// Utilitários de data compartilhados pelas rotinas agendadas (reactivationJob,
// delayedOrdersJob) — extraído porque os dois precisam da mesma conversão.

/**
 * `pedidos.created_at` é "timestamp without time zone" no Postgres, mas o
 * valor gravado pelo site/bot vem de `toISOString()` (sempre UTC) sem o
 * sufixo "Z". Se deixarmos o JS interpretar essa string "nua" como horário
 * local do servidor, o cálculo de tempo decorrido fica errado em servidores
 * que não rodam em UTC (Railway/Render podem rodar em qualquer fuso).
 * Forçamos UTC explicitamente aqui.
 */
export function parseComoUTC(valor) {
  if (!valor) return null;
  const iso = valor.includes('T') ? valor : valor.replace(' ', 'T');
  return new Date(iso.endsWith('Z') ? iso : iso + 'Z');
}

export function diasEntre(dataAntiga, dataRecente) {
  return Math.floor((dataRecente.getTime() - dataAntiga.getTime()) / 86400000);
}

export function minutosEntre(dataAntiga, dataRecente) {
  return Math.floor((dataRecente.getTime() - dataAntiga.getTime()) / 60000);
}
