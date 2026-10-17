// Dados da loja física — fonte ÚNICA do endereço e da localização.
// Usada pelo bot (endereço que a Luiza informa, endereço gravado no pedido de
// retirada, localização enviada no WhatsApp) e copiada pro site pelo script
// whatsapp-bot/scripts/sincronizar-loja.mjs (schema.org das páginas e o
// endereço do pedido manual no admin.html). Mudou algo aqui? Rode o script.

export const LOJA_NOME = 'Big Bang Pizza';
export const LOJA_RUA = 'Av. Amarílio Thiago dos Santos, 1152, sala 03';
export const LOJA_BAIRRO = 'Vila Praiana';
export const LOJA_CIDADE = 'Lauro de Freitas';
export const LOJA_UF = 'BA';
export const LOJA_CEP = '42704-550';

// Pin da loja no Google Maps (ex: -12.9012, -38.3101). Enquanto estiverem
// vazias (null), o bot manda um link do Google Maps montado pelo endereço em
// texto e o schema.org do site fica sem "geo".
export const LOJA_LAT = null;
export const LOJA_LNG = null;

export const ENDERECO_LOJA = `${LOJA_RUA} - ${LOJA_BAIRRO}, ${LOJA_CIDADE} - ${LOJA_UF}, CEP ${LOJA_CEP}`;

export function lojaTemCoordenadas() {
  return Number.isFinite(LOJA_LAT) && Number.isFinite(LOJA_LNG);
}

export function linkMapsLoja() {
  const destino = lojaTemCoordenadas() ? `${LOJA_LAT},${LOJA_LNG}` : ENDERECO_LOJA;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destino)}`;
}
