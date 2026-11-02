import { selectComoAdmin, atualizarComoAdmin, atualizarComoAdminSeStatus, rpcComoAdmin } from './supabaseAdmin.js';
import { consultarFidelidade } from './supabaseData.js';
import { enviarTexto } from './evolutionApi.js';
import { normalizarWhatsapp } from './dataUtils.js';
import { formatarTelefoneExibicao } from './pedidoStatusUtil.js';
import { registrarAcaoEquipe, primeiroNome } from './equipe.js';

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

// ── Ajuste de selos de fidelidade ───────────────────────────────────────
// Quem grava e confere a regra (nunca negativo, máximo 5, motivo obrigatório)
// é a função fidelidade_ajustar do banco; aqui só antecipamos a conta pro resumo.

const META_SELOS = 5;

/** Mensagem pro cliente depois do ajuste (só vai se a equipe confirmar). */
export function mensagemAjusteSelos(nomeCompleto, quantidade, selos, operacao) {
  const nome = primeiroNome(nomeCompleto);
  const oi = `Oi${nome ? `, ${nome}` : ''}!`;
  if (operacao === 'presente') return `${oi} Liberamos o seu presente da fidelidade: seu próximo pedido ganha uma Grande Tradicional! 🎁🍕`;
  if (quantidade < 0) return `${oi} Corrigimos o seu cartão fidelidade: agora você tem ${selos} de ${META_SELOS} selos 🍕`;
  const presente = selos >= META_SELOS ? ' Seu próximo pedido ganha uma Grande Tradicional de presente! 🎁' : '';
  return `${oi} Adicionamos ${quantidade} selo${quantidade > 1 ? 's' : ''} no seu cartão fidelidade. Agora você tem ${Math.min(selos, META_SELOS)} de ${META_SELOS} 🍕${presente}`;
}

export async function prepararAjusteSelos({ numero, membro, telefone, nome, operacao, valor, motivo }) {
  const motivoLimpo = String(motivo || '').trim();
  if (motivoLimpo.length < 3) return { erro: 'Falta o motivo do ajuste: pergunte à pessoa antes de preparar.' };
  if (!telefone) return { erro: 'Telefone do cliente inválido.' };
  const st = await consultarFidelidade(telefone);
  if (!st) return { erro: 'Não consegui consultar os selos agora. Tenta de novo em instantes.' };
  if (!st.valido) return { erro: 'Esse telefone está fora do programa de fidelidade.' };
  const antes = st.saldo ?? st.selos;
  const n = Number(valor);
  let depois;
  if (operacao === 'somar') {
    if (!Number.isInteger(n) || n === 0) return { erro: 'Diga quantos selos somar ou tirar (ex: +1, -1).' };
    depois = antes + n;
  } else if (operacao === 'definir') {
    if (!Number.isInteger(n)) return { erro: 'Diga com quantos selos o cliente deve ficar (0 a 5).' };
    depois = n;
  } else if (operacao === 'presente') {
    if (antes >= META_SELOS) return { erro: `${nome} já está com o presente liberado (5 de 5).` };
    depois = META_SELOS;
  } else {
    return { erro: `Operação desconhecida: ${operacao}` };
  }
  if (depois < 0) return { erro: `Não dá: ${nome} tem ${antes} selo(s), e o saldo não pode ficar negativo.` };
  if (depois > META_SELOS) return { erro: `Não dá: o máximo é ${META_SELOS} selos (5 = presente liberado). ${nome} já tem ${Math.min(antes, META_SELOS)}.` };
  if (depois === antes) return { erro: `${nome} já tem ${antes} selo(s); nada mudaria.` };

  const presente = depois >= META_SELOS ? ' (🎁 presente liberado: Grande Tradicional no próximo pedido)' : '';
  const resumo = `Vou ajustar os selos de fidelidade de ${nome} (${formatarTelefoneExibicao(telefone)}):\n${Math.min(antes, META_SELOS)} → ${depois} de ${META_SELOS}${presente}\nMotivo: ${motivoLimpo}`;
  pendentes.set(numero, { tipo: 'ajuste_selos', cliente: { nome, telefone }, operacao, valor: operacao === 'presente' ? 0 : n, motivo: motivoLimpo, membro, criadaEm: Date.now() });
  resumoDoTurno.set(numero, resumo);
  return { preparado: true, resumo };
}

async function executarAjusteSelos(numero, acao) {
  const { cliente, operacao, valor, motivo, membro } = acao;
  let resultado;
  let resposta;
  let gravado = null;
  try {
    gravado = await rpcComoAdmin('fidelidade_ajustar', { p_whatsapp: cliente.telefone, p_operacao: operacao, p_valor: valor, p_motivo: motivo, p_autor: membro.nome });
    resultado = 'ok';
    resposta = `Feito ✅ ${cliente.nome} agora tem ${gravado.selos} de ${META_SELOS} selos${gravado.tem_brinde ? ' (🎁 presente liberado)' : ''}.\n\nQuer que eu avise o cliente?`;
    pendentes.set(numero, {
      tipo: 'oferta_aviso',
      pedido: { id: null, nome: cliente.nome },
      destino: cliente.telefone,
      texto: mensagemAjusteSelos(cliente.nome, gravado.quantidade, gravado.saldo, operacao),
      membro,
      criadaEm: Date.now(),
    });
  } catch (err) {
    if (err.mensagemDoBanco) {
      resultado = `recusado: ${err.mensagemDoBanco}`;
      resposta = `Não ajustei: ${err.mensagemDoBanco}`;
    } else {
      console.error(`[equipeAcoes] falha ao ajustar selos de ${cliente.telefone}:`, err);
      resultado = `erro: ${String(err.message).slice(0, 200)}`;
      resposta = 'Não consegui ajustar agora (erro técnico). Nada foi alterado.';
    }
  }
  await registrarAcaoEquipe({
    membro,
    tipo: 'ajuste_selos',
    pedidoId: null,
    detalhes: { telefone: cliente.telefone, nome: cliente.nome, operacao, valor, motivo, selos_antes: gravado?.selos_antes ?? null, selos_depois: gravado?.selos ?? null },
    resultado,
  });
  return resposta;
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
  if (tipo === 'ajuste_selos') return executarAjusteSelos(numero, acao);
  // "Sim" pra "Quer que eu avise o cliente?" (depois de cancelar ou de ajustar selos): só
  // prepara a mensagem padrão — ela ainda precisa do próprio "confirma? (sim/não)".
  if (tipo === 'oferta_aviso') {
    const texto = acao.texto;
    pendentes.set(numero, { tipo: 'mensagem_cliente', pedido, texto, destino: acao.destino, membro, criadaEm: Date.now() });
    return `Vou mandar pelo número da loja para ${pedido.nome} (${formatarTelefoneExibicao(acao.destino)}), exatamente:

"${texto}"

Confirma? (sim/não)
(Se quiser outro texto, é só me dizer qual.)`;
  }
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
        const destino = normalizarWhatsapp(pedido.whatsapp);
        if (destino) {
          const texto = `Olá${primeiroNome(pedido.nome) ? `, ${primeiroNome(pedido.nome)}` : ''}! Aqui é da Big Bang Pizza. Seu pedido #${pedido.id} foi cancelado. Qualquer dúvida, é só responder por aqui.`;
          pendentes.set(numero, { tipo: 'oferta_aviso', pedido, destino, texto, membro, criadaEm: Date.now() });
          resposta += '\n\nQuer que eu avise o cliente?';
        } else {
          resposta += '\n(O pedido não tem telefone gravado, então não dá pra avisar o cliente por aqui.)';
        }
      }
    } else if (tipo === 'mensagem_cliente') {
      await enviarTexto(acao.destino, acao.texto);
      await aoEnviarMensagem?.(acao.destino, acao.texto);
      resultado = 'ok';
      resposta = `Enviado ✅ para ${pedido.nome}${pedido.id ? ` (pedido #${pedido.id})` : ''}.`;
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
