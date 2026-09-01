/**
 * A linha que você escreve junto do comprovante.
 *
 *   bastos tsuya, tijolos e areia, material, 2500,00
 *   └─ obra ──┘  └─ descrição ─┘  └tipo┘   └valor┘
 *
 * Por que ler ISTO em vez de confiar na foto: quem digitou sabe. O modelo de
 * visão lê 1.500 onde era 1.800, e a obra e o tipo do gasto nem aparecem no
 * cupom — não tem como o Posto Ipiranga saber que aquele diesel foi para
 * Bastos. A leitura da imagem continua acontecendo, mas como conferência e
 * como reserva: onde você escreveu, o que você escreveu vale.
 *
 * É a mesma regra do resto do robô. O CÓDIGO é dono dos fatos que viram
 * registro; o modelo entra onde falta informação, não onde ela já existe.
 *
 * A ordem dos campos é livre e tudo é opcional. O que der para identificar
 * com certeza é identificado; o resto vira descrição, e a pessoa completa na
 * hora de aprovar — que é onde ela já está de qualquer jeito.
 */
import { norm, melhorMatch } from './texto.js'
import { CATEGORIAS } from './ia-visao.js'

/**
 * Como cada tipo é chamado na obra.
 *
 * O primeiro termo é o nome da categoria; os outros são o que as pessoas
 * realmente escrevem. Ninguém digita "MAO_DE_OBRA" — digita "diária",
 * "empreita", "pagamento".
 */
const TERMOS = {
  COMBUSTIVEL: ['combustivel', 'gasolina', 'diesel', 'etanol', 'alcool', 'posto', 'arla', 'abastecimento'],
  MATERIAL: ['material', 'materiais', 'cimento', 'areia', 'tijolo', 'tijolos', 'brita', 'tinta', 'madeira', 'ferro', 'eletrico', 'hidraulico'],
  ALIMENTACAO: ['alimentacao', 'comida', 'almoco', 'marmita', 'refeicao', 'lanche', 'mercado', 'padaria', 'agua', 'cafe'],
  FERRAMENTA: ['ferramenta', 'ferramentas', 'equipamento', 'aluguel de ferramenta', 'epi'],
  TRANSPORTE: ['transporte', 'frete', 'pedagio', 'estacionamento', 'passagem', 'uber', 'onibus'],
  MAO_DE_OBRA: ['mao de obra', 'maodeobra', 'diaria', 'diarias', 'empreita', 'empreiteiro', 'pagamento', 'servico', 'prestador'],
  HOSPEDAGEM: ['hospedagem', 'hotel', 'pousada', 'alojamento', 'estadia'],
  MANUTENCAO: ['manutencao', 'oficina', 'peca', 'pneu', 'revisao', 'conserto', 'mecanico'],
  TAXA: ['taxa', 'cartorio', 'prefeitura', 'art', 'licenca', 'multa', 'imposto', 'guia'],
  OUTROS: ['outros', 'outro', 'diverso', 'diversos'],
}

const OPCOES_TIPO = Object.entries(TERMOS).map(([valor, termos]) => ({ valor, termos }))

/** Todo termo conhecido, normalizado, apontando para a categoria dele. */
const TERMO_EXATO = new Map(
  Object.entries(TERMOS).flatMap(([cat, termos]) => termos.map(t => [norm(t), cat])),
)

/**
 * Acha o valor em dinheiro no texto.
 *
 * O formato brasileiro usa vírgula decimal, e a linha é separada por
 * vírgulas — "2500,00" seria partido no meio por uma divisão ingênua. Por
 * isso o valor é extraído ANTES de qualquer separação.
 *
 * Pega o ÚLTIMO número da linha: no jeito que as pessoas escrevem, o valor
 * vem no fim, e no meio pode haver quantidade ("20 sacos de cimento").
 */
export function acharValor(texto) {
  if (!texto) return { valor: null, resto: texto ?? '' }

  // R$ 2.500,00 · 2500,00 · 2.500 · 2500.00 · 2500
  const padrao = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+,\d{1,2}|\d+(?:\.\d{2})?)\b/gi
  const achados = [...texto.matchAll(padrao)]
  if (!achados.length) return { valor: null, resto: texto }

  const ultimo = achados[achados.length - 1]
  const bruto = ultimo[1]

  // "2.500,00" → 2500.00   |   "2500,00" → 2500.00   |   "2500.00" → 2500.00
  let normalizado = bruto
  if (bruto.includes(',')) {
    normalizado = bruto.replace(/\./g, '').replace(',', '.')
  }

  const valor = Number(normalizado)
  if (!Number.isFinite(valor) || valor <= 0 || valor >= 1000000) {
    return { valor: null, resto: texto }
  }

  const resto = (texto.slice(0, ultimo.index) + texto.slice(ultimo.index + ultimo[0].length))
    .replace(/\s*,\s*,\s*/g, ', ')
    .replace(/[,\s]+$/, '')
    .trim()

  return { valor: Math.round(valor * 100) / 100, resto }
}

/**
 * Qual tipo de gasto este pedaço descreve.
 *
 * Usa a mesma comparação tolerante a erro de escrita que reconhece "pedrero"
 * como Pedreiro — quem digita na obra escreve "materal", "combustivl".
 * Vocabulário fechado de dez categorias, então distância de edição acerta
 * mais que um modelo e responde na hora.
 */
export function acharTipo(pedaco) {
  if (!pedaco?.trim()) return null
  const achado = melhorMatch(pedaco, OPCOES_TIPO)
  return achado && CATEGORIAS.includes(achado) ? achado : null
}

/**
 * Interpreta a linha inteira.
 *
 * Devolve sempre um objeto — linha vazia ou incompreensível dá todos os
 * campos nulos, e o comprovante segue assim mesmo para a caixa de aprovação.
 * Nunca recusa um comprovante por não entender o texto: a foto no lugar
 * certo já vale, e quem aprova completa o que faltar.
 */
export function interpretar(texto) {
  const vazio = { obra: null, descricao: null, tipo: null, valor: null, textoOriginal: texto ?? null }
  if (!texto?.trim()) return vazio

  const { valor, resto } = acharValor(texto)

  const pedacos = resto.split(/[,;\n]|\s+[-–—]\s+/).map(p => p.trim()).filter(Boolean)
  if (!pedacos.length) return { ...vazio, valor }

  // O tipo pode estar em qualquer posição, e é o único campo com vocabulário
  // conhecido — então acha-se ele primeiro e o que sobra se acomoda em volta.
  let tipo = null
  let ondeTipo = -1
  for (let i = 0; i < pedacos.length; i++) {
    const limpo = norm(pedacos[i])

    // O pedaço é EXATAMENTE o nome de um tipo ("material", "mao de obra")?
    // Então é o campo do tipo, não importa quantas palavras tenha.
    if (TERMO_EXATO.has(limpo)) {
      tipo = TERMO_EXATO.get(limpo)
      ondeTipo = i
      break
    }

    // Senão, aceita parecido — mas só em pedaço CURTO. "tijolos e areia"
    // casaria com MATERIAL, e ali é a descrição do que foi comprado, não a
    // classificação: consumir esse pedaço apagaria o que a pessoa escreveu.
    const achado = acharTipo(pedacos[i])
    if (achado && limpo.split(' ').length <= 2) {
      tipo = achado
      ondeTipo = i
      break
    }
  }

  const sobrou = pedacos.filter((_, i) => i !== ondeTipo)

  // Primeiro pedaço é a obra: é assim que a linha é escrita, e a obra é o
  // campo que o sistema de obras precisa para saber onde lançar.
  const obra = sobrou[0] ?? null
  const descricao = sobrou.slice(1).join(', ') || null

  // Nenhuma categoria reconhecida, mas há descrição: tenta achar o tipo
  // dentro dela ("tijolos e areia" → MATERIAL). É palpite, e por isso só
  // acontece depois de o campo próprio ter falhado.
  const tipoFinal = tipo ?? acharTipo(descricao ?? '')

  return { obra, descricao, tipo: tipoFinal, valor, textoOriginal: texto }
}

/**
 * Junta o que a pessoa escreveu com o que a IA leu da imagem.
 *
 * A regra é uma só, e é a que evita o pior erro possível: **o que a pessoa
 * escreveu ganha, sempre**. A IA preenche buraco, nunca corrige quem digitou.
 *
 * Lançar 1.500 porque o modelo leu errado, num campo que a pessoa tinha
 * escrito 1.800, é o tipo de erro que ninguém percebe até fechar o mês.
 */
export function combinar(escrito, lido) {
  return {
    obra: escrito?.obra ?? null,
    descricao: escrito?.descricao ?? lido?.estabelecimento ?? null,
    tipo: escrito?.tipo ?? lido?.categoria ?? null,
    valor: escrito?.valor ?? lido?.valor ?? null,
    // De onde veio cada coisa, para a caixa de aprovação poder mostrar o que
    // foi digitado e o que foi chutado por máquina.
    valorDigitado: escrito?.valor != null,
    // A data do comprovante, quando a IA conseguiu ler, vai junto — mas quem
    // manda no lançamento é a data do envio, que é o que foi combinado.
    dataComprovante: lido?.data ?? null,
    estabelecimento: lido?.estabelecimento ?? null,
    documento: lido?.documento ?? null,
    formaPagamento: lido?.formaPagamento ?? null,
    confianca: escrito?.valor != null ? 'digitado' : (lido?.confianca ?? 'baixa'),
  }
}
