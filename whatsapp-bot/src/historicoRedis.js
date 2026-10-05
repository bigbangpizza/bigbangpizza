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
const PREFIXO_PAUSA = 'bbpizza:pausa:';
const PREFIXO_CONTATO = 'bbpizza:ultimocontato:';

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

  /**
   * Pausa do atendimento manual (ver atendimentoHumanoUtil.js): guarda até
   * quando o bot fica calado pra esse número, com TTL = o tempo que falta —
   * a chave some sozinha quando a pausa acaba. Mesmo fallback gracioso.
   */
  async function salvarPausa(numero, ateMs) {
    if (!cliente) return;
    const segundos = Math.ceil((ateMs - Date.now()) / 1000);
    if (segundos <= 0) return;
    try {
      await cliente.set(`${PREFIXO_PAUSA}${numero}`, String(ateMs), 'EX', segundos);
    } catch (err) {
      console.error(`[historicoRedis] falha ao salvar pausa de ${numero}:`, err.message);
    }
  }

  /** @returns {Promise<number|null>} até quando está pausado (ms), ou null. */
  async function obterPausa(numero) {
    if (!cliente) return null;
    try {
      const bruto = await cliente.get(`${PREFIXO_PAUSA}${numero}`);
      const ate = Number(bruto);
      return bruto && Number.isFinite(ate) ? ate : null;
    } catch (err) {
      console.error(`[historicoRedis] falha ao ler pausa de ${numero}:`, err.message);
      return null;
    }
  }

  /**
   * Último contato no WhatsApp (mensagem do cliente ou da equipe digitando
   * manualmente) — usado pelo abandonedCartJob.js pra não mandar "você não
   * finalizou" pra quem já está conversando. A chave é o telefone já
   * normalizado por chaveTelefone() (dataUtils.js). TTL de 48h.
   * @returns {Promise<boolean>} se gravou.
   */
  async function salvarUltimoContato(chaveTel, ms) {
    if (!cliente) return false;
    try {
      await cliente.set(`${PREFIXO_CONTATO}${chaveTel}`, String(ms), 'EX', 48 * 60 * 60);
      return true;
    } catch (err) {
      console.error(`[historicoRedis] falha ao salvar último contato de ${chaveTel}:`, err.message);
      return false;
    }
  }

  /**
   * @returns {Promise<number|null|undefined>} ms do último contato; null se não
   *   há registro; undefined se NÃO deu pra saber (Redis ausente ou falhou).
   */
  async function obterUltimoContato(chaveTel) {
    if (!cliente) return undefined;
    try {
      const bruto = await cliente.get(`${PREFIXO_CONTATO}${chaveTel}`);
      const ms = Number(bruto);
      return bruto && Number.isFinite(ms) ? ms : null;
    } catch (err) {
      console.error(`[historicoRedis] falha ao ler último contato de ${chaveTel}:`, err.message);
      return undefined;
    }
  }

  function redisConfigurado() {
    return Boolean(cliente);
  }

  return { obterHistorico, salvarHistorico, salvarPausa, obterPausa, salvarUltimoContato, obterUltimoContato, redisConfigurado };
}

const store = criarHistoricoStore(Redis, config.redis.url);

export const obterHistorico = store.obterHistorico;
export const salvarHistorico = store.salvarHistorico;
export const salvarPausa = store.salvarPausa;
export const obterPausa = store.obterPausa;
export const salvarUltimoContato = store.salvarUltimoContato;
export const obterUltimoContato = store.obterUltimoContato;
export const redisConfigurado = store.redisConfigurado;
