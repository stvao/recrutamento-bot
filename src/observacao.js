/**
 * O que se conversa no privado — para o robô aprender antes de atender.
 *
 * Enquanto o dono atende os candidatos à mão, o robô fica olhando: grava o
 * que o candidato escreve E o que o dono responde (as respostas digitadas no
 * celular chegam aqui como mensagens "minhas"). É desse material que saem as
 * respostas da Maria Vitória: as perguntas que de fato aparecem, o jeito de
 * responder de quem conhece o negócio, e o ponto em que as pessoas desistem.
 *
 * Três cuidados, porque isto é conversa de gente:
 *
 *  - SEM TELEFONE. Cada conversa ganha um código tirado do endereço com um
 *    sal aleatório guardado só neste servidor; do número, ficam os quatro
 *    últimos dígitos, para o dono reconhecer de quem é. Um arquivo destes
 *    vazado não diz a ninguém para quem ligar.
 *  - COM PRAZO. Depois de OBSERVACAO_DIAS (180 por padrão) o mês inteiro é
 *    apagado. Isto é material de estudo, não arquivo morto.
 *  - SÓ O PRIVADO. Grupo não entra: o de comprovantes não ensina nada sobre
 *    atender candidato.
 *
 * Nada aqui pode derrubar o atendimento: disco cheio ou arquivo quebrado
 * viram uma linha de log, e a mensagem segue o caminho dela.
 */
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)))
const PASTA = process.env.OBSERVACAO_DIR || join(RAIZ, 'dados', 'observacao')

/** Lidos na hora: mudar o .env e reiniciar basta, e os testes controlam. */
export const ligado = () => (process.env.OBSERVAR ?? 'on').toLowerCase() !== 'off'
const retencaoDias = () => Number(process.env.OBSERVACAO_DIAS || 180)

const MAX_TEXTO = 2000

// ── Pseudônimo da conversa ─────────────────────────────────────────────

let sal = null

/**
 * O sal é criado uma vez e fica só neste servidor. Sem ele, o código da
 * conversa não leva de volta ao endereço — e com ele fora do repositório,
 * nem quem lê o código consegue.
 */
function oSal() {
  if (sal) return sal
  const arquivo = join(PASTA, '.sal')
  try {
    mkdirSync(PASTA, { recursive: true })
    if (!existsSync(arquivo)) writeFileSync(arquivo, randomBytes(16).toString('hex'), { mode: 0o600 })
    sal = readFileSync(arquivo, 'utf8').trim()
  } catch {
    // Sem disco, um sal só desta execução: os códigos mudam no reinício, mas
    // o atendimento não para por causa disso.
    sal = randomBytes(16).toString('hex')
  }
  return sal
}

/** "c_3f9a1b7e2d" — o mesmo endereço dá sempre o mesmo código. */
export function codigoDaConversa(chave) {
  return 'c_' + createHash('sha256').update(oSal() + String(chave ?? '')).digest('hex').slice(0, 10)
}

// ── Que tipo de mensagem ───────────────────────────────────────────────

/**
 * O que a mensagem é, ou null quando não vale anotar.
 *
 * Reação, edição, apagada e as mensagens técnicas de criptografia não são
 * conversa; anotá-las só encheria o arquivo de linhas vazias.
 */
export function tipoDe(message) {
  const m = message ?? {}
  if (m.conversation != null || m.extendedTextMessage) return 'texto'
  if (m.audioMessage) return 'audio'
  if (m.imageMessage) return 'imagem'
  if (m.videoMessage) return 'video'
  if (m.documentMessage || m.documentWithCaptionMessage) return 'documento'
  if (m.stickerMessage) return 'figurinha'
  if (m.contactMessage || m.contactsArrayMessage) return 'contato'
  if (m.locationMessage || m.liveLocationMessage) return 'localizacao'
  if (m.reactionMessage || m.protocolMessage || m.editedMessage) return null

  const chaves = Object.keys(m).filter(k => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage')
  return chaves.length ? 'outro' : null
}

// ── O que o próprio robô mandou ────────────────────────────────────────
//
// As mensagens "minhas" são do dono (digitadas no celular) ou do robô. Para
// separar, o robô anota o id de tudo que envia. Guarda os últimos 2000: o que
// importa é distinguir o eco imediato, não a história inteira.

const doRobo = new Set()

export function marcarDoRobo(id) {
  if (!id) return
  doRobo.add(id)
  if (doRobo.size > 2000) doRobo.delete(doRobo.values().next().value)
}

export const foiORobo = (id) => Boolean(id) && doRobo.has(id)

// ── Gravar ─────────────────────────────────────────────────────────────

const arquivoDoMes = (quando) => {
  const d = new Date(quando)
  return join(PASTA, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`)
}

let ultimaLimpeza = 0

/**
 * Anota uma mensagem.
 *
 * `chave` identifica a conversa (o endereço do chat); `final` são os quatro
 * últimos dígitos do telefone, quando conhecido; `autor` é 'candidato',
 * 'empresa' (o dono, no celular) ou 'robo'.
 *
 * Devolve se anotou.
 */
export function anotar({ chave, final = null, autor, tipo, texto = null, em = Date.now() }) {
  if (!ligado() || !chave || !autor || !tipo) return false

  try {
    // Uma vez por dia, no máximo, apaga o que passou do prazo.
    if (em - ultimaLimpeza > 24 * 60 * 60 * 1000) {
      ultimaLimpeza = em
      limparAntigos(em)
    }

    mkdirSync(PASTA, { recursive: true })
    const registro = {
      em: new Date(em).toISOString(),
      conversa: codigoDaConversa(chave),
      final: final ? String(final).slice(-4) : null,
      autor,
      tipo,
      texto: texto ? String(texto).slice(0, MAX_TEXTO) : null,
    }
    appendFileSync(arquivoDoMes(em), JSON.stringify(registro) + '\n', 'utf8')
    return true
  } catch (e) {
    console.error('[observacao] não consegui anotar:', e.message)
    return false
  }
}

/**
 * Apaga os meses que já passaram inteiros do prazo.
 *
 * Por mês, e não por linha: reescrever um arquivo para tirar linhas velhas
 * seria o mesmo trabalho todo dia. Um mês sai quando o ÚLTIMO dia dele fica
 * mais velho que o prazo — nenhuma conversa sai antes da hora.
 */
export function limparAntigos(agora = Date.now()) {
  let apagados = 0
  try {
    if (!existsSync(PASTA)) return 0
    const limite = agora - retencaoDias() * 24 * 60 * 60 * 1000
    for (const nome of readdirSync(PASTA)) {
      const m = /^(\d{4})-(\d{2})\.jsonl$/.exec(nome)
      if (!m) continue
      const fimDoMes = new Date(Number(m[1]), Number(m[2]), 1).getTime()   // 1º dia do mês seguinte
      if (fimDoMes < limite) {
        unlinkSync(join(PASTA, nome))
        apagados++
      }
    }
  } catch (e) {
    console.error('[observacao] limpeza falhou:', e.message)
  }
  return apagados
}

// ── Ler ────────────────────────────────────────────────────────────────

/** Tudo o que foi anotado, em ordem de tempo. Linha quebrada é pulada. */
export function lerTudo() {
  if (!existsSync(PASTA)) return []
  const todos = []
  for (const nome of readdirSync(PASTA).filter(n => n.endsWith('.jsonl')).sort()) {
    for (const linha of readFileSync(join(PASTA, nome), 'utf8').split('\n')) {
      if (!linha.trim()) continue
      try { todos.push(JSON.parse(linha)) } catch { /* linha pela metade: pula */ }
    }
  }
  return todos.sort((a, b) => a.em.localeCompare(b.em))
}

export function situacao() {
  return { ligado: ligado(), retencaoDias: retencaoDias(), pasta: PASTA }
}
