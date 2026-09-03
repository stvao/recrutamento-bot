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

**Em produção ele mora no servidor do RH**, e não na máquina de ninguém — o
auto-deploy de lá já o atualiza sozinho. O passo a passo está em
[COLOCAR-NO-AR.md](COLOCAR-NO-AR.md).

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
| `rh-client.js` | Envia candidatura e alerta ao RH, e pergunta quem é funcionário. |
| `triagem.js` | O primeiro contato de quem o sistema não conhece. Não presume nada. |
| `funcionario.js` | Atende quem já trabalha aqui — **sem dado pessoal e sem link**. |
| `memoria.js` | O que já foi lançado e os apelidos de obra que você usa. |
| `resumo-diario.js` | O fechamento do dia no grupo dos comprovantes. |
| `pendentes.js` | Comprovantes esperando resposta, em disco. |
| `telegram.js` | Conexão com o Telegram (long polling — sem webhook nem domínio). |
| `gastos.js` | O módulo de comprovantes: quem pode lançar, e o que vira envio. |
| `ia-visao.js` | Lê o comprovante e **confere** o que o modelo diz ter lido. |
| `obras-client.js` | Envia o comprovante ao sistema de obras. |
| `lancamento.js` | Lê a linha que você escreve: obra, descrição, tipo, valor. |

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
| `GET /api/integracao/quem` | Quem é este número: funcionário, candidato já inscrito, ou ninguém. Só primeiro nome, cargo e obra — nada pessoal. |
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

### Como se manda

Comprovante (foto, PDF ou arquivo), e a linha do que é:

```
[foto do comprovante]
bastos tsuya, tijolos e areia, material, 2500,00
 └─ obra ──┘  └─ descrição ─┘  └tipo┘   └valor┘
```

Pode ser legenda da foto ou mensagem separada logo depois — nesse caso o robô
segura o comprovante por 60 segundos esperando a linha chegar.

**A ordem é livre e tudo é opcional.** O que der para identificar com certeza
é identificado; o que faltar você completa na hora de aprovar. O tipo aceita
como se fala na obra ("gasolina", "diária", "marmita", "frete") e tolera erro
de digitação — "materal" vira `MATERIAL`, pelo mesmo mecanismo que reconhece
"pedrero" como Pedreiro.

**O que você escreveu ganha da IA. Sempre.** A leitura da imagem acontece,
mas só preenche buraco — nunca corrige quem digitou. Lançar 1.500 porque o
modelo leu errado, num campo onde você escreveu 1.800, é o erro que ninguém
percebe até fechar o mês. Por isso o envio marca cada valor como *digitado*
ou *lido da imagem*, e a resposta avisa só no segundo caso.

**A data do lançamento é a do envio**, não a que a IA leu no papel — manda-se
o comprovante no dia em que se pagou. A data lida do papel vai junto como
`dataComprovante`, para quem aprova ver se as duas batem.

A resposta repete o que ele **entendeu**, não o que recebeu:

```
✅ Comprovante recebido. Você tem 3 esperando lançamento.
Bastos Tsuya · tijolos e areia · material · R$ 2.500,00
```

É a sua chance de ver que a obra saiu errada enquanto ainda lembra do gasto.

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

**Lacuna conhecida, e é ela que separa "quase pronto" de "pronto":** o
endpoint aceita só `arquivo` e `texto`. Enquanto for assim, tudo vira aquela
linha de texto na caixa, e **você ainda digita obra, tipo e valor** — ganha-se
a foto no lugar certo com a informação do lado, não o preenchimento.

O robô **já manda** `obra`, `descricao`, `categoria`, `valor`, `data`,
`dataComprovante`, `estabelecimento`, `documento`, `formaPagamento` e
`confianca` como campos extras do multipart, que um servidor que não os
conhece ignora sem erro. No dia em que o DTO e o modelo `ComprovanteRecebido`
aceitarem esses campos, o formulário passa a abrir preenchido **sem mexer uma
linha aqui**.

Falta também um jeito de resolver a obra pelo título. O robô manda `obra`
como texto (`"bastos tsuya"`); casar isso com a obra certa é do lado de lá,
que é quem tem a lista — o token daqui só cria comprovante, não lê nada.

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
