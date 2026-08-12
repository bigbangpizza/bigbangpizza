import { config } from './config.js';
import { enviarTexto } from './evolutionApi.js';
import { temServiceRoleConfigurada } from './supabaseAdmin.js';
import { obterConfigBotAdmin } from './botConfig.js';

// Repassa o webhook de monitoramento externo (UptimeRobot) como alerta de
// WhatsApp pro Gabriel. O UptimeRobot não tem um formato de payload fixo —
// o corpo é o template JSON que você mesmo configura no painel deles
// ("Web-Hook" em Alert Contacts, com "Send as JSON" ligado). Configure o
// "POST value" com exatamente isto (as variáveis entre *asteriscos* são
// substituídas pelo UptimeRobot na hora do envio):
//
//   {
//     "alertTypeFriendlyName": "*alertTypeFriendlyName*",
//     "alertType": "*alertType*",
//     "alertDetails": "*alertDetails*",
//     "alertDateTime": "*alertDateTime*"
//   }
//
// alertType: 1 = down, 2 = up, 3 = SSL/domínio expirando (docs do
// UptimeRobot) — confere os dois campos (código E nome amigável) pra não
// depender só de um formato.

function ehVoltaAoNormal(body) {
  const tipoAmigavel = String(body?.alertTypeFriendlyName || '').toLowerCase();
  const tipoCodigo = String(body?.alertType ?? '').trim();
  return tipoAmigavel.includes('up') || tipoCodigo === '2';
}

/** alertDateTime normalmente vem em Unix timestamp (segundos) — cai pra parse direto se não for numérico. */
function formatarDataHora(valor) {
  if (!valor) return '';
  const segundos = Number(valor);
  const data = Number.isFinite(segundos) && segundos > 0 ? new Date(segundos * 1000) : new Date(valor);
  if (Number.isNaN(data.getTime())) return '';
  return data.toLocaleString('pt-BR', { timeZone: 'America/Bahia', dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Número que recebe o alerta: tenta o configurado na aba "Configurações do
 * Bot" do admin.html primeiro (mesma fonte dos outros alertas), mas nunca
 * deixa a falta/instabilidade do Supabase bloquear um aviso de "o bot tá
 * fora do ar" — se o Supabase não responder ou a service_role key não
 * estiver configurada, cai direto pro GABRIEL_WHATSAPP_NUMBER do .env.
 */
async function resolverNumeroAlerta() {
  if (temServiceRoleConfigurada()) {
    try {
      const { alertaWhatsappNumero } = await obterConfigBotAdmin();
      if (alertaWhatsappNumero) return alertaWhatsappNumero;
    } catch (err) {
      console.error('[uptimeAlert] falha ao ler número configurado no admin, usando o do .env:', err.message);
    }
  }
  return config.gabrielWhatsappNumber;
}

export async function processarAlertaUptime(body) {
  const numero = await resolverNumeroAlerta();
  if (!numero) {
    console.warn('[uptimeAlert] Nenhum número de alerta configurado (admin ou GABRIEL_WHATSAPP_NUMBER) — não foi possível repassar o alerta do UptimeRobot.');
    return;
  }

  const voltouAoNormal = ehVoltaAoNormal(body);
  const dataHora = formatarDataHora(body?.alertDateTime);
  const detalhes = String(body?.alertDetails || '').trim();
  const extras = [detalhes && `Detalhe: ${detalhes}`, dataHora && `Horário: ${dataHora}`].filter(Boolean).join('\n');

  const msg = voltouAoNormal
    ? `🟢 Big Bang Pizza WhatsApp Bot voltou ao normal.${extras ? `\n${extras}` : ''}`
    : `🔴 Alerta: Big Bang Pizza WhatsApp Bot está fora do ar. Verifique o Railway.${extras ? `\n${extras}` : ''}`;

  await enviarTexto(numero, msg);
  console.log(`[uptimeAlert] alerta repassado: resultado=${voltouAoNormal ? 'up' : 'down'} numero=${numero}`);
}
