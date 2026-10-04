import { config } from './config.js';

// Rotas do admin (ex: /admin/extrair-pedido) só aceitam o LOGIN da equipe:
// o admin manda o token da sessão do Supabase Auth (o mesmo que usa pra ler
// os pedidos) e o bot confere no próprio Supabase se ele é válido e se é da
// conta da equipe. Substitui o ADMIN_API_SECRET, que ficava visível no
// código do admin.html.
const EMAIL_EQUIPE = (process.env.ADMIN_EMAIL || 'bigbangpz@outlook.com').toLowerCase();
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // token -> { ok, expiraEm }

/** @returns {Promise<boolean>} true se o header Authorization traz o login válido da conta da equipe. */
export async function validarLoginEquipe(authorizationHeader) {
  const token = /^Bearer\s+(.+)$/i.exec(authorizationHeader || '')?.[1]?.trim();
  if (!token || token.length < 20) return false;
  const emCache = cache.get(token);
  if (emCache && emCache.expiraEm > Date.now()) return emCache.ok;
  let ok = false;
  try {
    const r = await fetch(`${config.supabase.url}/auth/v1/user`, {
      headers: { apikey: config.supabase.anonKey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const usuario = await r.json();
      ok = String(usuario?.email || '').toLowerCase() === EMAIL_EQUIPE;
    }
  } catch (err) {
    console.error('[adminAuth] falha ao validar login no Supabase:', err.message);
    return false; // não guarda em cache: pode ser só instabilidade
  }
  cache.set(token, { ok, expiraEm: Date.now() + CACHE_MS });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return ok;
}
