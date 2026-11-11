/**
 * Cobrança de diário de obras e de controle de pessoal.
 *
 * O sistema de obras decide QUEM cobrar e ESCREVE o texto
 * (`GET /api/integracao-rh/conferencia/cobrancas`, contrato em
 * docs/ROBO-WHATSAPP.md do NovaGestaoObras). Aqui só se entrega: uma vez por
 * dia, de manhã, em conta-gotas. Nenhuma palavra sai de modelo de IA, e o
 * texto não é reescrito.
 *
 * Três modos, em COBRAR_CONFERENCIA:
 *   off    (padrão) — não faz nada.
 *   ensaio — junta tudo o que IRIA para a equipe numa mensagem só e manda
 *            para CONFERENCIA_ENSAIO_PARA. Ninguém da equipe recebe nada.
 *            É para o dono ver por uns dias se as cobranças estão certas.
 *   on     — cada um recebe a sua; os administradores recebem o bloco deles.
 *
 * Aqui ficam a DECISÃO, o TEXTO e o registro do que já foi; quem envia é o
 * server.js, no mesmo desenho da cobrança de documentos.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export function modoCobranca(env = process.env) {
  const m = String(env.COBRAR_CONFERENCIA ?? 'off').trim().toLowerCase()
  return m === 'on' || m === 'ensaio' ? m : 'off'
}

/** Para onde vai o ensaio. Sem número válido, o ensaio não roda. */
export function destinoDoEnsaio(env = process.env) {
  const d = String(env.CONFERENCIA_ENSAIO_PARA ?? '').replace(/\D/g, '')
  if (d.length === 10 || d.length === 11) return `55${d}`
  return d.length >= 12 ? d : null
}

/** 'diaria' (padrão): todo dia útil. 'semanal': só no dia combinado. */
export function frequencia(env = process.env) {
  return String(env.CONFERENCIA_FREQUENCIA ?? '').toLowerCase() === 'semanal' ? 'semanal' : 'diaria'
}

const DIAS = { dom: 'Sun', seg: 'Mon', ter: 'Tue', qua: 'Wed', qui: 'Thu', sex: 'Fri', sab: 'Sat' }
export function diaDaSemanal(env = process.env) {
  return DIAS[String(env.CONFERENCIA_DIA_SEMANAL || 'seg').toLowerCase().slice(0, 3)] ?? 'Mon'
}

/** A partir de que hora manda. Até as 18h: depois disso, fica para amanhã. */
export function horaDeComecar(env = process.env) {
  const h = Number(env.CONFERENCIA_HORA ?? 8)
  return Number.isFinite(h) && h >= 0 && h < 18 ? h : 8
}

export function diaEmBrasilia(agora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora)
}
function semanaEHora(agora) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', weekday: 'short', hour: 'numeric', hour12: false,
  }).formatToParts(agora)
  return {
    dia: p.find(x => x.type === 'weekday')?.value,
    hora: Number(p.find(x => x.type === 'hour')?.value) % 24,
  }
}

/** É hora de rodar? Devolve o motivo, para o log e para o teste. */
export function deveRodar({ agora = new Date(), env = process.env, estado = {} } = {}) {
  const modo = modoCobranca(env)
  if (modo === 'off') return { rodar: false, motivo: 'desligada' }
  if (modo === 'ensaio' && !destinoDoEnsaio(env)) return { rodar: false, motivo: 'ensaio sem CONFERENCIA_ENSAIO_PARA' }
  const { dia, hora } = semanaEHora(agora)
  if (dia === 'Sun') return { rodar: false, motivo: 'domingo' }
  if (frequencia(env) === 'semanal' && dia !== diaDaSemanal(env)) return { rodar: false, motivo: 'não é o dia' }
  if (hora < horaDeComecar(env) || hora >= 18) return { rodar: false, motivo: 'fora do horário' }
  if (estado.dia === diaEmBrasilia(agora) && estado.concluido) return { rodar: false, motivo: 'já foi hoje' }
  return { rodar: true, motivo: modo }
}

const ULTIMOS4 = (t) => String(t ?? '').replace(/\D/g, '').slice(-4)

/** Junta as mensagens num texto só para o ensaio. Longo demais, corta. */
export const LIMITE_ENSAIO = 6000
export function textoDoEnsaio(resposta) {
  const todas = [
    ...(resposta?.mensagens ?? []).map(m => ({ ...m, papel: '' })),
    ...(resposta?.gestores ?? []).map(m => ({ ...m, papel: ' (administrador)' })),
  ].filter(m => m?.texto)
  if (!todas.length) return null

  const cab = [
    '🧪 *Ensaio — cobrança de diário e presença*',
    `Nada disto foi enviado. Com a cobrança ligada, hoje iriam ${todas.length} mensagem(ns):`,
  ].join('\n')
  const partes = [cab]
  let tamanho = cab.length
  let cortadas = 0
  for (const m of todas) {
    const bloco = `— *Para ${m.nome ?? 'sem nome'}*${m.papel} (final ${ULTIMOS4(m.telefone)}):\n${m.texto}`
    if (tamanho + bloco.length > LIMITE_ENSAIO) { cortadas++; continue }
    partes.push(bloco)
    tamanho += bloco.length + 2
  }
  if (cortadas) partes.push(`… e mais ${cortadas}. Veja todas em Conferência diária → Mensagens do robô.`)
  return partes.join('\n\n')
}

export const RODAPE = '\n\n_Mensagem automática do sistema de obras._'

/**
 * Quando a cobrança sai do número de uma PESSOA (o do dono), a primeira linha
 * diz que foi o sistema que escreveu — quem lê sabe que não é bronca pessoal
 * e que responder ali é falar com gente.
 */
export const CABECALHO = '🤖 *Aviso automático — Sistema NovaGestão Obras*\n\n'

/**
 * O que mandar, e para quem. Cada envio tem uma `chave`: é ela que impede
 * mandar duas vezes no mesmo dia, inclusive depois de o robô reiniciar no
 * meio da rodada.
 */
export function montarEnvios(resposta, { modo, ensaioPara, cabecalho = false } = {}) {
  if (!resposta) return []
  if (modo === 'ensaio') {
    const texto = textoDoEnsaio(resposta)
    return texto && ensaioPara ? [{ chave: `ensaio:${ensaioPara}`, telefone: ensaioPara, texto, cobrado: false }] : []
  }
  if (modo !== 'on') return []
  const envios = []
  const vistos = new Set()
  for (const [lista, tipo] of [[resposta.mensagens, 'equipe'], [resposta.gestores, 'gestor']]) {
    for (const m of lista ?? []) {
      const tel = String(m?.telefone ?? '').replace(/\D/g, '')
      if (tel.length < 12 || !m.texto) continue
      const chave = `${tipo}:${tel}`
      if (vistos.has(chave)) continue
      vistos.add(chave)
      const texto = cabecalho ? CABECALHO + m.texto : m.texto + RODAPE
      envios.push({ chave, telefone: tel, texto, cobrado: tipo === 'equipe' })
    }
  }
  return envios
}

// ── Estado: o que já foi hoje, e quem foi cobrado nos últimos dias ─────────

const ARQUIVO = () => process.env.CONFERENCIA_ARQUIVO || join(process.cwd(), 'dados', 'cobranca-conferencia.json')

export function lerEstado() {
  try {
    const j = JSON.parse(readFileSync(ARQUIVO(), 'utf8'))
    return { dia: j.dia ?? null, concluido: !!j.concluido, enviados: j.enviados ?? [], cobrados: j.cobrados ?? {} }
  } catch {
    return { dia: null, concluido: false, enviados: [], cobrados: {} }
  }
}

export function gravarEstado(estado) {
  mkdirSync(dirname(ARQUIVO()), { recursive: true })
  writeFileSync(ARQUIVO(), JSON.stringify(estado))
}

/** Começa o dia, se mudou: zera o que foi enviado e esquece cobrança velha. */
export function estadoDoDia(estado, agora = new Date()) {
  const hoje = diaEmBrasilia(agora)
  const limite = agora.getTime() - DIAS_RESPOSTA * 86_400_000
  const cobrados = Object.fromEntries(
    Object.entries(estado.cobrados ?? {}).filter(([, quando]) => Date.parse(quando) >= limite),
  )
  if (estado.dia === hoje) return { ...estado, cobrados }
  return { dia: hoje, concluido: false, enviados: [], cobrados }
}

/**
 * Quem recebeu cobrança e responde no WhatsApp não pode cair na conversa de
 * recrutamento ("para qual vaga você procura?"). Por estes dias depois da
 * cobrança, a resposta vai para gente, não para o robô.
 */
export const DIAS_RESPOSTA = 3

export function formas(numero) {
  const d = String(numero ?? '').split('@')[0].replace(/\D/g, '')
  if (!d) return []
  const c = d.length <= 11 ? `55${d}` : d
  const out = new Set([c])
  // celular com e sem o nono dígito: 55 + DDD + 9XXXXXXXX  <->  55 + DDD + XXXXXXXX
  if (c.length === 13 && c[4] === '9') out.add(c.slice(0, 4) + c.slice(5))
  if (c.length === 12 && /[6-9]/.test(c[4])) out.add(c.slice(0, 4) + '9' + c.slice(4))
  return [...out]
}

export function foiCobradoRecentemente(numero, estado = lerEstado(), agora = new Date()) {
  const limite = agora.getTime() - DIAS_RESPOSTA * 86_400_000
  return formas(numero).some(f => {
    const quando = estado.cobrados?.[f]
    return quando && Date.parse(quando) >= limite
  })
}

// ── Busca no sistema de obras ───────────────────────────────────────────────

/**
 * Busca as mensagens prontas. Nunca lança: sem resposta, a rodada tenta de
 * novo dali a pouco.
 *
 * O token é o RH_INTEGRATION_TOKEN do sistema de obras (o mesmo que o RH usa
 * para falar com ele) — NÃO o OBRAS_API_TOKEN, que só cria comprovante.
 */
export async function buscarCobrancas(modo = 'diaria', env = process.env, fetchFn = fetch) {
  const url = env.OBRAS_API_URL || 'https://novagestaoobras.duckdns.org'
  const token = env.OBRAS_INTEGRACAO_TOKEN
  if (!token) {
    console.warn('[conferencia] OBRAS_INTEGRACAO_TOKEN não configurado — nada a buscar.')
    return null
  }
  try {
    const r = await fetchFn(`${url}/api/integracao-rh/conferencia/cobrancas?modo=${modo}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
    })
    if (!r.ok) {
      console.warn(`[conferencia] sistema de obras respondeu ${r.status}`)
      return null
    }
    const j = await r.json().catch(() => null)
    return j && Array.isArray(j.mensagens) ? j : null
  } catch (e) {
    console.warn('[conferencia] não consegui falar com o sistema de obras:', e.message)
    return null
  }
}

/** Quantas por rodada, e a pausa entre uma e outra (Baileys não gosta de rajada). */
export const MAX_POR_RODADA = Number(process.env.CONFERENCIA_MAX_POR_RODADA || 8)
export function pausa() {
  return 25_000 + Math.floor(Math.random() * 20_000)
}

/**
 * Uma rodada inteira, com o envio e a espera injetados (para o teste).
 * Marca cada envio logo depois do ok: se o robô cair no meio, quem já
 * recebeu não recebe de novo, e quem faltou recebe na próxima rodada.
 */
export async function rodar({
  agora = new Date(), env = process.env, enviar, esperar = (ms) => new Promise(ok => setTimeout(ok, ms)),
  buscar = buscarCobrancas, ler = lerEstado, gravar = gravarEstado, cabecalho = false,
} = {}) {
  let estado = estadoDoDia(ler(), agora)
  const d = deveRodar({ agora, env, estado })
  if (!d.rodar) return { rodou: false, motivo: d.motivo }

  const resposta = await buscar(frequencia(env), env)
  if (!resposta) return { rodou: false, motivo: 'sem resposta do sistema de obras' }

  const modo = modoCobranca(env)
  const todos = montarEnvios(resposta, { modo, ensaioPara: destinoDoEnsaio(env), cabecalho })
  const faltam = todos.filter(e => !estado.enviados.includes(e.chave))
  const agoraVai = faltam.slice(0, MAX_POR_RODADA)

  let enviados = 0
  for (const [i, e] of agoraVai.entries()) {
    if (i > 0) await esperar(pausa())
    const r = await enviar(e.telefone, e.texto)
    if (!r?.ok) continue
    enviados++
    estado = {
      ...estado,
      enviados: [...estado.enviados, e.chave],
      cobrados: e.cobrado ? { ...estado.cobrados, [e.telefone]: agora.toISOString() } : estado.cobrados,
    }
    gravar(estado)
  }

  const concluido = todos.every(e => estado.enviados.includes(e.chave))
  estado = { ...estado, concluido }
  gravar(estado)
  return { rodou: true, modo, total: todos.length, enviados, concluido }
}
