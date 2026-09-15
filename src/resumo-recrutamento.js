/**
 * O resumo do recrutamento às 8h, no WhatsApp do gestor.
 *
 * O texto vem pronto do RH (só números e cidades, nenhum nome de candidato).
 * Só liga com RESUMO_RECRUTAMENTO_PARA no .env — sem número, não manda nada.
 * Um por dia: o dia do último envio fica guardado em dados/.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const ARQUIVO = () => process.env.RESUMO_RECRUTAMENTO_ARQUIVO || join(process.cwd(), 'dados', 'resumo-recrutamento.json')
export const HORA = Number(process.env.RESUMO_RECRUTAMENTO_HORA || 8)

export function destino() {
  const d = String(process.env.RESUMO_RECRUTAMENTO_PARA ?? '').replace(/\D/g, '')
  return d.length >= 12 ? d : null
}

const diaEmBrasilia = (agora) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora)
const horaEmBrasilia = (agora) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }).format(agora)) % 24

function ultimoDia() {
  try { return JSON.parse(readFileSync(ARQUIVO(), 'utf8')).dia } catch { return null }
}

/** Deve mandar agora? Na hora certa (ou depois, se o robô estava fora), uma vez por dia. */
export function deveEnviar(agora = new Date()) {
  if (!destino()) return false
  return horaEmBrasilia(agora) >= HORA && ultimoDia() !== diaEmBrasilia(agora)
}

export function marcarEnviado(agora = new Date()) {
  mkdirSync(dirname(ARQUIVO()), { recursive: true })
  writeFileSync(ARQUIVO(), JSON.stringify({ dia: diaEmBrasilia(agora) }))
}

export async function buscarTexto() {
  const url = process.env.RH_API_URL, token = process.env.RH_API_TOKEN
  if (!url || !token) return null
  try {
    const r = await fetch(`${url}/api/integracao/recrutamento/resumo-diario`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
    })
    const j = await r.json().catch(() => null)
    return r.ok && typeof j?.texto === 'string' ? j.texto : null
  } catch {
    return null
  }
}
