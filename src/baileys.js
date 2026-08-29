/**
 * Conexão com o WhatsApp pelo Baileys.
 *
 * É a via NÃO OFICIAL: o robô se conecta como se fosse mais um aparelho seu,
 * lendo um QR code igual ao WhatsApp Web. Funciona hoje e não custa nada,
 * mas o número pode ser bloqueado pelo WhatsApp — por isso ele nunca deve ser
 * o número principal da empresa.
 *
 * Enquanto a verificação da Meta não sai (1 a 2 semanas), é isto que põe a
 * Maria Vitória no ar. Quando sair, troca-se CONNECTOR=cloud no .env e este
 * arquivo pode ficar como estava, sem mexer no resto.
 *
 * Cuidados que reduzem o risco de bloqueio, e por quê:
 *
 *  - Só responde a conversa de UMA pessoa. Grupo, lista de transmissão e
 *    status são ignorados: robô que fala em grupo é o padrão que mais leva
 *    a denúncia.
 *  - Nunca inicia conversa. Só responde quem falou primeiro.
 *  - Espera alguns segundos e mostra "digitando…" antes de responder. Robô
 *    que responde em 200ms é reconhecível por qualquer sistema antifraude.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import qrcode from 'qrcode-terminal'
import pino from 'pino'

/** Onde a sessão fica guardada. */
const PASTA_SESSAO = process.env.BAILEYS_SESSAO || join(process.cwd(), 'dados', 'whatsapp')

/**
 * Quanto esperar antes de responder.
 *
 * Uma pessoa do RH não responde no mesmo segundo. O intervalo é sorteado
 * dentro desta faixa para o ritmo não ficar mecânico.
 */
const ESPERA_MIN_MS = Number(process.env.BAILEYS_ESPERA_MIN || 2000)
const ESPERA_MAX_MS = Number(process.env.BAILEYS_ESPERA_MAX || 5000)

let sock = null
let conectado = false

function espera(ms) {
  return new Promise(r => setTimeout(r, ms))
}

/** Espera um tempo variável, proporcional ao tamanho da resposta. */
function tempoDeDigitacao(texto) {
  const base = ESPERA_MIN_MS + Math.random() * (ESPERA_MAX_MS - ESPERA_MIN_MS)
  // ~40ms por caractere, com teto: resposta longa demora mais, mas ninguém
  // espera meio minuto.
  return Math.min(base + texto.length * 40, 12000)
}

/** É conversa individual de uma pessoa de verdade? */
function ehConversaPessoal(msg) {
  const jid = msg.key?.remoteJid ?? ''
  if (msg.key?.fromMe) return false          // eco da própria resposta
  if (jid.endsWith('@g.us')) return false    // grupo
  if (jid === 'status@broadcast') return false
  if (jid.endsWith('@broadcast')) return false
  if (jid.endsWith('@newsletter')) return false
  return jid.endsWith('@s.whatsapp.net')
}

/** O texto da mensagem, em qualquer um dos formatos que o WhatsApp usa. */
function textoDaMensagem(msg) {
  const m = msg.message
  if (!m) return null
  return m.conversation
    ?? m.extendedTextMessage?.text
    ?? m.imageMessage?.caption
    ?? m.videoMessage?.caption
    ?? m.buttonsResponseMessage?.selectedDisplayText
    ?? m.listResponseMessage?.title
    ?? null
}

/** Só os dígitos do número, para casar com o que o RH guarda. */
function numeroDoJid(jid) {
  return (jid ?? '').split('@')[0].split(':')[0]
}

/**
 * Abre a conexão.
 *
 * `aoReceber(numero, texto)` deve devolver o texto da resposta (ou nada).
 */
export async function conectar(aoReceber) {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } =
    await import('@whiskeysockets/baileys')

  if (!existsSync(PASTA_SESSAO)) mkdirSync(PASTA_SESSAO, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    // O Baileys é falante demais no nível padrão; só o que importa aparece.
    logger: pino({ level: 'error' }),
    // Marcar-se como online o tempo todo faz o celular da pessoa parar de
    // receber notificação das mensagens — e ela reclama que "não chega nada".
    markOnlineOnConnect: false,
    browser: ['Nova Gestão RH', 'Chrome', '1.0.0'],
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u

    if (qr) {
      console.log('\n📱 Leia este QR code no WhatsApp do número do robô:')
      console.log('   WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho\n')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'open') {
      conectado = true
      const meu = numeroDoJid(sock.user?.id)
      console.log(`\n✅ WhatsApp conectado no número ${meu}. A Maria Vitória está atendendo.\n`)
    }

    if (connection === 'close') {
      conectado = false
      const motivo = lastDisconnect?.error?.output?.statusCode

      // Sessão encerrada de propósito (desconectado no celular) — reconectar
      // em laço só geraria erro infinito. Precisa ler o QR de novo.
      if (motivo === DisconnectReason.loggedOut) {
        console.error(
          '\n❌ A sessão foi encerrada no celular.\n'
          + `   Apague a pasta ${PASTA_SESSAO} e rode de novo para ler outro QR code.\n`,
        )
        return
      }

      console.warn(`[whatsapp] conexão caiu (${motivo ?? 'motivo desconhecido'}) — reconectando em 5s…`)
      setTimeout(() => conectar(aoReceber), 5000)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' é mensagem chegando agora. 'append' é histórico sendo
    // sincronizado — responder a isso faria o robô reagir a conversas
    // antigas ao reconectar, mandando mensagem para quem não falou nada.
    if (type !== 'notify') return

    for (const msg of messages) {
      if (!ehConversaPessoal(msg)) continue

      const texto = textoDaMensagem(msg)
      const jid = msg.key.remoteJid
      if (!texto?.trim()) {
        // Áudio, figurinha, documento. Ela não processa, mas ficar muda é
        // pior: a pessoa acha que não chegou.
        await responder(jid, 'Consigo ler só mensagem de texto, viu? Pode escrever aí que eu te ajudo. 🙂')
        continue
      }

      const numero = numeroDoJid(jid)
      try {
        const resposta = await aoReceber(numero, texto.trim())
        if (resposta) await responder(jid, resposta)
      } catch (e) {
        console.error('[whatsapp] erro ao atender:', e.message)
        await responder(jid, 'Tive um probleminha aqui no sistema. Pode repetir, por favor?')
      }
    }
  })

  return sock
}

/** Envia, com a pausa e o "digitando…" que fazem parecer gente. */
async function responder(jid, texto) {
  if (!sock) return { ok: false }
  try {
    await sock.presenceSubscribe(jid)
    await sock.sendPresenceUpdate('composing', jid)
    await espera(tempoDeDigitacao(texto))
    await sock.sendPresenceUpdate('paused', jid)
    await sock.sendMessage(jid, { text: texto })
    return { ok: true }
  } catch (e) {
    console.error('[whatsapp] não consegui enviar:', e.message)
    return { ok: false, erro: e.message }
  }
}

/** Envio avulso, para o resto do serviço usar. */
export async function enviarPorBaileys(numero, texto) {
  const jid = numero.includes('@') ? numero : `${numero.replace(/\D/g, '')}@s.whatsapp.net`
  return responder(jid, texto)
}

export function estaConectado() {
  return conectado
}
