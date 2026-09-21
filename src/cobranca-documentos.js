/**
 * A cobrança de documento para quem JÁ TRABALHA na empresa.
 *
 * O robô foi desligado para funcionário por decisão do dono (12/09/2026): ele
 * atende candidato, e funcionário fala com gente. Isto NÃO desfaz aquilo. O
 * robô continua sem conversar com funcionário — o que ele faz aqui é uma coisa
 * só, estreita:
 *
 *   - uma vez por semana, no dia combinado, em horário comercial;
 *   - para quem tem documento faltando ou vencendo;
 *   - com texto FIXO, escrito aqui — nenhuma palavra sai de modelo de IA;
 *   - sem link, sem valor, sem número de documento.
 *
 * E vem DESLIGADO. Liga com COBRAR_DOCUMENTOS=on — é decisão do dono, não do
 * código.
 *
 * Aqui só a DECISÃO e o TEXTO, sem WhatsApp nem relógio: quem envia é o
 * server.js, no mesmo desenho do lembrete de cadastro.
 */
import { horarioComercial } from './lembrete-cadastro.js'

export function cobrancaLigada(env = process.env) {
  return env.COBRAR_DOCUMENTOS === 'on'
}

const DIAS = { dom: 'Sun', seg: 'Mon', ter: 'Tue', qua: 'Wed', qui: 'Thu', sex: 'Fri', sab: 'Sat' }

/** O dia da semana da cobrança. Padrão segunda: a semana começando na obra. */
export function diaDaCobranca(env = process.env) {
  const d = String(env.COBRANCA_DIA || 'seg').toLowerCase().slice(0, 3)
  return DIAS[d] ?? 'Mon'
}

/** Dia da semana em Brasília — o servidor roda em UTC. */
export function diaDaSemanaSP(agora = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' })
    .format(agora)
}

/** É hora de rodar a cobrança? Devolve o motivo, para o log e para o teste. */
export function deveRodar({ agora = new Date(), env = process.env } = {}) {
  if (!cobrancaLigada(env)) return { rodar: false, motivo: 'desligada' }
  if (diaDaSemanaSP(agora) !== diaDaCobranca(env)) return { rodar: false, motivo: 'não é o dia' }
  if (!horarioComercial(agora)) return { rodar: false, motivo: 'fora do horário comercial' }
  return { rodar: true, motivo: 'dia de cobrar' }
}

/**
 * Quantas mensagens por rodada, e a pausa entre elas.
 *
 * O conector é o Baileys, não-oficial. Mandar dezenas de mensagens seguidas é
 * o padrão que o WhatsApp reconhece como disparo em massa — e o castigo é
 * banir o número, que é o mesmo número por onde entram os candidatos. A
 * rodada roda a cada 15 minutos o dia inteiro; conta-gotas cabe com folga.
 */
export const MAX_POR_RODADA = Number(process.env.COBRANCA_MAX_POR_RODADA || 8)
export const PAUSA_MIN_MS = 25_000
export const PAUSA_MAX_MS = 45_000

export function pausa() {
  return PAUSA_MIN_MS + Math.floor(Math.random() * (PAUSA_MAX_MS - PAUSA_MIN_MS))
}

/** A mensagem não vira uma parede: até quatro, e "mais N". */
export const MAX_ITENS_NA_MENSAGEM = 4

/** "RG", "CNH, que venceu", "ASO, que vence em 15 dias". */
export function descrever(item) {
  const rotulo = item?.rotulo ?? 'documento'
  if (item?.motivo === 'VENCIDO') return `${rotulo}, que venceu`
  if (item?.motivo === 'VENCENDO') {
    const d = Number(item.dias ?? 0)
    return d <= 0 ? `${rotulo}, que vence hoje` : `${rotulo}, que vence em ${d} dia${d === 1 ? '' : 's'}`
  }
  return rotulo
}

/** "RG, CPF e comprovante de residência". */
export function listaFalada(partes) {
  if (partes.length <= 1) return partes[0] ?? ''
  return `${partes.slice(0, -1).join(', ')} e ${partes[partes.length - 1]}`
}

/** O texto da cobrança. Curto, sem emoji, no jeito das outras mensagens do robô. */
export function textoDaCobranca(primeiroNome, itens) {
  const nome = String(primeiroNome ?? '').trim()
  const mostrados = (itens ?? []).slice(0, MAX_ITENS_NA_MENSAGEM).map(descrever)
  const resto = (itens ?? []).length - mostrados.length
  if (resto > 0) mostrados.push(`mais ${resto} documento${resto === 1 ? '' : 's'}`)

  const oi = nome ? `oi ${nome}, aqui é do RH da KE.` : 'oi, aqui é do RH da KE.'
  return `${oi} pra deixar sua ficha em dia preciso de: ${listaFalada(mostrados)}. `
    + 'pode mandar a foto por aqui mesmo'
}

/** A resposta a quem acabou de mandar a foto — só com a cobrança ligada. */
export function textoDoRecebido(recebido, faltam) {
  const oQue = recebido ? `recebi ${recebido}` : 'recebi aqui'
  const lista = Array.isArray(faltam) ? faltam : []
  if (lista.length === 0) return `${oQue}, obrigada. sua ficha tá em dia`
  return `${oQue}, obrigada. ainda falta: ${listaFalada(lista.slice(0, MAX_ITENS_NA_MENSAGEM))}`
}
