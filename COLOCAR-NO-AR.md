# Colocar o robô no ar

Enquanto ele roda no seu computador, ele só funciona com a máquina ligada e a
janela aberta. Fechou o notebook, comprovante mandado no grupo não é atendido
por ninguém — e você não fica sabendo.

Este documento tira ele de lá. **Os comandos estão prontos: é copiar e colar.**

## Onde ele vai morar: no servidor do RH

**Não crie uma instância nova.** O servidor do RH já está preparado:

- o `auto-deploy.sh` que roda lá a cada 2 minutos **já tem uma seção para o
  robô** — ele espera o repositório em `$HOME/recrutamento-bot` e um processo
  pm2 chamado `recrutamento-bot`;
- o robô conversa com o RH a cada mensagem (quem é a pessoa, vagas,
  candidatura, alerta). Na mesma máquina isso é `localhost`: sem rede no
  meio, sem nada exposto;
- a rota `/simular` só aceita chamadas de dentro da própria máquina, e é
  exatamente assim que o RH a chama;
- o sistema de obras é alcançado por HTTPS de qualquer lugar, então para ele
  não muda nada.

Instância separada só valeria a pena se o robô passasse a incomodar o RH —
memória ou CPU. Hoje ele usa entre 150 e 300 MB, e essa é uma ponte para
atravessar quando se chegar nela.

---

# Antes de tudo: as duas chaves queimadas

A chave do **Gemini** e o token do **sistema de obras** apareceram em
conversa e continuam válidas. Enquanto isto é teste, dá para seguir com elas
— o passo 3 tem um caminho que reaproveita as que já estão no seu PC.

**Antes de o robô atender gente de verdade, troque as duas.** São dois
cliques cada:

- Gemini: <https://aistudio.google.com/apikey>
- Obras: <https://novagestaoobras.duckdns.org/m/atalho> (aparece uma vez só)

O terceiro segredo (`RH_API_TOKEN`) você **nunca** precisa procurar: ele já
está no servidor, e os dois caminhos do passo 3 o pegam de lá sozinhos.

---

# Passo 1 — Conectar no servidor

No **PowerShell** do seu PC:

```powershell
ssh -i "D:\Projetos-de-Codigos\Chaves de acesso\AWS RH\chave-rh.pem" ubuntu@56.126.66.124
```

Deu erro de permissão na chave? Rode isto uma vez e tente de novo:

```powershell
icacls "D:\Projetos-de-Codigos\Chaves de acesso\AWS RH\chave-rh.pem" /inheritance:r /grant:r "$($env:USERNAME):(R)"
```

Conectou quando o começo da linha virar `ubuntu@ip-...:~$`. **Daqui para
baixo, todos os comandos são dentro do servidor.**

# Passo 2 — Ver se cabe, e trazer o robô

```bash
free -m && df -h / && pm2 list
```

O robô ocupa 150–300 MB. Se a memória livre estiver apertada, o caminho é
tirar o *build* do RH de dentro do servidor (`touch ~/.deploy-por-github`),
e não deixar o robô de fora.

```bash
cd ~ && git clone https://github.com/stvao/recrutamento-bot.git && cd recrutamento-bot && npm install --omit=dev
```

# Passo 3 — Escrever o `.env`

Dois caminhos. **Em fase de teste, use o A.**

## 3A — Reaproveitar as chaves que você já tem

O `.env` do seu PC já tem tudo: Gemini, obras, grupo, obras conhecidas. Leve
esse arquivo para o servidor e ajuste o que muda de lugar.

**No PowerShell do seu PC** (numa janela nova, sem fechar a do servidor):

```powershell
scp -i "D:\Projetos-de-Codigos\Chaves de acesso\AWS RH\chave-rh.pem" "D:\Projetos-de-Codigos\LexDocs VAdvocacia\recrutamento-bot\.env" ubuntu@56.126.66.124:~/recrutamento-bot/.env
```

**De volta no servidor**, cole o bloco inteiro:

```bash
cd ~/recrutamento-bot
sed -i 's|^RH_API_URL=.*|RH_API_URL=http://localhost:3000|' .env
TOKEN_RH=$(grep -m1 '^RECRUTAMENTO_BOT_TOKEN=' ~/nova-gestao-rh/.env | cut -d= -f2- | tr -d "\"' ")
sed -i "s|^RH_API_TOKEN=.*|RH_API_TOKEN=$TOKEN_RH|" .env
grep -q '^GASTOS_RESUMO=' .env || printf '\n# Fechamento do dia no grupo\nGASTOS_RESUMO=on\nGASTOS_RESUMO_HORA=18:00\n' >> .env
chmod 600 .env
echo "--- .env do servidor, com os valores encurtados: ---"
grep -v '^\s*#' .env | grep . | sed 's/=\(.\{8\}\).*/=\1…/'
grep -q "RH_API_TOKEN=$TOKEN_RH" .env && [ ${#TOKEN_RH} -gt 10 ] && echo "✅ token do RH veio do .env do RH" || echo "❌ token do RH VAZIO — pare aqui e me avise"
```

**Repare nas duas linhas que ele troca**, e por que:

- `RH_API_URL` vira `localhost`, porque no servidor o RH está na mesma
  máquina;
- `RH_API_TOKEN` é **substituído pelo do próprio RH**. O que está no seu PC é
  `token-de-…`, um valor de exemplo que nunca funcionou — o RH devolveria 401
  em tudo, e você passaria a tarde procurando o motivo.

## 3B — Com chaves novas (quando for para valer)

Gere as duas novas nos endereços lá de cima e cole este bloco. Ele pergunta
as duas e resolve o resto sozinho:

```bash
cd ~/recrutamento-bot
read -p "Chave NOVA do Gemini: " GEMINI
read -p "Token NOVO do sistema de obras: " OBRAS
TOKEN_RH=$(grep -m1 '^RECRUTAMENTO_BOT_TOKEN=' ~/nova-gestao-rh/.env | cut -d= -f2- | tr -d "\"' ")
cat > .env <<FIM
PORT=3100

# O RH roda nesta mesma máquina — sem rede no meio.
RH_API_URL=http://localhost:3000
RH_API_TOKEN=$TOKEN_RH
WEBHOOK_SEGREDO=$(openssl rand -hex 24)
EMPRESA_NOME=KE Engenharia
GEMINI_API_KEY=$GEMINI

# WhatsApp pelo chip dedicado (+55 11 95826-7769)
CONNECTOR=baileys

# ── Módulo de gastos ──
OBRAS_API_URL=https://novagestaoobras.duckdns.org
OBRAS_API_TOKEN=$OBRAS
GASTOS_GRUPOS=Comprovantes
GASTOS_AUTORIZADOS=*
GASTOS_OBRAS=EE DR FRANCISCO PEREIRA DA ROCHA,EE OSWALDO LUIZ SANCHES TOSCHI,EE PROFA TSUYA OHNO KIMURA,EE VER EGILDO PASCHOALUCCI,EE/ETEC AGUIA DE HAIA,Escola Ambiental - Itapevi

# Fechamento do dia no grupo, às 18h
GASTOS_RESUMO=on
GASTOS_RESUMO_HORA=18:00
FIM
chmod 600 .env
echo "--- .env escrito, com os valores encurtados: ---"
sed 's/=\(.\{8\}\).*/=\1…/' .env
grep -q 'RH_API_TOKEN=.\{10,\}' .env && echo "✅ token do RH veio do .env do RH" || echo "❌ token do RH VAZIO — pare aqui e me avise"
```

O `GASTOS_OBRAS` é só uma reserva para quando o sistema de obras não
responder — a lista de verdade ele busca lá, sozinho.

# Passo 4 — Ler o QR code (uma vez só)

**Maximize a janela do PowerShell antes.** Janela pequena corta o QR e o
celular não lê.

```bash
cd ~/recrutamento-bot && npm start
```

No celular **do chip dedicado**: WhatsApp → Configurações → Aparelhos
conectados → Conectar aparelho → aponte para o QR na tela.

Espere aparecer estas quatro linhas:

```
✅ WhatsApp conectado no número 5511958267769
[whatsapp] ✅ grupo "Comprovantes" encontrado (120363413147794205@g.us)
[gastos] no ar — quem pode lançar: qualquer um dos grupos cadastrados
[atendimento] RH respondendo em http://localhost:3000
```

Se aparecer o aviso `⚠️ O RECRUTAMENTO ESTÁ LIGADO E O RH NÃO RESPONDE`, pare
aqui e me avise — quer dizer que o RH não está de pé nessa máquina.

Deu tudo certo? `Ctrl+C`. A sessão fica salva em `dados/whatsapp` e não pede
QR de novo.

# Passo 5 — Deixar rodando sozinho

O nome `recrutamento-bot` **não é opcional** — é por ele que o auto-deploy
encontra o processo:

```bash
cd ~/recrutamento-bot && pm2 start npm --name recrutamento-bot -- start && pm2 save && pm2 list
```

# Passo 6 — Conferir

```bash
curl -s localhost:3100/metricas
```

E no grupo do WhatsApp, mande **`ping`**. Ele tem que responder.

---

# Depois

## Limpar o seu PC

A pasta `dados/whatsapp` do seu computador guarda as **credenciais da sessão**
— quem tiver esses arquivos entra no WhatsApp do robô sem ler QR nenhum. No
PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Remove-Item -Recurse -Force "D:\Projetos-de-Codigos\LexDocs VAdvocacia\recrutamento-bot\dados"
```

## Atualizar daqui para a frente

Você **não precisa mais entrar no servidor**. Eu faço `git push`, e em até 2
minutos o auto-deploy põe no ar.

Para ver o que está acontecendo:

```powershell
ssh -i "D:\Projetos-de-Codigos\Chaves de acesso\AWS RH\chave-rh.pem" ubuntu@56.126.66.124 "pm2 logs recrutamento-bot --lines 40 --nostream"
```

## Se precisar reiniciar

```bash
pm2 restart recrutamento-bot && pm2 logs recrutamento-bot --lines 20 --nostream
```

---

# Duas coisas que NÃO fazer

**Não abra a porta 3100 no security group.** Com `CONNECTOR=baileys` o robô
não recebe webhook nenhum — quem procura o WhatsApp é ele. A porta só precisa
existir para o RH chamar em `localhost`. Aberta, é uma porta a mais exposta à
internet sem necessidade alguma.

**Não copie a pasta `dados/` do seu PC para o servidor.** Deixe ele parear do
zero. Copiar a sessão significa dois aparelhos usando as mesmas credenciais, e
é o tipo de coisa que faz o WhatsApp desconfiar do número.
