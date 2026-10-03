import { temServiceRoleConfigurada, selectComoAdmin, inserirComoAdmin } from './supabaseAdmin.js';
import { enviarTexto } from './evolutionApi.js';
import { parseComoUTC, diasEntre, normalizarWhatsapp, getAgoraNoBrasil } from './dataUtils.js';
import { obterConfigBotAdmin } from './botConfig.js';

// Cliente "entra em risco" 15 dias sem pedido (mesmo critério do admin.html:
// classificarSegmentoCliente). A janela vai até 21 dias — não é só o dia
// exato 15 — pra tolerar o cron eventualmente não rodar num dia (deploy,
// reinício) sem deixar de notificar quem entrou em risco naquela semana.
// Clientes com mais de 21 dias sem pedido já devem ter sido pegos numa
// execução anterior; se não foram (primeira vez rodando o cron, por
// exemplo), eles só entram na safra automática na próxima vez que voltarem
// a ficar "recém em risco" — evita mandar mensagem de reativação do nada
// pra quem já sumiu há meses.
const JANELA_MIN_DIAS = 15;
const JANELA_MAX_DIAS = 21;

// Mesmo cliente não recebe reativação mais de 1x a cada 30 dias, mesmo que
// continue em risco por várias semanas seguidas.
const DEDUP_DIAS = 30;

const brl = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');

const mensagemReativacao = (primeiroNome, cupomCodigo, cupomPercentual, pedidoMinimo) =>
  `Oi ${primeiroNome}! Sentimos sua falta por aqui 🍕 Que tal matar a saudade com ${cupomPercentual}% OFF no seu próximo pedido? Usa o cupom ${cupomCodigo} e vem sentir a Explosão de Sabor de novo!` +
  (pedidoMinimo ? ` Válido para pedidos a partir de ${brl(pedidoMinimo)} em produtos (frete à parte, não vale em combos).` : '');

// Pedido mínimo cadastrado no próprio cupom (tabela cupons) — mesmo valor
// que o checkout do site e o bot exigem.
async function pedidoMinimoDoCupom(codigo) {
  try {
    const rows = await selectComoAdmin('cupons', `select=pedido_minimo&codigo=ilike.${encodeURIComponent(codigo)}&limit=1`);
    const v = rows?.[0]?.pedido_minimo;
    return v != null ? Number(v) : null;
  } catch (err) {
    console.error('[reactivationJob] falha ao ler pedido mínimo do cupom (seguindo sem citar o mínimo):', err);
    return null;
  }
}

async function buscarClientesRecemEmRisco() {
  const pedidos = await selectComoAdmin('pedidos', 'select=whatsapp,nome,created_at&whatsapp=not.is.null');

  const ultimoPedidoPorCliente = new Map(); // whatsapp -> {nome, ultimoPedidoEm}
  for (const p of pedidos) {
    if (!p.whatsapp) continue;
    const dataPedido = parseComoUTC(p.created_at);
    const atual = ultimoPedidoPorCliente.get(p.whatsapp);
    if (!atual || dataPedido > atual.ultimoPedidoEm) {
      ultimoPedidoPorCliente.set(p.whatsapp, { nome: p.nome, ultimoPedidoEm: dataPedido });
    }
  }

  const agora = new Date();
  const candidatos = [];
  for (const [whatsapp, { nome, ultimoPedidoEm }] of ultimoPedidoPorCliente) {
    const dias = diasEntre(ultimoPedidoEm, agora);
    if (dias >= JANELA_MIN_DIAS && dias <= JANELA_MAX_DIAS) {
      candidatos.push({ whatsapp, nome, diasSemPedido: dias });
    }
  }
  return candidatos;
}

async function jaRecebeuReativacaoRecente(whatsapp) {
  const limite = new Date(Date.now() - DEDUP_DIAS * 86400000).toISOString();
  const rows = await selectComoAdmin(
    'reativacoes_enviadas',
    `select=id&whatsapp=eq.${encodeURIComponent(whatsapp)}&enviado_em=gte.${limite}&limit=1`
  );
  return rows.length > 0;
}

/**
 * Rotina de reativação automática — chamada a cada hora (ver server.js),
 * mas só executa a lógica pesada quando o dia da semana e a hora batem com
 * o configurado na aba "Configurações do Bot" do admin.html (tabela
 * `configuracoes`, padrão: todos os dias às 15h — mesmo horário fixo de
 * antes). Rodar a cada hora em vez de agendar direto no dia/hora
 * configurado é o que permite trocar esses valores pelo admin e ver efeito
 * já na próxima hora, sem precisar reiniciar o bot.
 *
 * Quando bate a janela, identifica clientes que entraram no segmento "em
 * risco" recentemente (15-21 dias sem pedido), ainda não reativados nos
 * últimos 30 dias, e envia a mensagem via Evolution API (chamada direta,
 * não wa.me). Erros em clientes individuais são logados e não interrompem
 * o processamento dos demais.
 */
export async function rodarReativacaoDiaria() {
  if (!temServiceRoleConfigurada()) {
    console.warn(
      '[reactivationJob] SUPABASE_SERVICE_ROLE_KEY não configurada — pulando rotina de reativação automática.'
    );
    return { pulado: true };
  }

  const cfg = await obterConfigBotAdmin();
  const { diaSemana, hora } = getAgoraNoBrasil();
  if (!cfg.reativacaoDiasSemana.includes(diaSemana) || hora !== cfg.reativacaoHora) {
    return { pulado: true, foraDaJanela: true };
  }

  console.log('[reactivationJob] iniciando rotina diária de reativação de clientes...');

  let candidatos;
  try {
    candidatos = await buscarClientesRecemEmRisco();
  } catch (err) {
    console.error('[reactivationJob] falha ao buscar candidatos — abortando rotina desta vez:', err);
    return { erro: true };
  }

  let enviados = 0;
  let pulados = 0;
  let falhas = 0;
  const pedidoMinimo = await pedidoMinimoDoCupom(cfg.reativacaoCupomCodigo);

  for (const cliente of candidatos) {
    try {
      if (await jaRecebeuReativacaoRecente(cliente.whatsapp)) {
        pulados++;
        continue;
      }

      const numero = normalizarWhatsapp(cliente.whatsapp);
      if (!numero) {
        console.error(`[reactivationJob] WhatsApp inválido pro cliente "${cliente.nome}" (${cliente.whatsapp}) — pulando.`);
        falhas++;
        continue;
      }

      const primeiroNome = (cliente.nome || '').trim().split(/\s+/)[0] || '';
      await enviarTexto(numero, mensagemReativacao(primeiroNome, cfg.reativacaoCupomCodigo, cfg.reativacaoCupomPercentual, pedidoMinimo));
      await inserirComoAdmin('reativacoes_enviadas', {
        whatsapp: cliente.whatsapp,
        nome: cliente.nome,
        origem: 'automatico',
      });
      enviados++;
    } catch (err) {
      falhas++;
      console.error(`[reactivationJob] falha ao processar cliente "${cliente.nome}" (${cliente.whatsapp}):`, err);
      // segue pro próximo cliente — erro individual não trava o lote inteiro
    }
  }

  console.log(
    `[reactivationJob] concluído: ${enviados} enviado(s), ${pulados} já reativado(s) recentemente, ` +
      `${falhas} falha(s), ${candidatos.length} candidato(s) no total.`
  );
  return { enviados, pulados, falhas, totalCandidatos: candidatos.length };
}
