/**
 * Testes do catálogo vindo do RH (vagas e cidades).
 *
 * O que se protege aqui é uma decisão, não um detalhe: quando o RH não
 * responde, o robô diz "a combinar" em vez de repetir um salário guardado.
 * Não saber o valor é aceitável; prometer o errado por escrito, no WhatsApp
 * de um candidato, não é.
 *
 *   node src/teste-catalogo.js
 */
// Garante o cenário "sem RH" em vez de torcer para as variáveis não
// existirem: com o .env carregado, este teste encontrava o RH de verdade e
// falhava por motivo errado.
delete process.env.RH_API_URL
delete process.env.RH_API_TOKEN

const { getVagas, vagasAtuais, termosDasVagas, origemDaLista, _limparCache } = await import('../src/catalogo.js')

let falhas = 0
function conf(desc, ok) {
  if (!ok) falhas++
  console.log(`${ok ? 'ok  ' : 'FALHA '}${desc}`)
}

// ── Sem RH configurado, cai na reserva ──────────────────────────────────────
_limparCache()
const semRH = await getVagas()

conf('sem RH, ainda devolve vagas', Array.isArray(semRH) && semRH.length > 0)
conf('a reserva NUNCA traz salário', semRH.every(v => v.salario === null))

// Mesma ideia para alojamento: sem confirmar com o RH, a resposta segura é
// "não tenho" — prometer errado custa a mudança de alguém.
const { cidadesAtuais } = await import('../src/catalogo.js')
conf('a reserva NUNCA promete alojamento', cidadesAtuais().every(c => c.alojamento === false))
conf('a origem é declarada honestamente', origemDaLista().includes('reserva'))

// ── vagasAtuais() é síncrono e nunca devolve vazio ──────────────────────────
conf('vagasAtuais() responde sem esperar', vagasAtuais().length > 0)
_limparCache()
conf('vagasAtuais() sem cache ainda devolve a reserva', vagasAtuais().length > 0)

// ── termosDasVagas: o nome sempre entra ─────────────────────────────────────
const termos = termosDasVagas([
  { nome: 'Pedreiro', sinonimos: ['alvenaria'] },
  { nome: 'Encarregado de Obra', sinonimos: [] },   // vaga sem apelido cadastrado
])
conf('o nome da vaga entra junto com os apelidos',
  termos[0].termos.includes('Pedreiro') && termos[0].termos.includes('alvenaria'))
conf('vaga sem apelido ainda é reconhecível pelo nome',
  termos[1].termos.length === 1 && termos[1].termos[0] === 'Encarregado de Obra')
conf('sinonimos ausente não quebra',
  termosDasVagas([{ nome: 'X' }])[0].termos.length === 1)

// ── RH respondendo ──────────────────────────────────────────────────────────
const fetchReal = globalThis.fetch

async function comRespostaDoRH(corpo, status = 200) {
  _limparCache()
  process.env.RH_API_URL = 'http://rh.teste'
  process.env.RH_API_TOKEN = 'x'
  globalThis.fetch = async () => ({ ok: status < 400, status, json: async () => corpo })
  // catalogo.js lê as variáveis no carregamento, então recarrega o módulo
  const m = await import(`../src/catalogo.js?t=${Math.random()}`)
  const v = await m.getVagas()
  return { vagas: v, cidades: m.cidadesAtuais(), origem: m.origemDaLista() }
}

const bom = await comRespostaDoRH({
  vagas: [{ nome: 'Pedreiro', salario: 2801.98, profissional: true, sinonimos: ['alvenaria'] }],
  cidades: [{ nome: 'Praia Grande', uf: 'SP', alojamento: false }],
})
conf('com RH no ar, usa a lista do RH', bom.vagas.length === 1 && bom.vagas[0].salario === 2801.98)
conf('a origem passa a ser o RH', bom.origem === 'RH')
conf('as cidades vêm do RH junto com as vagas',
  bom.cidades.length === 1 && bom.cidades[0].nome === 'Praia Grande')
// Prometer alojamento que não existe faz alguém largar o que tem e chegar
// sem ter onde dormir. O valor tem que vir do banco, não de suposição.
conf('e o alojamento vem como está no banco', bom.cidades[0].alojamento === false)

const vazio = await comRespostaDoRH({ vagas: [] })
// Lista vazia é quase sempre erro de configuração, não a empresa sem vagas.
conf('lista vazia do RH não apaga tudo', vazio.vagas.length > 0)

const erro = await comRespostaDoRH({}, 500)
conf('erro do RH não derruba o robô', erro.vagas.length > 0)
conf('e nesse caso não inventa salário', erro.vagas.every(v => v.salario === null))

globalThis.fetch = fetchReal
console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
