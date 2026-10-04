import { config } from './config.js';
import { getMenuData } from './supabaseData.js';
import { enviarTexto } from './evolutionApi.js';
import { enviarRespostaHumanizada } from './respostaHumanizada.js';
import { formatarTelefoneExibicao } from './pedidoStatusUtil.js';
import { mascararSegredos } from './segredos.js';

// Quando a Luiza não consegue responder (API da Claude fora do ar, sem
// crédito, erro inesperado), o cliente não pode ficar no vácuo — caso real
// de 03/10: a conta ficou sem crédito e dois clientes escreveram às 20:10 e
// 20:23 sem receber nada. Aqui: uma mensagem fixa pro cliente e um alerta
// pra equipe com o motivo. Um aviso por número a cada 30 min, pra não repetir
// a cada mensagem enquanto o problema durar.

export const MENSAGEM_FALHA_CLIENTE =
  'Desculpa, estou com uma instabilidade aqui e não consegui responder agora. Já avisei a equipe, e alguém te responde por aqui em instantes.';

const INTERVALO_AVISO_MS = 30 * 60 * 1000;
const ultimoAvisoPorNumero = new Map(); // numero -> Date.now()

export function motivoDaFalha(err) {
  const texto = String(err?.message || err || '');
  if (/credit balance is too low/i.test(texto)) return 'a conta da Anthropic (API da Claude) está SEM CRÉDITO — recarregue em Plans & Billing';
  if (/\b(401|403)\b|authentication|invalid x-api-key/i.test(texto)) return 'a chave da API da Claude foi recusada (ANTHROPIC_API_KEY)';
  if (/\b(429|529)\b|overloaded|rate.?limit/i.test(texto)) return 'a API da Claude está sobrecarregada ou no limite de uso';
  return `erro inesperado: ${mascararSegredos(texto).slice(0, 160)}`;
}

/** @returns {Promise<boolean>} true se avisou agora (false = já tinha avisado há pouco). */
export async function avisarFalhaNoAtendimento(numero, nomeContato, err) {
  const agora = Date.now();
  if (agora - (ultimoAvisoPorNumero.get(numero) || 0) < INTERVALO_AVISO_MS) return false;
  ultimoAvisoPorNumero.set(numero, agora);

  await enviarRespostaHumanizada(numero, MENSAGEM_FALHA_CLIENTE).catch((e) => {
    console.error(`[falhaAtendimento] numero=${numero} não consegui avisar o cliente:`, e.message);
  });

  const { configuracoes } = await getMenuData().catch(() => ({ configuracoes: {} }));
  const alertaNumero = configuracoes.alerta_whatsapp_numero || config.gabrielWhatsappNumber;
  if (!alertaNumero) return true;
  const msg =
    `⚠️ A Luiza NÃO conseguiu responder um cliente — responda por aqui.\n\n` +
    `Cliente: ${nomeContato || '(sem nome)'}\nTelefone: ${formatarTelefoneExibicao(numero)}\n` +
    `Motivo: ${motivoDaFalha(err)}`;
  await enviarTexto(alertaNumero, msg).catch((e) => {
    console.error('[falhaAtendimento] não consegui mandar o alerta pra equipe:', e.message);
  });
  return true;
}
