/**
 * Quem mandou o comprovante — para o reembolso ir no nome certo.
 *
 * O gasto sem pagador é registrado pelo sistema como reembolso devido a
 * alguém. Antes era sempre ao dono do token do robô, que não gastou nada.
 * Agora o robô diz ao sistema o TELEFONE de quem mandou a mensagem, e o
 * sistema acha o usuário.
 *
 * O cuidado: em grupo o WhatsApp pode esconder o telefone atrás de um
 * "@lid". Dígitos de lid têm cara de telefone e não são de ninguém — não
 * podem ir no lugar.
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASTA = mkdtempSync(join(tmpdir(), 'teste-quem-mandou-'))
process.env.GASTOS_PENDENTES_DIR = PASTA
process.env.GASTOS_MEMORIA = join(PASTA, 'memoria-gastos.json')
process.env.GEMINI_API_KEY = ''
process.env.GASTOS_AUTORIZADOS = '*'
process.env.GASTOS_GRUPOS = '123@g.us'
process.env.OBRAS_API_TOKEN = 'token-de-teste'
process.env.GASTOS_ESPERA_DESCRICAO_MS = '50'

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

const OBRAS = ['EE PROFA TSUYA OHNO KIMURA', 'EE/ETEC AGUIA DE HAIA']
/** Os usuários do sistema que têm WhatsApp cadastrado. */
const CADASTRO = { 5511999990001: 'Carlos Mestre' }

const chamadas = []
let pagadores = []
/** Servidor que ainda não conhece `enviadoPor`: ignora o campo e não devolve nada. */
let servidorAntigo = false
/** Servidor antigo E estrito: 400 no campo desconhecido. */
let recusaCampoNovo = false

const srv = createServer((req, res) => {
  let corpo = ''
  req.on('data', c => { corpo += c })
  req.on('end', () => {
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    chamadas.push({ url: req.url, corpo })
    const campo = (n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null

    if (req.url.endsWith('/comprovantes/obras')) return json(200, { obras: OBRAS, pagadores })
    if (req.url.includes('/comprovantes/lancados')) return json(200, { lancados: [] })
    if (req.url.endsWith('/comprovantes/lancar')) {
      if (recusaCampoNovo && campo('enviadoPor') !== null) return json(400, { message: ['property enviadoPor should not exist'] })
      const obra = campo('obra')
      const resposta = { ok: true, id: 'g1', obra, obras: [obra], pagoPor: campo('pagoPor'), mensagem: `Lançado em ${obra}, aguardando sua aprovação.` }
      if (!servidorAntigo) resposta.enviadoPor = CADASTRO[campo('enviadoPor')] ?? null
      return json(201, resposta)
    }
    json(201, { ok: true, id: 'c1', mensagem: 'Comprovante recebido.', pendentes: 1 })
  })
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
process.env.OBRAS_API_URL = `http://127.0.0.1:${srv.address().port}`

const { tratar, iniciarRonda, _limparPendentes } = await import('../src/comprovantes/index.js')
const { _limparCacheObras, _esquecerDescoberta } = await import('../src/comprovantes/obras-client.js')
const memoria = await import('../src/comprovantes/memoria.js')

const base = { canal: 'whatsapp', chat: '123@g.us', chatNome: 'Comprovantes', ehGrupo: true }
const espera = (ms) => new Promise(r => setTimeout(r, ms))
let nFoto = 0
const foto = () => Buffer.from(`imagem-do-comprovante-${++nFoto}`)

function pessoa(de, { telefoneConhecido = true, socios = [] } = {}) {
  chamadas.length = 0
  _limparPendentes()
  _limparCacheObras()
  _esquecerDescoberta()
  memoria._limpar()
  pagadores = socios
  servidorAntigo = false
  recusaCampoNovo = false
  const ditos = []
  let n = 0
  const enviarResposta = async (t) => { ditos.push(t); return { id: `bot-${de}-${++n}` } }
  const guardar = (r) => { if (typeof r === 'string') ditos.push(r); return r }
  return {
    ditos,
    foto: async (texto) => guardar(await tratar({
      ...base, de, telefoneConhecido, arquivo: foto(), nomeArquivo: 'c.jpg', tipo: 'image/jpeg',
      texto, idMensagem: `foto-${de}-${Math.random().toString(36).slice(2, 8)}`, enviarResposta,
    })),
    diz: async (texto) => guardar(await tratar({
      ...base, de, telefoneConhecido, texto, idMensagem: `t-${Math.random()}`, respondendoA: null, enviarResposta,
    })),
  }
}

const lancs = () => chamadas.filter(c => c.url.endsWith('/lancar'))
const caixa = () => chamadas.filter(c => c.url.endsWith('/receber'))
const campoDe = (corpo, n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null
const lancado = (p) => p.ditos.find(t => /aguardando sua aprovação/i.test(t)) ?? ''

// ── 1. Telefone conhecido e cadastrado: o reembolso vai no nome da pessoa ──
{
  const p = pessoa('5511999990001')
  await p.foto('haia cimento 250')
  ok('manda o telefone de quem enviou', campoDe(lancs()[0]?.corpo ?? '', 'enviadoPor') === '5511999990001')
  ok('a confirmação diz de quem é o reembolso', /reembolso para Carlos Mestre/.test(lancado(p)))
}

// ── 2. Telefone conhecido, mas não cadastrado no sistema ──────────────────
{
  const p = pessoa('5511999990002')
  await p.foto('haia cimento 250')
  ok('manda o telefone mesmo assim', campoDe(lancs()[0]?.corpo ?? '', 'enviadoPor') === '5511999990002')
  ok('e avisa que o número não está cadastrado', /não está cadastrado no sistema/.test(lancado(p)) && /quem aprova/.test(lancado(p)))
  ok('sem prometer reembolso a ninguém', !/reembolso para/.test(lancado(p)))
}

// ── 3. @lid sem telefone conhecido: NADA vai no lugar ─────────────────────
{
  // Os dígitos de um lid: têm cara de número e não são telefone de ninguém.
  const p = pessoa('5511999990001', { telefoneConhecido: false })
  await p.foto('haia cimento 250')
  ok('lança normalmente', lancs().length === 1)
  ok('sem telefone conhecido, não manda `enviadoPor` — nem que os dígitos pareçam um', campoDe(lancs()[0].corpo, 'enviadoPor') === null)
  ok('e a confirmação não fala de reembolso nem de cadastro', !/reembolso|cadastrado/.test(lancado(p)))
}
{
  const p = pessoa('123456789012345')            // lid traduzido errado, ou número estrangeiro
  await p.foto('haia cimento 250')
  ok('o que não tem forma de telefone brasileiro não é mandado', campoDe(lancs()[0]?.corpo ?? '', 'enviadoPor') === null)
}
{
  // Telegram e afins não dizem `telefoneConhecido`: o `de` é um id, não um telefone.
  chamadas.length = 0
  _limparPendentes(); _limparCacheObras(); memoria._limpar(); pagadores = []
  await tratar({ chat: '123@g.us', ehGrupo: true, de: '5511999990001', arquivo: foto(), nomeArquivo: 'c.jpg', tipo: 'image/jpeg', texto: 'haia cimento 250', idMensagem: 'sem-canal-1' })
  ok('quem entrega a mensagem sem afirmar que é telefone: não manda', lancs().length === 1 && campoDe(lancs()[0].corpo, 'enviadoPor') === null)
}

// ── 4. Só quando o gasto ficou reembolsável ───────────────────────────────
{
  const p = pessoa('5511999990001', { socios: ['Ana', 'Beto'] })
  await p.foto('haia cimento 250 pago por Ana')
  ok('sócio pagou: vai o telefone, mas não se fala em reembolso',
    campoDe(lancs()[0]?.corpo ?? '', 'enviadoPor') === '5511999990001' && /pago por Ana/.test(lancado(p)) && !/reembolso/.test(lancado(p)))
}
{
  const p = pessoa('5511999990002', { socios: ['Ana', 'Beto'] })
  await p.foto('haia cimento 250')
  await espera(20)
  await p.diz('empresa')
  await espera(20)
  ok('empresa pagou: nem reembolso, nem aviso de cadastro',
    campoDe(lancs()[0]?.corpo ?? '', 'empresaPagou') === 'true' && !/reembolso|cadastrado/.test(lancado(p)))
}
{
  const p = pessoa('5511999990001', { socios: ['Ana', 'Beto'] })
  await p.foto('haia cimento 250')
  await espera(20)
  await p.diz('pular')
  await espera(20)
  ok('ninguém disse quem pagou: é reembolsável, e vai no nome de quem mandou', /reembolso para Carlos Mestre/.test(lancado(p)))
}

// ── 5. Servidor de versão anterior ────────────────────────────────────────
{
  const p = pessoa('5511999990001')
  servidorAntigo = true
  await p.foto('haia cimento 250')
  ok('servidor que não devolve o campo: lança, e nada se diz sobre reembolso', lancs().length === 1 && !/reembolso|cadastrado/.test(lancado(p)))
}
{
  const p = pessoa('5511999990001')
  recusaCampoNovo = true
  servidorAntigo = true
  const r = await p.foto('haia cimento 250')
  ok('servidor que recusa o campo: tenta sem ele e LANÇA', /aguardando sua aprovação/.test(r ?? '') && lancs().length === 2)
  ok('na segunda tentativa o campo não vai', campoDe(lancs()[1].corpo, 'enviadoPor') === null)
  ok('e nada foi para a caixa', caixa().length === 0)
}

// ── 6. A caixa também recebe ──────────────────────────────────────────────
{
  const p = pessoa('5511999990001')
  await p.foto('sem obra nem valor')
  await espera(20)
  await p.diz('cancelar')
  await espera(20)
  ok('na caixa vai o telefone de quem mandou', caixa().length === 1 && campoDe(caixa()[0].corpo, 'enviadoPor') === '5511999990001')
}
{
  const p = pessoa('5511999990001', { telefoneConhecido: false })
  await p.foto('sem obra nem valor')
  await espera(20)
  await p.diz('cancelar')
  await espera(20)
  ok('e sem telefone conhecido, não vai', caixa().length === 1 && campoDe(caixa()[0].corpo, 'enviadoPor') === null)
}

// ── 7. Ficha antiga em disco (sem o campo) continua sendo lida ────────────
{
  const p = pessoa('5511999990098')
  writeFileSync(join(PASTA, 'ficha-antiga-2.bin'), Buffer.from('foto de antes'))
  writeFileSync(join(PASTA, 'ficha-antiga-2.json'), JSON.stringify({
    id: 'ficha-antiga-2', chat: base.chat, de: '5511999990098', nomeArquivo: 'c.jpg', tipo: 'image/jpeg',
    descricao: 'haia cimento', respostas: [], idMensagem: 'ficha-antiga-2',
    enviadoEm: Date.now(), criadoEm: Date.now(), emDisco: true,
    jaPerguntou: true, perguntadoEm: Date.now(), ultimaPergunta: 'Qual foi o *valor*?',
    dados: { obra: OBRAS[1], valor: null },
  }), 'utf8')
  iniciarRonda()
  await p.diz('410')
  await espera(30)
  ok('ficha antiga, sem `enviadoPor`: lança sem o campo e sem falar de reembolso',
    lancs().length === 1 && campoDe(lancs()[0].corpo, 'enviadoPor') === null && !/reembolso|cadastrado/.test(lancado(p)))
}

_limparPendentes()
srv.close()
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
