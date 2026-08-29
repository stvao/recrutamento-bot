# Robô de recrutamento — WhatsApp

Atende candidatos por WhatsApp, conduz a conversa e registra a candidatura no
sistema de RH. A atendente se chama **Maria Vitória**.

Roda como serviço separado do RH. Fala com ele só por HTTP, com um token
compartilhado — é essa fronteira estreita que permite os dois viverem em
repositórios diferentes.

```
WhatsApp ──▶ robô ──▶ Gemini (escreve a conversa)
                │
                └──▶ RH (vagas, cidades, candidatura, alertas)
```

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
