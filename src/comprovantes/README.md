# Módulo de comprovantes (gastos)

Comprovante mandado no grupo vira gasto **pendente de aprovação** no
NovaGestão Obras. Fala pela mesma conexão de WhatsApp/Telegram do robô — um
número aceita uma conexão só, por isso é uma pasta e não um serviço à parte.

O resto do robô (`server.js`, `baileys.js`) importa **só** `index.js`.
A única exceção é `ia-documento.js` (recrutamento), que usa
`modelosDeVisao` de `ia-visao.js`.

Regras que valem aqui: o que a pessoa digitou ganha da IA; nada vira despesa
sem aprovação humana.

## O que é cada arquivo

| Arquivo | O que faz |
|---|---|
| `index.js` | Ponto de entrada. Só reexporta o que o resto do robô usa. |
| `entrada.js` | `tratar(msg)`: recebe a mensagem, guarda o comprovante e decide o caminho. Tem a visão geral do módulo no cabeçalho e o diagnóstico (`situacao`). |
| `autorizacao.js` | Quem pode lançar e de onde a mensagem pode vir (`GASTOS_AUTORIZADOS`, `GASTOS_GRUPOS`, o coringa `*`). É segurança. |
| `conversa.js` | Texto sem arquivo: resposta a uma pergunta, legenda atrasada, `pendentes`, `cancelar tudo`, `ping`. |
| `perguntas.js` | Monta as perguntas (obra, valor, confirmação do valor lido, quem pagou) e lê a resposta de "quem pagou?". |
| `processar.js` | O miolo: junta o escrito com o lido da imagem e decide — lança, pergunta ou caixa. Guarda o que está em andamento. |
| `duplicata.js` | Decide se o comprovante já foi lançado: mesmo arquivo, mesmo documento, ou mesma obra e valor. Funções puras. |
| `atraso.js` | A leitura do grupo antigo: ensaio, execução em lotes, retomada e as rotas HTTP. |
| `exportacao.js` | Lê a conversa exportada do WhatsApp (Android e iPhone) e acha os comprovantes. |
| `zip.js` | Leitor de zip mínimo, que trata o arquivo como dado de fora — e o gerador do zip do leitor pela conta. |
| `leitor-conta.js` | Lê o grupo antigo pela conta do dono (aparelho conectado) e monta um zip igual ao da exportação. Só lê. Usado por `scripts/ler-grupo-pela-conta.js`, fora do robô. |
| `correcao.js` | Corrigir ou cancelar pelo grupo um gasto já lançado, citando o comprovante ou a confirmação. |
| `habito.js` | De qual obra e categoria costuma ser cada fornecedor. Só sugere — nunca lança. Funções puras. |
| `a-pagar.js` | Decide se o documento é pagamento feito ou conta a pagar (boleto, orçamento, nota a prazo). Funções puras. |
| `leitura.js` | O grupo só de leitura: lê os comprovantes de um grupo onde o robô não fala, e pergunta/confirma em outro lugar. |
| `saida.js` | Lança o gasto pendente no Obras, ou manda para a caixa de comprovantes. |
| `ronda.js` | O lembrete (uma vez, 3 h) e o prazo (24 h → caixa). Liga no arranque. |
| `formato.js` | Como valor, data e item aparecem nas mensagens. |
| `lancamento.js` | Lê a linha que a pessoa escreve: obra, descrição, tipo, valor, data, quem pagou. |
| `ia-visao.js` | Lê a imagem do comprovante e confere o que o modelo diz ter lido. |
| `obras-client.js` | Fala com o NovaGestão Obras (lançar, caixa, lista de obras e sócios, consulta do que já foi lançado). |
| `memoria.js` | O que já foi lançado (com nº do documento e impressão digital do arquivo) e os apelidos de obra aprendidos (`dados/memoria-gastos.json`). |
| `pendentes.js` | Comprovantes esperando resposta, em disco (`dados/pendentes/`). Calcula a impressão digital (sha256) de cada arquivo. |
| `resumo-diario.js` | O fechamento do dia no grupo (desligado por padrão). |

Os testes ficam em `tests/`, com os demais: `teste-gastos.js`, `teste-legendas-reais.js`,
`teste-conversa-gastos.js`, `teste-conversa-pagador.js`, `teste-duplicata.js`, `teste-data-comprovante.js`, `teste-confirmar-valor.js`, `teste-atraso.js`, `teste-quem-mandou.js`, `teste-correcao.js`, `teste-habito.js`, `teste-a-pagar.js`, `teste-leitor-conta.js`, `teste-grupo-leitura.js`,
`teste-lancamento.js`, `teste-obras.js`, `teste-pendentes.js`.

## Como ele lê a legenda

Medido em 24/11/2026 contra as 243 legendas reais do grupo antigo — é assim
que a equipe escreve: a **cidade** ("Material Bastos", "Marmitas Pereiras"),
a **pessoa** ("Vale Rogério") e o **tipo** em poucas palavras.

- **Obra pela cidade.** De cada obra contam o que é só dela no nome
  ("toschi", "tsuya") e a **cidade** — o campo `municipio` do sistema, quando
  vier, ou o fim do endereço ("…, Bastos - SP"). A rua e o bairro não contam:
  "brita" achava a rua "Benedito Brito".
- **Nome de gente não é obra.** Escola tem nome de gente ("Oswaldo Luiz",
  "Francisco Pereira"), e "Vale Luiz" ia para a escola. Nomes e sobrenomes
  comuns não valem como apelido; se a legenda só traz a pessoa, ele pergunta.
- **Erro de digitação**, só com a mesma primeira letra, e nunca quando a
  palavra escrita já é outra conhecida: "tsuia" é a Tsuya, mas "guia" (do
  FGTS) não é "Águia".
- **Cidade com duas obras** (Bastos): pergunta só entre as duas.
- **Tipo** pela palavra exata, com o vocabulário da obra: "vale", "pgto",
  "demissão" (mão de obra), "condução", "vale transporte" (transporte),
  "FGTS", "guia", "internet" (outro), "concreto", "gesso", "ferragem"
  (material), "marmita", "mistura", "restaurante" (alimentação). Palavra
  genérica de pagamento perde para a específica ("Pgto hotel" é hospedagem);
  entre duas específicas, vale a primeira da frase.
- **A pergunta da obra** vem numerada e com a cidade de cada uma; dá para
  responder o número ("2"), o número e o valor ("2 150"), a obra ou a cidade.

## Comprovante repetido

Cada comprovante é comparado com o que o robô lembra de ter lançado e com o
que o Obras diz que está lançado (`GET /api/comprovantes/lancados`, que
inclui o que foi digitado à mão). Gasto rejeitado não conta.

| Situação | O que o robô faz |
|---|---|
| Mesmo arquivo (sha256 igual) de um gasto lançado | Avisa que já entrou e **não lança**. Não pergunta. |
| Mesmo nº de documento e mesmo valor (em qualquer obra) | Pergunta "é outro ou é o mesmo?". |
| Mesma obra e mesmo valor, documentos **diferentes** nos dois | Lança sem perguntar — são dois pagamentos. |
| Mesma obra e mesmo valor, sem documento em algum dos lados | Pergunta, como sempre. |
| Gasto digitado à mão no sistema (sem documento nem arquivo), mesma obra e valor | Pergunta só se a data estiver a até 3 dias do envio ou da data lida no papel. |

Descartar continua exigindo a pessoa dizer *mesmo*; a única exceção é o
arquivo idêntico. O que foi só para a **caixa** não barra: mandar de novo com
a legenda certa é o conserto.

O robô manda `documento` e `arquivoHash` no `/lancar` e na caixa. O documento
vai sempre numa forma só (maiúsculas, só letra e número, sem zeros à
esquerda; com menos de 4 caracteres não vai), porque o Obras compara letra
por letra. Todo `/lancar` leva o id da mensagem como `Idempotency-Key`. Com o
Obras em versão anterior nada quebra: 404 na consulta = compara só com a
memória; 400 nos campos novos = lança de novo sem eles.

## Quem mandou (reembolso)

O robô manda ao Obras, em `enviadoPor`, o telefone de quem enviou a mensagem
(só dígitos, com 55), no `/lancar` e na caixa. O sistema procura o usuário
que tem esse WhatsApp cadastrado e devolve o nome.

Só vai telefone **de verdade**. Em grupo o WhatsApp pode esconder o número
atrás de um `@lid`; quando o robô não consegue traduzi-lo, não manda nada —
os dígitos de um lid parecem telefone e não são de ninguém. O atraso (grupo
antigo) também não manda: lá o remetente é um nome da conversa exportada.

Quando o gasto ficou reembolsável (nem a empresa pagou, nem um sócio):

| O sistema respondeu | Linha na confirmação |
|---|---|
| o nome de quem mandou | "reembolso para Fulano" |
| que não conhece o número | aviso de que o número não está cadastrado e o reembolso ficou no nome de quem aprova |
| nada (versão anterior) | nenhuma |

## Valor lido da imagem

Valor que a pessoa digitou entra direto. Valor que veio **só da imagem**
depende da confiança da leitura:

| Confiança | O que o robô faz |
|---|---|
| alta | Lança, com o aviso "esse valor eu li da imagem, confere ao aprovar". |
| média ou baixa | Pergunta antes: "Li R$ X no comprovante. Confirma? Responde *sim* ou manda o valor certo." |

*sim*, *isso*, *confirma*, *ok* confirmam, e o valor passa a contar como
digitado. Um número na resposta substitui o lido. *não*, sozinho, faz a
pergunta voltar. Sem resposta vale a ronda: um lembrete e, no prazo, a
caixa — com o valor lido como sugestão.

A ordem das perguntas é: obra e valor (o que falta) → confirmação do valor
lido → quem pagou → repetido.

## Com que data o gasto entra

Nesta ordem (`dataDoGasto`, em `saida.js`):

1. a data que a pessoa **escreveu** na legenda ou numa resposta ("dia 30/10",
   "30/10/2026");
2. a data que a IA **leu** no papel, se a leitura é de confiança alta ou
   média, não é depois do dia do envio e não tem mais de 120 dias;
3. o **dia do envio**, como era antes.

Quando a data usada fica a mais de 3 dias do envio, a confirmação ganha a
linha "comprovante de 30/10". A mesma data vai para a caixa, para a memória
e para a comparação de repetido.

Medida não é data: "tubo 3/4" e "joelho 1/2" são ignorados. Sem ano, a data
só vale com o mês em dois dígitos ("05/09") ou com "dia", "data", "em" ou
"de" antes ("dia 3/8"), e até 120 dias para trás; com ano, até um ano.

## Grupo só de leitura (o grupo da equipe)

Para o grupo onde a equipe manda comprovante todo dia e o robô **não deve
falar**. Ele lê cada comprovante que chega ali, lança, e as dúvidas e as
confirmações saem em **outro lugar**: o grupo de conversa com o robô, ou o
privado do dono.

Para ligar:

1. **Pôr o número do robô no grupo.** É por ser membro que ele recebe as
   mensagens. Ele entra e fica calado.
2. No `.env`:

   ```
   GASTOS_GRUPOS_LEITURA=<identificador do grupo>@g.us
   GASTOS_LEITURA_DESTINO=55DDDNUMERODODONO
   ```

   O dono escolheu (24/11/2026) receber as dúvidas **no privado dele**: o
   destino é o número dele, só dígitos, com 55. Para usar o grupo de
   conversa, ponha ali o identificador do grupo (`…@g.us`). O número do dono
   tem de estar também em `GASTOS_AUTORIZADOS` — é o que o deixa responder
   pelo privado. Com ou sem o nono dígito, tanto faz: o WhatsApp entrega dos
   dois jeitos e o robô casa os dois.

   Com `GASTOS_AUTORIZADOS=*` o grupo de leitura tem de ir pelo
   **identificador** (o nome qualquer um escolhe). Se puser o nome
   ("Comprovantes Pgto obras"), na primeira mensagem de lá o robô escreve no
   log qual é o identificador — é só copiar para o `.env`.
3. Reiniciar o robô.

O que acontece:

- **Nada é dito no grupo de leitura** — nem pergunta, nem confirmação, nem
  resposta a "ping". Há uma trava na saída que bloqueia qualquer mensagem
  para ele.
- Tem obra e valor → **lança** pendente, como pago pela empresa (se a legenda
  disser "pago por Fulano", vale a legenda), com o telefone de quem mandou.
  A confirmação "✅ Lançado" sai no destino.
- Falta algo (obra, valor, valor lido com dúvida, parece repetido, boleto) →
  **pergunta no destino**. Toda mensagem lá começa dizendo de onde veio:

  > 📎 Do grupo "Comprovantes Pgto obras" — 24/11 às 14:03, de João Pedreiro
  > "cimento 80"

- **Quem responde** é quem está no destino, **citando** a pergunta (sem citar,
  quando é a única no ar). No privado, só o dono (ou quem estiver em
  `GASTOS_AUTORIZADOS` por número).
- Foto sem legenda: espera a mensagem seguinte **da mesma pessoa** como
  descrição, como no dia a dia.
- Corrigir pelo grupo (citando a confirmação, no destino) funciona igual.

| Variável | Padrão | Para quê |
|---|---|---|
| `GASTOS_GRUPOS_LEITURA` | — | Os grupos onde o robô só lê |
| `GASTOS_LEITURA_DESTINO` | `GASTOS_ATRASO_GRUPO`, ou o grupo dos comprovantes | Onde perguntar e confirmar: grupo ou número |
| `GASTOS_LEITURA_PAGADOR` | `empresa` | `perguntar` faz perguntar "quem pagou?" no destino |
| `GASTOS_LEITURA_CONFIRMA` | `on` | `off` lança calado (só as dúvidas saem) |

## Pago × a pagar

No grupo chega também o boleto que ainda vence, o orçamento, a nota a prazo.
Gasto é dinheiro que **saiu** — então o robô passou a olhar o que é o
documento. A leitura da imagem diz o tipo (`comprovante_pagamento`,
`cupom_fiscal`, `nota_fiscal`, `boleto`, `orcamento_pedido`, `outro`), se
há **prova de pagamento** na imagem, e o vencimento.

| Documento | O que o robô faz |
|---|---|
| Boleto ou orçamento/pedido, **sem** prova de pagamento | Não lança. Manda para a caixa com o texto começando por "A PAGAR — boleto, vence dd/mm" (ou "ORÇAMENTO/PEDIDO — não é pagamento") e avisa no grupo. |
| Nota fiscal com vencimento no futuro e sem prova de pagamento | Pergunta: "Já foi pago? Responde *pago* ou *a pagar*." |
| Todo o resto | Como sempre. |

- **`pago`**, *já paguei*, *foi pago* — citando o comprovante ou o aviso —
  lança normalmente, mesmo depois de ter ido para a caixa. *a pagar* (ou
  *não*, na pergunta da nota) manda para a caixa com a marca.
- **O que a pessoa escreveu ganha da imagem:** "pago", "pix feito", "paguei",
  "pago por Fulano" na legenda, e não há pergunta. "a pagar" na legenda
  manda para a caixa, seja qual for o tipo.
- **Na dúvida, o comportamento de antes.** Leitura que falhou, tipo `outro`
  ou desconhecido, modelo que não afirmou que falta a prova de pagamento:
  nada disso segura um comprovante.
- O que foi para a caixa como "a pagar" fica esperando um *pago* pelo prazo
  de sempre (24 h), sem lembrete; depois sai da espera em silêncio.
- No grupo antigo vale a mesma regra, mas o documento não fica esperando
  (não segura o lote de perguntas). No relatório do ensaio há a coluna
  "Tipo do documento" e o destino "a pagar".
- Os textos são fixos. O destino do que é "a pagar" está isolado em
  `mandarParaContasAPagar` (`saida.js`): hoje é a caixa; quando existir o
  agente de contas a pagar, troca-se só ali.

Limite conhecido: quando um documento vai para a caixa como "a pagar" e
depois é lançado com *pago*, a cópia que ficou na caixa continua lá — o robô
não tem como tirar.

## Hábito do fornecedor

O robô guarda, por fornecedor, de qual obra e de qual categoria foram os
gastos **lançados** (o que foi para a caixa não conta). O fornecedor é
reconhecido pelo CNPJ, quando a IA leu um inteiro; sem ele, pelo nome
(sem ligar para maiúsculas, acento e "Ltda"). Mesmo nome com outro CNPJ é
outra loja.

Quando **falta a obra** e o fornecedor tem pelo menos 3 lançamentos nos
últimos 90 dias, com 80% ou mais numa obra só, a pergunta deixa de ser a
lista e vira:

> É da *<obra>*, como das outras vezes? Responde *sim* ou diz a obra.

- **O robô nunca lança por hábito.** Obra errada é o pior erro do módulo, e
  ninguém percebe. A pessoa sempre confirma.
- *sim* confirma; *sim, 250* confirma e traz o valor que faltava; outra obra
  escrita vale no lugar; *não* faz voltar a pergunta de sempre, com a lista.
- Quem escreveu a obra não é perguntado. Obra encerrada (fora da lista do
  sistema) não é sugerida.
- **Categoria:** quando nem a legenda nem a imagem deram, entra a do hábito
  (mesma régua). Essa não pergunta — errar a categoria é barato, quem aprova
  vê e troca.
- Corrigir a obra ou cancelar o gasto pelo grupo corrige também o hábito.
- No grupo antigo vale igual, sempre como pergunta.

| Variável | Padrão | Para quê |
|---|---|---|
| `GASTOS_HABITO_MINIMO` | `3` | Lançamentos do fornecedor para haver hábito |
| `GASTOS_HABITO_DIAS` | `90` | Por quantos dias um lançamento conta |
| `GASTOS_HABITO_PROPORCAO` | `80` | % mínima numa obra só |

## Corrigir pelo grupo

Depois do "✅ Lançado", enquanto o gasto está **pendente**, dá para corrigir
sem abrir o sistema: **citar** o comprovante (ou a confirmação) e escrever a
correção.

| Escrevendo (citando) | O que muda |
|---|---|
| `valor 1800` · `era 1.800,00` · `R$ 1800` | o valor |
| `obra haia` · `é da haia` | a obra (ambígua ou desconhecida → pergunta com a lista) |
| `data 30/10` | a data |
| `material` · `locação` · `mão de obra` | a categoria |
| `descrição areia lavada` | a descrição |
| `apagar` · `cancelar` · `lancei errado` | cancela — depois de **uma** confirmação ("Cancelo o lançamento de R$ X em <obra>? Responde *sim*") |

A resposta é curta e diz o antes e o depois: `✏️ Corrigido: R$ 1.500,00 → R$ 1.800,00`.
Os textos são fixos, escritos no código — nenhuma IA redige.

As travas:

- **Sem citação, nada disto dispara.** "valor 1800" solto continua sendo o que
  sempre foi (resposta a uma pergunta, ou nada).
- **Quem pode — duas barreiras, e passa quem passa nas duas.**
  A do robô: quem mandou o comprovante, ou alguém de `GASTOS_AUTORIZADOS`
  **por número** (o coringa `*` do grupo não basta para mexer no gasto de
  outra pessoa). A do sistema: o robô manda em `enviadoPor` o telefone de
  **quem pediu** a correção (no corpo do `PATCH`, na consulta do `DELETE`),
  e o Obras decide pela pessoa — sócio/administrador mexe em qualquer gasto;
  outro usuário, só no que está no nome dele; telefone desconhecido, só nos
  que ficaram no nome do dono do token. A barreira do robô continua
  existindo para quando o sistema não tem como saber quem pediu: telefone
  escondido atrás de um `@lid` (aí não se manda nada no lugar) ou servidor
  de versão anterior.
- **Só pendente.** Já aprovado: "Esse já foi aprovado — agora só pelo
  sistema." Já rejeitado ou cancelado: diz isso, e não "aprovado".
- Gasto dividido entre obras: o valor corrige; a obra, só pelo sistema.
- Muitas correções no mesmo gasto: o sistema passa a recusar, e o robô manda
  o próximo ajuste para o sistema.
- O que o sistema não deixa mexer por aqui (lançado antes de existir a
  correção pelo grupo, no nome de outra pessoa, ou servidor sem a rota)
  recebe uma resposta só, sem cara de erro: "Esse lançamento só dá para
  corrigir pelo sistema."
- Número solto só vale como valor com cara de dinheiro (`1.800,00`, `R$ 1800`);
  `1800` puro pede `valor` ou `era` na frente. Citar e escrever outra coisa
  ("obrigado") não faz nada.

A memória do robô acompanha a correção (e esquece o gasto cancelado), para a
comparação de repetido e o fechamento do dia não ficarem com o dado velho. O
vínculo entre mensagem e gasto dura enquanto o lançamento está na memória (30
dias). Usa `PATCH` e `DELETE /api/comprovantes/lancados/:id`; servidor sem
essas rotas responde 404 e o robô manda corrigir pelo sistema.

Limites: os lançamentos do grupo antigo não têm confirmação para citar; e no
Telegram só citar o comprovante funciona (a confirmação não é reconhecida).

## O grupo antigo (comprovantes atrasados)

Lê a conversa **exportada** do grupo onde os comprovantes caíam e trata cada
um, de uma data para cá, pela mesma decisão do dia a dia. Tudo nasce como
**pago pelo caixa da empresa** (se a legenda disser "pago por Fulano", vale a
legenda). Nada é dito no grupo antigo: as perguntas e o resumo saem só no
grupo de conversa com o robô.

Desligado por padrão. Liga-se em dois tempos — primeiro o ensaio, depois de
verdade.

### Passo a passo

1. **Exportar.** No celular, abrir o grupo antigo → ⋮ (ou o nome do grupo, no
   iPhone) → *Exportar conversa* → **Incluir mídia**. Sai um `.zip`.
2. **Pôr o zip no servidor**, na pasta `dados/atraso/` do robô (por `scp`,
   por exemplo: `scp conversa.zip servidor:/caminho/do/robo/dados/atraso/grupo-antigo.zip`).
3. **Ensaio.** No `.env`: `GASTOS_ATRASO=ensaio`. Reiniciar o robô
   (`pm2 restart recrutamento-bot`). No servidor:

   ```
   curl -X POST "http://localhost:3100/comprovantes/atraso?arquivo=grupo-antigo.zip"
   ```

   Ele responde na hora quantos comprovantes achou e segue em segundo plano
   (com a pausa padrão, uns 15 por minuto). Para acompanhar:

   ```
   curl http://localhost:3100/comprovantes/atraso
   ```

4. **Ler o relatório.** Quando `rodando` voltar `false`:

   ```
   curl -o grupo-antigo-ensaio.csv http://localhost:3100/comprovantes/atraso/relatorio.csv
   ```

   Abre no Excel. Uma linha por comprovante: data, remetente, legenda, obra,
   valor, de onde veio o valor, a data que seria usada e o **destino** —
   *lançaria*, *já lançado* (com qual lançamento bateu), *provável repetido*
   ou *perguntaria* (o quê). O resumo com os totais vem no `resumo` da
   consulta acima e em `dados/atraso/resumo.txt`. No ensaio **nada** é
   lançado, mandado para a caixa ou escrito em conversa nenhuma.
5. **Ligar.** No `.env`: `GASTOS_ATRASO=on`. Reiniciar. Repetir o mesmo
   `curl -X POST` do passo 3. As leituras da IA feitas no ensaio são
   aproveitadas.
6. **Responder.** As perguntas chegam no grupo de conversa, **5 de cada
   vez**, cada uma dizendo de que dia é, quem mandou e o que estava escrito.
   Responde-se **citando** a pergunta (qualquer pessoa autorizada do grupo
   pode). O lote seguinte só sai quando o anterior estiver resolvido —
   respondido, ou encerrado pela ronda (um lembrete e, em 24 h, a caixa).
   Quando todos os arquivos tiverem passado, sai **uma** mensagem com os
   totais: lançados (R$), já estavam no sistema, esperando resposta, na caixa.
7. **Desligar.** Terminado, voltar `GASTOS_ATRASO=off`.

Pode-se mandar o mesmo zip de novo, ou reiniciar o robô no meio: o que foi
feito com cada arquivo fica em `dados/atraso/estado.json`, pela impressão
digital dele, e nada é lançado nem perguntado duas vezes.

Em vez de `?arquivo=`, o zip pode ir no corpo do pedido
(`curl -X POST --data-binary @conversa.zip -H "Content-Type: application/zip" http://localhost:3100/comprovantes/atraso`).
As rotas só atendem de dentro do próprio servidor, ou com
`Authorization: Bearer <GASTOS_ATRASO_TOKEN>` se esse token for definido.

### Sem exportar: ler o grupo pela conta do dono

Em vez do passo 1 e 2 (exportar pelo celular e copiar o zip), dá para ler o
grupo direto da conta de quem está nele. É uma **ferramenta avulsa**, de
rodar uma vez num computador com Node — **não** dentro do robô:
`scripts/ler-grupo-pela-conta.js`. Ela entra no WhatsApp do dono como
"aparelho conectado", lê só o grupo pedido, baixa imagens e PDFs e gera um
zip no mesmo formato da exportação.

O que ela garante:

- **Só lê.** Não manda mensagem, não marca como lido, não aparece online.
- **Só o grupo.** A conta recebe todas as conversas do dono; o que não é do
  grupo pedido é descartado na hora, na memória — não vai para o disco nem
  para a tela.
- **Sessão própria** (`dados/whatsapp-leitor`, fora do git). Não toca na
  sessão do robô nem na da cobrança de obras.

Passo a passo, na pasta do robô:

1. **Conectar e ler** (na primeira vez mostra um código de 8 letras):

   ```
   node scripts/ler-grupo-pela-conta.js ler --grupo "Comprovantes Pgto obras" --numero 55DDDNUMERO
   ```

   O nome do grupo não precisa vir igualzinho: maiúsculas, espaços a mais,
   acento e pontuação não contam. Se não achar, a ferramenta lista os grupos
   de nome parecido (só os parecidos) para escolher.

   No celular: WhatsApp → Aparelhos conectados → Conectar aparelho →
   *Conectar com número de telefone*, e digitar o código. (Com `--qr` no
   lugar de `--numero`, sai uma página com o QR em `dados/leitor-qr.html`.)
   Ele espera a conta mandar o histórico, pede ao celular o que veio antes —
   devagar, um pedido a cada poucos segundos — até passar da data de corte
   (`--desde`, padrão `2026-09-22`), e baixa as mídias. **O celular precisa
   estar ligado e com internet**: é ele que manda o histórico e reenvia a
   mídia antiga.
2. **Ler o resumo**, em `dados/leitor-saida/resumo.txt`: mensagens lidas,
   comprovantes, mídias baixadas, as que falharam e a data da mensagem mais
   antiga alcançada. O que não baixou está em `falhas.csv` (data, remetente,
   legenda), para achar à mão. Se a leitura não chegou à data de corte, o
   resumo diz — rodar o mesmo comando de novo **continua de onde parou** e
   não baixa nada duas vezes.
3. **Ensaio aqui mesmo** (opcional), sem mandar nada ao servidor do robô:

   ```
   node scripts/ler-grupo-pela-conta.js ensaio
   ```

   Precisa de `OBRAS_API_TOKEN` (e `OBRAS_API_URL`, se não for o padrão) no
   ambiente, só para **ler** o que já está lançado, e de `GEMINI_API_KEY`
   para ler as imagens. Não lança, não manda para a caixa, não escreve em
   conversa nenhuma, e não usa a pasta `dados/` do robô. O relatório sai em
   `dados/leitor-saida/grupo-antigo-ensaio.csv`.
4. **Desconectar o aparelho** quando terminar:

   ```
   node scripts/ler-grupo-pela-conta.js sair
   ```

   (ou, no celular, Aparelhos conectados → tocar no aparelho → Desconectar).
5. O zip (`dados/leitor-saida/grupo-antigo.zip`) segue pelo passo a passo
   de cima, a partir do passo 2.

Limites que não dependem da ferramenta: o WhatsApp só manda a um aparelho
novo as conversas recentes. Se o grupo estiver parado há muito tempo e não
vier nenhuma mensagem dele, não há ponto de partida para pedir as
anteriores — a ferramenta para e avisa, e o caminho é a exportação pelo
celular. E mídia que o celular já apagou não volta.

### O que cada comprovante vira

| Situação | Destino |
|---|---|
| Mesmo arquivo de um gasto lançado, ou mesmo nº de documento e valor | Já lançado — pula, sem pergunta |
| Mesma obra, mesmo valor, data a até 3 dias de um lançamento | Provável repetido — pergunta |
| Mesma obra e valor com data mais longe (até 30 dias), ou mesmo valor em outra obra com data perto | Dúvida — pergunta |
| Falta obra ou valor, ou o valor veio de leitura insegura da imagem | Pergunta |
| Tem obra e valor e não parece repetido | Lança pendente, pago pela empresa, com a data da mensagem original (ou a do comprovante, pelas regras de data acima) |

A leitura **para** — sem lançar mais nada, e dizendo por quê no estado, no
resumo e (ligada) uma vez no grupo de conversa — quando não consegue saber o
que já está lançado: sistema de obras fora do ar ou sem a consulta de
lançados, ou lista cortada (o sistema devolve no máximo 2.000 lançamentos,
dos mais recentes para os mais antigos, e não deixa pedir os que faltaram).
Nesse último caso a mensagem diz a partir de que data a lista está completa,
e dá para rodar com esse corte (`?desde=`). Corrigido o problema, é mandar o
mesmo zip de novo. No dia a dia a lista cortada continua sendo usada, com
aviso no log: ali o que interessa é recente.

Ficam de fora, e são contados no relatório: figurinha, áudio, vídeo, mídia
omitida, o que é de antes do corte, arquivo citado na conversa que não veio
no zip, arquivo que não é imagem nem PDF de verdade (confere-se o conteúdo,
não a extensão) e arquivo acima de 20 MB.

### Variáveis

| Variável | Padrão | Para quê |
|---|---|---|
| `GASTOS_ATRASO` | `off` | `ensaio` ou `on` |
| `GASTOS_ATRASO_GRUPO` | o grupo de onde os comprovantes já vêm | Onde perguntar e mandar o resumo. Tem de estar em `GASTOS_GRUPOS` |
| `GASTOS_ATRASO_DESDE` | `2026-09-22` | Data de corte (também `?desde=AAAA-MM-DD` no pedido) |
| `GASTOS_ATRASO_PAGADOR` | `legenda` | `empresa` faz ignorar "pago por Fulano" da legenda |
| `GASTOS_ATRASO_LOTE` | `5` | Perguntas no ar de cada vez |
| `GASTOS_ATRASO_PAUSA_MS` | `4000` | Pausa entre comprovantes (limite do Obras e cota da IA) |
| `GASTOS_ATRASO_TOKEN` | — | Token para disparar de fora do servidor |
| `GASTOS_ATRASO_DIR` | `dados/atraso` | Onde ficam o zip, o estado e o relatório |

## Configuração e dados

Variáveis `GASTOS_*`, `OBRAS_*` e `IA_VISAO_*`, lidas uma vez no import.
Os dados ficam em `dados/` (relativo a onde o robô roda, não a esta pasta).

## Contrato com o Obras

Está em `NovaGestaoObras/docs/ROBO-WHATSAPP.md`. A regra de casar nome de
obra existe em três lugares e tem de mudar junto: aqui (`lancamento.js`), em
`NovaGestaoObras/backend/.../comprovantes.service.ts` e em
`NovaGestaoObras/frontend/src/utils/casarObra.ts`.
