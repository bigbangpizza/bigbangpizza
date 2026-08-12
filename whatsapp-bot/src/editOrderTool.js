import { getMenuData } from './supabaseData.js';
import { temServiceRoleConfigurada, atualizarComoAdminSeStatus } from './supabaseAdmin.js';
import { buscarPedidoRecenteDoCliente, mensagemRecusaAcaoPedido, JANELA_BUSCA_PEDIDO_HORAS } from './pedidoStatusUtil.js';
import { processarItens, buscarPorNome, PAGAMENTO_TEXTO } from './orderTool.js';

const CAMPOS_PEDIDO_EDITAVEL = 'nome,endereco,bairro,complemento,pagamento,itens,itens_json,subtotal,frete,total,desconto';

/**
 * Definição da tool `editar_pedido` — mesma ideia do `cancelar_pedido`
 * (sem id: sempre o pedido mais recente do próprio número que está
 * conversando), mas em vez de cancelar, troca só os campos informados.
 * Cada campo é opcional; o que não vier é mantido como estava no pedido.
 */
export const EDITAR_PEDIDO_TOOL = {
  name: 'editar_pedido',
  description:
    'Altera o pedido mais recente do cliente que está conversando agora (item errado, bairro errado, ' +
    'forma de pagamento) — só funciona se o pedido ainda não tiver sido aceito pela cozinha, mesma janela ' +
    'do cancelamento. Use isso em vez de `cancelar_pedido` sempre que o cliente quiser CORRIGIR algo e ' +
    'continuar com o pedido, não desistir dele. Envie só os campos que realmente vão mudar — o que não for ' +
    'enviado continua exatamente como estava. Se enviar "itens", mande a lista COMPLETA e final (não é ' +
    'incremental: se o cliente só quer trocar 1 sabor de 3 pizzas, inclua as 3, já com a troca aplicada). ' +
    'O sistema sempre recalcula subtotal/frete/total a partir do cardápio e bairros reais — nunca confie em ' +
    'valor que você mesmo tenha calculado. Nunca tente adivinhar pelo histórico da conversa se ainda dá tempo ' +
    'de editar — a ferramenta sempre confere o status real no banco no exato momento da chamada. Se a resposta ' +
    'vier com "mensagem_para_cliente", repasse esse texto ao cliente literalmente, sem reformular.',
  input_schema: {
    type: 'object',
    properties: {
      itens: {
        type: 'array',
        minItems: 1,
        description: 'Lista COMPLETA e final dos itens do pedido. Omita se os itens não vão mudar.',
        items: {
          type: 'object',
          properties: {
            tipo: { type: 'string', enum: ['pizza_salgada', 'pizza_doce', 'combo', 'bebida'] },
            tamanho: {
              type: 'string',
              enum: ['Grande', 'Família'],
              description: 'Obrigatório apenas para tipo "pizza_salgada".',
            },
            sabor1: { type: 'string', description: 'Nome do produto/sabor exatamente como está no cardápio.' },
            sabor2: {
              type: 'string',
              description: 'Segundo sabor, apenas se for pizza salgada meio a meio. Deixe vazio para pizza de sabor único.',
            },
            quantidade: { type: 'integer', minimum: 1 },
            obs: { type: 'string', description: 'Observação específica deste item (ex: massa fina, bem assada).' },
          },
          required: ['tipo', 'sabor1', 'quantidade'],
        },
      },
      endereco: { type: 'string', description: 'Novo endereço (rua e número). Omita se o endereço não vai mudar.' },
      complemento: { type: 'string', description: 'Novo complemento. Omita se não vai mudar.' },
      bairro: {
        type: 'string',
        description: 'Novo bairro, exatamente como o cliente disse — validado contra a área de entrega real. Omita se o bairro não vai mudar.',
      },
      forma_pagamento: {
        type: 'string',
        enum: ['presencial', 'pix', 'cartao_link'],
        description: 'Nova forma de pagamento. Omita se não vai mudar.',
      },
      observacao_geral: { type: 'string', description: 'Nova observação geral do pedido. Omita se não vai mudar.' },
    },
    required: [],
  },
};

/** Nenhum campo de alteração foi enviado — não há o que fazer. */
function nenhumCampoParaMudar(input) {
  return (
    !input.itens &&
    input.endereco === undefined &&
    input.complemento === undefined &&
    !input.bairro &&
    !input.forma_pagamento &&
    input.observacao_geral === undefined
  );
}

/**
 * Cria o executor da tool `editar_pedido`, já amarrado ao número
 * verificado da conversa. Segue o mesmo padrão de segurança do
 * cancelamento (ver cancelOrderTool.js): a checagem de status e a escrita
 * NÃO são dois passos separados — a escrita em si já é condicional a
 * `status = 'aguardando'` no momento exato do UPDATE (uma única instrução
 * SQL atômica), então se a cozinha aceitar o pedido no meio da edição, o
 * UPDATE simplesmente não afeta nenhuma linha e a edição é recusada, nunca
 * aplicada pela metade.
 */
export function criarExecutorEditarPedido({ numero }) {
  return async function executarEditarPedido(input) {
    if (!temServiceRoleConfigurada()) {
      console.error('[editOrderTool] SUPABASE_SERVICE_ROLE_KEY não configurada — não é possível processar edição.');
      return { erro: 'Não consegui acessar seu pedido agora por um problema técnico. Tente de novo em instantes.' };
    }

    if (nenhumCampoParaMudar(input)) {
      return { erro: 'Não entendi o que você quer mudar no pedido — me diga se é item, bairro/endereço ou forma de pagamento.' };
    }

    let pedido;
    try {
      pedido = await buscarPedidoRecenteDoCliente(numero, CAMPOS_PEDIDO_EDITAVEL);
    } catch (err) {
      console.error(`[edicao] numero=${numero} falha ao buscar pedido:`, err);
      return { erro: 'Não consegui verificar seu pedido agora por um problema técnico. Tente de novo em instantes.' };
    }

    if (!pedido) {
      console.log(`[edicao] numero=${numero} resultado=nao_encontrado`);
      return { erro: `Não encontrei nenhum pedido seu nas últimas ${JANELA_BUSCA_PEDIDO_HORAS} horas pra editar.` };
    }

    if (pedido.status === 'cancelado') {
      console.log(`[edicao] pedido=${pedido.id} numero=${numero} resultado=ja_cancelado`);
      return { erro: 'Esse pedido já foi cancelado — não dá pra editar. Se quiser, posso anotar um pedido novo do zero.' };
    }

    if (pedido.status !== 'aguardando') {
      console.log(`[edicao] pedido=${pedido.id} numero=${numero} status_na_leitura=${pedido.status} resultado=recusado_pre_checagem`);
      return { erro: true, mensagem_para_cliente: await mensagemRecusaAcaoPedido('editar') };
    }

    // Monta o próximo estado: revalida contra o cardápio/bairros reais só o
    // que veio no input; o que não veio mantém o valor atual do pedido.
    const menuData = await getMenuData();
    const erros = [];
    const patch = {};

    let subtotalFinal = Number(pedido.subtotal) || 0;
    let itensTextoFinal = pedido.itens;

    if (input.itens) {
      const { itensProcessados, erros: errosItens } = processarItens(input.itens, menuData);
      erros.push(...errosItens);
      if (!errosItens.length) {
        subtotalFinal = +itensProcessados.reduce((s, i) => s + i.precoUnitario * i.qty, 0).toFixed(2);
        itensTextoFinal = itensProcessados.map((i) => `${i.qty}x ${i.nomeExibicao}`).join(' | ');
        patch.itens = itensTextoFinal;
        patch.itens_json = itensProcessados.map(({ tipo, tamanho, sabores, precoUnitario, qty, obs }) => ({
          tipo,
          tamanho,
          sabores,
          precoUnitario,
          qty,
          obs,
        }));
        patch.subtotal = subtotalFinal;
      }
    }

    let freteFinal = Number(pedido.frete) || 0;
    let bairroFinal = pedido.bairro;
    if (input.bairro) {
      const bairroEncontrado = buscarPorNome(menuData.bairros, 'nome', input.bairro);
      if (!bairroEncontrado) {
        const listaBairros = menuData.bairros.map((b) => b.nome).join(', ');
        erros.push(`O bairro "${input.bairro}" não está na nossa área de entrega. Bairros atendidos: ${listaBairros}.`);
      } else {
        freteFinal = Number(bairroEncontrado.frete) || 0;
        bairroFinal = bairroEncontrado.nome;
        patch.bairro = bairroFinal;
        patch.frete = freteFinal;
      }
    }

    if (input.endereco !== undefined) {
      if (!input.endereco.trim()) erros.push('O novo endereço não pode ficar vazio.');
      else patch.endereco = input.endereco.trim();
    }
    if (input.complemento !== undefined) patch.complemento = input.complemento.trim() || null;

    let pagamentoTextoFinal = pedido.pagamento;
    if (input.forma_pagamento) {
      pagamentoTextoFinal = PAGAMENTO_TEXTO[input.forma_pagamento];
      if (!pagamentoTextoFinal) erros.push(`Forma de pagamento inválida: "${input.forma_pagamento}". Use presencial, pix ou cartao_link.`);
      else patch.pagamento = pagamentoTextoFinal;
    }

    if (input.observacao_geral !== undefined) patch.observacao = input.observacao_geral || null;

    if (erros.length) {
      return { erro: erros.join(' ') };
    }

    // Desconto/cupom (se houver) não são recalculados aqui — fora do escopo
    // desta ferramenta; um cupom percentual aplicado antes da edição
    // continua valendo pelo valor absoluto original.
    const desconto = Number(pedido.desconto) || 0;
    const totalFinal = +(subtotalFinal - desconto + freteFinal).toFixed(2);
    patch.total = totalFinal;

    let linhasAfetadas;
    try {
      linhasAfetadas = await atualizarComoAdminSeStatus('pedidos', pedido.id, 'aguardando', patch);
    } catch (err) {
      console.error(`[edicao] pedido=${pedido.id} numero=${numero} falha ao escrever edição:`, err);
      return { erro: 'Não consegui salvar a edição agora por um problema técnico. Tente de novo em instantes.' };
    }

    if (!linhasAfetadas.length) {
      // Corrida: entre a leitura acima e este UPDATE, o status mudou (a
      // cozinha aceitou o pedido nesse intervalo). Não aplica a edição.
      console.log(`[edicao] pedido=${pedido.id} numero=${numero} resultado=recusado_corrida_na_escrita`);
      return { erro: true, mensagem_para_cliente: await mensagemRecusaAcaoPedido('editar') };
    }

    console.log(`[edicao] pedido=${pedido.id} numero=${numero} resultado=editado campos=${Object.keys(patch).join(',')}`);
    return {
      sucesso: true,
      pedido_id: pedido.id,
      itens: itensTextoFinal.split(' | '),
      subtotal: subtotalFinal,
      frete: freteFinal,
      total: totalFinal,
      bairro: bairroFinal,
      forma_pagamento: pagamentoTextoFinal,
    };
  };
}
