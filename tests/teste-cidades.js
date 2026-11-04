/**
 * Cada cidade contrata funções diferentes, e aloja funções diferentes.
 *
 * Quadro do dono em 04/11/2026:
 *   Peruíbe: pedreiro, carpinteiro, meio oficial, ajudante — alojamento para
 *            pedreiro e carpinteiro (ajudante não)
 *   Pereiras: pedreiro, com alojamento
 *   Praia Grande: pedreiro e ajudante, sem alojamento
 *   Bastos: pedreiro, meio oficial, ajudante
 *   Buritama: pedreiro e ajudante
 *   Itapevi: nada no momento
 *
 * O robô diz isto POR ESCRITO: errar manda alguém viajar para vaga que não
 * existe, ou chegar sem ter onde dormir.
 */
import { createServer } from 'node:http'

let falhas = 0
function ok(nome, cond) {
  if (cond) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

const RH = {
  vagas: [
    { nome: 'Meio Oficial', salario: null, profissional: false, sinonimos: ['meio oficial'] },
    { nome: 'Servente', salario: 2303, profissional: false, sinonimos: ['servente', 'ajudante'] },
    { nome: 'Pedreiro', salario: 2803, profissional: false, sinonimos: ['pedreiro'] },
    { nome: 'Carpinteiro', salario: 2803, profissional: false, sinonimos: ['carpinteiro', 'armador'] },
  ],
  cidades: [
    { nome: 'Peruíbe', uf: 'SP', alojamento: true, vagas: ['Pedreiro', 'Carpinteiro', 'Meio Oficial', 'Servente'], alojamentoPara: ['Pedreiro', 'Carpinteiro'] },
    { nome: 'Pereiras', uf: 'SP', alojamento: true, vagas: ['Pedreiro'], alojamentoPara: ['Pedreiro'] },
    { nome: 'Praia Grande', uf: 'SP', alojamento: false, vagas: ['Pedreiro', 'Servente'], alojamentoPara: [] },
    { nome: 'Bastos', uf: 'SP', alojamento: true, vagas: ['Pedreiro', 'Meio Oficial', 'Servente'], alojamentoPara: ['Pedreiro'] },
    { nome: 'Buritama', uf: 'SP', alojamento: false, vagas: ['Pedreiro', 'Servente'], alojamentoPara: [] },
    { nome: 'Itapevi', uf: 'SP', alojamento: false, vagas: [], alojamentoPara: [] },
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
const { iniciar, responder, responderFAQ, JORNADA } = await import('../src/brain.js')
const { montarFatos } = await import('../src/ia.js')
await catalogo.getVagas()
srv.close()

const faq = (msg, estado = {}) => responderFAQ(msg, estado)?.texto ?? ''

// ── A lista de cidades ─────────────────────────────────────────────────
{
  const r = iniciar('5511999999999').resposta
  ok('lista: Itapevi (sem vaga) não aparece', !/Itapevi/.test(r))
  ok('lista: mostra o que Peruíbe contrata', /Peruíbe \(.*carpinteiro.*\)/.test(r))
  ok('lista: Pereiras só pedreiro', /Pereiras \(pedreiro\)/.test(r))
}

// ── Carpinteiro só em Peruíbe ──────────────────────────────────────────
{
  let e = iniciar('5511999999999').estado
  let r = responder(e, 'quero carpinteiro em buritama')
  ok('carpinteiro em Buritama: diz que não tem', /Buritama .*não temos vaga de carpinteiro/.test(r.resposta))
  ok('  e onde tem', /Carpinteiro temos em Peruíbe/.test(r.resposta))
  ok('  e não registra a cidade', !r.estado.cidade)
  ok('  mas guarda a vaga', r.estado.vaga === 'Carpinteiro')
  ok('  e mostra só as cidades com carpinteiro', !/Bastos/.test(r.resposta.split('trabalhar?')[1] ?? ''))
  r = responder(r.estado, '1')
  ok('  o número 1 da lista nova é Peruíbe', r.estado.cidade === 'Peruíbe')
  ok('  com alojamento para carpinteiro', /alojamento aí, para pedreiro e carpinteiro/.test(r.resposta))
}

// ── Escolhida a cidade, só as vagas dela ───────────────────────────────
{
  let e = iniciar('5511999999999').estado
  let r = responder(e, 'pereiras')
  ok('Pereiras: lista só pedreiro', /1\. Pedreiro/.test(r.resposta) && !/Servente|Carpinteiro|Meio Oficial/.test(r.resposta))
  r = responder(r.estado, 'servente')
  ok('ajudante em Pereiras: não tem', /Pereiras .*não temos vaga de servente/.test(r.resposta))
  ok('  e continua na vaga', r.estado.etapa === 'vaga' && !r.estado.vaga)
}

// ── Itapevi: sem vaga agora ────────────────────────────────────────────
{
  const e = iniciar('5511999999999').estado
  const r = responder(e, 'itapevi')
  ok('Itapevi: não está contratando', /Itapevi no momento não estamos contratando/.test(r.resposta))
  ok('  e não registra', !r.estado.cidade)
}

// ── Alojamento por função e por cidade ─────────────────────────────────
ok('carpinteiro: alojamento em Peruíbe', /Para carpinteiro, tem alojamento em Peruíbe\./.test(faq('tem alojamento?', { vaga: 'Carpinteiro' })))
ok('ajudante em Peruíbe: sem alojamento', /Em Peruíbe não tem alojamento para servente/.test(faq('tem alojamento?', { vaga: 'Servente', cidade: 'Peruíbe' })))
ok('pedreiro em Pereiras: tem', /Sim! Em Pereiras tem alojamento para pedreiro/.test(faq('tem alojamento?', { vaga: 'Pedreiro', cidade: 'Pereiras' })))
ok('Praia Grande: sem alojamento', /Em Praia Grande não temos alojamento/.test(faq('tem alojamento em praia grande?')))
ok('geral: lista quem aloja quem', /Peruíbe \(pedreiro e carpinteiro\)/.test(faq('tem alojamento?')))
ok('vaga em Bastos: diz as funções', /em Bastos estamos contratando meio oficial, servente e pedreiro/.test(faq('tem vaga em bastos?')))

// ── O que a IA recebe ──────────────────────────────────────────────────
{
  const f = montarFatos({ vagas: catalogo.vagasAtuais(), cidades: catalogo.cidadesAtuais(), jornada: JORNADA })
  ok('fatos: Peruíbe com o que contrata', /Peruíbe: contrata meio oficial, servente, pedreiro e carpinteiro/.test(f))
  ok('fatos: alojamento de Peruíbe por função', /alojamento SÓ para pedreiro e carpinteiro \(meio oficial e servente NÃO fica alojado\)/.test(f))
  ok('fatos: Itapevi fora', !/Itapevi/.test(f))
  ok('fatos: preferência por meio oficial', /prefere MEIO OFICIAL/.test(f))
}

// ── RH antigo (sem a lista): tudo como antes ───────────────────────────
{
  const antiga = { nome: 'X', alojamento: true, vagas: null, alojamentoPara: ['Pedreiro'] }
  ok('cidade sem lista: aceita qualquer vaga', catalogo.vagaAbertaEm(antiga, 'Carpinteiro'))
  ok('estágio vale em qualquer cidade', catalogo.vagaAbertaEm(RH.cidades[1], 'Estagiário'))
}

console.log(falhas ? `\n${falhas} falha(s).` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
