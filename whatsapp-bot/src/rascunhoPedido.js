import { obterValor, salvarValor, apagarValor, TTL_SEGUNDOS } from './historicoRedis.js';
import { CRIAR_PEDIDO_TOOL, buscarPorNome } from './orderTool.js';

// ── Rascunho do pedido em andamento ────────────────────────────────────────
// O histórico da conversa é cortado nas últimas HISTORY_MAX_MESSAGES
// mensagens — num pedido longo (várias pizzas, endereço aos pedaços,
// pagamento), o começo do pedido saía da memória e a Luiza perguntava de
// novo "qual vai ser o pedido?" ou lançava só o último item pedido (ex:
// "manda 2 refri" no fim virava um pedido só com os refrigerantes). O
// rascunho guarda o pedido combinado até agora, por número, no Redis (mesmo
// TTL do histórico), e vai no system prompt de TODA mensagem — nunca sai da
// memória. A Luiza anota cada mudança com a ferramenta `anotar_pedido`
// (itens novos SOMAM, nunca substituem), o `criar_pedido` confere que tem
// tudo o que está no rascunho e, com sucesso, o rascunho é apagado.

const chave = (numero) => `rascunho:${numero}`;
const local = new Map(); // fallback se o Redis falhar: numero -> rascunho

export function rascunhoVazio() {
  return { itens: [] };
}

export async function carregarRascunho(numero) {
  const doRedis = await obterValor(chave(numero));
  if (doRedis && typeof doRedis === 'object') {
    local.set(numero, doRedis);
    return { ...rascunhoVazio(), ...doRedis, itens: Array.isArray(doRedis.itens) ? doRedis.itens : [] };
  }
  if (doRedis === null) local.delete(numero); // Redis respondeu: não existe
  return local.get(numero) || rascunhoVazio();
}

export async function salvarRascunho(numero, rascunho) {
  const r = { ...rascunho, atualizado_em: new Date().toISOString() };
  local.set(numero, r);
  await salvarValor(chave(numero), r, TTL_SEGUNDOS);
  return r;
}

export async function apagarRascunho(numero) {
  local.delete(numero);
  await apagarValor(chave(numero));
}

export function rascunhoTemConteudo(r) {
  if (!r) return false;
  return Boolean(r.itens?.length || r.endereco || r.bairro || r.retirada || r.forma_pagamento || r.pagamento_detalhe || r.observacoes || r.cupom);
}

// ── Ferramenta ──────────────────────────────────────────────────────────────
const ITEM_SCHEMA = CRIAR_PEDIDO_TOOL.input_schema.properties.itens.items;

export const ANOTAR_PEDIDO_TOOL = {
  name: 'anotar_pedido',
  description:
    'Anota no rascunho do pedido em andamento (bloco "Pedido em andamento até agora", no fim) cada coisa que o cliente ' +
    'decidir: item escolhido, endereço, bairro, pagamento, observação. Chame NA MESMA resposta em que o cliente escolhe ' +
    'algo, sempre que algo mudar. "adicionar_itens" SOMA ao rascunho (nunca substitui o que já está lá): mande só o que ' +
    'é NOVO — o que já está no rascunho não deve ser mandado de novo. Para corrigir um item já anotado use "trocar_itens"; ' +
    'para tirar, "remover_itens" (pelo número do item na lista do rascunho). Os campos de dados (endereço, pagamento etc.) ' +
    'substituem o valor anterior. "descartar: true" só quando o cliente desistir do pedido. Não grava pedido nenhum: ' +
    'quem registra é o criar_pedido.',
  input_schema: {
    type: 'object',
    properties: {
      adicionar_itens: { type: 'array', items: ITEM_SCHEMA, description: 'Itens NOVOS combinados agora (somam aos que já estão no rascunho).' },
      trocar_itens: {
        type: 'array',
        description: 'Corrige itens já anotados: número do item na lista do rascunho (1, 2, ...) e o item completo corrigido.',
        items: { type: 'object', properties: { numero: { type: 'integer', minimum: 1 }, item: ITEM_SCHEMA }, required: ['numero', 'item'] },
      },
      remover_itens: {
        type: 'array',
        description: 'Tira itens do rascunho: número do item na lista; "quantidade" para tirar só algumas unidades (sem ela, tira o item inteiro).',
        items: { type: 'object', properties: { numero: { type: 'integer', minimum: 1 }, quantidade: { type: 'integer', minimum: 1 } }, required: ['numero'] },
      },
      retirada: { type: 'boolean', description: 'true se o cliente pediu pra retirar na loja; false se voltou pra entrega.' },
      endereco: { type: 'string', description: 'Rua e número.' },
      complemento: { type: 'string', description: 'Condomínio, bloco, apartamento, referência.' },
      bairro: { type: 'string' },
      cep: { type: 'string' },
      forma_pagamento: { type: 'string', enum: ['presencial', 'pix', 'cartao_link'] },
      pagamento_detalhe: {
        type: 'string',
        description: 'Como o cliente vai pagar, por extenso (ex: "Dinheiro, troco para R$ 100", "Cartão na maquininha", "PAGAMENTO DIVIDIDO: R$ 50,00 em dinheiro + R$ 34,90 no cartão (levar maquininha)").',
      },
      observacoes: { type: 'string', description: 'Observações gerais do pedido (substitui a anterior — mande o texto completo).' },
      cupom: { type: 'string' },
      descartar: { type: 'boolean', description: 'true só se o cliente desistiu do pedido: apaga o rascunho.' },
    },
    required: [],
  },
};

const CAMPOS_DADOS = ['retirada', 'endereco', 'complemento', 'bairro', 'cep', 'forma_pagamento', 'pagamento_detalhe', 'observacoes', 'cupom'];

function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function limparItem(item) {
  const out = {};
  for (const [k, v] of Object.entries(item || {})) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  out.quantidade = Math.max(1, Math.trunc(Number(out.quantidade) || 1));
  return out;
}

// Mesmo item (sabores, tamanho, borda, combo e marcas) — a quantidade não entra.
function chaveItemBruta(item) {
  const { quantidade, ...resto } = limparItem(item);
  const ordenado = Object.keys(resto).sort().reduce((o, k) => ({ ...o, [k]: typeof resto[k] === 'string' ? normalizar(resto[k]) : resto[k] }), {});
  return JSON.stringify(ordenado);
}

/**
 * Aplica a chamada da ferramenta ao rascunho (função pura — não grava).
 * Ordem: trocar → remover → adicionar, com os números da lista ANTES da chamada.
 * @returns {{rascunho: object, erros: string[]}}
 */
export function aplicarAnotacao(rascunhoAtual, input = {}) {
  if (input.descartar) return { rascunho: rascunhoVazio(), erros: [], descartado: true };
  const erros = [];
  const itens = (rascunhoAtual?.itens || []).map((i) => ({ ...i }));

  for (const t of input.trocar_itens || []) {
    const idx = Number(t.numero) - 1;
    if (!itens[idx]) { erros.push(`Não existe o item ${t.numero} no rascunho.`); continue; }
    itens[idx] = limparItem(t.item);
  }
  const remover = new Map();
  for (const r of input.remover_itens || []) {
    const idx = Number(r.numero) - 1;
    if (!itens[idx]) { erros.push(`Não existe o item ${r.numero} no rascunho.`); continue; }
    remover.set(idx, r.quantidade ? Number(r.quantidade) : Infinity);
  }
  let resultado = itens
    .map((it, idx) => {
      if (!remover.has(idx)) return it;
      const q = it.quantidade - remover.get(idx);
      return q > 0 ? { ...it, quantidade: q } : null;
    })
    .filter(Boolean);
  // Adicionar SOMA: item igual a um já anotado só aumenta a quantidade.
  for (const novo of input.adicionar_itens || []) {
    const n = limparItem(novo);
    if (!n.tipo || !n.sabor1) { erros.push('Item sem tipo ou sem sabor/nome — não anotei.'); continue; }
    const k = chaveItemBruta(n);
    const igual = resultado.find((it) => chaveItemBruta(it) === k);
    if (igual) igual.quantidade += n.quantidade;
    else resultado.push(n);
  }

  const rascunho = { ...rascunhoVazio(), ...rascunhoAtual, itens: resultado };
  for (const c of CAMPOS_DADOS) {
    if (input[c] === undefined) continue;
    rascunho[c] = input[c];
  }
  // Mudou o bairro ou foi pra retirada: o frete antigo não vale mais.
  if (input.bairro !== undefined || input.retirada !== undefined) delete rascunho.frete;
  return { rascunho, erros };
}

const brl = (v) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');

function textoItem(i) {
  const tam = i.tamanho ? `${i.tamanho} ` : '';
  const tipo = { pizza_salgada: 'Pizza ', pizza_doce: 'Pizza doce ', combo: 'Combo ', bebida: '' }[i.tipo] ?? '';
  const sabores = i.sabor2 ? `½ ${i.sabor1} + ½ ${i.sabor2}` : i.sabor1;
  const partes = [`${i.quantidade}x ${tipo}${tam}${sabores}`];
  if (i.pizza_do_dia) partes.push('(Pizza do Dia)');
  if (i.brinde_fidelidade) partes.push('(presente fidelidade)');
  if (i.borda) partes.push(`com borda de ${i.borda}`);
  if (Array.isArray(i.pizzas_do_combo) && i.pizzas_do_combo.length) {
    partes.push(`[pizzas: ${i.pizzas_do_combo.map((p) => `${p.sabor1 || 'sabor fixo'}${p.sabor2 ? ` + ${p.sabor2}` : ''}${p.borda ? ` com borda de ${p.borda}` : ''}`).join('; ')}]`);
  }
  if (i.doce_do_combo?.sabor) partes.push(`[doce: ${i.doce_do_combo.sabor}${i.doce_do_combo.borda ? ' com borda de chocolate' : ''}]`);
  if (i.bebida_do_combo) partes.push(`[bebida: ${i.bebida_do_combo}]`);
  if (i.obs) partes.push(`(obs: ${i.obs})`);
  return partes.join(' ');
}

const ROTULO_PAGAMENTO = { presencial: 'na entrega (dinheiro/maquininha)', pix: 'Pix', cartao_link: 'link de cartão' };

/** Lista do rascunho, numerada (os números são os usados em trocar_itens/remover_itens). */
export function formatarRascunho(r) {
  const linhas = [];
  if (r.itens?.length) r.itens.forEach((i, k) => linhas.push(`${k + 1}. ${textoItem(i)}`));
  else linhas.push('(nenhum item anotado ainda)');
  if (r.retirada) linhas.push('- Entrega: retirada na loja');
  else if (r.endereco || r.bairro || r.complemento) {
    const end = [r.endereco, r.complemento].filter(Boolean).join(', ');
    linhas.push(`- Entrega: ${end || '(rua e número ainda não informados)'}${r.bairro ? ` — bairro ${r.bairro}` : ' — (bairro ainda não informado)'}${r.frete != null ? ` (frete ${brl(r.frete)})` : ''}`);
  }
  if (r.forma_pagamento || r.pagamento_detalhe) {
    linhas.push(`- Pagamento: ${[ROTULO_PAGAMENTO[r.forma_pagamento], r.pagamento_detalhe].filter(Boolean).join(' — ')}`);
  }
  if (r.cupom) linhas.push(`- Cupom citado pelo cliente: ${r.cupom}`);
  if (r.observacoes) linhas.push(`- Observações: ${r.observacoes}`);
  if (r.total_calculado != null) linhas.push(`- Último total calculado (calcular_total): ${brl(r.total_calculado)}`);
  return linhas.join('\n');
}

/** Bloco do system prompt (vazio se não há rascunho). */
export function montarBlocoRascunho(r) {
  if (!rascunhoTemConteudo(r)) return '';
  return `\n## Pedido em andamento até agora (rascunho salvo — memória oficial do pedido)\n${formatarRascunho(r)}\n` +
    '- Isto é o que já foi combinado com o cliente, mesmo que não apareça mais nas mensagens acima. Nunca pergunte de novo o que já está aqui nem pergunte "qual vai ser o pedido".\n' +
    '- Item novo que o cliente pedir SOMA a esta lista (anote com `anotar_pedido`, só o item novo). O `calcular_total` e o `criar_pedido` levam TODOS os itens daqui + os novos.\n';
}

// ── Conferência: o pedido a registrar tem tudo o que está no rascunho? ─────
function catalogo(menuData, tipo) {
  return { pizza_salgada: menuData.salgadas, pizza_doce: menuData.doces, combo: menuData.combos, bebida: menuData.bebidas }[tipo] || [];
}

// Nome do produto → id do cardápio, tolerando acento, maiúscula e pontuação
// ("coca cola 1l" = "Coca-Cola 1L"); sem achar, compara o texto sem pontuação.
const soLetras = (s) => normalizar(s).replace(/[^a-z0-9]/g, '');
function canon(menuData, tipo, nome) {
  if (!nome) return '';
  const lista = catalogo(menuData, tipo);
  const alvo = soLetras(nome);
  const exato = lista.filter((p) => soLetras(p.nome) === alvo);
  let achado = exato.length === 1 ? exato[0] : buscarPorNome(lista, 'nome', nome);
  if (!achado) {
    const palavras = normalizar(nome).split(/[^a-z0-9]+/).filter(Boolean);
    const porPalavras = lista.filter((p) => palavras.every((w) => soLetras(p.nome).includes(w)));
    if (porPalavras.length === 1) achado = porPalavras[0];
  }
  return achado ? `id:${achado.id}` : alvo;
}

// Chave usada na conferência: tipo, sabores (sem ordem), tamanho, borda e marcas.
function chaveConferencia(item, menuData) {
  const tipo = item.tipo;
  const sabores = [canon(menuData, tipo, item.sabor1), canon(menuData, tipo, item.sabor2)].filter(Boolean).sort().join('+');
  if (tipo === 'combo' || tipo === 'bebida' || tipo === 'pizza_doce') return `${tipo}|${sabores}|${tipo === 'pizza_doce' ? item.borda || '' : ''}`;
  return `${tipo}|${sabores}|${item.tamanho || ''}|${item.borda || ''}|${item.pizza_do_dia ? 'pdd' : ''}|${item.brinde_fidelidade ? 'brinde' : ''}`;
}

function contar(itens, menuData) {
  const m = new Map();
  for (const i of itens || []) {
    const k = chaveConferencia(i, menuData);
    const q = Math.max(1, Math.trunc(Number(i.quantidade) || 1));
    const atual = m.get(k) || { q: 0, item: i };
    atual.q += q;
    m.set(k, atual);
  }
  return m;
}

/**
 * Itens do rascunho que faltam (ou estão com quantidade menor) na lista que
 * vai pro calcular_total/criar_pedido. Itens a mais na lista não são erro.
 * @returns {string[]} descrição de cada falta (vazio = tudo certo)
 */
export function itensFaltandoDoRascunho(rascunho, itensDoPedido, menuData) {
  if (!rascunho?.itens?.length) return [];
  const doRascunho = contar(rascunho.itens, menuData);
  const doPedido = contar(itensDoPedido, menuData);
  const faltas = [];
  for (const [k, { q, item }] of doRascunho) {
    const tem = doPedido.get(k)?.q || 0;
    if (tem < q) faltas.push(textoItem({ ...item, quantidade: q - tem }));
  }
  return faltas;
}

export function mensagemFaltaItens(faltas) {
  return (
    `Faltam itens que já estão no rascunho do pedido (combinados com o cliente): ${faltas.join('; ')}. ` +
    'Nada foi registrado. Chame a ferramenta de novo AGORA, sem perguntar nada ao cliente, com TODOS os itens do ' +
    '"Pedido em andamento até agora" + os novos. Só se o cliente pediu pra tirar algum desses itens, tire-o antes com ' +
    'anotar_pedido (remover_itens).'
  );
}

// ── Executores (amarrados ao número da conversa) ───────────────────────────
export function criarExecutorAnotarPedido({ numero }) {
  return async function executarAnotarPedido(input = {}) {
    const atual = await carregarRascunho(numero);
    const { rascunho, erros, descartado } = aplicarAnotacao(atual, input);
    if (descartado) {
      await apagarRascunho(numero);
      return { sucesso: true, rascunho: '(descartado — o cliente desistiu do pedido)' };
    }
    await salvarRascunho(numero, rascunho);
    return { sucesso: true, rascunho: formatarRascunho(rascunho), ...(erros.length ? { avisos: erros } : {}) };
  };
}

/**
 * Envolve os executores que mexem com o pedido novo:
 * - criar_pedido: recusa se faltar item do rascunho; com sucesso, apaga o rascunho.
 * - calcular_total: avisa se faltar item do rascunho e guarda frete/total no rascunho.
 * - verificar_bairro: guarda o bairro reconhecido e o frete no rascunho.
 */
export function comRascunho({ numero, getMenuData }) {
  return {
    criarPedido: (executor) => async (input = {}) => {
      const rascunho = await carregarRascunho(numero);
      const faltas = itensFaltandoDoRascunho(rascunho, input.itens, await getMenuData());
      if (faltas.length) {
        console.warn(`[rascunho] numero=${numero} criar_pedido sem itens do rascunho: ${faltas.join('; ')}`);
        return { erro: mensagemFaltaItens(faltas), itens_faltando: faltas };
      }
      const r = await executor(input);
      if (r?.sucesso) await apagarRascunho(numero);
      return r;
    },
    calcularTotal: (executor) => async (input = {}) => {
      const r = await executor(input);
      if (!r || r.erro) return r;
      const rascunho = await carregarRascunho(numero);
      const faltas = itensFaltandoDoRascunho(rascunho, input.itens, await getMenuData());
      if (faltas.length) {
        return {
          erro: mensagemFaltaItens(faltas).replace('Nada foi registrado.', 'Este total está INCOMPLETO — não mostre ao cliente.'),
          itens_faltando: faltas,
        };
      }
      if (rascunhoTemConteudo(rascunho)) {
        await salvarRascunho(numero, { ...rascunho, frete: r.frete, total_calculado: r.total });
      }
      return r;
    },
    verificarBairro: (executor) => async (input = {}) => {
      const r = await executor(input);
      if (r?.reconhecido && r.atendido) {
        const rascunho = await carregarRascunho(numero);
        await salvarRascunho(numero, { ...rascunho, bairro: r.bairro, frete: r.frete_zona, ...(input.cep ? { cep: input.cep } : {}) });
      }
      return r;
    },
  };
}
