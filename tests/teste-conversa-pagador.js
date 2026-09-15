/**
 * "Quem pagou?" — a pergunta que faltava.
 *
 * O sócio já era lido da legenda ("pago por Estevão"). O que não havia era
 * perguntar quando ninguém escreveu — e ninguém escreve, porque quem está na
 * obra manda a foto com três palavras e o polegar sujo de cimento.
 *
 * A regra que estes testes existem para proteger é a de que esta pergunta
 * NUNCA segura o lançamento. Obra e valor decidem SE o gasto entra; o sócio
 * decide só como ele fica registrado. Trocar um gasto lançado por um campo
 * preenchido seria mau negócio: o campo se completa na aprovação, o gasto
 * perdido não.
 */
import { createServer } from 'node:http'
import { rmSync } from 'node:fs'

const PASTA = './dados/teste-pendentes-pagador'
process.env.GASTOS_PENDENTES_DIR = PASTA
process.env.GEMINI_API_KEY = ''
process.env.GASTOS_AUTORIZADOS = '*'
process.env.GASTOS_GRUPOS = '123@g.us'
process.env.OBRAS_API_TOKEN = 'token-de-teste'
process.env.GASTOS_ESPERA_DESCRICAO_MS = '50'
process.env.GASTOS_COBRAR_APOS_MS = '10000'
// Curto de proposito, para o ultimo caso poder ver a ronda desistir. Nao
// atrapalha os anteriores: a ronda so e ligada la no fim.
process.env.GASTOS_DESISTIR_APOS_MS = '400'
process.env.GASTOS_RONDA_MS = '50'

rmSync(PASTA, { recursive: true, force: true })

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

const OBRAS = [
  { nome: 'EE/ETEC AGUIA DE HAIA', endereco: 'Av Aguia de Haia 500, Sao Paulo - SP' },
]

// Dois "João" de propósito: é o caso em que escolher seria pior que perguntar.
const SOCIOS = ['Estevao Bandeira', 'Joao Carlos Silva', 'Joao Pedro Lima']

const chamadas = []
const srv = createServer((req, res) => {
  let corpo = ''
  req.on('data', c => { corpo += c })
  req.on('end', () => {
    chamadas.push({ url: req.url, corpo })

    if (req.url.endsWith('/comprovantes/obras')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        obras: OBRAS.map(o => o.nome), detalhes: OBRAS, pagadores: SOCIOS,
      }))
    }

    if (req.url.endsWith('/comprovantes/lancar')) {
      const campo = (n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? ''
      res.writeHead(201, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        ok: true, id: 'g1', obra: campo('obra'),
        // O servidor devolve quem ficou como pagador — é isso que o robô
        // mostra na confirmação, e não o que ele achou que seria.
        pagoPor: campo('pagoPor') || null,
        mensagem: 'Lançado, aguardando sua aprovação.',
      }))
    }

    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, id: 'c1', mensagem: 'Comprovante recebido.' }))
  })
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
process.env.OBRAS_API_URL = `http://127.0.0.1:${srv.address().port}`

const { tratar, _limparPendentes } = await import('../src/gastos.js')
const { _limparCacheObras } = await import('../src/obras-client.js')
const memoria = await import('../src/memoria.js')

const foto = Buffer.from('imagem-do-comprovante')
const base = { chat: '123@g.us', chatNome: 'Comprovantes', ehGrupo: true }
const espera = (ms) => new Promise(r => setTimeout(r, ms))

function pessoa(de) {
  chamadas.length = 0
  _limparPendentes()
  _limparCacheObras()
  memoria._limpar()
  const ditos = []
  let n = 0
  const enviarResposta = async (t) => { ditos.push(t); return { id: `bot-${de}-${++n}` } }
  const guardar = (r) => { if (typeof r === 'string') ditos.push(r); return r }

  return {
    ditos,
    foto: async (texto) => guardar(await tratar({
      ...base, de, arquivo: foto, nomeArquivo: 'c.jpg', tipo: 'image/jpeg',
      texto, idMensagem: `foto-${de}-${Math.random().toString(36).slice(2, 8)}`,
      enviarResposta,
    })),
    diz: async (texto) => guardar(await tratar({
      ...base, de, texto, idMensagem: `t-${Math.random()}`, enviarResposta,
    })),
  }
}

/**
 * A última coisa que o robô disse.
 *
 * Pergunta sai por `enviarResposta` e o retorno vem null — de propósito, para
 * não mandar a mesma coisa duas vezes. Então o que se confere é sempre o que
 * ele FALOU, e não o que a função devolveu.
 */
const fala = (p) => p.ditos.at(-1) ?? ''

const lancados = () => chamadas.filter(c => c.url.includes('lancar'))
/** O que foi enviado no campo `pagoPor` do último lançamento. */
const pagadorEnviado = () => {
  const ultimo = lancados().at(-1)
  if (!ultimo) return null
  return /name="pagoPor"\r?\n\r?\n([^\r]*)/.exec(ultimo.corpo)?.[1] ?? null
}

// ── 1. Não escreveu quem pagou: PERGUNTA ──────────────────────────────────
{
  const p = pessoa('5511900000101')
  await p.foto('haia cimento 250')
  await espera(20)
  ok('pergunta quem pagou', /quem pagou/i.test(fala(p)))
  ok('mostra o que já entendeu', fala(p).includes('AGUIA DE HAIA') && fala(p).includes('R$ 250,00'))
  ok('lista os sócios numerados', fala(p).includes('1) Estevao Bandeira'))
  ok('oferece a saída', /pular/i.test(fala(p)))
  ok('e ainda NÃO lançou', lancados().length === 0)

  await p.diz('1')
  await espera(30)
  ok('responder o número lança', p.ditos.some(t => /aguardando sua aprova/i.test(t)))
  ok('com o sócio escolhido', pagadorEnviado() === 'Estevao Bandeira')
  ok('e confirma na resposta', p.ditos.some(t => t.includes('pago por Estevao Bandeira')))
}

// ── 2. Responde o NOME, sem olhar a lista ─────────────────────────────────
//
// É o que faz quem está na obra: responde "estevao", não "1".
{
  const p = pessoa('5511900000102')
  await p.foto('haia areia 300')
  await espera(20)
  await p.diz('estevao')
  await espera(30)
  ok('responder o nome também funciona', pagadorEnviado() === 'Estevao Bandeira')
}

// ── 3. Dois João: pergunta de novo, não chuta ─────────────────────────────
//
// Pôr o gasto no nome do sócio errado é problema de dinheiro entre sócios, e
// ninguém percebe olhando o relatório.
{
  const p = pessoa('5511900000103')
  await p.foto('haia tijolos 400')
  await espera(20)
  await p.diz('joao')
  await espera(20)
  ok('não escolhe entre dois João', !/aguardando sua aprova/i.test(fala(p)))
  ok('pergunta entre os dois', /Joao Carlos Silva/.test(fala(p)) && /Joao Pedro Lima/.test(fala(p)))
  ok('e ainda não lançou', lancados().length === 0)

  await p.diz('2')
  await espera(30)
  ok('o desempate resolve', pagadorEnviado() === 'Joao Pedro Lima')
}

// ── 4. "pular": lança SEM sócio ───────────────────────────────────────────
//
// Comprovante de material comprado pela empresa não foi bancado por sócio
// nenhum. Sem esta saída, a pessoa ficaria sem resposta possível.
{
  const p = pessoa('5511900000104')
  await p.foto('haia bomba de concreto 1400')
  await espera(20)
  await p.diz('pular')
  await espera(30)
  ok('pular lança assim mesmo', p.ditos.some(t => /aguardando sua aprova/i.test(t)))
  ok('e sem pagador', !pagadorEnviado())
}

// ── 5. Escreveu na legenda: NÃO pergunta ──────────────────────────────────
//
// Perguntar o que a pessoa acabou de escrever é a forma mais rápida de ela
// parar de escrever.
{
  const p = pessoa('5511900000105')
  await p.foto('haia cimento 250 pago por estevao')
  await espera(20)
  ok('não pergunta o que já foi dito', !/quem pagou/i.test(fala(p)))
  ok('lança direto', /aguardando sua aprova/i.test(fala(p)))
  ok('com o sócio da legenda', pagadorEnviado() === 'Estevao Bandeira')
}

// ── 6. Nome que não existe: lança sem segurar ─────────────────────────────
{
  const p = pessoa('5511900000106')
  await p.foto('haia cimento 250')
  await espera(20)
  await p.diz('fulano de tal')
  await espera(30)
  ok('nome desconhecido não segura o gasto', p.ditos.some(t => /aguardando sua aprova/i.test(t)))
  ok('e entra sem pagador', !pagadorEnviado())
}

// ── 7. Faltando obra E sócio: a obra vem primeiro ─────────────────────────
//
// Obra e valor decidem SE o gasto entra; o sócio, só como fica registrado.
// Perguntar os três de uma vez faria a pessoa responder um e esquecer o resto.
{
  const p = pessoa('5511900000107')
  await p.foto('cimento e areia')
  await espera(20)
  ok('pergunta a obra antes do sócio', /obra/i.test(fala(p)) && !/quem pagou/i.test(fala(p)))

  await p.diz('haia 250')
  await espera(30)
  ok('resolvida a obra, aí sim pergunta o sócio', p.ditos.some(t => /quem pagou/i.test(t)))

  await p.diz('estevao')
  await espera(30)
  ok('e então lança', pagadorEnviado() === 'Estevao Bandeira')
}

// ── 8. Ninguém responde: o gasto NÃO se perde ─────────────────────────────
//
// A regra mais importante do arquivo. Se esta pergunta pudesse segurar um
// comprovante para sempre, ela teria custado mais do que resolveu.
{
  const { _rodarRonda } = await import('../src/gastos.js')

  const p = pessoa('5511900000108')
  await p.foto('haia cimento 250')
  await espera(20)
  ok('está esperando o sócio', lancados().length === 0)
  ok('e perguntou', /quem pagou/i.test(fala(p)))

  // A pessoa some. O prazo estoura e o robô decide sozinho.
  await espera(450)      // passa do prazo de desistir
  await _rodarRonda()

  ok('LANÇOU assim mesmo', lancados().length === 1)
  ok('sem pagador', !pagadorEnviado())
  ok('e nÃO foi para a caixa', chamadas.filter(c => c.url.includes('receber')).length === 0)
  ok('avisando o que fez', p.ditos.some(t => /ninguém disse quem pagou/i.test(t)))
}

rmSync(PASTA, { recursive: true, force: true })
srv.close()

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
