import { getMenuData, buscarPedidoPorToken } from './supabaseData.js';
import { enviarRespostaHumanizada } from './respostaHumanizada.js';
import { enviarTexto } from './evolutionApi.js';
import { config } from './config.js';

// ═══════════════════════════════════════════════════════
// Detecta a mensagem automática que o checkout do site (index.html) manda
// pro WhatsApp depois que o cliente finaliza um pedido — e faz o bot
// reconhecer que aquele pedido JÁ foi gravado no Supabase, em vez de tratar
// como uma solicitação de pedido nova.
//
// Bug que isso corrige: antes, essa mensagem (texto tipo "Olá! Quero fazer
// um pedido 🍕 [dados completos]") caía na conversa normal e a Claude
// conduzia um fechamento de pedido do zero — CRIANDO UM SEGUNDO PEDIDO
// duplicado na cozinha, com um rastreio_token diferente do que o site já
// tinha gerado. Confirmado em produção: pedido #230 (Felipe Melo).
//
// Como a detecção funciona: o site sempre inclui o link de rastreio
// (https://.../rastreio.html?token=<uuid>) na mensagem, com o MESMO token
// que ele já usou pra gravar o pedido no Supabase (ver index.html, variável
// rastreioToken — gerado no cliente ANTES do insert, pra poder ir junto na
// mensagem sem esperar o banco responder). Esse token é a marca mais
// confiável possível: verificável direto contra o banco (via a RPC pública
// rastrear_pedido, mesma que o rastreio.html usa — não depende de
// SUPABASE_SERVICE_ROLE_KEY estar configurada), então não é só "parece uma
// mensagem do site", é "esse pedido específico existe ou não". Nenhum
// cliente digitaria esse link por conta própria.
// ═══════════════════════════════════════════════════════

const REGEX_TOKEN_RASTREIO = /rastreio\.html\?token=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** @returns {string|null} o token de rastreio, se o texto contiver o link do site. */
export function extrairTokenRastreioDoSite(texto) {
  const m = (texto || '').match(REGEX_TOKEN_RASTREIO);
  return m ? m[1] : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// O insert do pedido no Supabase roda em paralelo à abertura do WhatsApp no
// site (não é esperado antes — ver comentário em index.html), e o cliente
// ainda precisa apertar "Enviar" manualmente no app antes da mensagem
// chegar aqui. Na prática o insert quase sempre já terminou muito antes
// disso, mas por segurança tenta de novo algumas vezes com um intervalo
// curto antes de desistir — nunca deixa cair pro fluxo normal da Claude só
// por causa de uma corrida de alguns milissegundos.
const TENTATIVAS_BUSCA_TOKEN = 4;
const INTERVALO_TENTATIVAS_MS = 1500;

async function buscarPedidoComRetry(token) {
  for (let i = 0; i < TENTATIVAS_BUSCA_TOKEN; i++) {
    if (i > 0) await sleep(INTERVALO_TENTATIVAS_MS);
    const pedido = await buscarPedidoPorToken(token).catch((err) => {
      console.error('[siteOrderNotice] erro ao consultar rastrear_pedido:', err);
      return null;
    });
    if (pedido) return pedido;
  }
  return null;
}

async function avisarGabrielTokenNaoEncontrado(numero, token) {
  const { configuracoes } = await getMenuData().catch(() => ({ configuracoes: {} }));
  const alertaNumero = configuracoes.alerta_whatsapp_numero || config.gabrielWhatsappNumber;
  if (!alertaNumero) {
    console.warn(`[siteOrderNotice] numero=${numero} token=${token} — pedido não encontrado e nenhum número de alerta configurado.`);
    return;
  }
  const msg =
    `⚠️ Mensagem automática de pedido do site chegou, mas NÃO encontrei o pedido correspondente (token ${token}) depois de várias tentativas.\n\n` +
    `Cliente: ${numero}\n\n` +
    `O insert no Supabase pode ter falhado — confira manualmente no admin (aba Pedidos) e, se não existir, ajude o cliente a fechar o pedido.`;
  await enviarTexto(alertaNumero, msg).catch((err) => {
    console.error('[siteOrderNotice] falha ao avisar Gabriel sobre token não encontrado:', err);
  });
}

/**
 * Processa a notificação: confirma que o pedido já existe (com retry pra
 * cobrir a corrida descrita acima) e manda um reconhecimento simples pro
 * cliente — NUNCA enfileira essa mensagem pra Claude/criar_pedido. Se o
 * token não for encontrado mesmo depois das tentativas, ainda assim não
 * deixa cair pro fluxo normal (evita criar um pedido "do zero" a partir de
 * uma mensagem que não foi escrita organicamente pelo cliente) — só avisa o
 * Gabriel pra conferir manualmente.
 */
export async function tratarNotificacaoPedidoDoSite(numero, token) {
  console.log(`[siteOrderNotice] numero=${numero} mensagem automática do site detectada — token=${token}`);
  const pedido = await buscarPedidoComRetry(token);

  if (pedido) {
    const primeiroNome = (pedido.nome || '').trim().split(/\s+/)[0] || '';
    await enviarRespostaHumanizada(numero, `Recebi seu pedido aqui${primeiroNome ? ', ' + primeiroNome : ''}! 🍕 Já tá na nossa fila, só aguardar.`);
    return;
  }

  console.error(`[siteOrderNotice] numero=${numero} token=${token} — pedido NÃO encontrado depois de ${TENTATIVAS_BUSCA_TOKEN} tentativas.`);
  await enviarRespostaHumanizada(numero, 'Recebi sua mensagem! Deixa eu confirmar aqui rapidinho e já te retorno 🍕');
  await avisarGabrielTokenNaoEncontrado(numero, token);
}
