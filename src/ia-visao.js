/**
 * Leitura do comprovante por modelo de visão.
 *
 * Regra fixa não serve aqui: cada banco e cada cupom têm formato próprio, e
 * manter expressão regular para cada um seria manutenção sem fim. Modelo de
 * visão lê foto torta de cupom amassado, que é o que chega no grupo.
 *
 * A divisão é a mesma do resto do robô, e pelo mesmo motivo:
 *
 *   O MODELO lê e propõe. O HUMANO confirma. O CÓDIGO não deixa virar custo.
 *
 * Ela erra — lê 1.500 onde era 1.800, confunde data, troca categoria. Por
 * isso nada daqui vira lançamento: vai para a caixa de aprovação, onde
 * alguém confere. O `confianca` existe para a mensagem de volta avisar
 * quando vale olhar com mais atenção.
 *
 * Usa a mesma chave do Gemini que a Maria Vitória já usa. Uma configuração
 * a menos para dar errado, e o plano gratuito cobre folgado o volume de
 * comprovante de uma construtora.
 */
const CHAVE = process.env.GEMINI_API_KEY || ''

/**
 * Modelos de visão, em ordem de preferência.
 *
 * É uma LISTA, e não um modelo só, por uma razão medida na prática: o
 * `gemini-flash-latest` passou a devolver 503 (sobrecarregado) e a leitura
 * simplesmente parou de acontecer — em silêncio, porque a falha aqui é
 * tratada como "segue sem resumo". Comprovante chegava sem valor nenhum e
 * ninguém sabia por quê.
 *
 * Modelo indisponível é condição normal na cota gratuita, não exceção. Com a
 * lista, um 503 no primeiro só custa ir para o segundo.
 *
 * A ordem é de propósito: o melhor primeiro, e um `lite` no fim — leitura
 * pior é melhor que leitura nenhuma.
 */
const MODELOS = (process.env.IA_VISAO_MODELO || process.env.IA_VISAO_MODELOS
  || 'gemini-flash-latest,gemini-3.5-flash,gemini-flash-lite-latest')
  .split(',').map(m => m.trim()).filter(Boolean)

const ENDPOINT_FIXO = process.env.IA_VISAO_ENDPOINT || null

function enderecoDe(modelo) {
  return ENDPOINT_FIXO
    || `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`
}

/**
 * Quanto esperar por modelo.
 *
 * Medido contra a cota gratuita: uma leitura de comprovante leva de 15 a 25
 * segundos quando o serviço está carregado. O prazo era 20s e cortava
 * leitura boa no meio. Quem mandou a foto no grupo aceita esperar meio
 * minuto pela confirmação; o que ele não aceita é o valor vir vazio.
 */
const PRAZO_MS = Number(process.env.IA_VISAO_PRAZO_MS || 35000)

/**
 * Quantos modelos tentar. Não é "quantas vezes o mesmo": repetir no modelo
 * que acabou de responder 503 não muda nada — trocar de modelo, sim.
 */
const TENTATIVAS = Number(process.env.IA_VISAO_TENTATIVAS || MODELOS.length)

export function visaoDisponivel() {
  return Boolean(CHAVE)
}

/** Diagnóstico: quais modelos estão na fila. */
export function modelosDeVisao() {
  return [...MODELOS]
}

/**
 * As categorias que o sistema de obras conhece.
 *
 * Lista fechada de propósito: categoria inventada pelo modelo não casa com
 * nada do outro lado, e a pessoa teria que corrigir na mão — que é
 * exatamente o trabalho que se quer tirar dela.
 */
export const CATEGORIAS = [
  'COMBUSTIVEL', 'MATERIAL', 'ALIMENTACAO', 'FERRAMENTA', 'LOCACAO',
  'TRANSPORTE', 'MAO_DE_OBRA', 'HOSPEDAGEM', 'MANUTENCAO', 'TAXA', 'OUTROS',
]

const ESQUEMA = {
  type: 'object',
  properties: {
    valor: { type: 'number', description: 'Valor TOTAL pago, em reais. Havendo total e subtotal, use o TOTAL. Sem simbolo de moeda. 0 se nao conseguir ler.' },
    data: { type: 'string', description: 'Data do pagamento no formato AAAA-MM-DD. Vazio se nao conseguir ler.' },
    estabelecimento: { type: 'string', description: 'Nome de quem RECEBEU o pagamento (posto, loja, pessoa). Vazio se nao conseguir ler.' },
    categoria: { type: 'string', enum: CATEGORIAS, description: 'A categoria do gasto.' },
    documento: { type: 'string', description: 'Numero do cupom, nota ou id da transacao, se aparecer. Vazio se nao.' },
    formaPagamento: { type: 'string', description: 'Pix, cartao, dinheiro, boleto — como aparece no comprovante. Vazio se nao aparecer.' },
    confianca: { type: 'string', enum: ['alta', 'media', 'baixa'], description: 'Quao seguro voce esta do VALOR e da DATA. "baixa" se a foto esta ruim, cortada ou ilegivel.' },
    observacao: { type: 'string', description: 'So se algo estiver estranho (foto cortada, dois valores possiveis, ilegivel). Vazio se estiver tudo claro.' },
  },
  required: ['valor', 'data', 'estabelecimento', 'categoria', 'documento', 'formaPagamento', 'confianca', 'observacao'],
}

const INSTRUCOES = `Você lê comprovantes de pagamento de uma construtora que reforma escolas
no interior e no litoral de São Paulo. As fotos vêm de celular, tiradas na
obra: tortas, com sombra, papel amassado, às vezes só parte do cupom.

Extraia o que der para ler COM CERTEZA. O que não der, deixe vazio.

REGRAS QUE VOCÊ NÃO QUEBRA
- NUNCA invente ou estime um valor. Se o total está ilegível, ponha 0 e
  marque confianca "baixa". Um valor chutado vira lançamento errado no
  financeiro da empresa, e ninguém percebe.
- Quando houver SUBTOTAL e TOTAL, o valor é o TOTAL — o que foi efetivamente
  pago, já com descontos e acréscimos.
- Em comprovante de Pix ou transferência, o valor é o transferido e o
  estabelecimento é QUEM RECEBEU, não quem pagou.
- A data é a do PAGAMENTO, não a de emissão do documento nem a de vencimento.
- Data sempre em AAAA-MM-DD. Cupom brasileiro escreve DD/MM/AAAA: 03/08/2026
  é 2026-08-03, e não 2026-03-08.
- Se a imagem não for um comprovante de pagamento (foto de obra, print de
  conversa, selfie), ponha 0 no valor, confianca "baixa" e diga o que é na
  observacao.

CATEGORIA, pelo que foi comprado:
- COMBUSTIVEL: posto, gasolina, diesel, etanol, arla
- MATERIAL: cimento, areia, tijolo, tinta, madeira, material elétrico/hidráulico
- ALIMENTACAO: restaurante, mercado, padaria, marmita, água, café
- FERRAMENTA: COMPRA de ferramenta ou equipamento
- LOCACAO: ALUGUEL de equipamento — bomba de concreto, betoneira, andaime,
  escoramento, caçamba, guincho, gerador, container. Se foi alugado e não
  comprado, é LOCACAO.
- TRANSPORTE: frete, pedágio, estacionamento, passagem, aplicativo
- MAO_DE_OBRA: pagamento a prestador, diária, empreita
- HOSPEDAGEM: hotel, pousada, aluguel de alojamento
- MANUTENCAO: oficina, peça, pneu, revisão de veículo
- TAXA: cartório, prefeitura, ART, licença, multa
- OUTROS: só quando nenhuma das outras serve`

/**
 * Lê um comprovante e devolve o que conseguiu extrair.
 *
 * Devolve null em QUALQUER problema — sem chave, cota estourada, rede fora,
 * resposta estranha. Quem chama trata null como "não consegui ler": o
 * comprovante segue para a caixa de aprovação assim mesmo, só sem o resumo.
 * A foto no lugar certo já vale; a leitura é o bônus.
 */
export async function lerComprovante({ arquivo, tipo, descricao }) {
  if (!CHAVE) return null

  const quantos = Math.min(TENTATIVAS, MODELOS.length)
  for (let i = 0; i < quantos; i++) {
    const modelo = MODELOS[i]
    const r = await umaTentativa({ arquivo, tipo, descricao, modelo })
    if (r) {
      if (i > 0) console.log(`[ia-visao] leitura veio do modelo reserva "${modelo}"`)
      return r
    }
    if (i + 1 < quantos) console.warn(`[ia-visao] "${modelo}" não respondeu — tentando "${MODELOS[i + 1]}"`)
  }
  console.warn('[ia-visao] nenhum modelo respondeu — o comprovante segue sem leitura da imagem.')
  return null
}

async function umaTentativa({ arquivo, tipo, descricao, modelo }) {
  const partes = [
    { inline_data: { mime_type: tipo || 'image/jpeg', data: Buffer.from(arquivo).toString('base64') } },
  ]
  // O que a pessoa escreveu junto costuma dizer o que a foto não diz — a obra,
  // ou "almoço da equipe". Entra como contexto, mas não substitui o que está
  // escrito no comprovante.
  if (descricao?.trim()) {
    partes.push({ text: `Quem enviou escreveu junto: "${descricao.trim()}". Use como contexto, mas o valor e a data vêm do comprovante.` })
  }

  const corpo = {
    systemInstruction: { parts: [{ text: INSTRUCOES }] },
    contents: [{ role: 'user', parts: partes }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: ESQUEMA,
      // Zero: aqui não se quer criatividade nenhuma. Se quer o que está
      // escrito no papel, e a mesma foto lida duas vezes tem que dar o mesmo
      // número.
      temperature: 0,
      maxOutputTokens: 500,
    },
  }

  try {
    const controle = new AbortController()
    const prazo = setTimeout(() => controle.abort(), PRAZO_MS)
    const r = await fetch(`${enderecoDe(modelo)}?key=${CHAVE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
      signal: controle.signal,
    })
    clearTimeout(prazo)

    if (!r.ok) {
      // 503 = modelo sobrecarregado, 429 = cota do dia, 404 = modelo que não
      // existe mais. Nenhum é erro de programação, e nenhum melhora
      // insistindo no MESMO modelo — quem chama passa para o próximo.
      const nivel = r.status === 429 ? 'cota esgotada'
        : r.status === 503 ? 'modelo sobrecarregado'
        : r.status === 404 ? 'modelo não existe'
        : `HTTP ${r.status}`
      console.warn(`[ia-visao] "${modelo}": ${nivel}`)
      return null
    }

    const j = await r.json()
    const texto = j?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!texto) return null

    return conferir(JSON.parse(texto))
  } catch (e) {
    console.warn(`[ia-visao] "${modelo}" indisponível:`, e.name === 'AbortError' || e.name === 'TimeoutError'
      ? `demorou mais de ${PRAZO_MS}ms` : e.message)
    return null
  }
}

/**
 * Confere o que o modelo devolveu antes de qualquer coisa valer.
 *
 * Mesma regra do atendimento: o modelo é instruído, mas instrução não é
 * garantia. Valor negativo, data impossível ou categoria inventada viram
 * null aqui, e o campo simplesmente não é preenchido do outro lado — melhor
 * a pessoa digitar do que corrigir um número errado que ela pode não
 * conferir.
 */
export function conferir(bruto) {
  if (!bruto || typeof bruto !== 'object') return null

  const valor = typeof bruto.valor === 'number' && bruto.valor > 0 && bruto.valor < 1000000
    ? Math.round(bruto.valor * 100) / 100
    : null

  // Data no futuro é erro de leitura (ano trocado, quase sempre). Um dia de
  // folga cobre fuso e comprovante emitido depois da meia-noite.
  let data = null
  if (typeof bruto.data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(bruto.data)) {
    const d = new Date(`${bruto.data}T12:00:00Z`)
    const amanha = Date.now() + 1000 * 60 * 60 * 24
    if (!Number.isNaN(d.getTime()) && d.getTime() <= amanha && d.getUTCFullYear() >= 2020) {
      data = bruto.data
    }
  }

  const categoria = CATEGORIAS.includes(bruto.categoria) ? bruto.categoria : null
  const texto = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null)

  return {
    valor,
    data,
    estabelecimento: texto(bruto.estabelecimento),
    categoria,
    documento: texto(bruto.documento),
    formaPagamento: texto(bruto.formaPagamento),
    // Sem valor legível não existe leitura de confiança alta, mesmo que o
    // modelo diga que sim.
    confianca: valor && ['alta', 'media', 'baixa'].includes(bruto.confianca) ? bruto.confianca : 'baixa',
    observacao: texto(bruto.observacao),
  }
}
