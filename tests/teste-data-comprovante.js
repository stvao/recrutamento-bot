/**
 * A data com que o gasto entra.
 *
 * Era sempre o dia do envio, e comprovante se manda depois: o recibo do dia
 * 30 mandado no dia 4 caía no mês seguinte. Agora vale, nesta ordem: a data
 * que a pessoa escreveu, a que a IA leu com confiança, e só então o dia do
 * envio.
 *
 * A IA aqui é de mentira: "lê" o que o próprio arquivo de teste traz dentro.
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASTA = mkdtempSync(join(tmpdir(), 'teste-data-'))
process.env.GASTOS_PENDENTES_DIR = PASTA
process.env.GASTOS_MEMORIA = join(PASTA, 'memoria-gastos.json')
process.env.GEMINI_API_KEY = 'chave-de-teste'
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
const emBrasilia = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ms))
const DIA = 24 * 60 * 60 * 1000
const hoje = emBrasilia(Date.now())
const diasAtras = (n) => emBrasilia(Date.now() - n * DIA)
/** "2026-10-30" → "30/10" */
const curta = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

const chamadas = []
let lancadosNoSistema = []
const srv = createServer((req, res) => {
  let corpo = ''
  req.on('data', c => { corpo += c })
  req.on('end', () => {
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }

    // A IA devolve o que o arquivo de teste traz dentro.
    if (req.url.startsWith('/ia')) {
      const dado = JSON.parse(corpo).contents[0].parts[0].inline_data.data
      const leitura = JSON.parse(Buffer.from(dado, 'base64').toString('utf8')).leitura
      return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({
        valor: 0, data: '', estabelecimento: '', categoria: '', documento: '', formaPagamento: '', confianca: 'baixa', observacao: '',
        ...leitura,
      }) }] } }] })
    }

    chamadas.push({ url: req.url, corpo })
    const campo = (n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null
    if (req.url.endsWith('/comprovantes/obras')) return json(200, { obras: OBRAS })
    if (req.url.includes('/comprovantes/lancados')) return json(200, { lancados: lancadosNoSistema })
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

const { tratar, _limparPendentes } = await import('../src/comprovantes/index.js')
const { _limparCacheObras } = await import('../src/comprovantes/obras-client.js')
const memoria = await import('../src/comprovantes/memoria.js')
const { acharData, interpretar } = await import('../src/comprovantes/lancamento.js')
const { dataDoGasto } = await import('../src/comprovantes/saida.js')

const base = { chat: '123@g.us', chatNome: 'Comprovantes', ehGrupo: true }
const espera = (ms) => new Promise(r => setTimeout(r, ms))

/** Um comprovante cuja "leitura" pela IA é a que se passar aqui. */
let nArq = 0
const cupom = (leitura = {}) => Buffer.from(JSON.stringify({ leitura, n: ++nArq }))

function pessoa(de) {
  chamadas.length = 0
  _limparPendentes()
  _limparCacheObras()
  memoria._limpar()
  lancadosNoSistema = []
  const ditos = []
  let n = 0
  const enviarResposta = async (t) => { ditos.push(t); return { id: `bot-${de}-${++n}` } }
  const guardar = (r) => { if (typeof r === 'string') ditos.push(r); return r }
  return {
    ditos,
    foto: async (texto, arquivo, enviadoEm) => guardar(await tratar({
      ...base, de, arquivo, nomeArquivo: 'c.jpg', tipo: 'image/jpeg',
      texto, idMensagem: `foto-${de}-${Math.random().toString(36).slice(2, 8)}`,
      enviadoEm, enviarResposta,
    })),
    diz: async (texto) => guardar(await tratar({
      ...base, de, texto, idMensagem: `t-${Math.random()}`, respondendoA: null, enviarResposta,
    })),
  }
}

const lancs = () => chamadas.filter(c => c.url.endsWith('/lancar'))
const caixa = () => chamadas.filter(c => c.url.endsWith('/receber'))
const campoDe = (corpo, n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null
const dataLancada = () => campoDe(lancs().at(-1)?.corpo ?? '', 'data')
const lancado = (p) => p.ditos.find(t => /aguardando sua aprovação/i.test(t)) ?? ''

// ── 1. A data lida no papel, quando a leitura é confiável ─────────────────
{
  const p = pessoa('5511900000201')
  await p.foto('haia cimento 250', cupom({ valor: 250, data: diasAtras(10), confianca: 'alta' }))
  ok('leitura de confiança alta: o gasto entra com a data do comprovante', dataLancada() === diasAtras(10))
  ok('e a confirmação diz a data usada', lancado(p).includes(`comprovante de ${curta(diasAtras(10))}`))
  ok('a memória guarda a mesma data', memoria.lancadosRecentes()[0]?.data === diasAtras(10))
}
{
  const p = pessoa('5511900000202')
  await p.foto('haia cimento 250', cupom({ valor: 250, data: diasAtras(10), confianca: 'media' }))
  ok('confiança média também vale', dataLancada() === diasAtras(10))
}
{
  const p = pessoa('5511900000203')
  await p.foto('haia cimento 250', cupom({ valor: 250, data: diasAtras(10), confianca: 'baixa' }))
  ok('confiança baixa: fica o dia do envio', dataLancada() === hoje)
  ok('e a confirmação não fala de data', !/comprovante de/i.test(lancado(p)))
}
// Sem valor legível a leitura inteira é de confiança baixa (regra do ia-visao).
{
  const p = pessoa('5511900000204')
  await p.foto('haia cimento 250', cupom({ data: diasAtras(10), confianca: 'alta' }))
  ok('data de uma leitura sem valor não é usada', dataLancada() === hoje)
}
{
  const p = pessoa('5511900000205')
  await p.foto('haia cimento 250', cupom({ valor: 250, data: diasAtras(2), confianca: 'alta' }))
  ok('dois dias de diferença: usa a data do comprovante', dataLancada() === diasAtras(2))
  ok('mas sem avisar — é o atraso normal', !/comprovante de/i.test(lancado(p)))
}
{
  const p = pessoa('5511900000206')
  await p.foto('haia cimento 250', cupom({ valor: 250, data: diasAtras(130), confianca: 'alta' }))
  ok('mais de 120 dias: é leitura errada, fica o dia do envio', dataLancada() === hoje)
}
{
  const p = pessoa('5511900000207')
  // O ia-visao tolera um dia de folga para o futuro; o lançamento não.
  await p.foto('haia cimento 250', cupom({ valor: 250, data: emBrasilia(Date.now() + DIA), confianca: 'alta' }))
  ok('data depois do envio não é usada', dataLancada() === hoje)
}

// ── 2. O que a pessoa escreveu ganha da imagem ────────────────────────────
{
  const p = pessoa('5511900000208')
  await p.foto(`haia cimento 250 dia ${curta(diasAtras(15))}`, cupom({ valor: 250, data: diasAtras(10), confianca: 'alta' }))
  ok('a data escrita na legenda ganha da lida', dataLancada() === diasAtras(15))
  ok('e é ela que aparece na confirmação', lancado(p).includes(`comprovante de ${curta(diasAtras(15))}`))
  ok('o valor não foi confundido com a data', campoDe(lancs()[0].corpo, 'valor') === '250')
}
{
  const p = pessoa('5511900000209')
  await p.foto('haia cimento', cupom())
  await espera(20)
  ok('sem valor, pergunta', p.ditos.some(t => /valor/i.test(t)))
  await p.diz(`250 dia ${curta(diasAtras(7))}`)
  await espera(20)
  ok('data escrita numa RESPOSTA também vale', dataLancada() === diasAtras(7))
}
{
  const p = pessoa('5511900000210')
  await p.foto('haia tubo 3/4 120', cupom())
  ok('"tubo 3/4" é medida, não 3 de abril', dataLancada() === hoje && campoDe(lancs()[0].corpo, 'valor') === '120')
}

// ── 3. Sem data nenhuma: o dia do envio, como sempre ──────────────────────
{
  const p = pessoa('5511900000211')
  const cincoDiasAtras = Date.now() - 5 * DIA
  await p.foto('haia cimento 250', cupom(), cincoDiasAtras)
  ok('sem data escrita nem lida, vale o dia em que foi mandado', dataLancada() === emBrasilia(cincoDiasAtras))
  ok('e não há o que avisar', !/comprovante de/i.test(lancado(p)))
}

// ── 4. A caixa recebe a mesma data ────────────────────────────────────────
{
  const p = pessoa('5511900000212')
  await p.foto(`material de limpeza dia ${curta(diasAtras(9))}`, cupom())
  await espera(20)
  await p.diz('cancelar')
  await espera(20)
  ok('foi para a caixa', caixa().length === 1)
  ok('com a data que o lançamento usaria', campoDe(caixa()[0].corpo, 'data') === diasAtras(9))
}

// ── 5. A comparação com o sistema usa a data do gasto ─────────────────────
{
  const p = pessoa('5511900000213')
  lancadosNoSistema = [{ origem: 'gasto', obra: 'EE/ETEC AGUIA DE HAIA', valor: 320, data: diasAtras(12), descricao: 'areia', documento: null, arquivoHash: null, status: 'APROVADO' }]
  await p.foto(`haia areia 320 dia ${curta(diasAtras(12))}`, cupom())
  await espera(20)
  ok('gasto digitado à mão com a mesma data escrita gera pergunta',
    p.ditos.some(t => /outro pagamento, ou é o mesmo/i.test(t)) && lancs().length === 0)
}
// E a pergunta de repetido mostra a data do gasto, não a de quando entrou.
{
  const p = pessoa('5511900000214')
  await p.foto(`haia cimento 250 dia ${curta(diasAtras(20))}`, cupom())
  await p.foto('haia cimento 250', cupom())
  await espera(20)
  const d = diasAtras(20)
  ok('a pergunta de repetido diz a data do gasto',
    p.ditos.some(t => t.includes(`com data de ${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}`)))
}

// ── 6. As regras, direto ──────────────────────────────────────────────────
{
  const agora = new Date('2026-11-23T15:00:00Z')
  const d = (t) => acharData(t, agora).data
  ok('"dia 30/10"', d('pago dia 30/10') === '2026-10-30')
  ok('"30/10/2026"', d('cimento 30/10/2026') === '2026-10-30')
  ok('"30/10/26"', d('30/10/26') === '2026-10-30')
  ok('"05/09" sem rótulo, mês em dois dígitos', d('areia 05/09') === '2026-09-05')
  ok('"dia 3/8" com rótulo', d('dia 3/8') === '2026-08-03')
  ok('"3/4", "1/2", "3/8" soltos são medida', d('tubo 3/4') === null && d('joelho 1/2') === null && d('barra 3/8') === null)
  ok('data que não existe não vale', d('31/02') === null)
  ok('data no futuro não vale', d('25/12/2026') === null)
  ok('sem ano e longe demais: é engano', d('30/12') === null)
  ok('com ano, até um ano atrás vale', d('30/12/2025') === '2025-12-30')
  ok('mais de um ano atrás não vale', d('01/01/2024') === null)
  ok('havendo duas, vale a última', d('dia 01/11, na verdade 02/11') === '2026-11-02')
  ok('hora e valor não são data', d('as 14:30') === null && d('1.250,00') === null)
  ok('virada de ano: "30/12" escrito em janeiro é do ano anterior',
    acharData('dia 30/12', new Date('2027-01-04T15:00:00Z')).data === '2026-12-30')
  ok('interpretar devolve a data escrita', interpretar(`haia cimento 250 dia ${curta(diasAtras(5))}`, OBRAS).data === diasAtras(5))
  ok('e nada quando não há', interpretar('haia cimento 250', OBRAS).data === null)

  const envio = Date.parse('2026-11-23T15:00:00Z')
  const g = (dados) => dataDoGasto({ enviadoEm: envio }, dados)
  ok('escrita ganha da lida', g({ dataEscrita: '2026-11-01', dataComprovante: '2026-11-10', confiancaLeitura: 'alta' }) === '2026-11-01')
  ok('lida com confiança alta', g({ dataComprovante: '2026-11-10', confiancaLeitura: 'alta' }) === '2026-11-10')
  ok('lida com confiança baixa: dia do envio', g({ dataComprovante: '2026-11-10', confiancaLeitura: 'baixa' }) === '2026-11-23')
  ok('exatamente 120 dias ainda vale', g({ dataComprovante: '2026-07-26', confiancaLeitura: 'alta' }) === '2026-07-26')
  ok('121 dias já não', g({ dataComprovante: '2026-07-25', confiancaLeitura: 'alta' }) === '2026-11-23')
  ok('sem nada: dia do envio', g({}) === '2026-11-23' && g(null) === '2026-11-23')
}

_limparPendentes()
srv.close()
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
