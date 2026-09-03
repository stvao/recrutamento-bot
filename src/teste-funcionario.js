/**
 * Atendimento a quem já trabalha na empresa.
 *
 * O bloco que importa é o primeiro. Todo o resto deste arquivo é
 * conveniência; aquele é a razão de o módulo existir do jeito que existe:
 *
 *   NADA PESSOAL SAI POR AQUI.
 *
 * Número de WhatsApp é identificação fraca — celular emprestado é rotina em
 * obra — e o que o robô escreve vira prova num contexto trabalhista. Um
 * valor de salário informado à pessoa errada, ou informado errado, é um
 * problema que não se conserta depois.
 *
 * Roda SEM chave de IA: o que se testa é a decisão, não a redação.
 */
process.env.GEMINI_API_KEY = ''

const { atender, conferir, ehAssuntoPessoal } = await import('./funcionario.js')

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

const JOSE = {
  primeiroNome: 'José',
  funcao: 'Pedreiro',
  obra: 'EE/ETEC AGUIA DE HAIA',
  obraEndereco: 'Av Aguia de Haia 500, São Paulo - SP',
}

// ── 1. O que NUNCA pode sair ──────────────────────────────────────────────
// Estas perguntas nem chegam ao modelo: são barradas antes.
const PESSOAIS = [
  'quanto eu ganho?',
  'qual o meu salário?',
  'me manda o holerite',
  'quero ver meu contracheque',
  'quanto tem de saldo de férias?',
  'quando sai o décimo terceiro?',
  'por que descontaram do meu pagamento?',
  'meu FGTS foi depositado?',
  'quanto vou receber de rescisão?',
  'qual a minha chave pix cadastrada?',
  'confere meu CPF aí',
  'quanto falta do meu vale?',
]
for (const pergunta of PESSOAIS) {
  ok(`"${pergunta}" é assunto pessoal`, ehAssuntoPessoal(pergunta))
}

// E a resposta é sempre a mesma: chama gente, e avisa o RH.
for (const pergunta of PESSOAIS.slice(0, 4)) {
  const r = await atender({ ficha: JOSE, texto: pergunta })
  ok(`"${pergunta}" chama uma pessoa`, r.escalarHumano === true)
  ok(`"${pergunta}" não dá nenhum valor`, !/R\$|\d+\s*reais/i.test(r.resposta))
  ok(`"${pergunta}" não manda link`, !/https?:|www\.|\.com/i.test(r.resposta))
}

// Pergunta comum NÃO é confundida com assunto pessoal — senão tudo viraria
// escalada e o módulo não serviria para nada.
for (const comum of ['que horas começa?', 'onde fica a obra?', 'como peço bota nova?', 'bom dia']) {
  ok(`"${comum}" não é barrado como pessoal`, !ehAssuntoPessoal(comum))
}

/*
  Palavra dentro de outra palavra não conta.

  "vale" sem fronteira casava com "valeu" e com "cavalete": alguém
  agradecendo virava alerta para o RH. Alerta falso repetido faz quem recebe
  parar de olhar o sino — e aí os alertas de verdade se perdem junto.
*/
for (const inocente of ['valeu, obrigado', 'valeu demais', 'vou pegar o cavalete', 'me passa a chave de fenda']) {
  ok(`"${inocente}" não vira alerta`, !ehAssuntoPessoal(inocente))
}

// E o que É sobre o dinheiro dele continua sendo barrado.
for (const pessoal of ['vale transporte tem?', 'e o meu vale?', 'quantos dias de férias eu tenho?']) {
  ok(`"${pessoal}" continua sendo pessoal`, ehAssuntoPessoal(pessoal))
}

// ── 2. A conferência da resposta do modelo ────────────────────────────────
// Última barreira. O prompt manda não falar de dinheiro; isto GARANTE.
{
  ok('resposta com valor em reais é DESCARTADA',
    conferir({ resposta: 'Seu salário é R$ 2.400,00', precisaHumano: false }).escalarHumano !== false
    || /pessoa do RH/i.test(conferir({ resposta: 'Seu salário é R$ 2.400,00', precisaHumano: false }).resposta))

  const comValor = conferir({ resposta: 'Você recebe R$ 2.400 por mês', precisaHumano: false })
  ok('e vira "chama alguém"', comValor.precisaHumano === true)
  ok('sem repetir o valor', !comValor.resposta.includes('2.400'))

  const comLink = conferir({ resposta: 'Acessa https://portal.empresa.com para ver', precisaHumano: false })
  ok('resposta com LINK é descartada', comLink.precisaHumano === true)
  ok('sem repetir o link', !comLink.resposta.includes('http'))

  const comSenha = conferir({ resposta: 'Sua senha é 1234', precisaHumano: false })
  ok('resposta com SENHA é descartada', comSenha.precisaHumano === true)

  const boa = conferir({ resposta: 'O horário é das 7h às 17h.', precisaHumano: false, motivo: '' })
  ok('resposta institucional passa', boa.resposta.includes('7h'))
  ok('e não vira escalada à toa', boa.precisaHumano === false)

  ok('resposta vazia não quebra', conferir({ resposta: '   ' }) === null)
  ok('nulo não quebra', conferir(null) === null)
}

// "2 mil reais" também é valor, escrito por extenso.
{
  const porExtenso = conferir({ resposta: 'Dá uns 2 mil reais', precisaHumano: false })
  ok('valor por extenso também é barrado', porExtenso.precisaHumano === true)
}

// ── 3. O que ele responde direto, sem modelo ──────────────────────────────
// Não é economia de cota: é previsibilidade. A resposta destas não pode
// variar de um dia para o outro.
{
  const horario = await atender({ ficha: JOSE, texto: 'que horas eu entro amanhã?' })
  ok('responde o horário', /7h/.test(horario.resposta))
  ok('sem chamar ninguém', horario.escalarHumano === false)

  const onde = await atender({ ficha: JOSE, texto: 'onde fica a obra?' })
  ok('responde o endereço da obra', onde.resposta.includes('Aguia de Haia 500'))

  const epi = await atender({ ficha: JOSE, texto: 'minha botina furou, como peço outra?' })
  ok('explica como pedir EPI', /encarregado/i.test(epi.resposta))

  const atestado = await atender({ ficha: JOSE, texto: 'fui no médico, e o atestado?' })
  ok('explica o procedimento do atestado', /48 horas/i.test(atestado.resposta))
}

// Sem endereço cadastrado, não inventa.
{
  const semEndereco = await atender({
    ficha: { primeiroNome: 'Ana', obra: 'Obra X' },
    texto: 'onde fica a obra?',
  })
  ok('sem endereço, manda falar com o encarregado', /encarregado/i.test(semEndereco.resposta))
  ok('e não inventa endereço', !/rua|avenida|av /i.test(semEndereco.resposta))
}

// ── 4. Sem IA, ele chama gente — e não fica mudo ──────────────────────────
{
  const r = await atender({ ficha: JOSE, texto: 'preciso trocar meu horário na semana que vem' })
  ok('sem modelo, chama uma pessoa', r.escalarHumano === true)
  ok('e diz isso para a pessoa', /RH/i.test(r.resposta))
  ok('usando o primeiro nome dela', r.resposta.includes('José'))
}

// ── 5. Ficha incompleta não derruba nada ──────────────────────────────────
{
  const r = await atender({ ficha: {}, texto: 'quanto eu ganho?' })
  ok('sem nome, ainda responde', r.resposta.length > 0)
  ok('e ainda escala', r.escalarHumano === true)

  const r2 = await atender({ ficha: null, texto: 'oi' })
  ok('ficha nula não quebra', r2.resposta.length > 0)
}

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exitCode = falhas ? 1 : 0
