/**
 * O robô perguntando o que falta antes de lançar.
 *
 * É a diferença entre "comprovante numa caixa esperando alguém digitar" e
 * "lançamento pronto esperando um clique". Sem perguntar, todo comprovante
 * sem valor na legenda vira trabalho manual — e valor na legenda é
 * justamente o que as pessoas esquecem.
 *
 * Roda contra um sistema de obras de mentira, e SEM chave de IA: o que se
 * testa aqui é a decisão (lançar, perguntar, ou desistir para a caixa), não
 * a leitura da imagem.
 */
import { createServer } from 'node:http'

process.env.GEMINI_API_KEY = ''            // sem leitura de imagem, de propósito
process.env.GASTOS_AUTORIZADOS = '*'
process.env.GASTOS_GRUPOS = 'Comprovantes'
process.env.OBRAS_API_TOKEN = 'token-de-teste'
process.env.GASTOS_ESPERA_DESCRICAO_MS = '50'
process.env.GASTOS_ESPERA_RESPOSTA_MS = '300'

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

/** Sistema de obras de mentira. */
const chamadas = []
const srv = createServer((req, res) => {
  let corpo = ''
  req.on('data', c => { corpo += c })
  req.on('end', () => {
    chamadas.push({ url: req.url, corpo })

    if (req.url.endsWith('/comprovantes/obras')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ obras: ['Bastos Haia', 'Bastos Tsuya', 'Peruibe'] }))
    }
    if (req.url.endsWith('/comprovantes/lancar')) {
      const obra = /name="obra"\r?\n\r?\n([^\r]*)/.exec(corpo)?.[1] ?? ''
      if (!/bastos|peruibe/i.test(obra)) {
        res.writeHead(422, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ message: 'não achei', obras: ['Bastos Haia', 'Peruibe'] }))
      }
      res.writeHead(201, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, id: 'g1', obra: obra.trim(), mensagem: `Lançado em ${obra.trim()}, aguardando sua aprovação.` }))
    }
    // /receber — a caixa
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, id: 'c1', mensagem: 'Comprovante recebido.', pendentes: 1 }))
  })
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
process.env.OBRAS_API_URL = `http://127.0.0.1:${srv.address().port}`

const { tratar, _limparPendentes } = await import('./gastos.js')
const { _limparCacheObras } = await import('./obras-client.js')

const foto = Buffer.from('imagem-do-comprovante')
const base = { chat: '123@g.us', chatNome: 'Comprovantes', ehGrupo: true }
const espera = (ms) => new Promise(r => setTimeout(r, ms))

function novo(de) {
  chamadas.length = 0
  _limparPendentes()
  _limparCacheObras()
  const ditos = []
  return {
    ditos,
    foto: (texto, id) => tratar({
      ...base, de, arquivo: foto, nomeArquivo: 'c.jpg', tipo: 'image/jpeg',
      texto, idMensagem: id ?? `m-${Math.random()}`,
      enviarResposta: async (t) => { ditos.push(t) },
    }),
    diz: (texto) => tratar({
      ...base, de, texto, idMensagem: `t-${Math.random()}`,
      enviarResposta: async (t) => { ditos.push(t) },
    }),
  }
}

const rota = () => chamadas.map(c => c.url.replace(/^.*\/comprovantes\//, '')).filter(u => u !== 'obras')

// ── 1. Legenda completa: lança direto ─────────────────────────────────────
{
  const p = novo('5511900000001')
  const r = await p.foto('bastos haia, tijolos e areia, material, 2500,00')
  ok('lança direto quando não falta nada', r.includes('aguardando sua aprovação'))
  ok('e diz em qual obra', r.includes('Bastos Haia'))
  ok('e repete o valor entendido', r.includes('R$ 2.500,00'))
  ok('foi para /lancar, não para a caixa', rota().includes('lancar') && !rota().includes('receber'))
}

// ── 2. Falta o valor: PERGUNTA ────────────────────────────────────────────
{
  const p = novo('5511900000002')
  const r = await p.foto('bastos haia tijolos e areia')
  ok('pergunta o valor quando falta', /valor/i.test(r))
  ok('mostra o que já entendeu antes de perguntar', r.includes('Bastos Haia'))
  ok('e ainda NÃO enviou nada', rota().length === 0)

  const r2 = await p.diz('2500,00')
  ok('responder o valor faz lançar', r2.includes('aguardando sua aprovação'))
  ok('com o valor respondido', r2.includes('R$ 2.500,00'))
  ok('e a obra da legenda não se perdeu', r2.includes('Bastos Haia'))
}

// ── 3. Falta a obra: pergunta e oferece a lista ───────────────────────────
{
  const p = novo('5511900000003')
  const r = await p.foto('tijolos e areia 2500,00')
  ok('pergunta a obra quando falta', /obra/i.test(r))
  ok('oferece os nomes das obras do sistema', r.includes('Bastos Haia'))

  const r2 = await p.diz('bastos haia')
  ok('responder a obra faz lançar', r2.includes('aguardando sua aprovação'))
  ok('e o valor da legenda não se perdeu', r2.includes('R$ 2.500,00'))
}

// ── 4. Faltam os dois ─────────────────────────────────────────────────────
{
  const p = novo('5511900000004')
  const r = await p.foto('nota do fornecedor')
  ok('pergunta os dois de uma vez', /obra/i.test(r) && /valor/i.test(r))

  const r2 = await p.diz('peruibe 890')
  ok('uma resposta só resolve os dois', r2.includes('aguardando sua aprovação'))
  ok('acha a obra na resposta', r2.includes('Peruibe'))
  ok('acha o valor na resposta', r2.includes('R$ 890,00'))
}

// ── 5. Não respondeu: vai para a caixa, e AVISA ───────────────────────────
// Comprovante na caixa é pior que lançado, e muito melhor que perdido — e a
// pessoa precisa saber que aconteceu, senão acha que sumiu.
{
  const p = novo('5511900000005')
  const r = await p.foto('nota sem nada')
  ok('perguntou', /obra/i.test(r))

  await espera(500)   // estoura o prazo de resposta
  ok('passou o prazo e foi para a caixa', rota().includes('receber'))
  ok('e AVISOU que foi para a caixa', p.ditos.some(t => t.includes('📥')))
  ok('dizendo o que faltou', p.ditos.some(t => /Faltou/i.test(t)))
}

// ── 6. Desistir na hora ───────────────────────────────────────────────────
{
  const p = novo('5511900000006')
  await p.foto('nota qualquer')
  const r = await p.diz('deixa pra lá')
  ok('desistir manda para a caixa na hora', r.includes('📥'))
  ok('sem esperar o prazo', rota().includes('receber'))
}

// ── 7. O que NÃO deve virar resposta ──────────────────────────────────────
{
  const p = novo('5511900000007')
  ok('texto solto sem comprovante parado é ignorado', (await p.diz('bom dia pessoal')) === null)
}

// ── 8. Obra que o SISTEMA não reconhece ───────────────────────────────────
// Nossa lista pode estar velha. Quem manda no nome da obra é o sistema, e
// quando ele recusa, pergunta-se de novo com os nomes que ELE devolveu.
{
  const p = novo('5511900000008')
  const r = await p.foto('obra fantasma cimento 100')
  // "obra fantasma" não casa com a lista, então já pergunta antes de enviar
  ok('obra desconhecida vira pergunta', /obra/i.test(r))
}

// ── 9. Foto nova não deixa a anterior pendurada ───────────────────────────
{
  const p = novo('5511900000009')
  await p.foto('nota A')                       // fica perguntando
  const r = await p.foto('bastos haia cimento 300', 'm-B')
  ok('a foto nova é processada normalmente', r.includes('aguardando sua aprovação'))
  await espera(120)
  ok('e a anterior foi resolvida, não esquecida', rota().includes('receber'))
}

srv.close()
_limparPendentes()
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exitCode = falhas ? 1 : 0
