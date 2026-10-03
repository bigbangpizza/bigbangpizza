import { config } from './config.js';
import { getMenuData, inserirPedido, calcularCheckout } from './supabaseData.js';
import { resolverBairro, mensagemBairroNaoReconhecido } from './bairroMatch.js';
import { montarResumoPedido, textoWhatsApp } from './resumoPedido.js';
import { enviarTexto } from './evolutionApi.js';
import { temServiceRoleConfigurada } from './supabaseAdmin.js';
import { buscarPedidoAbertoRecente } from './pedidoStatusUtil.js';

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
    'confirmadas na conversa: itens (com tamanho/sabores quando aplicável), endereço completo + bairro ' +
    '(ou "retirada" se o cliente pediu pra retirar no local) e forma de pagamento. Só chame esta função ' +
    'depois que o cliente confirmar explicitamente que quer fechar o pedido com esses dados — nunca ' +
    'antes disso. Os preços não precisam ser calculados por você: o sistema recalcula os valores ' +
    'oficiais a partir do cardápio real e retorna o resultado. Se a resposta desta função vier com ' +
    '"erro", NÃO tente de novo sozinho — explique o problema ao cliente com as próprias palavras do ' +
    'erro e aguarde ele corrigir. Se vier "duplicata: true" com "mensagem_para_cliente", o sistema já ' +
    'detectou um pedido muito parecido feito há poucos minutos (proteção contra duplicidade) — repasse ' +
    'essa mensagem ao cliente literalmente, sem reformular, e não chame a ferramenta de novo.',
  input_schema: {
    type: 'object',
    properties: {
      retirada: {
        type: 'boolean',
        description:
          'true SOMENTE se o cliente pediu explicitamente pra retirar o pedido no local, em vez de receber em casa. ' +
          'Nunca ofereça ou sugira essa opção por conta própria — o padrão é sempre entrega; só marque true se o ' +
          'próprio cliente pedir retirada. Quando true, "endereco" e "bairro" ficam dispensados.',
      },
      endereco: { type: 'string', description: 'Rua e número informados pelo cliente. Dispensado se "retirada" for true.' },
      complemento: { type: 'string', description: 'Complemento do endereço (apto, ponto de referência), se houver.' },
      bairro: {
        type: 'string',
        description:
          'Nome do bairro exatamente como o cliente disse — o sistema reconhece apelidos e pequenos erros de digitação e valida contra a lista real de bairros atendidos. Dispensado se "retirada" for true.',
      },
      cep: {
        type: 'string',
        description: 'CEP do endereço, se o cliente informou (só números ou com hífen). Usado pra identificar o bairro quando o nome não foi reconhecido.',
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
          'Código do cupom de desconto, apenas se o cliente mencionar um explicitamente (ex: "BIGBANG15"). O sistema ' +
          'valida se existe, está ativo e ainda tem uso disponível. Se for inválido, o pedido é registrado normalmente ' +
          'sem desconto e a resposta vem com um aviso pra você repassar ao cliente — nunca deixe de fechar o pedido ' +
          'por causa de um cupom inválido. Omita este campo se o cliente não mencionar nenhum cupom.',
      },
      cliente_escolheu_cupom_mais_caro: {
        type: 'boolean',
        description:
          'Só quando calcular_total devolveu "comparacao" com a oferta da pizza doce mais barata: true se você mostrou ' +
          'os dois totais ao cliente e ele, mesmo assim, escolheu usar o cupom. Omita nos outros casos.',
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
            borda: {
              type: 'string',
              enum: ['catupiry', 'cheddar', 'chocolate'],
              description:
                'Borda recheada, só se o cliente pedir. "catupiry" e "cheddar" valem só para tipo "pizza_salgada"; ' +
                '"chocolate" só para tipo "pizza_doce". Omita se o cliente não quiser borda ou se o item não for pizza.',
            },
            quantidade: { type: 'integer', minimum: 1 },
            obs: { type: 'string', description: 'Observação específica deste item (ex: massa fina, bem assada).' },
          },
          required: ['tipo', 'sabor1', 'quantidade'],
        },
      },
    },
    required: ['forma_pagamento', 'itens'],
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

// Endereço físico da loja — usado só quando o cliente pede retirada no
// local (campo "retirada" da tool). Mesmo endereço já publicado no
// schema.org do site (index.html) — atualize os dois juntos se a loja mudar.
export const ENDERECO_LOJA = 'Rua Nilton Calmon, 96 - Centro, Lauro de Freitas - BA';

export const PAGAMENTO_TEXTO = {
  presencial: 'Presencial (dinheiro/cartão na entrega)',
  pix: 'Pix (aguardando pagamento)',
  cartao_link: 'Cartão via link Ton (aguardando envio do link)',
};

// Mesmas opções de borda do checkout do site (index.html) — catupiry/cheddar
// só pra pizza_salgada, chocolate só pra pizza_doce.
const OPCOES_BORDA = {
  pizza_salgada: { catupiry: 'Catupiry', cheddar: 'Cheddar' },
  pizza_doce: { chocolate: 'Chocolate' },
};

/**
 * Preço da borda recheada, configurável no admin (Configurações do Bot >
 * Borda recheada, tabela `configuracoes`, chaves borda_preco_salgada/
 * borda_preco_doce — mesmas chaves que o site usa). Cai pro padrão de
 * R$12 se ainda não foi configurado, igual ao fallback do site.
 */
function precoBorda(menuData, tipoItem) {
  const chave = tipoItem === 'pizza_doce' ? 'borda_preco_doce' : 'borda_preco_salgada';
  const valor = parseFloat(menuData.configuracoes[chave]);
  return Number.isFinite(valor) ? valor : 12;
}

/**
 * Processa e valida a lista de itens do pedido contra o cardápio real,
 * recalculando os preços a partir dos dados do Supabase (nunca confia em
 * preço que a IA eventualmente tenha citado na conversa). Pizza salgada
 * meio a meio usa a mesma regra do site: preço = o do sabor mais caro dos
 * dois no tamanho escolhido. Exportada porque editOrderTool.js reaproveita
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
        precoUnitario = Math.max(sabores[0].preco, sabores[1].preco);
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

    let borda = null;
    if (itemInput.borda) {
      const nomeBorda = OPCOES_BORDA[itemInput.tipo]?.[itemInput.borda];
      if (!nomeBorda) {
        const tipoLabel = itemInput.tipo === 'pizza_salgada' ? 'pizza salgada' : itemInput.tipo === 'pizza_doce' ? 'pizza doce' : 'esse tipo de item';
        erros.push(`Borda "${itemInput.borda}" não está disponível para ${tipoLabel}.`);
        continue;
      }
      const precoDaBorda = precoBorda(menuData, itemInput.tipo);
      borda = { id: itemInput.borda, nome: nomeBorda, preco: precoDaBorda };
      precoUnitario = +(precoUnitario + precoDaBorda).toFixed(2);
      nomeExibicao += ` — Borda ${nomeBorda}`;
    }

    const qty = Math.max(1, Math.trunc(Number(itemInput.quantidade) || 1));
    itensProcessados.push({
      tipo: tipoItem,
      tabela,
      tamanho,
      sabores,
      borda,
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

    // Retirada no local: dispensa bairro/endereço (não há entrega). Ver
    // regra no system prompt — a IA só deve marcar isso se o cliente pedir
    // explicitamente, nunca por sugestão própria.
    let bairroEncontrado;
    if (input.retirada) {
      bairroEncontrado = { nome: 'Retirada no local', frete: 0 };
    } else {
      const { bairro, cepInfo } = await resolverBairro(menuData.bairros, input.bairro, input.cep);
      bairroEncontrado = bairro;
      if (!bairroEncontrado) {
        erros.push(mensagemBairroNaoReconhecido(menuData.bairros, input.bairro, input.cep, cepInfo));
      }
      if (!input.endereco || !input.endereco.trim()) {
        erros.push('O endereço (rua e número) não foi informado.');
      }
    }

    const pagamentoTexto = PAGAMENTO_TEXTO[input.forma_pagamento];
    if (!pagamentoTexto) {
      erros.push(`Forma de pagamento inválida: "${input.forma_pagamento}". Use presencial, pix ou cartao_link.`);
    }

    if (erros.length) {
      return { erro: erros.join(' ') };
    }

    const subtotal = +itensProcessados.reduce((s, i) => s + i.precoUnitario * i.qty, 0).toFixed(2);
    const itensTexto = itensProcessados.map((i) => `${i.qty}x ${i.nomeExibicao}`).join(' | ');
    const itensJson = itensProcessados.map(({ tipo, tamanho, sabores, borda, precoUnitario, qty, obs }) => ({
      tipo,
      tamanho,
      sabores,
      borda,
      precoUnitario,
      qty,
      obs,
    }));

    // Rede de segurança contra pedido duplicado (ver PEDIDO_DUPLICADO_* em
    // config.js e o aviso de contexto que buildSystemPrompt já injeta antes
    // disso). Cenário que motivou essa checagem: cliente fecha o pedido
    // pelo site e, em seguida, envia a mensagem pré-preenchida do WhatsApp
    // (botão "Enviar pelo WhatsApp") — o bot recebia isso como um pedido
    // novo e criava uma segunda linha idêntica. Comparação exata (mesmos
    // itens + mesmo bairro/retirada) numa janela curta, não uma regra vaga
    // — pedidos parecidos mas legitimamente diferentes (bairro ou itens
    // diferentes) não são bloqueados aqui.
    if (temServiceRoleConfigurada()) {
      try {
        const pedidoRecente = await buscarPedidoAbertoRecente(numero, config.pedidoDuplicadoBloqueioMinutos, 'itens,bairro');
        const destinoBate = pedidoRecente
          ? input.retirada
            ? pedidoRecente.bairro === 'Retirada no local'
            : pedidoRecente.bairro === bairroEncontrado.nome
          : false;
        if (pedidoRecente && destinoBate && pedidoRecente.itens === itensTexto) {
          console.warn(
            `[orderTool] possível pedido duplicado bloqueado: numero=${numero} pedido_existente=${pedidoRecente.id} itens="${itensTexto}"`
          );
          return {
            erro: true,
            duplicata: true,
            pedido_existente_id: pedidoRecente.id,
            mensagem_para_cliente:
              `Já tenho um pedido seu bem parecido com esse, registrado há poucos minutos (pedido #${pedidoRecente.id}). ` +
              'Pra não duplicar, não criei um novo agora — se for realmente um pedido diferente, me conta o que muda que eu ajusto! 🍕',
          };
        }
      } catch (err) {
        console.error('[orderTool] falha ao checar pedido duplicado (seguindo sem bloquear):', err);
      }
    }

    // Frete, cupom e total vêm do cálculo oficial no Supabase (mesmas regras
    // do site e do gatilho do servidor). Cupom é opcional e nunca trava o
    // fechamento do pedido: se não valer, o pedido segue sem desconto e o
    // motivo vai em "aviso_cupom" pra Claude repassar ao cliente.
    let checkout;
    try {
      checkout = await calcularCheckout({ itensJson, bairro: bairroEncontrado.nome, cupom: input.cupom, whatsapp: numero, retirada: input.retirada });
    } catch (err) {
      console.error('[orderTool] falha ao calcular checkout:', err);
      return { erro: 'Não consegui calcular o total agora por um problema técnico. Peça pro cliente tentar de novo em instantes.' };
    }
    // Cupom e oferta da pizza doce não acumulam. Se a oferta sai mais barata, o
    // pedido só é registrado com o cupom se o cliente viu os dois totais e
    // escolheu o cupom mesmo assim — nunca a opção mais cara sem ele saber.
    const cmp = checkout.comparacao;
    if (cmp && cmp.mais_barato === 'oferta' && !input.cliente_escolheu_cupom_mais_caro) {
      return {
        erro:
          `Não registrei ainda: com o cupom o total fica ${brl(cmp.total_com_cupom)}, e com a pizza doce em oferta (sem cupom) ` +
          `fica ${brl(cmp.total_com_oferta)} — ${brl(cmp.diferenca)} mais barato. Mostre os dois totais ao cliente e recomende a oferta. ` +
          'Se ele escolher a oferta, chame criar_pedido de novo SEM o campo cupom. Se ele preferir o cupom mesmo assim, ' +
          'chame com cliente_escolheu_cupom_mais_caro: true.',
      };
    }
    const cupomAplicado = checkout.cupom?.valido ? { codigo: checkout.cupom.codigo } : null;
    const avisoCupom = checkout.cupom && !checkout.cupom.valido ? checkout.cupom.motivo : null;
    const desconto = Number(checkout.desconto) || 0;
    const frete = Number(checkout.frete) || 0;
    const total = Number(checkout.total);

    const pedido = {
      nome: nomeContato || 'Cliente WhatsApp',
      endereco: input.retirada ? ENDERECO_LOJA : input.endereco.trim(),
      bairro: bairroEncontrado.nome,
      complemento: input.complemento || null,
      pagamento: pagamentoTexto,
      whatsapp: numero,
      observacao: input.observacao_geral || null,
      status: 'aguardando',
      cupom: cupomAplicado ? cupomAplicado.codigo : null,
      itens: itensTexto,
      itens_json: checkout.itens, // normalizados pelo servidor (oferta da pizza doce marcada)
      subtotal: Number(checkout.subtotal),
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

    const linkRastreio = rastreioToken ? `https://bigbangpizza.com.br/rastreio.html?token=${rastreioToken}` : null;
    // A confirmação que vai pro cliente é montada pelo código (server.js), com
    // o valor de cada item — mesmo formato do admin e do rastreio.
    ultimaConfirmacaoPorNumero.set(numero, {
      tipo: 'criado',
      pedido: { ...pedido, id: pedidoId },
      linkRastreio,
      avisoCupom,
      formaPagamento: input.forma_pagamento,
      retirada: Boolean(input.retirada),
    });

    return {
      sucesso: true,
      pedido_id: pedidoId,
      link_rastreio: linkRastreio,
      itens: itensProcessados.map((i) => `${i.qty}x ${i.nomeExibicao}`),
      subtotal: Number(checkout.subtotal),
      oferta_pizza_doce: checkout.oferta_doce?.aplicada ? { preco: checkout.oferta_doce.preco, economia: checkout.oferta_doce.economia } : null,
      cupom_aplicado: cupomAplicado ? { codigo: cupomAplicado.codigo, desconto } : null,
      aviso_cupom: avisoCupom,
      frete,
      total,
      falta_para_frete_gratis: checkout.falta_para_frete_gratis || null,
      bairro: bairroEncontrado.nome,
      endereco: pedido.endereco,
      forma_pagamento: pagamentoTexto,
      tempo_estimado: '35 a 60 minutos',
    };
  };
}

/**
 * Tool `calcular_total` — a Luiza chama antes de mandar o resumo de
 * confirmação, pra usar os valores oficiais (frete grátis, frete da zona,
 * cupom) em vez de somar de cabeça. Só consulta; não grava nada.
 *
 * A linha "Faltam R$ X para frete grátis" NÃO é escrita pelo modelo: o
 * resultado fica guardado em `ultimoResumoPorNumero` e o servidor
 * (server.js) acrescenta a linha no resumo que vai pro cliente.
 */
export const CALCULAR_TOTAL_TOOL = {
  name: 'calcular_total',
  description:
    'Calcula o total oficial do pedido (subtotal, frete, desconto de cupom e total) antes do resumo de confirmação. ' +
    'Chame SEMPRE antes de mandar o resumo "Posso confirmar?", com os mesmos itens/bairro/cupom que vai usar no criar_pedido, ' +
    'e use exatamente os valores retornados no resumo.',
  input_schema: {
    type: 'object',
    properties: {
      itens: CRIAR_PEDIDO_TOOL.input_schema.properties.itens,
      bairro: { type: 'string', description: 'Bairro de entrega (dispensado se retirada for true).' },
      cupom: { type: 'string', description: 'Código do cupom, se o cliente mencionou um.' },
      retirada: { type: 'boolean', description: 'true se o cliente vai retirar no local.' },
    },
    required: ['itens'],
  },
};

// numero -> { linhaFreteGratis } do último calcular_total desta mensagem do cliente.
export const ultimoResumoPorNumero = new Map();

// numero -> pedido criado/editado nesta mensagem do cliente; o server.js usa
// pra mandar a confirmação com o valor de cada item (montada pelo código).
export const ultimaConfirmacaoPorNumero = new Map();

/**
 * Confirmação do pedido pro WhatsApp — itens com valor, adicionais, descontos,
 * subtotal, frete e total (resumoPedido.js, mesmo formato do admin e do
 * rastreio), mais pagamento, prazo e link. Cada bloco separado por linha em
 * branco vira uma mensagem.
 */
export function montarConfirmacaoPedido(conf, { nomesDoces, lojaAberta }) {
  const p = conf.pedido;
  const resumo = montarResumoPedido(p, nomesDoces);
  const blocos = [`${conf.tipo === 'editado' ? 'Pedido' : 'Pedido'} #${p.id ?? ''} ${conf.tipo === 'editado' ? 'atualizado' : 'registrado'}.\n${textoWhatsApp(resumo)}`.replace('# ', '')];
  if (conf.avisoCupom) blocos.push(`${conf.avisoCupom.startsWith('O cupom') ? '' : 'O cupom não foi aplicado: '}${conf.avisoCupom}`);
  if (conf.tipo === 'criado') {
    if (conf.formaPagamento === 'pix') blocos.push('Pagamento via Pix: pode enviar o comprovante por aqui.');
    else if (conf.formaPagamento === 'cartao_link') blocos.push('O link de pagamento do cartão chega em instantes.');
    else blocos.push('Pagamento na entrega.');
    if (conf.retirada) blocos.push(`Retirada na loja: ${p.endereco}.`);
    blocos.push(
      lojaAberta
        ? `Tempo estimado: 35 a 60 minutos.${conf.linkRastreio ? `\nAcompanhe por aqui: ${conf.linkRastreio}` : ''}`
        : `A loja está fechada agora; o pedido entra em preparo assim que abrirmos.${conf.linkRastreio ? `\nAcompanhe por aqui: ${conf.linkRastreio}` : ''}`
    );
  }
  return blocos.join('\n\n');
}

export function criarExecutorCalcularTotal({ numero }) {
  return async function executarCalcularTotal(input) {
    const menuData = await getMenuData();
    const { itensProcessados, erros } = processarItens(input.itens, menuData);
    let bairroNome = 'Retirada no local';
    if (!input.retirada) {
      const { bairro } = await resolverBairro(menuData.bairros, input.bairro);
      if (!bairro) erros.push(`Bairro "${input.bairro || ''}" não reconhecido — use verificar_bairro antes.`);
      else bairroNome = bairro.nome;
    }
    if (erros.length) return { erro: erros.join(' ') };

    const itensJson = itensProcessados.map(({ tipo, tamanho, sabores, borda, precoUnitario, qty, obs }) => ({ tipo, tamanho, sabores, borda, precoUnitario, qty, obs }));
    const c = await calcularCheckout({ itensJson, bairro: bairroNome, cupom: input.cupom, whatsapp: numero, retirada: input.retirada });
    const falta = Number(c.falta_para_frete_gratis) || 0;
    ultimoResumoPorNumero.set(numero, { linhaFreteGratis: falta > 0 ? `Faltam ${brl(falta)} para frete grátis.` : null });
    return {
      itens: linhasDosItens(c.itens),
      subtotal: c.subtotal,
      oferta_pizza_doce: c.oferta_doce?.aplicada
        ? { aplicada: true, preco: c.oferta_doce.preco, economia: c.oferta_doce.economia }
        : { aplicada: false, motivo: c.oferta_doce?.motivo || null },
      frete: c.frete,
      frete_gratis: c.frete === 0 && !input.retirada,
      desconto: c.desconto,
      cupom: c.cupom ? { codigo: c.cupom.codigo, valido: c.cupom.valido, motivo: c.cupom.motivo } : null,
      total: c.total,
      // Cupom x oferta da doce (não acumulam): total de cada opção e qual sai mais barata.
      comparacao_cupom_x_oferta_doce: c.comparacao
        ? {
            total_com_cupom: c.comparacao.total_com_cupom,
            total_com_oferta_doce_sem_cupom: c.comparacao.total_com_oferta,
            mais_barato: c.comparacao.mais_barato,
            diferenca: c.comparacao.diferenca,
          }
        : null,
      observacao: 'Não escreva no resumo a linha de quanto falta para o frete grátis — o sistema acrescenta sozinho.',
    };
  };
}

function linhasDosItens(itensNormalizados) {
  return (itensNormalizados || []).map((i) => {
    const nome = i.sabores?.length === 2 ? `½ ${i.sabores[0].nome} + ½ ${i.sabores[1].nome}` : i.sabores?.[0]?.nome;
    const tam = i.tamanho ? `${i.tamanho} ` : '';
    return `${i.qty}x ${tam}${nome} — ${brl(i.precoUnitario * i.qty)}${i.oferta_doce ? ' (oferta pizza doce)' : ''}`;
  });
}

/**
 * Acrescenta (no texto que vai pro cliente) a linha "Faltam R$ X para frete
 * grátis" calculada por calcular_total, logo antes do "Posso confirmar?".
 * Remove qualquer linha parecida que o modelo tenha escrito por conta própria.
 */
export function aplicarLinhaFreteGratis(numero, texto) {
  const resumo = ultimoResumoPorNumero.get(numero);
  ultimoResumoPorNumero.delete(numero);
  if (!resumo || !/posso confirmar/i.test(texto)) return texto;
  const semLinhaDoModelo = texto
    .split('\n')
    .filter((l) => !/faltam\s+r\$\s*[\d.,]+\s+(em produtos\s+)?para (o )?frete gr[aá]tis/i.test(l))
    .join('\n');
  if (!resumo.linhaFreteGratis) return semLinhaDoModelo;
  return semLinhaDoModelo.replace(/([^\n]*posso confirmar\?)/i, `${resumo.linhaFreteGratis}\n\n$1`);
}
