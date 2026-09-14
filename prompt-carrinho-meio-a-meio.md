# Prompt para Claude Code — Correção do fluxo de pizza meio a meio

## Contexto do projeto

Site: https://bigbangpizza.github.io/bigbangpizza
Admin: https://bigbangpizza.github.io/bigbangpizza/admin.html
Repositório: bigbangpizza/bigbangpizza
Backend: Supabase (alvvkpuedwrxbmkkayff.supabase.co)

## Problema atual

O modal de "Pizza meio a meio" permite selecionar sabores de tamanhos diferentes na mesma pizza (ex: 1ª metade Grande + 2ª metade Família), o que é uma inconsistência grave de cardápio. Além disso, o preço final não reflete corretamente a combinação dos dois sabores.

## Objetivo

Reestruturar o fluxo de seleção de sabor e cálculo de preço, seguindo exatamente a especificação abaixo.

---

## 1. Estrutura de botões no card do produto

No card de cada pizza, substituir o fluxo atual (selecionar tamanho → clicar "+ Adicionar") por dois botões diretamente clicáveis, sem etapa de seleção prévia:
- Cada botão já mostra o preço daquele sabor específico naquele tamanho (preço individual, não é preço de combinação).
- Clicar em qualquer um dos dois botões abre diretamente o modal de seleção de sabores correspondente àquele tamanho. Não precisa de um passo intermediário de "selecionar tamanho" separado.

## 2. Modal de seleção de sabores (por tamanho)

Ao clicar em **Grande**: abre modal mostrando **somente** os sabores disponíveis no tamanho Grande. Sabores exclusivos de Família não aparecem nesse modal.

Ao clicar em **Família**: abre modal mostrando **somente** os sabores disponíveis no tamanho Família. Sabores exclusivos de Grande não aparecem nesse modal.

Dentro do modal:
- Opção "1 sabor" (pizza inteira de um sabor só) ou "Meio a meio" (2 sabores).
- Quando "Meio a meio" é selecionado, exibir dois seletores: "1ª metade" e "2ª metade", ambos filtrados apenas pelos sabores do tamanho já escolhido (não repetir a pergunta de tamanho, ela já foi respondida ao clicar no botão).
- Não é possível, em nenhuma hipótese, misturar sabores de tamanhos diferentes no mesmo item. O tamanho é fixado no momento do clique no botão (Grande ou Família) e vale para as duas metades.

## 3. Regra de cálculo de preço — Opção 2 (soma das metades)

Cada sabor tem um preço individual próprio, cadastrado por tamanho (Grande e Família), correspondente ao preço da pizza inteira daquele sabor.

**Fórmula para pizza meio a meio:**Exemplo:
- Sabor 1 (Grande) = R$ 50,00 → metade = R$ 25,00
- Sabor 2 (Grande) = R$ 60,00 → metade = R$ 30,00
- **Total do item = R$ 55,00**

Regras adicionais:
- Se o cliente escolher "1 sabor" (pizza inteira), o preço é o valor integral cadastrado daquele sabor no tamanho escolhido, sem divisão.
- O preço deve recalcular em tempo real no modal conforme o cliente troca qualquer uma das duas metades, antes de confirmar.
- Exibir o preço já calculado (não mostrar "R$ 25,00 + R$ 30,00" separado) — mostrar apenas o total: "R$ 55,00".
- Arredondar para 2 casas decimais, padrão R$ 0,00.

## 4. Estrutura de dados esperada (Supabase)

Cada sabor de pizza deve ter preço individual por tamanho. Estrutura sugerida na tabela de sabores/produtos:- Cada item tem botão de remoção individual (ícone de lixeira), sem precisar excluir o pedido inteiro.
- Cliente pode adicionar novos itens ao carrinho sem perder os já adicionados.
- Total do pedido atualiza automaticamente a cada remoção ou adição.
- Manter o carrinho persistente durante a sessão (não resetar ao navegar entre páginas do cardápio).

## 7. Botão "Finalizar pedido"

Ao clicar em "Finalizar pedido" no carrinho, abrir a aba/modal de finalização de compra já existente no site (formulário de nome, endereço, bairro, forma de pagamento e campo de cupom de desconto). Não recriar essa etapa, apenas conectar o botão do carrinho a ela.

- O carrinho, com todos os itens, tamanhos, sabores e preços corretos, deve ser passado para essa etapa de finalização sem perda de dados.
- O campo de cupom (ex: BIGBANG15) deve aplicar o desconto sobre o total já calculado do carrinho.

## 8. Validações obrigatórias

- Impedir a finalização do modal de sabor sem pelo menos 1 sabor selecionado.
- Impedir seleção do mesmo sabor duas vezes no meio a meio (1ª e 2ª metade não podem ser iguais) — se ocorrer, mostrar aviso e sugerir trocar para "1 sabor".
- Garantir que, ao editar um item já no carrinho, o modal reabra já filtrado pelo tamanho original daquele item, mantendo a mesma regra de não misturar tamanhos.

## 9. Escopo técnico

- Aplicar a mudança em todos os produtos do tipo "pizza" que hoje têm opção de meio a meio no cardápio (salgadas e doces).
- Não alterar produtos sem opção de meio a meio (bebidas, combos fechados).
- Manter compatibilidade com o admin panel: o cálculo de preço no admin (relatórios financeiros, CMV) deve refletir a mesma lógica de soma das metades para pedidos meio a meio.
- Testar o fluxo completo: card → modal Grande → meio a meio → carrinho → remover item → finalizar → WhatsApp, e repetir o mesmo teste para Família.

## 10. Resultado esperado

Nunca mais deve ser possível montar uma pizza combinando Grande com Família na mesma unidade. O preço de toda pizza meio a meio deve refletir exatamente a soma proporcional dos dois sabores escolhidos, sem exceção.