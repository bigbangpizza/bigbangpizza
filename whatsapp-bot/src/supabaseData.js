import { randomUUID } from 'node:crypto';
import { config } from './config.js';

// Mesmo padrão de acesso usado no site (index.html/admin.html): REST direta
// do PostgREST do Supabase com a chave pública (anon/publishable). As tabelas
// abaixo já são de leitura pública no site — não expõe nada nesse endpoint que
// não esteja acessível olhando o código-fonte de index.html.
//
// Só as tabelas do cardápio (e bairros) têm a coluna "ordem" — "configuracoes"
// não tem, então não dá pra ordenar por ela (mesma distinção feita em
// admin.html: const hasOrdem = [...].includes(table)).
const TABELAS_COM_ORDEM = ['combos', 'pizzas_salgadas', 'pizzas_doces', 'bebidas', 'bairros'];

async function fetchTable(table, query = '') {
  const sep = query ? '&' : '';
  const orderBy = TABELAS_COM_ORDEM.includes(table) ? 'ordem.asc,id.asc' : 'id.asc';
  const url = `${config.supabase.url}/rest/v1/${table}?${query}${sep}order=${orderBy}`;
  const r = await fetch(url, {
    headers: {
      apikey: config.supabase.anonKey,
      Authorization: `Bearer ${config.supabase.anonKey}`,
    },
  });
  if (!r.ok) {
    console.error(`[supabase] erro ao buscar ${table}:`, r.status, await r.text().catch(() => ''));
    return [];
  }
  return r.json();
}

async function fetchConfiguracoes() {
  const rows = await fetchTable('configuracoes');
  const map = {};
  for (const row of rows) map[row.chave] = row.valor;
  return map;
}

let cache = null; // { data, expiresAt }

async function loadMenuData() {
  const [salgadas, doces, combos, bebidas, bairros, configuracoes] = await Promise.all([
    fetchTable('pizzas_salgadas', 'ativo=eq.true'),
    fetchTable('pizzas_doces', 'ativo=eq.true'),
    fetchTable('combos', 'ativo=eq.true'),
    fetchTable('bebidas', 'ativo=eq.true'),
    fetchTable('bairros', 'ativo=eq.true'),
    fetchConfiguracoes(),
  ]);
  return { salgadas, doces, combos, bebidas, bairros, configuracoes };
}

/**
 * Retorna os dados do cardápio/bairros/config, com cache em memória de
 * `MENU_CACHE_TTL_SECONDS` segundos — evita bater no Supabase a cada
 * mensagem recebida, mas ainda assim reflete alterações feitas no admin
 * em poucos minutos, sem precisar reiniciar o bot.
 */
export async function getMenuData({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cache && cache.expiresAt > now) {
    return cache.data;
  }
  const data = await loadMenuData();
  cache = { data, expiresAt: now + config.menuCacheTtlSeconds * 1000 };
  return data;
}

/**
 * Insere um pedido na tabela `pedidos` — mesma estrutura usada pelo
 * checkout do site (index.html), então o pedido aparece no kanban do
 * admin normalmente. Usa a chave pública (anon), igual ao site.
 *
 * A policy de RLS de INSERT em `pedidos` é aberta pra anon (`with_check:
 * true`), mas NÃO existe policy de SELECT pra anon nessa tabela (proposital
 * — protege dados de clientes de outras pessoas). Isso tem duas
 * consequências importantes, confirmadas testando direto contra o projeto:
 *   1) O insert precisa ir com `Prefer: return=minimal` — pedir
 *      `return=representation` faz o PostgREST tentar um SELECT de volta
 *      da linha inserida, que falha com "row-level security policy" (o
 *      mesmo erro genérico de RLS, mas na real é falta de permissão de
 *      leitura, não de escrita).
 *   2) Pra saber o `id` gerado, a gente não lê a tabela diretamente — usa a
 *      mesma RPC `rastrear_pedido(p_token)` que o rastreio.html já usa pra
 *      buscar UM pedido específico pelo token, contornando a RLS de forma
 *      segura e já validada em produção. Por isso geramos o
 *      `rastreio_token` aqui (em vez de deixar o banco gerar sozinho) —
 *      assim já sabemos de antemão qual token usar pra essa segunda busca.
 * @returns {Promise<{id:number, rastreioToken:string}>}
 */
export async function inserirPedido(pedido) {
  const rastreioToken = randomUUID();

  const rInsert = await fetch(`${config.supabase.url}/rest/v1/pedidos`, {
    method: 'POST',
    headers: {
      apikey: config.supabase.anonKey,
      Authorization: `Bearer ${config.supabase.anonKey}`,
      'content-type': 'application/json',
      prefer: 'return=minimal',
    },
    body: JSON.stringify({ ...pedido, rastreio_token: rastreioToken }),
  });
  if (!rInsert.ok) {
    const errBody = await rInsert.text().catch(() => '');
    throw new Error(`Falha ao registrar pedido no Supabase (${rInsert.status}): ${errBody}`);
  }

  const rBusca = await fetch(`${config.supabase.url}/rest/v1/rpc/rastrear_pedido`, {
    method: 'POST',
    headers: {
      apikey: config.supabase.anonKey,
      Authorization: `Bearer ${config.supabase.anonKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ p_token: rastreioToken }),
  });
  if (!rBusca.ok) {
    // O pedido já foi inserido com sucesso — só não conseguimos confirmar o
    // id de volta. Não trata como falha do pedido em si.
    console.error('[supabase] pedido inserido, mas falha ao buscar id de volta via rastrear_pedido:', rBusca.status);
    return { id: null, rastreioToken };
  }
  const [row] = await rBusca.json();
  return { id: row?.id ?? null, rastreioToken };
}
