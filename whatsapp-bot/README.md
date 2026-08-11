# Big Bang Pizza — Bot de Atendimento via WhatsApp

Servidor Node.js que recebe mensagens do WhatsApp via **Evolution API** e responde
automaticamente usando a **Claude API** (Anthropic), com o cardápio, preços e
bairros de entrega puxados em tempo real do mesmo Supabase que alimenta o site
e o admin.

**Escopo desta versão:** responder dúvidas do cliente (cardápio, horário,
bairros atendidos) **e fechar o pedido inteiro dentro da própria conversa**
— itens, endereço, bairro (validado contra a área de entrega real) e forma
de pagamento (presencial, Pix ou cartão via link/Ton), gravando direto na
mesma tabela `pedidos` do site/admin. Cancelamento/edição de pedido ainda
não existe (só criação) — ver "Próximos passos".

## Como funciona

```
WhatsApp → Evolution API → POST /webhook → este servidor
                                              │
                              texto ──────────┤
                              áudio → Groq Whisper (transcreve) ──┤
                              imagem ─────────┤
                                              ↓
                                   Claude API (Anthropic, com tool use)
                                   system prompt montado com dados
                                   ao vivo do Supabase (cardápio/bairros/Pix)
                                              │
                              se o cliente confirmar o pedido:
                              Claude chama a tool `criar_pedido`
                                              ↓
                              src/orderTool.js revalida itens e bairro contra
                              o cardápio real, recalcula os preços (nunca
                              confia em número que a IA tenha dito) e grava
                              em `pedidos` (Supabase) com status "aguardando"
                                              │
                              pagamento "Cartão via link" → avisa o Gabriel
                              por WhatsApp pra gerar o link na Ton
                                              ↓
                              Evolution API (sendText) → WhatsApp do cliente
```

- O cardápio/bairros/config (incluindo a chave Pix) ficam em cache em
  memória por `MENU_CACHE_TTL_SECONDS` (padrão 5 min) — não bate no Supabase
  a cada mensagem, mas reflete alterações feitas no admin em poucos minutos,
  sem precisar reiniciar o bot.
- O histórico de conversa por número fica em memória (`HISTORY_MAX_MESSAGES`
  últimas mensagens) — some se o processo reiniciar. Ver "Próximos passos".
  Isso inclui o "rastro" de quando um pedido já foi criado na conversa, pra
  evitar que a Claude tente registrar o mesmo pedido duas vezes.

### Formas de pagamento

| Opção | O que acontece |
|---|---|
| Presencial | Só confirma e registra — dinheiro/cartão são acertados na entrega. |
| Pix | O bot informa a chave Pix (lida de `configuracoes.pix_chave`/`pix_titular` no Supabase — **não** fica em variável de ambiente nem em código, pra não versionar um dado financeiro real). Pedido é gravado com `pagamento: "Pix (aguardando pagamento)"`. |
| Cartão via link (Ton) | O bot avisa que o link chega em instantes, registra o pedido com `pagamento: "Cartão via link Ton (aguardando envio do link)"` e manda um WhatsApp pro número em `GABRIEL_WHATSAPP_NUMBER` com o resumo do pedido — o link em si é gerado manualmente no app da Ton, não é automatizado. |

Pra trocar/consultar a chave Pix, edite a tabela `configuracoes` no Supabase
(chaves `pix_chave` e `pix_titular`) — não precisa redeploy do bot, só
espera o cache expirar (ou reinicia o processo).

### Sobre a leitura/escrita no Supabase

O bot usa a mesma chave pública (`anon`/publishable) do site. A tabela
`pedidos` tem uma policy de RLS que permite **INSERT** anônimo (mesma usada
pelo checkout do site) mas **não** permite leitura (`SELECT`) anônima — é
proposital, protege dados de outros clientes. Por isso, depois de inserir um
pedido, o bot não lê a linha de volta diretamente: ele gera o
`rastreio_token` (UUID) antes de inserir e usa a função `rastrear_pedido`
(RPC do Postgres, a mesma que a página `rastreio.html` já usa) pra buscar o
`id` gerado de forma segura e pontual — sem precisar abrir uma policy de
SELECT geral em `pedidos`. Se algum dia mudar essa RPC no banco, revise
`src/supabaseData.js#inserirPedido`.

## Setup local (para testes)

Pré-requisitos: Node 18+, uma instância da Evolution API rodando (local ou
remota) com um número de WhatsApp conectado, uma chave da Claude API e uma
chave da Groq API.

```bash
cd whatsapp-bot
npm install
cp .env.example .env
# preencha o .env com as chaves reais
npm run dev
```

O servidor sobe em `http://localhost:3000`. Para a Evolution API (rodando em
outra máquina/container) conseguir chamar seu webhook local, exponha a porta
com um túnel, por exemplo [ngrok](https://ngrok.com/):

```bash
ngrok http 3000
```

### Configurar o webhook na Evolution API

Na configuração da instância (via Manager UI ou API), aponte o webhook para:

```
https://<sua-url>/webhook?secret=<o mesmo valor de WEBHOOK_SECRET no .env>
```

Habilite pelo menos o evento **MESSAGES_UPSERT**. Recomenda-se também ativar
a opção **`webhook_base64: true`** na instância — assim áudios e imagens já
chegam em base64 dentro do próprio webhook, sem precisar de uma chamada
extra à API para baixar a mídia (o bot já tem um fallback automático via
`getBase64FromMediaMessage` caso essa opção esteja desligada, mas é mais
lento).

## Transcrição de áudio — por que Groq Whisper

Comparado com outras opções (OpenAI Whisper, Google Speech-to-Text, Deepgram,
AWS Transcribe), a Groq foi a escolhida por:

- **Tier gratuito generoso**: cobre um volume alto de mensagens de voz por
  dia sem custo, difícil de estourar numa pizzaria de bairro.
- **Preço pago também muito baixo** quando o tier gratuito acaba, mais barato
  que a maioria das alternativas.
- **Qualidade**: roda o modelo Whisper (mesmo modelo usado pela OpenAI),
  com bom suporte a português do Brasil.
- **Velocidade**: infraestrutura da Groq é otimizada para latência baixa,
  importante pra não deixar o cliente esperando no WhatsApp.

Se preferir trocar, o único arquivo a mexer é `src/transcribe.js` — troque a
chamada HTTP pela API do provedor escolhido (a interface `transcreverAudio(buffer, mimetype)` continua igual para o resto do código).

## Deploy

Este projeto é um servidor Express simples (`npm start` roda `node src/server.js`)
— qualquer host que rode Node.js funciona. Duas opções simples que não exigem
configurar VPS do zero:

### Railway
1. Crie um novo projeto apontando para este repositório, com **root directory**
   `whatsapp-bot`.
2. Configure as variáveis de ambiente do `.env.example` nas Settings do projeto.
3. Railway detecta o `package.json` e roda `npm install && npm start`
   automaticamente. Pegue a URL pública gerada e use no webhook da Evolution API.

### Render
1. New → Web Service → conecte o repositório, definindo **Root Directory**
   como `whatsapp-bot`.
2. Build Command: `npm install` — Start Command: `npm start`.
3. Configure as variáveis de ambiente na aba Environment.
4. Use a URL `https://seu-servico.onrender.com/webhook?secret=...` no
   webhook da Evolution API.

Em ambos os casos, depois do deploy, teste primeiro `GET /health` (deve
retornar `{"ok":true}`) antes de configurar o webhook de verdade.

## Próximos passos (fora do escopo desta versão)

- Cancelamento/edição de pedido já criado pelo WhatsApp (hoje só existe
  criação — pra mudar ou cancelar, ainda precisa falar direto ou usar o
  admin).
- Persistir o histórico de conversa em banco (hoje é em memória e some a
  cada deploy/restart) — dá pra usar a própria tabela `contatos`/`pedidos`
  do Supabase ou um Redis, dependendo do volume. Isso também evitaria o
  cliente ter que recomeçar o pedido do zero se o servidor reiniciar no meio
  da conversa.
- Validação/normalização mais robusta do número de telefone (mesmo padrão
  já usado no admin.html, `normalizarWhatsapp`).
- Aplicar cupom de desconto pelo WhatsApp (hoje a tool `criar_pedido` sempre
  grava `cupom: null` — o site continua sendo a única forma de usar cupom).
