/**
 * Documento que chegou antes de a ficha existir no RH.
 *
 * Quem manda o currículo na primeira mensagem ainda não tem candidatura: o RH
 * responde 404. O arquivo fica aqui até a ficha ser registrada.
 *
 * Em DISCO, e não na memória: antes um reinício do robô (todo deploy) perdia
 * o currículo em silêncio. Com teto de quantidade e prazo de 24 horas — o
 * servidor divide o disco com o RH, e documento de quem nunca terminou a
 * ficha não deve ficar guardado sem motivo.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const PASTA = () => process.env.DOCUMENTOS_GUARDADOS_DIR || join(process.cwd(), 'dados', 'documentos-guardados')
export const PRAZO_MS = 24 * 3600_000
export const MAX_TOTAL = 20
export const MAX_POR_PESSOA = 3

const codigo = (de) => createHash('sha256').update(String(de)).digest('hex').slice(0, 16)

function metas() {
  const pasta = PASTA()
  if (!existsSync(pasta)) return []
  return readdirSync(pasta)
    .filter(n => n.endsWith('.json'))
    .map(n => {
      try { return { base: n.slice(0, -5), ...JSON.parse(readFileSync(join(pasta, n), 'utf8')) } } catch { return null }
    })
    .filter(Boolean)
}

function apagar(base) {
  const pasta = PASTA()
  rmSync(join(pasta, `${base}.json`), { force: true })
  rmSync(join(pasta, `${base}.bin`), { force: true })
}

/** Apaga o que passou do prazo. Devolve quantos apagou. */
export function limpar(agora = Date.now()) {
  let n = 0
  for (const m of metas()) {
    if (agora - m.em > PRAZO_MS) { apagar(m.base); n++ }
  }
  return n
}

/** Guarda. False quando não coube (teto) — o documento se perde, avisado no log. */
export function guardar(de, { tipo, nome, arquivo, extraido }, agora = Date.now()) {
  try {
    limpar(agora)
    const todas = metas()
    if (todas.length >= MAX_TOTAL) return false
    const dela = todas.filter(m => m.pessoa === codigo(de)).sort((a, b) => a.em - b.em)
    if (dela.length >= MAX_POR_PESSOA) apagar(dela[0].base)

    const pasta = PASTA()
    mkdirSync(pasta, { recursive: true })
    const base = `${codigo(de)}-${agora}-${Math.random().toString(36).slice(2, 6)}`
    writeFileSync(join(pasta, `${base}.bin`), Buffer.from(arquivo))
    writeFileSync(join(pasta, `${base}.json`), JSON.stringify({
      pessoa: codigo(de), whatsapp: de, tipo, nome: nome ?? null, extraido: extraido ?? null, em: agora,
    }))
    return true
  } catch (e) {
    console.error('[documentos-guardados] não consegui guardar:', e.message)
    return false
  }
}

/** Tira os documentos desta pessoa (e apaga do disco). */
export function retirar(de, agora = Date.now()) {
  const pasta = PASTA()
  const docs = []
  for (const m of metas().filter(x => x.pessoa === codigo(de)).sort((a, b) => a.em - b.em)) {
    try {
      if (agora - m.em <= PRAZO_MS) {
        docs.push({ whatsapp: m.whatsapp, tipo: m.tipo, nome: m.nome, extraido: m.extraido, arquivo: readFileSync(join(pasta, `${m.base}.bin`)) })
      }
    } catch { /* arquivo sumiu: segue */ }
    apagar(m.base)
  }
  return docs
}

export const quantos = () => metas().length
