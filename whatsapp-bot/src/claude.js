import { config } from './config.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Limite de idas-e-voltas de tool use dentro de UMA mensagem do cliente —
// evita loop infinito/custo descontrolado se a Claude insistir em chamar
// ferramentas repetidamente. Na prática, criar um pedido usa 1.
const MAX_TOOL_ITERATIONS = 4;

async function callMessagesApi(systemPrompt, messages, tools) {
  const body = {
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    system: systemPrompt,
    messages,
  };
  if (tools?.length) body.tools = tools;

  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`Claude API respondeu ${r.status}: ${errBody}`);
  }
  return r.json();
}

function extrairTexto(data) {
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Chamada simples à Claude API, sem tools — usada quando a conversa não
 * precisa de nenhuma ação server-side (ex: só tirar dúvida do cardápio).
 *
 * @param {string} systemPrompt
 * @param {Array<{role:'user'|'assistant', content: any}>} messages
 * @returns {Promise<string>} texto da resposta
 */
export async function askClaude(systemPrompt, messages) {
  const data = await callMessagesApi(systemPrompt, messages, null);
  return extrairTexto(data) || 'Desculpa, não consegui pensar numa resposta agora 😅 pode repetir?';
}

/**
 * Roda uma "vez" completa da conversa permitindo que a Claude chame
 * ferramentas (tool use) — ex: registrar o pedido — quantas vezes precisar
 * antes de dar a resposta final em texto pro cliente. Cada tool em `tools`
 * precisa ter um executor correspondente em `toolExecutors` (mesmo nome).
 *
 * Retorna também `novasMensagens`: TODAS as mensagens geradas nesta rodada
 * (incluindo os blocos internos de tool_use/tool_result) — é importante
 * salvar essas mensagens completas no histórico da conversa (e não só o
 * texto final), senão a próxima chamada à API fica com um tool_use "solto"
 * sem o resultado correspondente, o que a Anthropic rejeita.
 *
 * @param {string} systemPrompt
 * @param {Array} historicoExistente mensagens já salvas da conversa
 * @param {Array} tools definições de tools no formato da Anthropic API
 * @param {Record<string, (input:any) => Promise<any>>} toolExecutors
 * @returns {Promise<{textoResposta: string, novasMensagens: Array}>}
 */
export async function conversarComFerramentas(systemPrompt, historicoExistente, tools, toolExecutors) {
  const novasMensagens = [];
  let mensagens = [...historicoExistente];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const data = await callMessagesApi(systemPrompt, mensagens, tools);
    const assistantMessage = { role: 'assistant', content: data.content };
    novasMensagens.push(assistantMessage);
    mensagens = [...mensagens, assistantMessage];

    if (data.stop_reason !== 'tool_use') {
      return { textoResposta: extrairTexto(data) || 'Feito! 🍕', novasMensagens };
    }

    const toolUseBlocks = data.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];
    for (const block of toolUseBlocks) {
      const executor = toolExecutors[block.name];
      let resultado;
      try {
        resultado = executor
          ? await executor(block.input)
          : { erro: `Ferramenta desconhecida: ${block.name}` };
      } catch (err) {
        console.error(`[claude] erro ao executar tool "${block.name}":`, err);
        resultado = { erro: `Falha interna ao executar ${block.name}: ${err.message}` };
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(resultado),
        is_error: Boolean(resultado?.erro),
      });
    }

    const toolResultMessage = { role: 'user', content: toolResults };
    novasMensagens.push(toolResultMessage);
    mensagens = [...mensagens, toolResultMessage];
  }

  return {
    textoResposta:
      'Desculpa, tive um problema pra finalizar isso agora 😕 pode tentar de novo em instantes ou me chamar em texto que eu te ajudo manualmente?',
    novasMensagens,
  };
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
