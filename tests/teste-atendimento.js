/**
 * Testes da camada de atendimento.
 *
 * O que se protege aqui é a fronteira entre o que o modelo DIZ e o que vira
 * registro no RH. Modelo de linguagem erra, inventa e às vezes some — e
 * nenhuma dessas três coisas pode virar candidatura errada nem candidato sem
 * resposta.
 *
 *   node src/teste-atendimento.js
 */
process.env.GEMINI_API_KEY = 'chave-de-teste'
// Sem pausa depois da cota esgotada: em produção são 10 minutos até tentar de
// novo, e aqui o teste simula a cota acabando e a IA voltando em seguida.
process.env.IA_PAUSA_COTA_MS = '0'

const { atender, iniciarAtendimento } = await import('../src/atendimento.js')

let falhas = 0
function conf(desc, ok) {
  if (!ok) falhas++
  console.log(`${ok ? 'ok  ' : 'FALHA '}${desc}`)
}

const fetchReal = globalThis.fetch

/** Faz a próxima chamada ao modelo devolver isto. */
function modeloResponde(objeto) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(objeto) }] } }],
    }),
  })
}

function modeloFalha(status = 500) {
  globalThis.fetch = async () => ({ ok: false, status, json: async () => ({}) })
}

const base = { modo: 'ia', whatsapp: '5514999990000', historico: [] }

// ── Abertura ────────────────────────────────────────────────────────────────
const ini = iniciarAtendimento('5514999990000')
conf('ela se apresenta pelo nome', ini.resposta.includes('Maria Vitória'))
conf('e já pergunta a função', /função|vaga/i.test(ini.resposta))

// ── Extração conferida contra a lista real ──────────────────────────────────
modeloResponde({ resposta: 'Boa! E em qual cidade?', vaga: 'Pedreiro' })
let r = await atender(base, 'quero ser pedreiro')
conf('aceita vaga que existe', r.estado.vaga === 'Pedreiro')

modeloResponde({ resposta: 'Certo!', vaga: 'Encanador' })
r = await atender(base, 'sou encanador')
conf('DESCARTA vaga que a empresa não tem', r.estado.vaga === null)

modeloResponde({ resposta: 'Ok', vaga: 'PEDREIRO' })
r = await atender(base, 'PEDREIRO')
conf('aceita a vaga mesmo em caixa alta', r.estado.vaga === 'Pedreiro')

modeloResponde({ resposta: 'Ok', cidade: 'São Paulo' })
r = await atender(base, 'moro em sao paulo')
conf('DESCARTA cidade onde não há obra', r.estado.cidade === null)

modeloResponde({ resposta: 'Ok', cidade: 'peruibe' })
r = await atender(base, 'peruibe')
conf('aceita cidade sem acento e devolve o nome certo', r.estado.cidade === 'Peruíbe')

// ── O que vira registro ─────────────────────────────────────────────────────
modeloResponde({ resposta: 'Prontinho!', tudoColetado: true, nomeCompleto: 'Joao da Silva' })
r = await atender(base, 'Joao da Silva')
conf('NÃO grava só porque o modelo disse que terminou', !r.acao)

modeloResponde({
  resposta: 'Prontinho, João!', tudoColetado: true,
  nomeCompleto: 'Joao da Silva', vaga: 'Pedreiro', cidade: 'Peruíbe',
  temExperiencia: 'sim', temRegistro: 'nao',
})
r = await atender(base, 'Joao da Silva')
conf('grava quando nome, vaga e cidade estão completos', r.acao?.tipo === 'criar_candidatura')
conf('  com os dados certos',
  r.acao?.dados.nomeCompleto === 'Joao da Silva'
  && r.acao?.dados.vagaPretendida === 'Pedreiro'
  && r.acao?.dados.cidadePreferencia === 'Peruíbe')
conf('  e a experiência traduzida', r.acao?.dados.tempoExperiencia === 'Com experiência')
conf('  registrando que nunca teve carteira assinada',
  /Nunca teve registro/.test(r.acao?.dados.resumoExperiencia ?? ''))

// Reenvia a cada dado novo, para o RH ATUALIZAR a mesma candidatura — mas
// só a primeira vez conta como conclusão nas métricas.
const jaGravado = { ...r.estado }
modeloResponde({
  resposta: 'Anotado!', nomeCompleto: 'Joao da Silva', vaga: 'Pedreiro',
  cidade: 'Peruíbe', bairro: 'Centro', tamanhoBota: '42',
})
const r2 = await atender(jaGravado, 'moro no centro, bota 42')
conf('reenvia quando aparece dado novo da ficha', r2.acao?.tipo === 'criar_candidatura')
conf('  mas marcado como NÃO sendo a primeira vez', r2.acao?.primeiraVez === false)
conf('  levando o bairro', r2.acao?.dados.bairro === 'Centro')
conf('  e o tamanho da bota', r2.acao?.dados.tamanhoBota === '42')

// Campo vazio não pode apagar o que já tinha.
modeloResponde({ resposta: 'Certo', nomeCompleto: 'Joao da Silva', vaga: 'Pedreiro', cidade: 'Peruíbe', bairro: '' })
const r3 = await atender(r2.estado, 'ok')
conf('campo vazio NÃO apaga o que a pessoa já respondeu', r3.estado.bairro === 'Centro')

// nome que não é nome
modeloResponde({ resposta: 'Ok', nomeCompleto: 'valeu', vaga: 'Pedreiro', cidade: 'Peruíbe' })
r = await atender(base, 'valeu')
conf('recusa "valeu" como nome completo', r.estado.nome === null && !r.acao)

modeloResponde({ resposta: 'Ok', nomeCompleto: 'Joao', vaga: 'Pedreiro', cidade: 'Peruíbe' })
r = await atender(base, 'Joao')
conf('exige sobrenome', r.estado.nome === null)

// ── Quando o modelo some ────────────────────────────────────────────────────
modeloFalha(429)   // cota do dia estourada — o caso mais provável no gratuito
r = await atender(base, 'quero ser pedreiro')
conf('cota estourada: o candidato AINDA recebe resposta', Boolean(r.resposta?.trim()))

// Uma travada é comum (≈1 em 5) e não pode rebaixar a conversa para sempre —
// senão quase toda conversa acabaria no roteiro, que é o que se substituiu.
conf('uma falha NÃO rebaixa a conversa', r.estado.modo === 'ia')
conf('  mas fica contada', r.estado.falhasIA === 1)

let comFalhas = r.estado
for (let i = 0; i < 2; i++) comFalhas = (await atender(comFalhas, 'oi')).estado
conf('três falhas seguidas: aí sim assume o roteiro', comFalhas.modo === 'roteiro')

// E o roteiro continua de onde ela parou, sem perguntar tudo de novo.
modeloResponde({ resposta: 'Ok', vaga: 'Pedreiro', cidade: 'Peruíbe' })
const comDados = (await atender(base, 'pedreiro em peruibe')).estado
modeloFalha(500)
const caiu = await atender(comDados, 'e ai?')
conf('ao cair, não pergunta a vaga que a pessoa já respondeu',
  !/qual vaga|Para qual vaga/i.test(caiu.resposta))

modeloResponde({ resposta: 'voltei!', vaga: 'Pedreiro' })
const voltou = await atender(caiu.estado, 'oi')
conf('quando ela volta, o contador zera', voltou.estado.falhasIA === 0)

// Numa conversa real o candidato mandou o nome completo justo no turno em que
// a IA travou. A mensagem ficava de fora do histórico e o dado se perdia.
modeloFalha(500)
const naQueda = await atender(base, 'Antonio Carlos Ribeiro')
conf('o que a pessoa disse durante a queda NÃO se perde',
  naQueda.estado.historico?.some(m => m.texto === 'Antonio Carlos Ribeiro'))

modeloFalha(500)
r = await atender(base, 'oi')
conf('erro do servidor também não deixa ninguém sem resposta', Boolean(r.resposta?.trim()))

globalThis.fetch = async () => { throw new Error('rede fora') }
r = await atender(base, 'oi')
conf('rede fora também não', Boolean(r.resposta?.trim()))

// ── Passar para humano ──────────────────────────────────────────────────────
modeloResponde({ resposta: 'Vou chamar alguém da equipe.', precisaHumano: true })
r = await atender(base, 'quero falar com uma pessoa')
conf('sinaliza quando precisa de humano', r.escalarHumano === true)

// ── Sem chave, nem tenta ────────────────────────────────────────────────────
// Em processo separado de propósito: ia.js lê a chave ao carregar, então
// apagar a variável aqui não desfaz o que já foi lido. Processo novo é o
// cenário de verdade — é assim que o serviço sobe sem a chave configurada.
globalThis.fetch = fetchReal
const { execFileSync } = await import('node:child_process')
const semChave = { ...process.env }
delete semChave.GEMINI_API_KEY
const saida = execFileSync(process.execPath, ['-e', `
  import('./src/atendimento.js').then(m => {
    console.log(m.iniciarAtendimento('5514999990000').resposta)
  })
`], { env: semChave, encoding: 'utf8', cwd: process.cwd() })
conf('sem chave, abre com o roteiro (processo novo)', !saida.includes('Maria Vitória'))
conf('  e ainda assim cumprimenta o candidato', saida.trim().length > 20)

console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
