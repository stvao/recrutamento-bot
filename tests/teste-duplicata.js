/**
 * Comprovante repetido — quando o robô barra, quando pergunta, e quando
 * deixa passar.
 *
 * A regra antiga era "mesma obra + mesmo valor em 30 dias → pergunta". Errava
 * para os dois lados: perguntava à toa de dois cupons diferentes de mesmo
 * valor, e não via a mesma foto lançada em outra obra nem o gasto que o dono
 * já tinha digitado no sistema.
 *
 * Aqui há um sistema de obras de mentira (com a consulta de lançados) e uma
 * IA de mentira, que "lê" o nº do documento de dentro do próprio arquivo —
 * o que se testa é a decisão, não a leitura.
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const PASTA = mkdtempSync(join(tmpdir(), 'teste-duplicata-'))
process.env.GASTOS_PENDENTES_DIR = PASTA
process.env.GASTOS_MEMORIA = join(PASTA, 'memoria-gastos.json')
process.env.GEMINI_API_KEY = 'chave-de-teste'
process.env.GASTOS_AUTORIZADOS = '*'
process.env.GASTOS_GRUPOS = '123@g.us'
process.env.OBRAS_API_TOKEN = 'token-de-teste'
process.env.GASTOS_ESPERA_DESCRICAO_MS = '50'

// Um arquivo de memória do FORMATO ANTIGO, de antes de existirem documento e
// impressão digital. O que está em produção tem de continuar sendo lido.
writeFileSync(process.env.GASTOS_MEMORIA, JSON.stringify({
  lancamentos: [{
    obra: 'EE/ETEC AGUIA DE HAIA', valor: 777, descricao: 'brita', categoria: 'MATERIAL',
    de: '5511900000000', resultado: 'lancado', idMensagem: 'antiga-1', quando: Date.now() - 60000,
  }],
  apelidos: {}, grupo: null,
}), 'utf8')

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

const OBRAS = ['EE PROFA TSUYA OHNO KIMURA', 'EE/ETEC AGUIA DE HAIA']
const sha = (b) => createHash('sha256').update(b).digest('hex')
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())
const diasAtras = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' })
  .format(new Date(Date.now() - n * 24 * 60 * 60 * 1000))

// ── O sistema de obras e a IA, de mentira ─────────────────────────────────
const chamadas = []
/** O que GET /lancados devolve. null = servidor antigo (404). */
let lancadosNoSistema = []
/** Servidor antigo e estrito: 400 se vierem os campos novos no /lancar. */
let recusaCamposNovos = false
/** O /lancar responde que reconheceu um reenvio. */
let respondeReenvio = false

const srv = createServer((req, res) => {
  let corpo = ''
  req.on('data', c => { corpo += c })
  req.on('end', () => {
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }

    // A IA: o arquivo de teste é "cupom|<documento>|<data>", e ela devolve isso.
    if (req.url.startsWith('/ia')) {
      const dado = JSON.parse(corpo).contents[0].parts[0].inline_data.data
      const [, documento = '', data = ''] = Buffer.from(dado, 'base64').toString('utf8').split('|')
      return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({
        valor: 0, data, estabelecimento: '', categoria: '', documento, formaPagamento: '', confianca: 'baixa', observacao: '',
      }) }] } }] })
    }

    chamadas.push({ url: req.url, corpo })
    const campo = (n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null

    if (req.url.endsWith('/comprovantes/obras')) return json(200, { obras: OBRAS })

    if (req.url.includes('/comprovantes/lancados')) {
      if (lancadosNoSistema === null) return json(404, { message: 'Cannot GET' })
      return json(200, { lancados: lancadosNoSistema })
    }

    if (req.url.endsWith('/comprovantes/lancar')) {
      if (recusaCamposNovos && (campo('documento') !== null || campo('arquivoHash') !== null)) {
        return json(400, { message: ['property documento should not exist'] })
      }
      const obra = campo('obra')
      if (respondeReenvio) {
        return json(200, { ok: true, reenvio: true, id: 'g-antigo', obra, mensagem: 'Esse comprovante já estava lançado.' })
      }
      return json(201, { ok: true, id: 'g1', obra, obras: [obra], mensagem: `Lançado em ${obra}, aguardando sua aprovação.` })
    }

    // /receber — a caixa
    json(201, { ok: true, id: 'c1', mensagem: 'Comprovante recebido.', pendentes: 1 })
  })
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const URL_BASE = `http://127.0.0.1:${srv.address().port}`
process.env.OBRAS_API_URL = URL_BASE
process.env.IA_VISAO_ENDPOINT = `${URL_BASE}/ia`

const { tratar, _limparPendentes } = await import('../src/comprovantes/index.js')
const { _limparCacheObras, _esquecerDescoberta, lancadosDoSistema } = await import('../src/comprovantes/obras-client.js')
const memoria = await import('../src/comprovantes/memoria.js')
const { mesmoArquivo, parecido, documentoComparavel } = await import('../src/comprovantes/duplicata.js')

const base = { chat: '123@g.us', chatNome: 'Comprovantes', ehGrupo: true }
const espera = (ms) => new Promise(r => setTimeout(r, ms))

/** Um arquivo de comprovante com o nº de documento (e a data) que a IA vai "ler". */
let nArq = 0
const cupom = (documento = '', data = '') => Buffer.from(`cupom|${documento}|${data}|${++nArq}`)

function pessoa(de, { manterMemoria = false } = {}) {
  chamadas.length = 0
  _limparPendentes()
  _limparCacheObras()
  _esquecerDescoberta()
  if (!manterMemoria) memoria._limpar()
  lancadosNoSistema = []
  recusaCamposNovos = false
  respondeReenvio = false

  const ditos = []
  let n = 0
  const enviarResposta = async (t) => { ditos.push(t); return { id: `bot-${de}-${++n}` } }
  const guardar = (r) => { if (typeof r === 'string') ditos.push(r); return r }
  return {
    ditos,
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
const perguntou = (p) => p.ditos.some(t => /outro pagamento, ou é o mesmo/i.test(t))
const campoDe = (corpo, n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null

// ── 0. Memória do formato antigo continua valendo ─────────────────────────
{
  const p = pessoa('5511900000100', { manterMemoria: true })
  ok('arquivo de memória antigo é lido', memoria.lancadosRecentes().length === 1)
  await p.foto('haia brita 777', cupom('555666'))
  await espera(20)
  ok('lançamento antigo (sem documento) ainda gera a pergunta', perguntou(p))
  ok('e nada é lançado sozinho', lancs().length === 0)
}

// ── 1. O que vai para o sistema ───────────────────────────────────────────
{
  const p = pessoa('5511900000101')
  const arq = cupom('NSU-000123')
  await p.foto('haia cimento 250', arq)
  ok('lança', lancs().length === 1)
  ok('manda o nº do documento', campoDe(lancs()[0].corpo, 'documento') === 'NSU-000123')
  ok('manda a impressão digital do arquivo', campoDe(lancs()[0].corpo, 'arquivoHash') === sha(arq))
  const anotado = memoria.lancadosRecentes()[0]
  ok('a memória guarda os dois', anotado?.documento === 'NSU-000123' && anotado?.arquivoHash === sha(arq))
}

// A caixa também recebe a impressão digital.
{
  const p = pessoa('5511900000102')
  const arq = cupom('777888')
  await p.foto('alguma coisa sem obra nem valor', arq)
  await espera(20)
  await p.diz('cancelar')
  await espera(20)
  ok('foi para a caixa', caixa().length === 1)
  ok('com a impressão digital', campoDe(caixa()[0].corpo, 'arquivoHash') === sha(arq))
  ok('e o documento', campoDe(caixa()[0].corpo, 'documento') === '777888')
}

// ── 2. MESMO ARQUIVO: não lança, e não pergunta ───────────────────────────
{
  const p = pessoa('5511900000103')
  const arq = cupom('111222')
  await p.foto('haia cimento 250', arq)
  const r = await p.foto('haia cimento 250', arq)
  ok('o mesmo arquivo de novo é reconhecido', /mesmo arquivo/i.test(r ?? ''))
  ok('diz que não lançou', /não lancei de novo/i.test(r ?? ''))
  ok('sem perguntar nada', !perguntou(p))
  ok('sem lançar o segundo', lancs().length === 1)
  ok('e sem mandar para a caixa', caixa().length === 0)
}

// Vale mesmo com legenda diferente — outra obra, outro valor. É o mesmo papel.
{
  const p = pessoa('5511900000104')
  const arq = cupom('333444')
  await p.foto('haia cimento 250', arq)
  const r = await p.foto('tsuya areia 90', arq)
  ok('mesmo arquivo com outra legenda também não entra', /mesmo arquivo/i.test(r ?? '') && lancs().length === 1)
}

// E antes de qualquer pergunta: sem legenda nenhuma, já responde.
{
  const p = pessoa('5511900000105')
  const arq = cupom('999000')
  await p.foto('haia cimento 250', arq)
  p.foto('', arq)            // sem legenda: espera a descrição e depois processa
  await espera(120)
  ok('sem legenda, não pergunta obra nem valor — avisa que já entrou',
    p.ditos.some(t => /mesmo arquivo/i.test(t)) && !p.ditos.some(t => /obra|valor\?/i.test(t) && !/mesmo arquivo/i.test(t)))
}

// O que foi para a CAIXA não barra: mandar de novo com a legenda certa é o conserto.
{
  const p = pessoa('5511900000106')
  const arq = cupom('121212')
  await p.foto('sem obra nem valor', arq)
  await espera(20)
  await p.diz('cancelar')
  await espera(20)
  await p.foto('haia cimento 80', arq)
  ok('arquivo que só foi para a caixa pode ser lançado depois', lancs().length === 1)
}

// ── 3. MESMO DOCUMENTO + MESMO VALOR: pergunta ────────────────────────────
{
  const p = pessoa('5511900000107')
  await p.foto('haia cimento 250', cupom('000.123-4'))
  // Outra foto do mesmo cupom (arquivo diferente), e lançada em OUTRA obra.
  await p.foto('tsuya cimento 250', cupom('1234'))
  await espera(20)
  ok('mesmo documento e valor vira pergunta, mesmo em outra obra', perguntou(p))
  ok('a pergunta cita o documento', p.ditos.some(t => /mesmo nº de documento/i.test(t)))
  ok('e não lança sozinho', lancs().length === 1)
  const r = await p.diz('mesmo')
  ok('"mesmo" descarta', /não lancei/i.test(r ?? '') && lancs().length === 1)
}

{
  const p = pessoa('5511900000108')
  await p.foto('haia cimento 250', cupom('445566'))
  await p.foto('haia cimento 250', cupom('445566'))
  await espera(20)
  await p.diz('outro')
  await espera(20)
  ok('"outro" lança o segundo', lancs().length === 2)
  ok('avisando o sistema de que a pessoa confirmou', campoDe(lancs()[1].corpo, 'confirmadoOutro') === 'true')
}

// Mesmo documento com VALOR diferente não é o mesmo pagamento.
{
  const p = pessoa('5511900000109')
  await p.foto('haia cimento 250', cupom('778899'))
  await p.foto('tsuya cimento 300', cupom('778899'))
  await espera(20)
  ok('mesmo documento com outro valor não pergunta', !perguntou(p) && lancs().length === 2)
}

// ── 4. MESMA OBRA + MESMO VALOR, documentos DIFERENTES: não pergunta mais ──
{
  const p = pessoa('5511900000110')
  await p.foto('haia almoço 50', cupom('100001'))
  await p.foto('haia almoço 50', cupom('100002'))
  await espera(20)
  ok('dois cupons diferentes de mesmo valor entram sem pergunta', !perguntou(p))
  ok('os dois lançados', lancs().length === 2)
}

// ── 5. Sem documento em algum dos lados: a pergunta de sempre ─────────────
{
  const p = pessoa('5511900000111')
  await p.foto('haia almoço 50', cupom('200001'))
  await p.foto('haia almoço 50', cupom(''))        // a IA não achou número
  await espera(20)
  ok('sem documento no segundo, pergunta', perguntou(p) && lancs().length === 1)
}
{
  const p = pessoa('5511900000112')
  await p.foto('haia almoço 50', cupom(''))
  await p.foto('haia almoço 50', cupom('200002'))
  await espera(20)
  ok('sem documento no primeiro, pergunta', perguntou(p) && lancs().length === 1)
}
// Número curto demais não vale como documento (nº do caixa, da via).
{
  const p = pessoa('5511900000113')
  await p.foto('haia almoço 50', cupom('01'))
  await p.foto('haia almoço 50', cupom('02'))
  await espera(20)
  ok('"01" e "02" não desempatam: pergunta', perguntou(p) && lancs().length === 1)
}

// ── 6. O que está no SISTEMA também conta ─────────────────────────────────
// Lançado à mão pelo dono: sem documento, sem arquivo. Vale obra + valor +
// data perto.
{
  const p = pessoa('5511900000114')
  lancadosNoSistema = [{ origem: 'gasto', obra: 'EE/ETEC AGUIA DE HAIA', valor: 320, data: diasAtras(2), descricao: 'areia', fornecedor: null, documento: null, arquivoHash: null, status: 'APROVADO' }]
  await p.foto('haia areia 320', cupom('300001'))
  await espera(20)
  ok('gasto digitado à mão há 2 dias gera pergunta', perguntou(p) && lancs().length === 0)
  ok('e a pergunta diz que está NO SISTEMA, não que o robô lançou',
    p.ditos.some(t => /no sistema/i.test(t)) && !p.ditos.some(t => /já lancei/i.test(t)))
  ok('consultou os lançados', chamadas.some(c => /\/lancados\?desde=\d{4}-\d{2}-\d{2}$/.test(c.url)))
}
{
  const p = pessoa('5511900000115')
  lancadosNoSistema = [{ origem: 'conta', obra: 'EE/ETEC AGUIA DE HAIA', valor: 320, data: diasAtras(10), descricao: 'areia', documento: null, arquivoHash: null, status: 'PENDENTE' }]
  await p.foto('haia areia 320', cupom('300002'))
  await espera(20)
  ok('digitado à mão há 10 dias não gera pergunta', !perguntou(p) && lancs().length === 1)
}
// ...mas a data lida no papel também vale: quem digita usa a data do cupom.
{
  const p = pessoa('5511900000116')
  lancadosNoSistema = [{ origem: 'gasto', obra: 'EE/ETEC AGUIA DE HAIA', valor: 320, data: diasAtras(10), descricao: 'areia', documento: null, arquivoHash: null, status: 'APROVADO' }]
  await p.foto('haia areia 320', cupom('300003', diasAtras(11)))
  await espera(20)
  ok('comprovante antigo mandado hoje casa pela data do papel', perguntou(p) && lancs().length === 0)
}
// Mesmo arquivo já no sistema, sem ter passado pela memória do robô.
{
  const p = pessoa('5511900000117')
  const arq = cupom('300004')
  lancadosNoSistema = [{ origem: 'gasto', obra: 'EE/ETEC AGUIA DE HAIA', valor: 60, data: hoje, descricao: 'prego', documento: '300004', arquivoHash: sha(arq), status: 'PENDENTE' }]
  const r = await p.foto('haia prego 60', arq)
  ok('arquivo que já está no sistema não é lançado de novo', /mesmo arquivo/i.test(r ?? '') && lancs().length === 0)
}
// Mesmo documento no sistema.
{
  const p = pessoa('5511900000118')
  lancadosNoSistema = [{ origem: 'gasto', obra: 'EE PROFA TSUYA OHNO KIMURA', valor: 60, data: diasAtras(20), descricao: 'prego', documento: 'ABC-9000', arquivoHash: 'outro', status: 'APROVADO' }]
  await p.foto('haia prego 60', cupom('abc9000'))
  await espera(20)
  ok('mesmo documento de um gasto do sistema gera pergunta', perguntou(p) && lancs().length === 0)
}
// Rejeitado não conta — nem para barrar o mesmo arquivo.
{
  const p = pessoa('5511900000119')
  const arq = cupom('300005')
  lancadosNoSistema = [{ origem: 'gasto', obra: 'EE/ETEC AGUIA DE HAIA', valor: 60, data: hoje, descricao: 'prego', documento: '300005', arquivoHash: sha(arq), status: 'REJEITADO' }]
  await p.foto('haia prego 60', arq)
  await espera(20)
  ok('gasto REJEITADO não barra nem pergunta', !perguntou(p) && lancs().length === 1)
}

// ── 7. Servidor de versão anterior não derruba nada ───────────────────────
{
  const p = pessoa('5511900000120')
  lancadosNoSistema = null                 // 404 na rota nova
  await p.foto('haia cimento 250', cupom('400001'))
  ok('sem a rota de lançados, lança como sempre', lancs().length === 1)
  await p.foto('haia cimento 250', cupom(''))
  await espera(20)
  ok('e a memória do robô continua valendo', perguntou(p) && lancs().length === 1)
  const consultas = chamadas.filter(c => c.url.includes('/lancados')).length
  ok('o 404 é lembrado: não pergunta de novo a cada comprovante', consultas === 1)
}
{
  const p = pessoa('5511900000121')
  recusaCamposNovos = true                 // 400 nos campos que ele não conhece
  const r = await p.foto('haia cimento 250', cupom('400002'))
  ok('recusados os campos novos, tenta sem eles e LANÇA', /aguardando sua aprovação/i.test(r ?? ''))
  ok('foram duas tentativas', lancs().length === 2 && campoDe(lancs()[1].corpo, 'arquivoHash') === null)
  ok('e nada foi para a caixa', caixa().length === 0)
  await p.foto('tsuya areia 90', cupom('400003'))
  ok('descoberto isso, o seguinte já vai sem os campos', lancs().length === 3 && campoDe(lancs()[2].corpo, 'documento') === null)
}
// A consulta nunca lança, venha o que vier.
{
  pessoa('5511900000122')
  lancadosNoSistema = 'isto não é uma lista'
  ok('resposta estranha vira null', (await lancadosDoSistema(hoje)) === null)
  _limparCacheObras()
  ok('data inválida vira null', (await lancadosDoSistema('ontem')) === null)
}

// ── 8. `reenvio: true`: o sistema reconheceu, e a memória não anota de novo ──
{
  const p = pessoa('5511900000123')
  respondeReenvio = true
  const r = await p.foto('haia cimento 250', cupom('500001'))
  ok('responde que já estava lançado', /já estava lançado/i.test(r ?? '') && !/✅/.test(r ?? ''))
  ok('e não anota na memória', memoria.lancadosRecentes().length === 0)
}

// ── 9. As regras, direto ──────────────────────────────────────────────────
{
  ok('documento: pontuação e zero à esquerda não contam', documentoComparavel('000.123-4') === '1234')
  ok('documento: curto demais é como não ter', documentoComparavel('02') === null && documentoComparavel('') === null)

  const local = { obra: 'Obra A', valor: 100, documento: '555000', arquivoHash: 'h1', idMensagem: 'm1', quando: Date.now(), resultado: 'lancado' }
  ok('mesmo arquivo na memória', mesmoArquivo({ arquivoHash: 'h1', idMensagem: 'm2' }, { locais: [local] })?.fonte === 'robo')
  ok('a própria mensagem não é duplicata de si mesma', mesmoArquivo({ arquivoHash: 'h1', idMensagem: 'm1' }, { locais: [local] }) === null)
  ok('sem impressão digital não há mesmo arquivo', mesmoArquivo({ arquivoHash: null }, { locais: [{ ...local, arquivoHash: null }] }) === null)
  ok('rejeitado no sistema solta o que a memória segurava',
    mesmoArquivo({ arquivoHash: 'h1', idMensagem: 'm2' }, { locais: [local], doSistema: [{ arquivoHash: 'h1', status: 'REJEITADO' }] }) === null)

  ok('obra e valor iguais, documentos diferentes: nada',
    parecido({ obra: 'obra a', valor: 100, documento: '555111' }, { locais: [local] }) === null)
  ok('obra e valor iguais, sem documento: parecido',
    parecido({ obra: 'obra a', valor: 100, documento: null }, { locais: [local] })?.motivo === 'obra-valor')
  ok('documento e valor iguais em outra obra: parecido',
    parecido({ obra: 'Obra B', valor: 100, documento: '0555000' }, { locais: [local] })?.motivo === 'documento')
  ok('valor diferente: nada', parecido({ obra: 'Obra A', valor: 101, documento: '555000' }, { locais: [local] }) === null)
  ok('listas ausentes não quebram', parecido({ obra: 'Obra A', valor: 100 }, {}) === null && mesmoArquivo({ arquivoHash: 'x' }) === null)
  ok('valor do sistema como texto também casa',
    parecido({ obra: 'Obra A', valor: 100, datas: [hoje] }, { doSistema: [{ obra: 'OBRA A', valor: '100.00', data: `${hoje}T00:00:00.000Z` }] })?.fonte === 'sistema')
}

_limparPendentes()
srv.close()
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
