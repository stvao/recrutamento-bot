/**
 * Ouvir o áudio do candidato.
 *
 * 6% das mensagens são áudio, e a resposta era "consigo ler só texto" — ou
 * seja, o robô mandava quem está na obra parar e digitar.
 *
 * Roda contra um Gemini de mentira: o que se testa é a decisão (transcreveu,
 * não transcreveu, recusou por tamanho), não a qualidade do modelo.
 */
import { createServer } from 'node:http'

process.env.GEMINI_API_KEY = 'chave-de-teste'
process.env.IA_AUDIO_MAX_MB = '1'
process.env.IA_AUDIO_PRAZO_MS = '3000'

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

/** O que o Gemini de mentira vai responder da próxima vez. */
let proxima = { status: 200, texto: 'bom dia, sou pedreiro, tem vaga em bastos?' }
const pedidos = []

const srv = createServer((req, res) => {
  let corpo = ''
  req.on('data', c => { corpo += c })
  req.on('end', () => {
    pedidos.push(JSON.parse(corpo))
    if (proxima.status !== 200) {
      res.writeHead(proxima.status, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'deu ruim' }))
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: proxima.texto }] } }] }))
  })
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
process.env.IA_AUDIO_ENDPOINT = `http://127.0.0.1:${srv.address().port}/gerar`

const { transcrever, audioDisponivel, MAX_AUDIO_BYTES } = await import('../src/ia-audio.js')

const audio = Buffer.from('isto faz de conta que e um audio')

// ── O caminho normal ───────────────────────────────────────────────────
{
  const t = await transcrever({ arquivo: audio, tipo: 'audio/ogg; codecs=opus' })
  ok('transcreve o que a pessoa falou', t === 'bom dia, sou pedreiro, tem vaga em bastos?')

  const p = pedidos.at(-1)
  ok('manda o áudio junto', Boolean(p.contents[0].parts[0].inline_data.data))
  ok('com o tipo que chegou do WhatsApp', p.contents[0].parts[0].inline_data.mime_type.startsWith('audio/ogg'))
  ok('e pede só a transcrição', /Transcreva exatamente/.test(p.contents[0].parts[1].text))
  ok('sem deixar o modelo inventar', p.generationConfig.temperature === 0)
}

// ── "(inaudível)" não é frase da pessoa ────────────────────────────────
{
  proxima = { status: 200, texto: '(inaudível)' }
  ok('áudio que não dá para entender vira nada', await transcrever({ arquivo: audio, tipo: 'audio/ogg' }) === null)
}

// ── Modelo fora do ar: tenta o reserva ─────────────────────────────────
{
  const antes = pedidos.length
  proxima = { status: 503, texto: '' }
  const t = await transcrever({ arquivo: audio, tipo: 'audio/ogg' })
  ok('nenhum modelo respondeu: devolve nada', t === null)
  ok('mas tentou os modelos reserva', pedidos.length - antes >= 2)
}

// ── Tamanho ────────────────────────────────────────────────────────────
{
  proxima = { status: 200, texto: 'oi' }
  const antes = pedidos.length
  const enorme = Buffer.alloc(MAX_AUDIO_BYTES + 1)
  ok('áudio grande demais é recusado', await transcrever({ arquivo: enorme, tipo: 'audio/ogg' }) === null)
  ok('  e nem chega a ser enviado', pedidos.length === antes)
  ok('o limite é configurável', MAX_AUDIO_BYTES === 1024 * 1024)
}

// ── Bordas ─────────────────────────────────────────────────────────────
ok('sem áudio, nada', await transcrever({ arquivo: null, tipo: 'audio/ogg' }) === null)
ok('áudio vazio, nada', await transcrever({ arquivo: Buffer.alloc(0), tipo: 'audio/ogg' }) === null)
ok('a chave manda no disponível', audioDisponivel())

// Encerra as conexoes ANTES de fechar o servidor.
//
// O `fetch` do Node mantem a conexao viva para reaproveitar; fechar o
// servidor e sair no mesmo instante, com socket ainda aberto, derruba o
// processo com uma checagem interna no Windows.
srv.closeAllConnections?.()
await new Promise(r => srv.close(r))
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
// Sem `process.exit`: os prazos de espera das chamadas ao modelo ainda estao
// pendentes, e encerrar a forca no meio deles derruba o processo no Windows.
// Marcando o codigo de saida, o Node termina sozinho quando tudo se resolve.
process.exitCode = falhas ? 1 : 0
