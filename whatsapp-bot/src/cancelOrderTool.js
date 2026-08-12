import { temServiceRoleConfigurada, atualizarComoAdminSeStatus } from './supabaseAdmin.js';
import { buscarPedidoRecenteDoCliente, mensagemRecusaAcaoPedido, JANELA_BUSCA_PEDIDO_HORAS } from './pedidoStatusUtil.js';

/**
 * Definição da tool `cancelar_pedido` — sem parâmetros: o pedido a
 * cancelar é sempre o mais recente do próprio número que está
 * conversando (nunca um id informado em texto livre pela IA/cliente).
 */
export const CANCELAR_PEDIDO_TOOL = {
  name: 'cancelar_pedido',
  description:
    'Cancela o pedido mais recente do cliente que está conversando agora — só funciona se o pedido ainda ' +
    'não tiver sido aceito pela cozinha. Chame isso SÓ quando o cliente quer desistir do pedido de vez ' +
    '(não use pra trocar bairro/item/pagamento — pra isso existe a tool `editar_pedido`). Não peça ' +
    'confirmação por escrito antes de chamar (a ferramenta é rápida e reversível de explicar depois). ' +
    'Nunca tente adivinhar ou supor pelo histórico da conversa se ainda dá tempo de cancelar — a ferramenta ' +
    'sempre confere o status real no banco de dados no exato momento da chamada, que é a única fonte confiável ' +
    '(o status pode ter mudado desde a última vez que você mencionou ele). Se a resposta vier com ' +
    '"mensagem_para_cliente", repasse esse texto ao cliente literalmente, sem reformular.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

/**
 * Cria o executor da tool `cancelar_pedido`, já amarrado ao número
 * verificado da conversa (mesmo padrão de segurança do orderTool.js — o
 * telefone vem sempre do contexto real do webhook, nunca de texto livre).
 *
 * Corrida cliente-cancela vs. cozinha-aceita: a checagem de status e a
 * escrita do cancelamento NÃO são dois passos separados (select, depois
 * decide, depois update) — isso deixaria uma brecha entre o select e o
 * update onde a cozinha poderia aceitar o pedido bem no meio. Em vez disso,
 * a escrita em si (`atualizarComoAdminSeStatus`) já é condicional a
 * `status = 'aguardando'` no momento exato do UPDATE, dentro de uma única
 * instrução SQL atômica no Postgres. Se a cozinha aceitar um milissegundo
 * antes dessa escrita, o UPDATE simplesmente não afeta nenhuma linha — e é
 * só esse resultado (0 linhas afetadas) que decide se o cancelamento
 * aconteceu, não o valor lido antes.
 */
export function criarExecutorCancelarPedido({ numero }) {
  return async function executarCancelarPedido() {
    if (!temServiceRoleConfigurada()) {
      console.error('[cancelOrderTool] SUPABASE_SERVICE_ROLE_KEY não configurada — não é possível processar cancelamento.');
      return { erro: 'Não consegui verificar seu pedido agora por um problema técnico. Tente de novo em instantes.' };
    }

    let pedido;
    try {
      pedido = await buscarPedidoRecenteDoCliente(numero);
    } catch (err) {
      console.error(`[cancelamento] numero=${numero} falha ao buscar pedido:`, err);
      return { erro: 'Não consegui verificar seu pedido agora por um problema técnico. Tente de novo em instantes.' };
    }

    if (!pedido) {
      console.log(`[cancelamento] numero=${numero} resultado=nao_encontrado`);
      return { erro: `Não encontrei nenhum pedido seu nas últimas ${JANELA_BUSCA_PEDIDO_HORAS} horas pra cancelar.` };
    }

    if (pedido.status === 'cancelado') {
      console.log(`[cancelamento] pedido=${pedido.id} numero=${numero} resultado=ja_cancelado`);
      return { erro: 'Esse pedido já estava cancelado — não precisa fazer nada.' };
    }

    if (pedido.status !== 'aguardando') {
      console.log(`[cancelamento] pedido=${pedido.id} numero=${numero} status_no_momento_da_leitura=${pedido.status} resultado=recusado_pre_checagem`);
      return { erro: true, mensagem_para_cliente: await mensagemRecusaAcaoPedido('cancelar') };
    }

    let linhasAfetadas;
    try {
      linhasAfetadas = await atualizarComoAdminSeStatus('pedidos', pedido.id, 'aguardando', { status: 'cancelado' });
    } catch (err) {
      console.error(`[cancelamento] pedido=${pedido.id} numero=${numero} falha ao escrever cancelamento:`, err);
      return { erro: 'Não consegui cancelar agora por um problema técnico. Tente de novo em instantes.' };
    }

    if (!linhasAfetadas.length) {
      // Corrida: entre a leitura acima e este UPDATE, o status mudou (a
      // cozinha aceitou o pedido nesse intervalo). Não cancela.
      console.log(`[cancelamento] pedido=${pedido.id} numero=${numero} resultado=recusado_corrida_na_escrita`);
      return { erro: true, mensagem_para_cliente: await mensagemRecusaAcaoPedido('cancelar') };
    }

    console.log(`[cancelamento] pedido=${pedido.id} numero=${numero} resultado=cancelado`);
    return { sucesso: true, pedido_id: pedido.id };
  };
}
