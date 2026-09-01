/**
 * Os defeitos de costura entre camadas, cada um com um teste.
 *
 * Todos eram invisíveis: nada quebrava, nada aparecia no log. O dado
 * simplesmente não chegava do outro lado. Teste que os prenda é a única
 * forma de não voltarem na próxima refatoração.
 */
import { _corpoDaCandidatura } from './rh-client.js'
import { _envelhecer, _expirar, setEstado, getEstado, _limparTudo, metricas } from './store.js'
import { atender } from './atendimento.js'

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

// ── 1. A ficha inteira chega ao RH ────────────────────────────────────────
// Nove campos eram montados pelo atendimento e descartados no rh-client.
const corpo = _corpoDaCandidatura({
  nomeCompleto: 'Jose da Silva',
  vagaPretendida: 'Pedreiro',
  cidadePreferencia: 'Buritama',
  whatsapp: '5511999998888',
  tempoExperiencia: '8 anos',
  bairro: 'Centro',
  cep: '16000000',
  dataNascimento: '10/05/1980',
  disponibilidadeInicio: 'na segunda',
  aceitaOutrasObras: 'Sim',
  tamanhoCamisa: 'G',
  tamanhoBota: '42',
  contatoRecadoNome: 'Maria',
  contatoRecadoTelefone: '5511977776666',
  dadosBrutos: { historico: [{ de: 'candidato', texto: 'oi' }] },
})

for (const campo of [
  'bairro', 'cep', 'dataNascimento', 'disponibilidadeInicio', 'aceitaOutrasObras',
  'tamanhoCamisa', 'tamanhoBota', 'contatoRecadoNome', 'contatoRecadoTelefone',
]) {
  ok(`ficha leva ${campo} para o RH`, corpo[campo] != null)
}

// Campo que a pessoa não respondeu vai como null, e não some do corpo: o RH
// precisa distinguir "não perguntei" de "campo que eu nem conheço".
ok('campo não coletado vai como null', 'resumoExperiencia' in corpo && corpo.resumoExperiencia === null)

// ── 2. A conversa vai junto (é o que vale como prova) ─────────────────────
// dadosBrutos lia `dados.transcricao`, que só existe no caminho do roteiro:
// pela IA o histórico virava {"origem":"whatsapp-bot"} e sumia.
const brutos = JSON.parse(corpo.dadosBrutos)
ok('dadosBrutos leva o histórico da conversa', Array.isArray(brutos.historico) && brutos.historico.length === 1)
ok('dadosBrutos mantém a origem', brutos.origem === 'whatsapp-bot')

const doRoteiro = JSON.parse(_corpoDaCandidatura({
  nomeCompleto: 'Ana Souza',
  transcricao: { etapa: 'fim', vaga: 'Servente' },
}).dadosBrutos)
ok('dadosBrutos aceita também o formato do roteiro', doRoteiro.vaga === 'Servente')

// ── 3. "Recomeçar" vale com a Maria Vitória, não só no roteiro ────────────
// O servidor oferece o comando por escrito na mensagem de retomada, que é
// exibida justamente quando a IA está atendendo.
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'para-teste'
const cheio = { modo: 'ia', whatsapp: '5511999998888', vaga: 'Pedreiro', cidade: 'Buritama', nome: 'Jose da Silva', registrado: true, historico: [{ de: 'candidato', texto: 'oi' }] }

for (const palavra of ['recomeçar', 'reiniciar', 'quero começar de novo']) {
  const r = await atender(cheio, palavra)
  ok(`"${palavra}" zera a conversa da IA`, !r.estado.vaga && !r.estado.nome && !r.estado.registrado)
}

// e não zera à toa: falar de recomeço de obra não é pedir para recomeçar
const normal = await atender({ ...cheio, modo: 'roteiro' }, 'quando recomeça a obra?')
ok('pergunta comum não zera a conversa', Boolean(normal.estado))

// ── 4. Conversa velha é descartada ────────────────────────────────────────
// Nada removia sessão: o arquivo crescia para sempre e as métricas vinham
// diluídas por candidato de meses atrás.
_limparTudo()
setEstado('5511111111111', { etapa: 'vaga' })   // recente
setEstado('5522222222222', { etapa: 'nome' })   // vai envelhecer
_envelhecer('5522222222222', 1000 * 60 * 60 * 24 * 8)  // 8 dias

const removidas = _expirar()
ok('descarta a conversa passada da retenção', removidas === 1)
ok('mantém a conversa recente', getEstado('5511111111111') !== null)
ok('métrica não conta mais a antiga', metricas().iniciadas === 1)

// Dentro da retenção não some, mesmo já expirada para atendimento: é
// exatamente a conversa que a retomada usa.
_limparTudo()
setEstado('5544444444444', { etapa: 'cidade' })
_envelhecer('5544444444444', 1000 * 60 * 60 * 24 * 3)  // 3 dias
ok('conversa retomável sobrevive à limpeza', _expirar() === 0)

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
