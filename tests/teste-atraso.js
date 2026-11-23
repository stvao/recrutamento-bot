/**
 * O atraso — a leitura do grupo antigo a partir da conversa exportada.
 *
 * Os zips são montados aqui mesmo, nos dois formatos (Android e iPhone). Há
 * um sistema de obras de mentira e uma IA de mentira, que "lê" o que o
 * próprio arquivo de teste traz dentro. O que se confere:
 *
 *  - a conversa é lida certo, e o que não é comprovante fica de fora;
 *  - o zip é tratado como dado de fora;
 *  - no ENSAIO nada é escrito: nem lançamento, nem caixa, nem mensagem;
 *  - ligado, cada comprovante vai para o destino certo, as perguntas saem de
 *    5 em 5 e só no grupo de conversa, e rodar de novo não repete nada.
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'

const PASTA = mkdtempSync(join(tmpdir(), 'teste-atraso-'))
process.env.GASTOS_ATRASO_DIR = join(PASTA, 'atraso')
process.env.GASTOS_PENDENTES_DIR = join(PASTA, 'pendentes')
process.env.GASTOS_MEMORIA = join(PASTA, 'memoria-gastos.json')
process.env.GEMINI_API_KEY = 'chave-de-teste'
process.env.GASTOS_AUTORIZADOS = '*'
process.env.GASTOS_GRUPOS = '123@g.us'
process.env.GASTOS_ATRASO_GRUPO = '123@g.us'
process.env.OBRAS_API_TOKEN = 'token-de-teste'
process.env.GASTOS_ESPERA_DESCRICAO_MS = '50'
process.env.GASTOS_ATRASO_PAUSA_MS = '0'
process.env.GASTOS_ATRASO_TIQUE_MS = '25'
delete process.env.GASTOS_ATRASO
delete process.env.GASTOS_ATRASO_TOKEN

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

const OBRAS = ['EE PROFA TSUYA OHNO KIMURA', 'EE/ETEC AGUIA DE HAIA']
const GRUPO = '123@g.us'
const DIA = 24 * 60 * 60 * 1000
const emBrasilia = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ms))
const diasAtras = (n) => emBrasilia(Date.now() - n * DIA)
/** "2026-09-22" → "22/09/2026", como aparece na conversa exportada. */
const br = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
const sha = (b) => createHash('sha256').update(b).digest('hex')

// ── Um zip, montado à mão ─────────────────────────────────────────────────
function montarZip(arquivos) {
  const locais = []
  const centrais = []
  let posicao = 0
  for (const { nome, dados, comprimir } of arquivos) {
    const nomeB = Buffer.from(nome, 'utf8')
    const corpo = comprimir ? zlib.deflateRawSync(dados) : dados
    const crc = zlib.crc32 ? zlib.crc32(dados) : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(comprimir ? 8 : 0, 8); local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(corpo.length, 18); local.writeUInt32LE(dados.length, 22); local.writeUInt16LE(nomeB.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(comprimir ? 8 : 0, 10); central.writeUInt32LE(crc >>> 0, 16)
    central.writeUInt32LE(corpo.length, 20); central.writeUInt32LE(dados.length, 24); central.writeUInt16LE(nomeB.length, 28)
    central.writeUInt32LE(posicao, 42)
    locais.push(local, nomeB, corpo)
    centrais.push(central, nomeB)
    posicao += 30 + nomeB.length + corpo.length
  }
  const dir = Buffer.concat(centrais)
  const fim = Buffer.alloc(22)
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(arquivos.length, 8); fim.writeUInt16LE(arquivos.length, 10)
  fim.writeUInt32LE(dir.length, 12); fim.writeUInt32LE(posicao, 16)
  return Buffer.concat([...locais, dir, fim])
}

/** Uma "foto": começa como um JPEG de verdade e traz dentro o que a IA vai "ler". */
let nFoto = 0
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const foto = (leitura = {}) => Buffer.concat([JPEG, Buffer.from(JSON.stringify({ leitura, n: ++nFoto }))])

// ── O sistema de obras e a IA, de mentira ─────────────────────────────────
const chamadas = []
let lancadosNoSistema = []
let leiturasDaIA = 0
const srv = createServer((req, res) => {
  let corpo = ''
  req.on('data', c => { corpo += c })
  req.on('end', () => {
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }

    if (req.url.startsWith('/ia')) {
      leiturasDaIA++
      let leitura = {}
      try {
        const cru = Buffer.from(JSON.parse(corpo).contents[0].parts[0].inline_data.data, 'base64').toString('utf8')
        leitura = JSON.parse(cru.slice(cru.indexOf('{'))).leitura ?? {}
      } catch { /* arquivo que não é de teste */ }
      return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({
        valor: 0, data: '', estabelecimento: '', categoria: '', documento: '', formaPagamento: '', confianca: 'baixa', observacao: '',
        ...leitura,
      }) }] } }] })
    }

    chamadas.push({ url: req.url, metodo: req.method, corpo, chave: req.headers['idempotency-key'] ?? null })
    const campo = (n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null
    if (req.url.endsWith('/comprovantes/obras')) return json(200, { obras: OBRAS, pagadores: ['Ana', 'Beto'] })
    if (req.url.includes('/comprovantes/lancados')) return json(200, { lancados: lancadosNoSistema })
    if (req.url.endsWith('/comprovantes/lancar')) {
      const obra = campo('obra')
      return json(201, { ok: true, id: 'g1', obra, obras: [obra], pagoPor: campo('pagoPor'), mensagem: `Lançado em ${obra}, aguardando sua aprovação.` })
    }
    json(201, { ok: true, id: 'c1', mensagem: 'Comprovante recebido.', pendentes: 1 })
  })
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const URL_BASE = `http://127.0.0.1:${srv.address().port}`
process.env.OBRAS_API_URL = URL_BASE
process.env.IA_VISAO_ENDPOINT = `${URL_BASE}/ia`

const { tratar, _limparPendentes, registrarRotasDoAtraso, retomarAtraso, situacaoDoAtraso } = await import('../src/comprovantes/index.js')
const atraso = await import('../src/comprovantes/atraso.js')
const { _limparCacheObras } = await import('../src/comprovantes/obras-client.js')
const pendentes = await import('../src/comprovantes/pendentes.js')
const memoria = await import('../src/comprovantes/memoria.js')
const { lerConversa, comprovantesDaConversa, tipoReal, especieDoAnexo } = await import('../src/comprovantes/exportacao.js')
const { abrirZip, nomeBase } = await import('../src/comprovantes/zip.js')
const { classificar } = await import('../src/comprovantes/duplicata.js')

const espera = (ms) => new Promise(r => setTimeout(r, ms))
async function ate(condicao, prazo = 4000) {
  const fim = Date.now() + prazo
  while (Date.now() < fim) { if (condicao()) return true; await espera(10) }
  return condicao()
}

/** Tudo que o atraso disse, e para onde. */
const envios = []
let nEnvio = 0
atraso._usarEnvio(async (para, texto) => { envios.push({ para, texto, id: `msg-${++nEnvio}` }); return { ok: true, id: `msg-${nEnvio}` } })

const lancs = () => chamadas.filter(c => c.url.endsWith('/lancar'))
const caixa = () => chamadas.filter(c => c.url.endsWith('/receber'))
const campoDe = (corpo, n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null
const perguntas = () => envios.filter(e => /Do grupo antigo/.test(e.texto))
const resumos = () => envios.filter(e => /^📋/.test(e.texto))

function gravarZip(nome, arquivos) {
  const caminho = join(PASTA, nome)
  writeFileSync(caminho, montarZip(arquivos))
  return caminho
}

// ══ 1. A conversa exportada ═══════════════════════════════════════════════
{
  const android = [
    '21/09/2026 09:00 - As mensagens e ligações são protegidas com a criptografia de ponta a ponta.',
    '21/09/2026 10:00 - João Pedreiro: IMG-20260921-WA0001.jpg (arquivo anexado)',
    'antes do corte',
    '22/09/2026 14:03 - João Pedreiro: \u200eIMG-20260922-WA0002.jpg (arquivo anexado)',
    'haia cimento 250',
    'segunda linha da legenda',
    '22/09/2026 14:10 - Maria: IMG-20260922-WA0003.jpg (arquivo anexado)',
    '22/09/2026 14:11 - Maria: tsuya areia 90',
    '22/09/2026 15:00 - Maria: IMG-20260922-WA0004.jpg (arquivo anexado)',
    '22/09/2026 15:05 - Maria: isto veio cinco minutos depois',
    '22/09/2026 16:00 - Maria: Nota 4521.pdf (arquivo anexado)',
    '22/09/2026 16:01 - João Pedreiro: isto é de outra pessoa',
    '23/09/2026 08:00 - João Pedreiro: STK-20260923-WA0005.webp (arquivo anexado)',
    '23/09/2026 08:01 - João Pedreiro: PTT-20260923-WA0006.opus (arquivo anexado)',
    '23/09/2026 08:02 - João Pedreiro: VID-20260923-WA0007.mp4 (arquivo anexado)',
    '23/09/2026 08:03 - João Pedreiro: <Mídia oculta>',
    '23/09/2026 08:04 - João Pedreiro: contato.vcf (arquivo anexado)',
    '23/09/2026 08:05 - João Pedreiro: bom dia',
  ].join('\n')

  const msgs = lerConversa(android)
  ok('Android: aviso do sistema não vira mensagem', !msgs.some(m => /protegidas/.test(m.texto)))
  ok('Android: remetente e data lidos', msgs[1].remetente === 'João Pedreiro' && msgs[1].dia === '2026-09-22')
  ok('Android: a hora é a de Brasília', msgs[1].quando === Date.parse('2026-09-22T14:03:00-03:00'))

  const { comprovantes, ignorados } = comprovantesDaConversa(android, { desde: '2026-09-22' })
  ok('Android: quatro comprovantes depois do corte', comprovantes.length === 4)
  ok('Android: marca invisível antes do nome não atrapalha', comprovantes[0].arquivo === 'IMG-20260922-WA0002.jpg')
  ok('Android: legenda na mesma mensagem, com as linhas seguintes', comprovantes[0].legenda === 'haia cimento 250\nsegunda linha da legenda')
  ok('Android: texto do mesmo remetente logo depois vale como descrição', comprovantes[1].legenda === 'tsuya areia 90')
  ok('Android: depois de 2 minutos já não é descrição', comprovantes[2].legenda === '')
  ok('Android: texto de OUTRA pessoa não é descrição', comprovantes[3].legenda === '' && comprovantes[3].arquivo === 'Nota 4521.pdf')
  ok('Android: conta o que ficou de fora',
    ignorados.antesDoCorte === 1 && ignorados.figurinha === 1 && ignorados.audio === 1
    && ignorados.video === 1 && ignorados.midiaOmitida === 1 && ignorados.outro === 1)

  const iphone = [
    '[22/09/2026, 14:03:11] João Pedreiro: \u200e<anexado: 00000012-PHOTO-2026-09-22-14-03-11.jpg>',
    '[22/09/2026, 14:04:00] João Pedreiro: haia cimento 250',
    '[22/09/2026, 14:20:00] Maria: tsuya areia 90 \u200e<anexado: 00000013-PHOTO-2026-09-22-14-20-00.jpg>',
    '[22/09/2026, 14:21:00] Maria: \u200e<anexado: 00000014-AUDIO-2026-09-22-14-21-00.opus>',
    '[22/09/2026, 14:22:00] Maria: \u200efigurinha omitida',
    '[22/09/26, 14:23:00] Maria: \u200e<anexado: 00000015-Nota fiscal.pdf>',
  ].join('\r\n')
  const ip = comprovantesDaConversa(iphone, { desde: '2026-09-22' })
  ok('iPhone: três comprovantes', ip.comprovantes.length === 3)
  ok('iPhone: nome do arquivo de dentro do <anexado: …>', ip.comprovantes[0].arquivo === '00000012-PHOTO-2026-09-22-14-03-11.jpg')
  ok('iPhone: segundos na hora', ip.comprovantes[0].quando === Date.parse('2026-09-22T14:03:11-03:00'))
  ok('iPhone: texto logo depois vale como descrição', ip.comprovantes[0].legenda === 'haia cimento 250')
  ok('iPhone: legenda na mesma mensagem', ip.comprovantes[1].legenda === 'tsuya areia 90')
  ok('iPhone: ano com dois dígitos', ip.comprovantes[2].dia === '2026-09-22' && ip.comprovantes[2].arquivo === '00000015-Nota fiscal.pdf')
  ok('iPhone: áudio e figurinha omitida ficam de fora', ip.ignorados.audio === 1 && ip.ignorados.midiaOmitida === 1)

  ok('figurinha é reconhecida pelo nome', especieDoAnexo('STK-20260923-WA0005.webp') === 'figurinha')
  ok('tipo real: JPEG', tipoReal(foto()) === 'image/jpeg')
  ok('tipo real: PDF', tipoReal(Buffer.from('%PDF-1.7 conteudo do pdf')) === 'application/pdf')
  ok('tipo real: texto com nome de .jpg não passa', tipoReal(Buffer.from('isto nao e uma imagem de verdade')) === null)
}

// ══ 2. O zip é dado de fora ═══════════════════════════════════════════════
{
  const grande = Buffer.alloc(300000, 65)
  const caminho = gravarZip('seguranca.zip', [
    { nome: '../../fora/da/pasta.jpg', dados: foto() },
    { nome: 'pasta\\interna\\outra.jpg', dados: foto() },
    { nome: 'comprimido.txt', dados: Buffer.from('conteúdo comprimido '.repeat(50)), comprimir: true },
    { nome: 'bomba.bin', dados: grande, comprimir: true },
  ])
  const zip = abrirZip(caminho)
  ok('lista as entradas', zip.entradas.length === 4)
  ok('o nome nunca vira caminho: só o último pedaço', zip.entradas[0].base === 'pasta.jpg' && zip.entradas[1].base === 'outra.jpg')
  ok('nomeBase tira qualquer pasta', nomeBase('../../etc/passwd') === 'passwd' && nomeBase('C:\\x\\y.jpg') === 'y.jpg')
  ok('lê entrada comprimida', zip.ler(zip.entradas[2], 1e6).toString('utf8').startsWith('conteúdo comprimido'))
  let erro = null
  try { zip.ler(zip.entradas[3], 1000) } catch (e) { erro = e.message }
  ok('arquivo maior que o limite não é lido', erro === 'grande-demais')
  // O zip mente sobre o próprio tamanho: o limite vale durante a descompressão.
  let erro2 = null
  try { zip.ler({ ...zip.entradas[3], tamanho: 10 }, 1000) } catch (e) { erro2 = e.message }
  ok('nem quando o zip declara um tamanho pequeno', erro2 === 'grande-demais')
  zip.fechar()

  writeFileSync(join(PASTA, 'nao-e-zip.zip'), 'isto não é um zip')
  let erro3 = null
  try { abrirZip(join(PASTA, 'nao-e-zip.zip')) } catch (e) { erro3 = e.message }
  ok('arquivo que não é zip é recusado', /não é um arquivo zip/.test(erro3 ?? ''))
}

// ══ 3. A régua de repetido do atraso ══════════════════════════════════════
{
  const sistema = (x) => ({ doSistema: [{ obra: 'Obra A', valor: 100, data: '2026-10-10', documento: null, arquivoHash: null, status: 'APROVADO', ...x }] })
  const novo = (x) => ({ obra: 'Obra A', valor: 100, documento: null, datas: ['2026-10-11'], ...x })
  ok('mesmo documento e valor: já lançado', classificar(novo({ documento: '0555000' }), sistema({ documento: '555000', obra: 'Obra B' }))?.grau === 'ja-lancado')
  ok('mesma obra, valor e data perto: provável', classificar(novo(), sistema())?.grau === 'provavel')
  ok('mesma obra e valor, data longe: dúvida', classificar(novo({ datas: ['2026-10-25'] }), sistema())?.motivo === 'data-distante')
  ok('mesma obra e valor, data longe demais: nada', classificar(novo({ datas: ['2026-12-25'] }), sistema()) === null)
  ok('outra obra, mesmo valor, data perto: dúvida', classificar(novo({ obra: 'Obra B' }), sistema())?.motivo === 'outra-obra')
  ok('outra obra, mesmo valor, data longe: nada', classificar(novo({ obra: 'Obra B', datas: ['2026-10-25'] }), sistema()) === null)
  ok('documentos diferentes nos dois lados: nada', classificar(novo({ documento: '111222' }), sistema({ documento: '333444' })) === null)
  ok('rejeitado não conta', classificar(novo(), sistema({ status: 'REJEITADO' })) === null)
  ok('valor diferente: nada', classificar(novo({ valor: 101 }), sistema()) === null)
}

// ══ 4. Desligado ══════════════════════════════════════════════════════════
{
  const zip = gravarZip('qualquer.zip', [{ nome: 'Conversa.txt', dados: Buffer.from('') }])
  const r = await atraso.iniciarAtraso({ zip })
  ok('sem GASTOS_ATRASO, não começa', r.ok === false && r.status === 409)
  ok('e retomar não faz nada', retomarAtraso() === false)
}

// ══ 5. ENSAIO: nada é escrito ═════════════════════════════════════════════
const D1 = diasAtras(30)
const D2 = diasAtras(29)
const CORTE = diasAtras(31)
{
  process.env.GASTOS_ATRASO = 'ensaio'
  _limparCacheObras()
  chamadas.length = 0
  envios.length = 0

  const fJaPorArquivo = foto()
  const fRepetidaNoZip = foto()
  lancadosNoSistema = [
    { origem: 'gasto', obra: OBRAS[1], valor: 60, data: D1, descricao: 'prego', documento: null, arquivoHash: sha(fJaPorArquivo), status: 'APROVADO' },
    { origem: 'conta', obra: OBRAS[0], valor: 80, data: D1, descricao: 'nota', documento: 'ABC1234', arquivoHash: null, status: 'PENDENTE' },
    { origem: 'gasto', obra: OBRAS[1], valor: 320, data: D1, descricao: 'areia digitada à mão', documento: null, arquivoHash: null, status: 'APROVADO' },
    { origem: 'gasto', obra: OBRAS[0], valor: 777, data: D1, descricao: 'tinta', documento: null, arquivoHash: null, status: 'APROVADO' },
  ]

  const linhas = [
    `${br(diasAtras(40))} 10:00 - João: IMG-0.jpg (arquivo anexado)`, 'haia antigo 10',
    `${br(D1)} 09:00 - João: IMG-1.jpg (arquivo anexado)`, 'haia cimento 250',
    `${br(D1)} 09:05 - João: IMG-2.jpg (arquivo anexado)`, 'haia prego 60',
    `${br(D1)} 09:10 - Maria: IMG-3.jpg (arquivo anexado)`, 'haia nota 80',
    `${br(D1)} 09:15 - Maria: IMG-4.jpg (arquivo anexado)`, 'haia areia 320',
    `${br(D1)} 09:20 - Maria: IMG-5.jpg (arquivo anexado)`, 'cimento 50',
    `${br(D1)} 09:25 - Maria: IMG-6.jpg (arquivo anexado)`, 'haia brita',
    `${br(D1)} 09:30 - Maria: IMG-7.jpg (arquivo anexado)`, 'haia tinta 777',
    `${br(D1)} 09:35 - Maria: IMG-8.jpg (arquivo anexado)`, 'haia repetida 33',
    `${br(D1)} 09:36 - Maria: IMG-9.jpg (arquivo anexado)`, 'haia repetida 33',
    `${br(D1)} 09:40 - Maria: IMG-10.jpg (arquivo anexado)`, 'haia falsa 12',
    `${br(D2)} 12:00 - João: IMG-11.jpg (arquivo anexado)`, 'haia almoço 45',
    `${br(D2)} 12:30 - Ana: IMG-12.jpg (arquivo anexado)`, 'haia almoço 45',
    `${br(D2)} 13:00 - Ana: IMG-13.jpg (arquivo anexado)`, 'sumiu do zip 10',
    `${br(D2)} 13:05 - Ana: PTT-1.opus (arquivo anexado)`,
    `${br(D2)} 13:06 - Ana: <Mídia oculta>`,
  ]
  const zip = gravarZip('android.zip', [
    { nome: 'Conversa do WhatsApp com Comprovantes.txt', dados: Buffer.from(linhas.join('\n')), comprimir: true },
    { nome: 'IMG-0.jpg', dados: foto() },
    { nome: 'IMG-1.jpg', dados: foto(), comprimir: true },
    { nome: 'IMG-2.jpg', dados: fJaPorArquivo },
    { nome: 'IMG-3.jpg', dados: foto({ valor: 80, documento: 'abc-1234', confianca: 'alta' }) },
    { nome: 'IMG-4.jpg', dados: foto() },
    { nome: 'IMG-5.jpg', dados: foto() },
    { nome: 'IMG-6.jpg', dados: foto({ valor: 640, confianca: 'baixa' }) },
    { nome: 'IMG-7.jpg', dados: foto() },
    { nome: 'IMG-8.jpg', dados: fRepetidaNoZip },
    { nome: 'IMG-9.jpg', dados: fRepetidaNoZip },
    { nome: 'IMG-10.jpg', dados: Buffer.from('nome de imagem, conteúdo de texto qualquer') },
    { nome: 'IMG-11.jpg', dados: foto() },
    { nome: 'IMG-12.jpg', dados: foto() },
    { nome: 'PTT-1.opus', dados: Buffer.from('audio') },
  ])

  const r = await atraso.iniciarAtraso({ zip, desde: CORTE })
  ok('ensaio começa', r.ok === true && r.modo === 'ensaio')
  await atraso._aguardar()

  ok('ENSAIO: nenhum lançamento', lancs().length === 0)
  ok('ENSAIO: nada na caixa', caixa().length === 0)
  ok('ENSAIO: nenhuma escrita no sistema, só leitura', chamadas.every(c => c.metodo === 'GET'))
  ok('ENSAIO: nenhuma mensagem em conversa nenhuma', envios.length === 0)
  ok('ENSAIO: nenhum comprovante guardado para esperar', pendentes.quantos() === 0)
  ok('ENSAIO: nada anotado na memória', memoria.lancadosRecentes().length === 0)

  const s = situacaoDoAtraso()
  ok('o relatório fica disponível', s.relatorio === '/comprovantes/atraso/relatorio.csv' && s.rodando === false)
  const csv = readFileSync(join(process.env.GASTOS_ATRASO_DIR, 'relatorio.csv'), 'utf8')
  const linhasCsv = csv.trim().split('\r\n').slice(1).map(l => l.slice(1, -1).split('";"'))
  const de = (arquivo) => linhasCsv.find(l => l[3] === arquivo) ?? []
  const DESTINO = 9
  const DETALHE = 10

  ok('relatório: uma linha por comprovante avaliado', linhasCsv.length === 10)
  ok('lançaria: tem obra e valor', de('IMG-1.jpg')[DESTINO] === 'lançaria' && de('IMG-1.jpg')[5] === OBRAS[1] && de('IMG-1.jpg')[6] === '250,00')
  ok('lançaria: diz de onde veio o valor e a data que usaria', de('IMG-1.jpg')[7] === 'digitado' && de('IMG-1.jpg')[8] === D1)
  ok('já lançado: mesmo arquivo', de('IMG-2.jpg')[DESTINO] === 'já lançado' && /mesmo arquivo/.test(de('IMG-2.jpg')[DETALHE]))
  ok('já lançado: mesmo documento e valor, mesmo em outra obra', de('IMG-3.jpg')[DESTINO] === 'já lançado' && /mesmo documento/.test(de('IMG-3.jpg')[DETALHE]))
  ok('e diz com qual lançamento bateu', /no sistema/.test(de('IMG-3.jpg')[DETALHE]) && /ABC1234/.test(de('IMG-3.jpg')[DETALHE]))
  ok('provável repetido: digitado à mão, mesma obra, valor e data', de('IMG-4.jpg')[DESTINO] === 'provável repetido' && /areia digitada/.test(de('IMG-4.jpg')[DETALHE]))
  ok('perguntaria: falta a obra', de('IMG-5.jpg')[DESTINO] === 'perguntaria' && /falta: obra/.test(de('IMG-5.jpg')[DETALHE]))
  ok('perguntaria: valor de leitura insegura', de('IMG-6.jpg')[DESTINO] === 'perguntaria' && /confirmar o valor/.test(de('IMG-6.jpg')[DETALHE])
    && /lido da imagem \(confiança baixa\)/.test(de('IMG-6.jpg')[7]))
  ok('perguntaria: mesmo valor em outra obra', de('IMG-7.jpg')[DESTINO] === 'perguntaria' && /dúvida de repetido/.test(de('IMG-7.jpg')[DETALHE]))
  ok('dois iguais no MESMO zip: o segundo é provável repetido do primeiro',
    de('IMG-11.jpg')[DESTINO] === 'lançaria' && de('IMG-12.jpg')[DESTINO] === 'provável repetido')
  ok('remetente e legenda vão no relatório', de('IMG-12.jpg')[2] === 'Ana' && de('IMG-12.jpg')[4] === 'haia almoço 45')

  ok('resumo: totais', /10 comprovante\(s\) avaliados/.test(s.resumo) && /3 seriam lançados \(R\$ 328,00\)/.test(s.resumo)
    && /2 já estão lançados/.test(s.resumo) && /2 parecem repetidos/.test(s.resumo) && /3 seriam perguntados/.test(s.resumo))
  ok('resumo: o que ficou de fora',
    /1 de antes do corte/.test(s.resumo) && /1 áudio/.test(s.resumo) && /1 com mídia omitida/.test(s.resumo)
    && /1 citado\(s\) na conversa sem o arquivo/.test(s.resumo) && /1 que não é imagem nem PDF/.test(s.resumo)
    && /1 arquivo\(s\) repetido\(s\) dentro do próprio zip/.test(s.resumo))
  ok('resumo: diz que nada foi feito', /Nada foi lançado nem perguntado/.test(s.resumo))
  ok('o resumo também fica em arquivo', existsSync(join(process.env.GASTOS_ATRASO_DIR, 'resumo.txt')))
}

// ══ 6. LIGADO ═════════════════════════════════════════════════════════════
const fNoSistema = foto()
const D3 = diasAtras(20)
let zipOn
{
  process.env.GASTOS_ATRASO = 'on'
  atraso._reiniciar()
  _limparCacheObras()
  chamadas.length = 0
  envios.length = 0
  leiturasDaIA = 0
  lancadosNoSistema = [
    { origem: 'gasto', obra: OBRAS[1], valor: 60, data: D3, descricao: 'prego', documento: null, arquivoHash: sha(fNoSistema), status: 'APROVADO' },
  ]

  // Formato do iPhone. Sete comprovantes sem obra: só cinco perguntas cabem.
  const linhas = [
    `[${br(D3)}, 09:00:00] João: \u200e<anexado: 00000001-PHOTO.jpg>`,
    `[${br(D3)}, 09:00:30] João: haia cimento 250`,
    `[${br(D3)}, 09:05:00] João: haia areia 90 pago por Ana \u200e<anexado: 00000002-PHOTO.jpg>`,
    `[${br(D3)}, 09:10:00] João: haia prego 60 \u200e<anexado: 00000003-PHOTO.jpg>`,
    ...[1, 2, 3, 4, 5, 6, 7].map(i => `[${br(D3)}, 10:0${i}:00] Maria: cimento 5${i} \u200e<anexado: 0000001${i}-PHOTO.jpg>`),
    `[${br(D3)}, 11:00:00] Maria: \u200efigurinha omitida`,
  ]
  zipOn = gravarZip('iphone.zip', [
    { nome: '_chat.txt', dados: Buffer.from(linhas.join('\r\n')) },
    { nome: '00000001-PHOTO.jpg', dados: foto() },
    { nome: '00000002-PHOTO.jpg', dados: foto() },
    { nome: '00000003-PHOTO.jpg', dados: fNoSistema },
    ...[1, 2, 3, 4, 5, 6, 7].map(i => ({ nome: `0000001${i}-PHOTO.jpg`, dados: foto() })),
  ])

  const r = await atraso.iniciarAtraso({ zip: zipOn, desde: CORTE })
  ok('ligado: começa', r.ok === true && r.modo === 'on' && r.comprovantes === 10)
  ok('uma leitura por vez', (await atraso.iniciarAtraso({ zip: zipOn, desde: CORTE })).status === 409)
  await ate(() => resumos().length === 1)

  ok('lança direto os que têm obra e valor', lancs().length === 2)
  const [l1, l2] = lancs()
  ok('como pago pela EMPRESA', campoDe(l1.corpo, 'empresaPagou') === 'true')
  ok('com a data da mensagem original, não a de hoje', campoDe(l1.corpo, 'data') === D3)
  ok('a descrição veio do texto mandado logo depois da foto', campoDe(l1.corpo, 'valor') === '250' && campoDe(l1.corpo, 'obra') === OBRAS[1])
  ok('chave de idempotência estável, pela impressão digital', /^atraso-[0-9a-f]{32}$/.test(l1.chave ?? ''))
  ok('"pago por Ana" na legenda ganha: vai o sócio, e não "empresa pagou"',
    campoDe(l2.corpo, 'pagoPor') === 'Ana' && campoDe(l2.corpo, 'empresaPagou') === null)
  ok('o que já está no sistema (mesmo arquivo) é pulado', !lancs().some(c => campoDe(c.corpo, 'valor') === '60'))

  ok('LOTE: só cinco perguntas saem', perguntas().length === 5)
  ok('cada pergunta diz de quando é, quem mandou e o que escreveu',
    perguntas().every(p => p.texto.includes(`Do grupo antigo — ${D3.slice(8, 10)}/${D3.slice(5, 7)} às 10:0`) && p.texto.includes('de Maria') && /"cimento 5\d"/.test(p.texto)))
  ok('e pergunta a obra', perguntas().every(p => /obra/i.test(p.texto)))
  ok('ninguém é perguntado "quem pagou?"', !envios.some(e => /quem pagou/i.test(e.texto)))
  ok('TUDO sai para o grupo de conversa, e só para ele', envios.length > 0 && envios.every(e => e.para === GRUPO))

  ok('UM resumo, quando todos os arquivos já passaram', resumos().length === 1)
  const resumo = resumos()[0].texto
  ok('resumo: lançados com o total', /2 lançado\(s\) \(R\$ 340,00\)/.test(resumo))
  ok('resumo: já estavam no sistema', /1 já estavam no sistema/.test(resumo))
  ok('resumo: esperando resposta (as 5 perguntadas e as 2 da fila)', /7 esperando resposta/.test(resumo))
  ok('resumo: na caixa', /0 na caixa/.test(resumo))
  ok('resumo: o que ficou de fora', /1 com mídia omitida/.test(resumo))
  ok('a IA leu cada arquivo uma vez só', leiturasDaIA === 9)
}

// ── Retomada: reinício no meio, e o mesmo zip mandado de novo ─────────────
{
  await atraso._parar()
  atraso._reiniciar()                       // como um reinício: só o disco sobra
  const antes = { lancs: lancs().length, envios: envios.length, ia: leiturasDaIA }

  ok('no arranque, retoma sozinho', retomarAtraso() === true)
  await espera(150)
  await atraso._parar()
  atraso._reiniciar()

  const r = await atraso.iniciarAtraso({ zip: zipOn, desde: CORTE })
  ok('o mesmo zip de novo é aceito', r.ok === true)
  await espera(150)

  ok('RETOMADA: não lança de novo', lancs().length === antes.lancs)
  ok('RETOMADA: não pergunta de novo nem repete o resumo', envios.length === antes.envios)
  ok('RETOMADA: não lê de novo com a IA', leiturasDaIA === antes.ia)
}

// ── As respostas, e o lote seguinte ───────────────────────────────────────
{
  const dono = { chat: GRUPO, chatNome: 'Comprovantes', ehGrupo: true, de: '5511988887777' }
  const ditos = []
  const responder = async (texto, citando) => {
    const r = await tratar({
      ...dono, texto, idMensagem: `r-${Math.random()}`, respondendoA: citando ?? null,
      enviarResposta: async (t) => { ditos.push(t); return { id: `resp-${ditos.length}` } },
    })
    if (typeof r === 'string') ditos.push(r)
    return r
  }

  const primeiras = perguntas().slice(0, 5)
  // Fora de ordem, citando: quem responde não é quem "mandou" o comprovante.
  for (const p of [primeiras[2], primeiras[0], primeiras[4], primeiras[1]]) await responder('haia', p.id)
  await espera(30)
  ok('respondidas citando, quatro são lançadas', lancs().length === 6)
  ok('também como pagas pela empresa', lancs().slice(2).every(c => campoDe(c.corpo, 'empresaPagou') === 'true'))
  ok('com o valor que estava na legenda original', lancs().slice(2).every(c => /^5\d$/.test(campoDe(c.corpo, 'valor') ?? '')))
  ok('enquanto o lote não fecha, o seguinte não sai', perguntas().length === 5)

  // A última do lote, sem citar: só há uma no ar, e a pessoa não tem nada próprio.
  await responder('haia')
  await ate(() => perguntas().length === 7)
  ok('a quinta, respondida sem citar, também é lançada', lancs().length === 7)
  ok('lote resolvido: saem as duas que estavam na fila', perguntas().length === 7)

  const ultimas = perguntas().slice(5)
  await responder('tsuya', ultimas[0].id)
  await responder('cancelar', ultimas[1].id)
  await atraso._aguardar()

  ok('uma lançada em outra obra', lancs().length === 8 && campoDe(lancs()[7].corpo, 'obra') === OBRAS[0])
  ok('"cancelar" manda para a caixa', caixa().length === 1)
  const s = situacaoDoAtraso()
  ok('terminou', s.rodando === false && Boolean(s.trabalho.terminadoEm))
  ok('contagem final', s.contagem.lancados === 8 && s.contagem.jaLancados === 1 && s.contagem.naCaixa === 1 && s.contagem.esperando === 0)
  ok('e o resumo continuou sendo UM só', resumos().length === 1)
  ok('nada foi dito fora do grupo de conversa', envios.every(e => e.para === GRUPO))
  ok('terminado, não há o que retomar', retomarAtraso() === false)

  // Depois de tudo: o mesmo zip mais uma vez não faz nada.
  const r = await atraso.iniciarAtraso({ zip: zipOn, desde: CORTE })
  await atraso._aguardar()
  ok('o zip inteiro de novo: nenhum lançamento, nenhuma pergunta', r.ok && lancs().length === 8 && perguntas().length === 7)
}

// ── Quem tem comprovante próprio esperando continua sendo atendido por ele ──
{
  atraso._reiniciar()
  _limparCacheObras()
  lancadosNoSistema = []
  const zip = gravarZip('um.zip', [
    { nome: '_chat.txt', dados: Buffer.from(`[${br(D3)}, 15:00:00] Maria: tijolo 71 \u200e<anexado: 00000091-PHOTO.jpg>`) },
    { nome: '00000091-PHOTO.jpg', dados: foto() },
  ])
  const nPerguntas = perguntas().length
  await atraso.iniciarAtraso({ zip, desde: CORTE })
  await ate(() => perguntas().length === nPerguntas + 1)

  const dono = { chat: GRUPO, chatNome: 'Comprovantes', ehGrupo: true, de: '5511988887777' }
  const ditos = []
  const enviarResposta = async (t) => { ditos.push(t); return { id: `d-${ditos.length}` } }
  const antes = lancs().length
  // A pessoa manda um comprovante dela, sem obra — e responde sem citar.
  await tratar({ ...dono, arquivo: foto(), nomeArquivo: 'c.jpg', tipo: 'image/jpeg', texto: 'parafuso 12', idMensagem: 'dia-a-dia-1', enviarResposta })
  await espera(20)
  await tratar({ ...dono, texto: 'tsuya', idMensagem: 'dia-a-dia-2', respondendoA: null, enviarResposta })
  await espera(20)
  // No dia a dia existe a pergunta "quem pagou?" — a do atraso é que não tem.
  ok('o comprovante do dia a dia continua perguntando quem pagou', ditos.some(x => /quem pagou/i.test(x)))
  await tratar({ ...dono, texto: 'pular', idMensagem: 'dia-a-dia-2b', respondendoA: null, enviarResposta })
  await espera(20)
  const novo = lancs().slice(antes)
  ok('resposta sem citação vai para o comprovante DA PESSOA, não para o do atraso',
    novo.length === 1 && campoDe(novo[0].corpo, 'valor') === '12' && campoDe(novo[0].corpo, 'empresaPagou') === null)
  // E citando a pergunta do atraso, vai para ele.
  await tratar({ ...dono, texto: 'haia', idMensagem: 'dia-a-dia-3', respondendoA: perguntas().at(-1).id, enviarResposta })
  await atraso._aguardar()
  ok('citando a pergunta do atraso, a resposta vai para ele',
    lancs().length === antes + 2 && campoDe(lancs().at(-1).corpo, 'valor') === '71' && campoDe(lancs().at(-1).corpo, 'empresaPagou') === 'true')
}

// ── Sem grupo aceito, não liga ────────────────────────────────────────────
{
  atraso._reiniciar()
  process.env.GASTOS_ATRASO_GRUPO = '999@g.us'
  const r = await atraso.iniciarAtraso({ zip: zipOn, desde: CORTE })
  ok('grupo de conversa fora de GASTOS_GRUPOS: não começa', r.ok === false && /GASTOS_GRUPOS/.test(r.motivo))
  process.env.GASTOS_ATRASO_GRUPO = GRUPO
  ok('data de corte torta: não começa', (await atraso.iniciarAtraso({ zip: zipOn, desde: '22/09/2026' })).status === 422)
  ok('zip que não existe: não começa', (await atraso.iniciarAtraso({ zip: join(PASTA, 'nao-existe.zip') })).status === 422)
}

// ══ 7. Pela rota HTTP ═════════════════════════════════════════════════════
{
  const { default: express } = await import('express')
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  registrarRotasDoAtraso(app)
  const http = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const base = `http://127.0.0.1:${http.address().port}`

  process.env.GASTOS_ATRASO = 'ensaio'
  atraso._reiniciar()
  _limparCacheObras()
  const corpoZip = montarZip([
    { nome: '_chat.txt', dados: Buffer.from(`[${br(D3)}, 15:00:00] Maria: haia telha 83 \u200e<anexado: 00000099-PHOTO.jpg>`) },
    { nome: '00000099-PHOTO.jpg', dados: foto() },
  ])

  const fora = await fetch(`${base}/comprovantes/atraso`, { headers: { 'x-forwarded-for': '200.1.2.3' } })
  ok('HTTP: pedido que passou por proxy não entra', fora.status === 404)

  const r = await fetch(`${base}/comprovantes/atraso?desde=${CORTE}`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: corpoZip })
  const j = await r.json()
  ok('HTTP: recebe o zip e começa o ensaio', r.status === 202 && j.ok === true && j.modo === 'ensaio' && j.comprovantes === 1)
  await atraso._aguardar()

  const estado = await (await fetch(`${base}/comprovantes/atraso`)).json()
  ok('HTTP: mostra como está e o resumo', estado.rodando === false && /1 seriam lançados/.test(estado.resumo ?? ''))
  const csv = await fetch(`${base}/comprovantes/atraso/relatorio.csv`)
  ok('HTTP: entrega o relatório', csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type')) && /lançaria/.test(await csv.text()))

  // Com token: vale também de fora (atrás de proxy), e sem ele não.
  process.env.GASTOS_ATRASO_TOKEN = 'segredo-do-atraso'
  const comToken = await fetch(`${base}/comprovantes/atraso`, { headers: { 'x-forwarded-for': '200.1.2.3', Authorization: 'Bearer segredo-do-atraso' } })
  const tokenErrado = await fetch(`${base}/comprovantes/atraso`, { headers: { 'x-forwarded-for': '200.1.2.3', Authorization: 'Bearer outro' } })
  ok('HTTP: com o token certo entra; com o errado, não', comToken.status === 200 && tokenErrado.status === 404)
  delete process.env.GASTOS_ATRASO_TOKEN

  // O zip pode já estar na pasta do atraso (mandado por scp) — só o nome, nunca um caminho.
  writeFileSync(join(process.env.GASTOS_ATRASO_DIR, 'ja-esta-aqui.zip'), corpoZip)
  const porNome = await fetch(`${base}/comprovantes/atraso?arquivo=ja-esta-aqui.zip&desde=${CORTE}`, { method: 'POST' })
  ok('HTTP: aceita o nome de um zip que já está na pasta', porNome.status === 202)
  await atraso._aguardar()
  const fuga = await fetch(`${base}/comprovantes/atraso?arquivo=${encodeURIComponent('../../' + 'iphone.zip')}`, { method: 'POST' })
  ok('HTTP: nome com "../" não sai da pasta', fuga.status === 422)

  process.env.GASTOS_ATRASO = 'off'
  const desligado = await fetch(`${base}/comprovantes/atraso`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: corpoZip })
  ok('HTTP: desligado, recusa sem nem guardar o zip', desligado.status === 409)
  http.close()
}

_limparPendentes()
srv.close()
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
