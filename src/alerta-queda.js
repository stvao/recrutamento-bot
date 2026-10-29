/**
 * Aviso pelo Telegram quando o WhatsApp do robô cai — e quando volta.
 *
 * Em 28/10/2026 o WhatsApp tirou o robô dos aparelhos conectados e ele ficou
 * mais de um dia fora sem ninguém saber: a central mostrava "WhatsApp
 * desconectado" e os candidatos ficavam sem resposta. Agora quem cuida do
 * sistema recebe uma mensagem.
 *
 * Usa um bot do Telegram SÓ PARA ENVIAR (sendMessage). Pode ser o mesmo bot
 * de outras notificações (o do Cultivia, por exemplo): como não lê mensagens
 * (getUpdates), não disputa nada com quem já usa o bot.
 *
 * .env:
 *   ALERTA_TELEGRAM_TOKEN=   token do bot (sem ele, cai no TELEGRAM_TOKEN)
 *   ALERTA_TELEGRAM_CHAT=    chat que recebe; vários separados por vírgula
 *
 * Quando avisa:
 *   - sessão encerrada no celular (precisa ler o QR): na hora;
 *   - outra queda: só se continuar fora depois de 2 min (queda de rede que
 *     o próprio robô resolve não merece mensagem);
 *   - enquanto continuar fora: lembrete a cada 6 h;
 *   - quando volta, se tinha avisado da queda.
 */

const ESPERA_QUEDA_MS = 2 * 60 * 1000
const LEMBRETE_MS = 6 * 60 * 60 * 1000

let caiuEm = null          // quando caiu (ms), null = conectado
let avisouQueda = false
let timerQueda = null
let timerLembrete = null

function config() {
  const token = process.env.ALERTA_TELEGRAM_TOKEN || process.env.TELEGRAM_TOKEN || ''
  const chats = (process.env.ALERTA_TELEGRAM_CHAT || '').split(',').map(s => s.trim()).filter(Boolean)
  return { token, chats }
}

export function alertaConfigurado() {
  const { token, chats } = config()
  return Boolean(token && chats.length)
}

/** Envia para todos os chats. Nunca lança: aviso que falha não pode derrubar o robô. */
export async function enviarAlerta(texto) {
  const { token, chats } = config()
  if (!token || !chats.length) {
    console.warn('[alerta] Telegram de alerta não configurado (ALERTA_TELEGRAM_TOKEN / ALERTA_TELEGRAM_CHAT):', texto.split('\n')[0])
    return false
  }
  let algum = false
  for (const chat of chats) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: texto, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15000),
      })
      const j = await r.json().catch(() => ({}))
      if (j.ok) algum = true
      else console.warn('[alerta] Telegram recusou:', j.description ?? r.status)
    } catch (e) {
      console.warn('[alerta] não consegui avisar pelo Telegram:', e.message)
    }
  }
  return algum
}

const hora = (ms) => new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

function duracao(ms) {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60), m = min % 60
  return h < 48 ? `${h}h${m ? String(m).padStart(2, '0') : ''}` : `${Math.round(h / 24)} dias`
}

const COMO_RELIGAR = 'Para religar: no celular da empresa, WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho, e ler o QR que o robô mostra no servidor (pm2 logs recrutamento-bot).'

function lembrar(precisaQr) {
  clearInterval(timerLembrete)
  timerLembrete = setInterval(() => {
    if (caiuEm == null) return clearInterval(timerLembrete)
    void enviarAlerta(
      `⏰ O WhatsApp do robô continua desconectado — há ${duracao(Date.now() - caiuEm)} (desde ${hora(caiuEm)}).\n`
      + 'Os candidatos não estão recebendo resposta e a central de atendimento não envia mensagens.'
      + (precisaQr ? `\n\n${COMO_RELIGAR}` : ''),
    )
  }, LEMBRETE_MS)
}

/**
 * O WhatsApp caiu. `precisaQr` = a sessão foi encerrada no celular (ou o
 * aparelho foi removido): não volta sozinho, alguém precisa ler o QR.
 */
export function whatsappCaiu({ motivo, precisaQr = false, numero = null } = {}) {
  if (caiuEm == null) caiuEm = Date.now()
  const texto = precisaQr
    ? `🔴 WhatsApp do robô DESCONECTADO${numero ? ` (${numero})` : ''} — o aparelho foi removido no celular e não volta sozinho.\n\n${COMO_RELIGAR}`
    : `🟠 WhatsApp do robô caiu${numero ? ` (${numero})` : ''} e não voltou em 2 minutos (motivo: ${motivo ?? 'desconhecido'}).\n`
      + 'O robô segue tentando reconectar sozinho. Se não voltar, pode ser preciso ler o QR de novo.'

  clearTimeout(timerQueda)
  if (precisaQr) {
    avisouQueda = true
    void enviarAlerta(texto)
    lembrar(true)
    return
  }
  if (avisouQueda) return
  timerQueda = setTimeout(() => {
    if (caiuEm == null) return
    avisouQueda = true
    void enviarAlerta(texto)
    lembrar(false)
  }, ESPERA_QUEDA_MS)
}

/** Conectou. Se tinha avisado da queda, avisa que voltou. */
export function whatsappConectou(numero = null) {
  clearTimeout(timerQueda)
  clearInterval(timerLembrete)
  const desde = caiuEm
  const tinhaAvisado = avisouQueda
  caiuEm = null
  avisouQueda = false
  if (tinhaAvisado && desde != null) {
    void enviarAlerta(`🟢 WhatsApp do robô voltou${numero ? ` (${numero})` : ''}. Ficou fora ${duracao(Date.now() - desde)}.`)
  }
}

/** Só para teste. */
export function _estado() { return { caiuEm, avisouQueda } }
export function _zerar() { clearTimeout(timerQueda); clearInterval(timerLembrete); caiuEm = null; avisouQueda = false }
