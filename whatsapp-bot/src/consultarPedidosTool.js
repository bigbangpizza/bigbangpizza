import { getMenuData } from './supabaseData.js';
import { temServiceRoleConfigurada } from './supabaseAdmin.js';
import { buscarPedidosRecentesDoCliente, JANELA_BUSCA_PEDIDO_HORAS } from './pedidoStatusUtil.js';
import { montarResumoPedido, textoWhatsApp } from './resumoPedido.js';

// Ferramenta só de leitura: os pedidos recentes do cliente que está
// conversando (pelo telefone e pelos pedidos do site ligados a esta
// conversa — ver vincularPedidoAoNumero em pedidoStatusUtil.js). A Luiza
// chama sempre que o cliente fala de um pedido já feito ("já pedi", "tá no
// pedido que mandei"), em vez de responder de memória — bug real do pedido
// #273, em que ela disse que não havia registro de um pedido que existia.

const CAMPOS = 'nome,itens,itens_json,bairro,subtotal,desconto,cupom,frete,total,pagamento,historico_edicoes';

const STATUS_TEXTO = {
  aguardando: 'aguardando a cozinha aceitar (ainda dá pra editar ou cancelar)',
  aceito_preparando: 'em preparo (não dá mais pra editar por aqui)',
  aceito: 'em preparo (não dá mais pra editar por aqui)',
  preparando: 'em preparo (não dá mais pra editar por aqui)',
  saiu: 'saiu para entrega',
  entregue: 'entregue',
  cancelado: 'cancelado',
};

export const BUSCAR_PEDIDOS_RECENTES_TOOL = {
  name: 'buscar_pedidos_recentes',
  description:
    'Consulta os pedidos que este cliente fez nas últimas horas (pelo site ou por aqui), com status, itens, ' +
    'valores e se ainda dá pra editar. Chame SEMPRE que o cliente mencionar um pedido já feito ("já pedi", ' +
    '"tá no pedido que mandei", "meu pedido", "fiz pelo site"), ou mandar um texto que parece um pedido do ' +
    'site, ANTES de responder — nunca diga que não há registro sem consultar. Também traz, para cada pedido, ' +
    'os itens no formato exato de `editar_pedido` (itens_para_editar), pra você incluir algo sem redigitar.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

/** Itens gravados (itens_json) no formato de entrada do editar_pedido. */
function itensParaEditar(itensJson, nomesDoces, nomesCombos) {
  return (Array.isArray(itensJson) ? itensJson : []).map((i) => {
    const sabores = (i.sabores || []).map((s) => s.nome);
    const nomeBase = String(sabores[0] || '').toLowerCase();
    let tipo;
    if (i.tamanho) tipo = 'pizza_salgada';
    else if (i.oferta_doce || i.tabela === 'pizzas_doces' || nomesDoces.has(nomeBase)) tipo = 'pizza_doce';
    else if (i.tipo === 'combo' || i.tabela === 'combos' || nomesCombos.has(nomeBase)) tipo = 'combo';
    else tipo = 'bebida';
    const item = { tipo, sabor1: sabores[0], quantidade: Math.max(1, parseInt(i.qty, 10) || 1) };
    if (i.tamanho) item.tamanho = i.tamanho;
    if (sabores[1]) item.sabor2 = sabores[1];
    const borda = String(i.borda?.nome || '').toLowerCase();
    if (['catupiry', 'cheddar', 'chocolate'].includes(borda)) item.borda = borda;
    if (i.obs) item.obs = i.obs;
    return item;
  });
}

export function criarExecutorBuscarPedidosRecentes({ numero }) {
  return async function executarBuscarPedidosRecentes() {
    if (!temServiceRoleConfigurada()) {
      return { erro: 'Não consegui consultar os pedidos agora por um problema técnico. Chame a equipe com chamar_atendente.' };
    }
    let pedidos;
    try {
      pedidos = await buscarPedidosRecentesDoCliente(numero, JANELA_BUSCA_PEDIDO_HORAS, CAMPOS);
    } catch (err) {
      console.error(`[buscarPedidos] numero=${numero} falha na consulta:`, err);
      return { erro: 'Não consegui consultar os pedidos agora por um problema técnico. Chame a equipe com chamar_atendente.' };
    }
    console.log(`[buscarPedidos] numero=${numero} encontrados=${pedidos.length}`);
    if (!pedidos.length) {
      return {
        pedidos: [],
        observacao:
          `Nenhum pedido deste telefone nas últimas ${JANELA_BUSCA_PEDIDO_HORAS} horas (pedido do site sem este telefone também pode não aparecer). ` +
          'Não afirme que o cliente não pediu: diga que não localizou o pedido por aqui e chame a equipe com chamar_atendente pra conferir no sistema.',
      };
    }

    const { doces, combos, configuracoes } = await getMenuData();
    const nomesDoces = new Set(doces.map((d) => String(d.nome).toLowerCase()));
    const nomesCombos = new Set((combos || []).map((c) => String(c.nome).toLowerCase()));
    const ofertaAtiva = ['true', '1', 'sim'].includes(String(configuracoes.oferta_doce_ativa || '').toLowerCase());

    return {
      pedidos: pedidos.map((p) => {
        const itens = Array.isArray(p.itens_json) ? p.itens_json : [];
        const temSalgadaGrandeOuFamilia = itens.some((i) => i.tamanho === 'Grande' || i.tamanho === 'Família');
        const jaTemDoceDaOferta = itens.some((i) => i.oferta_doce);
        return {
          pedido_id: p.id,
          status: STATUS_TEXTO[p.status] || p.status,
          pode_editar: p.status === 'aguardando',
          resumo_com_valores: textoWhatsApp(montarResumoPedido(p, nomesDoces)),
          // Editado pela equipe no admin: este resumo já é o atual (vale mais que mensagens antigas da conversa).
          alterado_pela_equipe: Array.isArray(p.historico_edicoes) && p.historico_edicoes.length > 0,
          bairro: p.bairro,
          pagamento: p.pagamento,
          cupom: p.cupom || null,
          itens_para_editar: itensParaEditar(itens, nomesDoces, nomesCombos),
          pode_incluir_doce_da_oferta: ofertaAtiva && temSalgadaGrandeOuFamilia && !jaTemDoceDaOferta && !p.cupom,
        };
      }),
    };
  };
}
