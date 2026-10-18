// Copia os dados da loja (whatsapp-bot/src/loja.js, a fonte única) pro site:
//  - schema.org (JSON-LD) das páginas públicas: endereço e "geo" (sem
//    coordenadas em loja.js, o "geo" é removido);
//  - endereço gravado no pedido de retirada lançado pelo admin.
// Uso, na raiz do repositório:  node whatsapp-bot/scripts/sincronizar-loja.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ENDERECO_LOJA, LOJA_RUA, LOJA_BAIRRO, LOJA_CIDADE, LOJA_UF, LOJA_CEP, LOJA_LAT, LOJA_LNG, lojaTemCoordenadas } from '../src/loja.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGINAS = [
  'index.html',
  'pizza-doce-lauro-de-freitas.html',
  'delivery-ipitanga.html',
  'delivery-pitangueiras.html',
  'delivery-vilas-do-atlantico.html',
];

function atualizarSchema(obj) {
  obj.address = {
    '@type': 'PostalAddress',
    streetAddress: `${LOJA_RUA} - ${LOJA_BAIRRO}`,
    addressLocality: LOJA_CIDADE,
    addressRegion: LOJA_UF,
    postalCode: LOJA_CEP,
    addressCountry: 'BR',
  };
  if (lojaTemCoordenadas()) obj.geo = { '@type': 'GeoCoordinates', latitude: LOJA_LAT, longitude: LOJA_LNG };
  else delete obj.geo;
  return obj;
}

let mudou = 0;
for (const pagina of PAGINAS) {
  const caminho = join(RAIZ, pagina);
  const html = readFileSync(caminho, 'utf8');
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  let blocos = 0;
  const novo = html.replace(/(<script type="application\/ld\+json">\s*)([\s\S]*?)(\s*<\/script>)/g, (inteiro, ini, json, fim) => {
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object' || !obj.address) return inteiro;
    blocos++;
    // Mantém a ordem das chaves: o "address" e o "geo" voltam no mesmo lugar.
    const atualizado = atualizarSchema({ ...obj });
    const ordenado = {};
    for (const k of Object.keys(obj)) {
      if (k === 'geo') continue;
      ordenado[k] = atualizado[k];
      if (k === 'address' && atualizado.geo) ordenado.geo = atualizado.geo;
    }
    // Arrays curtos de texto numa linha só (ex: "dayOfWeek": ["Thursday", "Sunday"]), como já estavam.
    const json2 = JSON.stringify(ordenado, null, 2).replace(/\[\n\s*((?:"[^"\n]*",\n\s*)*"[^"\n]*")\n\s*\]/g, (inteiro, itens) => {
      const curto = `[${itens.split(/,\n\s*/).join(', ')}]`;
      return curto.length <= 60 ? curto : inteiro;
    });
    // Mesmo final de linha do arquivo (no Windows o Git costuma deixar CRLF na cópia de trabalho).
    return `${ini}${eol === '\r\n' ? json2.replace(/\n/g, '\r\n') : json2}${fim}`;
  });
  if (!blocos) throw new Error(`${pagina}: nenhum bloco schema.org com "address" encontrado`);
  if (novo !== html) { writeFileSync(caminho, novo); mudou++; }
  console.log(`${pagina}: ${blocos} bloco(s) ${novo !== html ? 'atualizado(s)' : 'já em dia'}`);
}

const admin = join(RAIZ, 'admin.html');
const htmlAdmin = readFileSync(admin, 'utf8');
const novoAdmin = htmlAdmin.replace(/const ENDERECO_LOJA_MANUAL = '[^']*';/, `const ENDERECO_LOJA_MANUAL = '${ENDERECO_LOJA.replace(/'/g, "\\'")}';`);
if (novoAdmin === htmlAdmin && !htmlAdmin.includes(`const ENDERECO_LOJA_MANUAL = '${ENDERECO_LOJA}'`)) {
  throw new Error('admin.html: constante ENDERECO_LOJA_MANUAL não encontrada');
}
if (novoAdmin !== htmlAdmin) { writeFileSync(admin, novoAdmin); mudou++; }
console.log(`admin.html: ENDERECO_LOJA_MANUAL ${novoAdmin !== htmlAdmin ? 'atualizado' : 'já em dia'}`);
// index.html: endereço da retirada no checkout e no rodapé
const indexHtml = join(RAIZ, 'index.html');
const htmlIndex = readFileSync(indexHtml, 'utf8');
const rodape = `${LOJA_RUA}, ${LOJA_BAIRRO}, ${LOJA_CIDADE} - ${LOJA_UF}`;
let novoIndex = htmlIndex.replace(/const ENDERECO_LOJA_SITE = '[^']*';/, `const ENDERECO_LOJA_SITE = '${ENDERECO_LOJA.replace(/'/g, "\\'")}';`);
novoIndex = novoIndex.replace(/(<span id="footer-endereco">)[^<]*(<\/span>)/, `$1${rodape}$2`);
if (!/const ENDERECO_LOJA_SITE = '/.test(htmlIndex) || !/<span id="footer-endereco">/.test(htmlIndex)) {
  throw new Error('index.html: ENDERECO_LOJA_SITE ou <span id="footer-endereco"> não encontrado');
}
if (novoIndex !== htmlIndex) { writeFileSync(indexHtml, novoIndex); mudou++; }
console.log(`index.html: endereço do checkout/rodapé ${novoIndex !== htmlIndex ? 'atualizado' : 'já em dia'}`);

console.log(`\n${mudou} arquivo(s) alterado(s). Endereço: ${ENDERECO_LOJA} | coordenadas: ${lojaTemCoordenadas() ? `${LOJA_LAT}, ${LOJA_LNG}` : 'vazias (sem "geo")'}`);
