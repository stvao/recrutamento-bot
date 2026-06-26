# Recrutamento Bot (WhatsApp)

Robô de atendimento de recrutamento no WhatsApp. **Serviço separado** do sistema
Nova Gestão RH — ele atende os candidatos, tira dúvidas e **envia as fichas**
para o recrutamento do RH por API. Assim a conexão do WhatsApp e a IA ficam
isoladas do sistema crítico de RH.

```
Candidato (WhatsApp) → recrutamento-bot → /api/integracao/candidatura (RH) → /recrutamento
```

## Como funciona
- `src/brain.js` — o cérebro (fluxo + FAQ). **Fonte da verdade**: edite vagas,
  salários, cidades e políticas aqui.
- `src/connectors.js` — adaptador da conexão (none | zapi | cloud).
- `src/rh-client.js` — envia a candidatura ao RH.
- `src/server.js` — webhook do WhatsApp + endpoint `/simular` de teste.

## Rodar localmente
```bash
npm install
cp .env.example .env   # edite RH_API_URL, RH_API_TOKEN, CONNECTOR
node src/teste-conversa.js   # testa o cérebro (sem WhatsApp)
npm start                    # sobe o serviço na porta 3100
```

## Testar sem WhatsApp
```bash
# inicia a conversa
curl -s -X POST localhost:3100/simular -H "Content-Type: application/json" -d '{}'
# responde (passe o "estado" retornado e a "mensagem")
curl -s -X POST localhost:3100/simular -H "Content-Type: application/json" \
  -d '{"estado":{...},"mensagem":"pedreiro"}'
```

## Conectar o WhatsApp (quando decidir)
No `.env`, defina `CONNECTOR`:
- **zapi** → `ZAPI_BASE_URL`, `ZAPI_TOKEN`. Webhook da Z-API → `POST /webhook`.
- **cloud** (oficial Meta) → `CLOUD_TOKEN`, `CLOUD_PHONE_NUMBER_ID`,
  `CLOUD_VERIFY_TOKEN`. Webhook na Meta → `GET/POST /webhook`.

O cérebro e o envio ao RH **não mudam** ao trocar a conexão.

## Deploy (mesma máquina do RH, processo separado via PM2)
```bash
cd ~/recrutamento-bot
npm install
pm2 start src/server.js --name recrutamento-bot
pm2 save
```
Configure no RH (`.env`): `RECRUTAMENTO_BOT_TOKEN=<o mesmo de RH_API_TOKEN aqui>`.
