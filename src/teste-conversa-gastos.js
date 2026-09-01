/**
 * O robô perguntando o que falta antes de lançar.
 *
 * É a diferença entre "comprovante numa caixa esperando alguém digitar" e
 * "lançamento pronto esperando um clique". Sem perguntar, todo comprovante
 * sem valor na legenda vira trabalho manual — e valor na legenda é
 * justamente o que as pessoas esquecem.
 *
 * Roda contra um sistema de obras de mentira, e SEM chave de IA: o que se
 * testa aqui é a decisão (lançar, perguntar, ou desistir para a caixa), não
 * a leitura da imagem.
 */
import { createServer } from 'node:http'

process.env.GEMINI_API_KEY = ''            // sem leitura de imagem, de propósito
process.env.GASTOS_AUTORIZADOS = '*'
process.env.GASTOS_GRUPOS = 'Comprovantes'
process.env.OBRAS_API_TOKEN = 'token-de-teste'
process.env.GASTOS_ESPERA_DESCRICAO_MS = '50'
process.env.GASTOS_ESPERA_RESPOSTA_MS = '300'

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

/**
 * As obras, como elas são de verdade: nome oficial da escola, e a cidade só
 * no endereço. Duas em Bastos, de propósito — é o caso ambíguo.
 */
const OBRAS = [
  { nome: 'EE PROFA TSUYA OHNO KIMURA', endereco: 'Rua das Flores 100, Bastos - SP' },
  { nome: 'EE OSWALDO LUIZ SANCHES TOSCHI', endereco: 'Rua Sete 45, Bastos - SP' },
  { nome: 'EE/ETEC AGUIA DE HAIA', endereco: 'Av Aguia de Haia 500, Sao Paulo - SP' },
]

/** Sistema de obras de mentira. */
const chamadas = []
const srv = createServer((req, res) => {
  let corpo = ''
  req.on('data', c => { corpo += c })
  req.on('end', () => {
    chamadas.push({ url: req.url, corpo })

    if (req.url.endsWith('/comprovantes/obras')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // Nomes e endereços REAIS em forma: o nome da obra é o da escola, e a
      // cidade só existe no endereço.
      return res.end(JSON.stringify({
        obras: OBRAS.map(o => o.nome),
        detalhes: OBRAS,
      }))
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

const { tratar, encerrar, _limparPendentes } = await import('./gastos.js')
const { _limparCacheObras } = await import('./obras-client.js')

const foto = Buffer.from('imagem-do-comprovante')
const base = { chat: '123@g.us', chatNome: 'Comprovantes', ehGrupo: true }
const espera = (ms) => new Promise(r => setTimeout(r, ms))

function novo(de) {
  chamadas.length = 0
  _limparPendentes()
  _limparCacheObras()
  const ditos = []
  return {
    ditos,
    foto: (texto, id) => tratar({
      ...base, de, arquivo: foto, nomeArquivo: 'c.jpg', tipo: 'image/jpeg',
      texto, idMensagem: id ?? `m-${Math.random()}`,
      enviarResposta: async (t) => { ditos.push(t) },
    }),
    diz: (texto) => tratar({
      ...base, de, texto, idMensagem: `t-${Math.random()}`,
      enviarResposta: async (t) => { ditos.push(t) },
    }),
  }
}

const rota = () => chamadas.map(c => c.url.replace(/^.*\/comprovantes\//, '')).filter(u => u !== 'obras')

// ── 1. Legenda completa: lança direto ─────────────────────────────────────
{
  const p = novo('5511900000001')
  const r = await p.foto('haia, tijolos e areia, material, 2500,00')
  ok('lança direto quando não falta nada', r.includes('aguardando sua aprovação'))
  ok('e diz em qual obra', r.includes('AGUIA DE HAIA'))
  ok('e repete o valor entendido', r.includes('R$ 2.500,00'))
  ok('foi para /lancar, não para a caixa', rota().includes('lancar') && !rota().includes('receber'))
}

// ── 2. Falta o valor: PERGUNTA ────────────────────────────────────────────
{
  const p = novo('5511900000002')
  const r = await p.foto('haia tijolos e areia')
  ok('pergunta o valor quando falta', /valor/i.test(r))
  ok('mostra o que já entendeu antes de perguntar', r.includes('AGUIA DE HAIA'))
  ok('e ainda NÃO enviou nada', rota().length === 0)

  const r2 = await p.diz('2500,00')
  ok('responder o valor faz lançar', r2.includes('aguardando sua aprovação'))
  ok('com o valor respondido', r2.includes('R$ 2.500,00'))
  ok('e a obra da legenda não se perdeu', r2.includes('AGUIA DE HAIA'))
}

// ── 3. Falta a obra: pergunta e oferece a lista ───────────────────────────
{
  const p = novo('5511900000003')
  const r = await p.foto('tijolos e areia 2500,00')
  ok('pergunta a obra quando falta', /obra/i.test(r))
  ok('oferece os nomes das obras do sistema', r.includes('AGUIA DE HAIA'))

  const r2 = await p.diz('haia')
  ok('responder a obra faz lançar', r2.includes('aguardando sua aprovação'))
  ok('e o valor da legenda não se perdeu', r2.includes('R$ 2.500,00'))
}

// ── 4. Faltam os dois ─────────────────────────────────────────────────────
{
  const p = novo('5511900000004')
  const r = await p.foto('nota do fornecedor')
  ok('pergunta os dois de uma vez', /obra/i.test(r) && /valor/i.test(r))

  const r2 = await p.diz('toschi 890')
  ok('uma resposta só resolve os dois', r2.includes('aguardando sua aprovação'))
  ok('acha a obra na resposta', r2.includes('TOSCHI'))
  ok('acha o valor na resposta', r2.includes('R$ 890,00'))
}

// ── 5. Não respondeu: vai para a caixa, e AVISA ───────────────────────────
// Comprovante na caixa é pior que lançado, e muito melhor que perdido — e a
// pessoa precisa saber que aconteceu, senão acha que sumiu.
{
  const p = novo('5511900000005')
  const r = await p.foto('nota sem nada')
  ok('perguntou', /obra/i.test(r))

  await espera(500)   // estoura o prazo de resposta
  ok('passou o prazo e foi para a caixa', rota().includes('receber'))
  ok('e AVISOU que foi para a caixa', p.ditos.some(t => t.includes('📥')))
  ok('dizendo o que faltou', p.ditos.some(t => /Faltou/i.test(t)))
}

// ── 6. Desistir na hora ───────────────────────────────────────────────────
{
  const p = novo('5511900000006')
  await p.foto('nota qualquer')
  const r = await p.diz('deixa pra lá')
  ok('desistir manda para a caixa na hora', r.includes('📥'))
  ok('sem esperar o prazo', rota().includes('receber'))
}

// ── 7. O que NÃO deve virar resposta ──────────────────────────────────────
{
  const p = novo('5511900000007')
  ok('texto solto sem comprovante parado é ignorado', (await p.diz('bom dia pessoal')) === null)
}

// ── 8. Obra que o SISTEMA não reconhece ───────────────────────────────────
// Nossa lista pode estar velha. Quem manda no nome da obra é o sistema, e
// quando ele recusa, pergunta-se de novo com os nomes que ELE devolveu.
{
  const p = novo('5511900000008')
  const r = await p.foto('obra fantasma cimento 100')
  // "obra fantasma" não casa com a lista, então já pergunta antes de enviar
  ok('obra desconhecida vira pergunta', /obra/i.test(r))
}

// ── 9. VÁRIAS fotos de uma vez ────────────────────────────────────────────
// Foi assim que quebrou no uso real: cada foto nova cancelava a anterior, e
// as respostas não tinham a qual pergunta pertencer. "Acabou que misturou."
//
// Agora é FILA, uma pergunta por vez.
{
  const p = novo('5511900000009')

  const r1 = await p.foto('nota A')
  ok('pergunta sobre a primeira', /obra/i.test(r1) || /valor/i.test(r1))

  const r2 = await p.foto('nota B')
  ok('a segunda ENTRA NA FILA, não cancela a primeira', /fila/i.test(r2))
  ok('e diz a posição dela', r2.includes('2'))

  const r3 = await p.foto('nota C')
  ok('a terceira também entra', /fila/i.test(r3))

  ok('nada foi enviado ainda — está esperando resposta', rota().length === 0)

  // Responder resolve a PRIMEIRA e já pergunta sobre a segunda.
  const r4 = await p.diz('haia cimento 100')
  ok('responder lança a primeira', r4.includes('aguardando sua aprovação'))
  ok('e já pergunta sobre a próxima', /obra/i.test(r4) || p.ditos.some(t => /obra/i.test(t)))

  const r5 = await p.diz('tsuya areia 200')
  ok('a segunda também lança', r5.includes('aguardando sua aprovação'))

  const r6 = await p.diz('toschi tinta 300')
  ok('e a terceira', r6.includes('aguardando sua aprovação'))

  const lancados = chamadas.filter(c => c.url.includes('lancar')).length
  ok('as TRÊS foram lançadas, nenhuma perdida', lancados === 3)
}

// ── 9b. Saber o que está esperando, e desistir de tudo ────────────────────
// "Ficou meio bagunçado na conversa" — precisa haver um jeito de ver o que
// falta e de sair do buraco sem perder comprovante.
{
  const p = novo('5511900000019')
  await p.foto('nota X')
  await p.foto('nota Y')

  const lista = await p.diz('pendentes')
  ok('"pendentes" lista o que está esperando', /2 comprovante/i.test(lista))

  const r = await p.diz('cancelar tudo')
  ok('"cancelar tudo" resolve', /caixa/i.test(r))
  ok('mandando TODOS para a caixa', chamadas.filter(c => c.url.includes('receber')).length === 2)
  ok('e diz onde achar', r.includes('/m/gasto'))

  ok('depois disso a fila está vazia', /não tenho nenhum/i.test(await p.diz('pendentes')))
}

// ── 10. Cidade com DUAS obras: pergunta entre elas ────────────────────────
// "bastos" é a cidade, e tem duas escolas. Chutar uma lançaria o custo na
// errada, calado. Perguntar entre as duas é curto e mostra que ele entendeu.
{
  const p = novo('5511900000010')
  const r = await p.foto('bastos cimento 500')
  ok('cidade ambígua vira pergunta', /qual delas/i.test(r))
  ok('lista a primeira candidata', r.includes('TSUYA'))
  ok('lista a segunda candidata', r.includes('TOSCHI'))
  ok('numera as opções', /1\)/.test(r) && /2\)/.test(r))
  ok('NÃO lista as obras de outra cidade', !r.includes('AGUIA'))

  const r2 = await p.diz('2')
  ok('responder o NÚMERO escolhe a obra', r2.includes('TOSCHI'))
  ok('e o valor da legenda não virou o número', r2.includes('R$ 500,00'))
}

// Responder pelo nome também vale, não só pelo número.
{
  const p = novo('5511900000011')
  await p.foto('bastos cimento 500')
  const r = await p.diz('tsuya')
  ok('responder pelo nome também escolhe', r.includes('TSUYA'))
}

// A cidade sem ambiguidade resolve sozinha.
{
  const p = novo('5511900000012')
  const r = await p.foto('sao paulo tinta 300')
  ok('cidade de uma obra só resolve direto', r.includes('AGUIA DE HAIA'))
}

// ── 11. Reinício não engole comprovante ───────────────────────────────────
// Um deploy no meio da tarde perderia calado o que estava esperando
// resposta: a pessoa responderia a pergunta e não receberia nada, e a foto
// teria sumido. Na caixa ela pelo menos existe.
{
  const p = novo('5511900000020')
  const r = await p.foto('nota esperando resposta')
  ok('está esperando resposta', /obra/i.test(r))
  ok('e nada foi enviado ainda', rota().length === 0)

  const quantos = await encerrar()
  ok('encerrar descarrega o que esperava', quantos === 1)
  ok('foi para a caixa', rota().includes('receber'))
  ok('e a pessoa foi avisada do reinício', p.ditos.some(t => /reiniciar/i.test(t)))
}

// ── 12. Legenda enorme não trava o robô ───────────────────────────────────
// A busca compara palavras × obras, e cada comparação é uma distância de
// edição: sem teto, 2000 palavras levavam 18 SEGUNDOS — e o robô atende uma
// mensagem por vez, então nesse tempo ninguém mais é respondido.
{
  const p = novo('5511900000021')
  const enorme = Array.from({ length: 3000 }, (_, i) => `palavra${i}`).join(' ')
  const t0 = Date.now()
  const r = await p.foto(`haia ${enorme} 250,00`)
  const levou = Date.now() - t0

  ok(`legenda de 3000 palavras responde rápido (${levou}ms)`, levou < 5000)
  ok('e ainda acha a obra', r.includes('AGUIA DE HAIA'))
  ok('e ainda acha o valor', r.includes('R$ 250,00'))
}

// ── 13. Rateio: uma compra, mais de uma obra ──────────────────────────────
// "As vezes eu compro, e é para mais de uma obra, o mesmo item." Sem isso a
// pessoa lança tudo numa obra e o custo da outra fica errado — e ninguém
// percebe, porque o total bate com o comprovante.
{
  const p = novo('5511900000030')
  const r = await p.foto('haia e tsuya areia, material, 600')
  ok('rateia citando as duas obras', /rateado entre 2/i.test(r))
  ok('mostra quanto foi para cada uma', r.includes('R$ 300,00'))
  ok('lista as duas obras', r.includes('AGUIA DE HAIA') && r.includes('TSUYA'))
}

// Divisão que não fecha redondo não pode perder centavo: o total tem que
// bater com o comprovante na mão de quem confere.
{
  const p = novo('5511900000031')
  const r = await p.foto('haia tsuya toschi tinta, material, 100')
  ok('divide entre três', /rateado entre 3/i.test(r))
  ok('a sobra do centavo vai para a primeira', r.includes('R$ 33,34'))
  ok('e as outras ficam com o resto', (r.match(/R\$ 33,33/g) ?? []).length === 2)
}

// Uma obra só continua sendo lançamento simples, sem falar em rateio.
{
  const p = novo('5511900000032')
  const r = await p.foto('tsuya cimento 300')
  ok('obra única não vira rateio', !/rateado/i.test(r) && r.includes('aguardando sua aprovação'))
}

srv.close()
_limparPendentes()
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exitCode = falhas ? 1 : 0
