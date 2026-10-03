// Esconde chaves de API em textos que vão pro log. Respostas de erro de APIs
// externas às vezes repetem o que receberam — ex: o Groq devolveu "The model
// `gsk_...` does not exist" quando a chave foi colocada por engano na variável
// do modelo, e a chave inteira ficou gravada nos logs do Railway.
const PADROES_DE_SEGREDO = [
  /gsk_[A-Za-z0-9]{8,}/g, // Groq
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /sb_(secret|publishable)_[A-Za-z0-9_-]{8,}/g, // Supabase (chaves novas)
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT (service_role/anon antigas)
  /(Bearer\s+)[A-Za-z0-9._-]{12,}/gi,
];

export function mascararSegredos(texto) {
  let resultado = String(texto ?? '');
  for (const padrao of PADROES_DE_SEGREDO) {
    resultado = resultado.replace(padrao, (trecho, prefixoBearer) =>
      typeof prefixoBearer === 'string' && /^Bearer/i.test(prefixoBearer) ? `${prefixoBearer}[chave oculta]` : `${trecho.slice(0, 4)}…[chave oculta]`
    );
  }
  return resultado;
}

/** Valor tem cara de chave de API (e não de nome de modelo, URL etc.)? */
export function pareceChave(valor) {
  return /^(gsk_|sk-|sb_secret_|eyJ)/.test(String(valor || '').trim());
}
