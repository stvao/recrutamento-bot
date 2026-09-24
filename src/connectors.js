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
    if (CONNECTOR === 'baileys') {
      const { enviarPorBaileys } = await import('./baileys.js')
      return await enviarPorBaileys(para, texto)
    }
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
 * O canal está pronto para enviar?
 *
 * Os lembretes e o resumo das 8h marcavam "enviado" ANTES de mandar, e com a
 * sessão do WhatsApp caída (esperando alguém ler o QR) o envio falhava em
 * silêncio: o lembrete de cadastro é único por regra, e o RH nunca devolvia
 * aquele número de novo. Ninguém recebia nada, e ninguém ficava sabendo.
 */
export async function conectado() {
  if (CONNECTOR !== 'baileys') return true
  try {
    const { estaConectado } = await import('./baileys.js')
    return estaConectado()
  } catch {
    return false
  }
}

/**
 * Normaliza o payload do webhook para o formato que o roteador entende —
 * o MESMO que o Baileys e o Telegram entregam:
 *
 *   { canal, de, chat, ehGrupo, texto, arquivo, tipo, nomeArquivo, idMensagem }
 *
 * `arquivo` vem null aqui: o webhook traz só o id da mídia, e baixar exige
 * outra chamada. Quem trata resolve isso com baixarMidiaCloud(), já que o
 * download não deve atrasar o 200 que a Meta espera.
 *
 * Retorna null se não for mensagem de entrada aproveitável.
 */
export function parseWebhook(body) {
  // WhatsApp Cloud API (oficial)
  try {
    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
    if (msg?.from) {
      const midia = msg.image ?? msg.document
      const tipo = midia?.mime_type ?? null
      const serve = tipo && (tipo.startsWith('image/') || tipo === 'application/pdf')
      const texto = msg.text?.body ?? midia?.caption ?? null
      if (texto || serve) {
        return {
          canal: 'whatsapp-cloud',
          de: String(msg.from),
          chat: String(msg.from),
          // A API oficial não entrega mensagem de grupo. Não é configuração:
          // é limite da plataforma, e vale para receber e para enviar.
          ehGrupo: false,
          texto: texto?.trim() || null,
          arquivo: null,
          mediaId: serve ? midia.id : null,
          tipo: serve ? tipo : null,
          nomeArquivo: msg.document?.filename ?? (serve ? 'comprovante.jpg' : null),
          // Id da mensagem da Meta: estável entre reentregas, que é
          // exatamente o que a idempotência do sistema de obras precisa.
          idMensagem: msg.id,
          // Data do envio, que é a do lançamento. A Meta manda em segundos.
          enviadoEm: msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now(),
        }
        // enviarResposta é acrescentado por quem trata o webhook: aqui só se
        // interpreta o payload, e mandar mensagem é outra responsabilidade.
      }
    }
  } catch {}

  // Z-API (formato comum)
  if (body?.phone && (body?.text?.message || body?.message)) {
    return {
      canal: 'zapi',
      de: String(body.phone),
      chat: String(body.phone),
      ehGrupo: Boolean(body.isGroup),
      texto: body.text?.message ?? body.message,
      arquivo: null,
      mediaId: null,
      tipo: null,
      nomeArquivo: null,
      idMensagem: body.messageId ?? body.id ?? null,
    }
  }
  return null
}

/**
 * Baixa uma mídia da Cloud API.
 *
 * São duas chamadas de propósito, é assim que a Meta expõe: primeiro se
 * pergunta a URL do arquivo pelo id, depois se baixa dela — e a segunda
 * também exige o token, porque a URL é assinada mas não é pública.
 *
 * Devolve null se não der: o comprovante não chega ao sistema de obras, mas
 * quem enviou recebe resposta em vez de silêncio.
 */
export async function baixarMidiaCloud(mediaId) {
  const token = process.env.CLOUD_TOKEN
  if (!token || !mediaId) return null
  try {
    const info = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!info.ok) throw new Error(`HTTP ${info.status} ao pedir a URL`)
    const { url } = await info.json()
    if (!url) throw new Error('resposta sem url')

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status} ao baixar`)
    return Buffer.from(await r.arrayBuffer())
  } catch (e) {
    console.error('[connector] não consegui baixar a mídia:', e.message)
    return null
  }
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
