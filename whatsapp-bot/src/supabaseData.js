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
