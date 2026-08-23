import { config } from './config.js';

// ═══════════════════════════════════════════════════════════════════════
// Distingue eco do próprio bot de mensagem humana real (fromMe)
// ═══════════════════════════════════════════════════════════════════════
// A Evolution API dispara um webhook "messages.upsert" com fromMe:true tanto
// pra mensagens que a nossa própria API envia (eco) quanto pra mensagens que
// alguém (Gabriel/equipe) digita manualmente no WhatsApp conectado — não dá
// pra distinguir pelo conteúdo do evento em si.
//
// MECANISMO PRINCIPAL — casamento por ID exato:
// A resposta da Evolution API ao mandar uma mensagem (POST /message/sendText)
// já retorna o ID real da mensagem (key.id) — e esse é o MESMO ID que volta
// depois no webhook de eco fromMe. Guardando esse ID no envio (ver
// registrarIdEnviado, chamado de evolutionApi.js) dá pra checar uma
// correspondência EXATA: se o ID do fromMe que chegou bate com um ID que a
// gente mandou, é eco, sem sombra de dúvida — não importa quanto tempo
// demorou pra chegar.
//
// Por que isso substitui o design anterior (só contador por número): a
// primeira versão desse módulo tentava inferir eco só pela PROXIMIDADE DE
// TEMPO (um contador de "ecos pendentes" que expira depois de
// JANELA_ECO_MS). Isso tem um defeito estrutural que só apareceu em
// produção: se alguém da equipe digitasse uma mensagem manual pro MESMO
// número pouco depois do bot ter mandado algo — antes do eco real do bot
// chegar —, o contador ainda tinha um "crédito" pendente, e a mensagem
// MANUAL acabava sendo consumida como se fosse o eco do bot. Ou seja, o
// caso mais importante de usar essa feature (Gabriel corrigindo o bot na
// hora) era justamente o caso em que ela falhava silenciosamente. Alargar
// a janela (pra corrigir o bot se autopausando com eco lento) só piorava
// isso, aumentando a chance de um humano digitar dentro da janela.
// Casar por ID exato elimina essa ambiguidade — não depende de "quantos
// envios recentes", só de "esse ID específico é nosso ou não".
const IDS_ENVIADOS_PELO_BOT = new Set();

// TTL aqui é só higiene de memória (evita o Set crescer pra sempre se algum
// ID nunca voltar) — não afeta a precisão da detecção, já que a checagem é
// por igualdade exata de ID, não por janela de tempo. Pode ser bem generoso
// sem nenhum risco de falso positivo.
const TTL_ID_ENVIADO_MS = 5 * 60_000;

// Flag de "o rastreamento por ID já provou que funciona nessa instância" —
// vira true na primeira vez que a Evolution API retornar um key.id de
// verdade num envio. Existe pra decidir SE o contador por número (abaixo)
// deve ser consultado como reserva. IMPORTANTE: essa checagem tem que ser
// "o mecanismo por ID nunca funcionou, então não temos como saber" — e NÃO
// "esse ID específico não bateu, então deixa eu tentar o contador" — as
// duas soam parecidas mas são bem diferentes na prática. Um teste local
// pegou isso: se o contador entra como fallback POR EVENTO (não por
// instância), ele volta a causar o mesmo bug que o casamento por ID foi
// feito pra resolver — porque o crédito do contador fica pendente até o
// eco de verdade chegar e consumi-lo, e se um humano mandar uma mensagem
// manual justamente NESSA janela (antes do eco chegar), o contador ainda
// tem crédito sobrando e "absorve" a mensagem manual como se fosse eco,
// mesmo com o ID não batendo. Só cair pro contador quando o ID NUNCA
// funcionou (falha sistêmica da instância/versão) evita essa reintrodução.
let idTrackingFuncionando = false;

/**
 * Registra o ID de uma mensagem que a própria API acabou de mandar (ver
 * evolutionApi.js/enviarTexto) — usado por ehEcoDoBot pra reconhecer o eco
 * correspondente com certeza, não importa quanto tempo demore pra chegar.
 */
export function registrarIdEnviado(id) {
  if (!id) return;
  idTrackingFuncionando = true;
  IDS_ENVIADOS_PELO_BOT.add(id);
  setTimeout(() => IDS_ENVIADOS_PELO_BOT.delete(id), TTL_ID_ENVIADO_MS);
}

// MECANISMO DE RESERVA — contador por número:
// Só é consultado se idTrackingFuncionando NUNCA tiver virado true — ou
// seja, se essa instância/versão da Evolution API simplesmente nunca
// retornou um key.id em nenhum envio (incompatibilidade sistêmica, não uma
// falha pontual). Nesse caso (raro), cai de volta pro comportamento antigo
// — melhor com o risco conhecido do que sem detecção nenhuma.
const JANELA_ECO_MS = 20_000;
const ecosPendentesPorNumero = new Map(); // numero -> quantidade

export function registrarEnvioBot(numero) {
  if (!numero) return;
  ecosPendentesPorNumero.set(numero, (ecosPendentesPorNumero.get(numero) || 0) + 1);
  setTimeout(() => {
    const atual = ecosPendentesPorNumero.get(numero) || 0;
    if (atual > 0) ecosPendentesPorNumero.set(numero, atual - 1);
  }, JANELA_ECO_MS);
}

function consumirCreditoPorContador(numero) {
  const atual = ecosPendentesPorNumero.get(numero) || 0;
  if (atual <= 0) return false;
  ecosPendentesPorNumero.set(numero, atual - 1);
  return true;
}

/**
 * true se essa mensagem fromMe é eco de algo que a própria API acabou de
 * mandar. Se o rastreamento por ID já provou funcionar nessa instância
 * (idTrackingFuncionando), o casamento por ID é a ÚNICA fonte de verdade —
 * não bateu, não é eco, ponto (mesmo que exista crédito pendente no
 * contador). Só cai pro contador (mais frágil, ver acima) se o rastreamento
 * por ID nunca tiver funcionado nem uma vez.
 */
export function ehEcoDoBot(numero, id) {
  if (id && IDS_ENVIADOS_PELO_BOT.has(id)) {
    IDS_ENVIADOS_PELO_BOT.delete(id);
    return true;
  }
  if (idTrackingFuncionando) return false;
  return consumirCreditoPorContador(numero);
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
