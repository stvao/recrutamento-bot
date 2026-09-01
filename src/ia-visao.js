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
 * Modelo separado do da conversa, de propósito.
 *
 * A conversa usa o `flash-lite`, rápido e barato porque só precisa escrever
 * texto. Ler valor em cupom amassado é outra tarefa: errar um dígito aqui
 * custa dinheiro, então vale o modelo maior. Trocável pelo .env.
 */
const MODELO = process.env.IA_VISAO_MODELO || 'gemini-flash-latest'
const ENDPOINT = process.env.IA_VISAO_ENDPOINT
  || `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`

/** Ler imagem demora mais que escrever frase — o prazo da conversa é curto demais. */
const PRAZO_MS = Number(process.env.IA_VISAO_PRAZO_MS || 20000)
const TENTATIVAS = Number(process.env.IA_VISAO_TENTATIVAS || 2)

export function visaoDisponivel() {
  return Boolean(CHAVE)
}

/**
 * As categorias que o sistema de obras conhece.
 *
 * Lista fechada de propósito: categoria inventada pelo modelo não casa com
 * nada do outro lado, e a pessoa teria que corrigir na mão — que é
 * exatamente o trabalho que se quer tirar dela.
 */
export const CATEGORIAS = [
  'COMBUSTIVEL', 'MATERIAL', 'ALIMENTACAO', 'FERRAMENTA', 'TRANSPORTE',
  'MAO_DE_OBRA', 'HOSPEDAGEM', 'MANUTENCAO', 'TAXA', 'OUTROS',
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
- FERRAMENTA: compra ou aluguel de ferramenta e equipamento
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

  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
    const r = await umaTentativa({ arquivo, tipo, descricao })
    if (r) return r
    if (tentativa < TENTATIVAS) console.warn(`[ia-visao] tentando de novo (${tentativa + 1}/${TENTATIVAS})`)
  }
  return null
}

async function umaTentativa({ arquivo, tipo, descricao }) {
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
    const r = await fetch(`${ENDPOINT}?key=${CHAVE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
      signal: controle.signal,
    })
    clearTimeout(prazo)

    if (!r.ok) {
      const nivel = r.status === 429 ? 'cota esgotada' : `HTTP ${r.status}`
      console.warn(`[ia-visao] ${nivel} — comprovante segue sem resumo.`)
      return null
    }

    const j = await r.json()
    const texto = j?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!texto) return null

    return conferir(JSON.parse(texto))
  } catch (e) {
    console.warn('[ia-visao] indisponível:', e.name === 'AbortError' ? `demorou mais de ${PRAZO_MS}ms` : e.message)
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
