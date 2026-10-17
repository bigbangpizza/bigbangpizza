import { enviarTexto, enviarLocalizacao } from './evolutionApi.js';
import { ENDERECO_LOJA, LOJA_NOME, LOJA_LAT, LOJA_LNG, lojaTemCoordenadas, linkMapsLoja } from './loja.js';

// ═══════════════════════════════════════════════════════════════════════
// Localização da loja no WhatsApp
// ═══════════════════════════════════════════════════════════════════════
// A Luiza informa o endereço em texto na resposta dela; esta ferramenta só
// AGENDA o envio da localização, que sai numa mensagem separada DEPOIS da
// resposta (ver processarLote em server.js): pin nativo do WhatsApp quando
// LOJA_LAT/LOJA_LNG estão preenchidas, senão um link do Google Maps.
// Uma vez por conversa: se o histórico já tem essa ferramenta, só reenvia
// quando o cliente pede a localização explicitamente.

export const ENVIAR_LOCALIZACAO_TOOL = {
  name: 'enviar_localizacao_loja',
  description:
    'Envia ao cliente a localização da loja no WhatsApp (pin no mapa ou link do Google Maps), numa mensagem separada logo depois da sua resposta. ' +
    'Chame quando o cliente perguntar o endereço da loja ou escolher retirar o pedido na loja. ' +
    'Uma vez por conversa: se a localização já foi enviada, só chame de novo se o cliente pedir a localização/mapa explicitamente (pedido_explicito: true). ' +
    'No seu texto, informe o endereço da loja normalmente; não cole link de mapa.',
  input_schema: {
    type: 'object',
    properties: {
      pedido_explicito: {
        type: 'boolean',
        description: 'true só se o cliente pediu agora, com essas palavras, a localização, o mapa ou o pin da loja.',
      },
    },
  },
};

/** true se a localização já foi enviada nesta conversa (a ferramenta aparece no histórico). */
export function localizacaoJaEnviadaNoHistorico(historico) {
  return (historico || []).some(
    (m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use' && b.name === ENVIAR_LOCALIZACAO_TOOL.name)
  );
}

/**
 * @param {object} opcoes
 * @param {boolean} opcoes.jaEnviada resultado de localizacaoJaEnviadaNoHistorico, calculado antes desta mensagem
 * @param {() => void} opcoes.agendar marca o envio pra depois da resposta da Luiza
 */
export function criarExecutorEnviarLocalizacao({ jaEnviada, agendar }) {
  let agendadaNestaMensagem = false;
  return async (input = {}) => {
    if (agendadaNestaMensagem) {
      return { enviada: true, observacao: 'Já vai ser enviada logo depois da sua resposta.' };
    }
    if (jaEnviada && !input.pedido_explicito) {
      return {
        enviada: false,
        motivo: 'A localização já foi enviada nesta conversa. Não reenvie; se o cliente precisar, repita só o endereço em texto.',
        endereco: ENDERECO_LOJA,
      };
    }
    agendadaNestaMensagem = true;
    agendar();
    return {
      enviada: true,
      tipo: lojaTemCoordenadas() ? 'pin_no_mapa' : 'link_google_maps',
      endereco: ENDERECO_LOJA,
      // O texto escrito junto com a chamada de uma ferramenta não chega ao cliente
      // (só a resposta final, depois da ferramenta) — por isso a instrução explícita.
      instrucao:
        'Localização agendada: vai numa mensagem separada, logo depois da sua resposta. ' +
        'ATENÇÃO: o texto que você escreveu junto com esta chamada NÃO chega ao cliente. Escreva agora a resposta completa: ' +
        'responda o que o cliente perguntou (ex: se ele pode retirar, diga que sim, sem custo de entrega) e informe o endereço da loja. Não cole link de mapa.',
    };
  };
}

/** Envia a localização (pin nativo ou link do Maps). Chamado depois da resposta da Luiza. */
export async function enviarLocalizacaoLoja(numero) {
  if (lojaTemCoordenadas()) {
    return enviarLocalizacao(numero, { nome: LOJA_NOME, endereco: ENDERECO_LOJA, latitude: LOJA_LAT, longitude: LOJA_LNG });
  }
  return enviarTexto(numero, `Localização da loja no mapa: ${linkMapsLoja()}`);
}
