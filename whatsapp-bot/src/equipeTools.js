import { selectComoAdmin } from './supabaseAdmin.js';
import { getMenuData, consultarFidelidade } from './supabaseData.js';
import { calcularStatusLoja } from './systemPrompt.js';
import { obterConfigBotAdmin } from './botConfig.js';
import { parseComoUTC, minutosEntre, chaveTelefone, normalizarWhatsapp } from './dataUtils.js';
import { formatarTelefoneExibicao } from './pedidoStatusUtil.js';
import { prepararAcao } from './equipeAcoes.js';
import { montarFichaPedido, fichaEmTexto } from './fichaTecnica.js';

// Ferramentas do modo equipe (ver modoEquipe.js). Todas só leem o banco na
// hora — a única que "faz" algo é preparar_acao, e mesmo ela só deixa a ação
// pendente: quem executa é o código, depois de um "sim" da própria pessoa.

const STATUS_LABEL = {
  aguardando: 'Aguardando (cozinha ainda não aceitou)',
  aceito_preparando: 'Aceito/preparando',
  aceito: 'Aceito/preparando',
  preparando: 'Aceito/preparando',
  saiu: 'Saiu para entrega',
  entregue: 'Entregue',
  cancelado: 'Cancelado',
};
const STATUS_EM_ABERTO = ['aguardando', 'aceito_preparando', 'aceito', 'preparando', 'saiu'];

const CAMPOS_PEDIDO =
  'id,nome,whatsapp,itens,total,subtotal,frete,desconto,cupom,pagamento,pago,pago_em,pago_por,status,created_at,endereco,bairro,complemento,observacao,origem';

// ── Datas no horário da Bahia (UTC-3 fixo, sem horário de verão) ─────────
const OFFSET_BAHIA_MS = 3 * 3600 * 1000;

export function dataHoraBahia(valor) {
  const d = valor instanceof Date ? valor : parseComoUTC(valor);
  if (!d || Number.isNaN(d.getTime())) return '';
  const b = new Date(d.getTime() - OFFSET_BAHIA_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(b.getUTCDate())}/${p(b.getUTCMonth() + 1)} ${p(b.getUTCHours())}:${p(b.getUTCMinutes())}`;
}

/** Início (UTC) do dia da Bahia que contém `agora`, deslocado `dias` dias. */
export function inicioDiaBahia(agora, dias = 0) {
  const b = new Date(agora.getTime() - OFFSET_BAHIA_MS);
  return new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() + dias) + OFFSET_BAHIA_MS);
}

/** "hoje" | "ontem" | "AAAA-MM-DD" | "DD/MM[/AAAA]" → { de, ate } em UTC, ou null. */
export function intervaloDoDia(texto, agora = new Date()) {
  const t = String(texto || '').trim().toLowerCase();
  if (!t) return null;
  if (t === 'hoje') return { de: inicioDiaBahia(agora), ate: inicioDiaBahia(agora, 1) };
  if (t === 'ontem') return { de: inicioDiaBahia(agora, -1), ate: inicioDiaBahia(agora) };
  let a, m, d;
  let r = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (r) [, a, m, d] = r.map(Number);
  r = r || t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (r && d === undefined) {
    d = Number(r[1]); m = Number(r[2]);
    a = r[3] ? Number(r[3].length === 2 ? '20' + r[3] : r[3]) : new Date(agora.getTime() - OFFSET_BAHIA_MS).getUTCFullYear();
  }
  if (!d || !m || !a) return null;
  const de = new Date(Date.UTC(a, m - 1, d) + OFFSET_BAHIA_MS);
  return { de, ate: new Date(de.getTime() + 86400000) };
}

/** Sem acento, minúsculo, só letras/números separados por espaço. */
export function normalizarTexto(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Busca por nome: parcial e sem acento. "Achou" quando todas as palavras da
 * busca aparecem no nome (no começo de alguma palavra dele); senão devolve
 * sugestões — pedidos em que pelo menos uma palavra bate (ex: busca "Matheus
 * Peneluc", pedido gravado só como "Matheus").
 */
export function filtrarPorNome(pedidos, busca) {
  const termos = normalizarTexto(busca).split(' ').filter(Boolean);
  if (!termos.length) return { achados: [], sugestoes: [] };
  const casa = (palavras, termo) => palavras.some((p) => p.startsWith(termo) || (termo.length >= 4 && p.includes(termo)));
  const achados = [];
  const sugestoes = [];
  for (const p of pedidos) {
    const palavras = normalizarTexto(p.nome).split(' ').filter(Boolean);
    const batem = termos.filter((t) => casa(palavras, t)).length;
    if (batem === termos.length) achados.push(p);
    else if (batem > 0) sugestoes.push({ p, batem });
  }
  sugestoes.sort((x, y) => y.batem - x.batem); // mantém a ordem por data entre empates
  return { achados, sugestoes: sugestoes.map((s) => s.p) };
}

export function origemDoPedido(p) {
  if (p.origem === 'manual') return 'manual (admin)';
  if (/^Presencial \(|\(aguardando|via link Ton/.test(p.pagamento || '')) return 'WhatsApp (Luiza)';
  return 'site';
}

export function situacaoPagamento(p) {
  const forma = p.pagamento || 'não informada';
  if (p.pago) {
    return `${forma} — marcado como PAGO no sistema${p.pago_por ? ` por ${p.pago_por}` : ''}${p.pago_em ? ` em ${dataHoraBahia(p.pago_em)}` : ''}`;
  }
  if (/pix/i.test(forma)) return 'foi escolhido Pix, mas o sistema não confirma o recebimento; confere no banco';
  return `${forma} — sem confirmação de pagamento no sistema (normal pra pagamento na entrega/retirada)`;
}

function resumoCurto(p) {
  return { pedido_id: p.id, nome: p.nome, quando: dataHoraBahia(p.created_at), status: STATUS_LABEL[p.status] || p.status, total: p.total };
}

async function historicoDeStatus(ids) {
  if (!ids.length) return new Map();
  const linhas = await selectComoAdmin(
    'pedidos_status_log',
    `select=pedido_id,status_anterior,status_novo,alterado_em,origem&pedido_id=in.(${ids.join(',')})&order=alterado_em.asc`
  ).catch(() => []);
  const porPedido = new Map();
  for (const l of linhas) {
    if (!porPedido.has(l.pedido_id)) porPedido.set(l.pedido_id, []);
    porPedido.get(l.pedido_id).push(`${dataHoraBahia(l.alterado_em)} → ${STATUS_LABEL[l.status_novo] || l.status_novo} (${l.origem})`);
  }
  return porPedido;
}

function detalharPedido(p, historico) {
  const retirada = p.bairro === 'Retirada no local';
  return {
    pedido_id: p.id,
    criado_em: dataHoraBahia(p.created_at),
    origem: origemDoPedido(p),
    cliente: p.nome,
    telefone: p.whatsapp ? formatarTelefoneExibicao(normalizarWhatsapp(p.whatsapp)) : '(sem telefone)',
    itens: p.itens,
    valores: { subtotal: p.subtotal, desconto: p.desconto || 0, cupom: p.cupom || null, frete: p.frete, total: p.total },
    pagamento: situacaoPagamento(p),
    status: STATUS_LABEL[p.status] || p.status,
    entrega: retirada ? 'Retirada na loja' : [p.endereco, p.bairro].filter(Boolean).join(' — '),
    observacao: p.observacao || null,
    historico_status: historico?.length
      ? historico
      : ['(sem registro de mudanças de status — o histórico só começou a ser gravado em 31/10/2026)'],
  };
}

async function todosOsPedidos() {
  return selectComoAdmin('pedidos', `select=${CAMPOS_PEDIDO}&order=created_at.desc&limit=5000`);
}

/** Pedidos de um telefone (qualquer formato), mais recentes primeiro. */
function pedidosDoTelefone(pedidos, telefone) {
  const chave = chaveTelefone(telefone);
  if (!chave) return [];
  return pedidos.filter((p) => {
    const k = chaveTelefone(p.whatsapp);
    if (!k) return false;
    return k.length === 10 && chave.length === 10 ? k === chave : k.slice(-8) === chave.slice(-8);
  });
}

// ── buscar_pedidos ───────────────────────────────────────────────────────

export const BUSCAR_PEDIDOS_EQUIPE_TOOL = {
  name: 'buscar_pedidos',
  description:
    'Busca pedidos no sistema (qualquer cliente) por número, nome (parcial, sem acento), telefone e/ou data. ' +
    'Devolve itens, valores, forma de pagamento e se está pago, status, horário, endereço/retirada e histórico de status. ' +
    'Quando não acha, devolve exatamente o que foi buscado e sugestões parecidas — mostre as sugestões e pergunte se é uma delas.',
  input_schema: {
    type: 'object',
    properties: {
      pedido_id: { type: 'integer', description: 'Número do pedido, ex: 374 (de "#374").' },
      nome: { type: 'string', description: 'Nome ou parte do nome do cliente.' },
      telefone: { type: 'string', description: 'Telefone em qualquer formato.' },
      data: { type: 'string', description: '"hoje", "ontem", "AAAA-MM-DD" ou "DD/MM".' },
      status: { type: 'string', enum: ['em_aberto', 'aguardando', 'aceito_preparando', 'saiu', 'entregue', 'cancelado'] },
    },
    required: [],
  },
};

export async function executarBuscarPedidos(input = {}, { agora = new Date() } = {}) {
  const buscou = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  if (!Object.keys(buscou).length) return { erro: 'Diga o número do pedido, o nome, o telefone ou a data.' };

  const pedidos = await todosOsPedidos();
  let lista = pedidos;
  if (input.pedido_id) {
    lista = lista.filter((p) => p.id === Number(input.pedido_id));
    if (!lista.length) {
      const ultimo = pedidos[0];
      return { buscou, encontrados: 0, observacao: `Não existe pedido #${input.pedido_id}. O último pedido é o #${ultimo?.id} (${dataHoraBahia(ultimo?.created_at)}).` };
    }
  }
  if (input.data) {
    const intervalo = intervaloDoDia(input.data, agora);
    if (!intervalo) return { erro: `Não entendi a data "${input.data}". Use hoje, ontem, DD/MM ou AAAA-MM-DD.` };
    lista = lista.filter((p) => {
      const d = parseComoUTC(p.created_at);
      return d >= intervalo.de && d < intervalo.ate;
    });
  }
  if (input.status) {
    const alvo = input.status === 'em_aberto' ? STATUS_EM_ABERTO : input.status === 'aceito_preparando' ? ['aceito_preparando', 'aceito', 'preparando'] : [input.status];
    lista = lista.filter((p) => alvo.includes(p.status));
  }
  if (input.telefone) lista = pedidosDoTelefone(lista, input.telefone);

  let sugestoes = [];
  let doMesmoTelefone = [];
  if (input.nome) {
    const base = lista;
    const r = filtrarPorNome(base, input.nome);
    lista = r.achados;
    sugestoes = r.sugestoes;
    // O mesmo cliente às vezes digita o nome diferente (ex: "Matheus Peneluc
    // Cavalcanti" num pedido e só "Matheus" no #374): entram também os pedidos
    // do mesmo telefone dos que bateram pelo nome.
    // Os telefones vêm de quem bate pelo nome em QUALQUER data (o nome completo
    // pode estar só num pedido antigo do mesmo cliente).
    const chaves = new Set(
      [...lista, ...filtrarPorNome(pedidos, input.nome).achados].map((p) => chaveTelefone(p.whatsapp)).filter((k) => k && k.length === 10)
    );
    doMesmoTelefone = base.filter((p) => !lista.includes(p) && chaves.has(chaveTelefone(p.whatsapp)));
    if (doMesmoTelefone.length) {
      lista = [...lista, ...doMesmoTelefone].sort((a, b) => parseComoUTC(b.created_at) - parseComoUTC(a.created_at));
      sugestoes = sugestoes.filter((p) => !doMesmoTelefone.includes(p));
    }
    // Nenhuma sugestão com os outros filtros: tenta o nome em todos os pedidos.
    if (!lista.length && !sugestoes.length) sugestoes = filtrarPorNome(pedidos, input.nome).sugestoes;
  }

  if (!lista.length) {
    return {
      buscou,
      encontrados: 0,
      sugestoes: sugestoes.slice(0, 5).map(resumoCurto),
      observacao: sugestoes.length
        ? 'Nada bate com tudo o que foi buscado. Mostre o que buscou e as sugestões, e pergunte se é alguma delas.'
        : 'Nada encontrado. Diga exatamente o que buscou e sugira buscar por outro dado (número do pedido, telefone, data).',
    };
  }

  const LIMITE_DETALHADO = 5;
  const detalhar = lista.slice(0, LIMITE_DETALHADO);
  const historicos = await historicoDeStatus(detalhar.map((p) => p.id));
  if (doMesmoTelefone.length) {
    buscou.observacao_busca = `Pedidos ${doMesmoTelefone.map((p) => `#${p.id} ("${p.nome}")`).join(', ')} são do MESMO telefone de pedidos com o nome buscado — é o mesmo cliente, só gravou o nome diferente. Diga isso.`;
  }
  return {
    buscou,
    encontrados: lista.length,
    pedidos: detalhar.map((p) => detalharPedido(p, historicos.get(p.id))),
    ...(lista.length > LIMITE_DETALHADO ? { outros: lista.slice(LIMITE_DETALHADO, 30).map(resumoCurto) } : {}),
  };
}

// ── resumo_conversa ──────────────────────────────────────────────────────

export const RESUMO_CONVERSA_TOOL = {
  name: 'resumo_conversa',
  description:
    'Traz a conversa recente da Luiza com um cliente (pelo telefone, pelo número de um pedido ou pelo nome), pra você resumir. ' +
    'Só existe a conversa das últimas ~24h e as últimas mensagens dela.',
  input_schema: {
    type: 'object',
    properties: {
      telefone: { type: 'string' },
      pedido_id: { type: 'integer' },
      nome: { type: 'string' },
    },
    required: [],
  },
};

/** Variações do número como a Evolution manda no remoteJid (com e sem o 9). */
export function variacoesNumeroWhatsapp(telefone) {
  const chave = chaveTelefone(telefone);
  if (!chave || chave.length !== 10) return [];
  return [`55${chave.slice(0, 2)}9${chave.slice(2)}`, `55${chave}`];
}

function transcrever(historico) {
  const linhas = [];
  for (const m of historico || []) {
    const blocos = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    const texto = blocos.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    if (blocos.some((b) => b.type === 'image')) linhas.push(`${m.role === 'user' ? 'Cliente' : 'Luiza'}: [imagem]`);
    if (texto) linhas.push(`${m.role === 'user' ? 'Cliente' : 'Luiza'}: ${texto.slice(0, 600)}`);
  }
  return linhas;
}

export async function executarResumoConversa(input = {}, { lerHistorico }) {
  let telefone = input.telefone;
  let nomeAchado = null;
  if (!telefone && (input.pedido_id || input.nome)) {
    const pedidos = await todosOsPedidos();
    const p = input.pedido_id
      ? pedidos.find((x) => x.id === Number(input.pedido_id))
      : filtrarPorNome(pedidos.filter((x) => x.whatsapp), input.nome).achados[0];
    if (!p) return { buscou: input, erro: 'Não achei o pedido/cliente pra saber o telefone. Peça o telefone.' };
    if (!p.whatsapp) return { buscou: input, erro: `O pedido #${p.id} (${p.nome}) não tem telefone gravado.` };
    telefone = p.whatsapp;
    nomeAchado = `${p.nome} (pedido #${p.id})`;
  }
  if (!telefone) return { erro: 'Diga o telefone, o número do pedido ou o nome do cliente.' };

  for (const numero of variacoesNumeroWhatsapp(telefone)) {
    const historico = await lerHistorico(numero);
    if (historico?.length) {
      return { cliente: nomeAchado, telefone: formatarTelefoneExibicao(numero), mensagens: transcrever(historico) };
    }
  }
  return {
    buscou: input,
    cliente: nomeAchado,
    mensagens: [],
    observacao: 'Nenhuma conversa guardada pra esse número (a Luiza só guarda as últimas ~24h, e só as mensagens mais recentes).',
  };
}

// ── situacao_loja ────────────────────────────────────────────────────────

export const SITUACAO_LOJA_TOOL = {
  name: 'situacao_loja',
  description:
    'Situação da loja agora: modo da loja (automático/aberta/fechada), se está aberta, pedidos em aberto por status, ' +
    'pedidos atrasados e faturamento/quantidade de pedidos do dia e da semana (segunda a domingo).',
  input_schema: { type: 'object', properties: {}, required: [] },
};

function totais(lista) {
  const validos = lista.filter((p) => p.status !== 'cancelado');
  return {
    pedidos: validos.length,
    faturamento: Math.round(validos.reduce((s, p) => s + Number(p.total || 0), 0) * 100) / 100,
    cancelados: lista.length - validos.length,
  };
}

export async function executarSituacaoLoja(_input = {}, { agora = new Date() } = {}) {
  const [{ configuracoes }, pedidos, cfgBot] = await Promise.all([getMenuData(), todosOsPedidos(), obterConfigBotAdmin().catch(() => ({ pedidoAtrasoMinutos: 40 }))]);
  const modo = configuracoes.modo_loja || 'automatico';
  const status = calcularStatusLoja(modo, agora, configuracoes.modo_loja_ate);

  const emAberto = pedidos.filter((p) => STATUS_EM_ABERTO.includes(p.status));
  const porStatus = {};
  for (const p of emAberto) {
    const k = STATUS_LABEL[p.status] || p.status;
    porStatus[k] = (porStatus[k] || 0) + 1;
  }
  const atrasados = emAberto
    .filter((p) => p.status !== 'saiu')
    .map((p) => ({ ...resumoCurto(p), minutos_parado: minutosEntre(parseComoUTC(p.created_at), agora) }))
    .filter((p) => p.minutos_parado >= cfgBot.pedidoAtrasoMinutos);

  const hojeDe = inicioDiaBahia(agora);
  const diaSemanaBahia = new Date(agora.getTime() - OFFSET_BAHIA_MS).getUTCDay(); // 0 = domingo
  const semanaDe = inicioDiaBahia(agora, -((diaSemanaBahia + 6) % 7)); // segunda-feira
  const desde = (de) => pedidos.filter((p) => parseComoUTC(p.created_at) >= de);

  return {
    modo_loja: modo,
    loja_agora: status.resumo,
    em_aberto: { total: emAberto.length, por_status: porStatus, lista: emAberto.slice(0, 15).map(resumoCurto) },
    atrasados: { limite_minutos: cfgBot.pedidoAtrasoMinutos, lista: atrasados },
    hoje: totais(desde(hojeDe)),
    semana: { desde: dataHoraBahia(semanaDe).slice(0, 5), ...totais(desde(semanaDe)) },
  };
}

// ── consultar_cliente ────────────────────────────────────────────────────

export const CONSULTAR_CLIENTE_TOOL = {
  name: 'consultar_cliente',
  description:
    'Ficha de um cliente pelo telefone ou nome: quantos pedidos, último pedido, selos de fidelidade e cupons já usados.',
  input_schema: {
    type: 'object',
    properties: { telefone: { type: 'string' }, nome: { type: 'string' } },
    required: [],
  },
};

export async function executarConsultarCliente(input = {}) {
  const pedidos = await todosOsPedidos();
  let telefone = input.telefone;
  if (!telefone && input.nome) {
    const { achados, sugestoes } = filtrarPorNome(pedidos.filter((p) => p.whatsapp), input.nome);
    const telefones = [...new Set(achados.map((p) => chaveTelefone(p.whatsapp)).filter(Boolean))];
    if (telefones.length !== 1) {
      return {
        buscou: input,
        observacao: telefones.length ? 'Mais de um cliente com esse nome — peça o telefone ou escolha um.' : 'Nenhum cliente com esse nome.',
        clientes: (telefones.length ? achados : sugestoes).slice(0, 6).map((p) => ({ nome: p.nome, telefone: formatarTelefoneExibicao(normalizarWhatsapp(p.whatsapp)), ultimo_pedido: `#${p.id} ${dataHoraBahia(p.created_at)}` })),
      };
    }
    telefone = achados[0].whatsapp;
  }
  if (!telefone) return { erro: 'Diga o telefone ou o nome do cliente.' };

  const doCliente = pedidosDoTelefone(pedidos, telefone);
  if (!doCliente.length) return { buscou: input, observacao: 'Nenhum pedido com esse telefone.' };

  const cupons = {};
  for (const p of doCliente) if (p.cupom) cupons[p.cupom] = (cupons[p.cupom] || 0) + 1;
  const ultimo = doCliente[0];
  const fidelidade = await consultarFidelidade(normalizarWhatsapp(telefone));
  return {
    nomes_usados: [...new Set(doCliente.map((p) => p.nome).filter(Boolean))],
    telefone: formatarTelefoneExibicao(normalizarWhatsapp(telefone)),
    pedidos: {
      total: doCliente.length,
      entregues: doCliente.filter((p) => p.status === 'entregue').length,
      cancelados: doCliente.filter((p) => p.status === 'cancelado').length,
      primeiro: dataHoraBahia(doCliente[doCliente.length - 1].created_at),
    },
    ultimo_pedido: { pedido_id: ultimo.id, quando: dataHoraBahia(ultimo.created_at), itens: ultimo.itens, total: ultimo.total, status: STATUS_LABEL[ultimo.status] || ultimo.status },
    fidelidade: fidelidade || '(não consegui consultar agora)',
    cupons_usados: cupons,
  };
}

// ── preparar_acao ────────────────────────────────────────────────────────

export const PREPARAR_ACAO_TOOL = {
  name: 'preparar_acao',
  description:
    'Prepara uma ação pedida pela equipe — NÃO executa. Tipos: "marcar_pago", "cancelar", "mensagem_cliente" ' +
    '(manda uma mensagem pelo número da loja pro cliente do pedido; `texto` é exatamente o que vai ser enviado). ' +
    'O sistema mostra o resumo e pergunta "confirma? (sim/não)"; só executa com "sim". Nunca diga que a ação foi feita.',
  input_schema: {
    type: 'object',
    properties: {
      tipo: { type: 'string', enum: ['marcar_pago', 'cancelar', 'mensagem_cliente'] },
      pedido_id: { type: 'integer' },
      texto: { type: 'string', description: 'Só para mensagem_cliente: o texto exato a enviar ao cliente.' },
    },
    required: ['tipo', 'pedido_id'],
  },
};

export function criarExecutoresEquipe({ numero, membro, agora, lerHistoricoCliente }) {
  return {
    buscar_pedidos: (input) => executarBuscarPedidos(input, { agora: agora?.() }),
    resumo_conversa: (input) => executarResumoConversa(input, { lerHistorico: lerHistoricoCliente }),
    situacao_loja: (input) => executarSituacaoLoja(input, { agora: agora?.() }),
    consultar_cliente: (input) => executarConsultarCliente(input),
    preparar_acao: (input) => prepararAcao({ numero, membro, ...input }),
    ficha_pedido: (input) => executarFichaPedido(input, { numero }),
  };
}



// ── ficha_pedido ─────────────────────────────────────────────────────────
// Ficha técnica (ingredientes e gramas) do pedido, o mesmo cálculo do painel
// Cozinha (fichaTecnica.js). O texto vai pra equipe exatamente como sai daqui:
// o modoEquipe.js manda a ficha no lugar da resposta do modelo.

const fichaDoTurno = new Map(); // numero -> texto

export function tirarFichaDoTurno(numero) {
  const f = fichaDoTurno.get(numero);
  fichaDoTurno.delete(numero);
  return f || null;
}

export const FICHA_PEDIDO_TOOL = {
  name: 'ficha_pedido',
  description:
    'Ficha técnica de um pedido: cada pizza com ingredientes e gramas (das receitas cadastradas) e o total por ingrediente. ' +
    'Use quando a equipe pedir "ficha do #380" ou "ficha do pedido do João". O sistema envia a ficha pronta — não reescreva nem resuma.',
  input_schema: {
    type: 'object',
    properties: { pedido_id: { type: 'integer' }, nome: { type: 'string', description: 'Nome do cliente (usa o pedido mais recente dele).' } },
    required: [],
  },
};

async function dadosDaFicha() {
  const [receitas, ingredientes, menu] = await Promise.all([
    selectComoAdmin('receitas', 'select=produto_nome,tamanho,ingrediente_id,quantidade_g&ativo=is.true'),
    selectComoAdmin('ingredientes', 'select=id,nome'),
    getMenuData(),
  ]);
  const nomeIng = new Map(ingredientes.map((i) => [i.id, i.nome]));
  return {
    receitas: receitas.filter((r) => nomeIng.has(r.ingrediente_id)).map((r) => ({ ...r, ingrediente: nomeIng.get(r.ingrediente_id) })),
    salgadas: menu.salgadas.map((p) => p.nome),
    doces: menu.doces.map((p) => p.nome),
    bebidas: menu.bebidas.map((p) => p.nome),
    combos: (menu.combos || []).map((c) => ({ nome: c.nome, descricao: c.descricao })),
  };
}

export async function executarFichaPedido(input = {}, { numero }) {
  let id = input.pedido_id;
  let outros = [];
  if (!id && input.nome) {
    const { achados, sugestoes } = filtrarPorNome(await todosOsPedidos(), input.nome);
    if (!achados.length) {
      return { buscou: input, encontrados: 0, sugestoes: sugestoes.slice(0, 5).map(resumoCurto), observacao: 'Mostre o que buscou e as sugestões, e pergunte de qual pedido é a ficha.' };
    }
    id = achados[0].id; // mais recente
    outros = achados.slice(1, 4).map(resumoCurto);
  }
  if (!id) return { erro: 'Diga o número do pedido ou o nome do cliente.' };

  const [p] = await selectComoAdmin('pedidos', `select=id,nome,itens_json,created_at&id=eq.${Number(id)}`);
  if (!p) return { buscou: input, erro: `Não existe pedido #${id}.` };
  const texto = fichaEmTexto(montarFichaPedido(p.itens_json, await dadosDaFicha()));
  fichaDoTurno.set(numero, `📋 Ficha do pedido #${p.id} — ${p.nome} (${dataHoraBahia(p.created_at)})\n\n${texto}`);
  return {
    ficha_enviada: true,
    pedido_id: p.id,
    ...(outros.length ? { outros_pedidos_com_esse_nome: outros } : {}),
    observacao: 'A ficha já vai ser enviada pelo sistema. Não repita o conteúdo.',
  };
}

export const FERRAMENTAS_EQUIPE = [BUSCAR_PEDIDOS_EQUIPE_TOOL, RESUMO_CONVERSA_TOOL, SITUACAO_LOJA_TOOL, CONSULTAR_CLIENTE_TOOL, PREPARAR_ACAO_TOOL, FICHA_PEDIDO_TOOL];
