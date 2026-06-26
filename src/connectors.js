/**
 * Adaptador de conexão do WhatsApp. Troque CONNECTOR no .env quando escolher a
 * via — o resto do robô (cérebro + envio ao RH) não muda.
 *   none  → não envia (modo teste)
 *   zapi  → Z-API (não-oficial)
 *   cloud → WhatsApp Cloud API (oficial Meta)
 */
const CONNECTOR = process.env.CONNECTOR || 'none'

/** Envia uma mensagem de texto para um número. Best-effort. */
export async function enviarMensagem(para, texto) {
  try {
    if (CONNECTOR === 'zapi') return await enviarZapi(para, texto)
    if (CONNECTOR === 'cloud') return await enviarCloud(para, texto)
    // none: apenas loga (modo teste/simulador)
    console.log(`[connector:none] → ${para}: ${texto.replace(/\n/g, ' / ')}`)
    return { ok: true, simulado: true }
  } catch (e) {
    console.error('[connector] falha ao enviar:', e.message)
    return { ok: false, motivo: e.message }
  }
}

/**
 * Extrai { from, text } do payload recebido no webhook, conforme o provedor.
 * Retorna null se não for uma mensagem de texto de entrada.
 */
export function parseWebhook(body) {
  // WhatsApp Cloud API (oficial)
  try {
    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
    if (msg?.from && msg?.text?.body) return { from: msg.from, text: msg.text.body }
  } catch {}
  // Z-API (formato comum)
  if (body?.phone && (body?.text?.message || body?.message)) {
    return { from: String(body.phone), text: body.text?.message ?? body.message }
  }
  return null
}

async function enviarZapi(para, texto) {
  const base = process.env.ZAPI_BASE_URL
  const token = process.env.ZAPI_TOKEN
  if (!base) throw new Error('ZAPI_BASE_URL ausente')
  const r = await fetch(`${base}/send-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'Client-Token': token } : {}) },
    body: JSON.stringify({ phone: para, message: texto }),
    signal: AbortSignal.timeout(8000),
  })
  return { ok: r.ok, status: r.status }
}

async function enviarCloud(para, texto) {
  const token = process.env.CLOUD_TOKEN
  const phoneId = process.env.CLOUD_PHONE_NUMBER_ID
  if (!token || !phoneId) throw new Error('CLOUD_TOKEN/CLOUD_PHONE_NUMBER_ID ausentes')
  const r = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: para, type: 'text', text: { body: texto } }),
    signal: AbortSignal.timeout(8000),
  })
  return { ok: r.ok, status: r.status }
}
