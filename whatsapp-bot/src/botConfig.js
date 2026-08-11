import { config } from './config.js';
import { selectComoAdmin } from './supabaseAdmin.js';

// Valores usados hoje em produção (env vars / constantes fixas) — viram o
// fallback enquanto o campo correspondente ainda não foi preenchido na aba
// "Configurações do Bot" do admin.html, pra não quebrar nada na transição.
const DEFAULT_REATIVACAO_DIAS_SEMANA = [0, 1, 2, 3, 4, 5, 6]; // todos os dias (comportamento atual)
const DEFAULT_REATIVACAO_HORA = 15;
const DEFAULT_REATIVACAO_CUPOM_CODIGO = 'VOLTEI10';
const DEFAULT_REATIVACAO_CUPOM_PERCENTUAL = 10;

function parseDiasSemana(raw) {
  if (!raw) return null;
  const dias = raw
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return dias.length ? [...new Set(dias)] : null;
}

function parseHora(raw) {
  const hora = Number(raw);
  return Number.isInteger(hora) && hora >= 0 && hora <= 23 ? hora : null;
}

function parseMinutos(raw) {
  const minutos = Number(raw);
  return Number.isFinite(minutos) && minutos > 0 ? minutos : null;
}

function parsePercentual(raw) {
  const pct = Number(raw);
  return Number.isFinite(pct) && pct > 0 && pct <= 100 ? pct : null;
}

/**
 * Lê a tabela `configuracoes` inteira com a service_role key (mesmo padrão
 * das outras rotinas agendadas — supabaseAdmin.js) e resolve os valores
 * operacionais editáveis na aba "Configurações do Bot" do admin.html,
 * caindo pro valor padrão (o mesmo já usado hoje em produção) quando o
 * campo ainda não foi preenchido por lá.
 */
export async function obterConfigBotAdmin() {
  const rows = await selectComoAdmin('configuracoes', '');
  const cfg = {};
  for (const row of rows) cfg[row.chave] = row.valor;

  return {
    alertaWhatsappNumero: cfg.alerta_whatsapp_numero || config.gabrielWhatsappNumber,
    pedidoAtrasoMinutos: parseMinutos(cfg.pedido_atraso_minutos) ?? config.pedidoAtrasoMinutos,
    reativacaoDiasSemana: parseDiasSemana(cfg.reativacao_dias_semana) ?? DEFAULT_REATIVACAO_DIAS_SEMANA,
    reativacaoHora: parseHora(cfg.reativacao_hora) ?? DEFAULT_REATIVACAO_HORA,
    reativacaoCupomCodigo: cfg.reativacao_cupom_codigo || DEFAULT_REATIVACAO_CUPOM_CODIGO,
    reativacaoCupomPercentual: parsePercentual(cfg.reativacao_cupom_percentual) ?? DEFAULT_REATIVACAO_CUPOM_PERCENTUAL,
  };
}
