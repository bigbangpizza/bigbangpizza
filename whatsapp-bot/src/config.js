import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name} (veja .env.example)`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT || 3000),

  evolution: {
    apiUrl: required('EVOLUTION_API_URL').replace(/\/+$/, ''),
    apiKey: required('EVOLUTION_API_KEY'),
    instance: required('EVOLUTION_INSTANCE_NAME'),
  },

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-5',
    maxTokens: Number(process.env.CLAUDE_MAX_TOKENS || 700),
  },

  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo',
  },

  supabase: {
    url: required('SUPABASE_URL').replace(/\/+$/, ''),
    anonKey: required('SUPABASE_ANON_KEY'),
    // ATENÇÃO: chave privilegiada (bypassa RLS por completo) — usada SÓ pelas
    // rotinas agendadas (reactivationJob.js, delayedOrdersJob.js,
    // badReviewsJob.js, via src/supabaseAdmin.js), nunca no fluxo público do
    // webhook. Não é obrigatória pra subir o servidor: sem ela, o bot
    // funciona normalmente, só essas 3 rotinas ficam desativadas (loga um
    // aviso e não agenda os crons).
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  menuCacheTtlSeconds: Number(process.env.MENU_CACHE_TTL_SECONDS || 300),

  // Minutos sem sair de "aguardando"/"aceito_preparando" pra um pedido ser
  // considerado atrasado e alertar o Gabriel (delayedOrdersJob.js).
  pedidoAtrasoMinutos: Number(process.env.PEDIDO_ATRASO_MINUTOS || 40),

  // Minutos parado desde a criação do carrinho (sem finalizar o pedido)
  // antes do abandonedCartJob.js mandar a mensagem de recuperação.
  abandonedCartMinutos: Number(process.env.ABANDONED_CART_MINUTOS || 25),

  // Duas janelas usadas pra evitar pedido duplicado (ver orderTool.js e
  // systemPrompt.js) — cenário típico: cliente fecha pedido pelo site e em
  // seguida manda a mensagem pré-preenchida do WhatsApp, que o bot processa
  // como se fosse um pedido novo.
  //   - pedidoDuplicadoContextoMinutos: janela maior, usada só pra AVISAR a
  //     Claude que o cliente já tem um pedido em aberto recente, deixando-a
  //     decidir com bom senso se a mensagem atual é sobre esse pedido ou é
  //     um pedido novo de verdade.
  //   - pedidoDuplicadoBloqueioMinutos: janela menor e mais estrita, usada
  //     como rede de segurança técnica logo antes do INSERT — só bloqueia
  //     se o pedido novo tiver os MESMOS itens e bairro de um pedido aberto
  //     recente (não é uma regra vaga, é comparação exata).
  pedidoDuplicadoContextoMinutos: Number(process.env.PEDIDO_DUPLICADO_CONTEXTO_MINUTOS || 20),
  pedidoDuplicadoBloqueioMinutos: Number(process.env.PEDIDO_DUPLICADO_BLOQUEIO_MINUTOS || 10),

  // Minutos que o bot fica em silêncio pra um número depois de detectar que
  // um humano (Gabriel/equipe) respondeu manualmente pelo WhatsApp — ver
  // atendimentoHumanoUtil.js. Passado esse tempo, a próxima mensagem do
  // cliente volta a ser respondida normalmente pelo bot.
  humanTakeoverPausaMinutos: Number(process.env.HUMAN_TAKEOVER_PAUSA_MINUTOS || 45),

  // Número (só dígitos, com DDI 55, ex: 5571999999999) que recebe o aviso
  // quando um pedido escolhe "Cartão via link (Ton)" — não é obrigatório pra
  // subir o servidor: sem ele, o bot ainda funciona normalmente, só não
  // consegue avisar ninguém sobre pedidos aguardando link Ton (loga um erro).
  gabrielWhatsappNumber: process.env.GABRIEL_WHATSAPP_NUMBER || '',

  // Segredo simples opcional: se definido, o webhook exige ?secret=... na URL.
  // Configure a mesma URL (com o secret) como webhook na Evolution API.
  webhookSecret: process.env.WEBHOOK_SECRET || '',

  // Mesma ideia do webhookSecret acima, mas pro endpoint /alerta-uptime
  // (monitoramento externo, ex: UptimeRobot) — ver src/uptimeAlert.js.
  uptimeWebhookSecret: process.env.UPTIME_WEBHOOK_SECRET || '',

  // Quantas mensagens (pares usuário/assistente) manter por contato, pra dar
  // contexto de conversa. Vale tanto pro histórico em Redis quanto pro
  // fallback em memória (ver historicoRedis.js).
  historyMaxMessages: Number(process.env.HISTORY_MAX_MESSAGES || 12),

  redis: {
    // URL de conexão do Redis já provisionado no Railway junto com a
    // Evolution API (redis://... ou rediss://... se usar TLS). Não é
    // obrigatória pra subir o servidor: sem ela, o histórico de conversa
    // funciona só em memória (some a cada restart) — ver historicoRedis.js.
    url: process.env.REDIS_URL || '',
  },
};
