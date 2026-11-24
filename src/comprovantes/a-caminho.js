/**
 * Comprovantes — a foto que ainda está sendo baixada.
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 *
 * Caso real (grupo "Comprovantes", 24/11/2026): a pessoa mandou o PDF e, 8
 * segundos depois, "Material, pereiras". O robô ignorou a legenda e
 * perguntou a obra. Noutra vez, "125,42 pedágios ratear com todas as obras"
 * foi parar no comprovante ANTERIOR — que entrou na caixa com o valor do
 * novo.
 *
 * A causa: a foto precisa ser BAIXADA antes de chegar aqui, e o texto não.
 * Mandados um atrás do outro, o texto chegava primeiro — sem foto nenhuma
 * esperando legenda, ou com uma foto velha esperando resposta.
 *
 * Aqui fica a lista do que está a caminho. O conector anota a foto assim que
 * ela chega (antes de baixar), e o texto da mesma pessoa, mandado DEPOIS da
 * foto, espera ela ser guardada antes de decidir a quem pertence. Texto que
 * não tem foto nenhuma a caminho segue na hora.
 */

/** Quanto um texto espera, no máximo, por uma foto a caminho. */
const ESPERA_MAXIMA_MS = Number(process.env.GASTOS_ESPERA_ARQUIVO_MS || 30000)

/** Uma foto anotada e nunca solta (o conector caiu no meio) deixa de contar depois disto. */
const VALIDADE_MS = 90000

/** chave do remetente → Map(id da mensagem → { enviadoEm, pronto, soltar, ate }) */
const aCaminho = new Map()

/**
 * A chave de quem mandou, numa conversa. Calculada do jeito mais cru — o
 * endereço da conversa e o do participante —, porque tem de ser a mesma
 * para a foto e para o texto antes de qualquer tradução de número.
 */
export function chaveDoRemetente(chat, participante) {
  return chat ? `${chat}|${participante ?? chat}` : null
}

/** Anota que uma foto desta pessoa está a caminho. Devolve a função que a solta. */
export function arquivoACaminho(chave, idMensagem, enviadoEm) {
  if (!chave || !idMensagem) return () => {}
  let soltar
  const pronto = new Promise((ok) => { soltar = ok })
  const doRemetente = aCaminho.get(chave) ?? new Map()
  doRemetente.set(idMensagem, { enviadoEm: enviadoEm ?? Date.now(), pronto, soltar, ate: Date.now() + VALIDADE_MS })
  aCaminho.set(chave, doRemetente)
  return () => soltarArquivo(chave, idMensagem)
}

/** A foto chegou ao módulo (ou desistiu-se dela). */
export function soltarArquivo(chave, idMensagem) {
  const doRemetente = aCaminho.get(chave)
  const item = doRemetente?.get(idMensagem)
  if (!item) return
  item.soltar()
  doRemetente.delete(idMensagem)
  if (!doRemetente.size) aCaminho.delete(chave)
}

/**
 * Espera as fotos desta pessoa que foram mandadas ANTES deste texto e ainda
 * estão a caminho. Devolve na hora quando não há nenhuma.
 */
export async function esperarFotosAnteriores(chave, enviadoEm) {
  const doRemetente = aCaminho.get(chave)
  if (!doRemetente?.size) return false
  const agora = Date.now()
  const quando = enviadoEm ?? agora
  const antes = [...doRemetente.values()].filter(a => a.ate > agora && a.enviadoEm <= quando + 2000)
  if (!antes.length) return false
  let relogio
  await Promise.race([
    Promise.all(antes.map(a => a.pronto)),
    new Promise((ok) => { relogio = setTimeout(ok, ESPERA_MAXIMA_MS); relogio.unref?.() }),
  ])
  clearTimeout(relogio)
  return true
}

/** Só para teste. */
export function _esquecerACaminho() {
  aCaminho.clear()
}
