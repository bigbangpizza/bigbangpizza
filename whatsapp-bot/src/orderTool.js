import { config } from './config.js';
import { getMenuData, inserirPedido, validarCupom } from './supabaseData.js';
import { enviarTexto } from './evolutionApi.js';

/**
 * Definição da tool `criar_pedido` no formato esperado pela Anthropic
 * Messages API (tool use / function calling). A Claude só deve chamar isso
 * depois de já ter reunido itens, endereço, bairro e forma de pagamento
 * confirmados pelo cliente — ver instruções completas no system prompt.
 */
export const CRIAR_PEDIDO_TOOL = {
  name: 'criar_pedido',
  description:
    'Registra o pedido do cliente no sistema depois que TODAS as informações necessárias já foram ' +
    'confirmadas na conversa: itens (com tamanho/sabores quando aplicável), endereço completo, bairro ' +
    'e forma de pagamento. Só chame esta função depois que o cliente confirmar explicitamente que quer ' +
    'fechar o pedido com esses dados — nunca antes disso. Os preços não precisam ser calculados por ' +
    'você: o sistema recalcula os valores oficiais a partir do cardápio real e retorna o resultado. Se ' +
    'a resposta desta função vier com "erro", NÃO tente de novo sozinho — explique o problema ao ' +
    'cliente com as próprias palavras do erro e aguarde ele corrigir.',
  input_schema: {
    type: 'object',
    properties: {
      endereco: { type: 'string', description: 'Rua e número informados pelo cliente.' },
      complemento: { type: 'string', description: 'Complemento do endereço (apto, ponto de referência), se houver.' },
      bairro: {
        type: 'string',
        description: 'Nome do bairro exatamente como o cliente disse — o sistema valida contra a lista real de bairros atendidos.',
      },
      forma_pagamento: {
        type: 'string',
        enum: ['presencial', 'pix', 'cartao_link'],
        description:
          '"presencial" = dinheiro/cartão na entrega; "pix" = pagamento via Pix; "cartao_link" = link de pagamento (Ton) enviado depois.',
      },
      observacao_geral: { type: 'string', description: 'Alguma observação geral do pedido (ex: sem cebola, campainha quebrada).' },
      cupom: {
        type: 'string',
        description:
          'Código do cupom de desconto, apenas se o cliente mencionar um explicitamente (ex: "BIGBANG10"). O sistema ' +
          'valida se existe, está ativo e ainda tem uso disponível. Se for inválido, o pedido é registrado normalmente ' +
          'sem desconto e a resposta vem com um aviso pra você repassar ao cliente — nunca deixe de fechar o pedido ' +
          'por causa de um cupom inválido. Omita este campo se o cliente não mencionar nenhum cupom.',
      },
      itens: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            tipo: {
              type: 'string',
              enum: ['pizza_salgada', 'pizza_doce', 'combo', 'bebida'],
            },
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
    },
    required: ['endereco', 'bairro', 'forma_pagamento', 'itens'],
  },
};

function normalizar(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos (marcas diacríticas combinantes)
    .toLowerCase()
    .trim();
}

/** Busca por nome com tolerância a acentuação/maiúsculas e correspondência parcial. */
export function buscarPorNome(lista, campoNome, nomeBusca) {
  const alvo = normalizar(nomeBusca);
  if (!alvo) return null;

  const exatos = lista.filter((item) => normalizar(item[campoNome]) === alvo);
  if (exatos.length === 1) return exatos[0];
  if (exatos.length > 1) return null; // ambíguo — não deveria ocorrer com o cardápio real

  const parciais = lista.filter((item) => {
    const nome = normalizar(item[campoNome]);
    return nome.includes(alvo) || alvo.includes(nome);
  });
  return parciais.length === 1 ? parciais[0] : null;
}

function catalogoPorTipo(menuData, tipo) {
  return { pizza_salgada: menuData.salgadas, pizza_doce: menuData.doces, combo: menuData.combos, bebida: menuData.bebidas }[tipo];
}

export function brl(v) {
  return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
}

export const PAGAMENTO_TEXTO = {
  presencial: 'Presencial (dinheiro/cartão na entrega)',
  pix: 'Pix (aguardando pagamento)',
  cartao_link: 'Cartão via link Ton (aguardando envio do link)',
};

/**
 * Processa e valida a lista de itens do pedido contra o cardápio real,
 * recalculando os preços a partir dos dados do Supabase (nunca confia em
 * preço que a IA eventualmente tenha citado na conversa). Pizza salgada
 * meio a meio usa a mesma regra do site: preço = soma das metades de cada
 * sabor no tamanho escolhido. Exportada porque editOrderTool.js reaproveita
 * a mesma validação/precificação ao editar os itens de um pedido existente.
 * @returns {{itensProcessados: Array, erros: string[]}}
 */
export function processarItens(itensInput, menuData) {
  const erros = [];
  const itensProcessados = [];

  for (const itemInput of itensInput || []) {
    const catalogo = catalogoPorTipo(menuData, itemInput.tipo);
    if (!catalogo) {
      erros.push(`Tipo de item desconhecido: "${itemInput.tipo}".`);
      continue;
    }

    const encontrado1 = buscarPorNome(catalogo, 'nome', itemInput.sabor1);
    if (!encontrado1) {
      erros.push(`Não encontrei "${itemInput.sabor1}" no cardápio.`);
      continue;
    }

    let precoUnitario;
    let nomeExibicao;
    let sabores;
    let tamanho = null;
    let tabela = null;
    let tipoItem = 'simples';

    if (itemInput.tipo === 'pizza_salgada') {
      tipoItem = 'pizza';
      tabela = 'pizzas_salgadas';
      tamanho = itemInput.tamanho;
      if (!['Grande', 'Família'].includes(tamanho)) {
        erros.push(`Tamanho inválido ou ausente para "${encontrado1.nome}" — precisa ser "Grande" ou "Família".`);
        continue;
      }
      const campoPreco = tamanho === 'Grande' ? 'preco_grande' : 'preco_familia';
      if (encontrado1[campoPreco] == null) {
        erros.push(`"${encontrado1.nome}" não está disponível no tamanho ${tamanho}.`);
        continue;
      }

      if (itemInput.sabor2) {
        const encontrado2 = buscarPorNome(catalogo, 'nome', itemInput.sabor2);
        if (!encontrado2) {
          erros.push(`Não encontrei "${itemInput.sabor2}" no cardápio de pizzas salgadas.`);
          continue;
        }
        if (encontrado2[campoPreco] == null) {
          erros.push(`"${encontrado2.nome}" não está disponível no tamanho ${tamanho}.`);
          continue;
        }
        if (encontrado1.id === encontrado2.id) {
          erros.push(`Os dois sabores escolhidos são iguais ("${encontrado1.nome}") — meio a meio precisa de 2 sabores diferentes.`);
          continue;
        }
        sabores = [
          { id: encontrado1.id, nome: encontrado1.nome, preco: encontrado1[campoPreco] },
          { id: encontrado2.id, nome: encontrado2.nome, preco: encontrado2[campoPreco] },
        ];
        precoUnitario = +(sabores[0].preco / 2 + sabores[1].preco / 2).toFixed(2);
        nomeExibicao = `Pizza ${tamanho} — ½ ${encontrado1.nome} + ½ ${encontrado2.nome}`;
      } else {
        sabores = [{ id: encontrado1.id, nome: encontrado1.nome, preco: encontrado1[campoPreco] }];
        precoUnitario = encontrado1[campoPreco];
        nomeExibicao = `Pizza ${tamanho} — ${encontrado1.nome}`;
      }
    } else {
      const prefixo = itemInput.tipo === 'pizza_doce' ? 'Doce ' : '';
      sabores = [{ nome: encontrado1.nome, preco: encontrado1.preco }];
      precoUnitario = encontrado1.preco;
      nomeExibicao = `${prefixo}${encontrado1.nome}`;
    }

    const qty = Math.max(1, Math.trunc(Number(itemInput.quantidade) || 1));
    itensProcessados.push({
      tipo: tipoItem,
      tabela,
      tamanho,
      sabores,
      precoUnitario,
      qty,
      obs: itemInput.obs || null,
      nomeExibicao,
    });
  }

  if (!itensInput || !itensInput.length) erros.push('Nenhum item foi informado no pedido.');

  return { itensProcessados, erros };
}

async function notificarGabriel({ pedidoId, nomeCliente, telefone, itensTexto, total, alertaWhatsappNumero }) {
  if (!alertaWhatsappNumero) {
    console.warn(
      `[orderTool] Nenhum número de alerta configurado (admin ou GABRIEL_WHATSAPP_NUMBER) — não foi possível avisar sobre o pedido #${pedidoId} (aguardando link Ton).`
    );
    return;
  }
  const msg =
    `💳 Novo pedido aguardando link de pagamento Ton\n\n` +
    `Pedido #${pedidoId ?? '?'}\n` +
    `Cliente: ${nomeCliente}\n` +
    `Telefone: ${telefone}\n` +
    `Itens: ${itensTexto}\n` +
    `Valor total: ${brl(total)}\n\n` +
    `Gera o link no app da Ton e envia pro cliente 🙏`;
  await enviarTexto(alertaWhatsappNumero, msg);
}

/**
 * Cria o executor da tool `criar_pedido` já "amarrado" ao contato do
 * WhatsApp que está conversando — o número/telefone do cliente vem sempre
 * do contexto real do webhook (nunca do que a IA disser), por segurança.
 */
export function criarExecutorCriarPedido({ numero, nomeContato }) {
  return async function executarCriarPedido(input) {
    const menuData = await getMenuData();

    const { itensProcessados, erros } = processarItens(input.itens, menuData);

    const bairroEncontrado = buscarPorNome(menuData.bairros, 'nome', input.bairro);
    if (!bairroEncontrado) {
      const listaBairros = menuData.bairros.map((b) => b.nome).join(', ');
      erros.push(`O bairro "${input.bairro}" não está na nossa área de entrega. Bairros atendidos: ${listaBairros}.`);
    }

    if (!input.endereco || !input.endereco.trim()) {
      erros.push('O endereço (rua e número) não foi informado.');
    }

    const pagamentoTexto = PAGAMENTO_TEXTO[input.forma_pagamento];
    if (!pagamentoTexto) {
      erros.push(`Forma de pagamento inválida: "${input.forma_pagamento}". Use presencial, pix ou cartao_link.`);
    }

    if (erros.length) {
      return { erro: erros.join(' ') };
    }

    const subtotal = +itensProcessados.reduce((s, i) => s + i.precoUnitario * i.qty, 0).toFixed(2);
    const frete = Number(bairroEncontrado.frete) || 0;
    const itensTexto = itensProcessados.map((i) => `${i.qty}x ${i.nomeExibicao}`).join(' | ');

    // Cupom é opcional e nunca trava o fechamento do pedido: se o código
    // vier inválido/expirado/esgotado, o pedido segue sem desconto e o
    // motivo vai em "aviso_cupom" pra Claude repassar ao cliente com
    // simpatia (ver instrução da tool acima e o system prompt).
    let cupomAplicado = null;
    let avisoCupom = null;
    if (input.cupom) {
      const resultado = await validarCupom(input.cupom);
      if (resultado.valido) {
        cupomAplicado = resultado;
      } else {
        avisoCupom = resultado.motivo;
      }
    }
    const desconto = cupomAplicado
      ? cupomAplicado.tipo === 'fixo'
        ? Math.min(cupomAplicado.desconto, subtotal)
        : +(subtotal * (cupomAplicado.desconto / 100)).toFixed(2)
      : 0;
    const total = +(subtotal - desconto + frete).toFixed(2);

    const pedido = {
      nome: nomeContato || 'Cliente WhatsApp',
      endereco: input.endereco.trim(),
      bairro: bairroEncontrado.nome,
      complemento: input.complemento || null,
      pagamento: pagamentoTexto,
      whatsapp: numero,
      observacao: input.observacao_geral || null,
      status: 'aguardando',
      cupom: cupomAplicado ? cupomAplicado.codigo : null,
      itens: itensTexto,
      itens_json: itensProcessados.map(({ tipo, tamanho, sabores, precoUnitario, qty, obs }) => ({
        tipo,
        tamanho,
        sabores,
        precoUnitario,
        qty,
        obs,
      })),
      subtotal,
      desconto,
      frete,
      total,
    };

    let pedidoId;
    let rastreioToken;
    try {
      ({ id: pedidoId, rastreioToken } = await inserirPedido(pedido));
    } catch (err) {
      console.error('[orderTool] falha ao inserir pedido:', err);
      return { erro: 'Não consegui registrar o pedido agora por um problema técnico. Peça pro cliente tentar de novo em instantes.' };
    }

    if (input.forma_pagamento === 'cartao_link') {
      // Número configurável na aba "Configurações do Bot" do admin.html
      // (tabela `configuracoes`, já cacheada em menuData), com fallback pro
      // GABRIEL_WHATSAPP_NUMBER enquanto o campo não é preenchido por lá.
      const alertaWhatsappNumero = menuData.configuracoes.alerta_whatsapp_numero || config.gabrielWhatsappNumber;
      notificarGabriel({ pedidoId, nomeCliente: pedido.nome, telefone: numero, itensTexto, total, alertaWhatsappNumero }).catch((err) => {
        console.error('[orderTool] falha ao notificar Gabriel sobre pedido aguardando link Ton:', err);
      });
    }

    return {
      sucesso: true,
      pedido_id: pedidoId,
      link_rastreio: rastreioToken ? `https://bigbangpizza.com.br/rastreio.html?token=${rastreioToken}` : null,
      itens: itensProcessados.map((i) => `${i.qty}x ${i.nomeExibicao}`),
      subtotal,
      cupom_aplicado: cupomAplicado ? { codigo: cupomAplicado.codigo, desconto } : null,
      aviso_cupom: avisoCupom,
      frete,
      total,
      bairro: bairroEncontrado.nome,
      forma_pagamento: pagamentoTexto,
      tempo_estimado: '35 a 60 minutos',
    };
  };
}
