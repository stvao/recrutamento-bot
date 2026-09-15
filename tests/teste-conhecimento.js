/**
 * O que o robô sabe da empresa — conferido contra o que o dono informou.
 *
 * Informado em 10/09/2026. Cada caso aqui é uma frase que vai, por escrito,
 * para o celular de um candidato. Dois tipos de erro importam:
 *
 *  - dizer algo FALSO: alojamento que não existe, salário errado;
 *  - dizer algo que COMPROMETE: quando o registro é feito, ou qualquer
 *    resposta sobre registro misturado com benefício. Isso vai para uma
 *    pessoa, e o robô não escreve nada a respeito.
 *
 * Roda contra um RH de mentira com os dados reais: vagas, salários, cidades
 * e alojamento vêm de lá, como em produção.
 */
import { createServer } from 'node:http'

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

const RH = {
  vagas: [
    { nome: 'Servente', salario: 2303, profissional: false, sinonimos: ['servente', 'ajudante'] },
    { nome: 'Pedreiro', salario: 2803, profissional: true, sinonimos: ['pedreiro'] },
    { nome: 'Carpinteiro', salario: 2803, profissional: false, sinonimos: ['carpinteiro', 'carpintaria'] },
    { nome: 'Estagiário', salario: 1200, profissional: false, sinonimos: ['estagiario'] },
  ],
  cidades: [
    { nome: 'Bastos', uf: 'SP', alojamento: true },
    { nome: 'Pereiras', uf: 'SP', alojamento: true },
    { nome: 'Buritama', uf: 'SP', alojamento: false },
    { nome: 'Caraguatatuba', uf: 'SP', alojamento: false },
    { nome: 'Itapevi', uf: 'SP', alojamento: false },
  ],
}

const srv = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(RH))
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
process.env.RH_API_URL = `http://127.0.0.1:${srv.address().port}`
process.env.RH_API_TOKEN = 'token-de-teste'

const catalogo = await import('../src/catalogo.js')
catalogo._limparCache()
await catalogo.getVagas()
ok('o catálogo veio do RH', catalogo.origemDaLista() === 'RH')

const { responderFAQ, JORNADA } = await import('../src/brain.js')
const { montarFatos } = await import('../src/ia.js')

const diz = (msg, estado) => responderFAQ(msg, estado) ?? { texto: '' }
const texto = (msg, estado) => diz(msg, estado).texto

// ── Salário ────────────────────────────────────────────────────────────
ok('servente: R$ 2.303,00', /2\.303,00/.test(texto('quanto ganha servente?')))
ok('servente não fala de teto', !/3\.500/.test(texto('quanto ganha servente?')))
ok('pedreiro: inicial R$ 2.803,00', /2\.803,00/.test(texto('quanto paga pedreiro?')))
ok('pedreiro: pode chegar a R$ 3.500,00', /3\.500,00/.test(texto('quanto paga pedreiro?')))
ok('o teto exige experiência comprovada EM CARTEIRA', /comprovada em carteira/.test(texto('quanto paga pedreiro?')))
ok('carpinteiro tem as mesmas duas faixas',
  /2\.803,00/.test(texto('quanto paga carpinteiro?')) && /3\.500,00/.test(texto('quanto paga carpinteiro?')))
ok('estagiário: bolsa R$ 1.200,00', /1\.200,00/.test(texto('quanto ganha estagiario?')))
ok('o teto é só do pedreiro', catalogo.tetoDe('Pedreiro') === 3500 && catalogo.tetoDe('Servente') === null)

// ── Alojamento: só Bastos e Pereiras ───────────────────────────────────
//
// A lista antiga dizia "todas as cidades, exceto Itapevi". Alguém podia sair
// de casa confiando nisso.
{
  const geral = texto('tem alojamento?')
  ok('alojamento: cita Bastos e Pereiras', geral.includes('Bastos') && geral.includes('Pereiras'))
  ok('alojamento: não cita cidade sem alojamento', !geral.includes('Buritama') && !geral.includes('Itapevi'))
  ok('alojamento: nunca mais "todas as cidades"', !/todas|exceto/i.test(geral))
}
ok('Bastos tem alojamento', /^Sim/.test(texto('tem alojamento em bastos?')))

// ── Alojamento é só para pedreiro (dono, 12/09/2026) ───────────────────
//
// O ajudante de outra cidade que descobre isso só na entrevista viajou à toa.
{
  const r = texto('tem alojamento?', { vaga: 'Servente' })
  ok('ajudante: alojamento é só para pedreiro', /só para pedreiro/.test(r))
  ok('ajudante: tem que morar na cidade da obra', /mora na cidade da obra/.test(r))
  ok('ajudante: não recebe a lista de cidades com alojamento', !/Bastos/.test(r))
}
ok('pedreiro continua recebendo as cidades', /Bastos/.test(texto('tem alojamento?', { vaga: 'Pedreiro' })))
ok('quem cita a função na pergunta também', /só para pedreiro/.test(texto('sou ajudante, tem alojamento?')))
ok('Pereiras tem alojamento', /^Sim/.test(texto('tem alojamento em pereiras?')))
{
  const buritama = texto('tem alojamento em buritama?')
  ok('Buritama não tem', /não temos alojamento/.test(buritama))
  ok('e diz onde tem', buritama.includes('Bastos') && buritama.includes('Pereiras'))
}
ok('as cidades vêm do RH, não de lista escrita à mão',
  /Caraguatatuba/.test(texto('quais cidades tem vaga?')) && !/Praia Grande/.test(texto('quais cidades tem vaga?')))

// ── Experiência virou FAIXA, não porta (dono, 12/09/2026) ──────────
//
// Dizer "pedreiro precisa de experiência" espantaria justamente quem a
// empresa contrata por R$ 2.803.
{
  const r = texto('precisa de experiencia?', { vaga: 'Pedreiro' })
  ok('pedreiro: dá para começar sem experiência', /começar sem experiência/.test(r))
  ok('pedreiro: as duas faixas na mesma frase', /2\.803,00/.test(r) && /3\.500,00/.test(r))
  ok('pedreiro: a faixa maior exige carteira', /comprovada em carteira/.test(r))
  ok('pedreiro: nunca mais "é necessário ter experiência"', !/necessário ter experiência/.test(r))
}
ok('servente: não precisa de experiência', /não é preciso experiência/.test(texto('precisa de experiencia?', { vaga: 'Servente' })))
ok('sem vaga escolhida: explica as duas funções',
  /Pedreiro e Carpinteiro/.test(texto('precisa de experiencia?')))

// ── Registro: formas de contratação, e NUNCA quando ────────────────────
{
  const r = texto('é registrado?')
  ok('registro: diz CLT', /CLT/.test(r))
  ok('registro: diz diária e empreita', /di[aá]ria/.test(r) && /empreita/.test(r))
  ok('registro: combinado na entrevista', /entrevista/.test(r))
  ok('registro: não diz quando registra', !/primeiro dia|sem registro|semanas|depois/i.test(r))
  ok('registro: não é mais "Sim, é CLT 👍"', !/^Sim/.test(r))
}
{
  // Decisão do dono (11/09/2026): responde que se combina com o responsável,
  // sem chamar ninguém — e continua sem dizer QUANDO registra.
  const r = diz('registra desde o primeiro dia?')
  ok('"desde o primeiro dia?": combina com o responsável', /responsável/.test(r.texto) && /ligar/.test(r.texto))
  ok('  sem chamar uma pessoa', !r.escalar)
  ok('  e não responde sim nem não', !/(^|\s)(sim|não)(\s|[.,!?]|$)/i.test(r.texto))
}

// ── Cidade: quem não precisa de alojamento escolhe onde trabalhar ──────
{
  const r = texto('tem alojamento em buritama?')
  ok('cidade sem alojamento: pode trabalhar nela', /pode trabalhar em Buritama/.test(r))
  ok('  a cidade a pessoa escolhe', /você escolhe/.test(r))
  ok('  sem prometer a vaga', !/garant|contratad|vaga (é|e) sua/i.test(r))
}
ok('cidade: pode escolher trabalhar lá', /pode escolher/.test(texto('tem vaga em buritama?')))

// ── Estágio ────────────────────────────────────────────────────────────
{
  const r = texto('quanto ganha estagiario?')
  ok('estágio: é bolsa, não salário', /bolsa/.test(r) && !/salário/.test(r))
  ok('estágio: bolsa R$ 1.200,00', /1\.200,00/.test(r))
  ok('estágio: mais R$ 300,00 de auxílio-transporte', /300,00/.test(r) && /auxílio-transporte/.test(r))
  ok('estágio: diz o requisito', /engenharia/.test(r) && /arquitetura/.test(r))
}
ok('estágio: precisa estar estudando', /cursando engenharia/.test(texto('estagio precisa estar estudando?')))
{
  // Estágio: bolsa + auxílio-transporte de R$ 300 (dono, 11/09/2026).
  const vale = texto('estagiario tem vale transporte?')
  ok('estágio + vale: R$ 300,00 de auxílio-transporte', /300,00/.test(vale) && /auxílio-transporte/.test(vale))
  ok('  e NÃO recebe a regra do vale dos contratados', !/primeiro dia/.test(vale))
  const almoco = texto('tem almoço?', { vaga: 'Estagiário' })
  ok('estágio + almoço: bolsa e auxílio, o resto com o responsável', /auxílio-transporte/.test(almoco) && /responsável combina/.test(almoco))
  ok('  sem prometer almoço', !/fornece o almoço/.test(almoco))
}
ok('contratado continua recebendo a regra do vale', /primeiro dia/.test(texto('tem vale transporte?', { vaga: 'Servente' })))

// ── Benefício: nada escrito, vai para uma pessoa ───────────────────────
//
// A resposta antiga oferecia, por escrito, "verificar a possibilidade" de não
// registrar quem recebe benefício.
for (const pergunta of [
  'recebo seguro desemprego, da pra nao registrar?',
  'tenho bolsa familia, perco o beneficio se registrar?',
  'recebo bpc',
]) {
  const r = diz(pergunta)
  ok(`"${pergunta}" vai para uma pessoa`, r.escalar === true)
  ok('  sem escrever nada sobre registro ou benefício', !/registr|benef|possibilidade|verific/i.test(r.texto))
}

// ── Pagamento, vale, comida, idade, processo ───────────────────────────
{
  const r = texto('quando cai o pagamento?')
  ok('pagamento: 5º dia útil', /5º dia útil/.test(r))
  ok('pagamento: vale no dia 20', /dia 20/.test(r))
  ok('"quando cai" não vira tabela de salário', !/2\.303/.test(r))
}
{
  const r = texto('tem vale transporte?')
  ok('vale-transporte: a partir do primeiro dia', /primeiro dia/.test(r))
  ok('vale-transporte: sem adiantamento', /não consegue adiantar/.test(r))
}
{
  const r = texto('tem almoço?')
  ok('almoço na obra', /almoço/.test(r))
  ok('alojado tem café e janta', /café da manhã/.test(r) && /janta/.test(r))
}
ok('quem fica no alojamento: resposta de comida', /café da manhã/.test(texto('quem fica no alojamento tem janta?')))
ok('idade mínima: 18 anos', /18 anos/.test(texto('qual a idade minima?')))
{
  const r = texto('como funciona o processo?')
  ok('processo: ficha, ligação e entrevista', /ficha/.test(r) && /liga/.test(r) && /entrevista/.test(r))
  ok('processo: sem link', !/https?:|\.org|\.br/.test(r))
}
ok('jornada continua', /segunda a quinta/i.test(texto('qual o horario?')) && JORNADA.includes('7h'))

// ── Os fatos da Maria Vitória ──────────────────────────────────────────
{
  const f = montarFatos({ vagas: catalogo.vagasAtuais(), cidades: catalogo.cidadesAtuais(), jornada: JORNADA })
  ok('fatos: salários do RH', /Servente: R\$ 2303,00/.test(f) && /Pedreiro: R\$ 2803,00/.test(f))
  ok('fatos: alojamento só para pedreiro', /S[ÓO] PARA PEDREIRO/.test(f) && /MORA na cidade da obra/.test(f))
  ok('fatos: o teto exige carteira', /COMPROVADA EM CARTEIRA/.test(f))
  ok('fatos: teto só na linha do pedreiro',
    /Pedreiro:.*3500,00/.test(f) && !/Servente:.*3500/.test(f) && !/Estagi.rio:.*3500/.test(f))
  ok('fatos: alojamento como está no RH', /Bastos: tem alojamento/.test(f) && /Buritama: NÃO tem alojamento/.test(f))
  ok('fatos: formas de contratação', /CLT/.test(f) && /diária/.test(f) && /empreita/.test(f))
  ok('fatos: pagamento e vale', /5º dia útil/.test(f) && /dia 20/.test(f))
  ok('fatos: alimentação', /almoço/.test(f) && /café/.test(f))
  ok('fatos: idade', /18 anos/.test(f))
  ok('fatos: nada de começar sem registro', !/sem registro|semanas/i.test(f))
  ok('fatos: nada de link', !/https?:|duckdns/.test(f))
}

srv.close()
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
