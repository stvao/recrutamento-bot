/**
 * O primeiro contato com quem o sistema não conhece.
 *
 * O robô tratava TODO desconhecido como candidato: quem escrevia "boa tarde"
 * recebia "qual vaga você procura?". É rude com quem só queria uma
 * informação, e absurdo com quem trabalha na empresa há dois anos e trocou
 * de número.
 *
 * A regra que este arquivo prende é: NÃO PRESUMIR.
 *
 * Roda SEM chave de IA: o que se testa é a decisão, não a redação. É também
 * o pior cenário — se o robô se comporta sem modelo, com modelo ele só
 * melhora.
 */
process.env.GEMINI_API_KEY = ''

const { atender, conferir, pareceNome, saudacao, _regras } = await import('./triagem.js')

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

// ── 1. Quem procura vaga é reconhecido na hora ────────────────────────────
for (const frase of [
  'tem vaga?', 'vcs estão contratando?', 'quero trabalhar com vocês',
  'to procurando emprego', 'onde mando meu currículo?',
  'tem alguma oportunidade aí?', 'preciso de trabalho',
]) {
  const r = await atender({ texto: frase })
  ok(`"${frase}" → recrutamento`, r.intencao === 'procura_vaga')
}

// Entregar ao recrutamento é não responder aqui: quem fala com a pessoa é a
// Maria Vitória, com a mensagem de abertura dela.
{
  const r = await atender({ texto: 'tem vaga de pedreiro?' })
  ok('quem procura vaga não recebe resposta da triagem', r.resposta === null)
}

// ── 2. Quem já trabalha é reconhecido, e o nome é pedido ──────────────────
for (const frase of [
  'eu trabalho aí', 'sou funcionário de vocês', 'já trabalho com vocês',
  'trabalho na obra', 'sou da obra de bastos',
]) {
  const r = await atender({ texto: frase })
  ok(`"${frase}" → já trabalha`, r.intencao === 'ja_trabalha')
  ok(`"${frase}" pede o nome`, r.pedindoNome === true)
}

{
  const r = await atender({ texto: 'eu trabalho aí' })
  ok('pede o nome COMPLETO', /nome completo/i.test(r.resposta))
  ok('e não pede documento nenhum', !/cpf|rg|pis|carteira/i.test(r.resposta))
}

// ── 3. Cumprimento não vira interrogatório ────────────────────────────────
// É o problema que motivou o módulo.
for (const frase of ['oi', 'olá', 'bom dia', 'boa tarde', 'tudo bem?', 'opa']) {
  const r = await atender({ texto: frase })
  ok(`"${frase}" não é presumido como vaga`, r.intencao !== 'procura_vaga')
  ok(`"${frase}" recebe um cumprimento de volta`, /ajudar|oi/i.test(r.resposta ?? ''))
}

ok('a saudação não fala de vaga', !/vaga|emprego|currículo/i.test(saudacao()))
ok('e diz de onde é', /RH/.test(saudacao()))

// ── 4. O nome, quando ele foi pedido ──────────────────────────────────────
{
  const r = await atender({ texto: 'José da Silva', esperandoNome: true })
  ok('reconhece o nome informado', r.nomeInformado === 'José da Silva')

  const comPrefixo = await atender({ texto: 'meu nome é Maria Aparecida Souza', esperandoNome: true })
  ok('entende "meu nome é ..."', comPrefixo.nomeInformado === 'Maria Aparecida Souza')

  const soPrimeiro = await atender({ texto: 'José', esperandoNome: true })
  ok('nome sem sobrenome não serve para buscar', !soPrimeiro.nomeInformado)

  const frase = await atender({ texto: 'não lembro agora', esperandoNome: true })
  ok('frase qualquer não vira nome', !frase.nomeInformado)

  // Fora do momento da pergunta, um nome não é lido como nome — senão
  // qualquer frase de duas palavras viraria identificação.
  const foraDeHora = await atender({ texto: 'José da Silva', esperandoNome: false })
  ok('sem ter perguntado, não trata como nome', !foraDeHora.nomeInformado)
}

ok('pareceNome aceita nome e sobrenome', pareceNome('Ana Paula') === 'Ana Paula')
ok('pareceNome recusa número', pareceNome('11 98765-4321') === null)
ok('pareceNome recusa frase longa', pareceNome('eu não sei o que dizer agora sobre isso tudo') === null)

// ── 5. A conferência da resposta do modelo ────────────────────────────────
// Aqui é ainda mais sério que no atendimento a funcionário: não se sabe quem
// está do outro lado.
{
  const comValor = conferir({ resposta: 'A vaga paga R$ 2.400', intencao: 'procura_vaga' })
  ok('valor é descartado', comValor.precisaHumano === true)
  ok('e não é repetido', !comValor.resposta.includes('2.400'))

  const comLink = conferir({ resposta: 'Se cadastra em https://x.com', intencao: 'procura_vaga' })
  ok('link é descartado', comLink.precisaHumano === true)

  const boa = conferir({ resposta: 'Bom dia! Em que posso ajudar?', intencao: 'nao_sei_ainda', pedindoNome: false, precisaHumano: false, motivo: '' })
  ok('resposta comum passa', boa.resposta.includes('ajudar'))
  ok('sem virar escalada', boa.precisaHumano === false)

  const inventada = conferir({ resposta: 'oi', intencao: 'qualquer_coisa' })
  ok('intenção inventada vira "não sei ainda"', inventada.intencao === 'nao_sei_ainda')

  ok('resposta vazia não quebra', conferir({ resposta: '  ' }) === null)
  ok('nulo não quebra', conferir(null) === null)
}

// ── 6. Sem IA, ele não inventa ────────────────────────────────────────────
// É o estado real quando a cota estoura, e nesse momento assumir que a
// pessoa quer vaga seria o pior palpite possível.
{
  const r = await atender({ texto: 'preciso falar com o financeiro de vocês' })
  ok('assunto que não é vaga chama gente', r.escalarHumano === true)
  ok('e NÃO é tratado como candidato', r.intencao !== 'procura_vaga')
  ok('sem prometer nada', !/vaga|salário|contrat/i.test(r.resposta))
}

/*
  Quem PRESTA serviço não está procurando vaga.

  "serviço" servia para os dois lados e decidia errado: um prestador
  cobrando ia parar no recrutamento, e era perguntado qual vaga procurava.
  A palavra saiu das regras fixas — quem lê a frase inteira é o modelo.
*/
for (const frase of [
  'preciso falar sobre um serviço que prestei',
  'fiz um serviço aí e não recebi',
  'presto serviço de terraplenagem, quero oferecer',
]) {
  const r = await atender({ texto: frase })
  ok(`"${frase}" NÃO vira candidatura`, r.intencao !== 'procura_vaga')
}

// Mas o que é procura de vaga de verdade continua sendo reconhecido na hora.
for (const frase of ['tem vaga?', 'quero trabalhar com vocês', 'mando o currículo pra onde?']) {
  const r = await atender({ texto: frase })
  ok(`"${frase}" continua indo para o recrutamento`, r.intencao === 'procura_vaga')
}

/*
  A entrega ao recrutamento não pode perder o que a pessoa disse.

  Quem escrevia "quero uma vaga de pedreiro em Buritama" abria uma conversa
  nova e recebia "para qual vaga você quer se candidatar?" — com a vaga e a
  cidade que acabara de informar jogadas fora. Aqui se prova que o cérebro do
  recrutamento aproveita a primeira mensagem.
*/
{
  const atendimento = await import('./atendimento.js')
  const ini = atendimento.iniciarAtendimento('5511900000099')
  const r = await atendimento.atender(ini.estado, 'quero uma vaga de pedreiro em Buritama')
  ok('a vaga informada na primeira mensagem é aproveitada', r.estado.vaga === 'Pedreiro')
  ok('e ele não pergunta a vaga de novo', !/para qual vaga/i.test(r.resposta))
}

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exitCode = falhas ? 1 : 0
