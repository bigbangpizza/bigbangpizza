import { config } from './config.js';
import { temServiceRoleConfigurada, selectComoAdmin, atualizarComoAdmin } from './supabaseAdmin.js';
import { enviarTexto } from './evolutionApi.js';
import { obterUltimoContato } from './historicoRedis.js';
import { parseComoUTC, minutosEntre, normalizarWhatsapp, chaveTelefone, mesmoTelefone } from './dataUtils.js';

// Carrinho abandonado com mais de 24h vira "expirado" e para de aparecer
// como pendente — não precisa mais ser verificado nem gera mensagem.
const EXPIRA_MINUTOS = 24 * 60;

// Qualquer pedido do telefone (site, bot ou manual do admin, em QUALQUER
// status, inclusive cancelado) de 12h antes do carrinho em diante = não é
// abandono, não manda nada.
const JANELA_PEDIDO_MINUTOS = 12 * 60;

const mensagemRecuperacao = (nome) =>
  `Oi${nome ? ' ' + nome : ''}! Notei que você começou um pedido na Big Bang Pizza mas não finalizou 🍕 Posso te ajudar a fechar? É rapidinho!`;

/**
 * Decide o que fazer com UM carrinho — função pura (sem rede), pra dar pra
 * testar todos os casos sem mandar mensagem. Na dúvida, NUNCA envia.
 *
 * Bug real (2026-10-04): o created_at do carrinho é "timestamp with time
 * zone" e vinha com "+00:00"; parseComoUTC colava um "Z" e virava data
 * inválida — nenhuma comparação dava certo, todo carrinho era avisado na
 * hora (até de quem já tinha fechado o pedido) e nunca virava convertido.
 *
 * @param {object} carrinho  linha de carrinhos_abandonados
 * @param {Array<{whatsapp:string, created_at:string}>} pedidos  pedidos recentes (qualquer status)
 * @param {number|null|undefined} ultimoContatoMs  último contato no WhatsApp
 *   (null = nenhum registrado; undefined = não deu pra saber)
 * @returns {'invalido'|'convertido'|'expirado'|'ja_notificado'|'aguardar'|'conversou'|'sem_telefone'|'sem_info_conversa'|'enviar'}
 */
export function decidirCarrinho(carrinho, pedidos, ultimoContatoMs, agora = new Date(), minutosAbandono = config.abandonedCartMinutos) {
  const criadoEm = parseComoUTC(carrinho.created_at);
  if (!criadoEm || Number.isNaN(criadoEm.getTime())) return 'invalido';

  const desde = criadoEm.getTime() - JANELA_PEDIDO_MINUTOS * 60000;
  const temPedido = pedidos.some((p) => {
    if (!mesmoTelefone(p.whatsapp, carrinho.telefone)) return false;
    const em = parseComoUTC(p.created_at);
    // data do pedido ilegível: trata como pedido (não arrisca mandar)
    return !em || Number.isNaN(em.getTime()) || em.getTime() >= desde;
  });
  if (temPedido) return 'convertido';

  const minutosParado = minutosEntre(criadoEm, agora);
  if (minutosParado >= EXPIRA_MINUTOS) return 'expirado';
  if (carrinho.notificado_em) return 'ja_notificado'; // inclui a trava 1970-01-01
  if (minutosParado < minutosAbandono) return 'aguardar';
  if (!chaveTelefone(carrinho.telefone)) return 'sem_telefone';
  if (ultimoContatoMs === undefined) return 'sem_info_conversa';
  if (ultimoContatoMs !== null && ultimoContatoMs >= criadoEm.getTime()) return 'conversou';
  return 'enviar';
}

/**
 * Pedidos de 36h pra cá (24h de vida do carrinho + 12h de janela), em
 * qualquer status. Uma consulta só por execução do job.
 */
async function buscarPedidosRecentes() {
  const limite = new Date(Date.now() - (EXPIRA_MINUTOS + JANELA_PEDIDO_MINUTOS) * 60000).toISOString();
  return selectComoAdmin('pedidos', `select=whatsapp,created_at&whatsapp=not.is.null&created_at=gte.${limite}`);
}

/**
 * Rotina periódica (a cada 10 min) que cuida do ciclo de vida dos carrinhos
 * abandonados registrados pelo site (tabela carrinhos_abandonados) — ver
 * decidirCarrinho(). Manda a mensagem de recuperação uma única vez por
 * carrinho (marca `notificado_em`). Erros em carrinhos individuais são
 * logados e não interrompem os demais. `deps` existe só pra teste.
 */
export async function verificarCarrinhosAbandonados(deps = {}) {
  const {
    select = selectComoAdmin,
    atualizar = atualizarComoAdmin,
    enviar = enviarTexto,
    ultimoContato = obterUltimoContato,
    buscarPedidos = buscarPedidosRecentes,
    agora = new Date(),
  } = deps;

  if (!deps.select && !temServiceRoleConfigurada()) {
    console.warn(
      '[abandonedCartJob] SUPABASE_SERVICE_ROLE_KEY não configurada — pulando verificação de carrinhos abandonados.'
    );
    return { pulado: true };
  }

  let carrinhos, pedidos;
  try {
    [carrinhos, pedidos] = await Promise.all([
      select('carrinhos_abandonados', 'select=id,telefone,nome,created_at,notificado_em&convertido_em=is.null&expirado=is.false'),
      buscarPedidos(),
    ]);
  } catch (err) {
    console.error('[abandonedCartJob] falha ao buscar carrinhos/pedidos — abortando desta vez:', err);
    return { erro: true };
  }

  const contagem = {};
  for (const carrinho of carrinhos) {
    try {
      // Só consulta o Redis de quem estaria pra receber mensagem.
      const preDecisao = decidirCarrinho(carrinho, pedidos, null, agora);
      const decisao = preDecisao === 'enviar'
        ? decidirCarrinho(carrinho, pedidos, await ultimoContato(chaveTelefone(carrinho.telefone)), agora)
        : preDecisao;
      contagem[decisao] = (contagem[decisao] || 0) + 1;

      if (decisao === 'convertido') {
        await atualizar('carrinhos_abandonados', carrinho.id, { convertido_em: agora.toISOString() });
      } else if (decisao === 'expirado') {
        await atualizar('carrinhos_abandonados', carrinho.id, { expirado: true });
      } else if (decisao === 'invalido') {
        console.error(`[abandonedCartJob] carrinho #${carrinho.id} com data ilegível — não envia nada.`);
      } else if (decisao === 'enviar') {
        const primeiroNome = (carrinho.nome || '').trim().split(/\s+/)[0] || '';
        await enviar(normalizarWhatsapp(carrinho.telefone), mensagemRecuperacao(primeiroNome));
        await atualizar('carrinhos_abandonados', carrinho.id, { notificado_em: agora.toISOString() });
      }
    } catch (err) {
      contagem.falha = (contagem.falha || 0) + 1;
      console.error(`[abandonedCartJob] falha ao processar carrinho #${carrinho.id}:`, err);
      // segue pro próximo carrinho — erro individual não trava o lote inteiro
    }
  }

  const relevantes = ['enviar', 'convertido', 'expirado', 'conversou', 'invalido', 'sem_info_conversa', 'falha'];
  if (relevantes.some((k) => contagem[k])) {
    console.log(`[abandonedCartJob] concluído (${carrinhos.length} verificado(s)):`, JSON.stringify(contagem));
  }
  return { ...contagem, totalVerificados: carrinhos.length };
}
