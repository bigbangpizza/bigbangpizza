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

// Mesma lógica de normalização usada no admin.html (normalizarWhatsapp) —
// texto livre digitado pelo cliente no checkout, sem máscara na origem.
export function normalizarWhatsapp(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length >= 12 && digits.startsWith('55')) return digits;
  if (digits.length === 10 || digits.length === 11) return '55' + digits;
  return digits;
}
