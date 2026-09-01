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
 *  - Só responde conversa de UMA pessoa, e os grupos que estiverem em
 *    GASTOS_GRUPOS. Lista de transmissão, status e todo grupo não listado
 *    são ignorados: robô que fala em grupo é o padrão que mais leva a
 *    denúncia, e o robô só tem o que fazer no grupo dos comprovantes.
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

/**
 * Os grupos onde o robô tem o que fazer.
 *
 * Só o dos comprovantes. Estar num grupo e ficar calado é o padrão; a
 * exceção é explícita e vem da mesma variável que o módulo de gastos usa,
 * para não haver duas listas divergindo.
 */
const GRUPOS_ATENDIDOS = new Set(
  (process.env.GASTOS_GRUPOS || '').split(',').map(g => g.trim()).filter(Boolean),
)

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

/**
 * Modo descoberta.
 *
 * Ninguém sabe de cabeça o identificador de um grupo do WhatsApp, e sem ele
 * não dá para preencher GASTOS_GRUPOS. Com GASTOS_DESCOBRIR_GRUPOS=1 o robô
 * imprime o identificador de cada grupo em que vê mensagem — é só mandar um
 * "oi" no grupo dos comprovantes, copiar a linha e desligar.
 *
 * Fica desligado por padrão: é diagnóstico, e ligado o tempo todo encheria o
 * log com todo grupo de que o número participa.
 */
const DESCOBRIR = process.env.GASTOS_DESCOBRIR_GRUPOS === '1'
const jaMostrados = new Set()

function mostrarGrupo(jid, msg) {
  if (!DESCOBRIR || jaMostrados.has(jid)) return
  jaMostrados.add(jid)
  console.log(
    `\n[descoberta] grupo "${msg.pushName ?? '?'}" → GASTOS_GRUPOS=${jid}`
    + `\n             quem falou → GASTOS_AUTORIZADOS=${numeroDoJid(msg.key.participant ?? '')}\n`,
  )
}

/** É um grupo que o robô acompanha? */
function ehGrupoAtendido(msg) {
  const jid = msg.key?.remoteJid ?? ''
  if (msg.key?.fromMe) return false
  if (!jid.endsWith('@g.us')) return false
  return GRUPOS_ATENDIDOS.has(jid) || GRUPOS_ATENDIDOS.has(jid.split('@')[0])
}

/**
 * A parte da mensagem que carrega um arquivo, se houver.
 *
 * PDF chega como documentMessage e foto como imageMessage — os dois valem
 * como comprovante. Áudio, vídeo e figurinha não.
 */
function anexoDaMensagem(msg) {
  const m = msg.message ?? {}
  const img = m.imageMessage
  if (img) return { tipo: img.mimetype || 'image/jpeg', nome: 'comprovante.jpg' }
  const doc = m.documentMessage ?? m.documentWithCaptionMessage?.message?.documentMessage
  if (doc) {
    const tipo = doc.mimetype || ''
    if (tipo.startsWith('image/') || tipo === 'application/pdf') {
      return { tipo, nome: doc.fileName || 'comprovante' }
    }
  }
  return null
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
      const pessoal = ehConversaPessoal(msg)
      const grupo = !pessoal && ehGrupoAtendido(msg)
      if (!pessoal && !grupo) {
        if (!msg.key?.fromMe && (msg.key?.remoteJid ?? '').endsWith('@g.us')) {
          mostrarGrupo(msg.key.remoteJid, msg)
        }
        continue
      }

      const jid = msg.key.remoteJid
      const texto = textoDaMensagem(msg)
      const anexo = anexoDaMensagem(msg)

      // Num grupo, quem falou é o participante — remoteJid é o grupo. Sem
      // isso a lista de autorizados compararia com o id do grupo, e nunca
      // ninguém passaria.
      const de = numeroDoJid(grupo ? (msg.key.participant ?? '') : jid)

      if (pessoal && !anexo && !texto?.trim()) {
        // Áudio ou figurinha na conversa de candidato. Ela não processa, mas
        // ficar muda é pior: a pessoa acha que não chegou.
        await responder(jid, 'Consigo ler só mensagem de texto, viu? Pode escrever aí que eu te ajudo. 🙂')
        continue
      }

      try {
        const arquivo = anexo ? await baixar(msg) : null
        const resposta = await aoReceber({
          canal: 'whatsapp',
          de,
          chat: grupo ? jid : de,
          ehGrupo: grupo,
          texto: texto?.trim() || null,
          arquivo,
          tipo: anexo?.tipo ?? null,
          nomeArquivo: anexo?.nome ?? null,
          // Id da mensagem do WhatsApp: é o que garante a idempotência do
          // envio ao sistema de obras, e é estável entre reentregas.
          idMensagem: msg.key.id,
          // Quando a mensagem foi enviada — é esta a data do lançamento, e
          // não a que a IA leu no papel. Vem em segundos, não milissegundos.
          enviadoEm: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
        })
        // Em grupo, responde citando a mensagem: com várias pessoas mandando
        // comprovante junto, confirmação solta não diz de qual foto é.
        if (resposta) await responder(jid, resposta, { citar: grupo ? msg : null, rapido: grupo })
      } catch (e) {
        console.error('[whatsapp] erro ao atender:', e.message)
        if (pessoal) await responder(jid, 'Tive um probleminha aqui no sistema. Pode repetir, por favor?')
      }
    }
  })

  return sock
}

/**
 * Baixa o arquivo da mensagem.
 *
 * Devolve null se não der: o comprovante não chega ao sistema de obras, mas
 * a conexão não cai e as outras mensagens seguem sendo atendidas.
 */
async function baixar(msg) {
  try {
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys')
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: pino({ level: 'error' }),
      reuploadRequest: sock.updateMediaMessage,
    })
    return buffer?.length ? buffer : null
  } catch (e) {
    console.error('[whatsapp] não consegui baixar o arquivo:', e.message)
    return null
  }
}

/** Envia, com a pausa e o "digitando…" que fazem parecer gente. */
async function responder(jid, texto, { citar = null, rapido = false } = {}) {
  if (!sock) return { ok: false }
  try {
    // A pausa existe para o robô não se denunciar na conversa com candidato.
    // No grupo interno todo mundo sabe que é robô, e demorar 10 segundos
    // para confirmar um comprovante só atrapalha quem está mandando vinte.
    if (!rapido) {
      await sock.presenceSubscribe(jid)
      await sock.sendPresenceUpdate('composing', jid)
      await espera(tempoDeDigitacao(texto))
      await sock.sendPresenceUpdate('paused', jid)
    }
    await sock.sendMessage(jid, { text: texto }, citar ? { quoted: citar } : {})
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
