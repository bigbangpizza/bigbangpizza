import { config } from './config.js';

// ═══════════════════════════════════════════════════════════════════════
// Distingue eco do próprio bot de mensagem humana real (fromMe)
// ═══════════════════════════════════════════════════════════════════════
// A Evolution API dispara um webhook "messages.upsert" com fromMe:true tanto
// pra mensagens que a nossa própria API envia (eco) quanto pra mensagens que
// alguém (Gabriel/equipe) digita manualmente no WhatsApp conectado — não dá
// pra distinguir pelo conteúdo do evento em si.
//
// Em vez de tentar casar pelo texto ou id da mensagem (frágil — depende de
// como a Evolution API formata o eco, que pode nem ser garantido igual em
// todo caso), usamos um contador de "ecos pendentes" por número: toda
// chamada a enviarTexto() incrementa o contador daquele número antes de
// mandar; quando um fromMe chega, se o contador for > 0, é eco — consome um
// e ignora. Se for 0, ninguém da nossa API mandou nada pra esse número
// agora há pouco — só pode ter sido alguém digitando na mão.
// Cada incremento expira sozinho depois de JANELA_ECO_MS mesmo se o eco
// nunca chegar (algumas instâncias/configurações podem não ecoar fromMe),
// pra não deixar o contador acumulando indefinidamente e mascarando uma
// mensagem humana real mais tarde.
const JANELA_ECO_MS = 5_000;
const ecosPendentesPorNumero = new Map(); // numero -> quantidade

export function registrarEnvioBot(numero) {
  if (!numero) return;
  ecosPendentesPorNumero.set(numero, (ecosPendentesPorNumero.get(numero) || 0) + 1);
  setTimeout(() => {
    const atual = ecosPendentesPorNumero.get(numero) || 0;
    if (atual > 0) ecosPendentesPorNumero.set(numero, atual - 1);
  }, JANELA_ECO_MS);
}

/** true se essa mensagem fromMe é eco de algo que a própria API acabou de mandar (consome um "crédito"). */
export function ehEcoDoBot(numero) {
  const atual = ecosPendentesPorNumero.get(numero) || 0;
  if (atual <= 0) return false;
  ecosPendentesPorNumero.set(numero, atual - 1);
  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// Pausa de atendimento manual
// ═══════════════════════════════════════════════════════════════════════
// Quando uma mensagem fromMe chega e NÃO é eco (ver acima), foi um humano
// respondendo direto pelo WhatsApp — pausa as respostas automáticas do bot
// pra esse número por HUMAN_TAKEOVER_PAUSA_MINUTOS, evitando que o bot
// atropele o atendimento manual. Estado só em memória (não sobrevive a um
// restart/redeploy do processo) — mesmo modelo de degradação graciosa já
// usado pro histórico de conversa em memória (ver server.js/historicoLocal).
const pausaAtePorNumero = new Map(); // numero -> timestamp (Date.now()) até quando fica pausado

export function ativarPausaHumana(numero) {
  const ate = Date.now() + config.humanTakeoverPausaMinutos * 60_000;
  pausaAtePorNumero.set(numero, ate);
  return ate;
}

export function estaPausadoPorHumano(numero) {
  const ate = pausaAtePorNumero.get(numero);
  if (!ate) return false;
  if (Date.now() >= ate) {
    pausaAtePorNumero.delete(numero);
    return false;
  }
  return true;
}
