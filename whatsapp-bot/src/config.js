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
    // ATENÇÃO: chave privilegiada (bypassa RLS por completo) — usada SÓ pela
    // rotina de reativação (src/reactivationJob.js / src/supabaseAdmin.js),
    // nunca no fluxo público do webhook. Não é obrigatória pra subir o
    // servidor: sem ela, o bot funciona normalmente, só a reativação
    // automática fica desativada (loga um aviso e não agenda o cron).
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  menuCacheTtlSeconds: Number(process.env.MENU_CACHE_TTL_SECONDS || 300),

  // Número (só dígitos, com DDI 55, ex: 5571999999999) que recebe o aviso
  // quando um pedido escolhe "Cartão via link (Ton)" — não é obrigatório pra
  // subir o servidor: sem ele, o bot ainda funciona normalmente, só não
  // consegue avisar ninguém sobre pedidos aguardando link Ton (loga um erro).
  gabrielWhatsappNumber: process.env.GABRIEL_WHATSAPP_NUMBER || '',

  // Segredo simples opcional: se definido, o webhook exige ?secret=... na URL.
  // Configure a mesma URL (com o secret) como webhook na Evolution API.
  webhookSecret: process.env.WEBHOOK_SECRET || '',

  // Quantas mensagens (pares usuário/assistente) manter em memória por
  // contato, para dar contexto de conversa sem precisar de banco de dados.
  historyMaxMessages: Number(process.env.HISTORY_MAX_MESSAGES || 12),
};
