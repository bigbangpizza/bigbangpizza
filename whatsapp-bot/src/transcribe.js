import { config } from './config.js';

const GROQ_TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

/**
 * Transcreve um áudio (buffer) para texto em português usando a Whisper API
 * da Groq — escolhida por ter um tier gratuito generoso (milhares de
 * requisições/dia) e ser, mesmo no plano pago, uma das opções mais baratas
 * do mercado para Whisper, com ótimo suporte a português do Brasil. Ver
 * README.md para outras opções caso prefira trocar.
 *
 * @param {Buffer} audioBuffer
 * @param {string} mimetype ex: "audio/ogg; codecs=opus"
 * @returns {Promise<string>}
 */
export async function transcreverAudio(audioBuffer, mimetype = 'audio/ogg') {
  if (!config.groq.apiKey) {
    throw new Error('GROQ_API_KEY não configurada — necessária para transcrever áudios (veja .env.example).');
  }

  const extensao = mimetype.includes('ogg') ? 'ogg' : mimetype.includes('mp4') ? 'm4a' : 'oga';
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimetype }), `audio.${extensao}`);
  form.append('model', config.groq.model);
  form.append('language', 'pt');
  form.append('response_format', 'json');

  const r = await fetch(GROQ_TRANSCRIPTIONS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.groq.apiKey}` },
    body: form,
  });

  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`Groq Whisper API respondeu ${r.status}: ${errBody}`);
  }

  const data = await r.json();
  return (data.text || '').trim();
}
