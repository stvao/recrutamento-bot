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
| `zip.js` | Leitor de zip mínimo, que trata o arquivo como dado de fora. |
| `correcao.js` | Corrigir ou cancelar pelo grupo um gasto já lançado, citando o comprovante ou a confirmação. |
| `saida.js` | Lança o gasto pendente no Obras, ou manda para a caixa de comprovantes. |
| `ronda.js` | O lembrete (uma vez, 3 h) e o prazo (24 h → caixa). Liga no arranque. |
| `formato.js` | Como valor, data e item aparecem nas mensagens. |
| `lancamento.js` | Lê a linha que a pessoa escreve: obra, descrição, tipo, valor, data, quem pagou. |
| `ia-visao.js` | Lê a imagem do comprovante e confere o que o modelo diz ter lido. |
| `obras-client.js` | Fala com o NovaGestão Obras (lançar, caixa, lista de obras e sócios, consulta do que já foi lançado). |
| `memoria.js` | O que já foi lançado (com nº do documento e impressão digital do arquivo) e os apelidos de obra aprendidos (`dados/memoria-gastos.json`). |
| `pendentes.js` | Comprovantes esperando resposta, em disco (`dados/pendentes/`). Calcula a impressão digital (sha256) de cada arquivo. |
| `resumo-diario.js` | O fechamento do dia no grupo (desligado por padrão). |

Os testes ficam em `tests/`, com os demais: `teste-gastos.js`,
`teste-conversa-gastos.js`, `teste-conversa-pagador.js`, `teste-duplicata.js`, `teste-data-comprovante.js`, `teste-confirmar-valor.js`, `teste-atraso.js`, `teste-quem-mandou.js`, `teste-correcao.js`,
`teste-lancamento.js`, `teste-obras.js`, `teste-pendentes.js`.

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
- **Quem pode:** quem mandou o comprovante, ou alguém de `GASTOS_AUTORIZADOS`
  **por número**. O coringa `*` do grupo não basta para mexer no gasto de
  outra pessoa.
- **Só pendente.** Já aprovado: "Esse já foi aprovado — agora só pelo sistema."
- Gasto dividido entre obras: o valor corrige; a obra, só pelo sistema.
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
