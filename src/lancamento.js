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
 *
 * E a vírgula também é opcional. Na prática ninguém escreve tão arrumado:
 *
 *   Bastos Tsuya bomba para concreto locação 1.400,00
 *   bombeamento de concreto bastos tsuya
 *
 * Nos dois a obra é "Bastos Tsuya" — no começo de um, no fim do outro. Não
 * há como separar isso de um texto corrido sem SABER quais obras existem,
 * e é por isso que a lista de obras entra aqui. Com ela, procura-se cada
 * nome conhecido em qualquer posição da frase; o que sobra é a descrição.
 */
import { norm, melhorMatch, distancia } from './texto.js'
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
  FERRAMENTA: ['ferramenta', 'ferramentas', 'equipamento', 'epi', 'furadeira', 'serra'],
  LOCACAO: ['locacao', 'locacoes', 'aluguel', 'alugado', 'alugada', 'bomba', 'bombeamento',
    'betoneira', 'andaime', 'andaimes', 'escoramento', 'cacamba', 'guincho', 'gerador',
    'container', 'compactador', 'placa vibratoria', 'bomba para concreto'],
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
 * Procura um dos nomes conhecidos dentro de um texto corrido.
 *
 * Compara JANELAS DE PALAVRAS, e não o texto todo: "bomba para concreto
 * bastos tsuya" precisa casar "bastos tsuya" mesmo cercado de outras
 * palavras. A janela mais longa ganha, para "Bastos Tsuya" vencer "Bastos"
 * quando as duas obras existem.
 *
 * Devolve o que achou e as palavras que sobraram — quem chama precisa das
 * duas coisas, senão o nome da obra apareceria de novo na descrição.
 *
 * Tolera erro de escrita no nome INTEIRO, e não só em palavra solta:
 * "bastos haya", "bastos aia" e "Bastos Haia" caem todos na mesma obra.
 * Quem digita está na obra, no celular, com pressa.
 */
export function acharNaFrase(texto, conhecidos, { tolerante = true } = {}) {
  const palavras = (texto || '').split(/\s+/).filter(Boolean)
  if (!palavras.length || !conhecidos?.length) return { achado: null, resto: texto ?? '' }

  const alvos = conhecidos.map(c => ({ original: c, limpo: norm(c) })).filter(a => a.limpo)
  const maxJanela = Math.min(5, palavras.length)

  // Guarda o MELHOR casamento, em vez de aceitar o primeiro.
  //
  // Aceitando o primeiro, "Bastos" ganharia de "Bastos Haia" só por ser
  // testado antes — e o custo iria para a obra errada, que é o pior erro
  // que este arquivo pode cometer. Ordena-se por: erro menor primeiro, e
  // empatado, janela mais longa.
  let melhor = null

  for (let tamanho = maxJanela; tamanho >= 1; tamanho--) {
    for (let i = 0; i + tamanho <= palavras.length; i++) {
      const janela = norm(palavras.slice(i, i + tamanho).join(' '))
      if (!janela) continue

      for (const alvo of alvos) {
        let erro = null

        if (alvo.limpo === janela) {
          erro = 0
        } else if (tolerante) {
          const d = distancia(janela, alvo.limpo)
          if (d <= toleranciaDe(alvo.limpo)) erro = d
        }

        if (erro === null) continue
        if (!melhor || erro < melhor.erro || (erro === melhor.erro && tamanho > melhor.tamanho)) {
          melhor = { alvo: alvo.original, erro, tamanho, i }
        }
      }
    }
  }

  if (!melhor) return { achado: null, resto: texto ?? '' }

  const resto = [...palavras.slice(0, melhor.i), ...palavras.slice(melhor.i + melhor.tamanho)].join(' ').trim()
  return { achado: melhor.alvo, resto }
}

/**
 * Quantas letras podem estar erradas, pelo tamanho do nome.
 *
 * Proporcional de propósito: uma letra trocada em "Bastos Haia" (11 letras)
 * é erro de digitação; a mesma letra em "SP" seria outra coisa. Nome curto
 * exige acerto, nome longo perdoa.
 *
 * O teto é baixo por escolha. Errar para menos faz a pessoa completar a obra
 * na hora de aprovar — chato. Errar para mais manda o custo para a obra
 * errada, e ninguém percebe.
 */
function toleranciaDe(nome) {
  const n = nome.length
  if (n <= 4) return 0
  if (n <= 8) return 1
  if (n <= 14) return 2
  return 3
}

/**
 * Dois vocabulários, e confundi-los estraga a descrição.
 *
 * CLASSIFICADORES são as palavras que a pessoa escreve para DIZER o tipo:
 * "material", "locação", "mão de obra". Elas são o campo, então saem da
 * frase depois de reconhecidas — repetir "material" na descrição não
 * acrescenta nada.
 *
 * TERMOS (acima) são PISTAS: "cimento", "tijolos", "bomba", "gasolina".
 * Elas dizem qual é o tipo, mas são a descrição do gasto e ficam onde estão.
 *
 * Tratar as duas iguais foi um erro real: "bastos tsuya, tijolos e areia,
 * material" virava descrição "e areia", porque "tijolos" tinha sido
 * arrancado como se fosse a classificação.
 */
const CLASSIFICADORES = {
  COMBUSTIVEL: ['combustivel', 'combustiveis'],
  MATERIAL: ['material', 'materiais'],
  ALIMENTACAO: ['alimentacao', 'refeicao', 'alimentacoes'],
  FERRAMENTA: ['ferramenta', 'ferramentas'],
  LOCACAO: ['locacao', 'locacoes', 'aluguel', 'alugado', 'alugada'],
  TRANSPORTE: ['transporte', 'frete'],
  MAO_DE_OBRA: ['mao de obra', 'maodeobra', 'mao-de-obra', 'servico', 'servicos'],
  HOSPEDAGEM: ['hospedagem'],
  MANUTENCAO: ['manutencao'],
  TAXA: ['taxa', 'taxas', 'imposto', 'impostos'],
  OUTROS: ['outros'],
}

const TODOS_OS_CLASSIFICADORES = Object.entries(CLASSIFICADORES)
  .flatMap(([cat, ts]) => ts.map(t => ({ termo: t, cat })))

/** Sobras de preposição no começo da descrição, depois de tirar uma palavra. */
function limparBordas(t) {
  return (t || '')
    .replace(/^\s*(de|da|do|para|pra|por|com|em|e)\s+/i, '')
    .replace(/\s*,\s*$/, '')
    .replace(/^\s*,\s*/, '')
    .trim()
}

/**
 * Interpreta a linha inteira.
 *
 * Devolve sempre um objeto — linha vazia ou incompreensível dá todos os
 * campos nulos, e o comprovante segue assim mesmo para a caixa de aprovação.
 * Nunca recusa um comprovante por não entender o texto: a foto no lugar
 * certo já vale, e quem aprova completa o que faltar.
 */
export function interpretar(texto, obras = []) {
  const vazio = { obra: null, descricao: null, tipo: null, valor: null, textoOriginal: texto ?? null }
  if (!texto?.trim()) return vazio

  const { valor, resto } = acharValor(texto)

  // A linha foi escrita no formato com separador, ou é texto corrido?
  //
  // Isto muda o que se pode supor. Com separador vale a convenção
  // documentada — o primeiro campo é a obra —, mesmo que só sobre um campo
  // depois de tirar o valor e o tipo ("bastos tsuya, combustivel, 300").
  // Em texto corrido, supor posição produziria "Bomba Para" como obra.
  const temSeparador = /[,;\n]|\s+[-–—]\s+/.test(resto)

  // 1) A OBRA, por nome conhecido, em qualquer posição da frase.
  //
  // Vem primeiro porque é o campo mais específico: nome de obra é próprio, e
  // deixar para depois faria "Bastos" ser consumido como outra coisa.
  const porNome = acharNaFrase(resto, obras)
  let obra = porNome.achado
  let sobra = porNome.resto

  // 2) O TIPO, quando a pessoa o ESCREVEU ("material", "locação").
  //
  //    Só o classificador sai da frase. As pistas ("cimento", "bomba") ficam,
  //    porque elas são a descrição do gasto.
  const porTipo = acharNaFrase(sobra, TODOS_OS_CLASSIFICADORES.map(t => t.termo), { tolerante: false })
  let tipo = porTipo.achado
    ? TODOS_OS_CLASSIFICADORES.find(t => t.termo === porTipo.achado)?.cat ?? null
    : null
  if (tipo) sobra = porTipo.resto

  // 3) O que sobrou vira descrição — separadores viram espaço, porque a
  //    vírgula já cumpriu o papel dela ou nunca existiu.
  let descricao = limparBordas(
    sobra.split(/[,;\n]|\s+[-–—]\s+/).map(p => limparBordas(p)).filter(Boolean).join(', '),
  ) || null

  // 4) Obra não reconhecida, mas a linha veio separada por vírgula: então
  //    vale a convenção documentada, e o primeiro pedaço é a obra.
  //
  //    Só nesse caso. Em texto corrido, chutar que as primeiras palavras são
  //    o nome da obra produziria "Bomba Para" como obra — pior que admitir
  //    que não sabe e deixar a pessoa escolher.
  if (!obra && temSeparador) {
    const pedacos = sobra.split(/[,;\n]|\s+[-–—]\s+/).map(p => p.trim()).filter(Boolean)
    if (pedacos.length) {
      obra = pedacos[0]
      descricao = pedacos.slice(1).map(limparBordas).filter(Boolean).join(', ') || null
    }
  }

  // 5) Última tentativa para o tipo: pelo que a descrição diz ("tijolos e
  //    areia" → MATERIAL). É palpite, e por isso só depois de tudo falhar.
  if (!tipo) tipo = acharTipo(descricao ?? '')

  return { obra, descricao, tipo, valor, textoOriginal: texto }
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
