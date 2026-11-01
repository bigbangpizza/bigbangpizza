// Ficha técnica do pedido: ingredientes e gramas de cada pizza, a partir das
// receitas cadastradas no admin (aba CMV). Usada no painel Cozinha e na
// Luiza (modo equipe) — o bot tem uma cópia idêntica em whatsapp-bot/src/fichaTecnica.js
// (mantenha as duas iguais). Sabor sem receita aparece como aviso, nunca com
// gramas inventadas.
(function (root) {
  // Nome curto e ordem dos ingredientes na ficha (base primeiro, depois o recheio).
  const NOME_CURTO = { 'massa pizza': 'Massa', 'molho de tomate': 'Molho', 'mussarela': 'Muçarela', 'catupiry/requeijao': 'Requeijão', 'frango desfiado': 'Frango' };
  const ORDEM_BASE = ['Massa', 'Molho', 'Muçarela'];
  const ROTULO_TAMANHO = { 'Grande': 'Pizza Grande (35cm)', 'Família': 'Pizza Família (40cm)', 'Doce 25cm': 'Pizza Doce (25cm)' };

  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const nomeIngrediente = (n) => NOME_CURTO[norm(n)] || n;
  const ehBase = (nome) => ORDEM_BASE.includes(nome);
  const gramas = (g) => (g >= 1000 ? (Math.round(g / 100) / 10) + 'kg' : (Math.round(g * 10) / 10) + 'g').replace('.', ',');

  /**
   * Índice das receitas por "tamanho|sabor" (sem acento, minúsculo).
   * @param {Array<{produto_nome:string, tamanho:string, ingrediente:string, quantidade_g:number}>} receitas
   */
  function indexarReceitas(receitas) {
    const idx = new Map();
    for (const r of receitas || []) {
      const k = `${norm(r.tamanho)}|${norm(r.produto_nome)}`;
      if (!idx.has(k)) idx.set(k, []);
      const nome = nomeIngrediente(r.ingrediente);
      const lista = idx.get(k);
      const ja = lista.find((x) => x.nome === nome);
      if (ja) ja.g += Number(r.quantidade_g) || 0;
      else lista.push({ nome, g: Number(r.quantidade_g) || 0 });
    }
    return idx;
  }

  function ordenar(linhas) {
    return [...linhas].sort((a, b) => {
      const ia = ORDEM_BASE.indexOf(a.nome), ib = ORDEM_BASE.indexOf(b.nome);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }

  /**
   * Uma pizza: inteira (1 sabor) ou meio a meio (2 sabores). No meio a meio a
   * base (massa, molho, muçarela) é da pizza inteira e o recheio de cada
   * metade vai pela metade — inclusive o requeijão, que só existe na receita
   * dos sabores com Catupiry.
   */
  function fichaPizza(idx, tamanho, sabores, extras = {}) {
    const nomes = (sabores || []).map((s) => (typeof s === 'string' ? s : s && s.nome)).filter(Boolean);
    const recs = nomes.map((n) => idx.get(`${norm(tamanho)}|${norm(n)}`) || null);
    const pizza = { tipo: 'pizza', titulo: `${ROTULO_TAMANHO[tamanho] || 'Pizza ' + (tamanho || '')} — ${nomes.length === 2 ? `½ ${nomes[0]} + ½ ${nomes[1]}` : nomes[0] || '?'}`, ...extras, partes: [] };
    if (nomes.length < 2) {
      pizza.partes.push(recs[0] ? { linhas: ordenar(recs[0]) } : { semReceita: true, sabor: nomes[0] || '?' });
      return pizza;
    }
    const comBase = recs.find(Boolean);
    if (comBase) pizza.partes.push({ rotulo: 'Base', linhas: ordenar(comBase.filter((l) => ehBase(l.nome))) });
    nomes.forEach((n, i) => {
      pizza.partes.push(recs[i]
        ? { rotulo: `½ ${n}`, linhas: recs[i].filter((l) => !ehBase(l.nome)).map((l) => ({ nome: l.nome, g: l.g / 2 })) }
        : { rotulo: `½ ${n}`, semReceita: true, sabor: n });
    });
    return pizza;
  }

  // Pizzas salgadas de um combo sem escolha do cliente (Combo BIG, Explosão,
  // Família Big Bang, Bombou Premium): lidas da descrição cadastrada no admin.
  function pizzasDaDescricao(descricao, salgadas) {
    const d = String(descricao || '');
    const tamanho = /fam[ií]lia/i.test(d) ? 'Família' : 'Grande';
    const nomesMenu = [...(salgadas || [])].sort((a, b) => b.length - a.length);
    const achar = (trecho) => nomesMenu.find((n) => norm(trecho).startsWith(norm(n))) || nomesMenu.find((n) => norm(trecho).includes(norm(n)));
    const metades = [...d.matchAll(/½\s*([^+()]+)/g)].map((m) => achar(m[1])).filter(Boolean);
    if (metades.length === 2) return [{ tamanho, sabores: metades }];
    const antesDoDoce = d.split(/\+\s*(pizza\s+)?doce/i)[0];
    const inteira = achar(antesDoDoce.replace(/^.*?pizza\s+(grande|fam[ií]lia)\s*(\d+\s*cm)?\s*(de\s+)?/i, ''));
    return inteira ? [{ tamanho, sabores: [inteira] }] : [];
  }

  /**
   * Ficha técnica do pedido inteiro, a partir do itens_json gravado.
   * @param {Array} itensJson pedidos.itens_json
   * @param {{receitas:Array, salgadas:string[], doces:string[], bebidas:string[], combos:Array<{nome:string, descricao:string}>}} dados
   * @returns {{blocos:Array, totais:Array<{nome:string,g:number}>}}
   */
  function montarFichaPedido(itensJson, dados) {
    const idx = indexarReceitas(dados.receitas);
    const doces = new Set((dados.doces || []).map(norm));
    const bebidas = new Set((dados.bebidas || []).map(norm));
    const combos = new Map((dados.combos || []).map((c) => [norm(c.nome), c]));
    const blocos = [];
    const doce = (nome, extras) => fichaPizza(idx, 'Doce 25cm', [nome], extras);

    for (const it of Array.isArray(itensJson) ? itensJson : []) {
      const qty = Math.max(1, parseInt(it.qty, 10) || 1);
      const sabores = it.sabores || [];
      const nome = sabores[0] && sabores[0].nome;
      const borda = it.borda ? (it.borda.nome || it.borda) : null;
      const comuns = { qty, borda, obs: it.obs || null };
      const combo = combos.get(norm(nome));

      if (combo || (Array.isArray(it.combo_pizzas) && it.combo_pizzas.length)) {
        const filhos = [];
        const pizzas = Array.isArray(it.combo_pizzas) && it.combo_pizzas.length
          ? it.combo_pizzas : pizzasDaDescricao(combo && combo.descricao, dados.salgadas);
        pizzas.forEach((p) => filhos.push(fichaPizza(idx, p.tamanho || 'Grande', p.sabores, borda ? { borda } : {})));
        if (!pizzas.length) filhos.push({ tipo: 'aviso', titulo: 'Pizzas do combo não identificadas — confira a descrição do combo no admin' });
        const descr = (combo && combo.descricao) || '';
        if (it.combo_doce && it.combo_doce.nome) filhos.push(doce(it.combo_doce.nome));
        else if (/doce/i.test(descr)) filhos.push({ tipo: 'aviso', titulo: 'Pizza Doce (25cm) — sabor não informado no pedido' });
        if (it.combo_bebida && it.combo_bebida.nome) filhos.push({ tipo: 'bebida', titulo: it.combo_bebida.nome });
        else if (/coca|refri|bebida|guaran/i.test(descr)) filhos.push({ tipo: 'bebida', titulo: (descr.match(/(coca[^+()]*|refri[^+()]*|guaran[^+()]*)/i) || [])[1]?.trim() || 'Bebida' });
        blocos.push({ tipo: 'combo', titulo: nome || 'Combo', ...comuns, filhos });
      } else if (it.tamanho === 'Grande' || it.tamanho === 'Família') {
        const extras = it.pizza_do_dia ? { etiqueta: `Pizza do Dia — ${it.pizza_do_dia}` } : it.brinde_fidelidade ? { etiqueta: '🎁 Presente da fidelidade' } : {};
        blocos.push(fichaPizza(idx, it.tamanho, sabores, { ...comuns, ...extras }));
      } else if (bebidas.has(norm(nome))) {
        blocos.push({ tipo: 'bebida', titulo: nome, qty });
      } else if (doces.has(norm(nome)) || it.oferta_doce || it.tabela === 'pizzas_doces' || it.tipo === 'pizza') {
        blocos.push(doce(nome, comuns));
      } else {
        blocos.push({ tipo: 'aviso', titulo: `${nome || 'Item'} — receita não cadastrada`, qty });
      }
    }

    // Total do pedido por ingrediente (quantidade do item × gramas).
    const totais = new Map();
    const somar = (b, mult) => (b.partes || []).forEach((p) => (p.linhas || []).forEach((l) => totais.set(l.nome, (totais.get(l.nome) || 0) + l.g * mult)));
    blocos.forEach((b) => (b.filhos ? b.filhos.forEach((f) => somar(f, b.qty || 1)) : somar(b, b.qty || 1)));
    return { blocos, totais: ordenar([...totais].map(([nome, g]) => ({ nome, g }))) };
  }

  /** A ficha em texto (WhatsApp e impressão térmica). */
  function fichaEmTexto(ficha, { negrito = (t) => `*${t}*` } = {}) {
    const out = [];
    const linhaIngredientes = (linhas) => linhas.map((l) => `${l.nome} ${gramas(l.g)}`).join(' · ');
    const pizza = (b, prefixo = '') => {
      const cab = `${prefixo}${b.qty > 1 ? b.qty + 'x ' : ''}${b.titulo}`;
      if (b.tipo === 'bebida') { out.push(`${cab} (bebida, sem receita)`); return; }
      if (b.tipo === 'aviso') { out.push(`⚠️ ${cab}`); return; }
      out.push(negrito(cab));
      if (b.etiqueta) out.push(b.etiqueta);
      if (b.borda) out.push(`Borda: ${b.borda}`);
      for (const p of b.partes || []) {
        const r = p.rotulo ? `${p.rotulo}: ` : '';
        out.push(p.semReceita ? `${r}⚠️ Receita não cadastrada (${p.sabor})` : r + linhaIngredientes(p.linhas));
      }
      if (b.obs) out.push(`Obs: ${b.obs}`);
    };
    ficha.blocos.forEach((b, i) => {
      if (i) out.push('');
      if (b.tipo === 'combo') {
        out.push(negrito(`${b.qty > 1 ? b.qty + 'x ' : ''}${b.titulo}`));
        if (b.obs) out.push(`Obs: ${b.obs}`);
        b.filhos.forEach((f) => pizza(f, '↳ '));
      } else pizza(b);
    });
    if (ficha.totais.length) {
      out.push('', negrito('Total do pedido'), linhaIngredientes(ficha.totais));
    }
    return out.join('\n');
  }

  const api = { montarFichaPedido, fichaEmTexto, gramas };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FichaTecnica = api;
})(typeof window !== 'undefined' ? window : globalThis);
