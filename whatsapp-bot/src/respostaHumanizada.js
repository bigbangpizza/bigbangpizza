import { enviarTexto, enviarPresenca } from './evolutionApi.js';

// Humaniza o envio da resposta da Claude: quebra em várias mensagens
// (bolhas), com uma pausa "digitando..." proporcional ao tamanho de cada
// uma antes de mandar — responder tudo instantaneamente, num parágrafo só,
// é um dos sinais mais óbvios de bot. O system prompt instrui a Claude a
// separar as bolhas com uma linha em branco (ver systemPrompt.js, seção
// "Como você escreve").

const LIMITE_CURTA = 50;
const LIMITE_MEDIA = 150;

const FAIXAS_DELAY_MS = {
  curta: [1500, 2000],
  media: [2000, 3000],
  longa: [3000, 4000],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aleatorioEntre([min, max]) {
  return Math.round(min + Math.random() * (max - min));
}

/** Divide o texto da Claude em "bolhas" — uma por parágrafo (linha em branco). */
export function dividirEmMensagens(texto) {
  return (texto || '')
    .split(/\n\s*\n/)
    .map((trecho) => trecho.trim())
    .filter(Boolean);
}

/** Delay (ms) proporcional ao tamanho da mensagem, com variação dentro da faixa — nunca exatamente o mesmo valor duas vezes. */
export function calcularDelayMs(texto) {
  const tamanho = (texto || '').length;
  const faixa = tamanho <= LIMITE_CURTA ? FAIXAS_DELAY_MS.curta : tamanho <= LIMITE_MEDIA ? FAIXAS_DELAY_MS.media : FAIXAS_DELAY_MS.longa;
  return aleatorioEntre(faixa);
}

/**
 * Envia a resposta completa como uma sequência de mensagens humanizadas:
 * divide em bolhas, e pra cada uma mostra "digitando..." e espera um tempo
 * proporcional ao tamanho antes de mandar de fato — inclusive entre bolhas
 * consecutivas da mesma resposta, não só antes da primeira.
 */
export async function enviarRespostaHumanizada(numero, textoResposta) {
  const mensagens = dividirEmMensagens(textoResposta);
  if (!mensagens.length) return;

  for (const mensagem of mensagens) {
    const delayMs = calcularDelayMs(mensagem);
    await enviarPresenca(numero, delayMs, 'composing');
    await sleep(delayMs);
    await enviarTexto(numero, mensagem);
  }
}

// ── Pizza do Dia citada uma vez só ─────────────────────────────────────────
function textoDoAssistente(m) {
  if (m.role !== 'assistant') return '';
  return (Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }])
    .filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

/** A Luiza já ofereceu a Pizza do Dia (nome + preço) numa resposta anterior desta conversa? */
export function pizzaDoDiaCitadaNoHistorico(historico, nomePizzaDoDia) {
  if (!nomePizzaDoDia) return false;
  const nome = nomePizzaDoDia.toLowerCase();
  return historico.some((m) => {
    const t = textoDoAssistente(m).toLowerCase();
    return t.includes(nome) && /r\$/.test(t);
  });
}

/**
 * Mantém só o primeiro parágrafo (bolha) que oferece a Pizza do Dia com preço;
 * os outros que repetem a oferta saem. Resumo e confirmação de pedido ficam intactos.
 */
export function semPizzaDoDiaRepetida(texto, nomePizzaDoDia) {
  if (!nomePizzaDoDia || !texto) return texto;
  const nome = nomePizzaDoDia.toLowerCase();
  const ehOferta = (p) => p.toLowerCase().includes(nome) && /r\$/i.test(p) && !/resumo do pedido|pedido #|posso confirmar/i.test(p);
  const partes = texto.split(/\n\s*\n/);
  let jaCitou = false;
  const ficam = partes.filter((p) => {
    if (!ehOferta(p)) return true;
    if (jaCitou) return false;
    jaCitou = true;
    return true;
  });
  return ficam.length === partes.length ? texto : ficam.join('\n\n');
}
