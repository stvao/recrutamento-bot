/**
 * Cobrança de diário de obras e presença, pelo WhatsApp do DONO.
 *
 * Processo à parte do robô de recrutamento (pm2 `cobranca-obras`), com a
 * própria sessão: mexer num não derruba o outro, e o número do recrutamento
 * continua só do recrutamento.
 *
 * Ele entra no WhatsApp do dono como "aparelho conectado" e SÓ ENVIA:
 *   - não tem ouvinte de mensagem nenhum — o que chega fica para o dono ler
 *     e responder no celular, como sempre;
 *   - não marca nada como lido, não aparece "online", não baixa histórico;
 *   - cada mensagem abre com "Aviso automático — Sistema NovaGestão Obras".
 *
 * Configuração em .env.cobranca (fora do git):
 *   COBRANCA_NUMERO=55...              o número do dono (para o código de pareamento)
 *   COBRANCA_SESSAO=dados/whatsapp-cobranca
 *   OBRAS_INTEGRACAO_TOKEN=...         RH_INTEGRATION_TOKEN do sistema de obras
 *   COBRAR_CONFERENCIA=ensaio|on       CONFERENCIA_ENSAIO_PARA=55...
 *   CONFERENCIA_HORA=7                 CONFERENCIA_ARQUIVO=dados/cobranca-obras.json
 *
 * Para conectar: `node --env-file=.env.cobranca src/cobranca-obras.js parear`
 * imprime um código de 8 letras; no celular, WhatsApp → Aparelhos conectados
 * → Conectar aparelho → "Conectar com número de telefone", e digita o código.
 */
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import pino from 'pino'
import * as conferencia from './cobranca-conferencia.js'

const PASTA = process.env.COBRANCA_SESSAO || join(process.cwd(), 'dados', 'whatsapp-cobranca')
const NUMERO = String(process.env.COBRANCA_NUMERO ?? '').replace(/\D/g, '')
const ARQUIVO_CODIGO = join(dirname(PASTA), 'cobranca-codigo.txt')
const PAREAR = process.argv.includes('parear')
// "parear qr": em vez do código de 8 letras, escreve uma página com o QR
// (cobranca-qr.html, ao lado da sessão), que se recarrega sozinha a cada
// troca de QR. Serve para conectar olhando a tela do computador.
const POR_QR = process.argv.includes('qr')
const ARQUIVO_QR = join(dirname(PASTA), 'cobranca-qr.html')

function paginaDoQr(qr) {
  const dado = JSON.stringify(qr).replace(/</g, '\\u003c')
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="4">
<title>Conectar cobrança</title>
<body style="font-family:sans-serif;text-align:center;background:#fff;color:#111;padding:16px">
<h2>WhatsApp → Aparelhos conectados → Conectar aparelho</h2>
<p>Aponte a câmera para o código. Ele muda sozinho a cada ~20 s.</p>
<div id="q" style="display:inline-block;padding:16px;background:#fff"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>new QRCode(document.getElementById('q'), { text: ${dado}, width: 320, height: 320 })</script>
</body>`
}

let sock = null
let aberto = false
let codigoPedido = false

async function conectar() {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } =
    await import('@whiskeysockets/baileys')
  if (!existsSync(PASTA)) mkdirSync(PASTA, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(PASTA)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'error' }),
    // "Online" o tempo todo faz o celular do dono parar de notificar.
    markOnlineOnConnect: false,
    // Não precisa de conversa nenhuma: só envia.
    shouldSyncHistoryMessage: () => false,
    syncFullHistory: false,
    // Conexão por código só é aceita com um sistema que o WhatsApp conhece
    // (Windows, Mac OS, Ubuntu). Nome inventado aqui = o celular recusa o
    // código e a conexão vence em 408. Quem diz que é do sistema é o cabeçalho
    // de cada mensagem, não o nome do aparelho.
    browser: Browsers.windows('Chrome'),
  })
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    // Sem sessão ainda: em vez de QR (que não dá para ler de longe), pede o
    // código de pareamento para o número do dono.
    if (qr && !state.creds.registered) {
      if (!PAREAR) {
        console.error('[cobranca-obras] sem sessão. Rode com "parear" para gerar o código de conexão.')
        process.exit(2)
      }
      if (POR_QR) {
        writeFileSync(ARQUIVO_QR, paginaDoQr(qr))
        console.log('[cobranca-obras] QR novo em', ARQUIVO_QR)
      } else if (!codigoPedido && NUMERO.length >= 12) {
        codigoPedido = true
        try {
          const codigo = await sock.requestPairingCode(NUMERO)
          writeFileSync(ARQUIVO_CODIGO, `${codigo}\n`)
          console.log(`\n[cobranca-obras] CÓDIGO DE CONEXÃO: ${codigo}`)
          console.log('  WhatsApp → Aparelhos conectados → Conectar aparelho → Conectar com número de telefone\n')
        } catch (e) {
          console.error('[cobranca-obras] não consegui pedir o código:', e.message)
        }
      }
    }

    if (connection === 'open') {
      aberto = true
      console.log(`[cobranca-obras] conectado no número de final ${String(sock.user?.id ?? '').split(/[:@]/)[0].slice(-4)}`)
      try { writeFileSync(ARQUIVO_CODIGO, 'conectado\n') } catch {}
      if (POR_QR) {
        try { writeFileSync(ARQUIVO_QR, '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>✅ Conectado</h1><p>Pode fechar esta página.</p></body>') } catch {}
      }
      if (PAREAR) {
        // Pareado: dá um tempo para gravar as chaves e sai; o pm2 sobe o de verdade.
        setTimeout(() => process.exit(0), 8000)
      }
    }

    if (connection === 'close') {
      aberto = false
      const motivo = lastDisconnect?.error?.output?.statusCode
      // Pareando e o código venceu (ou a conexão caiu antes de digitarem): sai,
      // e um código novo sai quando rodar "parear" de novo. Não é o dono
      // desconectando — não mexe em sessão nenhuma.
      // Depois de ler o QR o WhatsApp derruba a conexão uma vez (515) para
      // reabrir já pareado — aí `me` existe e é só reconectar.
      if (PAREAR && !state.creds.registered && !state.creds.me) {
        try { writeFileSync(ARQUIVO_CODIGO, 'expirou\n') } catch {}
        console.error(`[cobranca-obras] o código venceu (${motivo ?? '?'}). Rode "parear" de novo para um código novo.`)
        process.exit(1)
      }
      if (motivo === DisconnectReason.loggedOut) {
        // Desconectado no celular: é o dono dizendo "pare". Não tenta voltar.
        const guardada = `${PASTA}-removida-${Date.now()}`
        try { renameSync(PASTA, guardada) } catch {}
        console.error('[cobranca-obras] o aparelho foi desconectado no celular. Parado até parear de novo.')
        process.exit(0)
      }
      console.warn(`[cobranca-obras] conexão caiu (${motivo ?? '?'}) — reconectando em 10s`)
      setTimeout(() => conectar().catch(e => console.error('[cobranca-obras]', e.message)), 10_000)
    }
  })
}

/** O endereço certo do número: com ou sem o nono dígito, quem responde é o WhatsApp. */
async function endereco(numero) {
  for (const f of conferencia.formas(numero)) {
    try {
      const [r] = (await sock.onWhatsApp(f)) ?? []
      if (r?.exists && r.jid) return r.jid
    } catch { /* tenta a próxima */ }
  }
  return null
}

async function enviar(numero, texto) {
  if (!sock || !aberto) return { ok: false, motivo: 'desconectado' }
  const jid = await endereco(numero)
  if (!jid) {
    console.warn(`[cobranca-obras] final ${String(numero).slice(-4)}: não tem WhatsApp`)
    return { ok: false, motivo: 'sem-whatsapp' }
  }
  try {
    await sock.sendMessage(jid, { text: texto })
    console.log(`[cobranca-obras] enviada para final ${String(numero).slice(-4)}`)
    return { ok: true }
  } catch (e) {
    console.error(`[cobranca-obras] falhou para final ${String(numero).slice(-4)}:`, e.message)
    return { ok: false, motivo: e.message }
  }
}

let rodando = false
async function rodada() {
  if (rodando || !aberto) return
  rodando = true
  try {
    const r = await conferencia.rodar({ enviar, cabecalho: true })
    if (r.rodou) console.log(`[cobranca-obras] ${r.modo}: ${r.enviados} de ${r.total}${r.concluido ? '' : ' — o resto na próxima rodada'}`)
  } catch (e) {
    console.error('[cobranca-obras]', e.message)
  } finally {
    rodando = false
  }
}

await conectar()
if (!PAREAR) {
  console.log(`[cobranca-obras] modo ${conferencia.modoCobranca().toUpperCase()}, a partir das ${conferencia.horaDeComecar()}h`)
  setInterval(rodada, 5 * 60 * 1000)
  setTimeout(rodada, 60 * 1000)
}
