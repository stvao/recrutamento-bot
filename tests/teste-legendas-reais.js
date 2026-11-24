/**
 * As legendas como a equipe escreve DE VERDADE.
 *
 * Em 24/11/2026 as 243 legendas do grupo antigo de comprovantes passaram pelo
 * interpretador, e ele errava de dois jeitos:
 *
 *  - lançava na obra ERRADA sem perguntar: "Vale Luiz" ia para a escola
 *    Oswaldo LUIZ Sanches Toschi; "Guia FGTS" ia para a ÁGUIA de Haia;
 *    "brita" achava a rua "Benedito Brito" do endereço de outra obra;
 *  - deixava 94 delas sem tipo: "vale", "pgto", "condução", "FGTS",
 *    "concreto", "gesso"… — e "nota" virava EPI (a uma letra de "bota").
 *
 * As frases aqui são do mesmo jeito das reais. As obras, com endereço de rua
 * — que é o que o sistema manda.
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASTA = mkdtempSync(join(tmpdir(), 'teste-legendas-reais-'))
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

const TSUYA = 'EE PROFA TSUYA OHNO KIMURA'
const HAIA = 'EE/ETEC AGUIA DE HAIA'
const EGILDO = 'EE VER EGILDO PASCHOALUCCI'
const TOSCHI = 'EE OSWALDO LUIZ SANCHES TOSCHI'
const FRANCISCO = 'EE DR FRANCISCO PEREIRA DA ROCHA'
const BURITAMA = 'CEO Buritama – Reforma'
const OBRAS = [
  { nome: TSUYA, endereco: 'Rua Tsuya Ohno, 100 - Centro, Bastos - SP' },
  { nome: HAIA, endereco: 'Av. Brasil, 500 - Bastos/SP' },
  { nome: EGILDO, endereco: 'Rua Sete de Setembro, 45 - Pereiras - SP, 18580-000' },
  { nome: TOSCHI, endereco: 'Rua Benedito Brito, 300 - Vila Tupi, Praia Grande - SP' },
  { nome: FRANCISCO, endereco: 'Av. Padre Anchieta, 900, Peruíbe - SP' },
  { nome: BURITAMA, endereco: 'Rua XV de Novembro, 10', municipio: 'Buritama' },
]

const { interpretar, acharTipo, acharObra, cidadeDe } = await import('../src/comprovantes/lancamento.js')
const ler = (legenda) => interpretar(legenda, OBRAS)

// ── 1. A obra pela CIDADE, que é como a equipe escreve ────────────────────
{
  ok('"Marmitas Pereiras" → a obra de Pereiras', ler('Marmitas Pereiras').obra === EGILDO)
  ok('"Madeira Peruibe" (sem acento) → a obra de Peruíbe', ler('Madeira Peruibe 12500').obra === FRANCISCO)
  ok('"Material Praia Grande" → a obra de Praia Grande', ler('Material Praia Grande').obra === TOSCHI)
  ok('"Ferramentas Buritama" → a obra de Buritama (pelo município)', ler('Ferramentas Buritama').obra === BURITAMA)
  const bastos = ler('Madeira Bastos')
  ok('"Madeira Bastos": duas obras em Bastos → PERGUNTA entre as duas', !bastos.obra && bastos.candidatos?.length === 2
    && bastos.candidatos.includes(TSUYA) && bastos.candidatos.includes(HAIA))
  ok('"Material Bastos Tsuya" → a Tsuya', ler('Material Bastos Tsuya').obra === TSUYA)
  ok('"pereras" (erro de escrita) ainda acha Pereiras', ler('marmita pereras').obra === EGILDO)
  ok('a cidade sai da descrição', ler('Marmitas Pereiras').descricao === 'Marmitas')
}

// ── 2. O que NÃO pode virar obra ──────────────────────────────────────────
{
  ok('"Vale Luiz" não vai para a escola Oswaldo LUIZ', !ler('Vale Luiz').obra)
  ok('"Pgto Luiz" também não', !ler('Pgto Luiz 1500').obra)
  ok('"Guia FGTS" não vai para a ÁGUIA de Haia', !ler('Guia FGTS').obra)
  ok('"brita" não acha a rua "Benedito Brito"', !ler('brita 300').obra)
  ok('"Francisco" (o funcionário) não acha a escola Francisco Pereira', !ler('Vale Francisco').obra)
  ok('"Rocha" também não', !ler('Pgto Rocha').obra)
  ok('rua do endereço não é apelido: "anchieta"', !ler('compra anchieta').obra)
  ok('bairro do endereço também não: "tupi"', !ler('lanche tupi').obra)
  // E as obras continuam acháveis pelo que é delas.
  ok('"Toschi" ainda acha a Toschi', ler('material toschi').obra === TOSCHI)
  ok('"Egildo" ainda acha a Egildo', ler('marmita egildo').obra === EGILDO)
  ok('"tsuia" (erro de escrita) ainda acha a Tsuya', ler('cimento tsuia').obra === TSUYA)
  ok('"aguia de haia" escrito inteiro acha a Haia', ler('cimento aguia de haia').obra === HAIA)
}

// ── 3. O tipo ─────────────────────────────────────────────────────────────
{
  const tipos = [
    ['Vale Rogério', 'MAO_DE_OBRA'],
    ['Pgto func. demitido', 'MAO_DE_OBRA'],
    ['Demissão Servente', 'MAO_DE_OBRA'],
    ['Diária pedreiro', 'MAO_DE_OBRA'],
    ['Condução', 'TRANSPORTE'],
    ['Vale transporte Rogério', 'TRANSPORTE'],
    ['Vale transp. Ygor', 'TRANSPORTE'],
    ['Passagem func. para Bastos', 'TRANSPORTE'],
    ['Guia FGTS', 'OUTRO'],
    ['Internet alojamento', 'OUTRO'],
    ['Concreto', 'MATERIAL'],
    ['Gesso', 'MATERIAL'],
    ['Cadeados e correntes portão', 'MATERIAL'],
    ['Restaurante Praia Grande', 'ALIMENTACAO'],
    ['Marmitas Pereiras', 'ALIMENTACAO'],
    ['Mantimentos para o alojamento', 'ALIMENTACAO'],
    // Cita dois tipos; "alimentação" é palavra de TIPO escrita, e o tipo escrito ganha.
    ['Alojamento e alimentação Bastos', 'ALIMENTACAO'],
    ['Alojamento Bastos', 'HOSPEDAGEM'],
    ['Pgto hotel Pereiras', 'HOSPEDAGEM'],
    ['Pgto material', 'MATERIAL'],
    ['bombeamento de concreto', 'LOCACAO'],
    ['Caçamba Pereiras', 'LOCACAO'],
    ['Ferramentas obra', 'FERRAMENTAS'],
  ]
  for (const [legenda, tipo] of tipos) ok(`"${legenda}" → ${tipo}`, ler(legenda).tipo === tipo)

  // O que errava por estar a uma letra de outra palavra.
  ok('"nota" não é "bota" (EPI)', acharTipo('nota A') === null && acharTipo('Nota fiscal') === null)
  ok('"guia" não é "agua" (alimentação)', acharTipo('guia') === 'OUTRO')
  // Erro de escrita de verdade continua valendo.
  ok('"materal" ainda é material', acharTipo('materal') === 'MATERIAL')
  ok('"combustivl" ainda é combustível', acharTipo('combustivl') === 'COMBUSTIVEL')
}

// ── 4. A cidade, do endereço ──────────────────────────────────────────────
{
  ok('"…, Bastos - SP"', cidadeDe({ endereco: 'Rua X, 100 - Centro, Bastos - SP' }) === 'Bastos')
  ok('"… - Praia Grande/SP"', cidadeDe({ endereco: 'Rua X, 300 - Praia Grande/SP' }) === 'Praia Grande')
  ok('com CEP no fim', cidadeDe({ endereco: 'Rua X, 45 - Pereiras - SP, 18580-000' }) === 'Pereiras')
  ok('"…, Pereiras, SP"', cidadeDe({ endereco: 'Rodovia SP-294 km 3, Pereiras, SP' }) === 'Pereiras')
  ok('o município, quando vem, manda', cidadeDe({ endereco: 'Rua X, 10 - Bastos - SP', municipio: 'Buritama' }) === 'Buritama')
  ok('sem como achar a cidade, fica o endereço inteiro', cidadeDe({ endereco: 'Rua XV, 10' }) === 'Rua XV, 10')
  ok('obra só com nome não tem cidade', cidadeDe('EE Fulano') === '' && cidadeDe(null) === '')
  ok('acharObra com a lista só de nomes continua funcionando', acharObra('cimento toschi', [TOSCHI, TSUYA]).achado === TOSCHI)
}

// ── 5. A pergunta, e a resposta "2 150" ───────────────────────────────────
const chamadas = []
const srv = createServer((req, res) => {
  let corpo = ''
  req.on('data', c => { corpo += c })
  req.on('end', () => {
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    chamadas.push({ url: req.url, corpo })
    const campo = (n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null
    if (req.url.endsWith('/comprovantes/obras')) return json(200, { obras: OBRAS.map(o => o.nome), detalhes: OBRAS })
    if (req.url.includes('/comprovantes/lancados')) return json(200, { lancados: [] })
    if (req.url.endsWith('/comprovantes/lancar')) {
      const obra = campo('obra')
      return json(201, { ok: true, id: `g${chamadas.length}`, obra, obras: [obra], mensagem: `Lançado em ${obra}, aguardando sua aprovação.` })
    }
    json(201, { ok: true, id: 'c1', mensagem: 'Comprovante recebido.' })
  })
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
process.env.OBRAS_API_URL = `http://127.0.0.1:${srv.address().port}`

const { tratar, _limparPendentes } = await import('../src/comprovantes/index.js')
const { _limparCacheObras } = await import('../src/comprovantes/obras-client.js')
const memoria = await import('../src/comprovantes/memoria.js')
const espera = (ms) => new Promise(r => setTimeout(r, ms))
const lancs = () => chamadas.filter(c => c.url.endsWith('/lancar'))
const campoDe = (corpo, n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null

let nFoto = 0
function pessoa(de) {
  chamadas.length = 0
  _limparPendentes(); _limparCacheObras(); memoria._limpar()
  const ditos = []
  let n = 0
  const enviarResposta = async (t) => { ditos.push(t); return { id: `bot-${de}-${++n}` } }
  const guardar = (r) => { if (typeof r === 'string') ditos.push(r); return r }
  const base = { chat: '123@g.us', chatNome: 'Comprovantes', ehGrupo: true, de, enviarResposta }
  return {
    ditos,
    foto: async (texto) => guardar(await tratar({ ...base, arquivo: Buffer.from(`foto-${++nFoto}`), nomeArquivo: 'c.jpg', tipo: 'image/jpeg', texto, idMensagem: `f-${nFoto}` })),
    diz: async (texto) => guardar(await tratar({ ...base, texto, idMensagem: `t-${Math.random()}`, respondendoA: null })),
  }
}

{
  const p = pessoa('5511900000701')
  await p.foto('Vale Luiz'); await espera(20)
  const pergunta = p.ditos.at(-1) ?? ''
  ok('"Vale Luiz": não lança, pergunta', lancs().length === 0 && /faltou a \*obra\* e o \*valor\*/.test(pergunta))
  ok('a lista é numerada, com a cidade de cada obra',
    pergunta.includes(`1) ${TSUYA} — Bastos`) && pergunta.includes(`4) ${TOSCHI} — Praia Grande`) && pergunta.includes(`6) ${BURITAMA} — Buritama`))
  ok('e diz como responder', /responde o número e o valor, tipo "2 150"/.test(pergunta))
  ok('o tipo já foi entendido', /Anotei: .*mao de obra/i.test(pergunta))

  await p.diz('4 1500'); await espera(20)
  ok('"4 1500" escolhe a obra 4 E dá o valor', lancs().length === 1 && campoDe(lancs()[0].corpo, 'obra') === TOSCHI && campoDe(lancs()[0].corpo, 'valor') === '1500')
}
{
  const p = pessoa('5511900000702')
  await p.foto('Material Bastos 250'); await espera(20)
  const pergunta = p.ditos.at(-1) ?? ''
  ok('cidade com duas obras: pergunta só entre elas, com a cidade', /mais de uma obra/.test(pergunta)
    && pergunta.includes(`1) ${TSUYA} — Bastos`) && pergunta.includes(`2) ${HAIA} — Bastos`) && !pergunta.includes(TOSCHI))
  await p.diz('2'); await espera(20)
  ok('"2" escolhe a Haia', lancs().length === 1 && campoDe(lancs()[0].corpo, 'obra') === HAIA)
}
{
  const p = pessoa('5511900000703')
  await p.foto('Cimento 80'); await espera(20)
  await p.diz('praia grande'); await espera(20)
  ok('responder a cidade também resolve', lancs().length === 1 && campoDe(lancs()[0].corpo, 'obra') === TOSCHI)
}
{
  const p = pessoa('5511900000704')
  await p.foto('Marmitas Pereiras 520')
  ok('legenda completa no jeito da equipe: lança direto', lancs().length === 1 && campoDe(lancs()[0].corpo, 'obra') === EGILDO
    && campoDe(lancs()[0].corpo, 'categoria') === 'ALIMENTACAO')
}

_limparPendentes()
srv.close()
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
