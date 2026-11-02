import { getMenuData } from './supabaseData.js';
import { extrairComFerramenta } from './claude.js';
import { formatarSalgadas, formatarDoces, formatarCombos, formatarBebidas, formatarBairros } from './systemPrompt.js';

/**
 * Ferramenta usada só para EXTRAÇÃO (nunca grava nada) — o Gabriel cola no
 * admin.html um texto livre (print de conversa do WhatsApp, ou um resumo
 * digitado por ele) de um pedido que atendeu diretamente, fora do bot, e
 * este módulo pede pra Claude estruturar esse texto contra o cardápio real.
 * A tela de confirmação do admin.html é quem valida/corrige e efetivamente
 * grava o pedido — isto aqui nunca decide nada sozinho.
 */
export const EXTRAIR_PEDIDO_MANUAL_TOOL = {
  name: 'extrair_pedido_manual',
  description:
    'Estrutura, a partir de um texto livre (conversa de WhatsApp colada ou resumo digitado), os dados de um pedido ' +
    'de pizza pra revisão humana antes de ser lançado no sistema. NUNCA invente ou deduza um dado que não esteja ' +
    'no texto — quando um campo não estiver claro, deixe-o como string vazia "" (ou array vazio para itens que não ' +
    'conseguir identificar de jeito nenhum). É sempre preferível deixar em branco a chutar, porque uma pessoa vai ' +
    'revisar e corrigir cada campo antes de qualquer coisa ser salva.',
  input_schema: {
    type: 'object',
    properties: {
      nome: { type: 'string', description: 'Nome do cliente, se aparecer no texto. String vazia se não souber.' },
      whatsapp: { type: 'string', description: 'Número de WhatsApp do cliente, se aparecer no texto. String vazia se não souber.' },
      endereco: { type: 'string', description: 'Rua e número. Se o endereço vier em várias mensagens, junte as partes. String vazia se não souber.' },
      complemento: { type: 'string', description: 'Condomínio, bloco/torre, apartamento e ponto de referência, juntando todas as partes que aparecerem no texto.' },
      bairro: {
        type: 'string',
        description: 'Nome do bairro exatamente como está na lista de bairros atendidos abaixo, se conseguir identificar. String vazia se não souber ou não bater com nenhum da lista.',
      },
      forma_pagamento: {
        type: 'string',
        enum: ['presencial', 'pix', 'cartao_link', ''],
        description: '"presencial" = dinheiro ou cartão na maquininha, na entrega; "pix" = Pix; "cartao_link" = link de pagamento (Ton), só se o texto falar em link. Se o texto disser só "cartão", sem dizer se é maquininha ou link, deixe vazio "" (a equipe confirma). String vazia se o texto não deixar claro.',
      },
      observacao_geral: { type: 'string', description: 'Observação geral do pedido (ex: sem cebola, campainha quebrada), se houver.' },
      cupom: { type: 'string', description: 'Código do cupom de desconto, só se o texto citar um (ex: BIGBANG15, VOLTEI10), em maiúsculas e sem espaços. String vazia se não houver. Não coloque o cupom na observação.' },
      itens: {
        type: 'array',
        description: 'Cada item que o texto parece descrever, mesmo que não tenha certeza absoluta — a revisão humana corrige depois.',
        items: {
          type: 'object',
          properties: {
            tipo: { type: 'string', enum: ['pizza_salgada', 'pizza_doce', 'combo', 'bebida', 'pizza_do_dia', ''], description: '"pizza_do_dia" quando o texto citar uma promoção da lista "Pizza do Dia" (ex: Quintabresa, Sexta do Lombinho, Sabadão Cremoso), com o nome da promoção em sabor1.' },
            tamanho: { type: 'string', enum: ['Grande', 'Família', ''], description: 'Só relevante para pizza_salgada.' },
            sabor1: { type: 'string', description: 'Nome do produto/sabor, o mais parecido possível com o nome exato do cardápio abaixo. String vazia se não identificar.' },
            sabor2: { type: 'string', description: 'Segundo sabor, só se for pizza salgada meio a meio. Vazio se for sabor único.' },
            borda: { type: 'string', enum: ['catupiry', 'cheddar', 'chocolate', ''], description: 'Vazio se não tiver borda ou não mencionado.' },
            quantidade: { type: 'integer', minimum: 1, description: 'Padrão 1 se não especificado.' },
            obs: { type: 'string', description: 'Observação específica deste item, se houver.' },
            pizzas_do_combo: {
              type: 'array',
              description: 'Só em combo: uma entrada por pizza salgada do combo, na ordem. sabor1 só nas pizzas à escolha (Dupla Tradicional: Tradicionais, inteiras); vazio se o texto não disser ou se o sabor for fixo. borda: catupiry ou cheddar, se o texto pedir borda nessa pizza.',
              items: { type: 'object', properties: { sabor1: { type: 'string' }, borda: { type: 'string', enum: ['catupiry', 'cheddar', ''] } } },
            },
            doce: { type: 'string', description: 'Só em combo que tem pizza doce: o sabor da doce, se o texto disser. Vazio se não disser.' },
            doce_borda: { type: 'string', enum: ['chocolate', ''], description: 'Só em combo com pizza doce: "chocolate" se o texto pedir borda de chocolate na doce.' },
            bebida: { type: 'string', description: 'Só em combo que tem bebida: a bebida escolhida (nome do cardápio), se o texto disser. Vazio se não disser.' },
          },
          required: ['tipo', 'sabor1', 'quantidade'],
        },
      },
    },
    required: ['nome', 'whatsapp', 'endereco', 'complemento', 'bairro', 'forma_pagamento', 'observacao_geral', 'itens'],
  },
};

const DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function montarSystemPrompt({ salgadas, doces, combos, bebidas, bairros, pizzasDoDia = [] }) {
  return `Você ajuda a estruturar pedidos de pizza a partir de texto livre, para a Big Bang Pizza (pizzaria delivery em Lauro de Freitas, Bahia). O texto vem de um atendente humano (Gabriel) que já atendeu o cliente diretamente pelo WhatsApp, fora do bot automático, e agora está colando a conversa (ou um resumo) para lançar o pedido no sistema.

Sua única tarefa é chamar a ferramenta \`extrair_pedido_manual\` extraindo o que conseguir identificar no texto. Regra mais importante: NUNCA invente, deduza ou complete informação que não está explicitamente no texto — um humano vai revisar e corrigir cada campo antes de qualquer coisa ser salva, então é sempre melhor deixar um campo vazio do que chutar.

## Cardápio real (use estes nomes EXATOS em "sabor1"/"sabor2" quando identificar o item)

### Pizzas Salgadas (todas disponíveis meio a meio)
${formatarSalgadas(salgadas)}

### Pizzas Doces
${formatarDoces(doces)}

### Combos
${formatarCombos(combos)}

### Bebidas
${formatarBebidas(bebidas)}

### Pizza do Dia (promoções; use tipo "pizza_do_dia" e o NOME da promoção em sabor1)
${pizzasDoDia.filter((p) => p.ativo !== false).map((p) => `- ${p.nome}: ${p.tamanho} ${p.sabor} (${DIAS_SEMANA[p.dia_semana]})`).join('\n') || '- (nenhuma)'}

Combos: "Dupla" = Dupla Tradicional (2 Grandes Tradicionais inteiras: sabores em pizzas_do_combo). Nos combos com pizza doce e/ou refrigerante, ponha o sabor da doce em "doce" e a bebida em "bebida" (só se o texto disser). "Coca" sem dizer se é Zero ou Tradicional: deixe "Coca-Cola 1L" (a equipe escolhe).

## Bairros atendidos
${formatarBairros(bairros)}
`;
}

/**
 * @param {string} textoLivre texto colado/digitado pelo Gabriel no admin.html
 * @returns {Promise<object>} o input estruturado (não validado, não salvo) —
 *   ver EXTRAIR_PEDIDO_MANUAL_TOOL.input_schema pro formato exato.
 */
export async function extrairPedidoManual(textoLivre) {
  const menuData = await getMenuData();
  const systemPrompt = montarSystemPrompt(menuData);
  return extrairComFerramenta(systemPrompt, textoLivre, EXTRAIR_PEDIDO_MANUAL_TOOL);
}
