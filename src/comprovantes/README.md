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
`teste-conversa-gastos.js`, `teste-conversa-pagador.js`, `teste-duplicata.js`, `teste-data-comprovante.js`, `teste-confirmar-valor.js`,
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

## Configuração e dados

Variáveis `GASTOS_*`, `OBRAS_*` e `IA_VISAO_*`, lidas uma vez no import.
Os dados ficam em `dados/` (relativo a onde o robô roda, não a esta pasta).

## Contrato com o Obras

Está em `NovaGestaoObras/docs/ROBO-WHATSAPP.md`. A regra de casar nome de
obra existe em três lugares e tem de mudar junto: aqui (`lancamento.js`), em
`NovaGestaoObras/backend/.../comprovantes.service.ts` e em
`NovaGestaoObras/frontend/src/utils/casarObra.ts`.
