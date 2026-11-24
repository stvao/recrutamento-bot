/**
 * O hábito — este fornecedor é quase sempre da mesma obra.
 *
 * Quando falta a obra e o fornecedor tem história, a pergunta deixa de ser a
 * lista inteira e vira "É da <obra>, como das outras vezes?". O que se
 * confere aqui, acima de tudo: o robô NUNCA lança por hábito. Obra errada é
 * o pior erro do módulo, e ninguém percebe. A pessoa sempre confirma.
 *
 * A IA é de mentira: "lê" o fornecedor que o próprio arquivo de teste traz.
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASTA = mkdtempSync(join(tmpdir(), 'teste-habito-'))
process.env.GASTOS_PENDENTES_DIR = PASTA
process.env.GASTOS_MEMORIA = join(PASTA, 'memoria-gastos.json')
process.env.GEMINI_API_KEY = 'chave-de-teste'
process.env.GASTOS_AUTORIZADOS = '*'
process.env.GASTOS_GRUPOS = '123@g.us'
process.env.OBRAS_API_TOKEN = 'token-de-teste'
process.env.GASTOS_ESPERA_DESCRICAO_MS = '50'
delete process.env.GASTOS_HABITO_MINIMO
delete process.env.GASTOS_HABITO_DIAS
delete process.env.GASTOS_HABITO_PROPORCAO

// Memória do formato de ANTES do hábito: sem a lista de fornecedores.
writeFileSync(process.env.GASTOS_MEMORIA, JSON.stringify({
  lancamentos: [{ obra: 'EE/ETEC AGUIA DE HAIA', valor: 5, de: 'x', resultado: 'lancado', idMensagem: 'antiga', quando: Date.now() }],
  apelidos: {}, grupo: null,
}), 'utf8')

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

let OBRAS = ['EE PROFA TSUYA OHNO KIMURA', 'EE/ETEC AGUIA DE HAIA', 'EE OSWALDO LUIZ SANCHES TOSCHI']
const [TSUYA, HAIA, TOSCHI] = OBRAS
const TODAS = [...OBRAS]

const chamadas = []
const srv = createServer((req, res) => {
  let corpo = ''
  req.on('data', c => { corpo += c })
  req.on('end', () => {
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (req.url.startsWith('/ia')) {
      // Pedido de TEXTO (a IA lendo a frase, ia-frase.js), e não de imagem:
      // responde "não entendi", para o teste seguir só com as regras.
      if (!JSON.parse(corpo).contents?.[0]?.parts?.[0]?.inline_data) {
        return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ obras: [], valor: 0, pagoPor: '', empresaPagou: false, categoria: '', descricao: '', confianca: 'baixa' }) }] } }] })
      }
      let leitura = {}
      try { leitura = JSON.parse(Buffer.from(JSON.parse(corpo).contents[0].parts[0].inline_data.data, 'base64').toString('utf8')).leitura ?? {} } catch { /* não é de teste */ }
      return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({
        valor: 0, data: '', estabelecimento: '', categoria: '', documento: '', cnpj: '', formaPagamento: '', confianca: 'baixa', observacao: '',
        ...leitura,
      }) }] } }] })
    }
    chamadas.push({ url: req.url, metodo: req.method, corpo })
    const campo = (n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null
    if (req.url.endsWith('/comprovantes/obras')) return json(200, { obras: OBRAS })
    if (req.url.includes('/comprovantes/lancados')) return json(200, { lancados: [] })
    if (req.url.endsWith('/comprovantes/lancar')) {
      const obra = campo('obra')
      return json(201, { ok: true, id: `g${chamadas.length}`, obra, obras: [obra], mensagem: `Lançado em ${obra}, aguardando sua aprovação.` })
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
const { habitoDe, fornecedorDe, mesmoFornecedor } = await import('../src/comprovantes/habito.js')
const { processar } = await import('../src/comprovantes/processar.js')
const { conferir } = await import('../src/comprovantes/ia-visao.js')

ok('memória de antes do hábito é lida, e começa sem hábito nenhum',
  memoria.lancadosRecentes().length === 1 && memoria.habitosDe({ nome: 'qualquer coisa', cnpj: null }).length === 0)

const base = { chat: '123@g.us', chatNome: 'Comprovantes', ehGrupo: true }
const espera = (ms) => new Promise(r => setTimeout(r, ms))
let nArq = 0
/** Um comprovante do fornecedor dado. O valor vem sempre da legenda. */
const cupom = (leitura = {}) => Buffer.from(JSON.stringify({ leitura, n: ++nArq }))
const POSTO = { estabelecimento: 'Posto Bastos Ltda', cnpj: '12.345.678/0001-90' }

function zerar() {
  chamadas.length = 0
  _limparPendentes()
  _limparCacheObras()
  memoria._limpar()
  OBRAS = [...TODAS]
}

function pessoa(de) {
  const ditos = []
  let n = 0
  const enviarResposta = async (t) => { ditos.push(t); return { id: `bot-${de}-${++n}` } }
  const guardar = (r) => { if (typeof r === 'string') ditos.push(r); return r }
  return {
    ditos,
    foto: async (texto, arquivo) => {
      const idMensagem = `foto-${de}-${++nArq}`
      guardar(await tratar({ ...base, de, arquivo, nomeArquivo: 'c.jpg', tipo: 'image/jpeg', texto, idMensagem, enviarResposta }))
      return idMensagem
    },
    diz: async (texto) => guardar(await tratar({ ...base, de, texto, idMensagem: `t-${Math.random()}`, respondendoA: null, enviarResposta })),
  }
}

const lancs = () => chamadas.filter(c => c.url.endsWith('/lancar'))
const caixa = () => chamadas.filter(c => c.url.endsWith('/receber'))
const campoDe = (corpo, n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null
const doHabito = (p) => p.ditos.filter(t => /como das outras vezes/.test(t))
const daLista = (p) => p.ditos.filter(t => /De qual \*obra\*/.test(t))

/** N comprovantes do fornecedor, com a obra escrita — é assim que o hábito nasce. */
async function historia(p, fornecedor, obras) {
  const ids = []
  for (const [i, obra] of obras.entries()) ids.push(await p.foto(`${obra} compra ${100 + i}`, cupom(fornecedor)))
  return ids
}

// ── 1. Sem história, a pergunta é a de sempre ─────────────────────────────
{
  zerar()
  const p = pessoa('5511900000501')
  await historia(p, POSTO, ['haia', 'haia'])
  ok('dois lançamentos entram normalmente', lancs().length === 2)
  await p.foto('compra 300', cupom(POSTO)); await espera(20)
  ok('com dois lançamentos ainda não há hábito: lista de sempre', daLista(p).length === 1 && doHabito(p).length === 0)
}

// ── 2. Com história: pergunta "é da X?", e NÃO lança sozinho ──────────────
{
  zerar()
  const p = pessoa('5511900000502')
  await historia(p, POSTO, ['haia', 'haia', 'haia'])
  ok('três lançamentos do mesmo fornecedor na mesma obra', lancs().length === 3)

  await p.foto('compra 300', cupom(POSTO)); await espera(20)
  ok('o quarto, sem obra, vira a pergunta do hábito', doHabito(p).length === 1 && daLista(p).length === 0)
  ok('que diz a obra e mostra o que entendeu', doHabito(p)[0].includes(`É da *${HAIA}*, como das outras vezes?`) && /Anotei: Posto Bastos Ltda/.test(doHabito(p)[0]) && /R\$ 300,00/.test(doHabito(p)[0]))
  ok('NUNCA lança sozinho por hábito', lancs().length === 3 && caixa().length === 0)

  await p.diz('sim'); await espera(20)
  ok('"sim" confirma e lança na obra sugerida', lancs().length === 4 && campoDe(lancs()[3].corpo, 'obra') === HAIA && campoDe(lancs()[3].corpo, 'valor') === '300')
}

// ── 3. Qualquer outra resposta segue o fluxo de obra de hoje ──────────────
{
  zerar()
  const p = pessoa('5511900000503')
  await historia(p, POSTO, ['haia', 'haia', 'haia'])
  await p.foto('compra 300', cupom(POSTO)); await espera(20)
  await p.diz('tsuya'); await espera(20)
  ok('respondeu outra obra: é ela que vale', lancs().length === 4 && campoDe(lancs()[3].corpo, 'obra') === TSUYA)
}
{
  zerar()
  const p = pessoa('5511900000504')
  await historia(p, POSTO, ['haia', 'haia', 'haia'])
  await p.foto('compra 300', cupom(POSTO)); await espera(20)
  await p.diz('não'); await espera(20)
  ok('"não": não lança, e volta a pergunta de sempre, com a lista', lancs().length === 3 && daLista(p).length === 1)
  ok('a pergunta do hábito não se repete', doHabito(p).length === 1)
  await p.diz('toschi'); await espera(20)
  ok('e a obra respondida depois lança', lancs().length === 4 && campoDe(lancs()[3].corpo, 'obra') === TOSCHI)
}
{
  // Falta a obra E o valor: a mesma pergunta pede os dois, e "sim, 250" resolve.
  zerar()
  const p = pessoa('5511900000505')
  await historia(p, POSTO, ['haia', 'haia', 'haia'])
  await p.foto('compra', cupom(POSTO)); await espera(20)
  ok('faltando também o valor, a pergunta pede os dois', doHabito(p).length === 1 && /E qual foi o \*valor\*/.test(doHabito(p)[0]))
  await p.diz('sim, 250'); await espera(20)
  ok('"sim, 250" confirma a obra e traz o valor', lancs().length === 4 && campoDe(lancs()[3].corpo, 'obra') === HAIA && campoDe(lancs()[3].corpo, 'valor') === '250')
}
{
  // Quem escreveu a obra não é perguntado de nada.
  zerar()
  const p = pessoa('5511900000506')
  await historia(p, POSTO, ['haia', 'haia', 'haia'])
  await p.foto('tsuya compra 300', cupom(POSTO))
  ok('com a obra escrita, o hábito não se mete', lancs().length === 4 && campoDe(lancs()[3].corpo, 'obra') === TSUYA && doHabito(p).length === 0)
}

// ── 4. A régua: 80% ou mais numa obra só ──────────────────────────────────
{
  zerar()
  const p = pessoa('5511900000507')
  await historia(p, POSTO, ['haia', 'haia', 'haia', 'tsuya'])
  await p.foto('compra 300', cupom(POSTO)); await espera(20)
  ok('3 de 4 (75%) não é hábito', doHabito(p).length === 0 && daLista(p).length === 1)
}
{
  zerar()
  const p = pessoa('5511900000508')
  await historia(p, POSTO, ['haia', 'haia', 'haia', 'haia', 'tsuya'])
  await p.foto('compra 300', cupom(POSTO)); await espera(20)
  ok('4 de 5 (80%) é', doHabito(p).length === 1 && doHabito(p)[0].includes(HAIA))
}

// ── 5. Quem é o fornecedor: CNPJ antes do nome ────────────────────────────
{
  zerar()
  const p = pessoa('5511900000509')
  // Mesmo CNPJ, nome lido de três jeitos.
  await p.foto('haia compra 1', cupom({ estabelecimento: 'Posto Bastos', cnpj: '12345678000190' }))
  await p.foto('haia compra 2', cupom({ estabelecimento: 'AUTO POSTO BASTOS LTDA', cnpj: '12.345.678/0001-90' }))
  await p.foto('haia compra 3', cupom({ estabelecimento: 'P. Bastos', cnpj: '12345678000190' }))
  await p.foto('compra 300', cupom({ estabelecimento: 'Posto B.', cnpj: '12345678000190' })); await espera(20)
  ok('mesmo CNPJ com o nome lido de jeitos diferentes: é o mesmo fornecedor', doHabito(p).length === 1)
}
{
  zerar()
  const p = pessoa('5511900000510')
  await historia(p, POSTO, ['haia', 'haia', 'haia'])
  await p.foto('compra 300', cupom({ estabelecimento: 'Posto Bastos Ltda', cnpj: '99.999.999/0001-99' })); await espera(20)
  ok('mesmo nome com OUTRO CNPJ é outra loja: sem hábito', doHabito(p).length === 0 && daLista(p).length === 1)
}
{
  zerar()
  const p = pessoa('5511900000511')
  await historia(p, { estabelecimento: 'Depósito Central' }, ['tsuya', 'tsuya', 'tsuya'])
  await p.foto('compra 300', cupom({ estabelecimento: 'DEPOSITO CENTRAL LTDA' })); await espera(20)
  ok('sem CNPJ, vale o nome — sem ligar para maiúscula, acento e "Ltda"', doHabito(p).length === 1 && doHabito(p)[0].includes(TSUYA))
}
{
  zerar()
  const p = pessoa('5511900000512')
  await historia(p, {}, ['haia', 'haia', 'haia'])           // a IA não leu fornecedor nenhum
  await p.foto('compra 300', cupom({})); await espera(20)
  ok('sem fornecedor lido não há hábito', doHabito(p).length === 0 && daLista(p).length === 1)
}

// ── 6. Só o que foi LANÇADO conta — e a correção acompanha ────────────────
{
  zerar()
  const p = pessoa('5511900000513')
  for (let i = 0; i < 3; i++) {
    await p.foto('compra sem obra', cupom(POSTO)); await espera(20)
    await p.diz('cancelar'); await espera(20)
  }
  ok('três foram para a caixa', caixa().length === 3 && lancs().length === 0)
  ok('o que foi para a caixa não cria hábito', memoria.habitosDe(fornecedorDe(POSTO)).length === 0)
}
{
  zerar()
  const p = pessoa('5511900000514')
  const ids = await historia(p, POSTO, ['haia', 'haia', 'haia'])
  // Um deles estava na obra errada, e foi corrigido (passo 6).
  memoria.corrigirLancamento(ids[0], { obra: TSUYA })
  await p.foto('compra 300', cupom(POSTO)); await espera(20)
  ok('corrigida a obra de um, o hábito cai (2 de 3)', doHabito(p).length === 0)
}
{
  zerar()
  const p = pessoa('5511900000515')
  const ids = await historia(p, POSTO, ['haia', 'haia', 'haia'])
  memoria.esquecerLancamento(ids[1])                       // cancelado
  await p.foto('compra 300', cupom(POSTO)); await espera(20)
  ok('cancelado um, sobram dois: sem hábito', doHabito(p).length === 0 && memoria.habitosDe(fornecedorDe(POSTO)).length === 2)
}

// ── 7. 90 dias, e obra que ainda existe ───────────────────────────────────
{
  zerar()
  const f = fornecedorDe(POSTO)
  const dia = 24 * 60 * 60 * 1000
  for (const atras of [100, 95, 91]) memoria._anotarHabitoEm({ ...f, obra: HAIA, quando: Date.now() - atras * dia })
  const p = pessoa('5511900000516')
  await p.foto('compra 300', cupom(POSTO)); await espera(20)
  ok('lançamentos de mais de 90 dias não contam', doHabito(p).length === 0)
}
{
  zerar()
  const p = pessoa('5511900000517')
  await historia(p, POSTO, ['toschi', 'toschi', 'toschi'])
  OBRAS = [TSUYA, HAIA]                                    // a Toschi foi encerrada
  _limparCacheObras()
  await p.foto('compra 300', cupom(POSTO)); await espera(20)
  ok('obra encerrada não é sugerida', doHabito(p).length === 0 && daLista(p).length === 1)
}

// ── 8. A categoria pelo hábito ────────────────────────────────────────────
{
  zerar()
  const p = pessoa('5511900000518')
  for (let i = 0; i < 3; i++) await p.foto(`haia locação compra ${i + 1}`, cupom(POSTO))
  await p.foto('haia compra 300', cupom(POSTO))
  ok('sem categoria na legenda nem na imagem, vai a do hábito', campoDe(lancs()[3].corpo, 'categoria') === 'LOCACAO')
  await p.foto('haia material compra 301', cupom(POSTO))
  ok('a categoria escrita ganha do hábito', campoDe(lancs()[4].corpo, 'categoria') === 'MATERIAL')
  await p.foto('haia compra 302', cupom({ ...POSTO, categoria: 'COMBUSTIVEL' }))
  ok('a lida na imagem também', campoDe(lancs()[5].corpo, 'categoria') === 'COMBUSTIVEL')
  ok('categoria que veio do hábito não se confirma sozinha',
    memoria.habitosDe(fornecedorDe(POSTO)).filter(h => h.categoria === 'LOCACAO').length === 3)
}

// ── 9. No atraso também é PERGUNTA ────────────────────────────────────────
{
  zerar()
  const p = pessoa('5511900000519')
  await historia(p, POSTO, ['haia', 'haia', 'haia'])
  const falso = {
    id: 'ensaio-1', chat: null, de: 'atraso:ensaio', arquivo: cupom(POSTO), tipo: 'image/jpeg', descricao: 'compra 300', respostas: [],
    idMensagem: 'atraso-x', enviadoEm: Date.now(), atraso: { remetente: 'João', desde: '2026-01-01' }, empresaPagou: true, pagadorPerguntado: true,
  }
  const r = await processar(falso, { ensaio: true })
  ok('ensaio do atraso: seria pergunta, com a obra do hábito', r.desfecho === 'pergunta' && r.pergunta.includes(HAIA) && /como das outras vezes/.test(r.texto))
  ok('e não lançaria', r.desfecho !== 'lancaria' && lancs().length === 3)
}

// ── 10. As regras, direto ─────────────────────────────────────────────────
{
  const agora = Date.now()
  const ev = (obra, categoria = null, diasAtras = 1) => ({ obra, categoria, quando: agora - diasAtras * 86400000 })
  const atuais = { obrasAtuais: ['A', 'B'], agora }
  ok('menos de 3: nada', habitoDe([ev('A'), ev('A')], atuais) === null)
  ok('3 de 3: hábito', habitoDe([ev('A'), ev('A'), ev('A')], atuais)?.obra === 'A')
  ok('obra fora da lista atual: nada', habitoDe([ev('C'), ev('C'), ev('C')], atuais) === null)
  ok('categoria passa na régua por conta própria',
    habitoDe([ev('A', 'EPI'), ev('B', 'EPI'), ev('C', 'EPI')], atuais)?.categoria === 'EPI'
    && habitoDe([ev('A', 'EPI'), ev('B', 'EPI'), ev('C', 'EPI')], atuais)?.obra === null)
  ok('lista vazia ou ausente não quebra', habitoDe([], atuais) === null && habitoDe(null) === null)

  ok('fornecedor: CNPJ só inteiro', fornecedorDe({ cnpj: '12.345.678/0001-90' })?.cnpj === '12345678000190' && fornecedorDe({ cnpj: '123', estabelecimento: 'Loja Boa' })?.cnpj === null)
  ok('fornecedor: nome curto demais é como não ter', fornecedorDe({ estabelecimento: 'LJ' }) === null && fornecedorDe({}) === null)
  ok('mesmo fornecedor: CNPJ dos dois lados decide', mesmoFornecedor({ cnpj: '1', nome: 'x' }, { cnpj: '2', nome: 'x' }) === false)
  ok('mesmo fornecedor: sem CNPJ de um lado, vale o nome', mesmoFornecedor({ cnpj: '1', nome: 'posto' }, { cnpj: null, nome: 'posto' }) === true)

  ok('conferir: CNPJ inteiro fica só com os dígitos', conferir({ valor: 10, cnpj: '12.345.678/0001-90' })?.cnpj === '12345678000190')
  ok('conferir: CNPJ cortado, ou CPF, vira nada', conferir({ valor: 10, cnpj: '12.345.678/0001' })?.cnpj === null && conferir({ valor: 10, cnpj: '123.456.789-09' })?.cnpj === null)
  ok('conferir: leitura antiga, sem o campo, continua valendo', conferir({ valor: 10 })?.cnpj === null)
}

_limparPendentes()
srv.close()
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
