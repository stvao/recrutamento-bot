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
| `perguntas.js` | Monta as perguntas (obra, valor, quem pagou) e lê a resposta de "quem pagou?". |
| `processar.js` | O miolo: junta o escrito com o lido da imagem e decide — lança, pergunta ou caixa. Guarda o que está em andamento. |
| `saida.js` | Lança o gasto pendente no Obras, ou manda para a caixa de comprovantes. |
| `ronda.js` | O lembrete (uma vez, 3 h) e o prazo (24 h → caixa). Liga no arranque. |
| `formato.js` | Como valor, data e item aparecem nas mensagens. |
| `lancamento.js` | Lê a linha que a pessoa escreve: obra, descrição, tipo, valor, quem pagou. |
| `ia-visao.js` | Lê a imagem do comprovante e confere o que o modelo diz ter lido. |
| `obras-client.js` | Fala com o NovaGestão Obras (lançar, caixa, lista de obras e sócios). |
| `memoria.js` | O que já foi lançado e os apelidos de obra aprendidos (`dados/memoria-gastos.json`). |
| `pendentes.js` | Comprovantes esperando resposta, em disco (`dados/pendentes/`). |
| `resumo-diario.js` | O fechamento do dia no grupo (desligado por padrão). |

Os testes ficam em `tests/`, com os demais: `teste-gastos.js`,
`teste-conversa-gastos.js`, `teste-conversa-pagador.js`,
`teste-lancamento.js`, `teste-obras.js`, `teste-pendentes.js`.

## Configuração e dados

Variáveis `GASTOS_*`, `OBRAS_*` e `IA_VISAO_*`, lidas uma vez no import.
Os dados ficam em `dados/` (relativo a onde o robô roda, não a esta pasta).

## Contrato com o Obras

Está em `NovaGestaoObras/docs/ROBO-WHATSAPP.md`. A regra de casar nome de
obra existe em três lugares e tem de mudar junto: aqui (`lancamento.js`), em
`NovaGestaoObras/backend/.../comprovantes.service.ts` e em
`NovaGestaoObras/frontend/src/utils/casarObra.ts`.
