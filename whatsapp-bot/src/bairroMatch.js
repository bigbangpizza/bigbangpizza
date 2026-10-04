import { getMenuData } from './supabaseData.js';

// Reconhecimento do bairro que o cliente digitou/falou — tolerante a acento,
// maiúscula, pontuação, abreviações (Pq., Jd., Cond., Lot., Res.), pequenos
// erros de digitação e apelidos cadastrados no admin (coluna
// `bairros.apelidos`, que inclui os condomínios e loteamentos de cada
// bairro). Reconhece também os bairros INATIVOS (fora da área ou aguardando
// motoboy), pra Luiza poder dizer com educação que ainda não entregamos lá
// em vez de pedir CEP e chamar a equipe. Usado por verificar_bairro,
// criar_pedido e editar_pedido.

// Palavras que não ajudam a distinguir bairro: "Centro de Lauro", "Lauro
// Centro" e "bairro Centro" viram todos só "centro".
const PALAVRAS_IGNORADAS = new Set(['bairro', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'lauro', 'freitas', 'ba', 'bahia', 'cidade']);

// Abreviações e grafias que viram a forma cheia antes de comparar.
const EXPANSOES = {
  pq: 'parque', pque: 'parque', jd: 'jardim', jdm: 'jardim', cond: 'condominio', condominium: 'condominio',
  lot: 'loteamento', lote: 'loteamento', res: 'residencial', resid: 'residencial', cj: 'conjunto', conj: 'conjunto',
  joquei: 'jockey', jokey: 'jockey', club: 'clube', av: 'avenida',
};

export function normalizarBairro(texto) {
  return (texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((p) => EXPANSOES[p] || p)
    .filter((p) => p && !PALAVRAS_IGNORADAS.has(p))
    .join(' ');
}

function distancia(a, b) {
  const linha = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let anterior = linha[0];
    linha[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = linha[j];
      linha[j] = Math.min(linha[j] + 1, linha[j - 1] + 1, anterior + (a[i - 1] === b[j - 1] ? 0 : 1));
      anterior = temp;
    }
  }
  return linha[b.length];
}

// Quantos erros de digitação aceitar, pelo tamanho do nome.
function toleranciaPara(tamanho) {
  if (tamanho <= 4) return 0;
  if (tamanho <= 7) return 1;
  if (tamanho <= 12) return 2;
  return 3;
}

// Chaves normalizadas em cache por objeto (a lista com os apelidos é grande).
const cacheChaves = new WeakMap();
function chavesDo(bairro, soNome = false) {
  if (soNome) return [normalizarBairro(bairro.nome)].filter(Boolean);
  let c = cacheChaves.get(bairro);
  if (!c) {
    c = [bairro.nome, ...(bairro.apelidos || [])].map(normalizarBairro).filter(Boolean);
    cacheChaves.set(bairro, c);
  }
  return c;
}

// Palavras de "tipo" de lugar — não distinguem um bairro de outro
// ("Jardim do Jockey" e "Parque Jockey Clube" só têm "jockey" em comum).
const PALAVRAS_DE_TIPO = new Set(['jardim', 'parque', 'vila', 'vilas', 'conjunto', 'residencial', 'loteamento', 'recanto', 'condominio', 'clube', 'alto', 'novo', 'nova', 'portal', 'centro', 'avenida', 'praia']);

function palavrasDistintivas(chave) {
  return chave.split(' ').filter((p) => p.length >= 4 && !PALAVRAS_DE_TIPO.has(p));
}

function unico(lista) {
  const ids = [...new Set(lista.map((b) => b.id))];
  return ids.length === 1 ? lista[0] : null;
}

// Etapas da busca aproximada: null = nada nessa etapa; { achado } = o bairro,
// ou achado null quando ficou ambíguo.
const contem = (maior, menor) => menor.length >= 4 && ` ${maior} `.includes(` ${menor} `);

function porParte(lista, alvo, soNome) {
  // Nos apelidos (condomínios, loteamentos), só vale o apelido INTEIRO dentro do
  // que o cliente escreveu — uma palavra solta não pode puxar o bairro de um
  // condomínio ("Barra" não é o "Village Barra do Joanes", de Buraquinho).
  const casa = soNome ? (k) => contem(k, alvo) || contem(alvo, k) : (k) => contem(alvo, k);
  const r = lista.filter((b) => chavesDo(b, soNome).some(casa));
  return r.length ? { achado: unico(r) } : null;
}

function porPalavraCaracteristica(lista, alvo, soNome) {
  const palavrasAlvo = palavrasDistintivas(alvo);
  if (!palavrasAlvo.length) return null;
  const casa = (p, q) => p === q || (Math.min(p.length, q.length) >= 5 && distancia(p, q) <= 1);
  const r = lista.filter((b) => chavesDo(b, soNome).some((k) => palavrasDistintivas(k).some((pk) => palavrasAlvo.some((pa) => casa(pa, pk)))));
  const achado = r.length ? unico(r) : null;
  return achado ? { achado } : null; // ambíguo aqui não encerra a busca
}

function porDigitacao(lista, alvo, soNome) {
  let melhor = null;
  let melhorDist = Infinity;
  let empate = false;
  for (const b of lista) {
    for (const k of chavesDo(b, soNome)) {
      const d = distancia(alvo, k);
      if (d > toleranciaPara(Math.max(alvo.length, k.length))) continue;
      if (d < melhorDist) {
        melhor = b;
        melhorDist = d;
        empate = false;
      } else if (d === melhorDist && melhor && melhor.id !== b.id) {
        empate = true;
      }
    }
  }
  return melhor ? { achado: empate ? null : melhor } : null;
}

/**
 * @param {Array<{id:number, nome:string, apelidos?:string[]}>} bairros ativos
 * @param {string} texto o que o cliente disse
 * @param {Array} [inativos] bairros inativos (fora da área / aguardando motoboy) — o
 *   resultado traz `ativo: false` quando o cliente está num deles.
 * @returns {object|null} o bairro reconhecido, ou null se não reconheceu / ficou ambíguo
 */
export function buscarBairro(bairros, texto, inativos = []) {
  const alvo = normalizarBairro(texto);
  if (!alvo) return null;

  // 1. Igual ao nome ou a um apelido — vale mais que qualquer aproximação,
  // inclusive de um bairro que não atendemos.
  for (const lista of [bairros, inativos]) {
    const exatos = lista.filter((b) => chavesDo(b).includes(alvo));
    if (exatos.length) return unico(exatos);
  }

  // 2. Aproximações, nesta ordem: um nome contém o outro ("jockey" → Parque
  // Jockey Clube); mesma palavra característica mudando só o tipo ("Jardim
  // do Jockey"); pequenos erros de digitação. Em cada etapa: bairros
  // atendidos antes dos inativos, e o NOME antes dos apelidos (são centenas
  // de condomínios; um nome de bairro não pode ficar ambíguo por causa deles).
  for (const etapa of [porParte, porPalavraCaracteristica, porDigitacao]) {
    for (const lista of [bairros, inativos]) {
      for (const soNome of [true, false]) {
        const r = etapa(lista, alvo, soNome);
        if (r) {
          if (r.achado) return r.achado;
          if (etapa !== porPalavraCaracteristica) return null; // ambíguo: melhor não chutar
        }
      }
    }
  }
  return null;
}

/**
 * Consulta o CEP no ViaCEP (serviço público dos Correios) e devolve bairro e
 * cidade. Retorna null se o CEP for inválido ou o serviço não responder —
 * nunca lança, pra não travar o pedido.
 */
export async function consultarCep(cep) {
  const digitos = (cep || '').replace(/\D/g, '');
  if (digitos.length !== 8) return null;
  try {
    const r = await fetch(`https://viacep.com.br/ws/${digitos}/json/`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const data = await r.json();
    if (data.erro) return null;
    return {
      bairro: data.bairro || '',
      cidade: data.localidade || '',
      logradouro: data.logradouro || '',
      // CEP genérico — não indica o bairro do cliente:
      // - final 900-999: grande usuário, empresa, condomínio, caixa postal. Ex.
      //   real: 42702-900 volta "Centro" pra toda a Av. Luiz Tarquínio Pontes,
      //   mas o cliente do nº 710 é do Parque Jockey Clube;
      // - ViaCEP sem rua ou sem bairro: CEP geral da cidade. (Final 000 sozinho
      //   não basta: 42707-000 é a Rua José Ribeiro da Silva, em Vilas.)
      especial: Number(digitos.slice(5)) >= 900 || !data.logradouro || !data.bairro,
    };
  } catch (err) {
    console.error('[bairroMatch] falha ao consultar CEP no ViaCEP:', err.message);
    return null;
  }
}

/**
 * Resolve o bairro a partir do que o cliente disse e/ou do CEP. Se o nome não
 * bater, tenta o bairro que o ViaCEP devolve pro CEP.
 * @param {Array} [inativos] bairros que não atendemos (getMenuData().bairrosInativos)
 * @returns {Promise<{bairro: object|null, naoAtendido: object|null, cepInfo: object|null}>}
 *   `bairro` só vem preenchido se for atendido; `naoAtendido` = reconhecido, mas inativo.
 */
export async function resolverBairro(bairros, texto, cep, inativos = []) {
  let achado = texto ? buscarBairro(bairros, texto, inativos) : null;
  let cepInfo = null;
  if (!achado && cep) {
    cepInfo = await consultarCep(cep);
    if (cepInfo?.bairro && !cepInfo.especial) achado = buscarBairro(bairros, cepInfo.bairro, inativos);
  }
  const naoAtendido = achado && achado.ativo === false ? achado : null;
  return { bairro: naoAtendido ? null : achado, naoAtendido, cepInfo };
}

/** O cliente está num bairro que não atendemos (inativo): a Luiza avisa com educação, sem chamar a equipe. */
export function mensagemBairroNaoAtendido(bairro) {
  return (
    `"${bairro.nome}" é um bairro que ainda NÃO atendemos. Diga ao cliente, com educação e em uma mensagem, que ainda não entregamos em ${bairro.nome}. ` +
    'Não peça CEP nem chame chamar_atendente por isso, não registre o pedido com outro bairro e NÃO ofereça retirada nem outra alternativa por conta própria. Só se o cliente perguntar por retirada, diga que ele pode retirar na loja.'
  );
}

/**
 * Texto de erro devolvido pra Claude quando o bairro não foi reconhecido —
 * instrui o próximo passo em vez de mandar recusar o cliente.
 */
export function mensagemBairroNaoReconhecido(bairros, texto, cep, cepInfo) {
  const lista = bairros.map((b) => b.nome).join(', ');
  const infoCep = cep
    ? cepInfo?.especial
      ? ` O CEP ${cep} é genérico (de cidade, empresa, condomínio ou caixa postal) e NÃO indica o bairro do cliente — não use esse CEP pra definir bairro nem frete.`
      : cepInfo
        ? ` O CEP ${cep} é do bairro "${cepInfo.bairro || '(sem bairro)'}", ${cepInfo.cidade}, que também não está na lista.`
        : ` O CEP ${cep} não foi encontrado.`
    : '';
  return (
    `Não reconheci o bairro "${texto || ''}" na lista de entrega.${infoCep} ` +
    'NÃO diga ao cliente que o bairro não existe, que não está na lista ou que não entregamos lá. ' +
    (cep && cepInfo?.especial
      ? 'Peça ao cliente um ponto de referência do endereço (uma pergunta só) e, se der pra identificar o bairro, chame esta ferramenta de novo com o campo "bairro" (sem o CEP). Se ainda assim não der, chame chamar_atendente (motivo: confirmar o bairro e a entrega) e diga que a equipe vai confirmar por aqui.'
      : cep
      ? 'Agora chame a ferramenta chamar_atendente (motivo: confirmar entrega no bairro informado) e diga ao cliente que a equipe vai confirmar a entrega por aqui.'
      : 'Peça o CEP ou um ponto de referência do endereço e chame esta ferramenta de novo com o campo "cep". Se o cliente não souber o CEP e pelo ponto de referência você não conseguir identificar um bairro da lista, chame chamar_atendente e diga que a equipe vai confirmar a entrega por aqui.') +
    ` Bairros cadastrados: ${lista}.`
  );
}

/** Frete padrão da zona base (bairro cadastrado com R$ 0), editável em Configurações do Bot — mesmo fallback da calcular_checkout_v2. */
export function regrasFrete(configuracoes = {}) {
  const num = (v, padrao) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : padrao);
  return { fretePadrao: num(configuracoes.frete_padrao, 4.99) };
}

/**
 * Frete e regra de frete grátis de UM bairro: cada bairro tem o seu
 * "frete grátis a partir de" (coluna bairros.frete_gratis_minimo; vazio =
 * nunca grátis). Mesma regra da calcular_checkout_v2.
 */
export function freteDoBairro(bairro, configuracoes = {}) {
  const { fretePadrao } = regrasFrete(configuracoes);
  const frete = Number(bairro.frete) > 0 ? Number(bairro.frete) : fretePadrao;
  const min = Number.isFinite(parseFloat(bairro.frete_gratis_minimo)) ? parseFloat(bairro.frete_gratis_minimo) : null;
  const reais = (v) => 'R$ ' + v.toFixed(2).replace('.', ',');
  return {
    frete,
    freteGratisMinimo: min,
    regra: min != null
      ? `Frete ${reais(frete)}; grátis se os produtos somarem ${reais(min)} ou mais e o pedido não usar cupom.`
      : `Frete ${reais(frete)}, cobrado sempre: esse bairro não tem frete grátis.`,
  };
}

/**
 * Tool `verificar_bairro` — a Luiza chama logo que o cliente informa o
 * endereço, antes de seguir pro pagamento, pra não descobrir só na hora de
 * registrar o pedido que o bairro não foi reconhecido. Só consulta; não
 * grava nada.
 */
export const VERIFICAR_BAIRRO_TOOL = {
  name: 'verificar_bairro',
  description:
    'Confere se o bairro (e/ou CEP) que o cliente informou é atendido e qual o frete. Chame assim que o cliente ' +
    'informar o bairro ou o CEP, antes de perguntar a forma de pagamento. Mande o bairro exatamente como o cliente disse.',
  input_schema: {
    type: 'object',
    properties: {
      bairro: { type: 'string', description: 'Bairro exatamente como o cliente disse.' },
      cep: { type: 'string', description: 'CEP do endereço, se o cliente informou.' },
    },
    required: [],
  },
};

export function criarExecutorVerificarBairro() {
  return async function executarVerificarBairro(input = {}) {
    const { bairros, bairrosInativos, configuracoes } = await getMenuData();
    const { bairro, naoAtendido, cepInfo } = await resolverBairro(bairros, input.bairro, input.cep, bairrosInativos);
    if (naoAtendido) return { reconhecido: true, atendido: false, bairro: naoAtendido.nome, instrucao: mensagemBairroNaoAtendido(naoAtendido) };
    if (bairro) {
      const { frete, freteGratisMinimo, regra } = freteDoBairro(bairro, configuracoes);
      return {
        reconhecido: true,
        atendido: true,
        bairro: bairro.nome,
        frete_zona: frete,
        frete_gratis_a_partir_de: freteGratisMinimo,
        regra,
      };
    }
    return { reconhecido: false, instrucao: mensagemBairroNaoReconhecido(bairros, input.bairro, input.cep, cepInfo) };
  };
}
