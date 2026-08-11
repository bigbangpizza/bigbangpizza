import { temServiceRoleConfigurada, selectComoAdmin, inserirComoAdmin } from './supabaseAdmin.js';
import { enviarTexto } from './evolutionApi.js';
import { parseComoUTC, diasEntre } from './dataUtils.js';

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

const mensagemReativacao = (primeiroNome) =>
  `Oi ${primeiroNome}! Sentimos sua falta por aqui 🍕 Que tal matar a saudade com 10% OFF no seu próximo pedido? Usa o cupom VOLTEI10 e vem sentir a Explosão de Sabor de novo!`;

// Mesma lógica de normalização usada no admin.html (normalizarWhatsapp) —
// texto livre digitado pelo cliente no checkout, sem máscara na origem.
function normalizarWhatsapp(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length >= 12 && digits.startsWith('55')) return digits;
  if (digits.length === 10 || digits.length === 11) return '55' + digits;
  return digits;
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
 * Rotina diária de reativação automática — identifica clientes que
 * entraram no segmento "em risco" recentemente (15-21 dias sem pedido),
 * ainda não reativados nos últimos 30 dias, e envia a mensagem via
 * Evolution API (chamada direta, não wa.me). Erros em clientes individuais
 * são logados e não interrompem o processamento dos demais.
 */
export async function rodarReativacaoDiaria() {
  if (!temServiceRoleConfigurada()) {
    console.warn(
      '[reactivationJob] SUPABASE_SERVICE_ROLE_KEY não configurada — pulando rotina de reativação automática.'
    );
    return { pulado: true };
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
      await enviarTexto(numero, mensagemReativacao(primeiroNome));
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
