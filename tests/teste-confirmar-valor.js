/**
 * Valor lido da imagem com leitura insegura: confirma antes de lançar.
 *
 * Antes, sem valor digitado, o que a IA lia era lançado mesmo com confiança
 * baixa, só com um aviso para conferir na aprovação — e 1.500 lido onde era
 * 1.800 passava. Agora só a leitura de confiança ALTA entra direto; média e
 * baixa viram pergunta a quem tem o papel na mão.
 *
 * A IA aqui é de mentira: "lê" o que o próprio arquivo de teste traz dentro.
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASTA = mkdtempSync(join(tmpdir(), 'teste-confirmar-valor-'))
process.env.GASTOS_PENDENTES_DIR = PASTA
process.env.GASTOS_MEMORIA = join(PASTA, 'memoria-gastos.json')
process.env.GEMINI_API_KEY = 'chave-de-teste'
process.env.GASTOS_AUTORIZADOS = '*'
process.env.GASTOS_GRUPOS = '123@g.us'
process.env.OBRAS_API_TOKEN = 'token-de-teste'
process.env.GASTOS_ESPERA_DESCRICAO_MS = '50'
// Curtos, para o último caso ver a ronda lembrar e desistir. Não atrapalham
// os anteriores: a ronda só é ligada lá no fim.
process.env.GASTOS_COBRAR_APOS_MS = '80'
process.env.GASTOS_DESISTIR_APOS_MS = '300'
process.env.GASTOS_RONDA_MS = '40'

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

const OBRAS = ['EE PROFA TSUYA OHNO KIMURA', 'EE/ETEC AGUIA DE HAIA']

const chamadas = []
/** Os sócios que o sistema devolve — com eles, existe a pergunta "quem pagou?". */
let pagadores = []
const srv = createServer((req, res) => {
  let corpo = ''
  req.on('data', c => { corpo += c })
  req.on('end', () => {
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }

    if (req.url.startsWith('/ia')) {
      const dado = JSON.parse(corpo).contents[0].parts[0].inline_data.data
      let leitura = {}
      try { leitura = JSON.parse(Buffer.from(dado, 'base64').toString('utf8')).leitura ?? {} } catch { /* arquivo que não é de teste */ }
      return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({
        valor: 0, data: '', estabelecimento: '', categoria: '', documento: '', formaPagamento: '', confianca: 'baixa', observacao: '',
        ...leitura,
      }) }] } }] })
    }

    chamadas.push({ url: req.url, corpo })
    const campo = (n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null
    if (req.url.endsWith('/comprovantes/obras')) return json(200, { obras: OBRAS, pagadores })
    if (req.url.includes('/comprovantes/lancados')) return json(200, { lancados: [] })
    if (req.url.endsWith('/comprovantes/lancar')) {
      const obra = campo('obra')
      return json(201, { ok: true, id: 'g1', obra, obras: [obra], mensagem: `Lançado em ${obra}, aguardando sua aprovação.` })
    }
    json(201, { ok: true, id: 'c1', mensagem: 'Comprovante recebido.', pendentes: 1 })
  })
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const URL_BASE = `http://127.0.0.1:${srv.address().port}`
process.env.OBRAS_API_URL = URL_BASE
process.env.IA_VISAO_ENDPOINT = `${URL_BASE}/ia`

const { tratar, iniciarRonda, _limparPendentes } = await import('../src/comprovantes/index.js')
const { _limparCacheObras } = await import('../src/comprovantes/obras-client.js')
const memoria = await import('../src/comprovantes/memoria.js')
const { CONFIRMA_VALOR, NEGA_VALOR } = await import('../src/comprovantes/perguntas.js')

const base = { chat: '123@g.us', chatNome: 'Comprovantes', ehGrupo: true }
const espera = (ms) => new Promise(r => setTimeout(r, ms))

let nArq = 0
const cupom = (leitura = {}) => Buffer.from(JSON.stringify({ leitura, n: ++nArq }))

function pessoa(de, { socios = [] } = {}) {
  chamadas.length = 0
  _limparPendentes()
  _limparCacheObras()
  memoria._limpar()
  pagadores = socios
  const ditos = []
  let n = 0
  const enviarResposta = async (t) => { ditos.push(t); return { id: `bot-${de}-${++n}` } }
  const guardar = (r) => { if (typeof r === 'string') ditos.push(r); return r }
  return {
    de,
    ditos,
    enviarResposta,
    foto: async (texto, arquivo) => guardar(await tratar({
      ...base, de, arquivo, nomeArquivo: 'c.jpg', tipo: 'image/jpeg',
      texto, idMensagem: `foto-${de}-${Math.random().toString(36).slice(2, 8)}`,
      enviarResposta,
    })),
    diz: async (texto) => guardar(await tratar({
      ...base, de, texto, idMensagem: `t-${Math.random()}`, respondendoA: null, enviarResposta,
    })),
  }
}

const lancs = () => chamadas.filter(c => c.url.endsWith('/lancar'))
const caixa = () => chamadas.filter(c => c.url.endsWith('/receber'))
const campoDe = (corpo, n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null
const confirmacoes = (p) => p.ditos.filter(t => /no comprovante\. Confirma\?/i.test(t))
const lancado = (p) => p.ditos.find(t => /aguardando sua aprovação/i.test(t)) ?? ''

// ── 1. Confiança ALTA: lança como antes, com o aviso ──────────────────────
{
  const p = pessoa('5511900000301')
  await p.foto('haia cimento', cupom({ valor: 187.5, confianca: 'alta' }))
  ok('leitura de confiança alta lança direto', lancs().length === 1 && confirmacoes(p).length === 0)
  ok('com o valor lido', campoDe(lancs()[0].corpo, 'valor') === '187.5')
  ok('e o aviso de conferir continua', /li da imagem/i.test(lancado(p)))
}

// ── 2. Confiança MÉDIA ou BAIXA: pergunta antes ───────────────────────────
for (const confianca of ['media', 'baixa']) {
  const p = pessoa(`55119000003${confianca === 'media' ? '02' : '03'}`)
  await p.foto('haia cimento', cupom({ valor: 187.5, confianca }))
  await espera(20)
  ok(`confiança ${confianca}: pergunta antes de lançar`, confirmacoes(p).length === 1 && lancs().length === 0)
  ok(`confiança ${confianca}: a pergunta mostra o valor lido`, confirmacoes(p)[0].includes('R$ 187,50'))
  ok(`confiança ${confianca}: e o que já entendeu`, /Anotei: .*AGUIA DE HAIA/i.test(confirmacoes(p)[0]))
  ok(`confiança ${confianca}: nada foi para a caixa`, caixa().length === 0)

  await p.diz('sim')
  await espera(20)
  ok(`confiança ${confianca}: "sim" lança`, lancs().length === 1 && campoDe(lancs()[0].corpo, 'valor') === '187.5')
  ok(`confiança ${confianca}: confirmado, conta como digitado — sem aviso`, !/li da imagem/i.test(lancado(p)))
  ok(`confiança ${confianca}: e sem a observação de "confira" no sistema`, campoDe(lancs()[0].corpo, 'observacao') === null)
  ok(`confiança ${confianca}: perguntou uma vez só`, confirmacoes(p).length === 1)
}

// ── 3. Um número na resposta substitui o valor lido ───────────────────────
{
  const p = pessoa('5511900000304')
  await p.foto('haia cimento', cupom({ valor: 1500, confianca: 'baixa' }))
  await espera(20)
  await p.diz('1800')
  await espera(20)
  ok('o valor mandado na resposta é o que entra', lancs().length === 1 && campoDe(lancs()[0].corpo, 'valor') === '1800')
  ok('e é digitado: sem aviso', !/li da imagem/i.test(lancado(p)))
}
{
  const p = pessoa('5511900000305')
  await p.foto('haia cimento', cupom({ valor: 1500, confianca: 'baixa' }))
  await espera(20)
  await p.diz('1.800,00')
  await espera(20)
  ok('valor com cara de dinheiro na resposta', campoDe(lancs()[0]?.corpo ?? '', 'valor') === '1800')
}

// ── 4. "não" não é informação: pergunta de novo, e não suja a descrição ───
{
  const p = pessoa('5511900000306')
  await p.foto('haia cimento', cupom({ valor: 1500, confianca: 'baixa' }))
  await espera(20)
  await p.diz('não')
  await espera(20)
  ok('"não" não lança', lancs().length === 0)
  ok('e a pergunta volta', confirmacoes(p).length === 2)
  await p.diz('150')
  await espera(20)
  ok('o valor certo, mandado depois, lança', campoDe(lancs()[0]?.corpo ?? '', 'valor') === '150')
  ok('e "não" não foi parar na descrição', !/n[aã]o/i.test(campoDe(lancs()[0]?.corpo ?? '', 'descricao') ?? ''))
}

// ── 5. Valor digitado ganha da imagem — e não há o que confirmar ──────────
{
  const p = pessoa('5511900000307')
  await p.foto('haia cimento 250', cupom({ valor: 999, confianca: 'baixa' }))
  ok('com valor na legenda, não pergunta', confirmacoes(p).length === 0 && lancs().length === 1)
  ok('e vale o digitado', campoDe(lancs()[0].corpo, 'valor') === '250')
}

// ── 6. Falta o valor INTEIRO: uma pergunta só ─────────────────────────────
{
  const p = pessoa('5511900000308')
  await p.foto('haia cimento', cupom())                 // a IA não leu valor
  await espera(20)
  ok('pergunta o valor, do jeito de sempre', p.ditos.some(t => /Qual foi o \*valor\*/i.test(t)))
  ok('e não a confirmação', confirmacoes(p).length === 0)
  await p.diz('320')
  await espera(20)
  ok('respondido, lança sem segunda pergunta', lancs().length === 1 && confirmacoes(p).length === 0)
}

// ── 7. Falta a obra E o valor é inseguro: primeiro a obra, depois o valor ──
{
  const p = pessoa('5511900000309')
  await p.foto('cimento', cupom({ valor: 90, confianca: 'media' }))
  await espera(20)
  ok('primeiro pergunta a obra', p.ditos.some(t => /obra/i.test(t)) && confirmacoes(p).length === 0)
  await p.diz('2')                                       // escolhe a obra 2 da lista
  await espera(20)
  ok('obra resolvida, aí confirma o valor', confirmacoes(p).length === 1 && lancs().length === 0)

  // O cuidado com "3": a lista de obras ainda existia, e um valor de um
  // dígito trocaria a obra que acabou de ser escolhida.
  await p.diz('3')
  await espera(20)
  ok('"3" na confirmação é R$ 3,00', campoDe(lancs()[0]?.corpo ?? '', 'valor') === '3')
  ok('e a obra continua a escolhida', campoDe(lancs()[0]?.corpo ?? '', 'obra') === OBRAS[1])
}

// ── 8. A ordem: valor, depois "quem pagou", depois repetido ───────────────
{
  const p = pessoa('5511900000310', { socios: ['Ana', 'Beto'] })
  await p.foto('haia cimento', cupom({ valor: 75, confianca: 'baixa' }))
  await espera(20)
  ok('com sócios cadastrados, a confirmação do valor vem primeiro',
    confirmacoes(p).length === 1 && !p.ditos.some(t => /quem pagou/i.test(t)))
  await p.diz('isso')
  await espera(20)
  ok('confirmado, aí pergunta quem pagou', p.ditos.some(t => /quem pagou/i.test(t)) && lancs().length === 0)
  await p.diz('1')
  await espera(20)
  ok('e lança com o sócio', lancs().length === 1 && campoDe(lancs()[0].corpo, 'pagoPor') === 'Ana')
  ok('"1" foi o sócio, não o valor', campoDe(lancs()[0].corpo, 'valor') === '75')
}
{
  const p = pessoa('5511900000311')
  await p.foto('haia cimento 75', cupom())
  ok('um gasto de 75 já lançado', lancs().length === 1)
  await p.foto('haia cimento', cupom({ valor: 75, confianca: 'media' }))
  await espera(20)
  ok('o segundo confirma o valor antes de desconfiar de repetido',
    confirmacoes(p).length === 1 && !p.ditos.some(t => /outro pagamento, ou é o mesmo/i.test(t)))
  await p.diz('ok')
  await espera(20)
  ok('confirmado o valor, aí vem a pergunta de repetido',
    p.ditos.some(t => /outro pagamento, ou é o mesmo/i.test(t)) && lancs().length === 1)
}

// ── 9. As formas de confirmar e de negar ──────────────────────────────────
{
  for (const t of ['sim', 'Sim!', 'isso', 'isso mesmo', 'é isso', 'confirma', 'confirmo', 'ok', 'certo', 'tá certo', 'está certo', 'exato', '👍']) {
    ok(`"${t}" confirma`, CONFIRMA_VALOR.test(t))
  }
  for (const t of ['1800', 'sim, 1800', 'não', 'haia', 'sim mas é de outra obra']) {
    ok(`"${t}" NÃO confirma`, !CONFIRMA_VALOR.test(t))
  }
  for (const t of ['não', 'nao', 'errado', 'tá errado', 'não é isso']) ok(`"${t}" nega`, NEGA_VALOR.test(t))
  ok('"não, é 1800" traz valor: não é só negativa', !NEGA_VALOR.test('não, é 1800'))
}

// ── 10. Sem resposta: um lembrete, depois a caixa com o valor de sugestão ──
{
  const p = pessoa('5511900000312')

  // Uma ficha do FORMATO ANTIGO no disco — gravada antes de existirem a
  // impressão digital, a confirmação de valor e a data escrita. Tem de ser
  // relida e seguir funcionando.
  const idAntigo = 'ficha-antiga-1'
  writeFileSync(join(PASTA, `${idAntigo}.bin`), Buffer.from('foto de antes'))
  writeFileSync(join(PASTA, `${idAntigo}.json`), JSON.stringify({
    id: idAntigo, chat: base.chat, de: '5511900000399', nomeArquivo: 'c.jpg', tipo: 'image/jpeg',
    descricao: 'haia cimento', respostas: [], idMensagem: idAntigo,
    enviadoEm: Date.now(), criadoEm: Date.now(), emDisco: true,
    jaPerguntou: true, perguntadoEm: Date.now(), ultimaPergunta: 'Qual foi o *valor*?',
    dados: { obra: OBRAS[1], valor: null },
  }), 'utf8')

  iniciarRonda()                                          // relê o disco e liga a ronda

  const antiga = { ...p, de: '5511900000399' }
  await tratar({ ...base, de: antiga.de, texto: '410', idMensagem: 't-antiga', respondendoA: null, enviarResposta: p.enviarResposta })
  await espera(30)
  ok('ficha antiga do disco é relida e responde', lancs().length === 1 && campoDe(lancs()[0].corpo, 'valor') === '410')
  ok('e ganha a impressão digital na hora de lançar', /^[0-9a-f]{64}$/.test(campoDe(lancs()[0].corpo, 'arquivoHash') ?? ''))

  await p.foto('haia cimento', cupom({ valor: 640, confianca: 'baixa' }))
  await espera(20)
  ok('perguntou o valor', confirmacoes(p).length === 1)

  await espera(200)
  ok('sem resposta, lembra uma vez', p.ditos.filter(t => /Lembrete/i.test(t)).length === 1)
  ok('e o lembrete repete a pergunta do valor', p.ditos.some(t => /Lembrete/i.test(t) && /Confirma\?/i.test(t)))

  await espera(350)
  ok('no prazo, vai para a caixa', caixa().length === 1)
  ok('sem ter sido lançado', lancs().length === 1)       // só o da ficha antiga
  ok('com o valor lido como sugestão', campoDe(caixa()[0].corpo, 'valor') === '640')
  ok('e o texto diz que não foi digitado', /valor lido da imagem/i.test(caixa()[0].corpo))
}

_limparPendentes()
srv.close()
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
