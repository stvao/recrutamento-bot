/**
 * Comprovantes — o hábito: este fornecedor é quase sempre da mesma obra.
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 *
 * O robô já aprende o APELIDO que a pessoa dá a uma obra. Faltava aprender o
 * que ela nem escreve: o posto da esquina é sempre da obra de Bastos, a loja
 * de material é sempre da Águia de Haia. Quem manda o comprovante do posto
 * sem dizer a obra recebia a lista inteira para escolher, toda vez.
 *
 * Agora, quando FALTA a obra e o fornecedor tem história, a pergunta vira
 * "É da <obra>, como das outras vezes?" — e um "sim" resolve.
 *
 * ── O que isto NÃO faz ───────────────────────────────────────────────────
 *
 * Lançar sozinho com hábito comum. Obra errada é o pior erro que o módulo
 * pode cometer — o total bate com o comprovante e ninguém percebe até fechar
 * o mês —, e hábito é estatística, não certeza: no dia em que o posto de
 * sempre abastecer o caminhão de outra obra, é a pessoa que sabe. O hábito
 * comum só encurta a pergunta.
 *
 * A exceção, decidida pelo dono em 24/11/2026: hábito MUITO forte (ver
 * `habitoAutomatico`) lança direto — pendente, como todo gasto, e dizendo
 * na confirmação que a obra veio do hábito e como corrigir.
 *
 * Tudo aqui é função pura. Quem guarda os lançamentos é `memoria.js`.
 */
import { norm } from '../texto.js'
import { CATEGORIAS } from './ia-visao.js'

/** Quantos lançamentos do fornecedor, no mínimo, para haver hábito. */
export const HABITO_MINIMO = Number(process.env.GASTOS_HABITO_MINIMO || 3)

/** Por quantos dias um lançamento conta. Fornecedor muda de obra quando a obra acaba. */
export const HABITO_DIAS = Number(process.env.GASTOS_HABITO_DIAS || 90)

/** Que parte dos lançamentos tem de ser da mesma obra (em %, de 0 a 100). */
export const HABITO_PROPORCAO = Number(process.env.GASTOS_HABITO_PROPORCAO || 80) / 100

/**
 * Quem é o fornecedor, do jeito que dá para reconhecer de novo.
 *
 * O CNPJ, quando a IA leu um inteiro: é o único identificador que não muda
 * com a foto. O nome vai junto, normalizado — "Posto Bastos LTDA" e "POSTO
 * BASTOS" são o mesmo —, para as vezes em que o CNPJ não saiu na leitura.
 *
 * Nome curto demais não identifica ninguém ("LJ", "SA"), e é como não ter.
 */
export function fornecedorDe(dados) {
  const cnpj = String(dados?.cnpj ?? '').replace(/\D/g, '')
  const nome = norm(String(dados?.estabelecimento ?? '').replace(/\b(ltda|me|epp|eireli|s\/?a)\b\.?/gi, ' '))
  const f = {
    cnpj: cnpj.length === 14 ? cnpj : null,
    nome: nome.length >= 4 ? nome : null,
  }
  return f.cnpj || f.nome ? f : null
}

/**
 * Este lançamento guardado é do mesmo fornecedor?
 *
 * Com CNPJ dos dois lados, só o CNPJ decide — duas lojas de mesmo nome e
 * CNPJ diferente são duas lojas. O nome só serve quando falta o CNPJ de um
 * dos lados.
 */
export function mesmoFornecedor(a, b) {
  if (!a || !b) return false
  if (a.cnpj && b.cnpj) return a.cnpj === b.cnpj
  return Boolean(a.nome && b.nome && a.nome === b.nome)
}

/** O mais frequente de uma lista, com a contagem. */
function maisFrequente(valores) {
  const conta = new Map()
  for (const v of valores) conta.set(v, (conta.get(v) ?? 0) + 1)
  let melhor = null
  for (const [valor, vezes] of conta) if (!melhor || vezes > melhor.vezes) melhor = { valor, vezes }
  return melhor
}

/**
 * O hábito de um fornecedor, a partir dos lançamentos guardados dele.
 *
 * Devolve `{ obra, categoria, vezes, total }` — `obra` e `categoria` só vêm
 * quando passam na régua (mínimo de lançamentos e proporção), cada um por
 * conta própria. Devolve null quando não há hábito nenhum.
 *
 * `obrasAtuais` são os nomes das obras que existem hoje. Obra encerrada não
 * é sugerida: o fornecedor de uma obra que acabou não diz nada sobre a
 * próxima, e sugerir uma obra que nem aparece mais na lista só confundiria.
 */
export function habitoDe(eventos, { obrasAtuais = [], agora = Date.now(), eventosCategoria = null } = {}) {
  const corte = agora - HABITO_DIAS * 24 * 60 * 60 * 1000
  const recentes = (eventos ?? []).filter(e => e && e.quando >= corte)
  const recentesCategoria = eventosCategoria ? eventosCategoria.filter(e => e && e.quando >= corte) : recentes
  if (recentes.length < HABITO_MINIMO && recentesCategoria.length < HABITO_MINIMO) return null

  const passa = (m, total) => m && total >= HABITO_MINIMO && m.vezes / total >= HABITO_PROPORCAO

  const comObra = recentes.filter(e => e.obra)
  const obra = maisFrequente(comObra.map(e => e.obra))
  const atuais = new Set(obrasAtuais)
  const obraVale = passa(obra, comObra.length) && atuais.has(obra.valor)

  const comCategoria = recentesCategoria.filter(e => e.categoria)
  const categoria = maisFrequente(comCategoria.map(e => e.categoria))
  const categoriaVale = passa(categoria, comCategoria.length)

  if (!obraVale && !categoriaVale) return null
  return {
    obra: obraVale ? obra.valor : null,
    categoria: categoriaVale ? categoria.valor : null,
    vezes: obraVale ? obra.vezes : 0,
    total: comObra.length,
    // FORTE: tantas vezes, quase sempre na mesma obra, que perguntar de novo
    // seria só atrapalhar. Aí o robô lança direto — e diz que foi pelo
    // hábito, para quem leu corrigir citando se não for (ver processar.js).
    forte: Boolean(obraVale && obra.vezes >= HABITO_AUTO_MINIMO && obra.vezes / comObra.length >= HABITO_AUTO_PROPORCAO),
  }
}

/** Lançar sozinho quando o hábito é forte? Ligado por padrão (decisão do dono, 24/11/2026). */
export const habitoAutomatico = () => String(process.env.GASTOS_HABITO_AUTO ?? 'on').toLowerCase() !== 'off'

/** Quantas vezes, no mínimo, para lançar sozinho. */
export const HABITO_AUTO_MINIMO = Number(process.env.GASTOS_HABITO_AUTO_MINIMO || 6)

/** Que parte delas na mesma obra, para lançar sozinho (em %). */
export const HABITO_AUTO_PROPORCAO = Number(process.env.GASTOS_HABITO_AUTO_PROPORCAO || 95) / 100

/**
 * Os lançamentos deste fornecedor, para calcular o hábito.
 *
 * O que vale é o que está NO SISTEMA (`/lancados`): tem o que o robô lançou,
 * o que alguém digitou à mão, e — o mais valioso — a obra como ficou DEPOIS
 * da aprovação, quando quem aprova corrigiu. Com isso o hábito existe desde
 * o primeiro dia, sem esperar o robô lançar três vezes.
 *
 * Sem o sistema (fora do ar, versão antiga), vale a memória do robô, como
 * antes. Com ele, entra também o que o robô acabou de lançar e a lista ainda
 * não mostra (ela é guardada por uns minutos) — reconhecido pela impressão
 * digital do arquivo, para não contar duas vezes. A categoria vem do sistema
 * quando ele manda uma que o lançamento aceita; senão, da memória. (As contas
 * do financeiro usam uma lista maior — EMPREITEIRO, IMPOSTO… — que o /lancar
 * recusaria.)
 *
 * Gasto rateado conta uma vez e não diz de qual obra o fornecedor "é": as
 * partes (mesmo arquivo, obras diferentes) ficam de fora. Rejeitado não conta.
 */
export function eventosDoFornecedor(fornecedor, listaDoSistema, daMemoria = []) {
  if (!fornecedor) return { eventos: [], eventosCategoria: null }
  if (!Array.isArray(listaDoSistema)) return { eventos: daMemoria, eventosCategoria: null }

  const porArquivo = new Map()
  for (const l of listaDoSistema) if (l?.arquivoHash) porArquivo.set(l.arquivoHash, (porArquivo.get(l.arquivoHash) ?? 0) + 1)

  const doSistema = listaDoSistema
    .filter(l => l && l.obra && !/rejeit|recus|cancel/i.test(String(l.status ?? '')))
    .filter(l => !(l.arquivoHash && porArquivo.get(l.arquivoHash) > 1))
    .filter(l => mesmoFornecedor(fornecedor, fornecedorDe({ estabelecimento: l.fornecedor, cnpj: l.fornecedorCnpj })))
    .map(l => ({ obra: l.obra, categoria: CATEGORIAS.includes(l.categoria) ? l.categoria : null, quando: Date.parse(`${String(l.data ?? '').slice(0, 10)}T12:00:00-03:00`) }))
    .filter(e => Number.isFinite(e.quando))

  // Do robô, só o que tem impressão digital e ainda não está na lista: o
  // resto já foi contado pelo sistema (ou é de antes de o robô guardá-la).
  const noSistema = new Set(listaDoSistema.map(l => l?.arquivoHash).filter(Boolean))
  const recentesDoRobo = (daMemoria ?? []).filter(e => e.arquivoHash && !noSistema.has(e.arquivoHash))

  const eventos = [...doSistema, ...recentesDoRobo]
  const sistemaTemCategoria = doSistema.some(e => e.categoria)
  return { eventos, eventosCategoria: sistemaTemCategoria ? null : daMemoria }
}
