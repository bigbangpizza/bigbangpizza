import { config } from './config.js';

// ═══════════════════════════════════════════════════════════════════════
// ATENÇÃO: este módulo usa a service_role key do Supabase — uma chave
// privilegiada que ignora RLS por completo (lê/escreve qualquer tabela,
// de qualquer cliente). É INTENCIONALMENTE separado de supabaseData.js
// (que usa a chave pública/anon, segura para o fluxo do webhook que lida
// com mensagens de clientes). Só a rotina de reativação (reactivationJob.js)
// deve importar deste arquivo — nunca use isso para responder uma ação
// disparada diretamente por uma mensagem do cliente.
// ═══════════════════════════════════════════════════════════════════════

function headers() {
  return {
    apikey: config.supabase.serviceRoleKey,
    Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
    'content-type': 'application/json',
  };
}

export function temServiceRoleConfigurada() {
  return Boolean(config.supabase.serviceRoleKey);
}

/** SELECT genérico com a service_role key — só para uso interno do cron. */
export async function selectComoAdmin(table, query = '') {
  const temSelect = /(^|&)select=/.test(query);
  const finalQuery = temSelect ? query : `${query}${query ? '&' : ''}select=*`;
  const url = `${config.supabase.url}/rest/v1/${table}?${finalQuery}`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`Falha ao ler ${table} (service_role) (${r.status}): ${errBody}`);
  }
  return r.json();
}

/** INSERT genérico com a service_role key — só para uso interno do cron. */
export async function inserirComoAdmin(table, row) {
  const r = await fetch(`${config.supabase.url}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...headers(), prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`Falha ao inserir em ${table} (service_role) (${r.status}): ${errBody}`);
  }
}
