import { config } from './config.js';

// ═══════════════════════════════════════════════════════════════════════
// ATENÇÃO: este módulo usa a service_role key do Supabase — uma chave
// privilegiada que ignora RLS por completo (lê/escreve qualquer tabela,
// de qualquer cliente). É INTENCIONALMENTE separado de supabaseData.js
// (que usa a chave pública/anon, segura para o fluxo do webhook que lida
// com mensagens de clientes). Normalmente só as rotinas agendadas
// (reactivationJob.js, delayedOrdersJob.js, badReviewsJob.js,
// abandonedCartJob.js) importam este arquivo.
//
// Exceção deliberada: cancelOrderTool.js (tool `cancelar_pedido`, chamada
// direto de dentro do webhook) também usa a service_role key, porque
// cancelar exige um UPDATE em `pedidos` e a policy de RLS de `pedidos` só
// libera INSERT pra anon — não existe outro caminho. Pra manter isso
// seguro mesmo assim: (1) só lê/escreve pedidos cujo `whatsapp` bate com o
// número verificado pelo próprio webhook da Evolution API (nunca um id ou
// telefone informado em texto livre pela IA), e (2) a escrita usa
// `atualizarComoAdminSeStatus` — um UPDATE condicional, não o
// `atualizarComoAdmin` genérico abaixo. Qualquer novo uso desta chave
// dentro do fluxo do webhook deve seguir essa mesma disciplina.
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

/** UPDATE genérico (por id) com a service_role key — só para uso interno do cron. */
export async function atualizarComoAdmin(table, id, dados) {
  const r = await fetch(`${config.supabase.url}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...headers(), prefer: 'return=minimal' },
    body: JSON.stringify(dados),
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`Falha ao atualizar ${table}#${id} (service_role) (${r.status}): ${errBody}`);
  }
}

/**
 * UPDATE condicional (por id + status esperado) com a service_role key —
 * atômico: o Postgres só aplica a escrita se `status` ainda for
 * `statusEsperado` no exato momento em que o UPDATE roda no banco (uma
 * única instrução SQL, sem brecha entre "checar" e "escrever"). Existe
 * especificamente pra resolver corrida entre duas escritas concorrentes na
 * mesma linha — ex: cliente pedindo cancelamento pelo bot ao mesmo tempo
 * que a cozinha aceita o pedido no admin. Retorna as linhas efetivamente
 * atualizadas (`[]` se a condição não bateu — outro processo já tinha
 * mudado o status antes desta escrita chegar).
 */
export async function atualizarComoAdminSeStatus(table, id, statusEsperado, dados) {
  const r = await fetch(
    `${config.supabase.url}/rest/v1/${table}?id=eq.${id}&status=eq.${encodeURIComponent(statusEsperado)}`,
    {
      method: 'PATCH',
      headers: { ...headers(), prefer: 'return=representation' },
      body: JSON.stringify(dados),
    }
  );
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`Falha ao atualizar condicionalmente ${table}#${id} (service_role) (${r.status}): ${errBody}`);
  }
  return r.json();
}
