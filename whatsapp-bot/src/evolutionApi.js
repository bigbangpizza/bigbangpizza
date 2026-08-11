import { config } from './config.js';

function evolutionUrl(path) {
  return `${config.evolution.apiUrl}${path}/${config.evolution.instance}`;
}

function evolutionHeaders() {
  return {
    'content-type': 'application/json',
    apikey: config.evolution.apiKey,
  };
}

/**
 * Envia uma mensagem de texto para um número via Evolution API.
 * @param {string} number ex: "5571999999999" (com DDI, só dígitos) ou o remoteJid completo
 * @param {string} text
 */
export async function enviarTexto(number, text) {
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
