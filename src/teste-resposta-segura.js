/**
 * A barreira do que o robô não pode dizer.
 *
 * Existe porque ela falhou de duas formas diferentes, e as duas silenciosas:
 *
 *  1. As regras estavam copiadas em triagem.js e funcionario.js, e
 *     divergiram — uma passou a barrar "bit.ly" e "código de acesso", a outra
 *     não. Sem um lugar comum, a diferença não aparecia para ninguém.
 *
 *  2. Um conserto aplicado aos dois arquivos sem ler os dois fez a barreira
 *     lançar ReferenceError EXATAMENTE ao disparar. Uma barreira que só
 *     quebra quando tem trabalho é pior que barreira nenhuma.
 *
 *   node src/teste-resposta-segura.js
 */
import { proibidoEm } from './resposta-segura.js'

let falhas = 0
function ok(desc, cond) {
  if (!cond) falhas++
  console.log(`${cond ? 'ok  ' : 'FALHA '}${desc}`)
}

// ── O que NÃO pode sair ─────────────────────────────────────────────────────
const DEVE_BARRAR = [
  ['valor', 'Seu salário é R$ 2.500,00'],
  ['valor', 'São 2500 reais por mês'],
  // Escrito por extenso passava: é justamente assim que um modelo escreve,
  // porque soa mais natural. A forma não muda que salário dito vira prova.
  ['valor', 'São dois mil reais por mês'],
  ['valor', 'Ganha mil e quinhentos'],
  ['valor', 'o salário de pedreiro é esse'],
  ['link', 'Acessa https://exemplo.com'],
  ['link', 'entra em www.exemplo.com'],
  // bit.ly existia só no atendimento ao funcionário — a triagem não tinha.
  ['link', 'clica em bit.ly/abc'],
  ['senha', 'Sua senha é 1234'],
  ['senha', 'Seu token de acesso'],
  // "código de acesso" idem: existia num arquivo só.
  ['senha', 'Seu código de acesso chegou'],
  ['senha', 'Seu codigo de acesso chegou'],
]
for (const [categoria, texto] of DEVE_BARRAR) {
  const p = proibidoEm(texto)
  ok(`barra ${categoria}: "${texto.slice(0, 34)}"`, p.includes(categoria))
}

// ── O que PODE sair ─────────────────────────────────────────────────────────
//
// Tão importante quanto o resto: uma barreira que barra tudo manda toda
// conversa para um humano, e aí ninguém a mantém ligada.
const DEVE_PASSAR = [
  'Bom dia! Em que posso ajudar?',
  'A obra fica em Bastos',
  'Trabalhamos de segunda a quinta das 7h às 17h',
  'Já anotei sua candidatura, obrigada',
  'Vou chamar alguém da equipe pra falar com você',
  'Tem alojamento em Buritama',
  'Qual é o seu nome completo?',
  'Você já teve registro em carteira nessa função?',
  'A contratação é com registro em carteira',
]
for (const texto of DEVE_PASSAR) {
  ok(`deixa passar: "${texto.slice(0, 34)}"`, proibidoEm(texto).length === 0)
}

// ── Não quebra com entrada estranha ─────────────────────────────────────────
for (const v of [null, undefined, '', '   ', 42, {}, []]) {
  let quebrou = false
  try { proibidoEm(v) } catch { quebrou = true }
  ok(`não quebra com ${JSON.stringify(v)}`, !quebrou)
}

// ── As duas conversas usam a MESMA barreira ─────────────────────────────────
//
// É o que impede a divergência de voltar: se uma delas parar de importar
// daqui, este teste continua passando, mas o de triagem/funcionário mostra a
// diferença. Aqui se garante ao menos que a fonte é única.
const { conferir: conferirTriagem } = await import('./triagem.js')
const { conferir: conferirFuncionario } = await import('./funcionario.js')

for (const [nome, fn] of [['triagem', conferirTriagem], ['funcionario', conferirFuncionario]]) {
  for (const texto of ['clica em bit.ly/abc', 'Seu código de acesso chegou', 'São dois mil reais']) {
    let r, quebrou = false
    try { r = fn({ resposta: texto, intencao: 'procura_vaga' }) } catch { quebrou = true }
    ok(`${nome} barra "${texto.slice(0, 24)}" sem quebrar`, !quebrou && r?.precisaHumano === true)
  }
}

console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
