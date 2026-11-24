/**
 * O grupo "Comprovantes" de verdade — cada caso em que o robô foi burro,
 * reproduzido com as mesmas frases.
 *
 * Tirado da conversa exportada em 24/11/2026. Para cada caso, o que ele
 * fazia está no comentário; o teste confere o que tem de fazer agora.
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASTA = mkdtempSync(join(tmpdir(), 'teste-conversa-real-'))
process.env.GASTOS_PENDENTES_DIR = PASTA
process.env.GASTOS_MEMORIA = join(PASTA, 'memoria-gastos.json')
process.env.GEMINI_API_KEY = ''
process.env.GASTOS_AUTORIZADOS = '*'
process.env.GASTOS_GRUPOS = '123@g.us'
process.env.OBRAS_API_TOKEN = 'token-de-teste'
process.env.GASTOS_ESPERA_DESCRICAO_MS = '80'

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

const EGILDO = 'EE VER EGILDO PASCHOALUCCI'
const TOSCHI = 'EE OSWALDO LUIZ SANCHES TOSCHI'
const FRANCISCO = 'EE DR FRANCISCO PEREIRA DA ROCHA'
const ITAPEVI = 'Escola Ambiental - Itapevi'
const BURITAMA = 'CEO Buritama – Reforma'
const TSUYA = 'EE PROFA TSUYA OHNO KIMURA'
const HAIA = 'EE/ETEC AGUIA DE HAIA'
const OBRAS = [
  { nome: EGILDO, endereco: 'Rua Sete de Setembro, 45 - Pereiras - SP' },
  { nome: TOSCHI, endereco: 'Rua Benedito Brito, 300 - Praia Grande - SP' },
  { nome: FRANCISCO, endereco: 'Av. Padre Anchieta, 900 - Peruíbe - SP' },
  { nome: ITAPEVI, endereco: 'Estrada do Tanque, 10 - Itapevi - SP' },
  { nome: BURITAMA, endereco: 'Rua XV, 10', municipio: 'Buritama' },
  { nome: TSUYA, endereco: 'Rua Tsuya Ohno, 100 - Bastos - SP' },
  { nome: HAIA, endereco: 'Av. Brasil, 500 - Bastos/SP' },
]
const SOCIOS = ['Claudio Fernandes', 'Estevão', 'Paulo Freire']

const chamadas = []
/** O que a "IA" lê de cada foto: por padrão, nada. */
const srv = createServer((req, res) => {
  let corpo = ''
  req.on('data', c => { corpo += c })
  req.on('end', () => {
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    chamadas.push({ url: req.url, corpo })
    const campo = (n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null
    if (req.url.endsWith('/comprovantes/obras')) return json(200, { obras: OBRAS.map(o => o.nome), detalhes: OBRAS, pagadores: SOCIOS })
    if (req.url.includes('/comprovantes/lancados')) return json(200, { lancados: [] })
    if (req.url.endsWith('/comprovantes/lancar')) {
      const obra = campo('obra')
      const extras = (campo('rateio') ?? '').split(',').map(x => x.trim()).filter(Boolean)
      const todas = [obra, ...extras]
      const valor = Number(campo('valor'))
      return json(201, {
        ok: true, id: `g${chamadas.length}`, obra, obras: todas, pagoPor: campo('pagoPor'),
        rateio: todas.map(o => ({ obra: o, valor: valor / todas.length })),
        enviadoPor: null,
        mensagem: todas.length > 1 ? `Rateado entre ${todas.length} obras, aguardando sua aprovação.` : `Lançado em ${obra}, aguardando sua aprovação.`,
      })
    }
    json(201, { ok: true, id: 'c1', mensagem: 'Comprovante recebido.' })
  })
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
process.env.OBRAS_API_URL = `http://127.0.0.1:${srv.address().port}`

const { tratar, chaveDoRemetente, arquivoACaminho, _limparPendentes } = await import('../src/comprovantes/index.js')
const { _limparCacheObras } = await import('../src/comprovantes/obras-client.js')
const { _esquecerACaminho } = await import('../src/comprovantes/a-caminho.js')
const memoria = await import('../src/comprovantes/memoria.js')
const { lerConversa, comprovantesDaConversa } = await import('../src/comprovantes/exportacao.js')

const espera = (ms) => new Promise(r => setTimeout(r, ms))
const lancs = () => chamadas.filter(c => c.url.endsWith('/lancar'))
const caixa = () => chamadas.filter(c => c.url.endsWith('/receber'))
const campoDe = (corpo, n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null

let nMsg = 0
const GRUPO = '123@g.us'
function pessoa(de = '5511977770000') {
  chamadas.length = 0
  _limparPendentes(); _limparCacheObras(); memoria._limpar(); _esquecerACaminho()
  const ditos = []
  let n = 0
  const enviarResposta = async (t) => { ditos.push(t); return { id: `bot-${++n}` } }
  const guardar = (r) => { if (typeof r === 'string') ditos.push(r); return r }
  const base = { chat: GRUPO, chatNome: 'Comprovantes', ehGrupo: true, de, telefoneConhecido: true, enviarResposta, chaveRemetente: chaveDoRemetente(GRUPO, `${de}@s.whatsapp.net`) }
  return {
    ditos, base,
    /** Uma foto. Com `semEsperar`, não espera a resposta (a foto sem legenda fica esperando a descrição). */
    foto: async (texto, { semEsperar = false, enviadoEm } = {}) => {
      const p = tratar({ ...base, arquivo: Buffer.from(`foto-${++nMsg}`), nomeArquivo: 'c.jpg', tipo: 'image/jpeg', texto, idMensagem: `f-${nMsg}`, enviadoEm: enviadoEm ?? Date.now() })
      if (semEsperar) { p.then(guardar); return `f-${nMsg}` }
      guardar(await p)
      return `f-${nMsg}`
    },
    diz: async (texto, { citando, enviadoEm } = {}) => guardar(await tratar({ ...base, texto, idMensagem: `t-${++nMsg}`, respondendoA: citando ?? null, enviadoEm: enviadoEm ?? Date.now() })),
  }
}

// ── 1. "Caixa da empresa" ─────────────────────────────────────────────────
// Antes: virava descrição ("Marmita Caixa da empresa") e o gasto entrava
// REEMBOLSÁVEL, com aviso de que o reembolso ficou no nome de quem aprova.
for (const resposta of ['Caixa da empresa', 'Caixa empresa', 'caixa empresa', 'pelo caixa', 'a empresa pagou']) {
  const p = pessoa()
  await p.foto('Marmita peruibe 1100')
  ok(`pergunta quem pagou (antes de "${resposta}")`, p.ditos.some(t => /quem pagou/i.test(t)))
  await p.diz(resposta); await espera(20)
  const l = lancs()[0]?.corpo ?? ''
  ok(`"${resposta}": lança como pago pela EMPRESA`, campoDe(l, 'empresaPagou') === 'true' && campoDe(l, 'pagoPor') === null)
  ok(`"${resposta}": a descrição continua "Marmita"`, campoDe(l, 'descricao') === 'Marmita')
  ok(`"${resposta}": sem aviso de reembolso`, !p.ditos.some(t => /reembolso/i.test(t)))
}
{
  // Na legenda, ou junto da resposta da obra: nem pergunta quem pagou.
  const p = pessoa()
  await p.foto('Funcionário demitido 537,36'); await espera(20)
  await p.diz('praia grande, caixa empresa'); await espera(20)
  const l = lancs()[0]?.corpo ?? ''
  ok('"praia grande, caixa empresa": obra E empresa, sem perguntar quem pagou',
    campoDe(l, 'obra') === TOSCHI && campoDe(l, 'empresaPagou') === 'true' && !p.ditos.some(t => /quem pagou/i.test(t)))
  ok('e a descrição não leva "caixa empresa"', !/caixa/i.test(campoDe(l, 'descricao') ?? ''))
}

// ── 2. Ratear ─────────────────────────────────────────────────────────────
{
  // Antes: pedia o valor, quem pagou, e depois a obra, com a lista inteira.
  const p = pessoa()
  await p.foto('Pedagio mês de outubro, ratear entre todas as obras 925,57'); await espera(20)
  await p.diz('Caixa empresa'); await espera(20)
  const l = lancs()[0]?.corpo ?? ''
  ok('"ratear entre todas as obras": rateado entre as 7', campoDe(l, 'obra') === EGILDO && (campoDe(l, 'rateio') ?? '').split(',').length === 6)
  ok('com a descrição limpa', campoDe(l, 'descricao') === 'Pedagio mês de outubro')
  ok('e não perguntou a obra', !p.ditos.some(t => /De qual \*obra\*/.test(t)))
}
{
  // Antes: "Ratear entre todas, menos Itapevi" foi lançado INTEIRO em Itapevi.
  const p = pessoa()
  await p.foto('pedágio 125,42'); await espera(20)
  await p.diz('Ratear entre todas, menos Itapevi'); await espera(20)
  await p.diz('Caixa empresa'); await espera(20)
  const l = lancs()[0]?.corpo ?? ''
  const todas = [campoDe(l, 'obra'), ...(campoDe(l, 'rateio') ?? '').split(',')]
  ok('"todas, menos Itapevi": rateado entre as 6, SEM Itapevi', todas.length === 6 && !todas.includes(ITAPEVI))
}
{
  // Antes: "1 e 2, ratear quem pagou foi o Estevão" virou R$ 2,00, descrição "00, 1 e, ratear".
  const p = pessoa()
  await p.foto('Rogerio Serralheiro Bastos 4000,00'); await espera(20)
  ok('cidade com duas obras: pergunta entre elas', p.ditos.some(t => /mais de uma obra/.test(t)))
  await p.diz('1 e 2, ratear quem pagou foi o Estevão'); await espera(20)
  const l = lancs()[0]?.corpo ?? ''
  ok('"1 e 2": rateio entre as duas da lista', [campoDe(l, 'obra'), campoDe(l, 'rateio')].join(',') === `${TSUYA},${HAIA}`)
  ok('o valor continua R$ 4.000', campoDe(l, 'valor') === '4000')
  ok('e quem pagou foi o Estevão', campoDe(l, 'pagoPor') === 'Estevão')
}
{
  const p = pessoa()
  await p.foto('Thiago Encarregado Bastos 4000,00'); await espera(20)
  await p.diz('as duas'); await espera(20)
  await p.diz('2'); await espera(20)
  ok('"as duas": rateio entre as duas', campoDe(lancs()[0]?.corpo ?? '', 'rateio') === HAIA)
  ok('e NÃO aprende "Thiago Encarregado Bastos" como apelido de obra', !p.ditos.some(t => /anotei que/i.test(t)) && !Object.keys(memoria.apelidosAprendidos()).length)
}

// ── 3. Vários esperando, sem citação ──────────────────────────────────────
{
  // Antes: "Tenho 2 comprovantes esperando… Esta é de qual?", cinco vezes.
  const p = pessoa()
  await p.foto('Funcionário demitido 690,90'); await espera(20)
  await p.foto('Funcionário demitido 76,76'); await espera(20)
  await p.diz('todos são de praia grande'); await espera(30)
  ok('"todos são de praia grande": vale para os dois', p.ditos.filter(t => /quem pagou/i.test(t)).length === 2)
  await p.diz('todos caixa empresa'); await espera(30)
  ok('"todos caixa empresa": os dois lançados em Praia Grande, pagos pela empresa',
    lancs().length === 2 && lancs().every(c => campoDe(c.corpo, 'obra') === TOSCHI && campoDe(c.corpo, 'empresaPagou') === 'true'))
}
{
  const p = pessoa()
  await p.foto('Funcionário demitido 690,90'); await espera(20)
  await p.foto('Funcionário demitido 76,76'); await espera(20)
  await p.diz('praia grande'); await espera(20)
  const lista = p.ditos.at(-1) ?? ''
  ok('"praia grande" sem citar, com dois iguais esperando: pergunta qual — dizendo o que falta', /Esta é de qual/.test(lista) && /falta a obra/.test(lista))
  await p.diz('1 praia grande'); await espera(20)
  ok('"1 praia grande": o número escolhe, e o resto é a resposta', p.ditos.some(t => /quem pagou/i.test(t) && /R\$ 690,90/.test(t)))
}
{
  // Um esperando "quem pagou?", outro esperando a obra: "caixa empresa" só serve para um.
  const p = pessoa()
  await p.foto('Funcionário demitido praia grande 690,90'); await espera(20)
  await p.foto('Funcionário demitido 76,76'); await espera(20)
  await p.diz('caixa empresa'); await espera(20)
  ok('"caixa empresa": vai para o que espera "quem pagou?", sem perguntar qual', lancs().length === 1
    && campoDe(lancs()[0].corpo, 'valor') === '690.9' && !p.ditos.some(t => /Esta é de qual/.test(t)))
}

// ── 4. Pergunta não é resposta ────────────────────────────────────────────
{
  // Antes: "algum ficou sem lançar?" foi lido como resposta, e o comprovante foi para a caixa.
  const p = pessoa()
  await p.foto('Rogerio Serralheiro 4000'); await espera(20)
  const r = await p.diz('algum ficou sem lançar?'); await espera(20)
  ok('"algum ficou sem lançar?": mostra o que está esperando', /Tenho 1 comprovante/.test(r ?? ''))
  ok('e NÃO manda nada para a caixa', caixa().length === 0 && lancs().length === 0)
  const r2 = await p.diz('quais aguardam lançamento?')
  ok('"quais aguardam lançamento?": idem', /Tenho 1 comprovante/.test(r2 ?? ''))
}
{
  const p = pessoa()
  const r = await p.diz('aprovar gasto')
  ok('"aprovar gasto": diz onde se aprova', /Aprovar gastos/.test(r ?? ''))
}
{
  // Antes: "Pode manda para o sistema" virava resposta, e a pergunta voltava.
  const p = pessoa()
  await p.foto('pedágio 125,42'); await espera(20)
  await p.diz('Pode manda para o sistema'); await espera(20)
  ok('"Pode manda para o sistema": vai para a caixa', caixa().length === 1 && lancs().length === 0)
}
{
  const p = pessoa()
  // Com "caixa empresa" na legenda, não há pergunta de quem pagou no meio.
  await p.foto('cimento haia 250 caixa empresa'); await p.foto('cimento haia 250 caixa empresa'); await espera(20)
  ok('o segundo igual vira pergunta de repetido', p.ditos.some(t => /outro pagamento, ou é o mesmo/.test(t)))
  await p.diz('sim é outro pagamento'); await espera(20)
  ok('"sim é outro pagamento" responde à pergunta de repetido', lancs().length === 2 && campoDe(lancs()[1].corpo, 'confirmadoOutro') === 'true')
}

// ── 5. A legenda que chega antes da foto terminar de baixar ───────────────
{
  // Antes: "Material, pereiras", 8 s depois do PDF, foi ignorada.
  const p = pessoa()
  const enviadoFoto = Date.now()
  const idFoto = `f-${++nMsg}`
  const soltar = arquivoACaminho(p.base.chaveRemetente, idFoto, enviadoFoto)   // o conector anota: está baixando
  const texto = p.diz('Material, pereiras 148,08 caixa empresa', { enviadoEm: enviadoFoto + 8000 })
  await espera(50)                                                             // a foto ainda baixando…
  ok('o texto ESPERA a foto que está baixando', lancs().length === 0)
  tratar({ ...p.base, arquivo: Buffer.from('pdf'), nomeArquivo: 'c.pdf', tipo: 'application/pdf', texto: null, idMensagem: idFoto, enviadoEm: enviadoFoto })
  await texto; await espera(30); soltar()
  ok('chegada a foto, o texto vira a legenda dela', lancs().length === 1 && campoDe(lancs()[0].corpo, 'obra') === EGILDO && campoDe(lancs()[0].corpo, 'valor') === '148.08')
}
{
  // Antes: "125,42 pedágios…", legenda da foto NOVA, foi parar no comprovante ANTERIOR.
  const p = pessoa()
  await p.foto('Pedagio mês de outubro'); await espera(20)                     // fica esperando a obra e o valor
  ok('o primeiro ficou esperando', p.ditos.some(t => /faltou a \*obra\* e o \*valor\*/.test(t)))
  await p.foto(null, { semEsperar: true }); await espera(10)                   // foto nova, sem legenda
  await p.diz('125,42 pedágios ratear com todas as obras'); await espera(30)
  await p.diz('Caixa empresa', { citando: null }); await espera(30)
  const l = lancs()[0]?.corpo ?? ''
  ok('a legenda vai para a foto NOVA', campoDe(l, 'valor') === '125.42' && (campoDe(l, 'rateio') ?? '').split(',').length === 6)
  ok('e o comprovante anterior continua esperando, sem mudar', caixa().length === 0 && lancs().length === 1)
}

// ── 6. A exportação do iPhone com AM/PM ───────────────────────────────────
{
  const conversa = [
    '[01/09/2026, 9:55:59\u202fAM] Comprovantes: \u200eVocê criou o grupo “Comprovantes”',
    '\u200e[01/09/2026, 10:38:27\u202fAM] 卡尔 🇧🇷🇨🇳: restaurante Praia Grande \u200e<anexado: 00000003-PHOTO-2026-09-01-10-38-26.jpg>',
    '\u200e[24/11/2026, 7:09:20\u202fPM] 卡尔 🇧🇷🇨🇳: Comprovante_20261124_185841.pdf • \u200e1 página \u200e<anexado: 00000081-Comprovante_20261124_185841.pdf>',
    '[24/11/2026, 12:05:00\u202fPM] RH Construtora: meio-dia',
    '[24/11/2026, 12:30:00\u202fAM] RH Construtora: meia-noite e meia',
  ].join('\n')
  const msgs = lerConversa(conversa)
  ok('AM/PM: todas as linhas lidas', msgs.length === 5)
  ok('10:38 AM é 10:38', msgs[1].quando === Date.parse('2026-09-01T10:38:27-03:00'))
  ok('7:09 PM é 19:09', msgs[2].quando === Date.parse('2026-11-24T19:09:20-03:00'))
  ok('12:05 PM é meio-dia', msgs[3].quando === Date.parse('2026-11-24T12:05:00-03:00'))
  ok('12:30 AM é meia-noite e meia', msgs[4].quando === Date.parse('2026-11-24T00:30:00-03:00'))
  const r = comprovantesDaConversa(conversa, { desde: '2026-09-01' })
  ok('e os comprovantes saem, com a legenda', r.comprovantes.length === 2 && r.comprovantes[0].legenda === 'restaurante Praia Grande')
}

_limparPendentes()
srv.close()
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
