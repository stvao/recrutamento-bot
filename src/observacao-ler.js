/**
 * Lê o que o robô observou, conversa por conversa.
 *
 *   npm run observacao              tudo
 *   npm run observacao -- --dias 7  só os últimos 7 dias
 *   npm run observacao -- --resumo  só os números
 *
 * O resumo existe porque um número diz o que 200 conversas não dizem de
 * relance: quanto tempo o candidato espera pela primeira resposta, quantos
 * nunca recebem resposta, quanto do que chega é áudio.
 */
import { lerTudo, situacao } from './observacao.js'

const args = process.argv.slice(2)
const dias = Number(args[args.indexOf('--dias') + 1]) || null
const soResumo = args.includes('--resumo')

const desde = dias ? Date.now() - dias * 24 * 60 * 60 * 1000 : 0
const registros = lerTudo().filter(r => Date.parse(r.em) >= desde)

if (!registros.length) {
  console.log(`Nada observado ainda${dias ? ` nos últimos ${dias} dias` : ''}. (${situacao().pasta})`)
  process.exit(0)
}

// ── Agrupa por conversa ────────────────────────────────────────────────
const conversas = new Map()
for (const r of registros) {
  if (!conversas.has(r.conversa)) conversas.set(r.conversa, [])
  conversas.get(r.conversa).push(r)
}

const dataHora = (iso) => {
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const QUEM = { candidato: 'candidato', empresa: 'VOCÊ', robo: 'robô' }

// ── Números ────────────────────────────────────────────────────────────
//
// Primeira resposta: da primeira mensagem do candidato até a primeira da
// empresa (ou do robô) depois dela. Só conta conversa que o candidato começou.
const esperas = []
let semResposta = 0
for (const msgs of conversas.values()) {
  const primeira = msgs.find(m => m.autor === 'candidato')
  if (!primeira) continue
  const resposta = msgs.find(m => m.autor !== 'candidato' && m.em > primeira.em)
  if (resposta) esperas.push((Date.parse(resposta.em) - Date.parse(primeira.em)) / 60000)
  else semResposta++
}
esperas.sort((a, b) => a - b)
const mediana = esperas.length ? esperas[Math.floor(esperas.length / 2)] : null
const doCandidato = registros.filter(r => r.autor === 'candidato')
const audios = doCandidato.filter(r => r.tipo === 'audio').length

const tempo = (min) => min == null ? '—'
  : min < 60 ? `${Math.round(min)} min`
    : min < 1440 ? `${(min / 60).toFixed(1)} h` : `${(min / 1440).toFixed(1)} dias`

console.log('════════════════════════════════════════════════════════')
console.log(`Conversas: ${conversas.size}   Mensagens: ${registros.length}`)
console.log(`Do candidato: ${doCandidato.length} (${audios} em áudio — ${doCandidato.length ? Math.round(100 * audios / doCandidato.length) : 0}%)`)
console.log(`Primeira resposta: mediana ${tempo(mediana)}, pior ${tempo(esperas.at(-1) ?? null)}`)
console.log(`Conversas sem nenhuma resposta: ${semResposta}`)
console.log('════════════════════════════════════════════════════════')

if (soResumo) process.exit(0)

// ── As conversas ───────────────────────────────────────────────────────
for (const [codigo, msgs] of conversas) {
  const final = msgs.find(m => m.final)?.final
  console.log(`\n── ${codigo}${final ? ` (final ${final})` : ''} · ${msgs.length} mensagens · ${dataHora(msgs[0].em)} a ${dataHora(msgs.at(-1).em)}`)
  for (const m of msgs) {
    const corpo = m.texto ?? `[${m.tipo}]`
    console.log(`[${dataHora(m.em)}] ${QUEM[m.autor] ?? m.autor}: ${corpo}`)
  }
}
