import express from 'express';
import { config } from './config.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { askClaude, textBlock, imageBlock } from './claude.js';
import { transcreverAudio } from './transcribe.js';
import { enviarTexto, baixarMediaBase64 } from './evolutionApi.js';

const app = express();
app.use(express.json({ limit: '25mb' })); // imagens/áudios em base64 podem ser grandes

// Histórico de conversa em memória, por número de telefone. Suficiente pra
// dar contexto num primeiro atendimento; some quando o processo reinicia
// (ver README.md — "Próximos passos" — pra evoluir isso pra um banco/Redis).
const historico = new Map();

function getHistorico(numero) {
  if (!historico.has(numero)) historico.set(numero, []);
  return historico.get(numero);
}

function guardarNoHistorico(numero, role, content) {
  const h = getHistorico(numero);
  h.push({ role, content });
  const limite = config.historyMaxMessages;
  if (h.length > limite) h.splice(0, h.length - limite);
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

async function processarWebhook(body) {
  const evento = body?.event;
  const data = body?.data;
  if (!data || !['messages.upsert', 'MESSAGES_UPSERT'].includes(evento)) return;
  if (data.key?.fromMe) return; // ignora eco das próprias mensagens do bot

  const remoteJid = data.key?.remoteJid;
  if (!remoteJid || !remoteJid.endsWith('@s.whatsapp.net')) return; // ignora grupos/status/broadcast

  const numero = remoteJid.split('@')[0];
  const mensagem = data.message || {};

  let userContent;
  try {
    userContent = await extrairConteudoMensagem(mensagem, data.key?.id);
  } catch (err) {
    console.error('[webhook] erro ao extrair conteúdo da mensagem:', err);
    await enviarTexto(
      numero,
      'Desculpa, não consegui processar essa mensagem 😕 pode tentar de novo ou digitar sua dúvida em texto?'
    );
    return;
  }

  if (!userContent) return; // tipo de mensagem não suportado (figurinha, localização, contato, etc.)

  guardarNoHistorico(numero, 'user', userContent);

  const systemPrompt = await buildSystemPrompt();
  const resposta = await askClaude(systemPrompt, getHistorico(numero));

  guardarNoHistorico(numero, 'assistant', [textBlock(resposta)]);
  await enviarTexto(numero, resposta);
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
