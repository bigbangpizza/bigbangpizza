import express from 'express';
import cron from 'node-cron';
import { config } from './config.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { conversarComFerramentas, textBlock, imageBlock } from './claude.js';
import { transcreverAudio } from './transcribe.js';
import { baixarMediaBase64 } from './evolutionApi.js';
import { enviarRespostaHumanizada } from './respostaHumanizada.js';
import { CRIAR_PEDIDO_TOOL, criarExecutorCriarPedido } from './orderTool.js';
import { CANCELAR_PEDIDO_TOOL, criarExecutorCancelarPedido } from './cancelOrderTool.js';
import { EDITAR_PEDIDO_TOOL, criarExecutorEditarPedido } from './editOrderTool.js';
import { rodarReativacaoDiaria } from './reactivationJob.js';
import { verificarPedidosAtrasados } from './delayedOrdersJob.js';
import { verificarAvaliacoesRuins } from './badReviewsJob.js';
import { verificarCarrinhosAbandonados } from './abandonedCartJob.js';
import { temServiceRoleConfigurada } from './supabaseAdmin.js';
import { obterHistorico as obterHistoricoRedis, salvarHistorico as salvarHistoricoRedis } from './historicoRedis.js';
import { processarAlertaUptime } from './uptimeAlert.js';
import { ehEcoDoBot, ativarPausaHumana, estaPausadoPorHumano } from './atendimentoHumanoUtil.js';

const app = express();
app.use(express.json({ limit: '25mb' })); // imagens/áudios em base64 podem ser grandes

// Fallback em memória, por número de telefone — usado quando o Redis não
// está configurado ou está indisponível no momento (ver historicoRedis.js).
// Nesse modo degradado, o histórico some a cada restart, igual ao
// comportamento antigo (antes do Redis existir).
const historicoLocal = new Map();

/** Sempre tenta o Redis primeiro; cai pro fallback em memória se não vier nada de lá. */
async function carregarHistorico(numero) {
  const doRedis = await obterHistoricoRedis(numero);
  if (doRedis) {
    historicoLocal.set(numero, doRedis); // mantém o fallback local em dia, caso o Redis caia no meio da conversa
    return doRedis;
  }
  if (!historicoLocal.has(numero)) historicoLocal.set(numero, []);
  return historicoLocal.get(numero);
}

function aplicarLimiteHistorico(mensagens) {
  const limite = config.historyMaxMessages;
  if (mensagens.length > limite) mensagens.splice(0, mensagens.length - limite);
  // Evita deixar um tool_result "órfão" (sem o tool_use correspondente) logo
  // no início do histórico depois do corte — a Claude API rejeita isso.
  while (mensagens.length && Array.isArray(mensagens[0].content) && mensagens[0].content.some((b) => b.type === 'tool_result')) {
    mensagens.shift();
  }
}

/** Grava no fallback local (sempre) e tenta persistir no Redis (best-effort). */
async function persistirHistorico(numero, mensagens) {
  historicoLocal.set(numero, mensagens);
  await salvarHistoricoRedis(numero, mensagens);
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/webhook', (req, res) => {
  if (config.webhookSecret && req.query.secret !== config.webhookSecret) {
    return res.sendStatus(401);
  }
  // Responde 200 imediatamente pra Evolution API não re-tentar o webhook —
  // o processamento (que pode demorar por causa da transcrição/Claude)
  // continua depois, em segundo plano.
  res.sendStatus(200);

  processarWebhook(req.body).catch((err) => {
    console.error('[webhook] erro ao processar mensagem:', err);
  });
});

// ── Fila por número (evita respostas simultâneas/sobrepostas) ─────────────
// Antes, cada mensagem recebida disparava na hora um processarLote()
// independente. Quando o cliente mandava várias mensagens em sequência
// rápida (comum em WhatsApp — 2, 3 balões seguidos pra completar um
// pensamento), isso rodava múltiplas chamadas à Claude e ao envio
// humanizado (enviarRespostaHumanizada, que já leva vários segundos por
// causa do delay de "digitando...") em paralelo pro mesmo número:
// respostas saíam fora de ordem/sobrepostas, e havia até risco de uma
// mensagem se perder do histórico (duas chamadas concorrentes liam o
// histórico antes de qualquer uma delas persistir a sua).
//
// A correção agrupa (debounce) em vez de só travar: mensagens do mesmo
// número são acumuladas e só processadas juntas, como um único turno,
// depois de ~4s sem nenhuma mensagem nova. Isso resolve o problema
// relatado (várias mensagens rápidas geravam respostas separadas e
// sobrepostas) E melhora a conversa — 3 balões digitados em sequência
// viram 1 chamada à Claude com o pensamento completo, em vez de 3
// respostas parciais e possivelmente contraditórias. Se uma mensagem nova
// chegar enquanto o lote anterior ainda está sendo processado, ela entra
// na fila do próximo lote (nunca dispara processamento em paralelo).
const JANELA_DEBOUNCE_MS = 4000;
const filasPorNumero = new Map(); // numero -> { buffer, nomeContato, timer, processando }

function filaDe(numero) {
  let fila = filasPorNumero.get(numero);
  if (!fila) {
    fila = { buffer: [], nomeContato: '', timer: null, processando: false };
    filasPorNumero.set(numero, fila);
  }
  return fila;
}

function enfileirarMensagem(numero, nomeContato, blocos) {
  const fila = filaDe(numero);
  fila.buffer.push(...blocos);
  if (nomeContato) fila.nomeContato = nomeContato;
  if (fila.timer) clearTimeout(fila.timer);
  fila.timer = setTimeout(() => processarFila(numero), JANELA_DEBOUNCE_MS);
}

async function processarFila(numero) {
  const fila = filaDe(numero);
  fila.timer = null;
  // "processando" só pode estar true aqui se um lote anterior ainda não
  // terminou — nesse caso não faz nada agora; o próprio processarFila,
  // no finally logo abaixo, reagenda um novo ciclo assim que esse lote
  // acabar e sobrar algo no buffer, então essa mensagem não fica presa.
  if (fila.processando || !fila.buffer.length) return;

  fila.processando = true;
  const blocos = fila.buffer.splice(0, fila.buffer.length);
  const nomeContato = fila.nomeContato;
  try {
    await processarLote(numero, nomeContato, blocos);
  } catch (err) {
    console.error(`[webhook] numero=${numero} erro ao processar lote de mensagens:`, err);
  } finally {
    fila.processando = false;
    if (fila.buffer.length) {
      fila.timer = setTimeout(() => processarFila(numero), JANELA_DEBOUNCE_MS);
    }
  }
}

// Webhook de monitoramento externo (ex: UptimeRobot) — repassa como alerta
// de WhatsApp pro Gabriel. Ver src/uptimeAlert.js pro template JSON exato
// que precisa ser configurado no painel do serviço de monitoramento.
app.post('/alerta-uptime', (req, res) => {
  if (config.uptimeWebhookSecret && req.query.secret !== config.uptimeWebhookSecret) {
    return res.sendStatus(401);
  }
  res.sendStatus(200);

  processarAlertaUptime(req.body).catch((err) => {
    console.error('[alerta-uptime] erro inesperado ao processar:', err);
  });
});

async function processarWebhook(body) {
  const evento = body?.event;
  const data = body?.data;
  if (!data || !['messages.upsert', 'MESSAGES_UPSERT'].includes(evento)) return;

  const remoteJid = data.key?.remoteJid;
  if (!remoteJid || !remoteJid.endsWith('@s.whatsapp.net')) return; // ignora grupos/status/broadcast
  const numero = remoteJid.split('@')[0];

  if (data.key?.fromMe) {
    tratarMensagemPropria(numero);
    return;
  }

  const nomeContato = data.pushName || '';
  const mensagem = data.message || {};

  let userContent;
  try {
    userContent = await extrairConteudoMensagem(mensagem, data.key?.id);
  } catch (err) {
    console.error('[webhook] erro ao extrair conteúdo da mensagem:', err);
    await enviarRespostaHumanizada(
      numero,
      'Desculpa, não consegui processar essa mensagem 😕 pode tentar de novo ou digitar sua dúvida em texto?'
    );
    return;
  }

  if (!userContent) return; // tipo de mensagem não suportado (figurinha, localização, contato, etc.)

  enfileirarMensagem(numero, nomeContato, userContent);
}

/**
 * Mensagem fromMe (enviada pelo próprio número conectado) — ou é eco de um
 * enviarTexto() que a nossa API acabou de disparar (nada a fazer), ou foi
 * alguém (Gabriel/equipe) digitando manualmente pelo WhatsApp. Nesse
 * segundo caso, pausa as respostas automáticas pra esse número — ver
 * atendimentoHumanoUtil.js e o gate correspondente em processarLote().
 */
function tratarMensagemPropria(numero) {
  if (ehEcoDoBot(numero)) return;
  ativarPausaHumana(numero);
  console.log(
    `[atendimentoHumano] mensagem manual detectada numero=${numero} — pausando respostas automáticas por ${config.humanTakeoverPausaMinutos} min`
  );
}

/**
 * Processa um lote de content blocks (uma ou mais mensagens do cliente
 * acumuladas pela fila acima) como um único turno de conversa: chama a
 * Claude, executa as tools necessárias e envia a resposta humanizada.
 * Nunca roda duas vezes em paralelo pro mesmo número — ver fila acima.
 */
async function processarLote(numero, nomeContato, userContent) {
  const historico = await carregarHistorico(numero);
  // Precisa ser lido ANTES do push abaixo — sinaliza pro system prompt que é
  // a primeira mensagem de uma conversa nova (sem histórico recente), gatilho
  // pra consulta de reconhecimento de cliente recorrente (ver
  // montarBlocoClienteConhecido em systemPrompt.js).
  const ehConversaNova = historico.length === 0;
  historico.push({ role: 'user', content: userContent });
  aplicarLimiteHistorico(historico);
  // Persiste a mensagem do cliente ANTES de chamar a Claude — se a chamada
  // falhar lá na frente, a mensagem já não se perde (o cliente pode mandar
  // de novo sem repetir o que já disse, e o contexto sobrevive mesmo assim).
  await persistirHistorico(numero, historico);

  // Atendimento manual em andamento pra esse número (ver tratarMensagemPropria
  // acima) — a mensagem do cliente já ficou salva no histórico (o bot tem
  // contexto quando retomar), mas não gera resposta automática agora.
  // Checado aqui (não só na chegada do webhook) porque a pausa pode ter
  // começado durante a janela de debounce da fila.
  if (estaPausadoPorHumano(numero)) {
    console.log(`[atendimentoHumano] numero=${numero} pausado — mensagem guardada, bot não respondeu`);
    return;
  }

  const systemPrompt = await buildSystemPrompt(numero, ehConversaNova);
  const tools = [CRIAR_PEDIDO_TOOL, CANCELAR_PEDIDO_TOOL, EDITAR_PEDIDO_TOOL];
  const toolExecutors = {
    criar_pedido: criarExecutorCriarPedido({ numero, nomeContato }),
    cancelar_pedido: criarExecutorCancelarPedido({ numero }),
    editar_pedido: criarExecutorEditarPedido({ numero }),
  };

  const { textoResposta, novasMensagens } = await conversarComFerramentas(systemPrompt, historico, tools, toolExecutors);

  historico.push(...novasMensagens);
  aplicarLimiteHistorico(historico);
  await persistirHistorico(numero, historico);

  await enviarRespostaHumanizada(numero, textoResposta);
}

/** Converte a mensagem recebida da Evolution API em content blocks pra Claude. */
async function extrairConteudoMensagem(mensagem, messageId) {
  const texto = mensagem.conversation || mensagem.extendedTextMessage?.text;
  if (texto) return [textBlock(texto)];

  if (mensagem.audioMessage) {
    const media = await obterMedia(mensagem.audioMessage, messageId);
    if (!media) return [textBlock('[O cliente enviou um áudio, mas não foi possível baixá-lo]')];
    const textoTranscrito = await transcreverAudio(Buffer.from(media.base64, 'base64'), media.mimetype);
    if (!textoTranscrito) {
      return [textBlock('[O cliente enviou um áudio, mas não foi possível entender o que foi dito]')];
    }
    return [textBlock(textoTranscrito)];
  }

  if (mensagem.imageMessage) {
    const media = await obterMedia(mensagem.imageMessage, messageId);
    if (!media) return [textBlock('[O cliente enviou uma imagem, mas não foi possível baixá-la]')];
    const blocks = [imageBlock(media.base64, media.mimetype)];
    if (mensagem.imageMessage.caption) blocks.push(textBlock(mensagem.imageMessage.caption));
    return blocks;
  }

  return null;
}

/** Pega a mídia já em base64 do próprio webhook (se `webhook_base64` estiver
 * ligado na instância) ou baixa via API como fallback. */
async function obterMedia(mediaMessage, messageId) {
  if (mediaMessage.base64) {
    return { base64: mediaMessage.base64, mimetype: mediaMessage.mimetype || 'application/octet-stream' };
  }
  if (!messageId) return null;
  return baixarMediaBase64(messageId);
}

app.listen(config.port, () => {
  console.log(`🍕 Big Bang Pizza WhatsApp bot rodando na porta ${config.port}`);
});

// Reativação automática de clientes "em risco" — roda a cada hora (horário
// de Lauro de Freitas/BA); o próprio rodarReativacaoDiaria() decide se o
// dia/hora batem com o configurado na aba "Configurações do Bot" do
// admin.html (padrão: todos os dias às 15h, antes da abertura da loja às
// 18h). Disparar a cada hora em vez de num horário fixo é o que permite
// mudar dia/hora pelo admin sem precisar reiniciar o bot. Só agenda se a
// service_role key estiver configurada; sem ela, a rotina não tem como
// ler o histórico de pedidos (RLS bloqueia a chave pública) e ficaria só
// gerando erro à toa.
if (temServiceRoleConfigurada()) {
  cron.schedule('0 * * * *', () => {
    rodarReativacaoDiaria().catch((err) => {
      console.error('[reactivationJob] erro inesperado na execução agendada:', err);
    });
  }, { timezone: 'America/Bahia' });
  console.log('🕒 Reativação automática de clientes: checagem a cada hora (dia/hora configuráveis no admin, padrão 15h).');

  // Pedido atrasado — verifica a cada 10 min se algum pedido está parado em
  // "aguardando"/"aceito_preparando" há mais que o limiar configurado.
  cron.schedule('*/10 * * * *', () => {
    verificarPedidosAtrasados().catch((err) => {
      console.error('[delayedOrdersJob] erro inesperado na execução agendada:', err);
    });
  });
  console.log(`🕒 Verificação de pedidos atrasados agendada a cada 10 min (limiar padrão: ${config.pedidoAtrasoMinutos} min, ajustável no admin).`);

  // Avaliação ruim — verifica a cada 5 min se alguma avaliação com nota ≤ 3
  // chegou e ainda não foi avisada ao Gabriel.
  cron.schedule('*/5 * * * *', () => {
    verificarAvaliacoesRuins().catch((err) => {
      console.error('[badReviewsJob] erro inesperado na execução agendada:', err);
    });
  });
  console.log('🕒 Verificação de avaliações baixas agendada a cada 5 min.');

  // Carrinho abandonado — verifica a cada 10 min carrinhos registrados pelo
  // site (com telefone) parados há mais de ABANDONED_CART_MINUTOS sem
  // finalizar o pedido, envia a mensagem de recuperação e cuida da
  // conversão/expiração de cada carrinho.
  cron.schedule('*/10 * * * *', () => {
    verificarCarrinhosAbandonados().catch((err) => {
      console.error('[abandonedCartJob] erro inesperado na execução agendada:', err);
    });
  });
  console.log(`🕒 Verificação de carrinhos abandonados agendada a cada 10 min (limiar: ${config.abandonedCartMinutos} min).`);
} else {
  console.warn(
    '⚠️ SUPABASE_SERVICE_ROLE_KEY não configurada — reativação automática de clientes, alerta de pedido ' +
      'atrasado, alerta de avaliação baixa e recuperação de carrinho abandonado estão todos desativados.'
  );
}
