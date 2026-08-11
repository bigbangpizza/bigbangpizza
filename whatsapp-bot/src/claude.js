import { config } from './config.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Chama a Claude API (Anthropic Messages API) com o system prompt dinâmico
 * e o histórico de mensagens da conversa (texto e/ou imagem).
 *
 * @param {string} systemPrompt
 * @param {Array<{role:'user'|'assistant', content: any}>} messages
 * @returns {Promise<string>} texto da resposta
 */
export async function askClaude(systemPrompt, messages) {
  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: systemPrompt,
      messages,
    }),
  });

  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`Claude API respondeu ${r.status}: ${errBody}`);
  }

  const data = await r.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  return textBlock?.text?.trim() || 'Desculpa, não consegui pensar numa resposta agora 😅 pode repetir?';
}

/** Monta um content block de texto (formato Anthropic Messages API). */
export function textBlock(text) {
  return { type: 'text', text };
}

/** Monta um content block de imagem em base64 (formato Anthropic Messages API). */
export function imageBlock(base64Data, mediaType) {
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: base64Data },
  };
}
