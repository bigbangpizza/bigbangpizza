import { config } from './config.js';
import { temServiceRoleConfigurada, selectComoAdmin, atualizarComoAdmin } from './supabaseAdmin.js';
import { enviarTexto } from './evolutionApi.js';
import { parseComoUTC, minutosEntre } from './dataUtils.js';

// Só esses 2 status contam como "em andamento" pra fins de atraso — "saiu" e
// "entregue" já passaram da etapa que importa aqui, e "aguardando"/
// "aceito_preparando" são exatamente as 2 colunas iniciais do kanban do
// admin (ver CORES_STATUS_PEDIDO / COLUNAS_KANBAN_PEDIDOS em admin.html).
const STATUS_MONITORADOS = ['aguardando', 'aceito_preparando'];

const STATUS_LABEL = {
  aguardando: 'Aguardando',
  aceito_preparando: 'Aceito/Preparando',
};

/**
 * Rotina periódica (a cada 10 min) que identifica pedidos parados há mais
 * de `PEDIDO_ATRASO_MINUTOS` (padrão 40) em "aguardando" ou
 * "aceito_preparando" e avisa o Gabriel — uma única vez por pedido
 * (marca `alerta_atraso_enviado=true` depois de enviar). Erros em pedidos
 * individuais são logados e não interrompem os demais.
 */
export async function verificarPedidosAtrasados() {
  if (!temServiceRoleConfigurada()) {
    console.warn(
      '[delayedOrdersJob] SUPABASE_SERVICE_ROLE_KEY não configurada — pulando verificação de pedidos atrasados.'
    );
    return { pulado: true };
  }

  if (!config.gabrielWhatsappNumber) {
    console.warn('[delayedOrdersJob] GABRIEL_WHATSAPP_NUMBER não configurado — pulando verificação de pedidos atrasados.');
    return { pulado: true };
  }

  let pedidos;
  try {
    const statusFiltro = STATUS_MONITORADOS.join(',');
    pedidos = await selectComoAdmin(
      'pedidos',
      `select=id,nome,itens,status,created_at&status=in.(${statusFiltro})&alerta_atraso_enviado=is.false`
    );
  } catch (err) {
    console.error('[delayedOrdersJob] falha ao buscar pedidos em andamento — abortando desta vez:', err);
    return { erro: true };
  }

  const agora = new Date();
  let alertados = 0;
  let falhas = 0;

  for (const pedido of pedidos) {
    try {
      const criadoEm = parseComoUTC(pedido.created_at);
      const minutosParado = minutosEntre(criadoEm, agora);
      if (minutosParado < config.pedidoAtrasoMinutos) continue;

      const itensResumo = pedido.itens || '(itens não informados)';
      const statusLabel = STATUS_LABEL[pedido.status] || pedido.status;
      const msg =
        `⚠️ Pedido atrasado: ${pedido.nome}, ${itensResumo}, aguardando há ${minutosParado} min. ` +
        `Status atual: ${statusLabel}.`;

      await enviarTexto(config.gabrielWhatsappNumber, msg);
      await atualizarComoAdmin('pedidos', pedido.id, { alerta_atraso_enviado: true });
      alertados++;
    } catch (err) {
      falhas++;
      console.error(`[delayedOrdersJob] falha ao processar pedido #${pedido.id}:`, err);
      // segue pro próximo pedido — erro individual não trava o lote inteiro
    }
  }

  if (alertados || falhas) {
    console.log(`[delayedOrdersJob] concluído: ${alertados} alerta(s) enviado(s), ${falhas} falha(s), ${pedidos.length} pedido(s) verificado(s).`);
  }
  return { alertados, falhas, totalVerificados: pedidos.length };
}
