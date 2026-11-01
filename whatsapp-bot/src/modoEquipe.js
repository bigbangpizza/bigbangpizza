import { conversarComFerramentas, textBlock } from './claude.js';
import { getMenuData } from './supabaseData.js';
import { calcularStatusLoja } from './systemPrompt.js';
import { getAgoraBahiaDetalhado } from './dataUtils.js';
import { primeiroNome, anotacoesAtivas, salvarAnotacao, removerAnotacao } from './equipe.js';
import { FERRAMENTAS_EQUIPE, criarExecutoresEquipe, normalizarTexto, dataHoraBahia, intervaloDoDia, tirarFichaDoTurno } from './equipeTools.js';
import { acaoPendente, descartarAcao, executarAcaoPendente, tirarResumoDoTurno } from './equipeAcoes.js';

// Modo equipe: mensagem de um número da tabela `equipe` (reconhecido pelo
// remoteJid no server.js, nunca pelo texto). Nada daqui roda pra cliente.
// Ordem: 1) resposta a uma ação pendente (sim/não); 2) comandos de anotação
// ("Luiza, anota: / esquece: / o que você anotou?"), tratados pelo código;
// 3) o resto vai pra Claude com as ferramentas de consulta da equipe.

const RE_ANOTA = /^\s*luiza\s*[,:;-]?\s*anota\s*[:;,-]?\s*([\s\S]+)$/i;
const RE_ESQUECE = /^\s*luiza\s*[,:;-]?\s*esquece\s*[:;,-]?\s*([\s\S]+)$/i;
const RE_LISTA = /^\s*luiza\s*[,:;-]?\s*(o\s+que\s+(voc[eê]\s+)?anotou|(quais\s+(s[aã]o\s+)?)?(as\s+)?anota[cç][oõ]es)\s*\??\s*$/i;
const RE_SIM = /^\s*(sim|s|confirmo|confirma|pode|pode sim|ok)\s*[.!]*\s*$/i;
const RE_NAO = /^\s*(n[aã]o|n|cancela|deixa|esquece)\s*[.!]*\s*$/i;
// Anotação sobre o que só vale pelo banco/admin (preço, cupom, frete, horário).
const RE_ASSUNTO_DO_ADMIN = /(r\$\s*\d|\bpre[cç]os?\b|\bcustam?\b|\bcupo(m|ns)\b|\bdesconto\b|\bfrete\b|\bhor[aá]rio\b|\babr(e|imos|ir)\b|\bfecha(mos|r)?\b|\btaxa de entrega\b)/i;

const MEIA_NOITE = (agora, dias) => intervaloDoDia('hoje', agora).de.getTime() + dias * 86400000;

/** Validade escrita na própria anotação: "hoje"/"só hoje" → meia-noite; "até amanhã"; "até DD/MM". */
export function validadeDaAnotacao(texto, agora = new Date()) {
  const t = normalizarTexto(texto);
  const ate = texto.match(/\bat[eé]\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i);
  if (ate) {
    const intervalo = intervaloDoDia(ate[1], agora);
    if (intervalo) return intervalo.ate;
  }
  if (/\bate amanha\b/.test(t)) return new Date(MEIA_NOITE(agora, 2));
  if (/\bhoje\b/.test(t)) return new Date(MEIA_NOITE(agora, 1));
  return null;
}

function linhaAnotacao(a) {
  const validade = a.expira_em ? `; vale até ${dataHoraBahia(new Date(new Date(a.expira_em).getTime() - 60000))}` : '';
  return `#${a.id} — ${a.texto} (${primeiroNome(a.autor_nome) || 'equipe'}, ${dataHoraBahia(a.criado_em).slice(0, 5)}${validade})`;
}

async function responderComando(texto, membro, agora) {
  let m = texto.match(RE_LISTA);
  if (m) {
    const lista = await anotacoesAtivas({ forcar: true });
    return lista.length ? `Anotações ativas:\n${lista.map(linhaAnotacao).join('\n')}` : 'Não tenho nenhuma anotação ativa.';
  }

  m = texto.match(RE_ANOTA);
  if (m) {
    const conteudo = m[1].trim();
    const expiraEm = validadeDaAnotacao(conteudo, agora);
    await salvarAnotacao({ texto: conteudo, membro, expiraEm });
    let resposta = 'Anotado ✅';
    if (expiraEm) resposta += ` (vale até ${dataHoraBahia(new Date(expiraEm.getTime() - 60000))})`;
    if (RE_ASSUNTO_DO_ADMIN.test(conteudo)) {
      resposta += '\nSó um aviso: preço, cupom, frete e horário eu sigo sempre o que está no admin. Se isso muda algum deles, precisa mudar lá também.';
    }
    return resposta;
  }

  m = texto.match(RE_ESQUECE);
  if (m) {
    const busca = m[1].trim();
    const lista = await anotacoesAtivas({ forcar: true });
    const porId = busca.match(/^#?(\d+)$/);
    let alvo;
    if (porId) alvo = lista.filter((a) => a.id === Number(porId[1]));
    else {
      const q = normalizarTexto(busca);
      alvo = lista.filter((a) => normalizarTexto(a.texto).includes(q));
      if (!alvo.length) {
        const termos = q.split(' ').filter((x) => x.length >= 3);
        alvo = termos.length ? lista.filter((a) => termos.every((x) => normalizarTexto(a.texto).includes(x))) : [];
      }
    }
    if (alvo.length === 1) {
      await removerAnotacao(alvo[0].id);
      return `Esquecido ✅ (${alvo[0].texto})`;
    }
    if (alvo.length > 1) {
      return `Achei mais de uma anotação com "${busca}":\n${alvo.map(linhaAnotacao).join('\n')}\nMe diga qual: "Luiza, esquece #número".`;
    }
    return lista.length
      ? `Não achei anotação com "${busca}". As ativas são:\n${lista.map(linhaAnotacao).join('\n')}`
      : `Não achei anotação com "${busca}" — não tenho nenhuma ativa.`;
  }
  return null;
}

export async function montarPromptEquipe(membro, agora = new Date()) {
  const { configuracoes } = await getMenuData();
  const status = calcularStatusLoja(configuracoes.modo_loja || 'automatico', agora, configuracoes.modo_loja_ate);
  const hora = getAgoraBahiaDetalhado(agora);
  const anotacoes = await anotacoesAtivas();
  return `Você é a Luiza, assistente da Big Bang Pizza, falando com ${membro.nome}, da EQUIPE da loja (não é cliente). Chame a pessoa de ${primeiroNome(membro.nome)}.

## Como responder à equipe
- Curto e direto, em tópicos. Sem o tom de atendimento ao cliente: sem cumprimentos longos, sem oferecer cardápio, sem emojis desnecessários.
- Formatação do WhatsApp: negrito é *um asterisco* de cada lado (nunca **dois**); sem títulos com #.
- Responda SEMPRE com dados consultados agora nas ferramentas — nunca de memória e nunca inventando. Datas e horas no horário da Bahia, como as ferramentas devolvem.
- Pedido: use buscar_pedidos. Mostre itens, total, pagamento, status, horário, endereço ou retirada e o histórico de status quando importar.
- Pagamento: diga a forma escolhida e se está marcado como pago no sistema. Se for Pix sem confirmação, diga exatamente: "foi escolhido Pix, mas o sistema não confirma o recebimento; confere no banco".
- Não achou: diga exatamente o que buscou e mostre as sugestões (ex: "não achei 'Matheus Peneluc'; achei 'Matheus' com o pedido #374 de 30/10 às 23h27, é esse?"). Nunca responda só "não encontrei".
- Conversa com cliente: resumo_conversa, e resuma em poucos tópicos o que o cliente queria e como terminou.
- Situação da loja, atrasos, faturamento do dia/semana: situacao_loja. Ficha do cliente: consultar_cliente.
- Ficha técnica de um pedido ("ficha do #380", "ficha do pedido do João", gramas, ingredientes): ficha_pedido. O sistema manda a ficha pronta; você não repete o conteúdo.
- Mensagem encaminhada de um alerta (ex: "🙋 Cliente precisa de atendimento... Telefone: ...", "⚠️ Pedido atrasado...") seguida de uma pergunta é uma pergunta INTERNA sobre aquele cliente/pedido: consulte pelos dados do alerta e responda. Não é pedido de atendimento.

## Ações (só com confirmação)
- A equipe pode pedir: marcar um pedido como pago, cancelar um pedido, ou mandar uma mensagem pro cliente de um pedido. Para isso chame preparar_acao. O sistema mostra o resumo e pergunta "confirma? (sim/não)"; a ação só acontece depois do "sim". Nunca diga que já fez.
- Mensagem pro cliente: use em \`texto\` exatamente o que a pessoa pediu pra dizer (se ela ditou a ideia, escreva a mensagem e ela vai aprovar no resumo).
- NUNCA escreva você mesma um resumo de ação nem pergunte "Confirma?": o resumo e a pergunta só existem quando você chama preparar_acao. Se a pessoa pediu uma ação (inclusive respondendo "sim, diz que..." a "Quer que eu avise o cliente?"), chame preparar_acao direto.
- Qualquer outra alteração (preço, cardápio, cupom, frete, horário, editar pedido): diga que é pelo admin.

## Anotações
- Comandos tratados pelo sistema: "Luiza, anota: ..." (salva; "hoje" na frase vale até meia-noite), "Luiza, esquece: ..." e "Luiza, o que você anotou?". Se a pessoa perguntar como anotar, explique esses comandos.
${anotacoes.length ? `- Anotações ativas agora:\n${anotacoes.map((a) => `  - ${linhaAnotacao(a)}`).join('\n')}` : '- Nenhuma anotação ativa agora.'}

## Agora
- ${hora.nomeDia}, ${hora.data}, ${hora.horaTexto} (horário da Bahia).
- Loja: ${status.resumo} (modo_loja: ${configuracoes.modo_loja || 'automatico'}).`;
}

function juntarTexto(userContent) {
  return (userContent || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

/**
 * Um turno do modo equipe. Grava a conversa em `historico` (já carregado pelo
 * server.js com a chave própria da equipe) e devolve o texto a enviar.
 * @returns {Promise<string>}
 */
export async function processarTurnoEquipe({ numero, membro, userContent, historico, aoEnviarMensagemCliente, lerHistoricoCliente, agora = () => new Date() }) {
  const texto = juntarTexto(userContent);
  const registrar = (resposta) => {
    historico.push({ role: 'user', content: userContent });
    historico.push({ role: 'assistant', content: [textBlock(resposta)] });
    return resposta;
  };

  let prefixo = '';
  if (acaoPendente(numero)) {
    if (RE_SIM.test(texto)) return registrar(await executarAcaoPendente(numero, { aoEnviarMensagem: aoEnviarMensagemCliente }));
    const ehOfertaDeAviso = acaoPendente(numero).tipo === 'oferta_aviso';
    if (RE_NAO.test(texto)) {
      descartarAcao(numero);
      return registrar(ehOfertaDeAviso ? 'Ok, não aviso o cliente.' : 'Ok, não fiz nada.');
    }
    descartarAcao(numero);
    // Depois de "Quer que eu avise o cliente?", outra resposta (ex: "sim, diz que...")
    // segue pro modelo, que prepara a mensagem com o texto pedido.
    if (!ehOfertaDeAviso) prefixo = '(A ação que estava esperando confirmação foi descartada.)\n\n';
  }

  try {
    const comando = await responderComando(texto, membro, agora());
    if (comando) return registrar(prefixo + comando);
  } catch (err) {
    console.error(`[modoEquipe] falha no comando de anotação (${numero}):`, err);
    return registrar(prefixo + 'Não consegui salvar/ler as anotações agora (erro técnico). Tenta de novo em instantes.');
  }

  // A ação descartada precisa constar pro modelo, senão ele ainda a trata como pendente.
  const aviso = prefixo ? [textBlock('[Sistema: a ação que esperava confirmação foi DESCARTADA. Não há mais nada esperando "sim"; se a pessoa ainda quiser, ela precisa pedir de novo.]')] : [];
  historico.push({ role: 'user', content: [...userContent, ...aviso] });
  const prompt = await montarPromptEquipe(membro, agora());
  const executores = criarExecutoresEquipe({ numero, membro, agora, lerHistoricoCliente });
  tirarResumoDoTurno(numero); // limpa sobra de turno anterior
  tirarFichaDoTurno(numero);
  const { textoResposta, novasMensagens } = await conversarComFerramentas(prompt, historico, FERRAMENTAS_EQUIPE, executores);

  // Ação preparada neste turno: o resumo e a pergunta saem do código, nunca do modelo.
  const resumoAcao = tirarResumoDoTurno(numero);
  // Ficha técnica: vai exatamente como o painel monta; do modelo, só um recado curto (ex: outros pedidos com o mesmo nome).
  const ficha = tirarFichaDoTurno(numero);
  // **negrito** de Markdown não funciona no WhatsApp: vira *negrito*.
  const textoModelo = textoResposta.replace(/\*\*(.+?)\*\*/g, '*$1*');
  const resposta = prefixo + (resumoAcao
    ? `${resumoAcao}\n\nConfirma? (sim/não)`
    : ficha ? `${ficha}${textoModelo && textoModelo.length < 400 ? `\n\n${textoModelo}` : ''}` : textoModelo);
  const ultima = novasMensagens[novasMensagens.length - 1];
  if (ultima?.role === 'assistant') ultima.content = [textBlock(resposta)];
  historico.push(...novasMensagens);
  return resposta;
}
