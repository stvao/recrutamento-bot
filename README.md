# Robô — WhatsApp e Telegram

Um serviço, dois módulos, e a intenção de receber outros:

| Módulo | Quem fala com ele | O que faz |
|---|---|---|
| **Recrutamento** | Candidatos, no WhatsApp | Conduz a conversa e registra a candidatura no RH. A atendente se chama **Maria Vitória**. |
| **Gastos** | A equipe, no grupo de comprovantes | Lê a foto do comprovante e joga na caixa de aprovação do sistema de obras. |

Roda separado dos dois sistemas. Fala com eles só por HTTP, com token
compartilhado — é essa fronteira estreita que permite os três viverem em
repositórios diferentes.

```
                    ┌──▶ recrutamento ──▶ Gemini (escreve a conversa)
WhatsApp ──▶ robô ──┤                 └──▶ RH (vagas, candidatura, alertas)
Telegram ──▶        │
                    └──▶ gastos ──────▶ Gemini (lê o comprovante)
                                    └──▶ Obras (caixa de aprovação)
```

**Quem atende é decidido pelo remetente**, e isso é segurança, não
organização: só quem está em `GASTOS_AUTORIZADOS` entra no módulo de gastos.
Sem essa lista, qualquer um que descubra o número manda uma foto e cria
lançamento no financeiro da empresa. Todo o resto vai para o recrutamento.

## Subir

```bash
npm install
cp .env.example .env     # preencha
npm start
```

Sobe na porta 3100. `GET /health` responde se está de pé, `GET /metricas`
mostra quantas conversas começaram, terminaram e onde as pessoas desistem.

## As camadas, e o que cada uma decide

| Arquivo | O que faz |
|---|---|
| `ia.js` | Fala com o modelo. Monta quem é a Maria Vitória e os fatos que ela pode usar. |
| `atendimento.js` | **Confere o que o modelo diz** antes de virar registro, e escolhe quem atende. |
| `brain.js` | O roteiro determinístico. Atende quando o modelo não responde. |
| `catalogo.js` | Vagas, salários e cidades — vindos do RH, com reserva local. |
| `texto.js` | Comparação tolerante a erro de escrita ("pedrero" → Pedreiro). |
| `store.js` | Estado das conversas, em arquivo. Sobrevive ao reinício. |
| `baileys.js` | Conexão com o WhatsApp pela via não oficial (QR code). |
| `connectors.js` | Troca de conector: `none`, `baileys`, `zapi`, `cloud`. |
| `rh-client.js` | Envia candidatura e alerta ao RH. |
| `telegram.js` | Conexão com o Telegram (long polling — sem webhook nem domínio). |
| `gastos.js` | O módulo de comprovantes: quem pode lançar, e o que vira envio. |
| `ia-visao.js` | Lê o comprovante e **confere** o que o modelo diz ter lido. |
| `obras-client.js` | Envia o comprovante ao sistema de obras. |

A regra que organiza tudo: **o modelo decide o que dizer; o código é dono dos
fatos e do que fica gravado.** Salário e alojamento entram prontos, vindos do
banco do RH — o modelo nunca lembra um valor de memória, porque ele informa
esse valor por escrito no WhatsApp de um candidato, e isso vira prova.

## O contrato com o RH

Estas quatro coisas ligam os dois sistemas. **Mudou de um lado, tem que mudar
do outro** — é o preço de estarem em repositórios separados.

| | |
|---|---|
| `GET /api/integracao/vagas` | Vagas, salários, apelidos e cidades com alojamento. |
| `POST /api/integracao/candidatura` | Cria a candidatura. Chamada de novo com o mesmo telefone, **atualiza** em vez de duplicar. |
| `POST /api/integracao/alerta` | Avisa o RH que uma conversa precisa de gente. |
| Token | `RH_API_TOKEN` aqui = `RECRUTAMENTO_BOT_TOKEN` no RH. |

O RH também chama o robô em `POST /simular`, para o simulador interno
(`/recrutamento/robo`) testar a conversa sem WhatsApp.

## O módulo de gastos

Os comprovantes já chegam todo dia num grupo, com a descrição escrita do
lado, e alguém precisa olhar cada um e digitar no sistema de custos. Isso é o
que o módulo tira do caminho.

O que ele **não** faz é lançar no custo. O comprovante vai para a caixa
"Comprovantes recebidos" (topo de `/m/gasto` e `/m/gasto-campo`), já com o
resumo do que a IA leu, e a pessoa toca em "Lançar", confere e salva.
Lançar direto trocaria *trabalho de digitar* por *trabalho de auditar*, que é
pior: a IA erra — lê 1.500 onde era 1.800, troca a data, erra a categoria.

Três regras que não se negociam:

- **Lista de autorizados.** Sem ela, qualquer um lança no financeiro.
- **Nada entra direto no custo.** Sempre a caixa de aprovação.
- **Idempotência em todo envio.** O `Idempotency-Key` é o id da mensagem, que
  é estável entre reentregas. A Meta reentrega webhooks; sem a chave, o mesmo
  gasto entra duas vezes.

### O contrato com o sistema de obras

| | |
|---|---|
| `POST /api/comprovantes/receber` | `multipart`: `arquivo` (imagem ou PDF, até 20 MB) e `texto` livre. |
| Token | `OBRAS_API_TOKEN`, gerado em "Enviar pelo iPhone" (`/m/atalho`). Só cria comprovante — não lê, não lança, não aprova. |
| Cabeçalho | `Idempotency-Key: <id da mensagem>` |

**Lacuna conhecida:** o endpoint aceita só `arquivo` e `texto`. Enquanto for
assim, a IA escreve o resumo (`Posto Ipiranga · R$ 250,00 · 28/08`) no texto,
e a pessoa lê e digita o valor — ganha-se a foto no lugar certo, não o
preenchimento. O robô **já manda** `valor`, `data`, `categoria` e o resto como
campos extras, que o servidor ignora sem erro; quando o DTO do outro lado
aceitá-los, o formulário passa a abrir preenchido sem mexer aqui.

### Por qual canal

O grupo é o problema. A **API oficial da Meta não entrega mensagem de grupo** —
não é configuração, é limite da plataforma. Sobram:

- **`CONNECTOR=baileys`** lê o grupo direto, sem mudar o hábito de ninguém.
  O número pode ser bloqueado, então use um chip dedicado e barato — se cair,
  troca-se o chip. **Nunca o número que atende candidato.**
- **Telegram** lê grupo nativamente, sem verificação e sem risco de bloqueio,
  mas exige mover o grupo de aplicativo.
- **`CONNECTOR=cloud`** (oficial) só funciona se cada pessoa **encaminhar** o
  comprovante para o número do bot.

Os dois canais sobem juntos: `TELEGRAM_TOKEN` não substitui o WhatsApp, soma.

## Quando o modelo não responde

Cerca de uma em cada cinco chamadas ao Gemini trava. Duas defesas:

- **Tenta de novo** (4 s de prazo, 2 tentativas).
- **O roteiro assume** aquela mensagem. Uma falha não rebaixa a conversa —
  só depois de três seguidas é que se assume que a IA está fora.

E o que a pessoa disse durante a queda entra no histórico assim mesmo. Sem
isso, o candidato que manda o nome completo justo no turno que falhou vê a
pergunta repetida depois.

## Sem RH, sem IA, sem nada

O robô continua atendendo. Nessa condição ele diz **"a combinar"** em vez de
repetir um salário guardado: não saber o valor é aceitável, prometer o errado
por escrito não é.

## Testes

```bash
npm test
```

Não carregam o `.env`, de propósito — teste que muda conforme a configuração
da máquina não prova nada.

## WhatsApp

`CONNECTOR=baileys` lê um QR code e conecta como mais um aparelho. Funciona
hoje e não custa nada, **mas o número pode ser bloqueado pelo WhatsApp** —
nunca use o número principal da empresa.

Quando a verificação da Meta sair, troque para `CONNECTOR=cloud`. O resto do
código não muda.
