/**
 * O ritmo do robô: tetos por dia e a volta gradual depois de um bloqueio.
 *
 * O que este teste protege é o número do WhatsApp. O robô tem que se calar
 * quando passa do teto, subir os tetos aos poucos, e nunca barrar o que a
 * equipe mandou enviar.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.RITMO_ARQUIVO = join(tmpdir(), `ritmo-teste-${process.pid}.json`)
const { RAMPA, limitesDoDia, podeEnviar, anotarEnvio, recomecarRampa, situacao, esperarAVez, _zerar } = await import('../src/ritmo.js')

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}
const T = (iso) => Date.parse(iso)

// ── A rampa sobe com os dias ───────────────────────────────────────────
ok('dia da volta: primeiro degrau', limitesDoDia('2026-11-17', '2026-11-17').conversas === RAMPA[0].conversas)
ok('segundo dia: segundo degrau', limitesDoDia('2026-11-17', '2026-11-18').conversas === RAMPA[1].conversas)
ok('quarto ao sétimo dia: mesmo degrau', limitesDoDia('2026-11-17', '2026-11-20').conversas === 60 && limitesDoDia('2026-11-17', '2026-11-23').conversas === 60)
ok('oitavo dia em diante: degrau cheio', limitesDoDia('2026-11-17', '2026-11-24').conversas === 80 && limitesDoDia('2026-11-17', '2027-01-10').conversas === 80)
ok('os tetos nunca descem', RAMPA.every((d, i) => i === 0 || (d.conversas >= RAMPA[i - 1].conversas && d.mensagens >= RAMPA[i - 1].mensagens)))
ok('o intervalo nunca aumenta', RAMPA.every((d, i) => i === 0 || d.intervalo <= RAMPA[i - 1].intervalo))

// ── Teto por conversa ──────────────────────────────────────────────────
const dia1 = T('2026-11-17T15:00:00Z')
_zerar('2026-11-17', dia1)
for (let i = 0; i < RAMPA[0].porConversa; i++) { ok(`conversa: mensagem ${i + 1} passa`, podeEnviar('a', { agora: dia1 }).pode); anotarEnvio('a', dia1) }
const barrada = podeEnviar('a', { agora: dia1 })
ok('conversa: passou do teto, cala', barrada.pode === false && barrada.avisarLog === true)
ok('conversa: a segunda recusa não enche o registro', podeEnviar('a', { agora: dia1 }).avisarLog === false)
ok('outra conversa continua atendida', podeEnviar('b', { agora: dia1 }).pode)

// ── Teto de conversas no dia ───────────────────────────────────────────
_zerar('2026-11-17', dia1)
for (let i = 0; i < RAMPA[0].conversas; i++) anotarEnvio(`c${i}`, dia1)
ok('conversa nova além do teto: cala', podeEnviar('nova', { agora: dia1 }).pode === false)
ok('conversa já atendida hoje continua', podeEnviar('c0', { agora: dia1 }).pode)

// ── Teto de mensagens no dia ───────────────────────────────────────────
_zerar('2026-11-17', dia1)
for (let i = 0; i < RAMPA[0].mensagens; i++) anotarEnvio(`m${i % 15}`, dia1)
ok('total do dia estourado: cala todo mundo', podeEnviar('m0', { agora: dia1 }).pode === false)
ok('o que a equipe mandou enviar nunca é barrado', podeEnviar('m0', { forcar: true, agora: dia1 }).pode)

// ── Vira o dia: zera as contas e sobe o degrau ─────────────────────────
const dia2 = T('2026-11-18T15:00:00Z')
ok('dia seguinte volta a atender', podeEnviar('m0', { agora: dia2 }).pode)
const s = situacao(dia2)
ok('dia seguinte: contas zeradas e degrau 2', s.mensagens === 0 && s.diaDaVolta === 2 && s.limites.conversas === RAMPA[1].conversas)

// ── O dia vira em Brasília, não em UTC ─────────────────────────────────
_zerar('2026-11-17', T('2026-11-18T01:00:00Z')) // 22h de 17/11 em Brasília
anotarEnvio('x', T('2026-11-18T01:00:00Z'))
ok('22h em Brasília ainda é o mesmo dia', situacao(T('2026-11-18T02:30:00Z')).mensagens === 1)
ok('meia-noite e meia em Brasília já é outro', situacao(T('2026-11-18T03:30:00Z')).mensagens === 0)

// ── Ler o QR de novo recomeça a rampa ──────────────────────────────────
_zerar('2026-11-01', T('2026-11-20T15:00:00Z'))
ok('antes: degrau cheio', situacao(T('2026-11-20T15:00:00Z')).limites.conversas === 80)
recomecarRampa(T('2026-11-20T15:00:00Z'))
ok('depois do QR: volta ao primeiro degrau', situacao(T('2026-11-20T15:00:00Z')).limites.conversas === RAMPA[0].conversas)

// ── Intervalo entre envios ─────────────────────────────────────────────
_zerar('2026-11-17', dia1)
let relogio = dia1
const dormidas = []
const opts = { agora: () => relogio, dormir: async (ms) => { dormidas.push(ms); relogio += ms } }
await esperarAVez(opts)
await esperarAVez(opts)
await esperarAVez(opts)
ok('o primeiro envio não espera', dormidas.length === 2)
const min = RAMPA[0].intervalo * 1000
ok('os seguintes esperam pelo menos o intervalo', dormidas.every(ms => ms >= min * 0.999 && ms <= min * 1.4 + 1))

console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo')
process.exit(falhas ? 1 : 0)
