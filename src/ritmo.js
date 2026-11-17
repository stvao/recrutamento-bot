/**
 * Ritmo do robô no WhatsApp: quanto ele pode falar por dia, e a volta
 * gradual depois de um bloqueio (dono, 17/11/2026).
 *
 * Em 17/11/2026 o WhatsApp derrubou o aparelho do robô e bloqueou a conta
 * por 5 horas. Na véspera ele tinha mandado 1.208 mensagens em 145
 * conversas, respondendo na hora, até 9 por minuto, e 64 numa conversa só.
 * A conexão é a não oficial: nada aqui torna o robô "à prova de bloqueio",
 * só deixa o uso parecido com o de uma pessoa atendendo.
 *
 * Três tetos por dia, e um espaçamento entre um envio e o próximo:
 *   - conversas diferentes que o robô atende;
 *   - mensagens do robô no total;
 *   - mensagens do robô numa mesma conversa.
 *
 * Os tetos SOBEM aos poucos, contados do dia em que o número voltou (leu o
 * QR de novo). Passou do teto, o robô se cala: a conversa continua na
 * central de atendimento do RH, para uma pessoa responder. Calar é de
 * propósito — mandar a mesma frase pronta para todo mundo que passou do
 * limite seria justamente o disparo em massa que derruba a conta.
 *
 * Vale só para conversa com pessoa. Grupo de comprovantes e o que a equipe
 * envia pela central não passam por aqui.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ARQUIVO = process.env.RITMO_ARQUIVO || join(process.cwd(), 'dados', 'ritmo.json')

/**
 * A rampa: a partir de qual dia (1 = dia em que voltou) vale cada degrau.
 * `intervalo` é o mínimo, em segundos, entre dois envios para pessoas.
 */
export const RAMPA = [
  { aPartirDoDia: 1, conversas: 20, mensagens: 120, porConversa: 8, intervalo: 20 },
  { aPartirDoDia: 2, conversas: 30, mensagens: 200, porConversa: 8, intervalo: 15 },
  { aPartirDoDia: 3, conversas: 45, mensagens: 300, porConversa: 10, intervalo: 12 },
  { aPartirDoDia: 4, conversas: 60, mensagens: 450, porConversa: 10, intervalo: 10 },
  { aPartirDoDia: 8, conversas: 80, mensagens: 600, porConversa: 12, intervalo: 8 },
]

/** RITMO=off desliga tudo (volta a ser como era). */
const LIGADO = (process.env.RITMO || 'on').toLowerCase() !== 'off'

const numero = (nome) => {
  const v = Number(process.env[nome])
  return Number.isFinite(v) && v > 0 ? v : null
}

const diaDe = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ms))

/** Dias corridos entre duas datas YYYY-MM-DD. */
function diasEntre(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000)
}

/** Os tetos de hoje. As variáveis RITMO_* fixam um valor e ignoram a rampa. */
export function limitesDoDia(voltouEm, hoje) {
  const dia = Math.max(1, diasEntre(voltouEm, hoje) + 1)
  const degrau = [...RAMPA].reverse().find(d => dia >= d.aPartirDoDia) ?? RAMPA[0]
  return {
    dia,
    conversas: numero('RITMO_CONVERSAS') ?? degrau.conversas,
    mensagens: numero('RITMO_MENSAGENS') ?? degrau.mensagens,
    porConversa: numero('RITMO_POR_CONVERSA') ?? degrau.porConversa,
    intervalo: numero('RITMO_INTERVALO') ?? degrau.intervalo,
  }
}

function vazio(hoje) {
  return { voltouEm: hoje, dia: hoje, mensagens: 0, porConversa: {}, caladas: {} }
}

let estado = null

function carregar(agora) {
  if (estado) return estado
  const hoje = diaDe(agora)
  try {
    if (existsSync(ARQUIVO)) {
      const lido = JSON.parse(readFileSync(ARQUIVO, 'utf8'))
      if (lido && typeof lido === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(lido.voltouEm ?? '')) {
        estado = { ...vazio(hoje), ...lido, porConversa: lido.porConversa ?? {}, caladas: lido.caladas ?? {} }
        return estado
      }
    }
  } catch (e) {
    console.error('[ritmo] arquivo ilegível, começando do zero:', e.message)
  }
  // Sem registro: o robô está voltando agora. Começa pelo primeiro degrau.
  estado = vazio(hoje)
  return estado
}

function gravar() {
  try {
    mkdirSync(dirname(ARQUIVO), { recursive: true })
    writeFileSync(ARQUIVO, JSON.stringify(estado))
  } catch (e) {
    console.error('[ritmo] não consegui gravar:', e.message)
  }
}

/** Dia novo: zera as contas, mantém a data da volta. */
function virarODia(agora) {
  const e = carregar(agora)
  const hoje = diaDe(agora)
  if (e.dia !== hoje) {
    e.dia = hoje
    e.mensagens = 0
    e.porConversa = {}
    e.caladas = {}
  }
  return e
}

/**
 * O robô pode mandar esta mensagem agora?
 *
 * Devolve `{ pode: true }` ou `{ pode: false, motivo, avisarLog }`.
 * `avisarLog` é verdadeiro só na primeira recusa de cada conversa no dia,
 * para o registro não encher com a mesma linha.
 *
 * `forcar`: o que a equipe mandou enviar (pedido de documentos, cobrança).
 * Conta no total do dia, mas nunca é barrado.
 */
export function podeEnviar(conversa, { forcar = false, agora = Date.now() } = {}) {
  if (!LIGADO) return { pode: true }
  const e = virarODia(agora)
  if (forcar) return { pode: true }
  const lim = limitesDoDia(e.voltouEm, e.dia)
  const jaNaConversa = e.porConversa[conversa] ?? 0
  const conversasHoje = Object.keys(e.porConversa).length

  let motivo = null
  if (e.mensagens >= lim.mensagens) motivo = `teto de ${lim.mensagens} mensagens no dia`
  else if (!jaNaConversa && conversasHoje >= lim.conversas) motivo = `teto de ${lim.conversas} conversas no dia`
  else if (jaNaConversa >= lim.porConversa) motivo = `teto de ${lim.porConversa} mensagens nesta conversa`
  if (!motivo) return { pode: true }

  const avisarLog = !e.caladas[conversa]
  if (avisarLog) { e.caladas[conversa] = motivo; gravar() }
  return { pode: false, motivo, avisarLog }
}

/** Anota que uma mensagem saiu. */
export function anotarEnvio(conversa, agora = Date.now()) {
  if (!LIGADO) return
  const e = virarODia(agora)
  e.mensagens++
  e.porConversa[conversa] = (e.porConversa[conversa] ?? 0) + 1
  gravar()
}

/** O número voltou depois de ler um QR novo: a rampa recomeça hoje. */
export function recomecarRampa(agora = Date.now()) {
  const e = virarODia(agora)
  e.voltouEm = diaDe(agora)
  gravar()
  console.log('[ritmo] número reconectado por QR — volta gradual recomeça hoje.')
}

/**
 * Espera a vez: garante o intervalo mínimo entre dois envios para pessoas.
 * Os envios entram em fila; o sorteio de até 40% a mais evita ritmo de relógio.
 */
let fila = Promise.resolve()
let ultimoEnvio = 0
export function esperarAVez({ agora = () => Date.now(), dormir = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!LIGADO) return Promise.resolve()
  const vez = fila.then(async () => {
    const e = virarODia(agora())
    const minimo = limitesDoDia(e.voltouEm, e.dia).intervalo * 1000 * (1 + Math.random() * 0.4)
    const falta = ultimoEnvio + minimo - agora()
    if (falta > 0) await dormir(falta)
    ultimoEnvio = agora()
  })
  fila = vez.catch(() => {})
  return vez
}

/** Para o registro e para quem quiser ver como está o dia. */
export function situacao(agora = Date.now()) {
  if (!LIGADO) return { ligado: false }
  const e = virarODia(agora)
  const lim = limitesDoDia(e.voltouEm, e.dia)
  return {
    ligado: true, voltouEm: e.voltouEm, diaDaVolta: lim.dia, limites: lim,
    mensagens: e.mensagens, conversas: Object.keys(e.porConversa).length, caladas: Object.keys(e.caladas).length,
  }
}

/** Só para os testes. */
export function _zerar(voltouEm = null, agora = Date.now()) {
  estado = vazio(diaDe(agora))
  if (voltouEm) estado.voltouEm = voltouEm
  fila = Promise.resolve()
  ultimoEnvio = 0
}
