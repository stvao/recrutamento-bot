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
 * Nos dois a obra é a mesma — no começo de um, no fim do outro. Não há como
 * separar isso de um texto corrido sem SABER quais obras existem, e é por
 * isso que a lista de obras entra aqui. Com ela, procura-se cada nome
 * conhecido em qualquer posição da frase; o que sobra é a descrição.
 *
 * E ninguém escreve o nome cadastrado. A obra chamada "EE PROFA TSUYA OHNO
 * KIMURA" é "bastos tsuya" no WhatsApp, e "EE/ETEC AGUIA DE HAIA" é "bastos
 * haia". Por isso vale também o APELIDO: uma palavra que só exista naquela
 * obra a identifica sozinha. Ver apelidosDe().
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
  FERRAMENTAS: ['ferramenta', 'ferramentas', 'equipamento', 'furadeira', 'serra', 'marreta'],
  EPI: ['epi', 'capacete', 'bota', 'botina', 'luva', 'luvas', 'oculos', 'cinto', 'uniforme', 'protetor'],
  LOCACAO: ['locacao', 'locacoes', 'aluguel', 'alugado', 'alugada', 'bomba', 'bombeamento',
    'betoneira', 'andaime', 'andaimes', 'escoramento', 'cacamba', 'guincho', 'gerador',
    'container', 'compactador', 'placa vibratoria', 'bomba para concreto'],
  TRANSPORTE: ['transporte', 'frete', 'pedagio', 'estacionamento', 'passagem', 'uber', 'onibus'],
  MAO_DE_OBRA: ['mao de obra', 'maodeobra', 'diaria', 'diarias', 'empreita', 'empreiteiro', 'pagamento', 'servico', 'prestador'],
  HOSPEDAGEM: ['hospedagem', 'hotel', 'pousada', 'alojamento', 'estadia'],
  MANUTENCAO: ['manutencao', 'oficina', 'peca', 'pneu', 'revisao', 'conserto', 'mecanico'],
  OUTRO: ['outro', 'outros', 'diverso', 'diversos', 'taxa', 'cartorio', 'licenca', 'multa'],
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

  // Dois valores com CARA DE DINHEIRO: não se chuta.
  //
  // A regra do "último número" existe para ignorar quantidade ("20 sacos de
  // cimento, 2500,00"), e para isso ela serve. Mas em "material 2500,00 e
  // frete 300,00" ela lançava R$ 300 em silêncio — o número errado, com o
  // certo virando lixo na descrição. É o mesmo erro que o módulo já evita em
  // outro lugar: quando há duas obras possíveis, ele pergunta em vez de
  // escolher. Valor merece o mesmo cuidado, e mais: ninguém percebe um valor
  // errado até fechar o mês.
  //
  // Cara de dinheiro = tem R$, centavos, ou separador de milhar. "20" não
  // tem, "2.500,00" tem — é o que separa quantidade de preço.
  const comCaraDeDinheiro = achados.filter(a =>
    /r\$/i.test(a[0]) || /,\d{1,2}$/.test(a[1]) || /\.\d{3}/.test(a[1]))

  if (comCaraDeDinheiro.length > 1) {
    return {
      valor: null,
      resto: texto,
      ambiguo: comCaraDeDinheiro.map(a => a[1]),
    }
  }

  // UM número com cara de dinheiro: é ele, esteja onde estiver. A regra do
  // último número lançava "diaria pedreiro 150,00, 2 dias" como R$ 2,00 e
  // "cimento 350,00 nota 4521" como R$ 4.521,00. Sem nenhum com cara de
  // dinheiro ("20 sacos de cimento, 2500"), vale o último, como antes.
  const ultimo = comCaraDeDinheiro.length === 1 ? comCaraDeDinheiro[0] : achados[achados.length - 1]
  const bruto = ultimo[1]

  // "2.500,00" → 2500.00 | "2500,00" → 2500.00 | "2500.00" → 2500.00
  // "1.400" → 1400: milhar sem centavos, como se escreve no Brasil. Antes
  // só a vírgula disparava a troca, e "1.400" virava R$ 1,40.
  let normalizado = bruto
  if (bruto.includes(',')) {
    normalizado = bruto.replace(/\./g, '').replace(',', '.')
  } else if (/^\d{1,3}(\.\d{3})+$/.test(bruto)) {
    normalizado = bruto.replace(/\./g, '')
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
/**
 * Teto de palavras examinadas.
 *
 * A busca compara cada janela de palavras com cada nome conhecido, e cada
 * comparação é uma distância de edição: o custo cresce com palavras × obras.
 * Medido com 200 obras: 10 palavras levam 48ms, 100 levam 0,7s, e 2000
 * levam 18 SEGUNDOS — e o robô atende uma mensagem por vez, então nesse
 * tempo ninguém mais é respondido. Bastava alguém colar um texto no grupo.
 *
 * Sessenta palavras é muito mais do que qualquer legenda de comprovante, e
 * o resto do texto continua indo inteiro para a descrição: o corte é só na
 * BUSCA, não no que se guarda.
 */
const MAX_PALAVRAS_BUSCA = 60

export function acharNaFrase(texto, conhecidos, { tolerante = true } = {}) {
  const todas = (texto || '').split(/\s+/).filter(Boolean)
  const palavras = todas.slice(0, MAX_PALAVRAS_BUSCA)
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

  // O que ficou além do teto volta para o resto: cortar a busca não pode
  // apagar o que a pessoa escreveu.
  const resto = [
    ...palavras.slice(0, melhor.i),
    ...palavras.slice(melhor.i + melhor.tamanho),
    ...todas.slice(MAX_PALAVRAS_BUSCA),
  ].join(' ').trim()
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
 * Palavras que aparecem em quase todo nome de obra e não identificam nada.
 *
 * "EE" está em cinco das seis; "escola", "prof", "dr" no mesmo caso. Elas
 * seriam casadas por qualquer coisa e apontariam para a obra errada.
 */
const GENERICAS = new Set([
  // Nome de escola
  'ee', 'etec', 'em', 'emef', 'emei', 'escola', 'colegio', 'obra', 'obras',
  'prof', 'profa', 'professor', 'professora', 'dr', 'dra', 'doutor', 'ver',
  'vereador', 'de', 'da', 'do', 'das', 'dos', 'e', 'reforma', 'ampliacao',
  // Endereço — entra na busca junto do nome, e traz muita palavra que não
  // identifica nada. "Rua" está em todo endereço; "centro", em quase todos.
  'rua', 'av', 'avenida', 'travessa', 'estrada', 'rodovia', 'alameda', 'praca',
  'numero', 'num', 'sn', 'bairro', 'centro', 'jardim', 'jd', 'vila', 'parque',
  'cep', 'sp', 'brasil', 'lote', 'quadra', 'km',
])

/**
 * O apelido de cada obra: a palavra que só existe nela.
 *
 * Nasceu de um caso real. Os nomes cadastrados são "EE PROFA TSUYA OHNO
 * KIMURA" e "EE/ETEC AGUIA DE HAIA", mas ninguém escreve isso no WhatsApp —
 * escreve "bastos tsuya" e "bastos haia". Comparar o nome inteiro por
 * semelhança nunca casaria: a diferença é grande demais.
 *
 * Só que "tsuya" aparece em UMA obra, e "haia" também. Uma palavra que
 * existe em um único nome identifica aquele nome sozinha, e é isso que se
 * usa. Palavra repetida entre obras não vale nada e fica de fora — é o que
 * impede "EE" de casar com cinco obras ao mesmo tempo.
 *
 * A vantagem sobre uma lista de apelidos no .env é não precisar de
 * manutenção: obra nova entra no sistema e o apelido dela sai daí sozinho.
 */
/**
 * Esta palavra ja quer dizer outra coisa?
 *
 * Usado antes de aprender um apelido novo. "areia" e "cimento" descrevem o
 * que foi comprado, nao a obra — guardar um deles como apelido faria TODA
 * compra de areia cair naquela obra, e ninguem entenderia por que.
 */
export function ehVocabularioConhecido(palavra) {
  const p = norm(palavra)
  if (!p) return true
  return p.split(' ').some(x =>
    TERMO_EXATO.has(x) || TODOS_OS_CLASSIFICADORES.some(c => c.termo === x))
}

export function apelidosDe(obras) {
  const donasDe = new Map()   // palavra -> [obras que a contêm]

  for (const o of obras) {
    // Aceita tanto "Nome da obra" quanto { nome, endereco } — o endereço
    // entra na busca porque ninguém chama a obra pelo nome cadastrado: para
    // quem trabalha nela, ela é "a de Bastos", e a cidade não aparece em
    // nome nenhum.
    const nome = typeof o === 'string' ? o : o.nome
    const texto = typeof o === 'string' ? o : `${o.nome} ${o.endereco ?? ''}`

    const palavras = new Set(norm(texto).split(' ').filter(p => p.length >= 3 && !GENERICAS.has(p)))
    for (const p of palavras) {
      const donas = donasDe.get(p) ?? []
      if (!donas.includes(nome)) donas.push(nome)
      donasDe.set(p, donas)
    }
  }

  const apelidos = new Map()    // palavra -> a obra, quando só há uma
  const ambiguos = new Map()    // palavra -> as obras, quando há várias
  for (const [palavra, donas] of donasDe) {
    if (donas.length === 1) apelidos.set(palavra, donas[0])
    else ambiguos.set(palavra, donas)
  }

  // Devolve um Map, como antes, com os ambíguos pendurados. Quem só quer os
  // apelidos continua usando igual; quem precisa perguntar tem a lista de
  // candidatos sem uma segunda chamada.
  apelidos.ambiguos = ambiguos
  return apelidos
}

/** Só os nomes, venha a lista como texto ou como { nome, endereco }. */
export function nomesDe(obras) {
  return (obras ?? []).map(o => (typeof o === 'string' ? o : o?.nome)).filter(Boolean)
}

/**
 * Acha a obra numa frase: pelo nome inteiro, ou por uma palavra que só
 * exista nela.
 *
 * O nome inteiro é tentado primeiro porque é mais específico. Só depois vem
 * o apelido — e nele a tolerância a erro de escrita continua valendo, porque
 * quem digita "tsuia" quis dizer "tsuya".
 */
export function acharObra(texto, obras) {
  const nomes = nomesDe(obras)

  const porNome = acharNaFrase(texto, nomes)
  if (porNome.achado) return porNome

  /*
    Os APELIDOS APRENDIDOS, como frase inteira.

    Vêm logo depois do nome oficial e antes de qualquer palpite: a pessoa
    disse, com todas as letras, que "escola do ze" é aquela obra, e isso vale
    mais que qualquer semelhança que o código consiga inventar.
  */
  const deApelido = new Map()
  for (const o of obras ?? []) {
    for (const ap of (typeof o === 'object' ? o.apelidos ?? [] : [])) deApelido.set(ap, o.nome)
  }
  if (deApelido.size) {
    const r = acharNaFrase(texto, [...deApelido.keys()])
    if (r.achado) return { achado: deApelido.get(r.achado), resto: r.resto }
  }

  const apelidos = apelidosDe(obras)

  const porApelido = apelidos.size ? acharNaFrase(texto, [...apelidos.keys()]) : { achado: null }
  if (porApelido.achado) {
    return { achado: apelidos.get(porApelido.achado), resto: porApelido.resto }
  }

  /*
    Nada casou sozinho. Mas a pessoa pode ter escrito a CIDADE, e a cidade
    ter duas obras — "bastos" é exatamente esse caso.

    Aí não se chuta: devolve-se os candidatos para quem chama perguntar
    entre eles. Perguntar "é a Tsuya ou a Águia de Haia?" é uma pergunta boa;
    escolher uma das duas ao acaso lançaria o custo na errada, calado.
  */
  const ambiguos = apelidos.ambiguos ?? new Map()
  if (ambiguos.size) {
    const achado = acharNaFrase(texto, [...ambiguos.keys()])
    if (achado.achado) {
      return { achado: null, resto: achado.resto, candidatos: ambiguos.get(achado.achado) }
    }
  }

  return { achado: null, resto: texto ?? '' }
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
  FERRAMENTAS: ['ferramenta', 'ferramentas'],
  EPI: ['epi'],
  LOCACAO: ['locacao', 'locacoes', 'aluguel', 'alugado', 'alugada'],
  TRANSPORTE: ['transporte', 'frete'],
  MAO_DE_OBRA: ['mao de obra', 'maodeobra', 'mao-de-obra', 'servico', 'servicos'],
  HOSPEDAGEM: ['hospedagem'],
  MANUTENCAO: ['manutencao'],
  OUTRO: ['outro', 'outros', 'taxa', 'taxas'],
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
 * Acha TODAS as obras citadas, e não só a primeira.
 *
 * Existe porque uma compra só costuma servir a mais de uma obra: o caminhão
 * de areia abastece duas escolas na mesma viagem. Sem isto a pessoa lança
 * tudo numa e o custo da outra fica errado — e ninguém percebe, porque o
 * total bate com o comprovante.
 *
 * A primeira é a obra do lançamento; as outras entram no rateio. Ordem de
 * aparição, que é a ordem em que a pessoa pensou.
 */
export function acharObras(texto, obras, limite = 6) {
  const achadas = []
  let resto = texto ?? ''

  for (let i = 0; i < limite; i++) {
    const r = acharObra(resto, obras)
    if (!r.achado) {
      // Guarda os candidatos da primeira rodada: se nenhuma obra foi achada,
      // é entre eles que se pergunta.
      return { obras: achadas, resto, candidatos: achadas.length ? null : (r.candidatos ?? null) }
    }
    if (!achadas.includes(r.achado)) achadas.push(r.achado)
    resto = r.resto
  }
  return { obras: achadas, resto, candidatos: null }
}

/**
 * Quais dos sócios conhecidos servem para o nome escrito.
 *
 * Nome inteiro, ou um pedaço dele: "joao" e "joao carlos" acham "João Carlos
 * Silva". Basta que TODAS as palavras escritas estejam no nome — ninguém
 * digita o nome completo de cadastro numa legenda de foto.
 *
 * Devolve a LISTA, e não um escolhido, de propósito: quem chama decide o que
 * fazer com dois candidatos. Na legenda, dois significa desistir; numa
 * resposta à pergunta "quem pagou?", significa perguntar de novo entre esses
 * dois. A regra de casar é a mesma nos dois casos, e fica num lugar só.
 */
export function pagadoresQueServem(escrito, pagadores) {
  const alvo = norm(escrito ?? '')
  if (!alvo || !pagadores?.length) return []

  const iguais = pagadores.filter(p => norm(p) === alvo)
  if (iguais.length) return iguais

  const partes = alvo.split(' ').filter(Boolean)
  return pagadores.filter(p => {
    const doNome = norm(p).split(' ')
    return partes.every(x => doNome.includes(x))
  })
}

/**
 * Acha quem BANCOU o gasto: "pago por João", "quem pagou foi a Ana".
 *
 * Procurado ANTES de tudo, e por uma razão prática: o nome do pagador é um
 * nome próprio no meio da frase, e sem tirá-lo antes ele vira descrição — ou,
 * pior, é confundido com o nome de uma obra.
 *
 * A marca é a preposição. "Pago por" e "pagou" são as formas que as pessoas
 * usam; sem uma delas, um nome solto na linha não vira pagador, porque aí
 * seria adivinhação.
 */
export function acharPagador(texto, pagadores) {
  if (!texto || !pagadores?.length) return { achado: null, resto: texto ?? '' }

  // "pago por X", "pagou X", "quem pagou foi X" — X até o fim ou até uma
  // vírgula, que é onde o campo seguinte começa.
  const marca = /\b(?:pag(?:o|a|ou|amento)\s+(?:por|pelo|pela)|quem\s+pagou\s+foi|pagou)\s+(?:o\s+|a\s+)?([^,;\n]+)/i
  const achou = marca.exec(texto)
  if (!achou) return { achado: null, resto: texto }

  const escrito = achou[1].trim()
  const alvo = norm(escrito)
  if (!alvo) return { achado: null, resto: texto }

  const candidatos = pagadoresQueServem(escrito, pagadores)

  if (candidatos.length !== 1) {
    return { achado: null, resto: texto, ambiguo: candidatos.length > 1 ? candidatos : null }
  }

  const resto = (texto.slice(0, achou.index) + texto.slice(achou.index + achou[0].length))
    .replace(/\s*,\s*,\s*/g, ', ')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .trim()

  return { achado: candidatos[0], resto }
}

/**
 * Interpreta a linha inteira.
 *
 * Devolve sempre um objeto — linha vazia ou incompreensível dá todos os
 * campos nulos, e o comprovante segue assim mesmo para a caixa de aprovação.
 * Nunca recusa um comprovante por não entender o texto: a foto no lugar
 * certo já vale, e quem aprova completa o que faltar.
 */
export function interpretar(texto, obras = [], pagadores = []) {
  const vazio = { obra: null, rateio: null, descricao: null, tipo: null, valor: null, pagoPor: null, candidatos: null, textoOriginal: texto ?? null }
  if (!texto?.trim()) return vazio

  // O pagador sai primeiro: é nome próprio no meio da frase, e deixado ali
  // viraria descrição — ou seria confundido com nome de obra.
  const comPagador = acharPagador(texto, pagadores)
  const pagoPor = comPagador.achado

  const { valor, resto, ambiguo: valorAmbiguo } = acharValor(comPagador.resto)

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
  const todas = acharObras(resto, obras)
  let obra = todas.obras[0] ?? null
  // As demais viram rateio: o mesmo gasto dividido entre elas.
  const rateio = todas.obras.slice(1)
  let sobra = todas.resto
  // Cidade com mais de uma obra: quem chama pergunta entre estas.
  const candidatos = todas.candidatos ?? null

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

  return {
    obra, rateio: rateio.length ? rateio : null,
    descricao, tipo, valor, pagoPor, candidatos, textoOriginal: texto,
    // Os valores que apareceram quando havia mais de um com cara de dinheiro.
    // Serve para a pergunta dizer QUAIS eram — perguntar "qual o valor?" logo
    // depois de a pessoa ter escrito dois faz ela achar que o robô não leu.
    valorAmbiguo: valorAmbiguo ?? null,
  }
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
    // Outras obras citadas na mesma linha: o gasto é dividido entre elas.
    rateio: escrito?.rateio ?? null,
    // Quem bancou. Só sai da linha escrita: a foto do cupom não sabe quem
    // pagou, e a IA não deve chutar um nome de pessoa.
    pagoPor: escrito?.pagoPor ?? null,
    // As obras entre as quais perguntar, quando a pessoa escreveu algo que
    // serve para mais de uma (a cidade, tipicamente).
    candidatos: escrito?.candidatos ?? null,
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
