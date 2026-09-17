/**
 * As mudanças de conversa decididas em 17/09/2026, medidas nas fichas reais:
 *
 *  - a CIDADE vem antes da vaga (é ela que decide quem pode ser ajudante);
 *  - "qualquer uma" não vale como cidade — foi a resposta mais escolhida
 *    (48 de 315 fichas) e não diz para onde chamar a pessoa;
 *  - camisa e bota saem da ficha: só 164 das 315 ficavam completas;
 *  - a hora entra na conversa, para não prometer ligação às 2h da manhã;
 *  - no fim, ele pergunta se pode passar a ficha para o responsável ligar.
 */
import { readFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.ESTADO_ARQUIVO = join(mkdtempSync(join(tmpdir(), 'dialogos-')), 'conversas.json')

const brain = await import('../src/brain.js')
const { oQueJaSabe } = await import('../src/atendimento.js')

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

// ── A cidade abre a conversa ───────────────────────────────────────────
{
  const i = brain.iniciar('5514999990000')
  ok('a primeira pergunta é a cidade', i.estado.etapa === 'cidade' && /cidade você quer trabalhar/i.test(i.resposta))
  ok('  e não a vaga', !/qual vaga você quer/i.test(i.resposta))

  const r = brain.responder(i.estado, 'bastos')
  ok('escolhida a cidade, pergunta a vaga', r.estado.cidade === 'Bastos' && r.estado.etapa === 'vaga')
  // O alojamento por cidade vem do cadastro do RH; na lista reserva todas
  // vêm sem alojamento, de propósito (prometer errado custa a mudança).
  ok('  e confirma a cidade escolhida', /Bastos/.test(r.resposta))

  const r2 = brain.responder(r.estado, 'pedreiro')
  ok('a vaga entra depois da cidade', r2.estado.vaga === 'Pedreiro' && r2.estado.cidade === 'Bastos')
}

// ── Cidade e vaga na mesma frase ───────────────────────────────────────
{
  const i = brain.iniciar('5514999990001')
  const r = brain.responder(i.estado, 'quero vaga de pedreiro em buritama')
  ok('registra as duas de uma vez', r.estado.cidade === 'Buritama' && r.estado.vaga === 'Pedreiro')
  ok('  e não pergunta a vaga de novo', !/para qual vaga/i.test(r.resposta))
}

// ── "Qualquer uma" não vale como cidade ────────────────────────────────
{
  const i = brain.iniciar('5514999990002')
  for (const frase of ['qualquer uma', 'tanto faz', 'onde tiver vaga']) {
    const r = brain.responder(i.estado, frase)
    ok(`"${frase}" não vira cidade`, !r.estado.cidade)
    ok('  e mostra a lista', /Bastos/.test(r.resposta))
  }
}

// ── Ajudante em Bastos está aberto ─────────────────────────────────────
{
  const i = brain.iniciar('5514999990003')
  const cidade = brain.responder(i.estado, 'bastos')
  const r = brain.responder(cidade.estado, 'ajudante')
  ok('ajudante em Bastos segue como Servente', r.estado.vaga === 'Servente' && r.estado.cidade === 'Bastos')
}

// ── A ficha ficou mais curta ───────────────────────────────────────────
{
  const semUniforme = {
    vaga: 'Pedreiro', cidadeMora: 'Bastos', cidade: 'Bastos', nome: 'Carlos Alberto', temExperiencia: true,
    temRegistro: true, dataNascimento: 'x', disponibilidadeInicio: 'já', aceitaOutrasObras: 'sim',
    contatoRecadoNome: 'Manu',
  }
  const r = oQueJaSabe(semUniforme)
  ok('camisa e bota não travam mais a ficha', !r.falta.some(x => /camisa|bota/.test(x)))
  ok('  e a ficha conta como completa', r.falta.length === 0)
}

// ── A hora entra na conversa ───────────────────────────────────────────
{
  const madrugada = oQueJaSabe({ vaga: 'Pedreiro' }, { agora: new Date('2026-09-17T05:00:00Z') })
  ok('de madrugada, avisa a hora', /AGORA SÃO 02h/.test(madrugada.texto))
  ok('  e manda não prometer ligação hoje', /Não prometa ligação para hoje/.test(madrugada.texto))
  const tarde = oQueJaSabe({ vaga: 'Pedreiro' }, { agora: new Date('2026-09-17T18:00:00Z') })
  ok('à tarde, sem esse aviso', /AGORA SÃO 15h/.test(tarde.texto) && !/Não prometa ligação/.test(tarde.texto))
}

// ── Confirmar interesse ────────────────────────────────────────────────
{
  const sim = oQueJaSabe({ vaga: 'Pedreiro', nome: 'João Silva', confirmouInteresse: 'sim' })
  ok('deixou passar a ficha: o modelo sabe', sim.sabido.some(x => /deixou passar a ficha/.test(x)))
  const nao = oQueJaSabe({ vaga: 'Pedreiro', nome: 'João Silva', confirmouInteresse: 'nao' })
  ok('não quis: manda não insistir', /não insista/i.test(nao.texto))
}

// ── A ligação ──────────────────────────────────────────────────────────
{
  const aqui = dirname(fileURLToPath(import.meta.url))
  const ia = readFileSync(join(aqui, '..', 'src', 'ia.js'), 'utf8')
  const audio = readFileSync(join(aqui, '..', 'src', 'ia-audio.js'), 'utf8')
  const rc = readFileSync(join(aqui, '..', 'src', 'rh-client.js'), 'utf8')
  ok('a IA pergunta a cidade primeiro', /1\. EM QUAL CIDADE A PESSOA MORA/.test(ia))
  ok('a IA recusa "qualquer uma"', /"Qualquer uma", "tanto faz" ou "onde tiver" NÃO serve/.test(ia))
  ok('camisa e bota ficam para a contratação', /NÃO se pergunta agora: fica para a contratação/.test(ia))
  ok('a IA confirma o interesse no fim', /posso passar sua ficha pro responsável te ligar/.test(ia))
  ok('o áudio tenta de novo antes de desistir', /Segunda rodada no primeiro modelo/.test(audio))
  ok('a confirmação vai para a ficha do RH', /'confirmouInteresse'/.test(rc))
  ok('nenhum caractere invisível entrou', ![ia, audio, rc].some(t => t.includes(String.fromCharCode(8))))
}

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
