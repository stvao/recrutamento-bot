/**
 * Ouvir o áudio do candidato.
 *
 * 6% das mensagens que chegam são áudio, e o robô respondia "consigo ler só
 * texto". Quem está na obra, com a mão suja, manda áudio — é o jeito mais
 * natural de falar, e mandar a pessoa digitar é pedir para ela desistir.
 *
 * Usa o mesmo caminho que lê comprovante: o Gemini aceita áudio como aceita
 * imagem. A transcrição entra na conversa como se a pessoa tivesse escrito.
 *
 * Falhar aqui não é grave: sem transcrição o robô pede, uma vez, para
 * escrever. O que não pode é a mensagem sumir.
 */
const CHAVE = process.env.GEMINI_API_KEY || ''

const MODELOS = (process.env.IA_AUDIO_MODELOS
  || 'gemini-3.5-flash,gemini-flash-latest,gemini-flash-lite-latest')
  .split(',').map(m => m.trim()).filter(Boolean)

const ENDPOINT_FIXO = process.env.IA_AUDIO_ENDPOINT || null

const enderecoDe = (modelo) => ENDPOINT_FIXO
  || `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`

/** Áudio de WhatsApp é curto; 30s é folgado até com o serviço carregado. */
const PRAZO_MS = Number(process.env.IA_AUDIO_PRAZO_MS || 30000)

/**
 * O maior áudio que vale transcrever.
 *
 * Um áudio de WhatsApp de dois minutos tem menos de 1 MB. Acima de 16 MB é
 * outra coisa — e pagar leitura de modelo por ela não ajuda ninguém.
 */
export const MAX_AUDIO_BYTES = Number(process.env.IA_AUDIO_MAX_MB || 16) * 1024 * 1024

export function audioDisponivel() {
  return Boolean(CHAVE)
}

/*
  O pedido é deliberadamente burro: transcrever, e nada mais.

  Sem resumir, sem interpretar, sem responder ao que foi dito. Quem conduz a
  conversa é o mesmo cérebro que atende o texto — se este aqui "ajudasse",
  passariam a existir dois jeitos de responder, e um deles sem as regras.
*/
const INSTRUCAO = `Transcreva exatamente o que a pessoa falou neste áudio, em português do Brasil.
Escreva só a transcrição, sem comentar, sem resumir e sem responder.
É gente de obra falando de vaga de emprego: pedreiro, servente, carpinteiro, alojamento, cidade.
Se não der para entender nada, responda apenas: (inaudível)`

/**
 * Devolve o que a pessoa falou, ou null quando não deu.
 */
export async function transcrever({ arquivo, tipo }) {
  if (!CHAVE || !arquivo?.length) return null
  if (arquivo.length > MAX_AUDIO_BYTES) {
    console.warn(`[ia-audio] áudio de ${(arquivo.length / 1024 / 1024).toFixed(1)} MB — grande demais, não transcrevi.`)
    return null
  }

  for (let i = 0; i < MODELOS.length; i++) {
    const texto = await umaTentativa({ arquivo, tipo, modelo: MODELOS[i] })
    if (texto) {
      if (i > 0) console.log(`[ia-audio] transcrição veio do modelo reserva "${MODELOS[i]}"`)
      return texto
    }
    if (i + 1 < MODELOS.length) console.warn(`[ia-audio] "${MODELOS[i]}" não respondeu — tentando "${MODELOS[i + 1]}"`)
  }
  /*
    Segunda rodada no primeiro modelo antes de desistir.

    Muita gente de obra só manda áudio, e "não consegui ouvir" saiu 32 vezes
    em 180 dias. A falha aqui costuma ser passageira (503, tempo estourado);
    insistir uma vez custa segundos e salva a mensagem.
  */
  const ultima = await umaTentativa({ arquivo, tipo, modelo: MODELOS[0] })
  if (ultima) {
    console.log('[ia-audio] transcrição veio na segunda tentativa.')
    return ultima
  }
  console.warn('[ia-audio] nenhum modelo transcreveu o áudio.')
  return null
}

async function umaTentativa({ arquivo, tipo, modelo }) {
  try {
    const r = await fetch(`${enderecoDe(modelo)}?key=${CHAVE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(PRAZO_MS),
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: tipo || 'audio/ogg', data: Buffer.from(arquivo).toString('base64') } },
            { text: INSTRUCAO },
          ],
        }],
        generationConfig: { temperature: 0 },
      }),
    })

    if (!r.ok) {
      console.warn(`[ia-audio] modelo "${modelo}" respondeu ${r.status}`)
      return null
    }

    const j = await r.json()
    const texto = j?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join(' ').trim()
    if (!texto) return null

    // "(inaudível)" é o modelo dizendo que não entendeu — vale como não ter
    // transcrição, e não como uma frase que a pessoa falou.
    if (/^\(?inaud/i.test(texto)) return null

    return texto.slice(0, 2000)
  } catch (e) {
    console.warn(`[ia-audio] "${modelo}" falhou: ${e.message}`)
    return null
  }
}
