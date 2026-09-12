/**
 * Onde uma pessoa já está atendendo, o robô cala a boca.
 *
 * Em 12/09/2026, minutos depois de o robô ser ligado, ele e o dono
 * responderam o MESMO candidato ao mesmo tempo: o dono escreveu "preenche
 * essa ficha que eu peço para te ligarem" e, no mesmo minuto, o robô
 * perguntou "você está procurando vaga por aqui?". Para quem está do outro
 * lado, é a empresa falando duas coisas diferentes — e uma delas ignorando o
 * que a outra acabou de dizer.
 *
 * A regra é simples e sempre a favor da pessoa: se alguém da empresa
 * escreveu naquela conversa nas últimas horas, o robô não responde. Quem
 * assumiu, assumiu.
 *
 * Só na memória, de propósito. Reiniciar libera o robô de novo, e está
 * certo: o risco de ele ficar mudo para sempre por causa de um arquivo velho
 * é maior que o de ele voltar a responder uma conversa parada.
 */

/** Por quantas horas o robô se cala depois de uma resposta de gente. */
const JANELA_MS = Number(process.env.HUMANO_JANELA_H || 12) * 60 * 60 * 1000

const MAX = 2000

/** numero -> quando a última mensagem de gente saiu naquela conversa. */
const ultimaDeGente = new Map()

function limpar(agora) {
  for (const [numero, quando] of ultimaDeGente) {
    if (agora - quando > JANELA_MS * 2) ultimaDeGente.delete(numero)
  }
}

/** Alguém da empresa respondeu esta conversa agora. */
export function gentesRespondeu(numero, agora = Date.now()) {
  const chave = String(numero ?? '')
  if (!chave) return
  if (ultimaDeGente.size > MAX) limpar(agora)
  ultimaDeGente.set(chave, agora)
}

/**
 * Esta conversa está sendo atendida por gente?
 *
 * Devolve { atendida, faz } — `faz` são os minutos desde a última mensagem
 * da empresa, para o log dizer por que o robô ficou quieto.
 */
export function atendidaPorGente(numero, agora = Date.now()) {
  const quando = ultimaDeGente.get(String(numero ?? ''))
  if (!quando) return { atendida: false, faz: null }
  const faz = agora - quando
  return { atendida: faz < JANELA_MS, faz: Math.round(faz / 60000) }
}

/** Para teste. */
export function _limpar() {
  ultimaDeGente.clear()
}

export function situacao() {
  return { conversasComGente: ultimaDeGente.size, janelaHoras: JANELA_MS / 3600000 }
}
