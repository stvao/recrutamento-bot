/**
 * Comprovantes — este já foi lançado?
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 *
 * A regra antiga era uma só: MESMA OBRA e MESMO VALOR nos últimos 30 dias →
 * pergunta. Ela errava para os dois lados. Perguntava à toa (dois cupons de
 * R$ 50 de almoço na mesma obra, com números diferentes impressos neles) e
 * deixava passar o que importava (a mesma foto lançada em outra obra, ou o
 * gasto que o dono já tinha digitado à mão no sistema).
 *
 * Agora são três sinais, do mais forte para o mais fraco:
 *
 *  1. MESMO ARQUIVO (impressão digital igual). Não é palpite: são os mesmos
 *     bytes. O robô responde que já foi lançado e NÃO lança — é a única
 *     coisa que ele decide sem ninguém dizer "é o mesmo".
 *
 *  2. MESMO Nº DE DOCUMENTO e MESMO VALOR. Quase certo, mas o número foi lido
 *     por IA de uma foto — então PERGUNTA.
 *
 *  3. MESMA OBRA e MESMO VALOR. Só pergunta quando não dá para desempatar
 *     pelo documento: se os dois lados têm número e os números são
 *     diferentes, são dois pagamentos, e perguntar seria o ruído de antes.
 *
 * Compara com duas fontes: o que o robô lembra de ter lançado (`memoria.js`)
 * e o que o sistema de obras diz que está lançado (`lancadosDoSistema`),
 * que inclui o que foi digitado à mão. A segunda pode faltar — servidor de
 * versão anterior, rede fora — e aí vale só a primeira, como sempre foi.
 *
 * Tudo aqui é função pura: recebe o comprovante e as duas listas, devolve o
 * que achou. Quem fala com a pessoa e com o disco é `processar.js`.
 */
import { norm } from '../texto.js'
import { moeda } from './formato.js'

/**
 * Lançamento do sistema que foi digitado à mão — sem documento e sem
 * arquivo — só é suspeito se a data estiver perto.
 *
 * Sem nenhum dos dois sinais fortes, sobra obra + valor, e isso num mês
 * inteiro pega a diária do mesmo pedreiro toda semana. Três dias cobre o
 * atraso normal entre pagar, mandar a foto e alguém digitar.
 */
const DIAS_PERTO = 3

/**
 * O número do documento, do jeito que dá para comparar — e é NESTA forma que
 * ele é mandado ao sistema de obras e guardado na memória. O sistema não
 * normaliza nada: compara exatamente o que recebeu. Então a forma tem de ser
 * decidida num lugar só, e é aqui.
 *
 * A IA lê o mesmo cupom como "000.123-4" numa foto e "1234" na outra. Fica
 * só letra e número, sem zero à esquerda.
 *
 * Curto demais não vale como documento: "1" ou "02" aparecem em qualquer
 * cupom (nº do caixa, da via), e tratá-los como identificação faria dois
 * comprovantes diferentes parecerem o mesmo — ou, pior, faria o robô
 * concluir que são diferentes e deixar de perguntar.
 */
export function documentoComparavel(documento) {
  const limpo = String(documento ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '')
  return limpo.length >= 4 ? limpo : null
}

const mesmoValor = (a, b) => a != null && b != null
  && Number.isFinite(Number(a)) && Number.isFinite(Number(b))
  && Math.abs(Number(a) - Number(b)) < 0.005

/** Rejeitado no sistema não conta: o gasto não existe mais como despesa. */
const rejeitado = (item) => /rejeit|recus|cancel/i.test(String(item?.status ?? ''))

/** Diferença em dias entre duas datas AAAA-MM-DD (ou ISO). Infinito se alguma não serve. */
function diasEntre(a, b) {
  const ta = Date.parse(String(a ?? '').slice(0, 10))
  const tb = Date.parse(String(b ?? '').slice(0, 10))
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Infinity
  return Math.abs(ta - tb) / (24 * 60 * 60 * 1000)
}

/** As duas fontes numa lista só, cada item dizendo de onde veio. */
function candidatos({ locais, doSistema }, idMensagem) {
  const daMemoria = (locais ?? [])
    .filter(l => l && l.idMensagem !== idMensagem)
    .map(l => ({ ...l, fonte: 'robo' }))
  const doObras = (doSistema ?? [])
    .filter(l => l && !rejeitado(l))
    .map(l => ({ ...l, fonte: 'sistema' }))
  return [...daMemoria, ...doObras]
}

/**
 * É o mesmo ARQUIVO de um gasto já lançado? Devolve o lançamento, ou null.
 *
 * A memória do robô não sabe o que foi rejeitado depois — só o sistema sabe.
 * Então, quando o sistema mostra aquele arquivo e TODOS os registros dele
 * estão rejeitados, a memória não segura: a pessoa está mandando de novo
 * justamente porque foi recusado, e barrar seria impedir o conserto.
 */
export function mesmoArquivo({ arquivoHash, idMensagem }, { locais, doSistema } = {}) {
  if (!arquivoHash) return null

  const noSistema = (doSistema ?? []).filter(l => l?.arquivoHash === arquivoHash)
  const vivo = noSistema.find(l => !rejeitado(l))
  if (vivo) return { ...vivo, fonte: 'sistema' }

  const soRejeitados = noSistema.length > 0
  if (soRejeitados) return null

  const local = (locais ?? []).find(l => l?.arquivoHash === arquivoHash && l.idMensagem !== idMensagem)
  return local ? { ...local, fonte: 'robo' } : null
}

/**
 * Parece com algum já lançado, a ponto de valer PERGUNTAR?
 *
 * Devolve o lançamento parecido com `motivo` ('documento' ou 'obra-valor'),
 * ou null. Nunca decide nada sozinho — quem sabe se é o mesmo pagamento é
 * quem pagou.
 */
export function parecido({ obra, valor, documento, datas, idMensagem }, fontes = {}) {
  if (valor == null) return null

  const todos = candidatos(fontes, idMensagem)
  const meuDoc = documentoComparavel(documento)

  // 2. Mesmo documento e mesmo valor — vale em QUALQUER obra: é assim que se
  //    pega o comprovante lançado na obra errada e mandado de novo na certa.
  if (meuDoc) {
    const porDocumento = todos.find(l => documentoComparavel(l.documento) === meuDoc && mesmoValor(l.valor, valor))
    if (porDocumento) return { ...porDocumento, motivo: 'documento' }
  }

  // 3. Mesma obra e mesmo valor.
  if (!obra) return null
  const alvo = norm(obra)

  const porObra = todos.find((l) => {
    if (!mesmoValor(l.valor, valor) || norm(l.obra ?? '') !== alvo) return false

    // Os dois têm número, e os números são diferentes: dois pagamentos.
    // (Iguais teriam saído no passo de cima.)
    const docDele = documentoComparavel(l.documento)
    if (meuDoc && docDele) return false

    // Digitado à mão no sistema, sem documento nem arquivo: só se a data
    // estiver perto de quando este foi mandado, ou da data lida no papel.
    if (l.fonte === 'sistema' && !docDele && !l.arquivoHash) {
      return (datas ?? []).some(d => d && diasEntre(d, l.data) <= DIAS_PERTO)
    }

    // Falta o documento em um dos lados: não dá para desempatar. Pergunta,
    // como sempre se fez.
    return true
  })

  return porObra ? { ...porObra, motivo: 'obra-valor' } : null
}

/** "hoje às 14h05" / "em 3/11" — quando o lançamento parecido entrou. */
function quandoFoi(item) {
  // Da memória do robô: o instante em que ele lançou.
  if (item.quando) {
    // Lançado com a data do comprovante, e ela não é o dia em que entrou:
    // diz a data do GASTO, que é a que a pessoa reconhece.
    const lancadoEm = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(item.quando))
    if (item.data && item.data !== lancadoEm) {
      const [, mm, dd] = /^\d{4}-(\d{2})-(\d{2})/.exec(item.data) ?? []
      if (dd) return `com data de ${Number(dd)}/${Number(mm)}`
    }
    const quando = new Date(item.quando)
    return quando.toDateString() === new Date().toDateString()
      ? `hoje às ${quando.getHours()}h${String(quando.getMinutes()).padStart(2, '0')}`
      : `em ${quando.getDate()}/${quando.getMonth() + 1}`
  }
  // Do sistema: a data do gasto, sem hora.
  const [, m, d] = /^\d{4}-(\d{2})-(\d{2})/.exec(String(item.data ?? '')) ?? []
  return d ? `em ${Number(d)}/${Number(m)}` : 'há pouco'
}

/** A linha que mostra o que já estava lançado. */
function linhaDe(item) {
  return [item.obra, item.descricao ?? item.fornecedor ?? 'sem descrição', moeda(Number(item.valor))]
    .filter(Boolean).join(' · ')
}

/** O que dizer quando é o mesmo arquivo — sem pergunta, porque não há dúvida. */
export function avisoDeMesmoArquivo(item) {
  return [
    `ℹ️ Este é o mesmo arquivo de um gasto que já está lançado (${quandoFoi(item)}):`,
    `   ${linhaDe(item)}`,
    'Não lancei de novo.',
  ].join('\n')
}

/** A pergunta "é outro pagamento, ou é o mesmo comprovante?". */
export function perguntaDeRepetido(item) {
  const cabeca = item.motivo === 'documento'
    ? `⚠ Já existe um lançamento com o mesmo nº de documento (${String(item.documento).trim()}) e o mesmo valor, ${quandoFoi(item)}:`
    : item.fonte === 'sistema'
      // Não foi o robô que lançou — alguém digitou no sistema. Dizer "já
      // lancei" faria a pessoa procurar uma foto que ela nunca mandou.
      ? `⚠ Já existe um igual a este no sistema, ${quandoFoi(item)}:`
      : `⚠ Já lancei um igual a este ${quandoFoi(item)}:`

  return [
    cabeca,
    `   ${linhaDe(item)}`,
    '',
    'É outro pagamento, ou é o mesmo comprovante?',
    'Responde *outro* para lançar, ou *mesmo* para descartar.',
  ].join('\n')
}
