// Resumo do pedido com o valor de cada linha — o MESMO formato em todo lugar
// onde o pedido aparece: kanban e comanda do admin, página de rastreio e a
// confirmação no WhatsApp (o bot tem uma cópia idêntica em
// resumo-pedido.js na raiz do site — mantenha as duas iguais; esta é a cópia do bot, que roda separado no Railway).
//
// Regra principal: a soma das linhas bate exatamente com o total gravado no
// banco. Cada item mostra o preço cheio; borda vem embaixo como adicional;
// oferta da pizza doce e cupom aparecem como descontos (negativos). Se algum
// pedido antigo tiver diferença de centavos, entra uma linha "Ajuste".
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;

function brl(v) {
  const n = r2(v);
  return (n < 0 ? '-' : '') + 'R$ ' + Math.abs(n).toFixed(2).replace('.', ',');
}

function nomeItem(i, nomesDoces) {
  const s = i.sabores || [];
  const nome = s.length === 2 ? `½ ${s[0].nome} + ½ ${s[1].nome}` : (s[0] && s[0].nome) || 'Item';
  if (i.tamanho) return `Pizza ${i.tamanho} ${nome}`;
  const nomeBase = String((s[0] && s[0].nome) || '').toLowerCase();
  const ehDoce = i.oferta_doce || i.tabela === 'pizzas_doces' || (i.tipo === 'pizza' && !i.tamanho) || (nomesDoces && nomesDoces.has(nomeBase));
  return ehDoce ? `Pizza doce ${nome}` : nome;
}

/**
 * @param {object} p pedido (itens_json, itens, subtotal, desconto, cupom, frete, total, bairro)
 * @param {Set<string>} [nomesDoces] nomes das pizzas doces em minúsculas (pra rotular "Pizza doce")
 * @returns {{linhas: Array<{tipo:string, texto:string, valor:number|null}>, subtotal:number, frete:number, freteTexto:string, total:number}}
 */
function montarResumoPedido(p, nomesDoces) {
  const linhas = [];
  const itens = Array.isArray(p.itens_json) ? p.itens_json : [];
  let descontoOferta = 0;

  if (itens.length) {
    for (const i of itens) {
      const qty = Math.max(1, parseInt(i.qty, 10) || 1);
      const borda = i.borda && Number(i.borda.preco) > 0 ? i.borda : null;
      const precoBorda = borda ? Number(borda.preco) : 0;
      const precoPizza = r2(Number(i.precoUnitario || 0) - precoBorda);
      // Item da oferta: mostra o preço cheio e o desconto em linha própria.
      const precoCheio = i.oferta_doce ? Math.max(precoPizza, Number((i.sabores && i.sabores[0] && i.sabores[0].preco) || 0)) : precoPizza;
      linhas.push({ tipo: 'item', texto: `${qty}x ${nomeItem(i, nomesDoces)}`, valor: r2(precoCheio * qty) });
      if (borda) linhas.push({ tipo: 'adicional', texto: `+ Borda ${borda.nome}${qty > 1 ? ` (${qty}x)` : ''}`, valor: r2(precoBorda * qty) });
      if (precoCheio > precoPizza) descontoOferta = r2(descontoOferta + (precoCheio - precoPizza) * qty);
    }
  } else {
    // Pedido antigo sem itens detalhados: lista os itens e mostra o valor dos produtos numa linha só.
    for (const t of String(p.itens || '').split(' | ').filter(Boolean)) linhas.push({ tipo: 'item', texto: t, valor: null });
    linhas.push({ tipo: 'item', texto: 'Produtos', valor: r2(Number(p.subtotal || 0)) });
  }

  if (descontoOferta > 0) linhas.push({ tipo: 'desconto', texto: 'Oferta pizza doce', valor: -descontoOferta });
  const desconto = r2(Number(p.desconto || 0));
  if (desconto > 0) linhas.push({ tipo: 'desconto', texto: p.cupom ? `Cupom ${p.cupom}` : 'Desconto', valor: -desconto });

  const frete = r2(Number(p.frete || 0));
  const totalGravado = r2(Number(p.total || 0));
  let subtotal = r2(linhas.reduce((s, l) => s + (l.valor || 0), 0));
  const diferenca = r2(totalGravado - (subtotal + frete));
  if (Math.abs(diferenca) >= 0.01) {
    linhas.push({ tipo: 'ajuste', texto: 'Ajuste', valor: diferenca });
    subtotal = r2(subtotal + diferenca);
  }
  const retirada = p.bairro === 'Retirada no local';
  const freteTexto = retirada ? 'Retirada no local' : frete === 0 ? 'Frete grátis' : 'Frete';
  return { linhas, subtotal, frete, freteTexto, total: r2(subtotal + frete) };
}

/** Linhas de texto com o valor alinhado à direita (comanda térmica). Nunca corta o valor: quebra o texto. */
function textoMonoespacado(resumo, largura) {
  const saida = [];
  const linha = (texto, valor, recuo) => {
    const v = valor == null ? '' : brl(valor);
    // -2: linhas de continuação ganham 2 espaços de recuo e também precisam caber.
    const espacoTexto = Math.max(8, largura - v.length - 1 - recuo.length - 2);
    const palavras = String(texto).split(' ');
    const pedacos = [];
    let atual = '';
    for (const w of palavras) {
      if ((atual + (atual ? ' ' : '') + w).length > espacoTexto && atual) { pedacos.push(atual); atual = w; }
      else atual += (atual ? ' ' : '') + w;
    }
    if (atual) pedacos.push(atual);
    pedacos.forEach((pd, k) => {
      const ultima = k === pedacos.length - 1;
      const esq = (k === 0 ? recuo : recuo + '  ') + pd;
      saida.push(ultima && v ? esq + ' '.repeat(Math.max(1, largura - esq.length - v.length)) + v : esq);
    });
  };
  for (const l of resumo.linhas) linha(l.texto, l.valor, l.tipo === 'adicional' ? '  ' : '');
  saida.push('-'.repeat(largura));
  linha('Subtotal', resumo.subtotal, '');
  linha(resumo.freteTexto, resumo.frete, '');
  return saida;
}

/** Texto pro WhatsApp (sem colunas): "1x Pizza ... ... R$ 78,90". */
function textoWhatsApp(resumo) {
  const l = resumo.linhas.map((x) => (x.valor == null ? x.texto : `${x.tipo === 'adicional' ? '   ' : ''}${x.texto} ... ${brl(x.valor)}`));
  // Sem linha em branco: o bot quebra a resposta em mensagens separadas nas linhas em branco.
  l.push('──────────', `Subtotal ... ${brl(resumo.subtotal)}`, `${resumo.freteTexto} ... ${brl(resumo.frete)}`, `*TOTAL ... ${brl(resumo.total)}*`);
  return l.join('\n');
}

/** HTML (kanban do admin e página de rastreio). Quem chama passa a função de escape de HTML. */
function html(resumo, esc) {
  const row = (texto, valor, estilo) =>
    `<div style="display:flex;justify-content:space-between;gap:10px;padding:3px 0;${estilo || ''}"><span>${esc(texto)}</span><span style="white-space:nowrap;">${valor == null ? '' : esc(brl(valor))}</span></div>`;
  return [
    ...resumo.linhas.map((l) =>
      row(l.texto, l.valor, l.tipo === 'adicional' ? 'padding-left:14px;opacity:.75;font-size:.92em;' : l.tipo === 'desconto' || l.tipo === 'ajuste' ? 'color:#4ade80;' : 'font-weight:600;')
    ),
    `<div style="border-top:1px solid rgba(255,255,255,.12);margin:6px 0 2px;"></div>`,
    row('Subtotal', resumo.subtotal),
    row(resumo.freteTexto, resumo.frete),
    row('TOTAL', resumo.total, 'font-weight:800;font-size:1.15em;'),
  ].join('');
}

export { montarResumoPedido, textoMonoespacado, textoWhatsApp, html, brl };
