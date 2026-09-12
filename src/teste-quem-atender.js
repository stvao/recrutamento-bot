/**
 * Quem o robô atende.
 *
 * O caso real que criou este arquivo: em 12/09/2026 alguém que trabalhou e
 * não recebeu mandou 64 mensagens de madrugada cobrando. Não estava no
 * cadastro do RH — para o robô, seria uma desconhecida querendo vaga.
 *
 * Os dois erros têm pesos diferentes. Deixar de atender um candidato custa um
 * candidato; responder automaticamente a quem cobra pagamento custa uma
 * conversa gravada que vira reclamação trabalhista. Na dúvida, silêncio.
 */
import { ehCobranca, decidir, atendeFuncionario } from './quem-atender.js'

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

// ── Cobrança: o robô fica calado ───────────────────────────────────────
//
// As frases são as que chegaram de verdade naquela conversa.
for (const frase of [
  'Boa noite , somente o dinheiro do Renato vai cair hj ?',
  'gostaria de saber se eu vou receber algo',
  'Por que eu fui o único que não recebeu nada ainda ?',
  'não recebi meu pagamento',
  'cadê meu dinheiro',
  'trabalhei 3 dias e nada',
  'quero meu acerto',
  'fui demitido e não recebi a rescisão',
  'vocês estão devendo meu vale',
  'quando vocês vão me pagar',
]) {
  ok(`cobrança: "${frase.slice(0, 42)}…"`, ehCobranca(frase))
}

// ── Candidato: continua sendo atendido ─────────────────────────────────
//
// Confundir estas com cobrança deixaria candidato sem resposta — que é o
// problema que o robô existe para resolver.
for (const frase of [
  'qual o salário do pedreiro?',
  'quanto paga servente',
  'tem vale transporte?',
  'quando cai o pagamento de vocês?',
  'qual o dia do pagamento?',
  'tem alojamento em bastos?',
  'bom dia, tem vaga de pedreiro?',
  'quero trabalhar com vocês',
  'tenho experiência em obra',
  'posso começar segunda',
]) {
  ok(`candidato: "${frase.slice(0, 42)}…"`, !ehCobranca(frase))
}

ok('texto vazio não é cobrança', !ehCobranca('') && !ehCobranca(null))

// ── A decisão ──────────────────────────────────────────────────────────
ok('desconhecido com pergunta de vaga: atende',
  decidir({ texto: 'tem vaga de pedreiro?', ficha: null }).atender)
ok('desconhecido cobrando: NÃO atende',
  !decidir({ texto: 'não recebi meu pagamento', ficha: null }).atender)
ok('e o motivo vai para o alerta',
  /cobran/i.test(decidir({ texto: 'não recebi meu pagamento', ficha: null }).motivo ?? ''))

ok('funcionário não é atendido, mesmo perguntando de vaga',
  !decidir({ texto: 'tem vaga de pedreiro?', ficha: { tipo: 'funcionario' } }).atender)
ok('candidato cadastrado continua sendo atendido',
  decidir({ texto: 'tem novidade?', ficha: { tipo: 'candidato' } }).atender)

// ── A chave do atendimento a funcionário ───────────────────────────────
ok('por padrão o robô NÃO atende funcionário', !atendeFuncionario())
{
  process.env.ATENDER_FUNCIONARIO = 'on'
  ok('ligável por configuração', atendeFuncionario())
  ok('ligado, o funcionário é atendido',
    decidir({ texto: 'que horas entro amanhã?', ficha: { tipo: 'funcionario' } }).atender)
  ok('mas cobrança continua calada, mesmo com a chave ligada',
    !decidir({ texto: 'não recebi meu pagamento', ficha: { tipo: 'funcionario' } }).atender)
  process.env.ATENDER_FUNCIONARIO = 'off'
}

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
