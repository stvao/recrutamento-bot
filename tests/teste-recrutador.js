/**
 * O robô como recrutador (dono, 18/09/2026): sente a pessoa, prepara e
 * convence com o que é verdade, filtra quem vai mesmo e confere se ela sabe
 * fazer — para o entrevistador abrir a ficha e já ligar para contratar.
 */
import { readFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.ESTADO_ARQUIVO = join(mkdtempSync(join(tmpdir(), 'recrutador-')), 'conversas.json')

const { oQueJaSabe } = await import('../src/atendimento.js')
const brain = await import('../src/brain.js')

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

// ── Confere se sabe fazer ──────────────────────────────────────────────
{
  const semTeste = oQueJaSabe({ vaga: 'Pedreiro', nome: 'João Silva', cidadeMora: 'Bastos', cidade: 'Bastos' })
  ok('com nome e vaga, falta conferir o que sabe fazer', semTeste.falta.some(x => /sabe fazer/.test(x)))
  const conferido = oQueJaSabe({ vaga: 'Pedreiro', nome: 'João Silva', avaliacaoTecnica: 'boa' })
  ok('conferido, não pergunta de novo', !conferido.falta.some(x => /sabe fazer/.test(x)))
  ok('  e o modelo sabe como foi', conferido.sabido.some(x => /já conferiu o que sabe fazer \(boa\)/.test(x)))
}

// ── Filtra quem vai mesmo para o alojamento ────────────────────────────
{
  const deFora = oQueJaSabe({ vaga: 'Pedreiro', nome: 'João Silva', cidadeMora: 'Marília', cidade: 'Bastos' })
  ok('pedreiro de fora: confirma disponibilidade REAL de alojamento', deFora.falta.some(x => /disponibilidade REAL de ficar no alojamento/.test(x)))
  const daqui = oQueJaSabe({ vaga: 'Pedreiro', nome: 'João Silva', cidadeMora: 'Bastos', cidade: 'Bastos' })
  ok('pedreiro da cidade: não pergunta alojamento', !daqui.falta.some(x => /alojamento/.test(x)))
  const ajudante = oQueJaSabe({ vaga: 'Servente', nome: 'Ana Souza', cidadeMora: 'Marília', cidade: 'Bastos' })
  ok('ajudante nunca é empurrado para alojamento', !ajudante.falta.some(x => /alojamento/.test(x)))
  const firme = oQueJaSabe({ vaga: 'Pedreiro', nome: 'João Silva', cidadeMora: 'Marília', cidade: 'Bastos', alojamentoFirme: 'sim' })
  ok('já confirmado, não pergunta de novo', firme.sabido.some(x => /disponibilidade real de alojamento: sim/.test(x)))
}

// ── O que ele percebeu vai junto ───────────────────────────────────────
{
  const r = oQueJaSabe({ vaga: 'Pedreiro', sinais: 'condiciona à passagem adiantada' })
  ok('o que já percebeu da pessoa entra na conversa', /condiciona à passagem adiantada/.test(r.texto))
}

// ── Passagem, nas palavras do dono ─────────────────────────────────────
{
  const r = brain.responderFAQ('vcs pagam a passagem?', {})?.texto ?? ''
  ok('passagem: não faz adiantamento', /não faz adiantamento/.test(r))
  ok('  e reembolsa o valor gasto quando chega', /quando você chega no local da obra, a gente reembolsa o valor que você gastou/.test(r))
}

// ── As instruções ──────────────────────────────────────────────────────
{
  const aqui = dirname(fileURLToPath(import.meta.url))
  const ia = readFileSync(join(aqui, '..', 'src', 'ia.js'), 'utf8')
  const at = readFileSync(join(aqui, '..', 'src', 'atendimento.js'), 'utf8')
  const rc = readFileSync(join(aqui, '..', 'src', 'rh-client.js'), 'utf8')
  ok('ela é recrutadora, não só atendente', /VOCÊ É RECRUTADORA, NÃO SÓ ATENDENTE/.test(ia))
  ok('sente a pessoa e anota em sinais', /SINTA A PESSOA/.test(ia) && /sinais/.test(ia))
  ok('convence só com o que é verdade', /CONVENÇA COM O QUE É VERDADE/.test(ia) && /Nada de "salário alto", "vaga garantida"/.test(ia))
  ok('ajudante de fora não vai para Bastos', /Não empurre ajudante de fora para Bastos/.test(ia))
  ok('não promete de quanto em quanto tempo volta para casa', /Não prometa de quanto em quanto tempo ele volta para casa/.test(ia))
  ok('perguntas técnicas por função', /levanta parede de bloco sozinho/.test(ia) && /monta forma de pilar e viga/.test(ia))
  ok('no máximo duas perguntas técnicas', /duas perguntas, no máximo/.test(ia))
  ok('registra quem indicou', /indicadoPor/.test(ia))
  ok('o que se percebe acumula entre as conversas', /O que se percebe acumula/.test(at))
  ok('tudo vai para a ficha do RH', ['alojamentoFirme', 'avaliacaoTecnica', 'respostasTecnicas', 'sinais', 'indicadoPor'].every(c => rc.includes(`'${c}'`)))
  ok('nenhum caractere invisível', ![ia, at, rc].some(t => t.includes(String.fromCharCode(8))))
}

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
