/**
 * Pago × a pagar.
 *
 * No grupo dos comprovantes chega também o boleto que ainda vence, o
 * orçamento, a nota a prazo — e o robô lançava tudo como gasto. O que se
 * confere aqui:
 *
 *  - boleto e orçamento SEM prova de pagamento não viram gasto: vão para a
 *    caixa, marcados, e "pago" depois lança normalmente;
 *  - nota fiscal a vencer vira pergunta;
 *  - o que a pessoa escreveu ganha da imagem;
 *  - NA DÚVIDA, o comportamento de antes: leitura que falhou, tipo "outro",
 *    campo que não veio — nada disso segura um comprovante.
 *
 * A IA é de mentira: "lê" o que o próprio arquivo de teste traz dentro.
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASTA = mkdtempSync(join(tmpdir(), 'teste-a-pagar-'))
process.env.GASTOS_PENDENTES_DIR = PASTA
process.env.GASTOS_MEMORIA = join(PASTA, 'memoria-gastos.json')
process.env.GEMINI_API_KEY = 'chave-de-teste'
process.env.GASTOS_AUTORIZADOS = '*'
process.env.GASTOS_GRUPOS = '123@g.us'
process.env.OBRAS_API_TOKEN = 'token-de-teste'
process.env.GASTOS_ESPERA_DESCRICAO_MS = '50'
process.env.IA_VISAO_TENTATIVAS = '1'
// Curtos, para o último caso ver o que a ronda faz. Ela só é ligada lá.
process.env.GASTOS_COBRAR_APOS_MS = '80'
process.env.GASTOS_DESISTIR_APOS_MS = '300'
process.env.GASTOS_RONDA_MS = '40'

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

const OBRAS = ['EE PROFA TSUYA OHNO KIMURA', 'EE/ETEC AGUIA DE HAIA']
const HAIA = OBRAS[1]
const DIA = 24 * 60 * 60 * 1000
const emBrasilia = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ms))
const daquiA = (dias) => emBrasilia(Date.now() + dias * DIA)
const curta = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

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
      let dentro = {}
      try { dentro = JSON.parse(Buffer.from(JSON.parse(corpo).contents[0].parts[0].inline_data.data, 'base64').toString('utf8')) } catch { /* não é de teste */ }
      if (dentro.falha) return json(503, { error: 'sobrecarregado' })
      // `cru`: a resposta do modelo exatamente como o teste quer, sem os campos de costume.
      const leitura = dentro.cru ?? {
        valor: 0, data: '', estabelecimento: '', categoria: '', documento: '', cnpj: '', formaPagamento: '',
        tipoDocumento: 'comprovante_pagamento', pagamentoComprovado: true, vencimento: '', confianca: 'baixa', observacao: '',
        ...dentro.leitura,
      }
      return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(leitura) }] } }] })
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

const { tratar, iniciarRonda, _limparPendentes } = await import('../src/comprovantes/index.js')
const { _limparCacheObras } = await import('../src/comprovantes/obras-client.js')
const memoria = await import('../src/comprovantes/memoria.js')
const pendentes = await import('../src/comprovantes/pendentes.js')
const { processar, processarUmaVez } = await import('../src/comprovantes/processar.js')
const { pagoOuAPagar, RESPOSTA_PAGO, RESPOSTA_A_PAGAR } = await import('../src/comprovantes/a-pagar.js')
const { conferir } = await import('../src/comprovantes/ia-visao.js')

const base = { chat: '123@g.us', chatNome: 'Comprovantes', ehGrupo: true }
const espera = (ms) => new Promise(r => setTimeout(r, ms))
let nArq = 0
const doc = (leitura = {}) => Buffer.from(JSON.stringify({ leitura, n: ++nArq }))
const BOLETO = { tipoDocumento: 'boleto', pagamentoComprovado: false, valor: 400 }

function pessoa(de) {
  chamadas.length = 0
  _limparPendentes()
  _limparCacheObras()
  memoria._limpar()
  const ditos = []
  const enviadas = []
  let n = 0
  const enviarResposta = async (t) => { const id = `bot-${de}-${++n}`; ditos.push(t); enviadas.push({ id, texto: t }); return { id } }
  const guardar = (r) => { if (typeof r === 'string') ditos.push(r); return r }
  return {
    ditos,
    foto: async (texto, arquivo) => {
      const idMensagem = `foto-${de}-${++nArq}`
      guardar(await tratar({ ...base, de, arquivo, nomeArquivo: 'c.jpg', tipo: 'image/jpeg', texto, idMensagem, enviarResposta }))
      return idMensagem
    },
    diz: async (texto, citando) => guardar(await tratar({ ...base, de, texto, idMensagem: `t-${Math.random()}`, respondendoA: citando ?? null, enviarResposta })),
    idDe: (padrao) => enviadas.filter(e => padrao.test(e.texto)).at(-1)?.id ?? null,
  }
}

const lancs = () => chamadas.filter(c => c.url.endsWith('/lancar'))
const caixa = () => chamadas.filter(c => c.url.endsWith('/receber'))
/** O campo `texto` inteiro (tem várias linhas). */
const textoDaCaixa = (c) => /name="texto"\r?\n\r?\n([\s\S]*?)\r?\n--/.exec(c?.corpo ?? '')?.[1] ?? ''
const campoDe = (corpo, n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null

// ── 1. Boleto sem prova de pagamento: não é gasto ─────────────────────────
{
  const p = pessoa('5511900000601')
  const vence = daquiA(10)
  const idFoto = await p.foto('haia boleto energia 400', doc({ ...BOLETO, vencimento: vence }))
  await espera(20)
  ok('boleto não pago NÃO é lançado', lancs().length === 0)
  ok('vai para a caixa', caixa().length === 1)
  ok('com a marca no COMEÇO do texto', textoDaCaixa(caixa()[0]).startsWith(`A PAGAR — boleto, vence ${curta(vence)}`))
  ok('e o resto do resumo depois', /AGUIA DE HAIA/.test(textoDaCaixa(caixa()[0])) && /R\$ 400,00/.test(textoDaCaixa(caixa()[0])))
  ok('responde no grupo, com o texto fixo',
    p.ditos.at(-1) === `Isso parece boleto ainda não pago (vence ${curta(vence)}). Não lancei como gasto; deixei na caixa. Se já foi pago, responde *pago*.`)
  ok('não perguntou obra, valor nem nada', p.ditos.length === 1)

  // Outra coisa escrita não muda nada — ele já está onde devia.
  const r = await p.diz('ok obrigado', idFoto); await espera(20)
  ok('resposta que não é "pago" não faz nada', r === null && lancs().length === 0 && caixa().length === 1)

  await p.diz('pago', idFoto); await espera(20)
  ok('"pago" citando o comprovante lança normalmente', lancs().length === 1 && campoDe(lancs()[0].corpo, 'obra') === HAIA && campoDe(lancs()[0].corpo, 'valor') === '400')
  ok('e não manda para a caixa de novo', caixa().length === 1)
}
{
  const p = pessoa('5511900000602')
  await p.foto('haia boleto energia 400', doc(BOLETO)); await espera(20)
  ok('sem vencimento lido: a marca e o aviso saem sem a data',
    /^A PAGAR — boleto\r?\n/.test(textoDaCaixa(caixa()[0])) && p.ditos.at(-1).startsWith('Isso parece boleto ainda não pago. Não lancei'))
  await p.diz('já paguei', p.idDe(/boleto ainda não pago/)); await espera(20)
  ok('"já paguei" citando o AVISO do robô também lança', lancs().length === 1)
}
{
  const p = pessoa('5511900000603')
  await p.foto('haia boleto energia 400', doc(BOLETO)); await espera(20)
  await p.diz('foi pago'); await espera(20)
  ok('"foi pago" sem citar, com um só esperando, lança', lancs().length === 1)
}
{
  // Depois de "pago", o que falta é perguntado como em qualquer comprovante.
  const p = pessoa('5511900000604')
  await p.foto('boleto energia 400', doc(BOLETO)); await espera(20)
  await p.diz('pago'); await espera(20)
  ok('pago, mas sem obra: aí sim pergunta a obra', lancs().length === 0 && p.ditos.some(t => /De qual \*obra\*/.test(t)))
  await p.diz('haia'); await espera(20)
  ok('e lança quando a obra vem', lancs().length === 1)
}

// ── 2. Orçamento ou pedido ────────────────────────────────────────────────
{
  const p = pessoa('5511900000605')
  await p.foto('haia orçamento telhas 2500', doc({ tipoDocumento: 'orcamento_pedido', pagamentoComprovado: false, valor: 2500 })); await espera(20)
  ok('orçamento não é lançado', lancs().length === 0 && caixa().length === 1)
  ok('marca própria na caixa', textoDaCaixa(caixa()[0]).startsWith('ORÇAMENTO/PEDIDO — não é pagamento'))
  ok('e aviso próprio no grupo', p.ditos.at(-1) === 'Isso parece orçamento ou pedido, não pagamento. Não lancei como gasto; deixei na caixa. Se já foi pago, responde *pago*.')
}

// ── 3. Com prova de pagamento, boleto é gasto ─────────────────────────────
{
  const p = pessoa('5511900000606')
  await p.foto('haia boleto energia 400', doc({ ...BOLETO, pagamentoComprovado: true }))
  ok('boleto com autenticação de pagamento é lançado', lancs().length === 1 && caixa().length === 0)
}

// ── 4. O que a pessoa escreveu ganha da imagem ────────────────────────────
for (const legenda of ['haia energia 400 pago', 'haia energia 400 pix feito', 'haia energia 400 paguei hoje', 'haia energia 400 já foi pago']) {
  const p = pessoa('5511900000607')
  await p.foto(legenda, doc(BOLETO)); await espera(20)
  ok(`legenda "${legenda.slice(17)}": lança sem pergunta`, lancs().length === 1 && caixa().length === 0 && !p.ditos.some(t => /pago\*/.test(t)))
}
{
  // E ao contrário: a pessoa diz que é A PAGAR, mesmo com cara de comprovante.
  const p = pessoa('5511900000608')
  await p.foto('haia energia 400 a pagar', doc({ tipoDocumento: 'comprovante_pagamento', pagamentoComprovado: true })); await espera(20)
  ok('legenda "a pagar" manda para a caixa, não lança', lancs().length === 0 && caixa().length === 1 && textoDaCaixa(caixa()[0]).startsWith('A PAGAR'))
  ok('e confirma o que entendeu', /^Certo — a pagar\. Não lancei como gasto/.test(p.ditos.at(-1) ?? ''))
}
{
  const p = pessoa('5511900000609')
  await p.foto('haia energia 400 ainda não foi pago', doc({ tipoDocumento: 'cupom_fiscal', pagamentoComprovado: true })); await espera(20)
  ok('"ainda não foi pago" não é lido como "pago"', lancs().length === 0 && caixa().length === 1)
}

// ── 5. Nota fiscal a vencer: pergunta ─────────────────────────────────────
{
  const p = pessoa('5511900000610')
  const vence = daquiA(20)
  const NF = { tipoDocumento: 'nota_fiscal', pagamentoComprovado: false, vencimento: vence, valor: 1800 }
  await p.foto('haia cimento 1800', doc(NF)); await espera(20)
  ok('NF com vencimento futuro e sem prova: pergunta', p.ditos.at(-1) === `Essa nota vence ${curta(vence)}. Já foi pago? Responde *pago* ou *a pagar*.`)
  ok('sem lançar e sem mandar para a caixa ainda', lancs().length === 0 && caixa().length === 0)
  await p.diz('talvez'); await espera(20)
  ok('resposta que não responde: a pergunta volta', p.ditos.filter(t => /Já foi pago\?/.test(t)).length === 2 && lancs().length === 0)
  await p.diz('pago'); await espera(20)
  ok('"pago" lança', lancs().length === 1 && caixa().length === 0)
}
{
  const p = pessoa('5511900000611')
  const vence = daquiA(20)
  await p.foto('haia cimento 1800', doc({ tipoDocumento: 'nota_fiscal', pagamentoComprovado: false, vencimento: vence, valor: 1800 })); await espera(20)
  await p.diz('a pagar'); await espera(20)
  ok('"a pagar" manda para a caixa, com a marca da nota', lancs().length === 0 && caixa().length === 1
    && textoDaCaixa(caixa()[0]).startsWith(`A PAGAR — nota fiscal, vence ${curta(vence)}`))
  ok('e depois ainda dá para dizer que foi pago', (await p.diz('pago'), await espera(20), lancs().length === 1))
}
{
  const p = pessoa('5511900000612')
  await p.foto('haia cimento 1800', doc({ tipoDocumento: 'nota_fiscal', pagamentoComprovado: false, vencimento: daquiA(20), valor: 1800 })); await espera(20)
  await p.diz('não'); await espera(20)
  ok('aqui "não" quer dizer "não foi pago": caixa, sem lançar', lancs().length === 0 && caixa().length === 1)
}
{
  const p = pessoa('5511900000613')
  await p.foto('haia cimento 1800', doc({ tipoDocumento: 'nota_fiscal', pagamentoComprovado: false, vencimento: daquiA(-5), valor: 1800 }))
  ok('NF com vencimento no passado segue como sempre', lancs().length === 1)
}
{
  const p = pessoa('5511900000614')
  await p.foto('haia cimento 1800', doc({ tipoDocumento: 'nota_fiscal', pagamentoComprovado: false, valor: 1800 }))
  ok('NF sem vencimento também', lancs().length === 1)
}
{
  const p = pessoa('5511900000615')
  await p.foto('haia cimento 1800', doc({ tipoDocumento: 'nota_fiscal', pagamentoComprovado: true, vencimento: daquiA(20), valor: 1800 }))
  ok('NF com prova de pagamento não é perguntada', lancs().length === 1)
}

// ── 6. Na dúvida, o comportamento de antes ────────────────────────────────
for (const [nome, leitura] of [
  ['cupom fiscal', { tipoDocumento: 'cupom_fiscal', pagamentoComprovado: false }],
  ['comprovante de pagamento', { tipoDocumento: 'comprovante_pagamento', pagamentoComprovado: true }],
  ['tipo "outro"', { tipoDocumento: 'outro', pagamentoComprovado: false }],
]) {
  const p = pessoa('5511900000616')
  await p.foto('haia compra 90', doc(leitura))
  ok(`${nome}: lança como sempre`, lancs().length === 1 && caixa().length === 0)
}
{
  const p = pessoa('5511900000617')
  await p.foto('haia compra 90', Buffer.from(JSON.stringify({ falha: true, n: ++nArq })))
  ok('a leitura da imagem falhou: lança como sempre', lancs().length === 1 && caixa().length === 0)
}
{
  // O modelo disse "boleto" mas não disse se há prova de pagamento.
  const p = pessoa('5511900000618')
  await p.foto('haia compra 90', Buffer.from(JSON.stringify({ cru: { valor: 90, tipoDocumento: 'boleto', confianca: 'alta' }, n: ++nArq })))
  ok('boleto SEM o modelo afirmar que não foi pago: lança como sempre', lancs().length === 1 && caixa().length === 0)
}
{
  const p = pessoa('5511900000619')
  await p.foto('haia compra 90', Buffer.from(JSON.stringify({ cru: { valor: 90, tipoDocumento: 'duplicata_mercantil', pagamentoComprovado: false, confianca: 'alta' }, n: ++nArq })))
  ok('tipo que não está na lista: lança como sempre', lancs().length === 1)
}

// ── 7. No atraso: mesma regra, sem ficar esperando ────────────────────────
{
  pessoa('5511900000620')
  const ficha = (arquivo) => ({
    chat: '123@g.us', de: 'atraso:123@g.us', arquivo, nomeArquivo: 'c.jpg', tipo: 'image/jpeg', descricao: 'haia boleto energia 400', respostas: [],
    idMensagem: `atraso-${++nArq}`, enviadoEm: Date.now(), criadoEm: Date.now(), atraso: { remetente: 'João', desde: daquiA(-60) },
    empresaPagou: true, pagadorPerguntado: true,
  })
  const r = await processar({ ...ficha(doc({ ...BOLETO, vencimento: daquiA(10) })), id: 'ensaio-1' }, { ensaio: true })
  ok('ensaio do atraso: destino "a pagar", com a marca', r.desfecho === 'a-pagar' && /^A PAGAR — boleto, vence/.test(r.aPagar?.marca ?? ''))
  ok('ensaio não escreve nada', caixa().length === 0 && lancs().length === 0)

  const p = pendentes.guardar(ficha(doc(BOLETO)))
  await processarUmaVez(p)
  ok('ligado: vai para a caixa, marcado, sem lançar', caixa().length === 1 && lancs().length === 0 && textoDaCaixa(caixa()[0]).startsWith('A PAGAR — boleto'))
  ok('e NÃO fica esperando (não segura o lote de perguntas)', pendentes.porId(p.id) === null && p.desfecho === 'a-pagar')
}

// ── 8. As regras, direto ──────────────────────────────────────────────────
{
  const hoje = '2026-11-23'
  const d = (x) => pagoOuAPagar({ hoje, ...x })
  ok('boleto não pago → a pagar', d({ tipoDocumento: 'boleto', pagamentoComprovado: false })?.decisao === 'a-pagar')
  ok('boleto com "não sei" → segue', d({ tipoDocumento: 'boleto', pagamentoComprovado: null }) === null)
  ok('NF que vence hoje não é "futuro"', d({ tipoDocumento: 'nota_fiscal', pagamentoComprovado: false, vencimento: hoje }) === null)
  ok('NF que vence amanhã → pergunta', d({ tipoDocumento: 'nota_fiscal', pagamentoComprovado: false, vencimento: '2026-11-24' })?.decisao === 'perguntar')
  ok('"pago por Ana" na legenda conta como pago', d({ tipoDocumento: 'boleto', pagamentoComprovado: false, escrito: 'haia energia 400 pago por Ana' }) === null)
  ok('"pagamento" e "pagar depois" não são "pago"',
    d({ tipoDocumento: 'boleto', pagamentoComprovado: false, escrito: 'pagamento energia' })?.decisao === 'a-pagar'
    && d({ tipoDocumento: 'boleto', pagamentoComprovado: false, escrito: 'vou pagar depois' })?.decisao === 'a-pagar')
  ok('resposta "pago" vale mais que tudo', d({ tipoDocumento: 'boleto', pagamentoComprovado: false, escrito: 'a pagar', respondeu: 'pago' }) === null)
  ok('sem nada: segue', d({}) === null)

  for (const t of ['pago', 'Pago!', 'já paguei', 'foi pago', 'já foi pago', 'sim', 'paguei', 'quitado']) ok(`"${t}" é resposta de pago`, RESPOSTA_PAGO.test(t))
  for (const t of ['a pagar', 'ainda não', 'não', 'não foi pago', 'em aberto']) ok(`"${t}" é resposta de a pagar`, RESPOSTA_A_PAGAR.test(t) && !RESPOSTA_PAGO.test(t))
  ok('"obrigado" não é nenhuma das duas', !RESPOSTA_PAGO.test('obrigado') && !RESPOSTA_A_PAGAR.test('obrigado'))

  const c = (x) => conferir({ valor: 10, ...x })
  ok('conferir: tipo válido passa', c({ tipoDocumento: 'boleto' })?.tipoDocumento === 'boleto')
  ok('conferir: tipo inventado vira nada', c({ tipoDocumento: 'duplicata' })?.tipoDocumento === null)
  ok('conferir: prova de pagamento só vale como verdadeiro/falso', c({ pagamentoComprovado: false })?.pagamentoComprovado === false
    && c({ pagamentoComprovado: 'nao' })?.pagamentoComprovado === null && c({})?.pagamentoComprovado === null)
  ok('conferir: vencimento no futuro é aceito', c({ vencimento: daquiA(40) })?.vencimento === daquiA(40))
  ok('conferir: vencimento que não é data vira nada', c({ vencimento: '31/12/2026' })?.vencimento === null && c({ vencimento: '2026-02-31' })?.vencimento === null)
  ok('conferir: a data do PAGAMENTO continua sem aceitar futuro', c({ data: daquiA(40) })?.data === null)
}

// ── 9. A ronda não cobra o que já está na caixa ───────────────────────────
{
  const p = pessoa('5511900000621')
  iniciarRonda()
  await p.foto('haia boleto energia 400', doc(BOLETO)); await espera(20)
  ok('está esperando um "pago"', pendentes.quantos() === 1 && caixa().length === 1)
  await espera(200)
  ok('não há lembrete', !p.ditos.some(t => /Lembrete/.test(t)))
  await espera(350)
  ok('passado o prazo, sai da espera em silêncio', pendentes.quantos() === 0 && p.ditos.length === 1)
  ok('sem mandar para a caixa de novo', caixa().length === 1 && lancs().length === 0)
}

_limparPendentes()
srv.close()
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
