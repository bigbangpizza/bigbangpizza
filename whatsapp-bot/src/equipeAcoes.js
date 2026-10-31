import { selectComoAdmin, atualizarComoAdmin, atualizarComoAdminSeStatus } from './supabaseAdmin.js';
import { enviarTexto } from './evolutionApi.js';
import { normalizarWhatsapp } from './dataUtils.js';
import { formatarTelefoneExibicao } from './pedidoStatusUtil.js';
import { registrarAcaoEquipe } from './equipe.js';

// Ações que a equipe pode pedir pra Luiza (modo equipe). O modelo só PREPARA
// (preparar_acao): o resumo e o "confirma? (sim/não)" saem do código, e a
// execução só acontece quando a mesma pessoa responde "sim" (modoEquipe.js).
// A ação pendente vale 10 min e cai com qualquer outra mensagem.

const VALIDADE_MS = 10 * 60 * 1000;
const pendentes = new Map(); // numero da pessoa da equipe -> { tipo, pedido, texto, membro, criadaEm }
// Resumo preparado no turno atual, pra o modoEquipe.js mandar no lugar do texto do modelo.
const resumoDoTurno = new Map(); // numero -> texto

const NOME_STATUS = { aguardando: 'aguardando', aceito_preparando: 'em preparo', aceito: 'em preparo', preparando: 'em preparo', saiu: 'saiu para entrega', entregue: 'entregue', cancelado: 'cancelado' };

async function lerPedido(id) {
  const [p] = await selectComoAdmin('pedidos', `select=id,nome,whatsapp,total,status,pagamento,pago&id=eq.${Number(id)}`);
  return p || null;
}

const brl = (v) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');

/** Monta e guarda a ação pendente. Devolve o resumo (o modoEquipe manda ele + "confirma? (sim/não)"). */
export async function prepararAcao({ numero, membro, tipo, pedido_id, texto }) {
  const pedido = await lerPedido(pedido_id);
  if (!pedido) return { erro: `Não existe pedido #${pedido_id}.` };
  const cab = `Pedido #${pedido.id} — ${pedido.nome}, ${brl(pedido.total)}, ${NOME_STATUS[pedido.status] || pedido.status}, ${pedido.pagamento || 'pagamento não informado'}`;

  let resumo;
  if (tipo === 'marcar_pago') {
    if (pedido.pago) return { erro: `O pedido #${pedido.id} já está marcado como pago.` };
    resumo = `Vou marcar como PAGO:\n${cab}`;
  } else if (tipo === 'cancelar') {
    if (pedido.status === 'cancelado') return { erro: `O pedido #${pedido.id} já está cancelado.` };
    const aviso = ['saiu', 'entregue'].includes(pedido.status) ? `\n⚠️ Atenção: o pedido está "${NOME_STATUS[pedido.status]}".` : '';
    resumo = `Vou CANCELAR:\n${cab}${aviso}\n(o cliente não é avisado automaticamente)`;
  } else if (tipo === 'mensagem_cliente') {
    const destino = normalizarWhatsapp(pedido.whatsapp);
    if (!destino) return { erro: `O pedido #${pedido.id} não tem telefone gravado.` };
    const msg = String(texto || '').trim();
    if (!msg) return { erro: 'Falta o texto da mensagem.' };
    resumo = `Vou mandar pelo número da loja para ${pedido.nome} (${formatarTelefoneExibicao(destino)}), cliente do pedido #${pedido.id}, exatamente:\n\n"${msg}"`;
    pendentes.set(numero, { tipo, pedido, texto: msg, destino, membro, criadaEm: Date.now() });
    resumoDoTurno.set(numero, resumo);
    return { preparado: true, resumo };
  } else {
    return { erro: `Ação desconhecida: ${tipo}` };
  }
  pendentes.set(numero, { tipo, pedido, membro, criadaEm: Date.now() });
  resumoDoTurno.set(numero, resumo);
  return { preparado: true, resumo };
}

export function acaoPendente(numero) {
  const a = pendentes.get(numero);
  if (!a) return null;
  if (Date.now() - a.criadaEm > VALIDADE_MS) {
    pendentes.delete(numero);
    return null;
  }
  return a;
}

export function descartarAcao(numero) {
  pendentes.delete(numero);
}

/** Resumo preparado neste turno (e limpa). */
export function tirarResumoDoTurno(numero) {
  const r = resumoDoTurno.get(numero);
  resumoDoTurno.delete(numero);
  return r || null;
}

/**
 * Executa a ação pendente da pessoa (só depois do "sim"). `aoEnviarMensagem`
 * grava a mensagem no histórico da conversa do cliente (server.js), pra Luiza
 * saber dela se o cliente responder.
 * @returns {Promise<string>} texto de resposta pra equipe
 */
export async function executarAcaoPendente(numero, { aoEnviarMensagem } = {}) {
  const acao = acaoPendente(numero);
  pendentes.delete(numero);
  if (!acao) return 'Não tenho nenhuma ação esperando confirmação (ela vale 10 min).';
  const { tipo, pedido, membro } = acao;
  let resultado;
  let resposta;
  try {
    if (tipo === 'marcar_pago') {
      await atualizarComoAdmin('pedidos', pedido.id, { pago: true, pago_em: new Date().toISOString(), pago_por: membro.nome });
      resultado = 'ok';
      resposta = `Feito ✅ Pedido #${pedido.id} marcado como pago.`;
    } else if (tipo === 'cancelar') {
      // Condicional ao status lido no resumo: se mudou no meio tempo, não cancela.
      const linhas = await atualizarComoAdminSeStatus('pedidos', pedido.id, pedido.status, { status: 'cancelado' });
      if (!linhas.length) {
        resultado = 'status_mudou';
        resposta = `Não cancelei: o status do pedido #${pedido.id} mudou desde o resumo. Confere e me pede de novo.`;
      } else {
        resultado = 'ok';
        resposta = `Feito ✅ Pedido #${pedido.id} cancelado.`;
      }
    } else if (tipo === 'mensagem_cliente') {
      await enviarTexto(acao.destino, acao.texto);
      await aoEnviarMensagem?.(acao.destino, acao.texto);
      resultado = 'ok';
      resposta = `Enviado ✅ para ${pedido.nome} (pedido #${pedido.id}).`;
    }
  } catch (err) {
    console.error(`[equipeAcoes] falha ao executar ${tipo} no pedido #${pedido.id}:`, err);
    resultado = `erro: ${String(err.message).slice(0, 200)}`;
    resposta = `Não consegui fazer agora (erro técnico). Nada foi alterado${tipo === 'mensagem_cliente' ? ' — confira se a mensagem saiu antes de pedir de novo' : ''}.`;
  }
  await registrarAcaoEquipe({
    membro,
    tipo,
    pedidoId: pedido.id,
    detalhes: tipo === 'mensagem_cliente' ? { texto: acao.texto, destino: acao.destino } : { status_antes: pedido.status },
    resultado,
  });
  return resposta;
}
