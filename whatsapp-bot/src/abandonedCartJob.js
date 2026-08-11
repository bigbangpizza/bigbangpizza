import { config } from './config.js';
import { temServiceRoleConfigurada, selectComoAdmin, atualizarComoAdmin } from './supabaseAdmin.js';
import { enviarTexto } from './evolutionApi.js';
import { parseComoUTC, minutosEntre, normalizarWhatsapp } from './dataUtils.js';

// Carrinho abandonado com mais de 24h vira "expirado" e para de aparecer
// como pendente — não precisa mais ser verificado nem gera mensagem.
const EXPIRA_MINUTOS = 24 * 60;

const mensagemRecuperacao = (nome) =>
  `Oi${nome ? ' ' + nome : ''}! Notei que você começou um pedido na Big Bang Pizza mas não finalizou 🍕 Posso te ajudar a fechar? É rapidinho!`;

/**
 * Mapa telefone normalizado -> data do pedido mais recente, só entre
 * pedidos criados dentro da janela de expiração (pedidos mais antigos que
 * isso não podem ter convertido um carrinho ainda não expirado). Uma
 * consulta só por execução do job, em vez de uma por carrinho.
 */
async function buscarUltimoPedidoPorTelefone() {
  const limite = new Date(Date.now() - EXPIRA_MINUTOS * 60000).toISOString();
  const pedidos = await selectComoAdmin(
    'pedidos',
    `select=whatsapp,created_at&whatsapp=not.is.null&created_at=gte.${limite}`
  );
  const mapa = new Map();
  for (const p of pedidos) {
    const telefone = normalizarWhatsapp(p.whatsapp);
    if (!telefone) continue;
    const criadoEm = parseComoUTC(p.created_at);
    const atual = mapa.get(telefone);
    if (!atual || criadoEm > atual) mapa.set(telefone, criadoEm);
  }
  return mapa;
}

/**
 * Rotina periódica (a cada 10 min) que cuida do ciclo de vida dos carrinhos
 * abandonados registrados pelo site (tabela carrinhos_abandonados):
 *  1. Se já existe um pedido concluído com o mesmo telefone depois do
 *     carrinho ter sido criado, marca `convertido_em` — não é abandono.
 *  2. Se passou de 24h sem conversão, marca `expirado` — para de contar
 *     como pendente, mas não precisa ser deletado.
 *  3. Se passou de `ABANDONED_CART_MINUTOS` e ainda não foi notificado,
 *     manda a mensagem de recuperação via Evolution API (uma única vez
 *     por carrinho — marca `notificado_em` depois de enviar).
 * Erros em carrinhos individuais são logados e não interrompem os demais.
 */
export async function verificarCarrinhosAbandonados() {
  if (!temServiceRoleConfigurada()) {
    console.warn(
      '[abandonedCartJob] SUPABASE_SERVICE_ROLE_KEY não configurada — pulando verificação de carrinhos abandonados.'
    );
    return { pulado: true };
  }

  let carrinhos, ultimoPedidoPorTelefone;
  try {
    [carrinhos, ultimoPedidoPorTelefone] = await Promise.all([
      selectComoAdmin(
        'carrinhos_abandonados',
        'select=id,telefone,nome,created_at,notificado_em&convertido_em=is.null&expirado=is.false'
      ),
      buscarUltimoPedidoPorTelefone(),
    ]);
  } catch (err) {
    console.error('[abandonedCartJob] falha ao buscar carrinhos/pedidos — abortando desta vez:', err);
    return { erro: true };
  }

  const agora = new Date();
  let convertidos = 0;
  let expirados = 0;
  let notificados = 0;
  let falhas = 0;

  for (const carrinho of carrinhos) {
    try {
      const criadoEm = parseComoUTC(carrinho.created_at);
      const telefone = normalizarWhatsapp(carrinho.telefone);
      const ultimoPedidoEm = telefone ? ultimoPedidoPorTelefone.get(telefone) : null;

      if (ultimoPedidoEm && ultimoPedidoEm >= criadoEm) {
        await atualizarComoAdmin('carrinhos_abandonados', carrinho.id, { convertido_em: agora.toISOString() });
        convertidos++;
        continue;
      }

      const minutosParado = minutosEntre(criadoEm, agora);

      if (minutosParado >= EXPIRA_MINUTOS) {
        await atualizarComoAdmin('carrinhos_abandonados', carrinho.id, { expirado: true });
        expirados++;
        continue;
      }

      if (carrinho.notificado_em) continue; // já foi avisado, só falta expirar ou converter
      if (minutosParado < config.abandonedCartMinutos) continue;
      if (!telefone) continue;

      const primeiroNome = (carrinho.nome || '').trim().split(/\s+/)[0] || '';
      await enviarTexto(telefone, mensagemRecuperacao(primeiroNome));
      await atualizarComoAdmin('carrinhos_abandonados', carrinho.id, { notificado_em: agora.toISOString() });
      notificados++;
    } catch (err) {
      falhas++;
      console.error(`[abandonedCartJob] falha ao processar carrinho #${carrinho.id}:`, err);
      // segue pro próximo carrinho — erro individual não trava o lote inteiro
    }
  }

  if (convertidos || expirados || notificados || falhas) {
    console.log(
      `[abandonedCartJob] concluído: ${notificados} notificado(s), ${convertidos} convertido(s), ` +
        `${expirados} expirado(s), ${falhas} falha(s), ${carrinhos.length} carrinho(s) verificado(s).`
    );
  }
  return { notificados, convertidos, expirados, falhas, totalVerificados: carrinhos.length };
}
