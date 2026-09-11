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
    { nome: 'Estagiário', salario: 1500, profissional: false, sinonimos: ['estagiario'] },
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

const catalogo = await import('./catalogo.js')
catalogo._limparCache()
await catalogo.getVagas()
ok('o catálogo veio do RH', catalogo.origemDaLista() === 'RH')

const { responderFAQ, JORNADA } = await import('./brain.js')
const { montarFatos } = await import('./ia.js')

const diz = (msg, estado) => responderFAQ(msg, estado) ?? { texto: '' }
const texto = (msg, estado) => diz(msg, estado).texto

// ── Salário ────────────────────────────────────────────────────────────
ok('servente: R$ 2.303,00', /2\.303,00/.test(texto('quanto ganha servente?')))
ok('servente não fala de teto', !/3\.500/.test(texto('quanto ganha servente?')))
ok('pedreiro: inicial R$ 2.803,00', /2\.803,00/.test(texto('quanto paga pedreiro?')))
ok('pedreiro: pode chegar a R$ 3.500,00', /3\.500,00/.test(texto('quanto paga pedreiro?')))
ok('o teto depende de experiência comprovada', /experi[eê]ncia comprovada/.test(texto('quanto paga pedreiro?')))
ok('estagiário: R$ 1.500,00', /1\.500,00/.test(texto('quanto ganha estagiario?')))
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
ok('Pereiras tem alojamento', /^Sim/.test(texto('tem alojamento em pereiras?')))
{
  const buritama = texto('tem alojamento em buritama?')
  ok('Buritama não tem', /não temos alojamento/.test(buritama))
  ok('e diz onde tem', buritama.includes('Bastos') && buritama.includes('Pereiras'))
}
ok('as cidades vêm do RH, não de lista escrita à mão',
  /Caraguatatuba/.test(texto('quais cidades tem vaga?')) && !/Praia Grande/.test(texto('quais cidades tem vaga?')))

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
  const r = diz('registra desde o primeiro dia?')
  ok('"desde o primeiro dia?" vai para uma pessoa', r.escalar === true)
  ok('e não responde sim nem não', !/\bsim\b|\bnão\b/i.test(r.texto))
}

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
