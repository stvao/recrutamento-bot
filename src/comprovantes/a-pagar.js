/**
 * Comprovantes — pago ou A PAGAR?
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 *
 * No grupo dos comprovantes não chega só comprovante. Chega o boleto que
 * vence semana que vem, o orçamento do fornecedor, a nota fiscal a prazo. O
 * robô lançava tudo como gasto — e gasto é dinheiro que SAIU. Um boleto de
 * R$ 4.000 lançado no dia em que chegou é um custo que ainda não existe, e
 * que entra de novo no dia em que alguém mandar o comprovante do pagamento.
 *
 * A regra:
 *
 *  - BOLETO ou ORÇAMENTO/PEDIDO, sem prova de pagamento na imagem → não é
 *    gasto. Vai para a caixa, marcado, e o robô avisa. Se já foi pago, a
 *    pessoa responde *pago* e ele lança.
 *  - NOTA FISCAL com vencimento no futuro e sem prova de pagamento → pode
 *    ser à vista ou a prazo, e só quem pagou sabe. Pergunta.
 *  - Todo o resto → como sempre foi.
 *
 * O que a pessoa ESCREVEU ganha da imagem, como em todo o módulo: "pago",
 * "pix feito", "paguei" na legenda e não há pergunta nenhuma.
 *
 * NA DÚVIDA, O COMPORTAMENTO DE ANTES. Leitura que falhou, tipo que a IA não
 * soube dizer, prova de pagamento que ela não afirmou nem negou: nada disso
 * segura um comprovante. Deixar de lançar o que foi pago é pior do que
 * perguntar a mais.
 *
 * A decisão é função pura. Para onde vai o que é "a pagar" está isolado em
 * `saida.js` (`mandarParaContasAPagar`): hoje é a caixa de comprovantes; no
 * dia em que existir o agente de contas a pagar, troca-se lá, e só lá.
 */

/** Os tipos de documento que a leitura da imagem sabe dizer. */
export const TIPOS_DE_DOCUMENTO = ['comprovante_pagamento', 'cupom_fiscal', 'nota_fiscal', 'boleto', 'orcamento_pedido', 'outro']

/**
 * A pessoa DISSE que pagou.
 *
 * "pago", "paga", "paguei", "pagamos", "pix feito", "já paguei", "foi pago",
 * "quitado", "transferido". "pago por Ana" também: quem diz quem pagou está
 * dizendo que foi pago.
 */
const DISSE_QUE_PAGOU = /(^|[^a-zà-ú])(pag[oa]s?|paguei|pagamos|pagou|quitad[oa]s?|quitei|transferid[oa]|transferi|pix (feito|enviado|realizado|pago))([^a-zà-ú]|$)/i

/** A pessoa disse que NÃO pagou ainda. Olhado ANTES do de cima: "não foi pago" tem "pago" dentro. */
const DISSE_QUE_NAO_PAGOU = /(^|[^a-zà-ú])(a pagar|para pagar|pra pagar|n[aã]o (foi |est[aá] |t[aá] )?pag[oa]|ainda n[aã]o (foi )?pag[oa]|n[aã]o paguei|n[aã]o pagamos|vai (ser )?pag[oa]r?|falta pagar|em aberto)([^a-zà-ú]|$)/i

/** Resposta "pago" — sozinha, do jeito que se responde a uma pergunta. */
export const RESPOSTA_PAGO = /^\s*(sim,?\s+)?(j[aá]\s+)?(foi\s+|est[aá]\s+|t[aá]\s+)?(pag[oa]|paguei|pagamos|quitad[oa]|foi|sim)(\s+sim)?\s*[!.]*\s*$/i

/** Resposta "a pagar" / "ainda não". */
export const RESPOSTA_A_PAGAR = /^\s*(a pagar|para pagar|pra pagar|ainda n[aã]o|n[aã]o|n[aã]o (foi )?pag[oa]|n[aã]o paguei|em aberto|vai (ser )?pag[oa]r?)\s*[!.]*\s*$/i

const diaCurto = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : null)

/** "A PAGAR — boleto, vence 05/12" — a marca que abre o texto na caixa. */
function marca(tipo, vencimento) {
  if (tipo === 'orcamento_pedido') return 'ORÇAMENTO/PEDIDO — não é pagamento'
  const nome = tipo === 'boleto' ? 'boleto' : tipo === 'nota_fiscal' ? 'nota fiscal' : null
  return ['A PAGAR', [nome, vencimento && `vence ${diaCurto(vencimento)}`].filter(Boolean).join(', ')].filter(Boolean).join(' — ')
}

/**
 * Isto é pagamento feito, ou conta a pagar?
 *
 * Recebe o que se sabe do comprovante e devolve:
 *
 *  - null → é gasto (ou não dá para dizer que não é): segue como sempre;
 *  - `{ decisao: 'a-pagar', tipo, vencimento, marca, motivo }` → não lança;
 *  - `{ decisao: 'perguntar', vencimento }` → pergunta "já foi pago?".
 *
 * `escrito` é tudo que a pessoa escreveu (legenda e respostas). `respondeu`
 * é o que ela já respondeu a ESTA pergunta: 'pago', 'a-pagar' ou nada.
 * `hoje` é o dia em que o comprovante foi mandado (AAAA-MM-DD).
 */
export function pagoOuAPagar({ tipoDocumento, pagamentoComprovado, vencimento, escrito, respondeu, hoje }) {
  if (respondeu === 'pago') return null
  if (respondeu === 'a-pagar') {
    return { decisao: 'a-pagar', tipo: tipoDocumento ?? null, vencimento: vencimento ?? null, marca: marca(tipoDocumento, vencimento), motivo: 'resposta' }
  }

  // O que a pessoa escreveu ganha da imagem.
  const texto = String(escrito ?? '')
  if (DISSE_QUE_NAO_PAGOU.test(texto)) {
    return { decisao: 'a-pagar', tipo: tipoDocumento ?? null, vencimento: vencimento ?? null, marca: marca(tipoDocumento, vencimento), motivo: 'legenda' }
  }
  if (DISSE_QUE_PAGOU.test(texto)) return null

  // A imagem. Só quando a IA AFIRMOU que não há prova de pagamento: sem a
  // afirmação (leitura que falhou, campo que não veio), vale o de antes.
  if (pagamentoComprovado !== false) return null

  if (tipoDocumento === 'boleto' || tipoDocumento === 'orcamento_pedido') {
    return { decisao: 'a-pagar', tipo: tipoDocumento, vencimento: vencimento ?? null, marca: marca(tipoDocumento, vencimento), motivo: 'imagem' }
  }
  if (tipoDocumento === 'nota_fiscal' && vencimento && hoje && vencimento > hoje) {
    return { decisao: 'perguntar', tipo: tipoDocumento, vencimento }
  }
  return null
}

/** O que dizer no grupo quando o documento foi para a caixa como "a pagar". Texto fixo. */
export function avisoDeAPagar(situacao) {
  const vence = situacao.vencimento ? ` (vence ${diaCurto(situacao.vencimento)})` : ''
  if (situacao.motivo === 'resposta' || situacao.motivo === 'legenda') {
    return `Certo — a pagar${vence}. Não lancei como gasto; deixei na caixa. Quando for pago, responde *pago*.`
  }
  if (situacao.tipo === 'orcamento_pedido') {
    return 'Isso parece orçamento ou pedido, não pagamento. Não lancei como gasto; deixei na caixa. Se já foi pago, responde *pago*.'
  }
  return `Isso parece boleto ainda não pago${vence}. Não lancei como gasto; deixei na caixa. Se já foi pago, responde *pago*.`
}

/** A pergunta da nota fiscal a prazo. Texto fixo. */
export function perguntaDePago(situacao) {
  return `Essa nota vence ${diaCurto(situacao.vencimento)}. Já foi pago? Responde *pago* ou *a pagar*.`
}
