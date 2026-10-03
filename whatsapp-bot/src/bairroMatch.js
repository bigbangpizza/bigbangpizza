import { getMenuData } from './supabaseData.js';

// Reconhecimento do bairro que o cliente digitou/falou — tolerante a acento,
// maiúscula, pontuação, pequenos erros de digitação e apelidos cadastrados
// no admin (coluna `bairros.apelidos`). Usado por criar_pedido e
// editar_pedido. Nunca "recusa" nada: quem decide o que dizer ao cliente
// quando não reconhece é o prompt (pedir CEP/referência, depois chamar a
// equipe).

// Palavras que não ajudam a distinguir bairro: "Centro de Lauro", "Lauro
// Centro" e "bairro Centro" viram todos só "centro".
const PALAVRAS_IGNORADAS = new Set(['bairro', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'lauro', 'freitas', 'ba', 'bahia', 'cidade']);

export function normalizarBairro(texto) {
  return (texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
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

function chavesDo(bairro) {
  return [bairro.nome, ...(bairro.apelidos || [])].map(normalizarBairro).filter(Boolean);
}

function unico(lista) {
  const ids = [...new Set(lista.map((b) => b.id))];
  return ids.length === 1 ? lista[0] : null;
}

/**
 * @param {Array<{id:number, nome:string, apelidos?:string[]}>} bairros ativos
 * @param {string} texto o que o cliente disse
 * @returns {object|null} o bairro reconhecido, ou null se não reconheceu / ficou ambíguo
 */
export function buscarBairro(bairros, texto) {
  const alvo = normalizarBairro(texto);
  if (!alvo) return null;

  // 1. Igual ao nome ou a um apelido.
  const exatos = bairros.filter((b) => chavesDo(b).includes(alvo));
  if (exatos.length) return unico(exatos);

  // 2. Um contém o outro como palavras inteiras ("jockey" → Parque Jockey Clube).
  const contem = (maior, menor) => menor.length >= 4 && ` ${maior} `.includes(` ${menor} `);
  const parciais = bairros.filter((b) => chavesDo(b).some((k) => contem(k, alvo) || contem(alvo, k)));
  if (parciais.length) return unico(parciais);

  // 3. Pequenos erros de digitação: o mais próximo, se só um estiver dentro da tolerância.
  let melhor = null;
  let melhorDist = Infinity;
  let empate = false;
  for (const b of bairros) {
    for (const k of chavesDo(b)) {
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
  return melhor && !empate ? melhor : null;
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
    return { bairro: data.bairro || '', cidade: data.localidade || '', logradouro: data.logradouro || '' };
  } catch (err) {
    console.error('[bairroMatch] falha ao consultar CEP no ViaCEP:', err.message);
    return null;
  }
}

/**
 * Resolve o bairro a partir do que o cliente disse e/ou do CEP. Se o nome não
 * bater, tenta o bairro que o ViaCEP devolve pro CEP.
 * @returns {Promise<{bairro: object|null, cepInfo: object|null}>}
 */
export async function resolverBairro(bairros, texto, cep) {
  let bairro = texto ? buscarBairro(bairros, texto) : null;
  let cepInfo = null;
  if (!bairro && cep) {
    cepInfo = await consultarCep(cep);
    if (cepInfo?.bairro) bairro = buscarBairro(bairros, cepInfo.bairro);
  }
  return { bairro, cepInfo };
}

/**
 * Texto de erro devolvido pra Claude quando o bairro não foi reconhecido —
 * instrui o próximo passo em vez de mandar recusar o cliente.
 */
export function mensagemBairroNaoReconhecido(bairros, texto, cep, cepInfo) {
  const lista = bairros.map((b) => b.nome).join(', ');
  const infoCep = cep
    ? cepInfo
      ? ` O CEP ${cep} é do bairro "${cepInfo.bairro || '(sem bairro)'}", ${cepInfo.cidade}, que também não está na lista.`
      : ` O CEP ${cep} não foi encontrado.`
    : '';
  return (
    `Não reconheci o bairro "${texto || ''}" na lista de entrega.${infoCep} ` +
    'NÃO diga ao cliente que o bairro não existe, que não está na lista ou que não entregamos lá. ' +
    (cep
      ? 'Agora chame a ferramenta chamar_atendente (motivo: confirmar entrega no bairro informado) e diga ao cliente que a equipe vai confirmar a entrega por aqui.'
      : 'Peça o CEP ou um ponto de referência do endereço e chame esta ferramenta de novo com o campo "cep". Se o cliente não souber o CEP e pelo ponto de referência você não conseguir identificar um bairro da lista, chame chamar_atendente e diga que a equipe vai confirmar a entrega por aqui.') +
    ` Bairros cadastrados: ${lista}.`
  );
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
    const { bairros } = await getMenuData();
    const { bairro, cepInfo } = await resolverBairro(bairros, input.bairro, input.cep);
    if (bairro) {
      return { reconhecido: true, bairro: bairro.nome, frete: Number(bairro.frete) || 0 };
    }
    return { reconhecido: false, instrucao: mensagemBairroNaoReconhecido(bairros, input.bairro, input.cep, cepInfo) };
  };
}
