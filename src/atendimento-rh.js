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

// ── Mensagens com arquivo (foto, áudio, PDF) ───────────────────────────────
//
// Vão uma a uma, numa fila PEQUENA à parte: um arquivo pesa até MAX_MIDIA_MB,
// e guardar 2000 deles na memória derrubaria o robô (o servidor tem menos de
// 1 GB, dividido com o RH). Se a fila encher, o arquivo mais antigo vai sem
// o conteúdo — a mensagem aparece no RH como "📷 Foto", para ver no celular.

export const MAX_MIDIA_BYTES = Number(process.env.ATENDIMENTO_MAX_MIDIA_MB || 16) * 1024 * 1024
const MAX_FILA_MIDIA = 30
const filaMidia = []
let enviandoMidia = false

/** evento como em repassar(), mais midia: { base64, mime, nome, ptt } */
export function repassarComMidia(evento, midia) {
  if (!ligado()) return
  filaMidia.push({ ...evento, em: evento.em ?? Date.now(), midia })
  while (filaMidia.length > MAX_FILA_MIDIA) {
    const velha = filaMidia.shift()
    repassar({ ...velha, midia: undefined })
  }
  void esvaziarMidia()
}

async function esvaziarMidia() {
  if (enviandoMidia) return
  enviandoMidia = true
  try {
    while (filaMidia.length) {
      const item = filaMidia[0]
      let ok = false
      for (let tentativa = 0; tentativa < 3 && !ok; tentativa++) {
        try {
          const r = await fetch(`${RH_API_URL}/api/integracao/atendimento`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RH_API_TOKEN}` },
            body: JSON.stringify({ mensagens: [item] }),
            signal: AbortSignal.timeout(60000),
          })
          ok = r.ok
        } catch { /* tenta de novo */ }
        if (!ok) await new Promise(res => setTimeout(res, 3000 * (tentativa + 1)))
      }
      filaMidia.shift()
      // Não subiu nem com 3 tentativas: vai sem o arquivo, para a conversa
      // não ficar com buraco.
      if (!ok) repassar({ ...item, midia: undefined })
    }
  } finally {
    enviandoMidia = false
  }
}

/**
 * Histórico (mensagens antigas que o WhatsApp entrega em lote): vai direto,
 * em pedaços, sem passar pela fila — são centenas de uma vez, e a fila de
 * 2000 descartaria as mais velhas.
 */
export async function repassarLote(eventos) {
  if (!ligado() || !eventos.length) return 0
  let enviados = 0
  for (let i = 0; i < eventos.length; i += 200) {
    const pedaco = eventos.slice(i, i + 200)
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      try {
        const r = await fetch(`${RH_API_URL}/api/integracao/atendimento`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RH_API_TOKEN}` },
          body: JSON.stringify({ mensagens: pedaco }),
          signal: AbortSignal.timeout(60000),
        })
        if (r.ok) { enviados += pedaco.length; break }
      } catch { /* tenta de novo */ }
      await new Promise(res => setTimeout(res, 5000 * (tentativa + 1)))
    }
  }
  return enviados
}

export function situacao() {
  return { ligado: ligado(), naFila: fila.length, midiaNaFila: filaMidia.length, falhasSeguidas }
}
