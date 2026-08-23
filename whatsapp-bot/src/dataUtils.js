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

// Mesmo critério de segmentação usado em admin.html (classificarSegmentoCliente,
// aba Clientes) — duplicado aqui porque admin.html é JS puro de navegador,
// sem módulo compartilhado com o bot. Critérios (loja abre só qui-dom, 14
// dias ≈ 2 fins de semana sem pedido):
//   1) >14 dias sem pedido, qualquer frequência  → em_risco (prioridade máxima: quem sumiu)
//   2) 3+ pedidos                                → fiel
//   3) 1 pedido só                                → novo
//   4) (sobra: 2 pedidos, ≤14 dias)                → ativo
// Se mudar aqui, mude também em admin.html pra não divergir do que o
// Gabriel vê na aba Clientes.
export function classificarSegmentoCliente(totalPedidos, diasDesdeUltimo) {
  if (diasDesdeUltimo > 14) return 'em_risco';
  if (totalPedidos >= 3) return 'fiel';
  if (totalPedidos === 1) return 'novo';
  return 'ativo';
}

/**
 * Dia da semana (0=domingo...6=sábado, mesma convenção do JS Date#getDay) e
 * hora atual no horário de Lauro de Freitas (BA), independente do fuso
 * horário onde o servidor do bot estiver rodando (Railway/Render costumam
 * rodar em UTC ou horário dos EUA por padrão).
 */
export function getAgoraNoBrasil() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bahia',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const weekdayShort = parts.find((p) => p.type === 'weekday').value;
  const hora = Number(parts.find((p) => p.type === 'hour').value);
  const mapaDia = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { diaSemana: mapaDia[weekdayShort], hora };
}
