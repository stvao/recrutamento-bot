/**
 * Conexão com o Telegram.
 *
 * Existe como alternativa ao WhatsApp para o módulo de gastos, por dois
 * motivos práticos:
 *
 *  - Ler GRUPO é suportado e documentado. A API oficial da Meta não entrega
 *    mensagem de grupo de jeito nenhum, e o Baileys só faz isso na condição
 *    de aparelho vinculado, com o número podendo ser bloqueado.
 *  - Não tem verificação, documento nem espera. Fala-se com o @BotFather,
 *    manda-se /newbot, e ele devolve o token.
 *
 * Usa long polling em vez de webhook de propósito: assim não precisa de
 * domínio, porta aberta nem certificado. O robô é quem procura mensagem
 * nova, então funciona igual atrás de qualquer rede.
 *
 * IMPORTANTE, e é o passo que todo mundo esquece: por padrão um bot só
 * enxerga mensagens que o citam. Para ele ver os comprovantes do grupo,
 * desligue o modo privacidade no @BotFather:
 *   /mybots → o bot → Bot Settings → Group Privacy → Turn off
 * Depois REMOVA e adicione o bot no grupo de novo — a mudança não vale para
 * os grupos onde ele já estava.
 */
const TOKEN = process.env.TELEGRAM_TOKEN || ''
const API = `https://api.telegram.org/bot${TOKEN}`

/** Acima disso a própria API do Telegram recusa o download. */
const TAMANHO_MAXIMO = 20 * 1024 * 1024

let rodando = false
let ultimoUpdate = 0

export function telegramConfigurado() {
  return Boolean(TOKEN)
}

async function chamar(metodo, parametros) {
  const r = await fetch(`${API}/${metodo}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parametros),
    // 65s: acima do timeout de 60s do long polling, senão a espera normal
    // seria abortada como se fosse falha.
    signal: AbortSignal.timeout(65000),
  })
  const j = await r.json()
  if (!j.ok) throw new Error(j.description || `Telegram respondeu ${r.status}`)
  return j.result
}

/**
 * O anexo da mensagem, se for coisa que sirva de comprovante.
 *
 * `photo` vem como uma lista de tamanhos, do menor para o maior — o último é
 * o de maior resolução, e é o único que presta para ler valor em cupom.
 */
function anexoDaMensagem(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const maior = msg.photo[msg.photo.length - 1]
    return { fileId: maior.file_id, tipo: 'image/jpeg', nome: 'comprovante.jpg', tamanho: maior.file_size }
  }
  const doc = msg.document
  if (doc) {
    const tipo = doc.mime_type || ''
    if (tipo.startsWith('image/') || tipo === 'application/pdf') {
      return { fileId: doc.file_id, tipo, nome: doc.file_name || 'comprovante', tamanho: doc.file_size }
    }
  }
  return null
}

/** Baixa o arquivo. Devolve null se não der — quem chama segue sem ele. */
async function baixar(anexo) {
  try {
    if (anexo.tamanho > TAMANHO_MAXIMO) {
      console.warn('[telegram] arquivo grande demais para baixar:', anexo.tamanho)
      return null
    }
    const info = await chamar('getFile', { file_id: anexo.fileId })
    const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${info.file_path}`, {
      signal: AbortSignal.timeout(30000),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  } catch (e) {
    console.error('[telegram] não consegui baixar o arquivo:', e.message)
    return null
  }
}

/**
 * Abre a conexão e fica ouvindo.
 *
 * `aoReceber(msg)` recebe o mesmo formato que o Baileys entrega, e é o que
 * permite o módulo de gastos não saber por onde a foto chegou.
 */
export async function conectar(aoReceber) {
  if (!TOKEN) throw new Error('TELEGRAM_TOKEN ausente')

  const eu = await chamar('getMe', {})
  console.log(`\n✅ Telegram conectado como @${eu.username}. Adicione o bot no grupo dos comprovantes.\n`)
  rodando = true

  // Laço próprio, e não setInterval: a próxima busca só começa quando a
  // anterior terminou. Com intervalo fixo, uma busca lenta empilharia outra
  // por cima e as duas receberiam o mesmo update.
  while (rodando) {
    try {
      const updates = await chamar('getUpdates', {
        offset: ultimoUpdate + 1,
        timeout: 60,                                  // long polling
        allowed_updates: ['message', 'channel_post'],
      })

      for (const u of updates) {
        ultimoUpdate = Math.max(ultimoUpdate, u.update_id)
        const msg = u.message ?? u.channel_post
        if (!msg || msg.from?.is_bot) continue

        // Mesmo problema do WhatsApp: ninguém sabe de cabeça o id de um
        // chat do Telegram, e sem ele não dá para preencher GASTOS_GRUPOS.
        // Mande um "oi" no grupo com GASTOS_DESCOBRIR_GRUPOS=1, copie a
        // linha e desligue.
        if (process.env.GASTOS_DESCOBRIR_GRUPOS === '1') {
          console.log(
            `\n[descoberta] chat "${msg.chat.title ?? msg.chat.type}" → GASTOS_GRUPOS=${msg.chat.id}`
            + `\n             quem falou "${msg.from?.first_name ?? '?'}" → GASTOS_AUTORIZADOS=${msg.from?.id}\n`,
          )
        }

        const anexo = anexoDaMensagem(msg)
        const texto = msg.caption ?? msg.text ?? null
        if (!anexo && !texto?.trim()) continue

        try {
          const resposta = await aoReceber({
            canal: 'telegram',
            // Telegram identifica gente por id numérico, não por telefone.
            // GASTOS_AUTORIZADOS guarda esse id do mesmo jeito — é só um
            // número, e a lista não precisa saber de onde ele veio.
            de: String(msg.from?.id ?? ''),
            chat: String(msg.chat.id),
            chatNome: msg.chat.title ?? null,
            ehGrupo: msg.chat.type !== 'private',
            texto: texto?.trim() || null,
            arquivo: anexo ? await baixar(anexo) : null,
            tipo: anexo?.tipo ?? null,
            nomeArquivo: anexo?.nome ?? null,
            // Chat + mensagem, porque message_id só é único dentro do chat.
            // É o que garante a idempotência do envio ao sistema de obras.
            idMensagem: `tg:${msg.chat.id}:${msg.message_id}`,
            // Data do envio, que é a do lançamento. Telegram manda em
            // segundos.
            enviadoEm: msg.date ? msg.date * 1000 : Date.now(),
          })
          if (resposta) await enviarPorTelegram(msg.chat.id, resposta, msg.message_id)
        } catch (e) {
          console.error('[telegram] erro ao atender:', e.message)
        }
      }
    } catch (e) {
      // Timeout do long polling sem mensagem nenhuma é o caso normal, não
      // erro: registrar isso encheria o log de linha inútil.
      if (e.name !== 'TimeoutError' && e.name !== 'AbortError') {
        console.warn('[telegram] falha ao buscar mensagens:', e.message)
        await new Promise(r => setTimeout(r, 5000))
      }
    }
  }
}

/**
 * Envia uma mensagem.
 *
 * `responderA` cita a mensagem original: com várias pessoas mandando
 * comprovante ao mesmo tempo, confirmação solta não diz de qual foto é.
 */
export async function enviarPorTelegram(chatId, texto, responderA = null) {
  if (!TOKEN) return { ok: false, motivo: 'nao-configurado' }
  try {
    await chamar('sendMessage', {
      chat_id: chatId,
      text: texto,
      ...(responderA ? { reply_parameters: { message_id: responderA, allow_sending_without_reply: true } } : {}),
    })
    return { ok: true }
  } catch (e) {
    console.error('[telegram] não consegui enviar:', e.message)
    return { ok: false, motivo: e.message }
  }
}

export function desconectar() {
  rodando = false
}
