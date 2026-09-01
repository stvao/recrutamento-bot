/**
 * O robô perguntando o que falta, e esperando você responder.
 *
 * A parte que mais importa aqui é a CITAÇÃO. Com três comprovantes
 * esperando, é ela que diz a qual deles a resposta pertence — e sem ela a
 * conversa vira o que virou no uso real: "acabou que misturou".
 *
 * Roda contra um sistema de obras de mentira e SEM chave de IA: o que se
 * testa é a decisão (lançar, perguntar, cobrar, desistir), não a leitura da
 * imagem.
 */
import { createServer } from 'node:http'
import { rmSync } from 'node:fs'

const PASTA = './dados/teste-pendentes'
process.env.GASTOS_PENDENTES_DIR = PASTA
process.env.GEMINI_API_KEY = ''            // sem leitura de imagem, de propósito
process.env.GASTOS_AUTORIZADOS = '*'
process.env.GASTOS_GRUPOS = 'Comprovantes'
process.env.OBRAS_API_TOKEN = 'token-de-teste'
process.env.GASTOS_ESPERA_DESCRICAO_MS = '50'
process.env.GASTOS_COBRAR_APOS_MS = '80'
process.env.GASTOS_DESISTIR_APOS_MS = '250'
process.env.GASTOS_RONDA_MS = '40'

rmSync(PASTA, { recursive: true, force: true })

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

/**
 * As obras como elas são de verdade: nome oficial da escola, e a cidade só
 * no endereço. Duas em Bastos, de propósito — é o caso ambíguo.
 */
const OBRAS = [
  { nome: 'EE PROFA TSUYA OHNO KIMURA', endereco: 'Rua das Flores 100, Bastos - SP' },
  { nome: 'EE OSWALDO LUIZ SANCHES TOSCHI', endereco: 'Rua Sete 45, Bastos - SP' },
  { nome: 'EE/ETEC AGUIA DE HAIA', endereco: 'Av Aguia de Haia 500, Sao Paulo - SP' },
]

const chamadas = []
const srv = createServer((req, res) => {
  let corpo = ''
  req.on('data', c => { corpo += c })
  req.on('end', () => {
    chamadas.push({ url: req.url, corpo })

    if (req.url.endsWith('/comprovantes/obras')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ obras: OBRAS.map(o => o.nome), detalhes: OBRAS }))
    }

    if (req.url.endsWith('/comprovantes/lancar')) {
      const campo = (n) => new RegExp(`name="${n}"\r?\n\r?\n([^\r]*)`).exec(corpo)?.[1] ?? ''
      const obra = campo('obra')
      const valor = Number(campo('valor') || '0')
      const extras = campo('rateio').split(',').map(x => x.trim()).filter(Boolean)

      if (!OBRAS.some(o => o.nome === obra.trim())) {
        res.writeHead(422, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ message: 'não achei', obras: OBRAS.map(o => o.nome) }))
      }

      // Divide como o servidor divide: a sobra de centavo vai para a
      // primeira, para o total fechar com o comprovante.
      const todas = [obra.trim(), ...extras]
      const cent = Math.round(valor * 100)
      const base = Math.floor(cent / todas.length)
      const sobra = cent - base * todas.length
      const partes = todas.map((o, k) => ({ obra: o, valor: (base + (k < sobra ? 1 : 0)) / 100 }))

      res.writeHead(201, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        ok: true, id: 'g1', obra: todas[0], obras: todas, rateio: partes,
        mensagem: todas.length === 1
          ? `Lançado em ${todas[0]}, aguardando sua aprovação.`
          : `Rateado entre ${todas.length} obras, aguardando sua aprovação.`,
      }))
    }

    // /receber — a caixa
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, id: 'c1', mensagem: 'Comprovante recebido.', pendentes: 1 }))
  })
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
process.env.OBRAS_API_URL = `http://127.0.0.1:${srv.address().port}`

const { tratar, iniciarRonda, _limparPendentes } = await import('./gastos.js')
const { _limparCacheObras } = await import('./obras-client.js')
iniciarRonda()

const foto = Buffer.from('imagem-do-comprovante')
const base = { chat: '123@g.us', chatNome: 'Comprovantes', ehGrupo: true }
const espera = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * Uma pessoa conversando com o robô.
 *
 * `ditos` guarda tudo que o robô mandou — inclusive fora da resposta
 * imediata: a pergunta sobre o segundo comprovante, a cobrança, o aviso de
 * prazo. É por ali que se confere o que ele falou sem ter sido perguntado.
 */
function pessoa(de) {
  chamadas.length = 0
  _limparPendentes()
  _limparCacheObras()
  const ditos = []
  let n = 0

  const enviarResposta = async (t) => {
    ditos.push(t)
    return { id: `bot-${de}-${++n}` }   // o id que ela vai citar
  }

  const guardar = (r) => { if (typeof r === 'string') ditos.push(r); return r }

  return {
    ditos,
    ultimoId: () => `bot-${de}-${n}`,
    foto: async (texto, id) => guardar(await tratar({
      ...base, de, arquivo: foto, nomeArquivo: 'c.jpg', tipo: 'image/jpeg',
      texto, idMensagem: id ?? `foto-${de}-${Math.random().toString(36).slice(2, 8)}`,
      enviarResposta,
    })),
    diz: async (texto, citando) => guardar(await tratar({
      ...base, de, texto, idMensagem: `t-${Math.random()}`,
      respondendoA: citando ?? null,
      enviarResposta,
    })),
  }
}

const lancados = () => chamadas.filter(c => c.url.includes('lancar')).length
const naCaixa = () => chamadas.filter(c => c.url.includes('receber')).length
const enviados = () => lancados() + naCaixa()

// ── 1. Legenda completa: lança direto ─────────────────────────────────────
{
  const p = pessoa('5511900000001')
  const r = await p.foto('haia, tijolos e areia, material, 2500,00')
  ok('lança direto quando não falta nada', r.includes('aguardando sua aprovação'))
  ok('e diz em qual obra', r.includes('AGUIA DE HAIA'))
  ok('e repete o valor entendido', r.includes('R$ 2.500,00'))
  ok('foi para /lancar, não para a caixa', lancados() === 1 && naCaixa() === 0)
}

// ── 2. Falta o valor: pergunta ────────────────────────────────────────────
{
  const p = pessoa('5511900000002')
  await p.foto('haia tijolos e areia')
  await espera(20)
  ok('pergunta o valor quando falta', p.ditos.some(t => /valor/i.test(t)))
  ok('mostra o que já entendeu antes de perguntar', p.ditos.some(t => t.includes('AGUIA DE HAIA')))
  ok('e ainda NÃO enviou nada', enviados() === 0)

  await p.diz('2500,00')
  await espera(20)
  ok('responder o valor faz lançar', p.ditos.some(t => t.includes('aguardando sua aprovação')))
  ok('com o valor respondido', p.ditos.some(t => t.includes('R$ 2.500,00')))
}

// ── 3. TRÊS de uma vez, respondidos FORA DE ORDEM ─────────────────────────
// É o caso que quebrou no uso real. Cada comprovante espera sozinho, e a
// CITAÇÃO diz a qual deles a resposta pertence — a ordem é de quem responde.
{
  const p = pessoa('5511900000003')

  await p.foto('nota A', 'foto-A'); await espera(15)
  const idA = p.ultimoId()
  await p.foto('nota B', 'foto-B'); await espera(15)
  const idB = p.ultimoId()
  await p.foto('nota C', 'foto-C'); await espera(15)

  ok('perguntou sobre os três', p.ditos.filter(t => /obra/i.test(t)).length >= 3)
  ok('nenhum foi enviado ainda', enviados() === 0)

  // Responde o do MEIO primeiro, citando a pergunta dele.
  await p.diz('haia cimento 100', idB); await espera(20)
  ok('responder o do meio lança só ele', lancados() === 1)

  // Depois o ÚLTIMO, citando a FOTO em vez da pergunta.
  await p.diz('tsuya areia 200', 'foto-C'); await espera(20)
  ok('citar a FOTO também funciona', lancados() === 2)

  // E o primeiro por último.
  await p.diz('toschi tinta 300', idA); await espera(20)
  ok('os três foram lançados, em qualquer ordem', lancados() === 3)
  ok('e nenhum foi para a caixa', naCaixa() === 0)
}

// ── 4. Vários esperando e resposta SEM citação ────────────────────────────
// Adivinhar aqui é o que faz a resposta cair no comprovante errado.
{
  const p = pessoa('5511900000004')
  await p.foto('nota X', 'fx'); await espera(15)
  await p.foto('nota Y', 'fy'); await espera(15)

  const r = await p.diz('haia cimento 50')
  ok('sem citação, pergunta de qual é', /qual|esperando resposta/i.test(r ?? ''))
  ok('e não lança no palpite', lancados() === 0)
}

// ── 5. UM só esperando: não precisa citar ─────────────────────────────────
// Exigir citação quando não há dúvida seria burocracia.
{
  const p = pessoa('5511900000005')
  await p.foto('nota única'); await espera(15)
  await p.diz('haia cimento 70'); await espera(20)
  ok('com um só esperando, responder direto basta', lancados() === 1)
}

// ── 6. Demorou a responder: ele COBRA, uma vez ────────────────────────────
// "Às vezes estou ocupado, e posso não ver a mensagem."
{
  const p = pessoa('5511900000006')
  await p.foto('nota esquecida')
  await espera(160)

  ok('cobra quem não respondeu', p.ditos.some(t => /lembrete/i.test(t)))
  ok('a cobrança repete a pergunta', p.ditos.some(t => /lembrete/i.test(t) && /obra|valor/i.test(t)))
  ok('e ainda não desistiu', naCaixa() === 0)

  const cobrancas = p.ditos.filter(t => /lembrete/i.test(t)).length
  await espera(80)
  ok('não fica cobrando sem parar', p.ditos.filter(t => /lembrete/i.test(t)).length === cobrancas)
}

// ── 7. Demorou DEMAIS: vai para a caixa, e avisa ──────────────────────────
{
  const p = pessoa('5511900000007')
  await p.foto('nota abandonada')
  await espera(450)

  ok('passado o prazo, vai para a caixa', naCaixa() >= 1)
  ok('e diz que desistiu de esperar', p.ditos.some(t => /não tive resposta/i.test(t)))
}

// ── 8. Saber o que falta, e sair do buraco ────────────────────────────────
{
  const p = pessoa('5511900000008')
  await p.foto('nota 1'); await espera(15)
  await p.foto('nota 2'); await espera(15)

  const lista = await p.diz('pendentes')
  ok('"pendentes" lista o que está esperando', /2 comprovante/i.test(lista))
  ok('dizendo o que falta em cada um', /falta/i.test(lista))
  ok('e como responder', /citando/i.test(lista))

  const r = await p.diz('cancelar tudo')
  ok('"cancelar tudo" resolve', /caixa/i.test(r))
  ok('mandando todos para a caixa', naCaixa() === 2)
  ok('e diz onde achar', r.includes('/m/gasto'))
  ok('depois a lista fica vazia', /não tenho nenhum/i.test(await p.diz('pendentes')))
}

// ── 9. Cidade com duas obras: pergunta entre elas ─────────────────────────
{
  const p = pessoa('5511900000009')
  await p.foto('bastos cimento 500'); await espera(20)
  const pergunta = p.ditos.find(t => /qual delas/i.test(t)) ?? ''
  ok('cidade ambígua vira pergunta', pergunta.length > 0)
  ok('lista as duas candidatas', pergunta.includes('TSUYA') && pergunta.includes('TOSCHI'))
  ok('e NÃO as de outra cidade', !pergunta.includes('AGUIA'))

  await p.diz('2'); await espera(20)
  ok('responder o número escolhe a obra', p.ditos.some(t => t.includes('TOSCHI')))
  ok('e o valor não virou o número', p.ditos.some(t => t.includes('R$ 500,00')))
}

// ── 10. Rateio: uma compra, mais de uma obra ──────────────────────────────
{
  const p = pessoa('5511900000010')
  const r = await p.foto('haia e tsuya areia, material, 600')
  ok('rateia citando as duas obras', /rateado entre 2/i.test(r))
  ok('mostra quanto foi para cada uma', r.includes('R$ 300,00'))

  const p2 = pessoa('5511900000011')
  const r2 = await p2.foto('haia tsuya toschi tinta, material, 100')
  ok('divide entre três', /rateado entre 3/i.test(r2))
  ok('a sobra do centavo vai para a primeira', r2.includes('R$ 33,34'))
  ok('e as outras ficam com o resto', (r2.match(/R\$ 33,33/g) ?? []).length === 2)
}

// ── 11. O que NÃO deve virar resposta ─────────────────────────────────────
{
  const p = pessoa('5511900000012')
  ok('texto solto sem nada esperando é ignorado', (await p.diz('bom dia pessoal')) === null)
  ok('"ping" responde', /estou aqui/i.test(await p.diz('ping')))
}

// ── 12. Legenda enorme não trava o robô ───────────────────────────────────
{
  const p = pessoa('5511900000013')
  const enorme = Array.from({ length: 3000 }, (_, i) => `palavra${i}`).join(' ')
  const t0 = Date.now()
  const r = await p.foto(`haia ${enorme} 250,00`)
  const levou = Date.now() - t0
  ok(`legenda de 3000 palavras responde rápido (${levou}ms)`, levou < 5000)
  ok('e ainda acha a obra e o valor', r.includes('AGUIA DE HAIA') && r.includes('R$ 250,00'))
}

// ── 13. Reinício não perde comprovante ────────────────────────────────────
// O arquivo mora em disco justamente para isto: um deploy no meio da tarde
// não pode engolir o que estava esperando resposta.
{
  const p = pessoa('5511900000014')
  await p.foto('nota que sobrevive', 'foto-sobrevive'); await espera(15)
  ok('está esperando', p.ditos.some(t => /obra/i.test(t)))

  // Simula a subida seguinte: um módulo novo, relendo do disco.
  const outro = await import(`./pendentes.js?reinicio=${Date.now()}`)
  ok('o comprovante é relido do disco', outro.carregar() >= 1)
  const recuperado = outro.todos().find(x => x.idMensagem === 'foto-sobrevive')
  ok('com a ficha inteira', Boolean(recuperado))
  ok('e o arquivo ainda lá', outro.arquivoDe(recuperado)?.length === foto.length)
}

srv.close()
_limparPendentes()
rmSync(PASTA, { recursive: true, force: true })
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exitCode = falhas ? 1 : 0
