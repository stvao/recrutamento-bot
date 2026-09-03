# Colocar o robô no ar

Enquanto ele roda no seu computador, ele só funciona com a máquina ligada e a
janela aberta. Fechou o notebook, comprovante mandado no grupo não é atendido
por ninguém — e você não fica sabendo.

Este documento tira ele de lá.

## Onde ele deve morar: no servidor do RH

**Não crie uma instância nova.** O servidor do RH já está preparado:

- o `auto-deploy.sh` que roda lá a cada 2 minutos **já tem uma seção para o
  robô** — ele espera o repositório em `$HOME/recrutamento-bot` e um processo
  pm2 chamado `recrutamento-bot`;
- o robô conversa com o RH a cada mensagem (quem é a pessoa, vagas,
  candidatura, alerta). Na mesma máquina isso é `localhost`: sem rede no
  meio, sem nada exposto;
- a rota `/simular` só aceita chamadas de dentro da própria máquina, e é
  exatamente assim que o RH a chama;
- o sistema de obras é alcançado por HTTPS de qualquer lugar, então não muda
  nada para ele.

Instância separada só valeria a pena se o robô passasse a incomodar o RH —
memória ou CPU. Hoje ele usa pouco, e essa é uma ponte para atravessar quando
se chegar nela.

**Antes de começar, confira que cabe:**

```bash
free -m && df -h / && pm2 list
```

O robô ocupa algo entre 150 e 300 MB com o WhatsApp conectado. Se a memória
livre estiver apertada, o caminho é tirar o *build* do RH de dentro do
servidor (`touch ~/.deploy-por-github`), não deixar o robô de fora.

## Passo a passo

### 1. Conectar

```bash
ssh -i "CAMINHO\DA\CHAVE.pem" ubuntu@IP_DO_SERVIDOR_DO_RH
```

### 2. Trazer o repositório

```bash
cd ~ && git clone https://github.com/stvao/recrutamento-bot.git && cd recrutamento-bot && npm install --omit=dev
```

### 3. Criar o `.env`

```bash
nano ~/recrutamento-bot/.env
```

Cole isto e preencha os quatro segredos. **Repare no `RH_API_URL`**: aqui é
`localhost`, porque o RH roda na mesma máquina.

```
PORT=3100

# O RH está na mesma máquina — sem rede no meio.
RH_API_URL=http://localhost:3000
RH_API_TOKEN=<o mesmo RECRUTAMENTO_BOT_TOKEN do .env do RH>

WEBHOOK_SEGREDO=<gere: openssl rand -hex 24>
EMPRESA_NOME=KE Engenharia
GEMINI_API_KEY=<a chave NOVA, depois de revogar a antiga>

# WhatsApp pelo chip dedicado
CONNECTOR=baileys

# ── Módulo de gastos ──
OBRAS_API_URL=https://novagestaoobras.duckdns.org
OBRAS_API_TOKEN=<o token NOVO, gerado em /m/atalho>
GASTOS_GRUPOS=Comprovantes
GASTOS_AUTORIZADOS=*

# Fechamento do dia no grupo (opcional)
GASTOS_RESUMO=on
GASTOS_RESUMO_HORA=18:00
```

Salvar: `Ctrl+O`, `Enter`, `Ctrl+X`.

**Proteja o arquivo** — ele tem três segredos:

```bash
chmod 600 ~/recrutamento-bot/.env
```

### 4. Ler o QR code UMA vez

O WhatsApp precisa ser pareado, e o QR aparece no terminal. Rode em primeiro
plano só desta vez:

```bash
cd ~/recrutamento-bot && npm start
```

No celular **do chip dedicado**: WhatsApp → Configurações → Aparelhos
conectados → Conectar aparelho → aponte para o QR na tela do SSH.

Espere aparecer:

```
✅ WhatsApp conectado no número 55119...
[whatsapp] ✅ grupo "Comprovantes" encontrado
[atendimento] RH respondendo em http://localhost:3000
```

Aí `Ctrl+C`. A sessão fica salva em `dados/whatsapp` e não pede QR de novo.

### 5. Deixar rodando sozinho

O nome `recrutamento-bot` **não é opcional** — é por ele que o auto-deploy
encontra o processo:

```bash
cd ~/recrutamento-bot && pm2 start npm --name recrutamento-bot -- start && pm2 save
```

### 6. Conferir

```bash
pm2 list && curl -s localhost:3100/metricas
```

E no grupo do WhatsApp, mande **`ping`**. Ele tem que responder.

## Depois disso

O auto-deploy passa a atualizar o robô sozinho: você faz `git push`, e em até
2 minutos ele está no ar. Não precisa mais entrar no servidor para atualizar.

Para ver o que está acontecendo:

```bash
pm2 logs recrutamento-bot --lines 50
```

## Duas coisas que NÃO fazer

**Não abra a porta 3100 no security group.** Com o `CONNECTOR=baileys` o robô
não recebe webhook nenhum — quem procura o WhatsApp é ele. A porta só precisa
existir para o RH chamar em `localhost`. Aberta, ela é uma porta a mais para
a internet sem necessidade nenhuma.

**Não copie a pasta `dados/` do seu PC.** Ela guarda as credenciais da sessão
do WhatsApp: quem tiver esses arquivos entra no WhatsApp do robô sem ler QR
code nenhum. Deixe o servidor parear do zero, e apague a sessão da sua
máquina quando terminar:

```powershell
Remove-Item -Recurse -Force "D:\Projetos-de-Codigos\LexDocs VAdvocacia\recrutamento-bot\dados\whatsapp"
```

## Antes de tudo: as duas chaves queimadas

A chave do **Gemini** e o token do **sistema de obras** apareceram em
conversa, e as duas continuam válidas. Gere as novas *antes* de escrever o
`.env` do servidor — assim você não precisa mexer nele duas vezes:

- Gemini: revogar e gerar em `aistudio.google.com`
- Obras: revogar e gerar em `/m/atalho`, na tela "Enviar pelo iPhone"
