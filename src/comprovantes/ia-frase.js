/**
 * Comprovantes — a IA lendo o que a pessoa ESCREVEU, quando as regras não
 * dão conta.
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 *
 * As regras de `lancamento.js` entendem a legenda do jeito que a equipe
 * costuma escrever ("Material Bastos 250"). Não entendem a conversa:
 * "corrigindo, não é haia, é para ratear tsuya e haia, e pagamento feito por
 * estevão" — uma negação, uma troca, um rateio e um pagador na mesma frase.
 *
 * Aqui a IA lê o texto todo (legenda e respostas, em ordem) e devolve o que
 * entendeu. Mas ela PROPÕE; quem decide é o código, com as regras da casa:
 *
 *  - a obra tem de ser uma das que estão abertas E estar citada no texto
 *    (pelo nome, apelido ou cidade) — a IA escolhe entre o que a pessoa
 *    disse, nunca inventa uma obra;
 *  - o valor tem de ser um número que a pessoa ESCREVEU;
 *  - quem pagou tem de ser um dos sócios;
 *  - leitura de confiança baixa não muda nada.
 *
 * Só é chamada quando vale a pena: faltou a obra ou o valor depois das
 * regras, ou a pessoa está CORRIGINDO algo ("não é", "na verdade",
 * "corrigindo"). E o resultado fica guardado no comprovante: a mesma frase
 * não é perguntada duas vezes.
 *
 * Falhou (sem chave, cota, rede, resposta estranha)? Devolve null, e fica o
 * que as regras entenderam — o comportamento de antes.
 */
import { CATEGORIAS, modelosDeVisao } from './ia-visao.js'
import { acharObras, ratearEntreTodas, nomesDe, cidadeDe } from './lancamento.js'
import { norm } from '../texto.js'

const CHAVE = process.env.GEMINI_API_KEY || ''
// Sem endereço próprio, usa o da leitura da imagem quando há um (é o mesmo
// serviço) — e o do Google, quando não há.
const ENDPOINT_FIXO = process.env.IA_FRASE_ENDPOINT || process.env.IA_VISAO_ENDPOINT || null
const PRAZO_MS = Number(process.env.IA_FRASE_PRAZO_MS || 20000)

/** Ligada quando há chave da IA, a não ser que se desligue com GASTOS_IA_FRASE=off. */
export function iaFraseLigada() {
  return Boolean(CHAVE) && String(process.env.GASTOS_IA_FRASE ?? 'on').toLowerCase() !== 'off'
}

/** A pessoa está corrigindo o que disse antes? */
export const CORRIGINDO = /(^|[^a-zà-ú])(corrigindo|corrige|corre[cç][aã]o|n[aã]o [eé]|n[aã]o era|na verdade|errad[oa]|errei|troca|trocar|ao inv[eé]s|em vez)([^a-zà-ú]|$)/i

const ESQUEMA = {
  type: 'object',
  properties: {
    obras: { type: 'array', items: { type: 'string' }, description: 'As obras do gasto, com o NOME EXATO da lista. Mais de uma = rateio. Vazio se o texto não diz.' },
    valor: { type: 'number', description: 'O valor do gasto em reais, só se a pessoa ESCREVEU. 0 se não escreveu.' },
    pagoPor: { type: 'string', description: 'Quem pagou, com o nome EXATO da lista de sócios. Vazio se não diz.' },
    empresaPagou: { type: 'boolean', description: 'true se o texto diz que a empresa (o caixa da empresa) pagou.' },
    categoria: { type: 'string', enum: ['', ...CATEGORIAS], description: 'A categoria, se o texto deixa claro. Vazio se não.' },
    descricao: { type: 'string', description: 'O que foi comprado ou pago, em poucas palavras, SEM obra, valor nem quem pagou. Vazio se não diz.' },
    confianca: { type: 'string', enum: ['alta', 'media', 'baixa'], description: 'Quão claro o texto é.' },
  },
  required: ['obras', 'valor', 'pagoPor', 'empresaPagou', 'categoria', 'descricao', 'confianca'],
}

const INSTRUCOES = `Você ajuda a lançar gastos de uma construtora a partir do que a equipe
escreve no WhatsApp junto com um comprovante. O texto vem em ordem: a legenda
e depois as respostas da pessoa às perguntas do robô. A ÚLTIMA palavra da
pessoa vale mais: se ela corrigiu ("não é haia, é tsuya"), vale a correção.

Regras:
- Obras: use SÓ nomes da lista, exatamente como estão. A equipe chama as obras
  pela cidade ou por um pedaço do nome. "ratear", "dividir", "as duas", "todas"
  = mais de uma obra. "todas menos X" = todas da lista, sem X.
- Valor: só se a pessoa escreveu um número de dinheiro. Nunca invente.
- Quem pagou: só se o texto disser, e só com um nome da lista de sócios.
  "caixa da empresa", "a empresa pagou" = empresaPagou true.
- Na dúvida, deixe vazio e marque confianca "baixa".`

/** Todos os números que a pessoa escreveu, como valor em reais. */
function numerosEscritos(texto) {
  const achados = String(texto ?? '').match(/\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+,\d{1,2}|\d+(?:\.\d{1,2})?/g) ?? []
  return achados.map((n) => {
    if (n.includes(',')) return Number(n.replace(/\./g, '').replace(',', '.'))
    if (/^\d{1,3}(\.\d{3})+$/.test(n)) return Number(n.replace(/\./g, ''))
    return Number(n)
  }).filter(n => Number.isFinite(n) && n > 0)
}

/**
 * O que a IA entendeu do texto, já conferido. Devolve null quando não há
 * nada aproveitável.
 *
 * `fetcher` é só para teste.
 */
export async function entenderFrase({ trechos, obras, socios = [] }, { fetcher = fetch } = {}) {
  if (!iaFraseLigada() || !trechos?.length) return null
  const texto = trechos.join('\n')
  const nomes = nomesDe(obras)
  const listaObras = (obras ?? []).map((o) => {
    const nome = typeof o === 'string' ? o : o.nome
    const cidade = cidadeDe(o)
    return `- ${nome}${cidade && cidade.length <= 40 ? ` (cidade: ${cidade})` : ''}`
  }).join('\n')

  const pedido = [
    `Obras abertas:\n${listaObras}`,
    `Sócios: ${socios.length ? socios.join(', ') : '(nenhum)'}`,
    `O que a pessoa escreveu, em ordem:\n${trechos.map((t, i) => `${i === 0 ? 'Legenda' : `Resposta ${i}`}: ${t}`).join('\n')}`,
  ].join('\n\n')

  let bruto = null
  try {
    const modelo = modelosDeVisao()[0]
    const endereco = ENDPOINT_FIXO || `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`
    const r = await fetcher(`${endereco}?key=${CHAVE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: INSTRUCOES }] },
        contents: [{ role: 'user', parts: [{ text: pedido }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: ESQUEMA, temperature: 0, maxOutputTokens: 400 },
      }),
      signal: AbortSignal.timeout(PRAZO_MS),
    })
    if (!r.ok) { console.warn(`[ia-frase] HTTP ${r.status}`); return null }
    const j = await r.json()
    const t = j?.candidates?.[0]?.content?.parts?.[0]?.text
    bruto = t ? JSON.parse(t) : null
  } catch (e) {
    console.warn('[ia-frase] não consegui:', e.message)
    return null
  }
  return conferirFrase(bruto, { texto, obras, nomes, socios })
}

/**
 * A conferência — exportada para teste. Tudo que não passa vira null.
 *
 * A obra só vale se a pessoa a CITOU: pelo nome, apelido ou cidade (o que
 * `acharObras` acha no texto), ou pedindo "todas". A IA resolve a negação e a
 * escolha entre o que foi dito; não traz obra de fora.
 */
export function conferirFrase(bruto, { texto, obras, nomes, socios }) {
  if (!bruto || typeof bruto !== 'object' || bruto.confianca === 'baixa') return null

  const citadas = new Set()
  // Procura em cada pedaço, para achar todas as obras citadas (acharObras
  // para na sexta, e "não é haia, é tsuya" tem a mesma obra duas vezes).
  for (const pedaco of String(texto).split(/[\n,;.]+|\s+e\s+|\s+ou\s+/)) {
    const achou = acharObras(pedaco, obras)
    for (const o of achou.obras) citadas.add(o)
    for (const o of achou.candidatos ?? []) citadas.add(o)
  }
  for (const o of ratearEntreTodas(texto, obras) ?? []) citadas.add(o)

  const porNome = new Map(nomes.map(n => [norm(n), n]))
  const obrasIa = (Array.isArray(bruto.obras) ? bruto.obras : [])
    .map(o => porNome.get(norm(o)))
    .filter(Boolean)
  const obrasValidas = obrasIa.length && obrasIa.every(o => citadas.has(o)) ? [...new Set(obrasIa)] : null

  const escritos = numerosEscritos(texto)
  const valor = typeof bruto.valor === 'number' && bruto.valor > 0 && escritos.some(n => Math.abs(n - bruto.valor) < 0.005)
    ? Math.round(bruto.valor * 100) / 100 : null

  const pagoPor = socios.find(s => norm(s) === norm(bruto.pagoPor ?? '')) ?? null
  const categoria = CATEGORIAS.includes(bruto.categoria) ? bruto.categoria : null
  const descricao = typeof bruto.descricao === 'string' && bruto.descricao.trim() ? bruto.descricao.trim().slice(0, 80) : null

  if (!obrasValidas && valor == null && !pagoPor && !bruto.empresaPagou && !categoria) return null
  return { obras: obrasValidas, valor, pagoPor, empresaPagou: bruto.empresaPagou === true && !pagoPor, categoria, descricao }
}
