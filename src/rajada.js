/**
 * Espera a pessoa terminar de escrever antes de responder.
 *
 * No WhatsApp ninguém escreve um parágrafo: escreve em rajada. Um candidato
 * mandou, em dez segundos, "3584387250", "Manu" e "Minha filha" — e o robô
 * respondeu as três, com a mesma frase de encerramento, três vezes seguidas.
 * Depois respondeu "Boa tarde! Tudo bem por aí?" a um "🙏".
 *
 * Gente não faz isso: gente espera a pessoa parar de digitar e responde uma
 * vez, ao conjunto. É o que este módulo faz — segura alguns segundos e junta
 * o que chegou.
 *
 * As mensagens anteriores da rajada resolvem como `null`: elas não somem, só
 * não são atendidas sozinhas. Quem responde por todas é a última.
 */

/** Quanto esperar depois da última mensagem. */
const ESPERA_MS = Number(process.env.RAJADA_ESPERA_MS || 6000)

/**
 * Teto para quem escreve sem parar: passado esse tempo desde a PRIMEIRA
 * mensagem, responde com o que tem. Sem isto, quem digita de dez em dez
 * segundos nunca receberia resposta.
 */
const MAXIMO_MS = Number(process.env.RAJADA_MAXIMO_MS || 20000)

export function criarAgrupador({ espera = ESPERA_MS, maximo = MAXIMO_MS } = {}) {
  /** chave -> { textos, primeiraEm, timer, aguardando } */
  const rajadas = new Map()

  function fechar(chave) {
    const r = rajadas.get(chave)
    if (!r) return
    rajadas.delete(chave)
    clearTimeout(r.timer)
    const juntos = r.textos.join('\n')
    // Só a última mensagem da rajada é atendida — e com o texto inteiro.
    r.aguardando.forEach((resolver, i) => resolver(i === r.aguardando.length - 1 ? juntos : null))
  }

  /**
   * Devolve o texto JUNTO da rajada, ou null quando outra mensagem vai
   * responder por esta.
   */
  return function agrupar(chave, texto, agora = Date.now()) {
    return new Promise((resolver) => {
      const atual = rajadas.get(chave)

      if (atual) {
        atual.textos.push(texto)
        atual.aguardando.push(resolver)
        clearTimeout(atual.timer)
        // Nunca além do teto contado da primeira mensagem.
        const restante = Math.max(0, Math.min(espera, atual.primeiraEm + maximo - agora))
        atual.timer = setTimeout(() => fechar(chave), restante)
        atual.timer.unref?.()
        return
      }

      const nova = { textos: [texto], primeiraEm: agora, aguardando: [resolver], timer: null }
      nova.timer = setTimeout(() => fechar(chave), espera)
      nova.timer.unref?.()
      rajadas.set(chave, nova)
    })
  }
}
