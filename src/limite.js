/**
 * Quantas mensagens uma pessoa pode mandar antes de o robô parar de responder.
 *
 * Não existia limite nenhum. Qualquer número que descobrisse o WhatsApp podia
 * mandar mensagem sem parar, e cada uma delas custa uma chamada ao modelo de
 * conversa. A cota é diária e compartilhada: gasta por um, o robô cai no
 * roteiro fixo — que não sabe salário nem cidade — para o candidato de
 * verdade que escrever depois. Ou seja, o prejuízo não é a conta; é o
 * atendimento de quem interessa, no dia inteiro.
 *
 * O limite é por número e por janela de tempo. Não é castigo: quem passa
 * recebe UM aviso e volta a ser atendido quando a janela vira.
 *
 * Quem lança gasto NÃO passa por aqui. Vinte comprovantes seguidos no grupo é
 * o uso normal do módulo, e o próprio módulo já tem o seu limite (quantos
 * podem estar esperando resposta ao mesmo tempo).
 */

/** Mensagens permitidas dentro da janela. */
const MAX = Number(process.env.LIMITE_MENSAGENS || 25)

/** Tamanho da janela. */
const JANELA_MS = Number(process.env.LIMITE_JANELA_MIN || 10) * 60 * 1000

/**
 * telefone -> { marcas: number[], avisouEm: number|null }
 *
 * Só na memória, de propósito. Reiniciar libera todo mundo, e está certo:
 * o limite existe contra uma enxurrada acontecendo AGORA, não é uma punição
 * que deva sobreviver ao serviço. Guardar em disco daria a um número
 * qualquer o poder de fazer o robô escrever num arquivo.
 */
const porNumero = new Map()

/** Não deixa o Map crescer para sempre com quem passou uma vez e sumiu. */
function limpar(agora) {
  for (const [numero, reg] of porNumero) {
    const ultima = reg.marcas[reg.marcas.length - 1] ?? 0
    if (agora - ultima > JANELA_MS * 2) porNumero.delete(numero)
  }
}

/**
 * Registra a mensagem e diz o que fazer com ela.
 *
 * Devolve:
 *   { permitido: true }                    — atende normalmente
 *   { permitido: false, avisar: true }     — passou agora: manda UM aviso
 *   { permitido: false, avisar: false }    — já avisado: fica calado
 *
 * O aviso sai uma vez por janela. Repetir a cada mensagem transformaria o
 * robô no que se pretende evitar: uma máquina respondendo sem parar.
 */
export function registrar(numero, agora = Date.now()) {
  if (MAX <= 0) return { permitido: true }

  const chave = String(numero ?? '')
  if (!chave) return { permitido: true }

  if (porNumero.size > 500) limpar(agora)

  const reg = porNumero.get(chave) ?? { marcas: [], avisouEm: null }
  reg.marcas = reg.marcas.filter((t) => agora - t < JANELA_MS)

  if (reg.marcas.length >= MAX) {
    const jaAvisado = reg.avisouEm && agora - reg.avisouEm < JANELA_MS
    if (!jaAvisado) reg.avisouEm = agora
    porNumero.set(chave, reg)
    return { permitido: false, avisar: !jaAvisado }
  }

  reg.marcas.push(agora)
  porNumero.set(chave, reg)
  return { permitido: true }
}

/** O que dizer a quem passou do limite. */
export function textoDoAviso() {
  return 'Recebi bastante mensagem sua de uma vez e preciso de um tempinho '
    + 'para acompanhar. Daqui a pouco eu te respondo, tá?'
}

/** Para os testes: começa do zero. */
export function _limpar() {
  porNumero.clear()
}

/** Para o /metricas: quantos números estão sendo acompanhados agora. */
export function situacao() {
  return { numerosAcompanhados: porNumero.size, max: MAX, janelaMin: JANELA_MS / 60000 }
}
