import { getMenuData } from './supabaseData.js';

const DIAS_ABERTOS = [0, 4, 5, 6]; // dom, qui, sex, sáb (mesma regra do site)

// Pega dia da semana e hora corrigidos para o horário de Lauro de Freitas (BA),
// independente do fuso horário onde o servidor do bot estiver rodando
// (Railway/Render costumam rodar em UTC ou horário dos EUA por padrão).
function getAgoraNoBrasil() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bahia',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const weekdayShort = parts.find((p) => p.type === 'weekday').value;
  const hora = Number(parts.find((p) => p.type === 'hour').value);
  const mapaDia = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { diaSemana: mapaDia[weekdayShort], hora };
}

function estaAbertoAgora(modoLoja) {
  if (modoLoja === 'aberta') return true;
  if (modoLoja === 'fechada') return false;
  const { diaSemana, hora } = getAgoraNoBrasil();
  return DIAS_ABERTOS.includes(diaSemana) && hora >= 18 && hora < 24;
}

function brl(v) {
  return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
}

function formatarSalgadas(lista) {
  if (!lista.length) return '(nenhuma pizza salgada ativa no momento)';
  return lista
    .map((p) => {
      const precos = [
        p.preco_grande != null ? `Grande ${brl(p.preco_grande)}` : null,
        p.preco_familia != null ? `Família ${brl(p.preco_familia)}` : null,
      ]
        .filter(Boolean)
        .join(' / ');
      return `- ${p.nome}${p.descricao ? ` — ${p.descricao}` : ''} (${precos})`;
    })
    .join('\n');
}

function formatarDoces(lista) {
  if (!lista.length) return '(nenhuma pizza doce ativa no momento)';
  return lista
    .map((p) => `- ${p.nome}${p.descricao ? ` — ${p.descricao}` : ''} (${brl(p.preco)})`)
    .join('\n');
}

function formatarCombos(lista) {
  if (!lista.length) return '(nenhum combo ativo no momento)';
  return lista
    .map((c) => `- ${c.nome}${c.descricao ? ` — ${c.descricao}` : ''} (${brl(c.preco)})`)
    .join('\n');
}

function formatarBebidas(lista) {
  if (!lista.length) return '(nenhuma bebida ativa no momento)';
  return lista.map((b) => `- ${b.nome} (${brl(b.preco)})`).join('\n');
}

function formatarBairros(lista) {
  if (!lista.length) return '(nenhum bairro cadastrado no momento)';
  return lista
    .map((b) => `- ${b.nome}: ${Number(b.frete) === 0 ? 'frete grátis' : `frete ${brl(b.frete)}`}`)
    .join('\n');
}

/**
 * Monta o system prompt da Claude API a partir dos dados reais do Supabase —
 * cardápio, preços e bairros de entrega vêm sempre do banco, então quando
 * alguém atualiza o admin, o bot responde atualizado (respeitando o cache
 * de MENU_CACHE_TTL_SECONDS, ver supabaseData.js).
 */
export async function buildSystemPrompt() {
  const { salgadas, doces, combos, bebidas, bairros, configuracoes } = await getMenuData();
  const aberto = estaAbertoAgora(configuracoes.modo_loja || 'automatico');

  return `Você é o atendente virtual da Big Bang Pizza, uma pizzaria artesanal delivery em Lauro de Freitas, Bahia. Seu tom é caloroso, cordial e animado, seguindo o espírito da marca "Explosão de Sabor 🍕🔥💥" — use emojis com moderação, sem exagerar.

## O que você PODE fazer
- Tirar dúvidas sobre o cardápio (sabores, descrições, preços, tamanhos).
- Informar horário de funcionamento e se a loja está aberta agora.
- Informar se um bairro é atendido e qual a taxa de entrega.
- Explicar como fazer um pedido (ver seção "Como pedir" abaixo).
- Bater um papo simpático e tirar dúvidas gerais sobre a pizzaria.

## O que você NÃO deve fazer
- Não registre pedidos nem finalize compras pelo WhatsApp — essa função ainda não existe neste canal. Se o cliente quiser pedir, oriente a fazer o pedido pelo site: https://bigbangpizza.com.br (ou, se preferir, pelo iFood).
- Não invente sabores, preços, bairros ou promoções que não estejam listados abaixo. Se não souber algo, diga que vai confirmar ou direcione para o WhatsApp/site oficial.
- Não prometa prazos de entrega exatos além de "normalmente entre 35 e 60 minutos".

## Horário de funcionamento
Quinta a domingo, das 18h às 00h (horário de Lauro de Freitas/BA).
Status agora: ${aberto ? 'ABERTO ✅' : 'FECHADO 🔴'}. ${aberto ? '' : 'Se o cliente perguntar sobre pedir agora, avise que a loja está fechada no momento e informe o próximo horário de funcionamento.'}

## Como pedir
Peça pelo site https://bigbangpizza.com.br — lá dá pra montar o pedido (inclusive pizza meio a meio), aplicar cupom e enviar direto pelo WhatsApp com o resumo pronto.

## Cardápio — Pizzas Salgadas (todas disponíveis meio a meio)
${formatarSalgadas(salgadas)}

## Cardápio — Pizzas Doces
${formatarDoces(doces)}

## Cardápio — Combos
${formatarCombos(combos)}

## Bebidas
${formatarBebidas(bebidas)}

## Bairros atendidos e taxa de entrega
${formatarBairros(bairros)}

Responda sempre em português do Brasil, de forma direta e objetiva (mensagens de WhatsApp devem ser curtas — evite parágrafos longos). Se a pergunta não tiver relação com a pizzaria, responda com simpatia mas traga a conversa de volta para como você pode ajudar com o pedido.`;
}
