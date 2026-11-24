/**
 * O grupo só de leitura.
 *
 * Há um grupo onde a equipe manda comprovante todo dia e onde o robô não
 * deve falar. Ele lê o que chega ali, lança, e pergunta em OUTRO lugar: o
 * grupo de conversa, ou o privado do dono. O que se confere, antes de tudo:
 *
 *  - NADA é dito no grupo de leitura — nem pergunta, nem confirmação, nem
 *    resposta a "ping";
 *  - o que sai no destino diz de que grupo veio, quando e de quem;
 *  - quem responde é quem está no destino, citando.
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASTA = mkdtempSync(join(tmpdir(), 'teste-grupo-leitura-'))
const CONVERSA = '123@g.us'             // o grupo onde o robô conversa
const LEITURA = '999@g.us'              // o grupo onde ele só lê
const DONO = '5511988880000'
process.env.GASTOS_PENDENTES_DIR = PASTA
process.env.GASTOS_MEMORIA = join(PASTA, 'memoria-gastos.json')
process.env.GEMINI_API_KEY = ''
process.env.GASTOS_AUTORIZADOS = `*,${DONO}`
process.env.GASTOS_GRUPOS = CONVERSA
process.env.GASTOS_GRUPOS_LEITURA = `${LEITURA},Comprovantes Pgto obras`
process.env.GASTOS_LEITURA_DESTINO = CONVERSA
process.env.OBRAS_API_TOKEN = 'token-de-teste'
process.env.GASTOS_ESPERA_DESCRICAO_MS = '60'
delete process.env.GASTOS_ATRASO_GRUPO
delete process.env.GASTOS_LEITURA_PAGADOR
delete process.env.GASTOS_LEITURA_CONFIRMA

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

const OBRAS = ['EE PROFA TSUYA OHNO KIMURA', 'EE/ETEC AGUIA DE HAIA']
const HAIA = OBRAS[1]
const chamadas = []
const srv = createServer((req, res) => {
  let corpo = ''
  req.on('data', c => { corpo += c })
  req.on('end', () => {
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    chamadas.push({ url: req.url, metodo: req.method, corpo })
    const campo = (n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null
    if (req.url.endsWith('/comprovantes/obras')) return json(200, { obras: OBRAS, pagadores: ['Ana', 'Beto'] })
    if (/\/lancados\/[^/?]+/.test(req.url) && req.method === 'PATCH') {
      const pedido = JSON.parse(corpo)
      return json(200, { ok: true, id: 'g1', obra: HAIA, valor: pedido.valor, status: 'PENDENTE' })
    }
    if (req.url.includes('/comprovantes/lancados')) return json(200, { lancados: [] })
    if (req.url.endsWith('/comprovantes/lancar')) {
      const obra = campo('obra')
      return json(201, { ok: true, id: `g${chamadas.length}`, obra, obras: [obra], pagoPor: campo('pagoPor'), mensagem: `Lançado em ${obra}, aguardando sua aprovação.` })
    }
    json(201, { ok: true, id: 'c1', mensagem: 'Comprovante recebido.', pendentes: 1 })
  })
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
process.env.OBRAS_API_URL = `http://127.0.0.1:${srv.address().port}`

const { tratar, podeLancarGasto, esperaRespostaDe, _limparPendentes } = await import('../src/comprovantes/index.js')
const leitura = await import('../src/comprovantes/leitura.js')
const { avisar } = await import('../src/comprovantes/processar.js')
const { ehGrupoDeLeitura } = await import('../src/comprovantes/autorizacao.js')
const { _limparCacheObras } = await import('../src/comprovantes/obras-client.js')
const { _limparEsperas } = await import('../src/comprovantes/correcao.js')
const pendentes = await import('../src/comprovantes/pendentes.js')
const memoria = await import('../src/comprovantes/memoria.js')

const espera = (ms) => new Promise(r => setTimeout(r, ms))

/** Tudo que o robô disse por conta própria, e para onde. */
const envios = []
let nEnvio = 0
leitura._usarEnvio(async (para, texto) => { const id = `msg-${++nEnvio}`; envios.push({ para, texto, id }); return { ok: true, id } })

/** Tudo que o robô respondeu DENTRO do grupo de leitura — tem de ficar vazio. */
const ditoNoGrupoDeLeitura = []

function zerar() {
  chamadas.length = 0
  envios.length = 0
  _limparPendentes()
  _limparCacheObras()
  _limparEsperas()
  memoria._limpar()
  process.env.GASTOS_LEITURA_DESTINO = CONVERSA
  delete process.env.GASTOS_LEITURA_PAGADOR
  delete process.env.GASTOS_LEITURA_CONFIRMA
  leitura._usarEnvio(async (para, texto) => { const id = `msg-${++nEnvio}`; envios.push({ para, texto, id }); return { ok: true, id } })
}

let nFoto = 0
const QUANDO = Date.parse('2026-11-24T14:03:00-03:00')
/** Uma mensagem no grupo de leitura. O que o robô devolver ou mandar por ela é anotado. */
async function noGrupoDeLeitura(de, nome, { texto = null, comFoto = false } = {}) {
  const r = await tratar({
    canal: 'whatsapp', chat: LEITURA, chatNome: 'Comprovantes Pgto obras', ehGrupo: true,
    de, telefoneConhecido: true, nomeRemetente: nome, texto,
    ...(comFoto ? { arquivo: Buffer.from(`imagem-${++nFoto}`), nomeArquivo: 'c.jpg', tipo: 'image/jpeg' } : {}),
    idMensagem: `leitura-${++nFoto}`, enviadoEm: QUANDO,
    enviarResposta: async (t) => { ditoNoGrupoDeLeitura.push(t); return { id: 'vazou' } },
  })
  if (r !== null && r !== undefined) ditoNoGrupoDeLeitura.push(r)
  return r
}
/** Alguém respondendo no destino (o grupo de conversa, ou o privado). */
async function noDestino(de, texto, citando, { chat = CONVERSA, ehGrupo = true } = {}) {
  const ditos = []
  const r = await tratar({
    canal: 'whatsapp', chat, chatNome: ehGrupo ? 'Robô' : null, ehGrupo, de, telefoneConhecido: true, texto,
    idMensagem: `d-${Math.random()}`, respondendoA: citando ?? null,
    enviarResposta: async (t) => { ditos.push(t); return { id: `resp-${Math.random()}` } },
  })
  if (typeof r === 'string') ditos.push(r)
  return ditos
}

const lancs = () => chamadas.filter(c => c.url.endsWith('/lancar'))
const campoDe = (corpo, n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null

// ── 1. Comprovante completo: lê, lança, e confirma NO DESTINO ─────────────
{
  zerar()
  const r = await noGrupoDeLeitura('5511977771111', 'João Pedreiro', { comFoto: true, texto: 'haia cimento 250' })
  ok('no grupo de leitura o robô não devolve nada', r === null)
  ok('o comprovante é lançado', lancs().length === 1 && campoDe(lancs()[0].corpo, 'obra') === HAIA && campoDe(lancs()[0].corpo, 'valor') === '250')
  ok('como pago pela empresa', campoDe(lancs()[0].corpo, 'empresaPagou') === 'true')
  ok('com o telefone de quem mandou', campoDe(lancs()[0].corpo, 'enviadoPor') === '5511977771111')
  ok('com a data em que foi mandado', campoDe(lancs()[0].corpo, 'data') === '2026-11-24')
  ok('a confirmação sai no grupo de conversa', envios.length === 1 && envios[0].para === CONVERSA && /aguardando sua aprovação/.test(envios[0].texto))
  ok('dizendo de que grupo veio, quando e de quem',
    envios[0].texto.startsWith('📎 Do grupo "Comprovantes Pgto obras" — 24/11 às 14:03, de João Pedreiro\n"haia cimento 250"\n'))
  ok('ninguém é perguntado "quem pagou?"', !envios.some(e => /quem pagou/i.test(e.texto)))
  ok('o grupo de leitura não vira "o grupo dos comprovantes" do robô', memoria.grupoLembrado() !== LEITURA)
}

// ── 2. Falta a obra: pergunta no destino, e quem está lá responde ─────────
{
  zerar()
  await noGrupoDeLeitura('5511977771111', 'João Pedreiro', { comFoto: true, texto: 'cimento 80' })
  ok('não lança sem a obra', lancs().length === 0)
  ok('a pergunta sai no grupo de conversa, com o cabeçalho', envios.length === 1 && envios[0].para === CONVERSA
    && envios[0].texto.includes('Do grupo "Comprovantes Pgto obras"') && /De qual \*obra\*/.test(envios[0].texto))

  // Quem responde não é quem mandou: é o dono, no grupo de conversa, citando.
  const ditos = await noDestino(DONO, 'haia', envios[0].id)
  ok('respondido citando, no destino, lança', lancs().length === 1 && campoDe(lancs()[0].corpo, 'obra') === HAIA)
  ok('e a confirmação volta para quem respondeu', ditos.some(t => /aguardando sua aprovação/.test(t)))
  ok('ainda como pago pela empresa, e com o telefone de quem MANDOU a foto',
    campoDe(lancs()[0].corpo, 'empresaPagou') === 'true' && campoDe(lancs()[0].corpo, 'enviadoPor') === '5511977771111')
}
{
  // Sem citar: só uma pergunta no ar, e quem responde não tem nada próprio esperando.
  zerar()
  await noGrupoDeLeitura('5511977771111', 'João', { comFoto: true, texto: 'cimento 80' })
  await noDestino('5511966662222', 'tsuya')
  ok('resposta sem citação, com uma só pergunta no ar, também lança', lancs().length === 1 && campoDe(lancs()[0].corpo, 'obra') === OBRAS[0])
}

// ── 3. A descrição que vem depois da foto ─────────────────────────────────
{
  zerar()
  await noGrupoDeLeitura('5511977771111', 'João', { comFoto: true })
  ok('foto sem legenda: espera, sem perguntar nada ainda', envios.length === 0 && lancs().length === 0)
  await noGrupoDeLeitura('5511966662222', 'Maria', { texto: 'tsuya areia 90' })      // OUTRA pessoa
  ok('texto de outra pessoa não é a descrição', lancs().length === 0)
  await noGrupoDeLeitura('5511977771111', 'João', { texto: 'haia areia 90' })        // a mesma
  ok('texto de quem mandou a foto, logo depois, é a descrição', lancs().length === 1 && campoDe(lancs()[0].corpo, 'obra') === HAIA)
  ok('e aparece no cabeçalho da confirmação', envios.at(-1).texto.includes('"haia areia 90"'))
}
{
  zerar()
  await noGrupoDeLeitura('5511977771111', 'João', { comFoto: true })
  await espera(120)
  ok('sem descrição no prazo: aí pergunta, no destino', envios.length === 1 && envios[0].para === CONVERSA && envios[0].texto.includes('(sem legenda)'))
}

// ── 4. No grupo de leitura, nada mais acontece ────────────────────────────
{
  zerar()
  for (const texto of ['ping', 'pendentes', 'cancelar tudo', 'bom dia pessoal', 'valor 1800', 'apagar', 'sim']) {
    const r = await noGrupoDeLeitura('5511977771111', 'João', { texto })
    ok(`"${texto}" no grupo de leitura: nenhuma resposta, nenhum efeito`, r === null && envios.length === 0 && chamadas.filter(c => c.metodo !== 'GET').length === 0)
  }
}

// ── 5. Corrigir citando a confirmação, no destino ─────────────────────────
{
  zerar()
  await noGrupoDeLeitura('5511977771111', 'João', { comFoto: true, texto: 'haia cimento 250' })
  const confirmacao = envios[0]
  // Um colega do grupo de conversa que não mandou a foto nem está na lista por número.
  const ditos = await noDestino('5511966662222', 'valor 300', confirmacao.id)
  const patch = chamadas.find(c => c.metodo === 'PATCH')
  ok('quem está no destino corrige citando a confirmação', Boolean(patch) && /R\$ 250,00 → R\$ 300,00/.test(ditos.join('\n')))
  ok('e o sistema recebe o telefone de quem PEDIU', JSON.parse(patch?.corpo ?? '{}').enviadoPor === '5511966662222')
  // Mas de OUTRA conversa, não.
  chamadas.length = 0
  const fora = await noDestino('5511966662222', 'valor 999', confirmacao.id, { chat: '456@g.us' })
  ok('de outra conversa, não', !chamadas.some(c => c.metodo === 'PATCH') && fora.length === 0)
}

// ── 6. As opções ──────────────────────────────────────────────────────────
{
  zerar()
  process.env.GASTOS_LEITURA_CONFIRMA = 'off'
  await noGrupoDeLeitura('5511977771111', 'João', { comFoto: true, texto: 'haia cimento 250' })
  ok('confirmação desligada: lança calado', lancs().length === 1 && envios.length === 0)
  await noGrupoDeLeitura('5511977771111', 'João', { comFoto: true, texto: 'cimento 80' })
  ok('mas a pergunta continua saindo', envios.length === 1 && /De qual \*obra\*/.test(envios[0].texto))
}
{
  zerar()
  process.env.GASTOS_LEITURA_PAGADOR = 'perguntar'
  await noGrupoDeLeitura('5511977771111', 'João', { comFoto: true, texto: 'haia cimento 250' })
  ok('com GASTOS_LEITURA_PAGADOR=perguntar, pergunta quem pagou (no destino)', lancs().length === 0 && envios.length === 1 && /quem pagou/i.test(envios[0].texto))
}
{
  zerar()
  await noGrupoDeLeitura('5511977771111', 'João', { comFoto: true, texto: 'haia cimento 250 pago por Ana' })
  ok('"pago por Ana" na legenda ganha de "a empresa pagou"', campoDe(lancs()[0]?.corpo ?? '', 'pagoPor') === 'Ana' && campoDe(lancs()[0].corpo, 'empresaPagou') === null)
}

// ── 7. Destino no PRIVADO do dono ─────────────────────────────────────────
{
  zerar()
  process.env.GASTOS_LEITURA_DESTINO = DONO
  await noGrupoDeLeitura('5511977771111', 'João', { comFoto: true, texto: 'cimento 80' })
  ok('a pergunta vai para o privado do dono', envios.length === 1 && envios[0].para === DONO && /De qual \*obra\*/.test(envios[0].texto))

  const noPrivado = { chat: DONO, de: DONO, ehGrupo: false, texto: 'haia' }
  ok('texto no privado passa a ser assunto de comprovante enquanto há pergunta ali', esperaRespostaDe(noPrivado))
  ok('mas só para quem está na lista por número', !esperaRespostaDe({ ...noPrivado, de: '5511977771111' }))
  await noDestino(DONO, 'haia', null, { chat: DONO, ehGrupo: false })
  ok('e a resposta no privado lança', lancs().length === 1 && campoDe(lancs()[0].corpo, 'obra') === HAIA)
  ok('respondido, o privado volta a não ser assunto de comprovante', !esperaRespostaDe(noPrivado))
  ok('quem não está na lista por número não responde pelo privado', !esperaRespostaDe({ chat: DONO, de: '5511900000000', ehGrupo: false }))
}
{
  // O WhatsApp entrega o número do dono SEM o nono dígito: tem de casar igual.
  zerar()
  process.env.GASTOS_LEITURA_DESTINO = DONO                // configurado com o 9: 5511988880000
  const semNono = '551188880000'
  await noGrupoDeLeitura('5511977771111', 'João', { comFoto: true, texto: 'cimento 80' })
  ok('sem o nono dígito, ainda é reconhecido como o dono', esperaRespostaDe({ chat: semNono, de: semNono, ehGrupo: false }))
  await noDestino(semNono, 'haia', null, { chat: semNono, ehGrupo: false })
  ok('e a resposta lança', lancs().length === 1 && campoDe(lancs()[0].corpo, 'obra') === HAIA)
}
{
  // Destino é o privado do dono: no privado de OUTRA pessoa da lista, nada muda.
  zerar()
  process.env.GASTOS_LEITURA_DESTINO = DONO
  await noGrupoDeLeitura('5511977771111', 'João', { comFoto: true, texto: 'cimento 80' })
  ok('a pergunta foi só para o dono', envios.length === 1 && envios[0].para === DONO)
  ok('outra conversa privada não é tratada como resposta', !esperaRespostaDe({ chat: '5511966662222', de: '5511966662222', ehGrupo: false }))
}

// ── 8. Sem destino, não lê — e diz por quê ────────────────────────────────
{
  zerar()
  delete process.env.GASTOS_LEITURA_DESTINO
  const r = await noGrupoDeLeitura('5511977771111', 'João', { comFoto: true, texto: 'haia cimento 250' })
  ok('sem destino configurado (e sem grupo conhecido): não lança nem fala', r === null && lancs().length === 0 && envios.length === 0)
  process.env.GASTOS_LEITURA_DESTINO = LEITURA
  await noGrupoDeLeitura('5511977771111', 'João', { comFoto: true, texto: 'haia cimento 250' })
  ok('destino apontando para o próprio grupo de leitura é recusado', lancs().length === 0 && envios.length === 0)
}

// ── 9. As travas ──────────────────────────────────────────────────────────
{
  zerar()
  ok('grupo de leitura pelo identificador', ehGrupoDeLeitura(LEITURA) && !ehGrupoDeLeitura(CONVERSA))
  ok('com o coringa, só o identificador credencia', podeLancarGasto({ de: '5511977771111', chat: LEITURA, chatNome: 'x', ehGrupo: true }))
  // Um grupo criado por qualquer um, com o mesmo NOME: não vale.
  const avisos = []
  const avisoOriginal = console.warn
  console.warn = (...a) => avisos.push(a.join(' '))
  const falso = { de: '5599999999999', chat: '120363999999999999@g.us', chatNome: 'Comprovantes Pgto obras', ehGrupo: true }
  const passou = podeLancarGasto(falso)
  podeLancarGasto(falso)
  console.warn = avisoOriginal
  ok('grupo de mesmo NOME criado por outra pessoa não é lido', passou === false)
  ok('e o log diz o identificador, para copiar — uma vez só', avisos.length === 1 && avisos[0].includes('120363999999999999@g.us') && avisos[0].includes('GASTOS_GRUPOS_LEITURA'))

  // A última trava: mesmo que algo aponte para o grupo de leitura, nada sai.
  let vazou = false
  const erroOriginal = console.error
  console.error = () => {}
  const id = await avisar({ chat: LEITURA, enviar: async () => { vazou = true; return { id: 'x' } } }, 'não era para sair')
  console.error = erroOriginal
  ok('falar num grupo de leitura é bloqueado na saída', vazou === false && id === null)
}

ok('em todo o teste, NADA foi dito no grupo de leitura', ditoNoGrupoDeLeitura.length === 0 && !envios.some(e => e.para === LEITURA))

_limparPendentes()
srv.close()
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
