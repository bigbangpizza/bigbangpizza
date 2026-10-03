import { getMenuData, buscarPedidoPorToken } from './supabaseData.js';
import { enviarTexto } from './evolutionApi.js';
import { config } from './config.js';
import { montarResumoPedido, textoWhatsApp } from './resumoPedido.js';
import { selectComoAdmin, temServiceRoleConfigurada } from './supabaseAdmin.js';
import { normalizarWhatsapp } from './dataUtils.js';
import { vincularPedidoAoNumero, pedidoJaVinculado } from './pedidoStatusUtil.js';

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

function normalizarTexto(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const ROTULOS_MENSAGEM_SITE = ['nome:', 'endereco:', 'bairro:', 'pedido:', 'total:', 'pagamento:'];

/**
 * O texto do pedido do site colado à mão (com ou sem emojis, com ou sem o
 * link de rastreio) — caso real do pedido #273: o cliente colou o texto sem
 * os emojis e a Luiza respondeu que não tinha recebido nada. A mensagem
 * "meu bairro não está na lista" fica de fora: o site não grava pedido nesse
 * caso, então ela segue pra Luiza como conversa normal.
 */
export function pareceTextoDePedidoDoSite(texto) {
  const t = normalizarTexto(texto);
  if (!t || t.includes('nao esta na lista')) return false;
  const rotulos = ROTULOS_MENSAGEM_SITE.filter((r) => t.includes(r)).length;
  const frase = t.includes('quero fazer um pedido') || t.includes('acompanhe seu pedido');
  return (frase && rotulos >= 2) || rotulos >= 4;
}

function valorDoTexto(v) {
  const n = parseFloat(String(v || '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Sem token: procura o pedido do site pelo nome + total escritos no texto
 * (ou pelo telefone da conversa, se ele tiver um único pedido recente),
 * entre os pedidos das últimas 3 horas.
 */
async function localizarPedidoPeloTexto(numero, texto) {
  if (!temServiceRoleConfigurada()) return null;
  const limite = new Date(Date.now() - 3 * 3600000).toISOString();
  const pedidos = await selectComoAdmin(
    'pedidos',
    `select=id,nome,whatsapp,total,status&created_at=gte.${limite}&status=neq.cancelado&order=created_at.desc`
  );
  const numeroNormalizado = normalizarWhatsapp(numero);
  const nome = normalizarTexto((texto.match(/nome:\s*([^\n]+)/i) || [])[1]).trim();
  const total = valorDoTexto((texto.match(/(?:^|[^b])total:\s*r\$\s*([\d.]*\d,\d{2})/i) || [])[1]);
  const porNomeETotal = (p) =>
    nome && total != null && normalizarTexto(p.nome).trim() === nome && Math.abs(Number(p.total) - total) < 0.01;
  const exato = pedidos.find(porNomeETotal);
  if (exato) return exato;
  // Pedido já confirmado nesta conversa: o total pode ter mudado depois
  // (ex: a doce incluída por editar_pedido), então basta o nome — ou ser o único.
  const vinculados = pedidos.filter((p) => pedidoJaVinculado(numero, p.id));
  const vinculadoPeloNome = vinculados.find((p) => nome && normalizarTexto(p.nome).trim() === nome);
  if (vinculadoPeloNome) return vinculadoPeloNome;
  if (vinculados.length === 1) return vinculados[0];
  const doTelefone = pedidos.filter((p) => numeroNormalizado && normalizarWhatsapp(p.whatsapp) === numeroNormalizado);
  return doTelefone.length === 1 ? doTelefone[0] : null;
}

async function buscarPedidoCompleto(id) {
  if (!temServiceRoleConfigurada()) return null;
  const rows = await selectComoAdmin(
    'pedidos',
    `select=id,nome,itens,itens_json,status,created_at,subtotal,desconto,frete,total,cupom,bairro,endereco&id=eq.${id}`
  ).catch(() => []);
  return rows[0] || null;
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

async function textoConfirmacao(pedido) {
  const primeiroNome = (pedido.nome || '').trim().split(/\s+/)[0] || '';
  // Confirma com o valor de cada item e o total gravado — mesmo formato do
  // admin e do rastreio (resumoPedido.js). Se o resumo falhar, manda só o
  // reconhecimento simples.
  let resumoTexto = '';
  try {
    const { doces } = await getMenuData();
    resumoTexto = textoWhatsApp(montarResumoPedido(pedido, new Set(doces.map((d) => String(d.nome).toLowerCase()))));
  } catch (err) {
    console.error('[siteOrderNotice] falha ao montar o resumo do pedido (seguindo sem):', err);
  }
  // "Recebi seu pedido #ID" é a marca que liga o pedido a esta conversa
  // (vincularPedidosDoHistorico em pedidoStatusUtil.js) — não mude a frase.
  return `Recebi seu pedido #${pedido.id} aqui${primeiroNome ? ', ' + primeiroNome : ''}! Já está na nossa fila.${resumoTexto ? `\n${resumoTexto}` : ''}`;
}

/**
 * Mensagem de pedido do site (com o link de rastreio, ou o texto colado sem
 * ele): confirma que o pedido já existe e devolve a resposta pro server.js
 * enviar e GRAVAR NO HISTÓRICO junto com a mensagem do cliente — antes a
 * resposta ia direto pro WhatsApp e a Luiza nunca ficava sabendo do pedido
 * (bug do pedido #273). Nunca enfileira pra criar_pedido (duplicaria o
 * pedido — ver #230). Token não encontrado: avisa a equipe pra conferir.
 * @returns {Promise<{texto:string|null, pedido:object|null, jaConfirmado?:boolean}|null>}
 *   null = texto sem link cujo pedido não foi localizado (segue pra Luiza
 *   com um aviso). jaConfirmado = o pedido já foi confirmado nesta conversa
 *   (o cliente reenviou/colou o texto de novo): não repete a confirmação, a
 *   Luiza continua a conversa de onde parou (ver avisoPedidoDoSiteJaConfirmado).
 */
export async function montarRespostaPedidoDoSite(numero, texto, token) {
  if (!token) {
    let pedido = null;
    try {
      pedido = await localizarPedidoPeloTexto(numero, texto);
      if (pedido) pedido = (await buscarPedidoCompleto(pedido.id)) || pedido;
    } catch (err) {
      console.error('[siteOrderNotice] falha ao localizar pedido pelo texto:', err);
    }
    console.log(`[siteOrderNotice] numero=${numero} texto de pedido do site sem link — ${pedido ? `pedido #${pedido.id} localizado` : 'pedido não localizado'}`);
    if (!pedido) return null;
    const jaConfirmado = pedidoJaVinculado(numero, pedido.id);
    vincularPedidoAoNumero(numero, pedido.id);
    return { texto: jaConfirmado ? null : await textoConfirmacao(pedido), pedido, jaConfirmado };
  }

  console.log(`[siteOrderNotice] numero=${numero} mensagem automática do site detectada — token=${token}`);
  const pedido = await buscarPedidoComRetry(token);
  if (pedido) {
    const jaConfirmado = pedidoJaVinculado(numero, pedido.id);
    vincularPedidoAoNumero(numero, pedido.id);
    return { texto: jaConfirmado ? null : await textoConfirmacao(pedido), pedido, jaConfirmado };
  }

  console.error(`[siteOrderNotice] numero=${numero} token=${token} — pedido NÃO encontrado depois de ${TENTATIVAS_BUSCA_TOKEN} tentativas.`);
  await avisarGabrielTokenNaoEncontrado(numero, token);
  return {
    texto: 'Recebi sua mensagem com o pedido do site, mas ele ainda não apareceu no nosso sistema. Já avisei a equipe pra conferir, e alguém te responde por aqui.',
    pedido: null,
  };
}

/** Vai junto, pra Luiza, com um texto de pedido do site cujo pedido não foi localizado. */
export const AVISO_TEXTO_PEDIDO_SITE_NAO_LOCALIZADO =
  '[Aviso do sistema, não foi o cliente que escreveu: a mensagem acima é o texto de um pedido feito pelo site, mas o sistema não localizou esse pedido pelo nome e total nem pelo telefone. ' +
  'Você recebeu a mensagem e consegue ler os itens, o endereço e o total nela: nunca diga que não recebeu. Chame buscar_pedidos_recentes antes de responder. ' +
  'Se o pedido não aparecer, diga que recebeu os dados mas não localizou o pedido no sistema e chame chamar_atendente pra equipe conferir. Não registre pedido novo sem o cliente pedir.]';

/** Vai junto, pra Luiza, quando o cliente reenvia o texto de um pedido do site já confirmado nesta conversa. */
export function avisoPedidoDoSiteJaConfirmado(id) {
  return (
    `[Aviso do sistema, não foi o cliente que escreveu: a mensagem acima é o texto do pedido #${id} do site, que já está registrado e já foi confirmado nesta conversa. ` +
    'É o texto original: se o pedido foi alterado depois nesta conversa (ex: item incluído), vale o que está registrado agora, e diferença de valores não é problema. Você recebeu a mensagem: nunca diga que não recebeu, não registre o pedido de novo e não chame a equipe por causa disso. Continue a conversa de onde parou, considerando que o cliente está se referindo a esse pedido.]'
  );
}
