/**
 * O envio ao sistema de obras, contra um servidor de mentira.
 *
 * O caso que motivou este arquivo: o primeiro comprovante real tomou 400. O
 * robô manda `valor`, `data`, `categoria` e `obra` como campos extras, na
 * aposta de que um servidor que não os conhece os ignore — e o endpoint
 * validou estrito e recusou tudo. Um campo que era só bônus fez o
 * comprovante inteiro se perder.
 *
 * Aqui se prova que ele tenta de novo sem os extras, e que a idempotência
 * segue igual nas duas tentativas — senão a segunda criaria um lançamento
 * duplicado toda vez.
 */
import { createServer } from 'node:http'

process.env.OBRAS_API_TOKEN = 'token-de-teste'

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

/** Sobe um servidor que responde o que o teste mandar. */
function servidor(responder) {
  const recebidas = []
  const s = createServer((req, res) => {
    let corpo = ''
    req.on('data', c => { corpo += c })
    req.on('end', () => {
      const bruto = corpo
      recebidas.push({
        idempotencia: req.headers['idempotency-key'],
        autorizacao: req.headers.authorization,
        // Nome dos campos do multipart, sem depender de biblioteca.
        campos: [...bruto.matchAll(/name="([^"]+)"/g)].map(m => m[1]),
      })
      const r = responder(recebidas.length, bruto)
      res.writeHead(r.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(r.corpo ?? {}))
    })
  })
  return new Promise(resolve => {
    s.listen(0, '127.0.0.1', () => resolve({ porta: s.address().port, recebidas, fechar: () => s.close() }))
  })
}

const arquivo = Buffer.from('conteudo-do-comprovante')
const extras = { obra: 'Bastos Tsuya', valor: 2500, categoria: 'MATERIAL', data: '2026-09-01' }

// ── 1. Servidor que aceita tudo ───────────────────────────────────────────
{
  const srv = await servidor(() => ({ status: 201, corpo: { ok: true, id: 'uuid-1', mensagem: 'Comprovante recebido. Você tem 3 esperando lançamento.', pendentes: 3 } }))
  process.env.OBRAS_API_URL = `http://127.0.0.1:${srv.porta}`
  const { enviarComprovante, _esquecerDescoberta } = await import(`../src/obras-client.js?t=${Date.now()}`)
  _esquecerDescoberta()

  const r = await enviarComprovante({ arquivo, nomeArquivo: 'c.jpg', tipo: 'image/jpeg', texto: 'linha', idMensagem: 'wamid.1', extras })
  ok('envio aceito devolve ok', r.ok === true)
  ok('devolve a mensagem do servidor', r.mensagem?.includes('3 esperando'))
  ok('devolve os pendentes', r.pendentes === 3)
  ok('mandou uma vez só', srv.recebidas.length === 1)
  ok('mandou o arquivo', srv.recebidas[0].campos.includes('arquivo'))
  ok('mandou o texto', srv.recebidas[0].campos.includes('texto'))
  ok('mandou os campos estruturados', srv.recebidas[0].campos.includes('valor') && srv.recebidas[0].campos.includes('obra'))
  ok('mandou a Idempotency-Key', srv.recebidas[0].idempotencia === 'wamid.1')
  ok('mandou o token', srv.recebidas[0].autorizacao === 'Bearer token-de-teste')
  srv.fechar()
}

// ── 2. Servidor que RECUSA os campos extras — o caso real ─────────────────
{
  const srv = await servidor((n, corpo) => {
    const temExtras = /name="valor"/.test(corpo)
    if (temExtras) return { status: 400, corpo: { erro: 'campo desconhecido: valor' } }
    return { status: 201, corpo: { ok: true, id: 'uuid-2', mensagem: 'Comprovante recebido.', pendentes: 1 } }
  })
  process.env.OBRAS_API_URL = `http://127.0.0.1:${srv.porta}`
  const { enviarComprovante, _esquecerDescoberta } = await import(`../src/obras-client.js?t=${Date.now()}`)
  _esquecerDescoberta()

  const r = await enviarComprovante({ arquivo, nomeArquivo: 'c.jpg', tipo: 'image/jpeg', texto: 'linha', idMensagem: 'wamid.2', extras })
  ok('400 nos extras NÃO perde o comprovante', r.ok === true)
  ok('tentou duas vezes', srv.recebidas.length === 2)
  ok('a 1ª foi com os extras', srv.recebidas[0].campos.includes('valor'))
  ok('a 2ª foi SEM os extras', !srv.recebidas[1].campos.includes('valor'))
  ok('mas ainda com o arquivo', srv.recebidas[1].campos.includes('arquivo'))
  ok('e com o texto, que é onde a informação sobrevive', srv.recebidas[1].campos.includes('texto'))
  // A mesma chave nas duas: se a primeira tivesse passado, a segunda não
  // criaria um lançamento duplicado.
  ok('mesma Idempotency-Key nas duas', srv.recebidas[0].idempotencia === srv.recebidas[1].idempotencia)

  // Descoberto uma vez, não se repete: senão todo comprovante iria em dobro
  // e o limite de 30 por minuto chegaria na metade do tempo.
  const r2 = await enviarComprovante({ arquivo, nomeArquivo: 'c.jpg', tipo: 'image/jpeg', texto: 'linha', idMensagem: 'wamid.3', extras })
  ok('o 2º comprovante já vai sem extras', r2.ok === true && srv.recebidas.length === 3)
  ok('e sem tentar os extras de novo', !srv.recebidas[2].campos.includes('valor'))
  srv.fechar()
}

// ── 3. Erros que NÃO devem virar nova tentativa ───────────────────────────
{
  const srv = await servidor(() => ({ status: 401, corpo: { erro: 'token revogado' } }))
  process.env.OBRAS_API_URL = `http://127.0.0.1:${srv.porta}`
  const { enviarComprovante, _esquecerDescoberta } = await import(`../src/obras-client.js?t=${Date.now()}`)
  _esquecerDescoberta()

  const r = await enviarComprovante({ arquivo, nomeArquivo: 'c.jpg', tipo: 'image/jpeg', texto: 'x', idMensagem: 'wamid.4', extras })
  ok('401 não é reenviado', r.ok === false && srv.recebidas.length === 1)
  ok('401 devolve o status para a resposta certa', r.status === 401)
  ok('401 traz o motivo do servidor', String(r.motivo).includes('revogado'))
  srv.fechar()
}

// ── 4. O que nem sai daqui ────────────────────────────────────────────────
{
  const { enviarComprovante } = await import(`../src/obras-client.js?t=${Date.now()}`)
  const grande = await enviarComprovante({ arquivo: Buffer.alloc(21 * 1024 * 1024), tipo: 'image/jpeg', idMensagem: 'w5' })
  ok('arquivo acima de 20 MB não é enviado', grande.ok === false && grande.motivo === 'grande-demais')

  const vazio = await enviarComprovante({ arquivo: Buffer.alloc(0), tipo: 'image/jpeg', idMensagem: 'w6' })
  ok('arquivo vazio não é enviado', vazio.ok === false && vazio.motivo === 'arquivo-vazio')

  const audio = await enviarComprovante({ arquivo, tipo: 'audio/ogg', idMensagem: 'w7' })
  ok('tipo recusado não é enviado', audio.ok === false && audio.status === 400)
}

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
// exitCode em vez de exit(): os servidores de teste acabaram de fechar, e
// derrubar o processo no meio disso faz o libuv abortar no Windows.
process.exitCode = falhas ? 1 : 0
