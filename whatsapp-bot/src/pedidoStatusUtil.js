import { getMenuData } from './supabaseData.js';
import { selectComoAdmin } from './supabaseAdmin.js';
import { normalizarWhatsapp, diasEntre, parseComoUTC, classificarSegmentoCliente } from './dataUtils.js';

// Compartilhado por cancelOrderTool.js e editOrderTool.js — ambos precisam
// achar "o pedido do cliente que está conversando agora" antes de decidir
// se ainda dá tempo de agir sobre ele.

// Só pedidos criados nas últimas N horas entram na busca — cancelar/editar
// só faz sentido pra pedido recente/em andamento, e isso evita ter que
// varrer o histórico inteiro de pedidos (de todos os clientes) a cada
// tentativa. A loja funciona ~6h/dia (quinta-domingo, 18h-00h); 12h dá
// folga suficiente mesmo pra quem escreve já perto da virada do dia.
export const JANELA_BUSCA_PEDIDO_HORAS = 12;

const CAMPOS_BASE = 'id,status,created_at,whatsapp';

/**
 * Busca o pedido mais recente do cliente dentro da janela de busca.
 * Compara telefones normalizados (não `eq.` direto) porque `pedidos.whatsapp`
 * vem em formatos diferentes conforme a origem: pedidos feitos pelo bot
 * gravam `numero` já normalizado (55+DDD+número), pedidos feitos pelo site
 * gravam o texto livre digitado no checkout (com máscara, sem DDI) — mesmo
 * problema que abandonedCartJob.js/reactivationJob.js já resolvem assim.
 * @param {string} numero telefone verificado da conversa (webhook).
 * @param {string} [camposExtras] colunas adicionais além de CAMPOS_BASE,
 *   separadas por vírgula (ex: 'nome,endereco,bairro,itens_json').
 */
export async function buscarPedidoRecenteDoCliente(numero, camposExtras = '') {
  const numeroNormalizado = normalizarWhatsapp(numero);
  if (!numeroNormalizado) return null;

  const select = camposExtras ? `${CAMPOS_BASE},${camposExtras}` : CAMPOS_BASE;
  const limite = new Date(Date.now() - JANELA_BUSCA_PEDIDO_HORAS * 3600000).toISOString();
  const pedidos = await selectComoAdmin(
    'pedidos',
    `select=${select}&whatsapp=not.is.null&created_at=gte.${limite}&order=created_at.desc`
  );
  return pedidos.find((p) => normalizarWhatsapp(p.whatsapp) === numeroNormalizado) || null;
}

// Mesmos aliases legados tratados no kanban do admin (admin.html:
// STATUS_LEGACY_ALIASES) — pedidos antigos podem ter ficado gravados com
// "aceito"/"preparando" em vez do bucket unificado "aceito_preparando".
const STATUS_EM_ABERTO = ['aguardando', 'aceito_preparando', 'aceito', 'preparando'];

/**
 * Busca o pedido EM ABERTO (aguardando/aceito_preparando) mais recente do
 * cliente, criado dentro dos últimos `janelaMinutos` — usado só pela
 * checagem de duplicidade em orderTool.js antes de criar um pedido novo
 * (ver PEDIDO_DUPLICADO_* em config.js). Diferente de
 * `buscarPedidoRecenteDoCliente` acima (janela em horas, sem filtro de
 * status — feita pra cancelamento/edição, não pra detecção de duplicata).
 */
export async function buscarPedidoAbertoRecente(numero, janelaMinutos, camposExtras = '') {
  const numeroNormalizado = normalizarWhatsapp(numero);
  if (!numeroNormalizado) return null;

  const select = camposExtras ? `${CAMPOS_BASE},${camposExtras}` : CAMPOS_BASE;
  const limite = new Date(Date.now() - janelaMinutos * 60000).toISOString();
  const pedidos = await selectComoAdmin(
    'pedidos',
    `select=${select}&whatsapp=not.is.null&status=in.(${STATUS_EM_ABERTO.join(',')})&created_at=gte.${limite}&order=created_at.desc`
  );
  return pedidos.find((p) => normalizarWhatsapp(p.whatsapp) === numeroNormalizado) || null;
}

/**
 * Busca o histórico completo (todo o tempo, sem janela) de um cliente pelo
 * telefone — usado só pelo reconhecimento de cliente recorrente no início de
 * uma conversa nova (ver montarBlocoClienteConhecido em systemPrompt.js).
 * Precisa do histórico completo (não só recente) porque a segmentação
 * (classificarSegmentoCliente) depende do total de pedidos já feitos e de
 * quantos dias faz do último — os mesmos critérios usados na aba Clientes
 * do admin.html. Busca a tabela toda (sem filtro de telefone no servidor,
 * mesmo padrão de buscarPedidoRecenteDoCliente acima) porque o formato
 * gravado em `pedidos.whatsapp` varia conforme a origem do pedido.
 * @param {string} numero telefone verificado da conversa (webhook).
 * @returns {Promise<object|null>} null se o telefone não tiver nenhum pedido.
 */
export async function buscarHistoricoClienteConhecido(numero) {
  const numeroNormalizado = normalizarWhatsapp(numero);
  if (!numeroNormalizado) return null;

  const todos = await selectComoAdmin(
    'pedidos',
    'select=nome,whatsapp,created_at,itens,bairro,endereco,total,status&whatsapp=not.is.null&order=created_at.desc'
  );
  const pedidosCliente = todos.filter((p) => normalizarWhatsapp(p.whatsapp) === numeroNormalizado);
  if (pedidosCliente.length === 0) return null;

  const diasDesdeUltimoPedido = diasEntre(parseComoUTC(pedidosCliente[0].created_at), new Date());
  const segmento = classificarSegmentoCliente(pedidosCliente.length, diasDesdeUltimoPedido);

  // Pedido cancelado não entra como "último pedido" pra sugestão de repetir
  // (não faz sentido oferecer repetir algo que o próprio cliente cancelou),
  // mas ainda conta pra segmentação acima (mesmo critério do admin.html, que
  // também não filtra status).
  const pedidosValidos = pedidosCliente.filter((p) => p.status !== 'cancelado');

  return {
    nome: pedidosCliente[0].nome || null,
    segmento,
    totalPedidos: pedidosCliente.length,
    diasDesdeUltimoPedido,
    ultimoEndereco: pedidosValidos[0]?.endereco || null,
    ultimoBairro: pedidosValidos[0]?.bairro || null,
    ultimosPedidos: pedidosValidos.slice(0, 2).map((p) => ({ itens: p.itens, total: p.total, criadoEm: p.created_at })),
  };
}

export function formatarTelefoneExibicao(numeroComDDI) {
  const digits = (numeroComDDI || '').replace(/\D/g, '');
  const semDDI = digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
  if (semDDI.length === 11) return `(${semDDI.slice(0, 2)}) ${semDDI.slice(2, 7)}-${semDDI.slice(7)}`;
  if (semDDI.length === 10) return `(${semDDI.slice(0, 2)}) ${semDDI.slice(2, 6)}-${semDDI.slice(6)}`;
  return numeroComDDI || '';
}

/**
 * Mensagem fixa de recusa quando o pedido já saiu de "aguardando" — usada
 * tanto pelo cancelamento quanto pela edição, já que as duas ações têm a
 * mesma janela de validade. `acaoInfinitivo` entra literalmente na frase
 * ("cancelar", "editar"), então precisa combinar gramaticalmente com "não é
 * mais possível ___ por aqui".
 */
export async function mensagemRecusaAcaoPedido(acaoInfinitivo) {
  const { configuracoes } = await getMenuData();
  const contato = configuracoes.info_whatsapp
    ? `WhatsApp ${formatarTelefoneExibicao(configuracoes.info_whatsapp)}`
    : 'diretamente com a loja';
  return (
    `Poxa, seu pedido já entrou em produção e não é mais possível ${acaoInfinitivo} por aqui. ` +
    `Se for realmente necessário, entre em contato direto com a loja: ${contato}.`
  );
}
