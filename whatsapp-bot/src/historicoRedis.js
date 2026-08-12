import Redis from 'ioredis';
import { config } from './config.js';

// Histórico de conversa por telefone, persistido no Redis já provisionado
// no Railway junto com a Evolution API — sobrevive a um redeploy/restart do
// bot no meio de uma conversa ativa (antes, ficava só num Map em memória e
// sumia a cada restart, ver git blame). Se REDIS_URL não estiver
// configurada, ou se a conexão falhar por qualquer motivo (Redis fora do
// ar, timeout, credencial errada), toda função aqui falha silenciosamente
// (retorna null / não lança erro) — quem chama (server.js) cai de volta pro
// histórico em memória local. Nunca deve derrubar o atendimento por causa
// do Redis.

// Prefixo de namespace — esse Redis é compartilhado com a própria Evolution
// API (que guarda sessão/cache dela ali também), então as chaves precisam
// ser inconfundíveis com o que a Evolution usa.
const PREFIXO_CHAVE = 'bbpizza:conversa:';

// TTL renovado a cada leitura/escrita — 24h de inatividade é folga de sobra
// pra sobreviver a um restart no meio de uma conversa, sem guardar histórico
// indefinidamente pra sempre (a conversa não tem valor depois que esfria).
const TTL_SEGUNDOS = 24 * 60 * 60;

/**
 * Fábrica isolada do cliente real de Redis — existe pra dar pra testar essa
 * lógica (chave, TTL, serialização, fallback gracioso) injetando uma classe
 * compatível diferente (ex: `ioredis-mock`) sem precisar de um Redis de
 * verdade rodando. Em produção, só é chamada uma vez logo abaixo.
 */
export function criarHistoricoStore(ClienteRedis, url) {
  let cliente = null;

  if (url) {
    // Conecta imediatamente, em segundo plano (não bloqueia a subida do
    // servidor: `new ClienteRedis()` nunca espera a conexão terminar). Nada
    // de `lazyConnect` + `enableOfflineQueue:false` juntos aqui — essa
    // combinação faz o PRIMEIRO comando falhar mesmo com o Redis saudável,
    // porque o comando chega antes da conexão lazy terminar de conectar e,
    // sem fila offline, é rejeitado na hora em vez de esperar. Conectando
    // logo na construção (bem antes da primeira mensagem real chegar do
    // WhatsApp), esse comando raramente vai bater numa conexão ainda não
    // pronta. `maxRetriesPerRequest` baixo garante que, se o Redis estiver
    // mesmo fora do ar, cada comando ainda falha rápido — só não falha por
    // uma corrida de inicialização normal.
    cliente = new ClienteRedis(url, {
      maxRetriesPerRequest: 2,
      connectTimeout: 5000,
      retryStrategy: (tentativas) => (tentativas > 5 ? null : Math.min(tentativas * 500, 3000)), // desiste de reconectar em segundo plano depois de um tempo, evita log infinito se o Redis cair de vez
    });
    cliente.on('error', (err) => {
      console.error('[historicoRedis] erro de conexão com o Redis:', err.message);
    });
  } else {
    console.warn(
      '[historicoRedis] REDIS_URL não configurada — histórico de conversa vai ficar só em memória (some a cada restart).'
    );
  }

  function chave(numero) {
    return `${PREFIXO_CHAVE}${numero}`;
  }

  /**
   * @param {string} numero
   * @returns {Promise<Array|null>} histórico salvo, ou null se não achou
   *   nada pra esse número, o Redis não está configurado, ou a leitura
   *   falhou.
   */
  async function obterHistorico(numero) {
    if (!cliente) return null;
    try {
      const bruto = await cliente.get(chave(numero));
      return bruto ? JSON.parse(bruto) : null;
    } catch (err) {
      console.error(`[historicoRedis] falha ao ler histórico de ${numero}:`, err.message);
      return null;
    }
  }

  /**
   * Salva o histórico (substitui o valor anterior inteiro) com o TTL
   * renovado. Falha silenciosamente — nunca lança — se o Redis não estiver
   * configurado ou a escrita falhar; quem chama já manteve sua própria
   * cópia em memória, então não há nada a fazer além de logar o erro.
   */
  async function salvarHistorico(numero, mensagens) {
    if (!cliente) return;
    try {
      await cliente.set(chave(numero), JSON.stringify(mensagens), 'EX', TTL_SEGUNDOS);
    } catch (err) {
      console.error(`[historicoRedis] falha ao salvar histórico de ${numero}:`, err.message);
    }
  }

  function redisConfigurado() {
    return Boolean(cliente);
  }

  return { obterHistorico, salvarHistorico, redisConfigurado };
}

const store = criarHistoricoStore(Redis, config.redis.url);

export const obterHistorico = store.obterHistorico;
export const salvarHistorico = store.salvarHistorico;
export const redisConfigurado = store.redisConfigurado;
