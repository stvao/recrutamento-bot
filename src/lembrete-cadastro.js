/**
 * A mensagem para quem parou no meio do cadastro.
 *
 * Regras aprovadas pelo dono (14/09/2026), todas aqui e testadas:
 *  - uma única vez, 24 horas depois da última mensagem;
 *  - só em horário comercial;
 *  - só para quem ainda não terminou a ficha;
 *  - nunca para quem está com uma pessoa da empresa, foi passado para
 *    atendimento humano (cobrança, funcionário, pediu gente) ou disse que
 *    responde depois;
 *  - se não responder, não manda mais nada.
 *
 * Aqui só a DECISÃO, sem WhatsApp nem relógio: quem envia é o server.js.
 */
import { oQueJaSabe } from './atendimento.js'

export const ESPERA_MS = 24 * 3600_000
/** Depois disso a conversa já expirou (store: 3 dias); não se lembra mais. */
export const LIMITE_MS = 72 * 3600_000

const DISSE_QUE_VOLTA = /depois|mais tarde|amanh[aã]|agora n[aã]o|trabalhando|no servi[cç]o|t[oô] ocupad|sem interesse|n[aã]o tenho interesse|desist|n[aã]o quero/i

/** Segunda a sábado, das 8h às 18h, no horário de Brasília. */
export function horarioComercial(agora = new Date()) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', weekday: 'short', hour: 'numeric', hour12: false,
  }).formatToParts(agora)
  const dia = partes.find(p => p.type === 'weekday')?.value
  const hora = Number(partes.find(p => p.type === 'hour')?.value) % 24
  return dia !== 'Sun' && hora >= 8 && hora < 18
}

/**
 * Esta conversa deve receber o lembrete agora?
 *
 * `sessao` é o registro do store: { estado, atualizadoEm, escalouEm }.
 * Devolve { lembrar, motivo } — o motivo existe para o teste e para o log.
 */
export function decidir(sessao, { agora = Date.now(), atendidaPorGente = false, comercial = horarioComercial(new Date(agora)) } = {}) {
  const e = sessao?.estado
  if (!e || (e.modo !== 'ia' && e.modo !== 'roteiro')) return { lembrar: false, motivo: 'não é cadastro' }
  if (e.lembradoEm) return { lembrar: false, motivo: 'já lembrado' }
  if (sessao.escalouEm) return { lembrar: false, motivo: 'com atendimento humano' }
  if (atendidaPorGente) return { lembrar: false, motivo: 'pessoa da empresa atendendo' }

  const parado = agora - (sessao.atualizadoEm ?? agora)
  if (parado < ESPERA_MS) return { lembrar: false, motivo: 'ainda não deu 24h' }
  if (parado >= LIMITE_MS) return { lembrar: false, motivo: 'parado há tempo demais' }
  if (!comercial) return { lembrar: false, motivo: 'fora do horário comercial' }

  /*
    Conversa fechada não recebe "não terminamos seu cadastro".

    Quem respondeu "pode sim" à pergunta de passar a ficha ouviu "o
    responsável te liga" — e 25h depois recebia um lembrete dizendo o
    contrário. Quem disse que não quis também: a regra é não insistir. E a
    conversa que terminou no ROTEIRO ("sua candidatura foi registrada") não
    tem as perguntas que só a IA faz, então a ficha nunca conta como completa.
  */
  if (e.confirmouInteresse === 'sim' || e.confirmouInteresse === 'nao') {
    return { lembrar: false, motivo: 'conversa fechada' }
  }
  if (e.modo === 'roteiro' && e.etapa === 'fim') return { lembrar: false, motivo: 'roteiro concluiu' }

  /*
    Só conta como falta o que a PESSOA ainda deve responder. O que depende do
    robô — conferir o que ela sabe fazer, pedir a confirmação da ligação — não
    é motivo para dizer que ela não terminou o cadastro.
  */
  const doRobo = /sabe fazer|passar sua ficha/i
  if (oQueJaSabe(e).falta.filter(x => !doRobo.test(x)).length === 0) {
    return { lembrar: false, motivo: 'ficha completa' }
  }

  const historico = e.historico ?? []
  const ultima = historico[historico.length - 1]
  // A última palavra foi da pessoa: quem ficou devendo resposta foi o robô.
  if (ultima && ultima.de !== 'maria') return { lembrar: false, motivo: 'última mensagem foi da pessoa' }
  const daPessoa = [...historico].reverse().find(m => m.de !== 'maria')
  if (daPessoa && DISSE_QUE_VOLTA.test(daPessoa.texto ?? '')) return { lembrar: false, motivo: 'disse que responde depois' }

  return { lembrar: true, motivo: 'cadastro parado' }
}

export function texto(estado) {
  const vaga = estado?.vaga ? ` pra vaga de ${String(estado.vaga).toLowerCase()}` : ''
  return `oi, tudo bem? vi que a gente não terminou seu cadastro${vaga}. se ainda tiver interesse é só me responder aqui`
}
