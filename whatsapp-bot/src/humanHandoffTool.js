import { config } from './config.js';
import { getMenuData } from './supabaseData.js';
import { enviarTexto } from './evolutionApi.js';
import { formatarTelefoneExibicao } from './pedidoStatusUtil.js';

/**
 * Definição da tool `chamar_atendente` — a Luiza chama quando o cliente
 * pede pra falar com uma pessoa. Não muda nada no atendimento em si: só
 * avisa a equipe no número de alertas (Configurações do Bot >
 * alerta_whatsapp_numero, mesmo número dos avisos de link Ton). A pausa do
 * bot continua acontecendo do jeito de sempre, quando alguém da equipe
 * responde manualmente pelo WhatsApp (ver atendimentoHumanoUtil.js).
 */
export const CHAMAR_ATENDENTE_TOOL = {
  name: 'chamar_atendente',
  description:
    'Avisa a equipe da Big Bang Pizza que este cliente quer falar com uma pessoa. Chame SÓ quando o cliente ' +
    'pedir explicitamente pra falar com um humano/atendente/alguém da equipe (ou aceitar a oferta de ser ' +
    'atendido por alguém da equipe depois de perguntar se você é robô). Não chame por dúvida comum que você ' +
    'mesma consegue responder. Depois de chamar, diga ao cliente que alguém da equipe vai responder por aqui ' +
    'assim que possível.',
  input_schema: {
    type: 'object',
    properties: {
      motivo: {
        type: 'string',
        description: 'Resumo curto (uma frase) do que o cliente quer tratar com a pessoa, se ele disse. Ex: "dúvida sobre pedido #812", "quer falar sobre um evento".',
      },
    },
    required: [],
  },
};

// Um alerta por cliente a cada 30 min — se o cliente repetir "quero falar
// com alguém" várias vezes seguidas, a equipe não recebe uma rajada de avisos.
const INTERVALO_ALERTA_MS = 30 * 60 * 1000;
const ultimoAlertaPorNumero = new Map(); // numero -> timestamp

/**
 * Cria o executor da tool `chamar_atendente`, amarrado ao número verificado
 * da conversa (mesmo padrão de orderTool.js — o telefone vem do webhook,
 * nunca de texto livre da IA).
 */
export function criarExecutorChamarAtendente({ numero, nomeContato }) {
  return async function executarChamarAtendente(input = {}) {
    const agora = Date.now();
    const ultimo = ultimoAlertaPorNumero.get(numero);
    if (ultimo && agora - ultimo < INTERVALO_ALERTA_MS) {
      return { sucesso: true, ja_avisado: true };
    }

    const { configuracoes } = await getMenuData();
    const alertaWhatsappNumero = configuracoes.alerta_whatsapp_numero || config.gabrielWhatsappNumber;
    if (!alertaWhatsappNumero) {
      console.warn(`[humanHandoffTool] Nenhum número de alerta configurado — não foi possível avisar que ${numero} quer falar com uma pessoa.`);
      return { erro: 'Não consegui avisar a equipe agora.' };
    }

    const msg =
      `🙋 Cliente precisa de atendimento da equipe\n\n` +
      `Cliente: ${nomeContato || 'sem nome'}\n` +
      `Telefone: ${formatarTelefoneExibicao(numero)}\n` +
      (input.motivo ? `Assunto: ${input.motivo}\n` : '') +
      `\nResponda direto no WhatsApp da loja — o bot pausa sozinho quando alguém da equipe responde.`;

    try {
      await enviarTexto(alertaWhatsappNumero, msg);
    } catch (err) {
      console.error('[humanHandoffTool] falha ao enviar alerta de atendimento humano:', err);
      return { erro: 'Não consegui avisar a equipe agora.' };
    }
    ultimoAlertaPorNumero.set(numero, agora);
    return { sucesso: true };
  };
}
