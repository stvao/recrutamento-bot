/**
 * O robô aprendendo (24/11/2026):
 *
 *  1. o hábito do fornecedor vem do HISTÓRICO DO SISTEMA — inclusive o que
 *     foi digitado à mão —, e não só do que o robô lançou;
 *  2. pessoa → obra pelo RH ("Vale Rogério": o Rogério está na Haia);
 *  3. a IA lendo a frase inteira, com o código conferindo tudo;
 *  4. hábito MUITO forte lança direto, e diz que foi pelo hábito;
 *  5. o relatório da semana: quanto ele acertou sozinho.
 *
 * Obras, RH e IA são de mentira, num servidor só.
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASTA = mkdtempSync(join(tmpdir(), 'teste-inteligencia-'))
process.env.GASTOS_PENDENTES_DIR = PASTA
process.env.GASTOS_MEMORIA = join(PASTA, 'memoria-gastos.json')
process.env.GEMINI_API_KEY = 'chave-de-teste'
process.env.GASTOS_AUTORIZADOS = '*'
process.env.GASTOS_GRUPOS = '123@g.us'
process.env.OBRAS_API_TOKEN = 'token-de-teste'
process.env.RH_API_TOKEN = 'token-rh'
process.env.GASTOS_ESPERA_DESCRICAO_MS = '50'
process.env.IA_VISAO_TENTATIVAS = '1'
process.env.GASTOS_RELATORIO_PARA = '5511988880000'
delete process.env.GASTOS_HABITO_AUTO

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

const TSUYA = 'EE PROFA TSUYA OHNO KIMURA'
const HAIA = 'EE/ETEC AGUIA DE HAIA'
const FRANCISCO = 'EE DR FRANCISCO PEREIRA DA ROCHA'
const TOSCHI = 'EE OSWALDO LUIZ SANCHES TOSCHI'
const BURITAMA = 'CEO Buritama – Reforma'
const OBRAS = [
  { nome: TSUYA, endereco: 'Rua Tsuya Ohno, 100 - Bastos - SP' },
  { nome: HAIA, endereco: 'Av. Brasil, 500 - Bastos/SP' },
  { nome: FRANCISCO, endereco: 'Av. Padre Anchieta, 900 - Peruíbe - SP' },
  { nome: TOSCHI, endereco: 'Rua Benedito Brito, 300 - Praia Grande - SP' },
  { nome: BURITAMA, municipio: 'Buritama' },
]
const SOCIOS = ['Claudio Fernandes', 'Estevão', 'Paulo Freire']
const DIA = 24 * 60 * 60 * 1000
const diasAtras = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - n * DIA))

// ── O servidor de mentira: Obras, RH e IA ─────────────────────────────────
const chamadas = []
let lancadosNoSistema = []
let pagadores = []
/** RH: nome (minúsculo) → ficha. */
let funcionarios = {}
/** IA da frase: uma função que recebe o pedido em texto e devolve a resposta. */
let respostaDaIa = () => null
const iaFrase = []

const srv = createServer((req, res) => {
  let corpo = ''
  req.on('data', c => { corpo += c })
  req.on('end', () => {
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    const gemini = (obj) => json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] })

    if (req.url.startsWith('/ia')) {
      const partes = JSON.parse(corpo).contents?.[0]?.parts ?? []
      if (partes[0]?.inline_data) {
        // Leitura da imagem: o arquivo de teste traz o que "está escrito nele".
        let leitura = {}
        try { leitura = JSON.parse(Buffer.from(partes[0].inline_data.data, 'base64').toString('utf8')).leitura ?? {} } catch { /* não é de teste */ }
        return gemini({ valor: 0, data: '', estabelecimento: '', categoria: '', documento: '', cnpj: '', formaPagamento: '', tipoDocumento: 'comprovante_pagamento', pagamentoComprovado: true, vencimento: '', confianca: 'baixa', observacao: '', ...leitura })
      }
      const pedido = partes[0]?.text ?? ''
      iaFrase.push(pedido)
      return gemini(respostaDaIa(pedido) ?? { obras: [], valor: 0, pagoPor: '', empresaPagou: false, categoria: '', descricao: '', confianca: 'baixa' })
    }

    if (req.url.startsWith('/api/integracao/quem')) {
      const nome = new URL(req.url, 'http://x').searchParams.get('nome')?.toLowerCase() ?? ''
      return json(200, funcionarios[nome] ?? { tipo: 'desconhecido' })
    }

    chamadas.push({ url: req.url, corpo })
    const campo = (n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null
    if (req.url.endsWith('/comprovantes/obras')) return json(200, { obras: OBRAS.map(o => o.nome), detalhes: OBRAS, pagadores })
    if (req.url.includes('/comprovantes/lancados')) return json(200, { lancados: lancadosNoSistema })
    if (req.url.endsWith('/comprovantes/lancar')) {
      const obra = campo('obra')
      const extras = (campo('rateio') ?? '').split(',').map(x => x.trim()).filter(Boolean)
      return json(201, { ok: true, id: `g${chamadas.length}`, obra, obras: [obra, ...extras], rateio: [obra, ...extras].map(o => ({ obra: o, valor: 1 })), pagoPor: campo('pagoPor'), mensagem: extras.length ? `Rateado entre ${extras.length + 1} obras, aguardando sua aprovação.` : `Lançado em ${obra}, aguardando sua aprovação.` })
    }
    json(201, { ok: true, id: 'c1', mensagem: 'Comprovante recebido.' })
  })
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const URL_BASE = `http://127.0.0.1:${srv.address().port}`
process.env.OBRAS_API_URL = URL_BASE
process.env.RH_API_URL = URL_BASE
process.env.IA_VISAO_ENDPOINT = `${URL_BASE}/ia`

const { tratar, _limparPendentes } = await import('../src/comprovantes/index.js')
const { _limparCacheObras } = await import('../src/comprovantes/obras-client.js')
const { _limparCacheQuem } = await import('../src/rh-client.js')
const memoria = await import('../src/comprovantes/memoria.js')
const { conferirFrase } = await import('../src/comprovantes/ia-frase.js')
const { montarRelatorio, talvezMandar } = await import('../src/comprovantes/relatorio.js')

const espera = (ms) => new Promise(r => setTimeout(r, ms))
const lancs = () => chamadas.filter(c => c.url.endsWith('/lancar'))
const campoDe = (corpo, n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null
let nArq = 0
const cupom = (leitura = {}) => Buffer.from(JSON.stringify({ leitura, n: ++nArq }))

function pessoa({ manterMemoria = false } = {}) {
  chamadas.length = 0
  iaFrase.length = 0
  _limparPendentes(); _limparCacheObras(); _limparCacheQuem()
  if (!manterMemoria) memoria._limpar()
  lancadosNoSistema = []; pagadores = []; funcionarios = {}
  respostaDaIa = () => null
  delete process.env.GASTOS_HABITO_AUTO
  const ditos = []
  let n = 0
  const enviarResposta = async (t) => { ditos.push(t); return { id: `bot-${++n}` } }
  const guardar = (r) => { if (typeof r === 'string') ditos.push(r); return r }
  const base = { chat: '123@g.us', chatNome: 'Comprovantes', ehGrupo: true, de: '5511977770000', enviarResposta }
  return {
    ditos,
    foto: async (texto, arquivo = cupom()) => guardar(await tratar({ ...base, arquivo, nomeArquivo: 'c.jpg', tipo: 'image/jpeg', texto, idMensagem: `f-${++nArq}` })),
    diz: async (texto) => guardar(await tratar({ ...base, texto, idMensagem: `t-${++nArq}`, respondendoA: null })),
  }
}

/** N gastos de um fornecedor numa obra, como o sistema devolve (digitados à mão: sem arquivo). */
const historico = (fornecedor, obra, n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  origem: 'gasto', obra, valor: 100 + i, data: diasAtras(i + 2), descricao: 'compra', fornecedor, documento: null, arquivoHash: null, status: 'APROVADO', ...extra,
}))
const MADEIREIRA = { estabelecimento: 'APP MADEIREIRA EIRELI', valor: 965, confianca: 'alta' }

// ══ 1. O hábito vem do sistema, desde o primeiro dia ══════════════════════
{
  const p = pessoa()
  lancadosNoSistema = historico('App Madeireira Ltda', FRANCISCO, 3)
  await p.foto('madeira', cupom(MADEIREIRA)); await espera(30)
  ok('com 3 lançamentos à mão no sistema, o robô já sugere a obra — sem nunca ter lançado esse fornecedor',
    p.ditos.some(t => t.includes(`É da *${FRANCISCO}*, como das outras vezes?`)))
  ok('e não lança sozinho (3 vezes não é hábito forte)', lancs().length === 0)
  await p.diz('sim'); await espera(30)
  ok('"sim" lança na obra do hábito', lancs().length === 1 && campoDe(lancs()[0].corpo, 'obra') === FRANCISCO)
}
{
  const p = pessoa()
  lancadosNoSistema = [
    ...historico('App Madeireira Ltda', FRANCISCO, 2),
    ...historico('App Madeireira Ltda', FRANCISCO, 3, { status: 'REJEITADO' }),
  ]
  await p.foto('madeira', cupom(MADEIREIRA)); await espera(30)
  ok('gasto REJEITADO no sistema não conta para o hábito', !p.ditos.some(t => /como das outras vezes/.test(t)))
}
{
  const p = pessoa()
  // Um gasto rateado entre duas obras aparece como duas partes com o mesmo arquivo.
  lancadosNoSistema = [
    ...historico('App Madeireira Ltda', FRANCISCO, 2),
    { origem: 'gasto', obra: FRANCISCO, valor: 50, data: diasAtras(1), fornecedor: 'App Madeireira', arquivoHash: 'h-rateio', status: 'PENDENTE' },
    { origem: 'gasto', obra: TOSCHI, valor: 50, data: diasAtras(1), fornecedor: 'App Madeireira', arquivoHash: 'h-rateio', status: 'PENDENTE' },
  ]
  await p.foto('madeira', cupom(MADEIREIRA)); await espera(30)
  ok('gasto rateado não conta (não diz de qual obra o fornecedor é)', !p.ditos.some(t => /como das outras vezes/.test(t)))
}
{
  const p = pessoa()
  lancadosNoSistema = historico('App Madeireira Ltda', FRANCISCO, 3, { categoria: 'MATERIAL' })
  await p.foto('pagamento madeira peruibe 965', cupom(MADEIREIRA))
  ok('categoria que o sistema manda entra quando a legenda não diz', lancs().length === 1 || p.ditos.some(t => /material/i.test(t)))
}
{
  // O que o robô acabou de lançar conta, sem contar duas vezes o que já está no sistema.
  const p = pessoa()
  lancadosNoSistema = historico('App Madeireira Ltda', FRANCISCO, 2)
  memoria.anotarHabito({ fornecedor: { nome: 'app madeireira', cnpj: null }, obra: FRANCISCO, idMensagem: 'x1', arquivoHash: 'h-novo' })
  await p.foto('madeira', cupom(MADEIREIRA)); await espera(30)
  ok('o lançado agora pelo robô, que a lista ainda não mostra, soma ao do sistema (2 + 1)', p.ditos.some(t => /como das outras vezes/.test(t)))
}
{
  const p = pessoa()
  lancadosNoSistema = [...historico('App Madeireira Ltda', FRANCISCO, 2), { ...historico('App Madeireira Ltda', FRANCISCO, 1)[0], arquivoHash: 'h-dup' }]
  memoria.anotarHabito({ fornecedor: { nome: 'app madeireira', cnpj: null }, obra: FRANCISCO, idMensagem: 'x2', arquivoHash: 'h-dup' })
  await p.foto('madeira', cupom(MADEIREIRA)); await espera(30)
  ok('…mas o que já está na lista não conta duas vezes', p.ditos.some(t => /como das outras vezes/.test(t)))
  const p2 = pessoa()
  lancadosNoSistema = historico('App Madeireira Ltda', FRANCISCO, 1)
  memoria.anotarHabito({ fornecedor: { nome: 'app madeireira', cnpj: null }, obra: FRANCISCO, idMensagem: 'x3', arquivoHash: 'h-dup2' })
  lancadosNoSistema.push({ ...lancadosNoSistema[0], arquivoHash: 'h-dup2' })
  await p2.foto('madeira', cupom(MADEIREIRA)); await espera(30)
  ok('(2 no sistema, um deles o mesmo do robô: não chega a 3)', !p2.ditos.some(t => /como das outras vezes/.test(t)))
}

// ══ 4. Hábito muito forte: lança direto ═══════════════════════════════════
{
  const p = pessoa()
  lancadosNoSistema = historico('App Madeireira Ltda', FRANCISCO, 6)
  await p.foto('madeira 965', cupom(MADEIREIRA)); await espera(30)
  const l = lancs()[0]?.corpo ?? ''
  ok('6 de 6 na mesma obra: lança direto, sem perguntar', lancs().length === 1 && campoDe(l, 'obra') === FRANCISCO && !p.ditos.some(t => /como das outras vezes/.test(t)))
  ok('e a confirmação diz que foi pelo hábito, e como corrigir', p.ditos.some(t => /📌 Obra pelo hábito: das últimas 6 vezes deste fornecedor, 6 foram nessa obra/.test(t) && /cita esta mensagem e escreve \*obra\*/.test(t)))
  ok('quem aprova também fica sabendo', /hábito do fornecedor \(6 de 6/.test(campoDe(l, 'observacao') ?? ''))
}
{
  const p = pessoa()
  lancadosNoSistema = historico('App Madeireira Ltda', FRANCISCO, 6)
  process.env.GASTOS_HABITO_AUTO = 'off'
  await p.foto('madeira 965', cupom(MADEIREIRA)); await espera(30)
  ok('com GASTOS_HABITO_AUTO=off, pergunta em vez de lançar', lancs().length === 0 && p.ditos.some(t => /como das outras vezes/.test(t)))
}
{
  const p = pessoa()
  lancadosNoSistema = [...historico('App Madeireira Ltda', FRANCISCO, 6), ...historico('App Madeireira Ltda', TOSCHI, 1)]
  await p.foto('madeira 965', cupom(MADEIREIRA)); await espera(30)
  ok('6 de 7 (86%) não é forte o bastante: pergunta', lancs().length === 0 && p.ditos.some(t => /como das outras vezes/.test(t)))
}
{
  // A cidade tem duas obras, e o hábito aponta uma delas.
  const p = pessoa()
  lancadosNoSistema = historico('Deposito Central', TSUYA, 6)
  await p.foto('Material Bastos 300', cupom({ estabelecimento: 'Deposito Central', confianca: 'alta' })); await espera(30)
  ok('"Material Bastos" (duas obras) + hábito forte na Tsuya: lança na Tsuya', lancs().length === 1 && campoDe(lancs()[0].corpo, 'obra') === TSUYA)
  const p2 = pessoa()
  lancadosNoSistema = historico('Deposito Central', TSUYA, 3)
  await p2.foto('Material Bastos 300', cupom({ estabelecimento: 'Deposito Central', confianca: 'alta' })); await espera(30)
  ok('…e com hábito fraco, pergunta pela Tsuya em vez de "qual delas?"', p2.ditos.some(t => t.includes(`É da *${TSUYA}*`)) && !p2.ditos.some(t => /mais de uma obra/.test(t)))
  const p3 = pessoa()
  lancadosNoSistema = historico('Deposito Central', TOSCHI, 6)
  await p3.foto('Material Bastos 300', cupom({ estabelecimento: 'Deposito Central', confianca: 'alta' })); await espera(30)
  ok('…mas se o hábito é de OUTRA cidade, vale o que a pessoa escreveu (pergunta entre as de Bastos)', lancs().length === 0 && p3.ditos.some(t => /mais de uma obra/.test(t)))
}

// ══ 2. Pessoa → obra pelo RH ══════════════════════════════════════════════
{
  const p = pessoa()
  funcionarios = { 'rogério': { tipo: 'funcionario', primeiroNome: 'Rogério', obra: HAIA } }
  await p.foto('Vale Rogério 150'); await espera(30)
  ok('"Vale Rogério": pergunta pela obra do Rogério no RH', p.ditos.some(t => t.includes(`É da *${HAIA}*? No RH, Rogério está nessa obra.`)))
  ok('sem lançar sozinho', lancs().length === 0)
  await p.diz('sim'); await espera(30)
  ok('"sim" lança na Haia', lancs().length === 1 && campoDe(lancs()[0].corpo, 'obra') === HAIA)
}
{
  const p = pessoa()
  funcionarios = { 'julio cesar galindo rodrigues': { tipo: 'funcionario', primeiroNome: 'Julio', obra: 'EE PROFA TSUYA OHNO KIMURA' } }
  await p.foto('Condução 43', cupom({ estabelecimento: 'Julio Cesar Galindo Rodrigues', valor: 43, confianca: 'alta' })); await espera(30)
  ok('Pix para um funcionário (lido no comprovante): sugere a obra dele', p.ditos.some(t => t.includes(`É da *${TSUYA}*? No RH, Julio`)))
}
{
  const p = pessoa()
  await p.foto('Vale Fulaninho 150'); await espera(30)
  ok('nome que o RH não conhece: a pergunta de sempre', p.ditos.some(t => /De qual \*obra\*/.test(t)) && !p.ditos.some(t => /No RH/.test(t)))
  const p2 = pessoa()
  funcionarios = { 'rogério': { tipo: 'funcionario', primeiroNome: 'Rogério', obra: 'Obra que não existe mais' } }
  await p2.foto('Vale Rogério 150'); await espera(30)
  ok('obra do RH que não está aberta no sistema: não sugere', !p2.ditos.some(t => /No RH/.test(t)))
  const p3 = pessoa()
  funcionarios = { 'rogério': { tipo: 'candidato', primeiroNome: 'Rogério', obra: HAIA } }
  await p3.foto('Vale Rogério 150'); await espera(30)
  ok('candidato (não funcionário): não sugere', !p3.ditos.some(t => /No RH/.test(t)))
  const p4 = pessoa()
  funcionarios = { 'rogério': { tipo: 'funcionario', primeiroNome: 'Rogério', obra: HAIA } }
  await p4.foto('Vale Rogério 150'); await espera(30)
  await p4.diz('não, é da tsuya'); await espera(30)
  ok('recusada a sugestão, vale a obra que a pessoa disse', lancs().length === 1 && campoDe(lancs()[0].corpo, 'obra') === TSUYA)
}

// ══ 3. A IA lendo a frase ═════════════════════════════════════════════════
{
  const p = pessoa()
  pagadores = SOCIOS
  await p.foto('Thiago Encarregado Bastos 4000,00'); await espera(30)
  ok('cidade com duas obras: pergunta entre elas', p.ditos.some(t => /mais de uma obra/.test(t)))
  respostaDaIa = (t) => /corrigindo/.test(t)
    ? { obras: [TSUYA, HAIA], valor: 0, pagoPor: 'Estevão', empresaPagou: false, categoria: 'MAO_DE_OBRA', descricao: 'encarregado', confianca: 'alta' }
    : null
  await p.diz('corrigindo, não é haia, é para ratear tsuya e haia, e pagamento feito por estevão'); await espera(30)
  const l = lancs()[0]?.corpo ?? ''
  ok('a IA entende a correção: rateio entre Tsuya e Haia', [campoDe(l, 'obra'), campoDe(l, 'rateio')].join(',') === `${TSUYA},${HAIA}`)
  ok('e quem pagou foi o Estevão', campoDe(l, 'pagoPor') === 'Estevão')
  ok('o valor continua o escrito', campoDe(l, 'valor') === '4000')
  ok('quem aprova fica sabendo que a obra veio da IA', /IA/.test(campoDe(l, 'observacao') ?? ''))
  ok('a IA recebeu a lista de obras com as cidades, e o texto em ordem', /cidade: Bastos/.test(iaFrase.at(-1) ?? '') && /Legenda: Thiago/.test(iaFrase.at(-1) ?? '') && /Resposta 1: corrigindo/.test(iaFrase.at(-1) ?? ''))
}
{
  const p = pessoa()
  respostaDaIa = () => ({ obras: [FRANCISCO], valor: 0, pagoPor: '', empresaPagou: false, categoria: '', descricao: '', confianca: 'alta' })
  await p.foto('comprei umas coisas para a obra'); await espera(30)
  ok('obra que a pessoa NÃO citou: a IA não pode inventar — pergunta', lancs().length === 0 && p.ditos.some(t => /obra/.test(t)))
}
{
  const p = pessoa()
  respostaDaIa = () => ({ obras: [TOSCHI], valor: 777, pagoPor: '', empresaPagou: false, categoria: '', descricao: '', confianca: 'alta' })
  await p.foto('material para a obra de praia grande que ficou faltando'); await espera(30)
  ok('valor que a pessoa NÃO escreveu: a IA não pode inventar — pergunta o valor', lancs().length === 0 && p.ditos.some(t => /valor/i.test(t)))
}
{
  const p = pessoa()
  respostaDaIa = () => ({ obras: [TOSCHI], valor: 0, pagoPor: '', empresaPagou: false, categoria: '', descricao: '', confianca: 'baixa' })
  await p.foto('compra de material da obra que eu falei ontem 300'); await espera(30)
  ok('IA com confiança baixa: não muda nada', lancs().length === 0)
}
{
  // Texto que as regras já entendem: a IA nem é chamada.
  const p = pessoa()
  await p.foto('haia cimento 250'); await espera(30)
  ok('legenda completa: não chama a IA', iaFrase.length === 0 && lancs().length === 1)
}
{
  const ia = (b) => conferirFrase(b, { texto: 'ratear tsuya e haia, 1.250,00, pago pelo estevão', obras: OBRAS, nomes: OBRAS.map(o => o.nome), socios: SOCIOS })
  ok('conferir: obras citadas passam', ia({ obras: [TSUYA, HAIA], valor: 0, confianca: 'alta' })?.obras?.length === 2)
  ok('conferir: uma obra não citada derruba as obras', ia({ obras: [TSUYA, BURITAMA], valor: 0, confianca: 'alta' }) === null)
  ok('conferir: valor escrito passa ("1.250,00")', ia({ obras: [], valor: 1250, confianca: 'alta' })?.valor === 1250)
  ok('conferir: pagador fora da lista de sócios não passa', ia({ obras: [], valor: 0, pagoPor: 'Fulano', confianca: 'alta' }) === null)
  ok('conferir: nome exato da lista, sem ligar para maiúscula', ia({ obras: ['ee profa tsuya ohno kimura'], valor: 0, confianca: 'media' })?.obras?.[0] === TSUYA)
}

// ══ 5. O relatório da semana ══════════════════════════════════════════════
{
  pessoa()
  memoria._limpar()
  memoria.contar('lancado', 10); memoria.contar('semPergunta', 7); memoria.contar('pergunta', 5)
  memoria.contar('habitoDireto', 3); memoria.contar('sugestaoAceita', 2); memoria.contar('sugestaoRecusada', 1)
  memoria.contar('ia', 1); memoria.contar('corrigido', 1); memoria.contar('caixa', 2); memoria.contar('repetidoBarrado', 1)
  memoria.contar('lancado', 1)
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())
  const t = montarRelatorio(hoje) ?? ''
  ok('relatório: lançados e sem pergunta', /11 lançado\(s\) · 7 sem nenhuma pergunta — 64%/.test(t))
  ok('relatório: hábito, sugestões, IA, correções, caixa', /3 obra\(s\) pelo hábito/.test(t) && /2 aceita\(s\), 1 recusada/.test(t) && /1 frase/.test(t) && /1 correção/.test(t) && /2 na caixa/.test(t))

  const p = pessoa({ manterMemoria: true })
  const r = await p.diz('relatório')
  ok('"relatório" no grupo devolve o relatório na hora', /Como eu fui na semana/.test(r ?? ''))

  // A próxima segunda: manda uma vez só, para quem recebe as dúvidas.
  // (A semana que ela fecha inclui hoje, então os números acima entram.)
  const hojeMs = Date.parse(`${hoje}T12:00:00Z`)
  const diasAteSegunda = ((8 - new Date(hojeMs).getUTCDay()) % 7) || 7
  const segundaIso = new Date(hojeMs + diasAteSegunda * DIA).toISOString().slice(0, 10)
  const em = (iso, hhmmZ) => new Date(`${iso}T${hhmmZ}:00Z`)
  const maisDias = (n) => new Date(Date.parse(`${segundaIso}T12:00:00Z`) + n * DIA).toISOString().slice(0, 10)
  ok('segunda antes das 8h (Brasília): ainda não', (await talvezMandar(em(segundaIso, '10:30'))) === null)
  ok('domingo: não', (await talvezMandar(em(maisDias(-1), '12:30'))) === null)
  const mandou = await talvezMandar(em(segundaIso, '12:30'))       // 9h30 em Brasília
  ok('segunda às 9h30: manda o relatório da semana', /Como eu fui na semana/.test(mandou ?? '') && /11 lançado\(s\)/.test(mandou ?? ''))
  ok('a semana ficou marcada', memoria.relatorioDaSemana() === segundaIso)
  ok('na mesma segunda, não manda de novo', (await talvezMandar(em(segundaIso, '15:00'))) === null)
  ok('na terça, não manda', (await talvezMandar(em(maisDias(1), '12:30'))) === null)
  const semNada = pessoa()
  void semNada
  ok('semana sem nada: não manda, mas marca (não fica tentando)', (await talvezMandar(em(maisDias(7), '12:30'))) === null && memoria.relatorioDaSemana() === maisDias(7))
}

_limparPendentes()
srv.close()
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
