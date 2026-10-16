/**
 * Central de atendimento: o robô repassa ao RH cada mensagem das conversas
 * privadas — do candidato, do próprio robô, e da empresa pelo celular — para
 * a tela "Atendimento" mostrar a conversa inteira, venha de onde vier.
 *
 * Nunca atrasa nem derruba o atendimento: o envio é em segundo plano, com uma
 * fila pequena na memória e novas tentativas. Se o RH estiver fora, as
 * mensagens esperam (até MAX_FILA) e sobem quando ele voltar.
 */

const RH_API_URL = process.env.RH_API_URL || ''
const RH_API_TOKEN = process.env.RH_API_TOKEN || ''
const MAX_FILA = 2000
const LOTE = 50

/** Ligado por padrão; ATENDIMENTO_RH=off desliga. */
export const ligado = () => Boolean(RH_API_URL && RH_API_TOKEN)
  && (process.env.ATENDIMENTO_RH ?? 'on').toLowerCase() !== 'off'

const fila = []
let enviando = false
let falhasSeguidas = 0

/**
 * Uma mensagem para o RH.
 * evento: { chave (jid), numero?, lid?, nome?, autor: 'pessoa'|'robo'|'celular'|'atendente',
 *           atendente?, tipo, texto?, em (ms), waId? }
 */
export function repassar(evento) {
  if (!ligado()) return
  fila.push({ ...evento, em: evento.em ?? Date.now() })
  if (fila.length > MAX_FILA) fila.splice(0, fila.length - MAX_FILA)
  void esvaziar()
}

async function esvaziar() {
  if (enviando || fila.length === 0) return
  enviando = true
  try {
    while (fila.length) {
      const lote = fila.slice(0, LOTE)
      const r = await fetch(`${RH_API_URL}/api/integracao/atendimento`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RH_API_TOKEN}` },
        body: JSON.stringify({ mensagens: lote }),
        signal: AbortSignal.timeout(15000),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      fila.splice(0, lote.length)
      falhasSeguidas = 0
    }
  } catch (e) {
    falhasSeguidas++
    if (falhasSeguidas === 1 || falhasSeguidas % 20 === 0) {
      console.warn(`[atendimento] RH não recebeu (${fila.length} na fila):`, e.message)
    }
    // Tenta de novo depois, mais devagar a cada falha (até 5 min).
    setTimeout(() => void esvaziar(), Math.min(300_000, 5000 * falhasSeguidas))
  } finally {
    enviando = false
  }
}

export function situacao() {
  return { ligado: ligado(), naFila: fila.length, falhasSeguidas }
}
