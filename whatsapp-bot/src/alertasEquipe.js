import { config } from './config.js';
import { obterConfigBotAdmin } from './botConfig.js';
import { enviarTexto } from './evolutionApi.js';
import { statusDaLoja } from './systemPrompt.js';
import { obterValor, salvarValor } from './historicoRedis.js';

// Alertas pra equipe ("Cliente precisa de atendimento", "Pedido atrasado"):
// - no máximo 1 por assunto (pedido ou cliente) a cada 30 min;
// - com a loja fechada não sai alerta avulso: os alertas se juntam num
//   resumo só (mandado 10 min depois do primeiro), e o que chegar depois
//   disso espera a loja abrir — nada de alerta repetido de madrugada
//   (caso de 30–31/10). Estado no Redis (sobrevive a redeploy), com cópia
//   em memória se o Redis não estiver disponível.

const INTERVALO_MESMO_ASSUNTO_MS = 30 * 60 * 1000;
const ESPERA_RESUMO_FECHADA_MS = 10 * 60 * 1000;
const TTL_ESTADO_S = 3 * 24 * 3600;
const CHAVE_ESTADO = 'alertas-equipe';

let estadoLocal = { ultimos: {}, pendentes: [], resumoFechadaEnviado: false };

async function lerEstado() {
  const doRedis = await obterValor(CHAVE_ESTADO);
  if (doRedis) estadoLocal = doRedis;
  return estadoLocal;
}

async function gravarEstado(estado) {
  estadoLocal = estado;
  await salvarValor(CHAVE_ESTADO, estado, TTL_ESTADO_S);
}

async function numeroDeAlerta() {
  const cfg = await obterConfigBotAdmin().catch(() => null);
  return cfg?.alertaWhatsappNumero || config.gabrielWhatsappNumber;
}

/**
 * @param {{assunto:string, texto:string}} alerta assunto = "pedido:374", "cliente:5571..."
 * @returns {Promise<'enviado'|'acumulado'|'repetido'|'sem_numero'>}
 */
export async function enviarAlertaEquipe({ assunto, texto }, deps = {}) {
  const { enviar = enviarTexto, status = statusDaLoja, agora = Date.now() } = deps;
  const destino = deps.destino ?? (await numeroDeAlerta());
  if (!destino) {
    console.warn(`[alertasEquipe] sem número de alerta configurado — alerta "${assunto}" não enviado.`);
    return 'sem_numero';
  }
  const estado = await lerEstado();
  for (const [k, ms] of Object.entries(estado.ultimos)) if (agora - ms > INTERVALO_MESMO_ASSUNTO_MS) delete estado.ultimos[k];
  if (estado.ultimos[assunto]) return 'repetido';
  estado.ultimos[assunto] = agora;

  if ((await status()).aberta) {
    await gravarEstado(estado);
    await enviar(destino, texto);
    return 'enviado';
  }
  estado.pendentes.push({ assunto, texto, em: agora });
  await gravarEstado(estado);
  return 'acumulado';
}

function montarResumo(pendentes, titulo) {
  const linhas = pendentes.map((p, i) => `${i + 1}. ${p.texto.replace(/\n+/g, ' · ')}`);
  return `${titulo} (${pendentes.length}):\n\n${linhas.join('\n\n')}`;
}

/**
 * Rodada periódica (server.js, a cada 5 min): com a loja fechada manda UM
 * resumo por período fechado; quando a loja abre, manda o que ficou
 * acumulado depois do resumo e libera o próximo período.
 */
export async function processarAlertasAcumulados(deps = {}) {
  const { enviar = enviarTexto, status = statusDaLoja, agora = Date.now() } = deps;
  const estado = await lerEstado();
  const aberta = (await status()).aberta;

  if (aberta) {
    if (!estado.pendentes.length && !estado.resumoFechadaEnviado) return 'nada';
    const pendentes = estado.pendentes;
    await gravarEstado({ ...estado, pendentes: [], resumoFechadaEnviado: false });
    if (!pendentes.length) return 'liberado';
    const destino = deps.destino ?? (await numeroDeAlerta());
    if (destino) await enviar(destino, montarResumo(pendentes, '🔔 Alertas de quando a loja estava fechada'));
    return 'enviado_na_abertura';
  }

  if (!estado.pendentes.length || estado.resumoFechadaEnviado) return 'nada';
  if (agora - estado.pendentes[0].em < ESPERA_RESUMO_FECHADA_MS) return 'aguardando';
  const destino = deps.destino ?? (await numeroDeAlerta());
  const pendentes = estado.pendentes;
  await gravarEstado({ ...estado, pendentes: [], resumoFechadaEnviado: true });
  if (destino) {
    await enviar(destino, `${montarResumo(pendentes, '🌙 Resumo de alertas (loja fechada)')}\n\nAté a loja abrir, os próximos alertas ficam guardados e chegam juntos na abertura.`);
  }
  return 'resumo_enviado';
}

/** Só pra testes. */
export function _zerarEstadoAlertas() {
  estadoLocal = { ultimos: {}, pendentes: [], resumoFechadaEnviado: false };
}
