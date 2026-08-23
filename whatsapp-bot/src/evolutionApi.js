import { config } from './config.js';
import { registrarEnvioBot } from './atendimentoHumanoUtil.js';

function evolutionUrl(path) {
  return `${config.evolution.apiUrl}${path}/${config.evolution.instance}`;
}

function evolutionHeaders() {
  return {
    // Charset explícito por segurança — o corpo em si (JSON.stringify de uma
    // string JS) já sai em UTF-8 pelo fetch do Node, mas declarar o charset
    // evita qualquer ambiguidade do lado de quem recebe (Evolution API ou um
    // proxy no meio do caminho) sobre como decodificar emoji/acentos.
    'content-type': 'application/json; charset=utf-8',
    apikey: config.evolution.apiKey,
  };
}

/**
 * Envia uma mensagem de texto para um número via Evolution API.
 * @param {string} number ex: "5571999999999" (com DDI, só dígitos) ou o remoteJid completo
 * @param {string} text
 */
export async function enviarTexto(number, text) {
  // Registrado ANTES do fetch (não depois) — evita qualquer corrida com o
  // eco fromMe do webhook, que só pode chegar depois da Evolution API
  // processar esse envio. Ver atendimentoHumanoUtil.js pra saber por que
  // isso existe: sem isso, o bot não teria como distinguir seu próprio eco
  // de uma mensagem manual digitada por um humano no mesmo WhatsApp.
  registrarEnvioBot(number);
  const r = await fetch(evolutionUrl('/message/sendText'), {
    method: 'POST',
    headers: evolutionHeaders(),
    body: JSON.stringify({ number, text }),
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`Evolution API (sendText) respondeu ${r.status}: ${errBody}`);
  }
  return r.json();
}

/**
 * Mostra (ou não, se a chamada falhar) o indicador de "digitando..." pro
 * número, por `delayMs` milissegundos — usado pra simular tempo de digitação
 * humana antes de mandar cada mensagem (ver respostaHumanizada.js). É
 * "melhor esforço": se o endpoint não existir nessa versão da Evolution API
 * ou a chamada falhar por qualquer motivo, só loga e segue — a mensagem em
 * si (via enviarTexto) precisa sair de qualquer jeito, com ou sem indicador.
 * @param {string} number
 * @param {number} delayMs
 * @param {'composing'|'paused'} presence
 */
export async function enviarPresenca(number, delayMs, presence = 'composing') {
  try {
    const r = await fetch(evolutionUrl('/chat/sendPresence'), {
      method: 'POST',
      headers: evolutionHeaders(),
      body: JSON.stringify({ number, delay: delayMs, presence }),
    });
    if (!r.ok) {
      console.error('[evolutionApi] sendPresence respondeu', r.status, await r.text().catch(() => ''));
    }
  } catch (err) {
    console.error('[evolutionApi] falha ao enviar indicador de presença:', err.message);
  }
}

/**
 * Baixa o base64 de uma mensagem de mídia (áudio/imagem) a partir do ID da
 * mensagem — usado como fallback quando o webhook não vem com o campo
 * `base64` já embutido (depende da opção "webhook_base64" da instância,
 * ver README.md).
 * @param {string} messageId data.key.id da mensagem recebida no webhook
 * @returns {Promise<{base64:string, mimetype:string}|null>}
 */
export async function baixarMediaBase64(messageId) {
  const r = await fetch(evolutionUrl('/chat/getBase64FromMediaMessage'), {
    method: 'POST',
    headers: evolutionHeaders(),
    body: JSON.stringify({ message: { key: { id: messageId } } }),
  });
  if (!r.ok) {
    console.error('[evolutionApi] falha ao baixar mídia:', r.status, await r.text().catch(() => ''));
    return null;
  }
  const data = await r.json();
  if (!data.base64) return null;
  return { base64: data.base64, mimetype: data.mimetype || 'application/octet-stream' };
}
