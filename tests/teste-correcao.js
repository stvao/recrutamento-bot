/**
 * Corrigir pelo grupo um gasto que já foi lançado.
 *
 * A pessoa CITA o comprovante (ou a confirmação "✅ Lançado") e escreve a
 * correção. O que se confere aqui:
 *
 *  - cada correção chega certa ao sistema, e a resposta diz o antes → depois;
 *  - cancelar pede UMA confirmação;
 *  - sem citação, nada disto dispara;
 *  - só corrige quem mandou, ou quem está na lista por número — o coringa do
 *    grupo não basta;
 *  - o que o sistema recusa (já aprovado, obra desconhecida, versão antiga)
 *    vira uma resposta clara, e nada muda na memória;
 *  - a memória do robô acompanha o que mudou.
 *
 * O sistema de obras é de mentira, e guarda os gastos para poder ser
 * corrigido de verdade.
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASTA = mkdtempSync(join(tmpdir(), 'teste-correcao-'))
process.env.GASTOS_PENDENTES_DIR = PASTA
process.env.GASTOS_MEMORIA = join(PASTA, 'memoria-gastos.json')
process.env.GEMINI_API_KEY = ''
// O coringa (qualquer um do grupo lança) MAIS um número na lista explícita:
// é a combinação que deixa ver a diferença entre "pode lançar" e "pode
// corrigir o gasto de outra pessoa".
const CHEFE = '5511988880000'
process.env.GASTOS_AUTORIZADOS = `*,${CHEFE}`
process.env.GASTOS_GRUPOS = '123@g.us'
process.env.OBRAS_API_TOKEN = 'token-de-teste'
process.env.GASTOS_ESPERA_DESCRICAO_MS = '50'

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

const OBRAS = [
  { nome: 'EE PROFA TSUYA OHNO KIMURA', endereco: 'Rua das Flores 100, Bastos - SP' },
  { nome: 'EE OSWALDO LUIZ SANCHES TOSCHI', endereco: 'Rua Sete 45, Bastos - SP' },
  { nome: 'EE/ETEC AGUIA DE HAIA', endereco: 'Av Aguia de Haia 500, Sao Paulo - SP' },
]
const HAIA = OBRAS[2].nome
const TSUYA = OBRAS[0].nome

// ── O sistema de obras, de mentira — mas com memória ──────────────────────
const chamadas = []
const gastos = new Map()                  // id → { obra, valor, data, descricao, categoria, status, rateio }
let nGasto = 0
/** Servidor de versão anterior: as rotas de corrigir e cancelar não existem. */
let semRotasDeCorrecao = false
/** O sistema recusa uma obra que o robô achou que conhecia. */
let recusaObra = false

const srv = createServer((req, res) => {
  let corpo = ''
  req.on('data', c => { corpo += c })
  req.on('end', () => {
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    chamadas.push({ url: req.url, metodo: req.method, corpo })
    const campo = (n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? null

    if (req.url.endsWith('/comprovantes/obras')) return json(200, { obras: OBRAS.map(o => o.nome), detalhes: OBRAS })

    const umGasto = /\/comprovantes\/lancados\/([^/?]+)$/.exec(req.url)
    if (umGasto && (req.method === 'PATCH' || req.method === 'DELETE')) {
      if (semRotasDeCorrecao) return json(404, { message: 'Cannot PATCH' })
      const g = gastos.get(decodeURIComponent(umGasto[1]))
      if (!g) return json(404, { message: 'não existe' })
      if (g.status !== 'PENDENTE') return json(409, { codigo: 'JA_ANALISADO', status: g.status, message: 'já analisado' })

      if (req.method === 'DELETE') {
        g.status = 'REJEITADO'
        return json(200, { ok: true, id: g.id, status: g.status })
      }
      const pedido = JSON.parse(corpo || '{}')
      if (pedido.obra !== undefined) {
        if (g.rateio.length > 1) return json(409, { codigo: 'RATEADO', message: 'gasto rateado' })
        if (recusaObra || !OBRAS.some(o => o.nome === pedido.obra)) return json(422, { message: 'não achei', obras: OBRAS.map(o => o.nome) })
        g.obra = pedido.obra
      }
      for (const c of ['valor', 'descricao', 'categoria', 'data']) if (pedido[c] !== undefined) g[c] = pedido[c]
      return json(200, { ok: true, id: g.id, ids: [g.id], obra: g.obra, obras: [g.obra], valor: g.valor, data: g.data, descricao: g.descricao, categoria: g.categoria, status: g.status, rateio: g.rateio })
    }

    if (req.url.includes('/comprovantes/lancados')) return json(200, { lancados: [] })

    if (req.url.endsWith('/comprovantes/lancar')) {
      const obra = campo('obra')
      const extras = (campo('rateio') ?? '').split(',').map(x => x.trim()).filter(Boolean)
      const todas = [obra, ...extras]
      const valor = Number(campo('valor'))
      const id = `g${++nGasto}`
      const rateio = todas.map(o => ({ obra: o, valor: valor / todas.length }))
      gastos.set(id, { id, obra, valor, data: campo('data'), descricao: campo('descricao'), categoria: campo('categoria'), status: 'PENDENTE', rateio })
      return json(201, { ok: true, id, obra, obras: todas, rateio, mensagem: `Lançado em ${obra}, aguardando sua aprovação.` })
    }
    json(201, { ok: true, id: 'c1', mensagem: 'Comprovante recebido.', pendentes: 1 })
  })
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
process.env.OBRAS_API_URL = `http://127.0.0.1:${srv.address().port}`

const { tratar, respostaEnviada, _limparPendentes } = await import('../src/comprovantes/index.js')
const { _limparCacheObras } = await import('../src/comprovantes/obras-client.js')
const { lerCorrecao, _limparEsperas } = await import('../src/comprovantes/correcao.js')
const memoria = await import('../src/comprovantes/memoria.js')

const base = { canal: 'whatsapp', chat: '123@g.us', chatNome: 'Comprovantes', ehGrupo: true }
const espera = (ms) => new Promise(r => setTimeout(r, ms))
let nFoto = 0
let nResposta = 0

/** Começa do zero: nada esperando, nada lembrado, sistema novo. */
function zerar() {
  chamadas.length = 0
  _limparPendentes()
  _limparCacheObras()
  _limparEsperas()
  memoria._limpar()
  semRotasDeCorrecao = false
  recusaObra = false
}

/**
 * Uma pessoa do grupo. Faz o papel do conector também: quando o robô devolve
 * um texto, ela o "manda" e avisa o id de volta (`respostaEnviada`) — que é
 * como o robô fica sabendo o id da confirmação "✅ Lançado".
 */
function pessoa(de) {
  const ditos = []
  const enviadas = []
  const enviarResposta = async (t) => { const id = `bot-${++nResposta}`; ditos.push(t); enviadas.push({ id, texto: t }); return { id } }
  const mandar = async (msg) => {
    const r = await tratar({ ...base, de, telefoneConhecido: true, enviarResposta, ...msg })
    if (typeof r === 'string') {
      const id = `bot-${++nResposta}`
      ditos.push(r); enviadas.push({ id, texto: r })
      respostaEnviada(msg.idMensagem, id)
    }
    return r
  }
  return {
    ditos,
    /** Manda um comprovante. Devolve o id da MENSAGEM dele. */
    foto: async (texto) => {
      const idMensagem = `foto-${++nFoto}`
      await mandar({ arquivo: Buffer.from(`imagem-${nFoto}`), nomeArquivo: 'c.jpg', tipo: 'image/jpeg', texto, idMensagem })
      return idMensagem
    },
    diz: (texto, citando) => mandar({ texto, idMensagem: `t-${Math.random()}`, respondendoA: citando ?? null }),
    /** O id da última mensagem do robô que casa. */
    idDe: (padrao) => enviadas.filter(e => padrao.test(e.texto)).at(-1)?.id ?? null,
  }
}

const pedidos = (metodo) => chamadas.filter(c => c.metodo === metodo && /\/lancados\/[^/?]+$/.test(c.url))
const ultimoGasto = () => gastos.get(`g${nGasto}`)

// ══ 1. Cada correção, citando a CONFIRMAÇÃO ═══════════════════════════════
{
  zerar()
  const p = pessoa('5511900000401')
  const idFoto = await p.foto('haia cimento 1500')
  const idConf = p.idDe(/aguardando sua aprovação/)
  ok('lançou, e a confirmação tem id', Boolean(idConf) && ultimoGasto().valor === 1500)
  ok('a memória guarda o id do gasto e o da confirmação',
    memoria.resultadoDe(idFoto)?.idGasto === `g${nGasto}` && memoria.resultadoDe(idFoto)?.idConfirmacao === idConf)

  // valor
  let r = await p.diz('valor 1800', idConf)
  ok('"valor 1800" corrige o valor no sistema', ultimoGasto().valor === 1800)
  ok('a resposta diz o antes → depois', r === '✏️ Corrigido: R$ 1.500,00 → R$ 1.800,00')
  ok('foi um PATCH só com o valor', pedidos('PATCH').length === 1 && pedidos('PATCH')[0].corpo === '{"valor":1800}')
  ok('a memória acompanha o valor', memoria.resultadoDe(idFoto)?.valor === 1800)

  r = await p.diz('era 1.950,50', idConf)
  ok('"era 1.950,50" também', ultimoGasto().valor === 1950.5 && r === '✏️ Corrigido: R$ 1.800,00 → R$ 1.950,50')

  // obra
  r = await p.diz('obra tsuya', idConf)
  ok('"obra tsuya" troca a obra, pelo nome oficial', ultimoGasto().obra === TSUYA)
  ok('e diz de qual para qual', r === `✏️ Corrigido: ${HAIA} → ${TSUYA}`)
  ok('a memória acompanha a obra', memoria.resultadoDe(idFoto)?.obra === TSUYA)
  r = await p.diz('é da haia', idConf)
  ok('"é da haia" também', ultimoGasto().obra === HAIA && r === `✏️ Corrigido: ${TSUYA} → ${HAIA}`)

  // data
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())
  const seteAtras = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - 7 * 86400000))
  const curta = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
  r = await p.diz(`data ${curta(seteAtras)}`, idConf)
  ok('"data DD/MM" corrige a data', ultimoGasto().data === seteAtras)
  ok('e diz de qual para qual', r === `✏️ Corrigido: data ${curta(hoje)} → ${curta(seteAtras)}`)
  ok('a memória acompanha a data', memoria.resultadoDe(idFoto)?.data === seteAtras)

  // categoria
  r = await p.diz('locação', idConf)
  ok('"locação" corrige a categoria', ultimoGasto().categoria === 'LOCACAO' && r === '✏️ Corrigido: material → locacao')
  ok('a memória acompanha a categoria', memoria.resultadoDe(idFoto)?.categoria === 'LOCACAO')

  // descrição
  r = await p.diz('descrição cimento CP-II 50kg', idConf)
  ok('"descrição …" corrige a descrição', ultimoGasto().descricao === 'cimento CP-II 50kg' && /Corrigido: "cimento" → "cimento CP-II 50kg"/.test(r))

  // Citar o COMPROVANTE vale o mesmo que citar a confirmação.
  r = await p.diz('valor 2000', idFoto)
  ok('citar a foto do comprovante também corrige', ultimoGasto().valor === 2000 && /R\$ 1\.950,50 → R\$ 2\.000,00/.test(r))
}

// ══ 2. Cancelar: UMA confirmação ══════════════════════════════════════════
{
  zerar()
  const p = pessoa('5511900000402')
  const idFoto = await p.foto('haia areia 320')
  const idConf = p.idDe(/aguardando sua aprovação/)

  let r = await p.diz('apagar', idConf)
  ok('"apagar" NÃO cancela na hora', pedidos('DELETE').length === 0 && ultimoGasto().status === 'PENDENTE')
  const pergunta = p.ditos.at(-1) ?? ''
  ok('pergunta antes, dizendo valor e obra', pergunta === `Cancelo o lançamento de R$ 320,00 em ${HAIA}? Responde *sim*.`)
  ok('a pergunta saiu uma vez só', r === null && p.ditos.filter(t => /^Cancelo/.test(t)).length === 1)

  r = await p.diz('não', p.idDe(/^Cancelo/))
  ok('"não" deixa como está', r === 'Certo, deixei como está.' && ultimoGasto().status === 'PENDENTE' && pedidos('DELETE').length === 0)
  r = await p.diz('sim', p.idDe(/^Cancelo/))
  ok('e um "sim" depois do "não" já não cancela nada', pedidos('DELETE').length === 0)

  await p.diz('lancei errado', idFoto)
  r = await p.diz('sim', p.idDe(/^Cancelo/))
  ok('"sim" citando a pergunta cancela', ultimoGasto().status === 'REJEITADO' && pedidos('DELETE').length === 1)
  ok('e a resposta diz o que foi cancelado', r === `🗑️ Cancelado: R$ 320,00 em ${HAIA}.`)
  ok('sai da memória: o fechamento do dia não soma mais', memoria.resultadoDe(idFoto) === null && memoria.lancadosRecentes().length === 0)

  r = await p.diz('valor 10', idConf)
  ok('cancelado, não há mais o que corrigir citando', r !== undefined && pedidos('PATCH').length === 0)
}
{
  // "sim" SEM citar: vale quando a pessoa não tem comprovante próprio esperando.
  zerar()
  const p = pessoa('5511900000403')
  await p.foto('haia brita 90')
  await p.diz('cancelar', p.idDe(/aguardando sua aprovação/))
  await p.diz('sim')
  ok('"sim" sem citar cancela, se não há outra pergunta no ar', ultimoGasto().status === 'REJEITADO')
}
{
  // ...mas se ela tem um comprovante esperando resposta, o "sim" solto é dele.
  zerar()
  const p = pessoa('5511900000404')
  await p.foto('haia brita 90')
  const idConf = p.idDe(/aguardando sua aprovação/)
  const alvo = ultimoGasto()
  await p.foto('nota sem obra nem valor'); await espera(20)
  await p.diz('cancelar', idConf)
  await p.diz('sim'); await espera(20)
  ok('com outro comprovante esperando, "sim" solto NÃO cancela', alvo.status === 'PENDENTE' && pedidos('DELETE').length === 0)
  await p.diz('sim', p.idDe(/^Cancelo/))
  ok('citando a pergunta, cancela', alvo.status === 'REJEITADO')
}

// ══ 3. Sem citação, nada dispara ══════════════════════════════════════════
{
  zerar()
  const p = pessoa('5511900000405')
  await p.foto('haia cimento 250')
  for (const texto of ['valor 1800', 'obra tsuya', 'data 01/01', 'locação', 'apagar', 'cancelar', 'lancei errado']) {
    const r = await p.diz(texto)
    ok(`"${texto}" solto não corrige nada`, r === null && pedidos('PATCH').length === 0 && pedidos('DELETE').length === 0)
  }
  ok('e o gasto continua como estava', ultimoGasto().valor === 250 && ultimoGasto().obra === HAIA && ultimoGasto().status === 'PENDENTE')
}
{
  // Citando o lançado e escrevendo outra coisa: calado, e não mexe em nada.
  zerar()
  const p = pessoa('5511900000406')
  await p.foto('haia cimento 250')
  const idConf = p.idDe(/aguardando sua aprovação/)
  for (const texto of ['obrigado', 'acho que o valor tá meio alto, uns 1800', '2', '1800', 'cimento']) {
    const r = await p.diz(texto, idConf)
    ok(`citando, "${texto}" não é correção: fica calado`, r === null && pedidos('PATCH').length === 0)
  }
}
{
  // Texto solto continua seguindo as regras de sempre (resposta a uma pergunta).
  zerar()
  const p = pessoa('5511900000407')
  await p.foto('haia cimento'); await espera(20)
  ok('pergunta o valor, como sempre', p.ditos.some(t => /Qual foi o \*valor\*/.test(t)))
  await p.diz('valor 300'); await espera(20)
  ok('"valor 300" solto responde à pergunta e lança', ultimoGasto().valor === 300 && pedidos('PATCH').length === 0)
}

// ══ 4. Quem pode corrigir ═════════════════════════════════════════════════
{
  zerar()
  const dono = pessoa('5511900000408')
  await dono.foto('haia cimento 250')
  const idConf = dono.idDe(/aguardando sua aprovação/)

  // Está no grupo (o coringa deixa lançar), mas não mandou este e não está na lista.
  const colega = pessoa('5511900000409')
  let r = await colega.diz('valor 9999', idConf)
  ok('colega do grupo NÃO corrige o gasto de outro', ultimoGasto().valor === 250 && pedidos('PATCH').length === 0)
  ok('e é dito por quê', /Só quem mandou esse comprovante/.test(r ?? ''))
  r = await colega.diz('apagar', idConf)
  ok('nem cancela', pedidos('DELETE').length === 0 && /Só quem mandou/.test(r ?? '') && !colega.ditos.some(t => /^Cancelo/.test(t)))

  // Na lista por NÚMERO: pode.
  const chefe = pessoa(CHEFE)
  r = await chefe.diz('valor 260', idConf)
  ok('quem está na lista por número corrige o de qualquer um', ultimoGasto().valor === 260 && /R\$ 250,00 → R\$ 260,00/.test(r ?? ''))

  // E quem mandou, claro.
  r = await dono.diz('valor 270', idConf)
  ok('quem mandou corrige o próprio', ultimoGasto().valor === 270)
}

// ══ 5. O que o sistema recusa ═════════════════════════════════════════════
{
  // 409: já aprovado.
  zerar()
  const p = pessoa('5511900000410')
  const idFoto = await p.foto('haia cimento 250')
  const idConf = p.idDe(/aguardando sua aprovação/)
  ultimoGasto().status = 'APROVADO'
  let r = await p.diz('valor 1800', idConf)
  ok('já aprovado: diz que agora é só pelo sistema', r === 'Esse já foi aprovado — agora só pelo sistema.')
  ok('e a memória NÃO muda', memoria.resultadoDe(idFoto)?.valor === 250)
  await p.diz('apagar', idConf)
  r = await p.diz('sim', p.idDe(/^Cancelo/))
  ok('cancelar o já aprovado: mesma resposta, e fica na memória', r === 'Esse já foi aprovado — agora só pelo sistema.' && memoria.resultadoDe(idFoto) !== null)

  ultimoGasto().status = 'REJEITADO'
  r = await p.diz('valor 1800', idConf)
  ok('já rejeitado: não diz "aprovado"', /rejeitado ou cancelado/.test(r ?? '') && !/aprovado/.test(r ?? ''))
}
{
  // Obra que o robô não reconhece: pergunta com a lista, e o número escolhe.
  zerar()
  const p = pessoa('5511900000411')
  await p.foto('haia cimento 250')
  const idConf = p.idDe(/aguardando sua aprovação/)
  let r = await p.diz('obra xyz', idConf)
  const lista = p.ditos.at(-1) ?? ''
  ok('obra desconhecida: pergunta com a lista, sem chutar', pedidos('PATCH').length === 0 && /Não achei a obra "xyz"/.test(lista) && lista.includes(`1) ${TSUYA}`))
  r = await p.diz('1', p.idDe(/Não achei a obra/))
  ok('o número escolhe, e aí corrige', ultimoGasto().obra === TSUYA && r === `✏️ Corrigido: ${HAIA} → ${TSUYA}`)
}
{
  // Cidade com duas obras: pergunta só entre as duas.
  zerar()
  const p = pessoa('5511900000412')
  await p.foto('haia cimento 250')
  const idConf = p.idDe(/aguardando sua aprovação/)
  await p.diz('obra bastos', idConf)
  const lista = p.ditos.at(-1) ?? ''
  ok('obra ambígua: pergunta entre as candidatas', /Qual é a obra certa\?/.test(lista) && lista.includes(TSUYA) && lista.includes(OBRAS[1].nome) && !lista.includes(HAIA))
  await p.diz('2', idConf)
  ok('responder citando o próprio gasto também escolhe', ultimoGasto().obra === OBRAS[1].nome)
}
{
  // 422: o robô achou que conhecia a obra, o sistema diz que não.
  zerar()
  const p = pessoa('5511900000413')
  const idFoto = await p.foto('haia cimento 250')
  const idConf = p.idDe(/aguardando sua aprovação/)
  recusaObra = true
  await p.diz('obra tsuya', idConf)
  const lista = p.ditos.at(-1) ?? ''
  ok('422 do sistema: pergunta com a lista DELE', pedidos('PATCH').length === 1 && /É qual destas\?/.test(lista) && lista.includes(`3) ${HAIA}`))
  ok('e nada muda até a pessoa escolher', ultimoGasto().obra === HAIA && memoria.resultadoDe(idFoto)?.obra === HAIA)
}
{
  // Rateio: trocar a obra não dá — e nem chega a pedir ao sistema.
  zerar()
  const p = pessoa('5511900000414')
  await p.foto('haia e tsuya, areia, 400')
  const idConf = p.idDe(/aguardando sua aprovação/)
  ok('lançou rateado', ultimoGasto().rateio.length === 2)
  let r = await p.diz('obra toschi', idConf)
  ok('gasto dividido: a obra só se troca pelo sistema', /dividido entre obras/.test(r ?? '') && pedidos('PATCH').length === 0)
  r = await p.diz('valor 500', idConf)
  ok('mas o valor de um rateado corrige', ultimoGasto().valor === 500 && /R\$ 400,00 → R\$ 500,00/.test(r ?? ''))
}
{
  // Servidor de versão anterior: 404 nas rotas novas.
  zerar()
  const p = pessoa('5511900000415')
  const idFoto = await p.foto('haia cimento 250')
  const idConf = p.idDe(/aguardando sua aprovação/)
  semRotasDeCorrecao = true
  let r = await p.diz('valor 1800', idConf)
  ok('servidor sem a rota (404): manda corrigir pelo sistema', /corrige pelo sistema/.test(r ?? ''))
  ok('e a memória fica como estava', memoria.resultadoDe(idFoto)?.valor === 250)
  await p.diz('apagar', idConf)
  r = await p.diz('sim', p.idDe(/^Cancelo/))
  ok('cancelar sem a rota: mesma resposta, e nada sai da memória', /corrige pelo sistema/.test(r ?? '') && memoria.resultadoDe(idFoto) !== null)
}
{
  // Lançamento de antes desta versão: a memória não tem o id do gasto.
  zerar()
  memoria.anotarLancamento({ obra: HAIA, valor: 80, descricao: 'prego', de: '5511900000416', resultado: 'lancado', idMensagem: 'foto-antiga' })
  const p = pessoa('5511900000416')
  const r = await p.diz('valor 90', 'foto-antiga')
  ok('lançamento antigo, sem id do gasto: diz que é pelo sistema, sem chamar nada', /corrige pelo sistema/.test(r ?? '') && pedidos('PATCH').length === 0)
}

// ══ 6. A memória corrigida vale para o repetido ═══════════════════════════
{
  zerar()
  const p = pessoa('5511900000417')
  await p.foto('haia cimento 250')
  await p.diz('valor 333', p.idDe(/aguardando sua aprovação/))
  await p.foto('haia cimento 250'); await espera(20)
  ok('depois da correção, o valor ANTIGO não levanta suspeita de repetido', !p.ditos.some(t => /outro pagamento, ou é o mesmo/.test(t)) && gastos.size >= 2 && ultimoGasto().valor === 250)
  await p.foto('haia cimento 333'); await espera(20)
  ok('e o valor NOVO levanta', p.ditos.some(t => /outro pagamento, ou é o mesmo/.test(t)))
}

// ══ 7. As frases, direto ══════════════════════════════════════════════════
{
  const nomes = OBRAS
  ok('"o valor certo é 95,50"', lerCorrecao('o valor certo é 95,50', nomes)?.valor === 95.5)
  ok('"R$ 40" (com cara de dinheiro, sem rótulo)', lerCorrecao('R$ 40', nomes)?.valor === 40)
  ok('"1.800,00" sozinho', lerCorrecao('1.800,00', nomes)?.valor === 1800)
  ok('"1800" sozinho NÃO: pode ser qualquer coisa', lerCorrecao('1800', nomes) === null)
  ok('dois valores: não escolhe', lerCorrecao('valor 10,00 e 20,00', nomes) === null)
  ok('"dia 30/10/2026" é data', lerCorrecao('dia 30/10/2026', nomes)?.campo === 'data')
  ok('"é mão de obra" é categoria', lerCorrecao('é mão de obra', nomes)?.valor === 'MAO_DE_OBRA')
  ok('"cimento" NÃO é categoria: descreve a compra', lerCorrecao('cimento', nomes) === null)
  ok('"apaga esse" cancela', lerCorrecao('apaga esse', nomes)?.cancelar === true)
  ok('"cancelar tudo" não é o cancelamento de UM gasto', lerCorrecao('cancelar tudo', nomes) === null)
  ok('vazio não é nada', lerCorrecao('', nomes) === null && lerCorrecao(null, nomes) === null)
}

_limparPendentes()
srv.close()
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
