# Big Bang Pizza — Bot de Atendimento via WhatsApp

Servidor Node.js que recebe mensagens do WhatsApp via **Evolution API** e responde
automaticamente usando a **Claude API** (Anthropic), com o cardápio, preços e
bairros de entrega puxados em tempo real do mesmo Supabase que alimenta o site
e o admin.

**Escopo desta versão:** responder dúvidas do cliente (cardápio, horário,
bairros atendidos), **fechar o pedido inteiro dentro da própria conversa**
— itens, endereço, bairro (validado contra a área de entrega real) e forma
de pagamento (presencial, Pix ou cartão via link/Ton), gravando direto na
mesma tabela `pedidos` do site/admin —, **cancelar** e **editar** o pedido
mais recente (item, bairro/endereço, forma de pagamento), sempre só
enquanto a cozinha ainda não tiver aceitado (ver "Cancelamento e edição de
pedido" abaixo). Aplicar cupom de desconto pelo WhatsApp ainda não existe —
ver "Próximos passos".

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
                                              │
                              se o cliente pedir cancelamento:
                              Claude chama a tool `cancelar_pedido`
                                              ↓
                              src/cancelOrderTool.js confere o status atual
                              (nunca cache) e só cancela se ainda estiver
                              "aguardando" — escrita atômica condicional
                                              │
                              se o cliente quiser corrigir algo (bairro
                              errado, trocar item, forma de pagamento):
                              Claude chama a tool `editar_pedido`
                                              ↓
                              src/editOrderTool.js revalida só os campos que
                              mudaram, recalcula subtotal/frete/total e
                              grava com a mesma escrita atômica condicional
                                              ↓
                              Evolution API (sendText) → WhatsApp do cliente
```

- O cardápio/bairros/config (incluindo a chave Pix) ficam em cache em
  memória por `MENU_CACHE_TTL_SECONDS` (padrão 5 min) — não bate no Supabase
  a cada mensagem, mas reflete alterações feitas no admin em poucos minutos,
  sem precisar reiniciar o bot.
- O histórico de conversa por número (`HISTORY_MAX_MESSAGES` últimas
  mensagens) é persistido no Redis — sobrevive a um redeploy/restart do bot
  no meio de uma conversa. Ver "Histórico de conversa (Redis)" abaixo. Isso
  inclui o "rastro" de quando um pedido já foi criado na conversa, pra
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

## Histórico de conversa (Redis)

`src/historicoRedis.js` guarda o histórico de cada conversa (por telefone)
no Redis já provisionado no Railway junto com a Evolution API, em vez de só
num `Map` em memória — antes, um redeploy ou crash do bot no meio de uma
conversa apagava o contexto e o cliente tinha que recomeçar do zero.

- **Leitura**: a cada mensagem recebida, `server.js` busca o histórico
  desse telefone com `obterHistorico(numero)` antes de chamar a Claude.
- **Escrita**: depois de anexar a mensagem do cliente E depois de anexar a
  resposta da Claude — duas escritas por mensagem recebida, não uma —
  `salvarHistorico(numero, historico)` grava o array inteiro de novo (já
  cortado em `HISTORY_MAX_MESSAGES` mensagens). Persistir a mensagem do
  cliente **antes** de chamar a Claude é proposital: se a chamada à Claude
  falhar por qualquer motivo, o que o cliente disse não se perde.
- **TTL**: 24h, renovado a cada escrita (`SET ... EX 86400`) — dá folga de
  sobra pra sobreviver a um restart no meio de uma conversa ativa, sem
  guardar histórico de clientes inativos indefinidamente.
- **Namespace**: chaves `bbpizza:conversa:<telefone>` — prefixo deliberado
  porque esse Redis é compartilhado com a própria Evolution API (que guarda
  sessão/cache dela ali também).

**Degradação graciosa:** se `REDIS_URL` não estiver configurada, ou se
qualquer operação de leitura/escrita falhar (Redis fora do ar, timeout,
credencial errada), `historicoRedis.js` nunca lança erro — só loga e
retorna `null`/não faz nada. `server.js` mantém um `Map` local
(`historicoLocal`) como fallback: sempre que o Redis não devolve nada, cai
pra esse `Map`; sempre que salva, grava nos dois lugares. Na prática:
- Sem `REDIS_URL`: funciona 100% em memória, igual ao comportamento antigo
  (histórico some a cada restart).
- Com `REDIS_URL` mas o Redis cai no meio da operação: continua atendendo
  normalmente, só perde a persistência entre restarts enquanto durar a
  instabilidade — nunca quebra uma conversa em andamento.

**Como configurar no Railway:** o Redis precisa já existir como serviço no
mesmo projeto (o mesmo provisionado junto com a Evolution API). No serviço
**whatsapp-bot** → aba *Variables*, adicione `REDIS_URL` como uma
"Variable Reference" apontando pro serviço Redis (algo como
`${{Redis.REDIS_URL}}` — o nome exato da variável de referência aparece na
aba *Variables* do próprio serviço Redis, pode copiar de lá). Não precisa
redeploy manual: o Railway reinicia o serviço sozinho quando uma variável
muda.

Testado simulando um restart de processo (nova instância do cliente Redis,
mesma conexão) no meio de uma conversa multi-turno — o histórico salvo pela
"instância antiga" foi lido corretamente pela "instância nova"; também
testados os dois caminhos de degradação graciosa (sem `REDIS_URL`, e com
erro em toda operação) sem lançar exceção em nenhum dos dois.

## Cancelamento e edição de pedido

`src/pedidoStatusUtil.js` reúne o que as duas tools abaixo têm em comum:
achar "o pedido mais recente do cliente que está conversando" (por telefone
normalizado, dentro de uma janela de 12h — mesma lógica de
`abandonedCartJob.js`/`reactivationJob.js` pra lidar com `pedidos.whatsapp`
vindo em formatos diferentes conforme a origem: bot grava já normalizado,
site grava o texto livre digitado no checkout) e a mensagem fixa de recusa
quando o pedido já saiu de `aguardando`.

### Cancelamento

Quando o cliente pede pra cancelar de vez, Claude chama a tool
`cancelar_pedido` (sem parâmetros). `src/cancelOrderTool.js`:

1. Busca, com a service_role key, o pedido mais recente desse telefone.
2. Se não achar nada, ou se já estiver `cancelado`, devolve pro Claude uma
   mensagem de erro simples pra explicar ao cliente.
3. Se o status lido for diferente de `aguardando` (`aceito_preparando`,
   `saiu`, `entregue`), recusa e devolve a mensagem fixa "seu pedido já
   entrou em produção..." com o WhatsApp da loja (lido de
   `configuracoes.info_whatsapp`) — o Claude é instruído a repassar esse
   texto literalmente, sem reformular.
4. Se ainda estava `aguardando` na leitura, tenta cancelar de verdade.

### Edição

Quando o cliente quer CORRIGIR algo em vez de desistir do pedido (bairro
errado, trocar um item, mudar forma de pagamento), Claude chama a tool
`editar_pedido` com só os campos que mudaram — o que não vier é mantido
como estava. `src/editOrderTool.js`:

1. Mesma busca/checagem de status do cancelamento (passos 1-3 acima; a
   mensagem de recusa troca só o verbo, "editar" em vez de "cancelar").
2. Revalida contra o cardápio/bairros reais só o que mudou — reaproveita
   `processarItens`/`buscarPorNome` de `orderTool.js` (a mesma validação e
   precificação usada pra criar um pedido, sem duplicar a lógica).
   - `itens`, se enviado, precisa ser a lista COMPLETA e final (não é
     incremental) — Claude é instruído a mandar todos os itens, já com a
     troca aplicada, mesmo que só 1 tenha mudado.
   - `bairro`, se enviado, recalcula o frete a partir do valor real
     cadastrado (nunca aceita um frete que a IA tenha dito).
3. Recalcula `subtotal`/`frete`/`total` a partir do que mudou (o que não
   mudou usa o valor que já estava salvo no pedido). Cupom/desconto não são
   recalculados — ficam pelo valor absoluto já aplicado antes da edição
   (fora do escopo desta versão; ver "Próximos passos").
4. Se ainda estava `aguardando` na leitura, tenta gravar a edição de
   verdade — tudo de uma vez (um único UPDATE), nunca campo por campo.

**Sobre a corrida cliente-mexe-no-pedido vs. cozinha-aceita:** tanto o passo
4 do cancelamento quanto o passo 4 da edição NÃO são "leu aguardando, então
escreve" — isso deixaria uma brecha entre a leitura e a escrita onde a
cozinha poderia aceitar o pedido bem no meio. Em vez disso, a escrita em si
já é condicional (`atualizarComoAdminSeStatus`, em `supabaseAdmin.js`): um
único `UPDATE ... WHERE id = X AND status = 'aguardando'` atômico no
Postgres — no cancelamento, `{status: 'cancelado'}`; na edição, o patch
inteiro (itens/bairro/frete/endereço/pagamento/total) num só UPDATE, nunca
campo por campo. Se a cozinha aceitar um instante antes dessa escrita, o
UPDATE não afeta nenhuma linha — e é esse resultado (zero linhas) que
decide se a ação aconteceu, não o valor lido antes; o pedido fica
exatamente como estava, sem aplicação parcial. Testado direto no banco nos
dois fluxos (cancelamento e edição) simulando as duas ordens de chegada
(aceitar-depois-de-mexer e mexer-depois-de-aceitar); no primeiro caso a
ação é corretamente recusada e o pedido continua com os dados antigos e
status `aceito_preparando`.

**A corrida na direção oposta também está fechada.** O admin.html (dropdown
do kanban, botão "Aceitar e Preparar" do modo Cozinha, swipe no card mobile)
agora usa o mesmo padrão atômico: `updSeStatus()` em admin.html manda um
`PATCH /pedidos?id=eq.X&status=eq.<esperado>` (reaproveitando
`statusFiltroQuery`, que já tratava os aliases legados `aceito`/`preparando`
pra leitura) em vez do `upd()` incondicional. Se a linha não bater mais com
o status que aquela tela achava que o pedido tinha — por exemplo, o cliente
cancelou pelo bot um instante antes de alguém clicar "Aceitar e Preparar"
numa tela desatualizada — o UPDATE não afeta nenhuma linha, a interface
mostra um toast explicando o que aconteceu ("Este pedido já foi cancelado
pelo cliente...") e recarrega a lista de pedidos automaticamente, sem
aplicar a mudança que o clique pretendia fazer. Testado e confirmado no
banco, nas duas direções da corrida e no caso de alias legado.

Toda tentativa de cancelamento ou edição (bem-sucedida ou recusada, em
qualquer um dos motivos acima) é logada no console do servidor com o id do
pedido, o telefone e o resultado — grep por `[cancelamento]` ou `[edicao]`
nos logs do Railway pra auditar.

## Reativação automática de clientes "em risco"

`src/reactivationJob.js` roda a cada hora (via `node-cron`, agendado em
`server.js`) mas só executa de verdade quando o dia da semana e a hora
batem com o configurado na aba **Configurações do Bot** do admin.html
(padrão: todos os dias às 15h — horário de Lauro de Freitas/BA, antes da
loja abrir às 18h). Rodar a cada hora e checar dia/hora por dentro — em vez
de agendar direto no horário certo — é o que permite mudar isso pelo admin
e ver efeito já na próxima hora, sem precisar reiniciar o bot (ver
"Configurações do Bot" abaixo). Quando a janela bate:

1. Busca, direto no Supabase, quem está a **15-21 dias sem pedido** (a
   mesma regra de "em risco" do admin.html, mas numa janela — não o dia 15
   cravado — pra tolerar o cron eventualmente não rodar numa hora sem
   deixar de notificar quem entrou em risco naquela semana).
2. Pula quem já recebeu uma reativação (manual ou automática) nos últimos
   30 dias — consulta a tabela `reativacoes_enviadas`.
3. Envia a mensagem via **Evolution API direto** (não é um link `wa.me`
   manual), com o código do cupom e o percentual configurados no admin
   (padrão `VOLTEI10` / 10%), e registra o envio em `reativacoes_enviadas`
   com `origem: 'automatico'`.
4. Erro num cliente (WhatsApp inválido, falha pontual da Evolution API
   etc.) é logado e não interrompe os demais.

O botão manual de reativação no admin.html continua existindo (pra mandar
antes das 15h ou pra um cliente específico) e agora também grava em
`reativacoes_enviadas` (`origem: 'manual'`) — as duas origens compartilham a
mesma janela de 30 dias de "não repetir", e o admin mostra um aviso de
quando a última reativação (de qualquer origem) foi enviada.

**Essa rotina exige a `SUPABASE_SERVICE_ROLE_KEY`** (ver `.env.example`) —
sem ela, o cron simplesmente não é agendado (log de aviso na subida do
servidor), o resto do bot continua funcionando normal. Junto com as duas
rotinas abaixo, são as únicas partes do projeto que usam essa chave
privilegiada; todo o resto (webhook, pedidos) usa a chave pública, de
propósito, pra manter o blast radius pequeno.

## Alertas em tempo real para o Gabriel (pedido atrasado / avaliação ruim)

Duas rotinas periódicas — mesma infra de `node-cron`, mesmo motivo de
escolha (o projeto inteiro já é construído em cima de polling: o site
reconsulta `modo_loja` a cada 30s, o admin repolla `pedidos` a cada 30s;
criar um Database Webhook do Supabase só pra isso adicionaria uma peça de
infraestrutura nova fora do repositório, com endpoint público próprio, só
pra trocar "a cada alguns minutos" por "instantâneo" — não compensa aqui):

- **`delayedOrdersJob.js`** — a cada 10 min, verifica pedidos em
  `aguardando`/`aceito_preparando` há mais do que o limite configurado
  (padrão 40 min) e avisa o Gabriel. Marca
  `pedidos.alerta_atraso_enviado = true` depois de avisar, pra não repetir
  o alerta do mesmo pedido a cada execução.
- **`badReviewsJob.js`** — a cada 5 min, verifica avaliações com nota ≤ 3
  ainda não avisadas e manda o resumo pro Gabriel. Marca
  `avaliacoes.alerta_enviado = true` depois de avisar.

O número que recebe os dois alertas (e o de "Cartão via link Ton", ver
diagrama acima) e o limite de minutos de `delayedOrdersJob.js` são lidos da
aba **Configurações do Bot** do admin.html a cada execução, com fallback
pras variáveis de ambiente `GABRIEL_WHATSAPP_NUMBER` / `PEDIDO_ATRASO_MINUTOS`
enquanto os campos não são preenchidos por lá (ver "Configurações do Bot"
abaixo).

Como as duas rotinas usam a service_role key (única forma de ler `pedidos`
fora do checkout público, e de marcar `avaliacoes` como já avisada — essa
tabela tem leitura pública mas não permite UPDATE anônimo), elas seguem a
mesma regra das outras: sem `SUPABASE_SERVICE_ROLE_KEY`, os crons não são
agendados e o resto do bot continua normal.

## Recuperação de carrinho abandonado

O checkout do site grava um registro em `carrinhos_abandonados` (INSERT
anônimo, mesma policy de `pedidos`/`contatos`) assim que o cliente digita um
WhatsApp válido no campo opcional do formulário — esse é o único ponto do
fluxo em que o telefone fica disponível antes de o pedido ser finalizado
(o campo só é lido de novo, pra valer, no clique de "Enviar pelo WhatsApp").

`src/abandonedCartJob.js` roda a cada 10 min (mesma infra de `node-cron`) e,
pra cada carrinho ainda não convertido/expirado:

1. Cruza o telefone com `pedidos.whatsapp` — se já existe um pedido
   concluído (pelo site ou pelo bot) criado depois do carrinho, marca
   `convertido_em` e não manda nada.
2. Se passou de 24h sem converter, marca `expirado = true` (fica no banco,
   só para de contar como pendente).
3. Se passou de `ABANDONED_CART_MINUTOS` (padrão 25, ajustável no `.env`) e
   ainda não foi notificado, manda a mensagem de recuperação via
   **Evolution API direto** e marca `notificado_em` — uma única vez por
   carrinho.

Mesma regra das outras rotinas: exige `SUPABASE_SERVICE_ROLE_KEY`, sem ela o
cron não é agendado.

## Configurações do Bot (aba no admin.html)

A aba **"Configurações do Bot"** do admin.html edita, direto na tabela
`configuracoes` do Supabase (a mesma que já guarda `modo_loja`, cores do
site etc.), os valores operacionais que antes só davam pra mudar editando
`.env` no Railway e fazendo redeploy:

| Chave (`configuracoes.chave`)   | Usado em                          | Padrão (se vazio)              |
|----------------------------------|------------------------------------|---------------------------------|
| `pix_chave` / `pix_titular`      | `systemPrompt.js` (mensagem de pagamento Pix) | — (avisa "vai confirmar em instantes") |
| `alerta_whatsapp_numero`         | `delayedOrdersJob.js`, `badReviewsJob.js`, `orderTool.js` (link Ton) | `GABRIEL_WHATSAPP_NUMBER` (env) |
| `pedido_atraso_minutos`          | `delayedOrdersJob.js`              | `PEDIDO_ATRASO_MINUTOS` (env, 40) |
| `reativacao_dias_semana`         | `reactivationJob.js`               | todos os dias (`0,1,2,3,4,5,6`) |
| `reativacao_hora`                | `reactivationJob.js`               | `15` (15h)                      |
| `reativacao_cupom_codigo`        | `reactivationJob.js` (texto da mensagem) | `VOLTEI10`                |
| `reativacao_cupom_percentual`    | `reactivationJob.js` (texto da mensagem) | `10`                       |

Duas leituras diferentes, cada uma pelo caminho já usado por quem consome o
dado (nenhuma rotina nova de acesso ao banco foi criada pra isso):

- **`pix_chave`/`pix_titular`/`alerta_whatsapp_numero` no fluxo do webhook**
  (`systemPrompt.js`, `orderTool.js`) — via `getMenuData()`
  (`supabaseData.js`), chave pública (`anon`), já cacheada por
  `MENU_CACHE_TTL_SECONDS`. A tabela `configuracoes` tem `SELECT` público
  (é assim que o site lê `modo_loja`/cores/etc.), então não precisa de
  privilégio nenhum extra — mantém o webhook só com a chave pública, de
  propósito (ver "Sobre a leitura/escrita no Supabase" abaixo).
- **Todo o resto, nas rotinas agendadas** (`delayedOrdersJob.js`,
  `badReviewsJob.js`, `reactivationJob.js`) — via `src/botConfig.js`
  (`obterConfigBotAdmin()`), que lê a tabela inteira com a service_role key
  (`supabaseAdmin.js`) a cada execução do cron e já resolve os fallbacks da
  tabela acima. Essas rotinas já usam a service_role pra outras coisas
  (ler `pedidos`, marcar `avaliacoes` como avisada etc.), então não é
  privilégio novo — só mais uma leitura na mesma chamada.

Nenhum campo é obrigatório: enquanto a aba não é preenchida, tudo continua
funcionando exatamente como antes (valores da coluna "Padrão" acima). As
chaves de API (Claude, Evolution, Supabase) **não** estão nessa aba —
continuam só nas variáveis de ambiente do Railway, por segurança.

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

- Edição de pedido depois que a cozinha já aceitou (`aceito_preparando`,
  `saiu`, `entregue`) — hoje só dá pra editar/cancelar enquanto ainda está
  `aguardando`; depois disso só falando direto com a loja/usando o admin.
- Recalcular cupom/desconto ao editar itens de um pedido que já tinha cupom
  aplicado — hoje `editar_pedido` mantém o valor absoluto do desconto
  original mesmo se o subtotal mudar (ex: cupom percentual não é
  reajustado pro novo valor).
- Validação/normalização mais robusta do número de telefone (mesmo padrão
  já usado no admin.html, `normalizarWhatsapp`).
- Aplicar cupom de desconto pelo WhatsApp (hoje `criar_pedido` sempre grava
  `cupom: null`, e `editar_pedido` nunca mexe em cupom/desconto — o site
  continua sendo a única forma de usar cupom).
