/**
 * Ler o grupo antigo de comprovantes PELA CONTA DO DONO — ferramenta avulsa.
 *
 * Roda UMA vez, num computador (não dentro do robô). Entra no WhatsApp do
 * dono como "aparelho conectado", lê só o grupo pedido, baixa os
 * comprovantes e monta um zip igual ao da "Exportar conversa", que a leitura
 * do grupo antigo (src/comprovantes/atraso.js) já sabe tratar.
 *
 * SÓ LÊ. Não manda mensagem, não marca como lido, não aparece online. Tem
 * sessão própria (dados/whatsapp-leitor): não toca na do robô nem na da
 * cobrança de obras. A lógica — e as travas — estão em
 * src/comprovantes/leitor-conta.js; aqui só se conecta.
 *
 * Uso (nesta pasta):
 *
 *   node scripts/ler-grupo-pela-conta.js ler --grupo "Comprovantes Pgto obras" --numero 5511999998888
 *       Conecta (na primeira vez mostra o código de 8 letras para digitar em
 *       WhatsApp → Aparelhos conectados → Conectar aparelho → Conectar com
 *       número de telefone), lê o grupo e gera o zip. Rodar de novo continua
 *       de onde parou.
 *
 *   ...  ler --grupo "Nome" --qr            em vez do código, uma página com o QR
 *   ...  ler --grupo "Nome" --desde 2026-09-22 --saida dados/leitor-saida
 *   ...  ler --grupo "Nome" --ensaio-local  depois do zip, roda aqui o ensaio do grupo antigo
 *   ...  ensaio                             só o ensaio, sobre o zip já gerado (não conecta)
 *   ...  sair                               desconecta este aparelho da conta
 *
 * O número também pode vir de LEITOR_NUMERO. Nunca fica escrito no código.
 */
import { existsSync, mkdirSync, writeFileSync, renameSync, copyFileSync, mkdtempSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import pino from 'pino'
import { LeitorDeGrupo } from '../src/comprovantes/leitor-conta.js'

const args = process.argv.slice(2)
const comando = args[0]
const opcao = (nome) => { const i = args.indexOf(`--${nome}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null }
const tem = (nome) => args.includes(`--${nome}`)

const SESSAO = resolve(process.env.LEITOR_SESSAO || join(process.cwd(), 'dados', 'whatsapp-leitor'))
const SAIDA = resolve(opcao('saida') || join(process.cwd(), 'dados', 'leitor-saida'))
const ESTADO = join(dirname(SESSAO), 'leitor-estado')
const NUMERO = String(opcao('numero') ?? process.env.LEITOR_NUMERO ?? '').replace(/\D/g, '')
const DESDE = opcao('desde') || '2026-09-22'
const ARQUIVO_QR = join(dirname(SESSAO), 'leitor-qr.html')

function ajuda(motivo) {
  if (motivo) console.error(`\n${motivo}\n`)
  console.error([
    'Uso:',
    '  node scripts/ler-grupo-pela-conta.js ler --grupo "Nome do grupo" --numero 55DDDNUMERO [--qr] [--desde AAAA-MM-DD] [--saida pasta] [--ensaio-local]',
    '  node scripts/ler-grupo-pela-conta.js ensaio [--desde AAAA-MM-DD] [--saida pasta]',
    '  node scripts/ler-grupo-pela-conta.js sair',
  ].join('\n'))
  process.exit(2)
}

function paginaDoQr(qr) {
  const dado = JSON.stringify(qr).replace(/</g, '\\u003c')
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="4">
<title>Conectar leitor</title>
<body style="font-family:sans-serif;text-align:center;background:#fff;color:#111;padding:16px">
<h2>WhatsApp → Aparelhos conectados → Conectar aparelho</h2>
<p>Aponte a câmera para o código. Ele muda sozinho a cada ~20 s.</p>
<div id="q" style="display:inline-block;padding:16px;background:#fff"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>new QRCode(document.getElementById('q'), { text: ${dado}, width: 320, height: 320 })</script>
</body>`
}

/**
 * Conecta à conta. Devolve quando a conexão abre; `aoSocket` é chamado a
 * cada socket novo (o WhatsApp derruba e reabre a conexão logo depois do
 * pareamento, e pode cair no meio).
 */
async function conectar({ aoSocket, podeParear }) {
  const baileys = await import('@whiskeysockets/baileys')
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys
  if (!existsSync(SESSAO)) mkdirSync(SESSAO, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(SESSAO)
  const { version } = await fetchLatestBaileysVersion()
  let codigoPedido = false
  let encerrando = false

  return new Promise((aberta, falhou) => {
    const abrir = () => {
      const sock = makeWASocket({
        version,
        auth: state,
        // Nível "fatal": o registro da biblioteca não pode despejar no
        // terminal pedaços das conversas da conta.
        logger: pino({ level: 'fatal' }),
        // Não aparece "online": o celular do dono continua notificando.
        markOnlineOnConnect: false,
        // O que se quer aqui é justamente o histórico.
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true,
        // Conexão por código só é aceita com um sistema que o WhatsApp
        // conhece. "desktop" pede mais histórico; se o código não for aceito
        // com ele, o padrão ("chrome") é o que a cobrança de obras já usa.
        browser: Browsers.windows(opcao('navegador') === 'desktop' ? 'Desktop' : 'Chrome'),
      })
      sock.ev.on('creds.update', saveCreds)
      aoSocket(sock)

      sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr && !state.creds.registered) {
          if (!podeParear) {
            falhou(new Error('Este computador não está conectado à conta. Rode o comando "ler" para conectar.'))
            return
          }
          if (tem('qr')) {
            writeFileSync(ARQUIVO_QR, paginaDoQr(qr))
            console.log('[leitor] QR novo em', ARQUIVO_QR, '— abra esse arquivo no navegador.')
          } else if (!codigoPedido) {
            if (NUMERO.length < 12) { falhou(new Error('Para conectar por código preciso do número da conta: --numero 55DDDNUMERO (ou use --qr).')); return }
            codigoPedido = true
            try {
              const codigo = await sock.requestPairingCode(NUMERO)
              console.log(`\n[leitor] CÓDIGO DE CONEXÃO: ${codigo}`)
              console.log('  No celular: WhatsApp → Aparelhos conectados → Conectar aparelho → Conectar com número de telefone\n')
            } catch (e) {
              falhou(new Error(`Não consegui pedir o código de conexão: ${e.message}`))
            }
          }
        }

        if (connection === 'open') {
          console.log(`[leitor] conectado na conta de final ${String(sock.user?.id ?? '').split(/[:@]/)[0].slice(-4)}`)
          if (tem('qr')) { try { writeFileSync(ARQUIVO_QR, '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>Conectado</h1><p>Pode fechar esta página.</p></body>') } catch { /* tanto faz */ } }
          aberta({ sock, encerrar: () => { encerrando = true; try { sock.end(undefined) } catch { /* já fechado */ } } })
        }

        if (connection === 'close') {
          if (encerrando) return
          const motivo = lastDisconnect?.error?.output?.statusCode
          if (!state.creds.registered && !state.creds.me) {
            falhou(new Error(`O código venceu ou a conexão caiu antes de ser digitado (${motivo ?? '?'}). Rode de novo para um código novo.`))
            return
          }
          if (motivo === DisconnectReason.loggedOut) {
            try { renameSync(SESSAO, `${SESSAO}-removida-${Date.now()}`) } catch { /* tanto faz */ }
            falhou(new Error('O aparelho foi desconectado no celular. Para ler de novo, conecte outra vez.'))
            return
          }
          console.warn(`[leitor] a conexão caiu (${motivo ?? '?'}) — reconectando em 5s`)
          setTimeout(abrir, 5000)
        }
      })
    }
    abrir()
  })
}

/** O ensaio do grupo antigo, aqui mesmo: só leitura no sistema de obras, nenhuma escrita, nenhuma mensagem. */
async function ensaioLocal(zip) {
  if (!existsSync(zip)) throw new Error(`Não achei o zip em ${zip}. Rode "ler" primeiro.`)
  if (!process.env.OBRAS_API_TOKEN) throw new Error('Para o ensaio preciso de OBRAS_API_TOKEN no ambiente (só para LER o que já está lançado).')
  if (!process.env.GEMINI_API_KEY) console.warn('[leitor] sem GEMINI_API_KEY: o ensaio não lê as imagens, só as legendas — quase tudo vai sair como "perguntaria".')

  // Tudo que o módulo guarda vai para uma pasta temporária: o `dados/` de
  // verdade não é tocado. E o modo é ENSAIO, fixado aqui.
  const temp = mkdtempSync(join(tmpdir(), 'leitor-ensaio-'))
  process.env.GASTOS_ATRASO = 'ensaio'
  process.env.GASTOS_ATRASO_DIR = join(temp, 'atraso')
  process.env.GASTOS_PENDENTES_DIR = join(temp, 'pendentes')
  process.env.GASTOS_MEMORIA = join(temp, 'memoria-gastos.json')
  process.env.CONNECTOR = 'none'

  const atraso = await import('../src/comprovantes/atraso.js')
  const r = await atraso.iniciarAtraso({ zip, desde: DESDE })
  if (!r.ok) throw new Error(`O ensaio não começou: ${r.motivo}`)
  console.log(`[leitor] ensaio: ${r.comprovantes} comprovantes a avaliar (com a pausa padrão, uns 15 por minuto)…`)
  await atraso._aguardar()

  const s = atraso.situacaoDoAtraso()
  if (s.trabalho?.erro) throw new Error(`O ensaio parou: ${s.trabalho.erro}`)
  const csv = join(dirname(zip), 'grupo-antigo-ensaio.csv')
  const resumo = join(dirname(zip), 'grupo-antigo-ensaio.txt')
  copyFileSync(join(process.env.GASTOS_ATRASO_DIR, 'relatorio.csv'), csv)
  writeFileSync(resumo, `${s.resumo ?? ''}\n`, 'utf8')
  console.log(`\n${s.resumo}\n\nRelatório do ensaio: ${csv}`)
}

async function ler() {
  const grupo = opcao('grupo')
  if (!grupo) ajuda('Diga o nome do grupo: --grupo "Nome do grupo"')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DESDE)) ajuda('A data de corte tem de ser AAAA-MM-DD.')

  let sockAtual = null
  const leitor = new LeitorDeGrupo({
    pasta: ESTADO,
    saida: SAIDA,
    grupoNome: grupo,
    grupoId: opcao('grupo-id'),
    desde: DESDE,
    baixar: async (mensagem) => {
      const { downloadMediaMessage } = await import('@whiskeysockets/baileys')
      // Mídia antiga some do servidor do WhatsApp. `reuploadRequest` pede ao
      // CELULAR do dono que a mande de novo — funciona enquanto ele ainda
      // tiver o arquivo.
      return downloadMediaMessage(mensagem, 'buffer', {}, { logger: pino({ level: 'fatal' }), reuploadRequest: sockAtual.updateMediaMessage })
    },
  })

  const conexao = await conectar({ podeParear: true, aoSocket: (sock) => { sockAtual = sock; leitor.ligar(sock) } })
  try {
    const resumo = await leitor.rodar()
    console.log(`\n${resumo.texto}\n`)
  } finally {
    conexao.encerrar()
  }

  if (tem('ensaio-local')) await ensaioLocal(join(SAIDA, 'grupo-antigo.zip'))
}

async function sair() {
  if (!existsSync(SESSAO)) { console.log('[leitor] este computador não está conectado a conta nenhuma.'); return }
  const conexao = await conectar({ podeParear: false, aoSocket: () => {} })
  try {
    await conexao.sock.logout()
    console.log('[leitor] aparelho desconectado da conta.')
  } catch (e) {
    console.error(`[leitor] não consegui desconectar por aqui (${e.message}). Remova no celular: WhatsApp → Aparelhos conectados.`)
  } finally {
    conexao.encerrar()
    try { renameSync(SESSAO, `${SESSAO}-removida-${Date.now()}`) } catch { /* tanto faz */ }
  }
}

try {
  if (comando === 'ler') await ler()
  else if (comando === 'ensaio') await ensaioLocal(join(SAIDA, 'grupo-antigo.zip'))
  else if (comando === 'sair') await sair()
  else ajuda()
} catch (e) {
  console.error(`\n[leitor] ${e.message}\n`)
  process.exitCode = 1
}

// Sai sozinho quando as conexões terminam de fechar. Encerrar à força no
// meio disso faz o Node abortar no Windows (e devolver código de erro com o
// trabalho já feito). O relógio abaixo é só a garantia de que ele sai: não
// segura o processo, e só age se algo ficar pendurado.
setTimeout(() => process.exit(), 8000).unref()
