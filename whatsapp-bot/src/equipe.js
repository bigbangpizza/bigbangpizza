import { temServiceRoleConfigurada, selectComoAdmin, inserirComoAdmin, atualizarComoAdmin } from './supabaseAdmin.js';
import { chaveTelefone } from './dataUtils.js';

// Modo equipe da Luiza. Quem é da equipe vem da tabela `equipe` (editada no
// admin, aba Configurações do Bot) e é reconhecido SÓ pelo número de origem
// da mensagem (remoteJid do webhook) — nunca pelo que está escrito no texto.
// A tabela não é legível pela chave pública (RLS), só pela service_role.

const CACHE_EQUIPE_MS = 60 * 1000;
let cacheEquipe = null; // { lista, ate }

/** Membros ativos da equipe, com cache curto (o admin pode editar a lista a qualquer hora). */
export async function listarEquipe() {
  if (cacheEquipe && cacheEquipe.ate > Date.now()) return cacheEquipe.lista;
  if (!temServiceRoleConfigurada()) return [];
  try {
    const lista = await selectComoAdmin('equipe', 'select=id,nome,telefone&ativo=is.true');
    cacheEquipe = { lista, ate: Date.now() + CACHE_EQUIPE_MS };
    return lista;
  } catch (err) {
    console.error('[equipe] falha ao ler a lista da equipe:', err.message);
    // Sem conseguir ler agora: usa a última lista conhecida; sem nenhuma, ninguém é equipe (fica no modo cliente).
    return cacheEquipe?.lista || [];
  }
}

/**
 * O número é da equipe? Compara pela chave do telefone (com ou sem 55, com
 * ou sem o 9), exigindo DDD dos dois lados — sem o atalho dos 8 últimos
 * dígitos de mesmoTelefone(), que aqui abriria brecha pra outro DDD.
 * @returns {Promise<{id:number, nome:string, telefone:string}|null>}
 */
export async function membroDaEquipe(numero) {
  const chave = chaveTelefone(numero);
  if (!chave || chave.length !== 10) return null;
  const lista = await listarEquipe();
  return lista.find((m) => chaveTelefone(m.telefone) === chave) || null;
}

/** Chaves de telefone da equipe — pra deixar a equipe fora do CRM, reativação e carrinho abandonado. */
export async function chavesTelefoneEquipe() {
  const lista = await listarEquipe();
  return new Set(lista.map((m) => chaveTelefone(m.telefone)).filter((k) => k && k.length === 10));
}

export function primeiroNome(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || '';
}

// ── Anotações ("Luiza, anota: ...") ──────────────────────────────────────

const CACHE_ANOTACOES_MS = 60 * 1000;
let cacheAnotacoes = null; // { lista, ate }

/** Anotações ativas e dentro da validade, mais antigas primeiro. */
export async function anotacoesAtivas({ forcar = false } = {}) {
  if (!forcar && cacheAnotacoes && cacheAnotacoes.ate > Date.now()) return cacheAnotacoes.lista;
  if (!temServiceRoleConfigurada()) return [];
  try {
    const agora = new Date().toISOString();
    const lista = await selectComoAdmin(
      'informacoes_loja',
      `select=id,texto,autor_nome,criado_em,expira_em&ativo=is.true&or=(expira_em.is.null,expira_em.gt.${agora})&order=criado_em.asc`
    );
    cacheAnotacoes = { lista, ate: Date.now() + CACHE_ANOTACOES_MS };
    return lista;
  } catch (err) {
    console.error('[equipe] falha ao ler anotações:', err.message);
    return cacheAnotacoes?.lista || [];
  }
}

export async function salvarAnotacao({ texto, membro, expiraEm }) {
  await inserirComoAdmin('informacoes_loja', {
    texto,
    autor_nome: membro.nome,
    autor_telefone: membro.telefone,
    expira_em: expiraEm ? expiraEm.toISOString() : null,
  });
  cacheAnotacoes = null;
}

export async function removerAnotacao(id) {
  await atualizarComoAdmin('informacoes_loja', id, { ativo: false });
  cacheAnotacoes = null;
}

/** Registro de toda ação executada pela Luiza a pedido da equipe. Nunca derruba a ação. */
export async function registrarAcaoEquipe({ membro, tipo, pedidoId, detalhes, resultado }) {
  try {
    await inserirComoAdmin('acoes_equipe', {
      membro_nome: membro.nome,
      membro_telefone: membro.telefone,
      tipo,
      pedido_id: pedidoId ?? null,
      detalhes: detalhes ?? null,
      resultado,
    });
  } catch (err) {
    console.error('[equipe] falha ao registrar ação da equipe:', err.message);
  }
}
