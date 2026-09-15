/**
 * O limite de mensagens por número.
 *
 * O que este teste protege é a cota do modelo de conversa, que é diária e
 * compartilhada: gasta por um número insistente, o candidato que escrever
 * depois cai no roteiro fixo, sem salário nem cidade.
 *
 * Por isso os casos são sobre as duas pontas: a enxurrada tem que parar, e
 * quem só conversa normalmente NUNCA pode ser barrado.
 */
import { registrar, textoDoAviso, _limpar, situacao } from '../src/limite.js'

let falhas = 0
function ok(nome, condicao) {
  if (condicao) {
    console.log(`ok  ${nome}`)
  } else {
    falhas++
    console.log(`FALHOU ${nome}`)
  }
}

const MAX = Number(process.env.LIMITE_MENSAGENS || 25)
const JANELA_MS = Number(process.env.LIMITE_JANELA_MIN || 10) * 60 * 1000

// ── A conversa normal passa inteira ────────────────────────────────────
//
// O caso que mais importa: uma candidatura tem uma dúzia de idas e vindas, e
// barrar no meio dela seria trocar um problema raro por um problema diário.
_limpar()
{
  let todasPassaram = true
  for (let i = 0; i < MAX; i++) {
    if (!registrar('5511999999999').permitido) todasPassaram = false
  }
  ok(`${MAX} mensagens seguidas passam`, todasPassaram)
}

// ── A enxurrada para ───────────────────────────────────────────────────
{
  const passouDoLimite = registrar('5511999999999')
  ok('a seguinte é barrada', passouDoLimite.permitido === false)
  ok('e a pessoa é avisada', passouDoLimite.avisar === true)

  const depois = registrar('5511999999999')
  ok('a próxima também é barrada', depois.permitido === false)
  ok('mas NÃO avisa de novo', depois.avisar === false)
}

// ── Um número não afeta o outro ────────────────────────────────────────
//
// Sem isso, um número insistente derrubaria o atendimento de todo mundo — que
// é exatamente o que o limite deveria impedir.
_limpar()
{
  for (let i = 0; i < MAX + 5; i++) registrar('5511111111111')
  ok('vizinho segue atendido', registrar('5511222222222').permitido === true)
}

// ── A janela vira e a pessoa volta a ser atendida ──────────────────────
//
// O limite não é castigo. Quem esperou tem que ser atendido, senão um engano
// de um minuto viraria um cliente perdido.
_limpar()
{
  const agora = Date.now()
  for (let i = 0; i < MAX + 3; i++) registrar('5511333333333', agora)
  ok('barrado dentro da janela', registrar('5511333333333', agora).permitido === false)

  const depoisDaJanela = agora + JANELA_MS + 1000
  ok('atendido de novo depois da janela', registrar('5511333333333', depoisDaJanela).permitido === true)
}

// ── A janela desliza, não zera de uma vez ──────────────────────────────
//
// Uma mensagem por minuto o dia inteiro é conversa, não enxurrada.
_limpar()
{
  const inicio = Date.now()
  let barrou = false
  for (let i = 0; i < MAX * 3; i++) {
    // Uma a cada minuto: nunca junta MAX dentro da mesma janela.
    const quando = inicio + i * 60 * 1000
    if (!registrar('5511444444444', quando).permitido) barrou = true
  }
  ok('conversa espaçada nunca é barrada', barrou === false)
}

// ── Bordas ─────────────────────────────────────────────────────────────
_limpar()
ok('número vazio não quebra', registrar('').permitido === true)
ok('número nulo não quebra', registrar(null).permitido === true)
ok('o aviso é uma frase de gente', /respondo/.test(textoDoAviso()))
ok('situação conta os números', typeof situacao().numerosAcompanhados === 'number')

// ── Não cresce para sempre ─────────────────────────────────────────────
//
// O Map guarda um registro por número que já escreveu. Sem limpeza, meses de
// operação viram um Map com todo mundo que já mandou "oi" desde sempre.
_limpar()
{
  const agora = Date.now()
  for (let i = 0; i < 600; i++) registrar(`55119${String(i).padStart(8, '0')}`, agora)
  const antes = situacao().numerosAcompanhados

  // Muito depois: a próxima mensagem dispara a limpeza dos que sumiram.
  registrar('5511888888888', agora + JANELA_MS * 3)
  ok('a limpeza tira quem sumiu', situacao().numerosAcompanhados < antes)
}

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
