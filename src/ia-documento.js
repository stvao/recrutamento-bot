/**
 * Leitura do documento que o CANDIDATO manda: currículo, carteira de trabalho
 * digital, RG, CPF.
 *
 * Separado da leitura de comprovante (ia-visao.js) porque o que se procura é
 * outra coisa, e misturar as duas instruções faria o modelo procurar valor de
 * nota fiscal num currículo.
 *
 * Mesma divisão do resto do robô: o MODELO lê e propõe, o CÓDIGO confere, o
 * RH decide. CPF com dígito verificador errado não vale; o que a foto diz só
 * preenche o que está vazio na ficha (ver /api/integracao/candidatura/documento).
 *
 * O documento é opcional para o candidato (regra do dono, 13/09/2026): quem
 * não quiser mandar segue a candidatura normalmente.
 */
import { modelosDeVisao } from './ia-visao.js'

const CHAVE = process.env.GEMINI_API_KEY || ''
const PRAZO_MS = Number(process.env.IA_DOCUMENTO_PRAZO_MS || 30000)
const ENDPOINT_FIXO = process.env.IA_DOCUMENTO_ENDPOINT || null

export const TIPOS_DOCUMENTO = ['curriculo', 'ctps', 'rg', 'cpf', 'cnh', 'outro']

/** O RH aceita até 10 MB; maior que isso nem vale ler. */
export const MAX_DOCUMENTO_BYTES = 10 * 1024 * 1024

const INSTRUCOES = `Você lê um documento que um candidato a vaga de obra mandou pelo WhatsApp.
Diga o que ele é e extraia só o que está ESCRITO nele. Nunca invente.

- tipo: "curriculo", "ctps" (carteira de trabalho, física ou digital), "rg",
  "cpf", "cnh" ou "outro".
- nome: nome completo como está no documento. Vazio se não houver.
- cpf: só os números, se estiver escrito. Vazio se não houver.
- rg: número do RG, se estiver escrito. Vazio se não houver.
- resumo: UMA frase com a experiência profissional que aparece (funções,
  empresas, tempo). Sem endereço, telefone, CPF ou dado pessoal. Vazio se não
  houver experiência no documento.
- confianca: "alta" se a imagem está legível, "baixa" se não.`

const ESQUEMA = {
  type: 'object',
  properties: {
    tipo: { type: 'string', enum: TIPOS_DOCUMENTO },
    nome: { type: 'string' },
    cpf: { type: 'string' },
    rg: { type: 'string' },
    resumo: { type: 'string' },
    confianca: { type: 'string', enum: ['alta', 'baixa'] },
  },
  required: ['tipo', 'nome', 'cpf', 'rg', 'resumo', 'confianca'],
}

/** Dígitos verificadores. CPF que não fecha a conta é leitura errada. */
export function cpfValido(cpf) {
  const d = String(cpf ?? '').replace(/\D/g, '')
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false
  for (const [qtd, pos] of [[9, 10], [10, 11]]) {
    let soma = 0
    for (let i = 0; i < qtd; i++) soma += Number(d[i]) * (pos - i)
    if ((soma * 10) % 11 % 10 !== Number(d[qtd])) return false
  }
  return true
}

/** Confere o que o modelo devolveu. O que não passa vira null. */
export function conferirLeitura(bruto) {
  if (!bruto || typeof bruto !== 'object') return null
  const texto = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
  const cpf = String(bruto.cpf ?? '').replace(/\D/g, '')
  const rg = texto(bruto.rg, 20)
  return {
    tipo: TIPOS_DOCUMENTO.includes(bruto.tipo) ? bruto.tipo : 'outro',
    nome: texto(bruto.nome, 120),
    cpf: cpfValido(cpf) ? cpf : null,
    rg: rg && /^[\dXx.\-\s]{5,15}$/.test(rg) ? rg : null,
    resumo: texto(bruto.resumo, 300),
    confianca: bruto.confianca === 'alta' ? 'alta' : 'baixa',
  }
}

/**
 * Lê o documento. Null em qualquer problema: o arquivo vai para o RH mesmo
 * assim, só sem leitura — a foto no lugar certo já vale.
 */
export async function lerDocumentoCandidato({ arquivo, tipo }) {
  if (!CHAVE || !arquivo?.length || arquivo.length > MAX_DOCUMENTO_BYTES) return null
  for (const modelo of modelosDeVisao().slice(0, 2)) {
    const r = await umaTentativa({ arquivo, tipo, modelo })
    if (r) return r
  }
  return null
}

async function umaTentativa({ arquivo, tipo, modelo }) {
  const url = ENDPOINT_FIXO || `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`
  try {
    const r = await fetch(`${url}?key=${CHAVE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: INSTRUCOES }] },
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: tipo || 'image/jpeg', data: Buffer.from(arquivo).toString('base64') } }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: ESQUEMA, temperature: 0, maxOutputTokens: 400 },
      }),
      signal: AbortSignal.timeout(PRAZO_MS),
    })
    if (!r.ok) {
      console.warn(`[ia-documento] "${modelo}": HTTP ${r.status}`)
      return null
    }
    const j = await r.json()
    const t = j?.candidates?.[0]?.content?.parts?.[0]?.text
    return t ? conferirLeitura(JSON.parse(t)) : null
  } catch (e) {
    console.warn(`[ia-documento] "${modelo}" indisponível:`, e.message)
    return null
  }
}
