/**
 * A candidatura que o RH não recebeu fica guardada até conseguir.
 *
 * O deploy do RH é manual e reinicia o processo; nesses segundos,
 * enviarCandidatura falha nas duas tentativas. O robô dizia à pessoa "tive um
 * probleminha para salvar, já avisei a equipe" — e não avisava ninguém (o
 * aviso vai para o MESMO servidor que está fora) nem tentava de novo. Se
 * aquela era a última mensagem dela, a ficha nunca existia: o lembrete via a
 * ficha completa e não lembrava, e as métricas contavam abandono.
 *
 * Em disco, um arquivo por número, como os documentos guardados: o que
 * importa é sobreviver ao reinício do próprio robô.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const PASTA = () => process.env.CANDIDATURAS_PENDENTES_DIR
  || join(process.cwd(), 'dados', 'candidaturas-pendentes')

/** Depois disso não vale mais insistir: a conversa já expirou de qualquer forma. */
export const PRAZO_MS = 7 * 24 * 3600_000
export const MAX_GUARDADAS = 200

const codigo = (whatsapp) => createHash('sha256').update(String(whatsapp)).digest('hex').slice(0, 16)

function arquivos() {
  const pasta = PASTA()
  if (!existsSync(pasta)) return []
  return readdirSync(pasta).filter(n => n.endsWith('.json'))
}

function ler(nome) {
  try {
    return { nome, ...JSON.parse(readFileSync(join(PASTA(), nome), 'utf8')) }
  } catch {
    return null
  }
}

/** Apaga o que passou do prazo. Devolve quantas apagou. */
export function limpar(agora = Date.now()) {
  let n = 0
  for (const nome of arquivos()) {
    const p = ler(nome)
    if (!p || agora - (p.em ?? 0) > PRAZO_MS) {
      rmSync(join(PASTA(), nome), { force: true })
      n++
    }
  }
  return n
}

/**
 * Guarda (ou atualiza) a candidatura deste número.
 *
 * Uma por pessoa: o robô reenvia a ficha inteira a cada dado novo, então a
 * última é a mais completa. `primeiraVez` é preservado da primeira tentativa —
 * é ele que diz, quando o envio finalmente der certo, se isto conta como uma
 * conclusão nova nas métricas.
 */
export function guardar(whatsapp, dados, { primeiraVez = false, agora = Date.now() } = {}) {
  try {
    limpar(agora)
    const pasta = PASTA()
    mkdirSync(pasta, { recursive: true })
    const nome = `${codigo(whatsapp)}.json`
    const antes = ler(nome)
    if (!antes && arquivos().length >= MAX_GUARDADAS) return false
    writeFileSync(join(pasta, nome), JSON.stringify({
      whatsapp,
      dados,
      primeiraVez: antes?.primeiraVez ?? primeiraVez,
      tentativas: (antes?.tentativas ?? 0) + 1,
      em: antes?.em ?? agora,
    }))
    return true
  } catch (e) {
    console.error('[candidatura-pendente] não consegui guardar:', e.message)
    return false
  }
}

/** As candidaturas que ainda não chegaram ao RH, da mais antiga para a mais nova. */
export function pendentes(agora = Date.now()) {
  return arquivos()
    .map(ler)
    .filter(p => p && agora - (p.em ?? 0) <= PRAZO_MS)
    .sort((a, b) => (a.em ?? 0) - (b.em ?? 0))
}

/** Tira da fila — o RH recebeu. */
export function remover(whatsapp) {
  rmSync(join(PASTA(), `${codigo(whatsapp)}.json`), { force: true })
}

export const quantas = () => arquivos().length
