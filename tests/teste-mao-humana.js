/**
 * O robô não fala por cima de quem já está atendendo.
 *
 * Caso real, 12/09/2026: o dono escreveu "preenche essa ficha que eu peço
 * para te ligarem" e, no mesmo minuto, o robô perguntou "você está procurando
 * vaga por aqui?" — para o candidato, a empresa falando duas coisas.
 */
import { gentesRespondeu, atendidaPorGente, _limpar, situacao } from '../src/mao-humana.js'

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

const HORA = 3600_000
const agora = Date.now()

_limpar()

// ── Ninguém atendeu: o robô responde ───────────────────────────────────
ok('conversa sem gente: o robô atende', !atendidaPorGente('5511999990001', agora).atendida)

// ── Gente respondeu: o robô cala ───────────────────────────────────────
{
  gentesRespondeu('5511999990002', agora)
  const r = atendidaPorGente('5511999990002', agora + 60_000)
  ok('depois de uma resposta de gente, o robô cala', r.atendida)
  ok('e o log sabe há quanto tempo', r.faz === 1)
}

// ── A janela vira e o robô volta ───────────────────────────────────────
//
// Sem isso, uma resposta de gente calaria o robô para sempre naquela
// conversa — e a pessoa que voltasse dali a uma semana ficaria sem resposta.
{
  gentesRespondeu('5511999990003', agora)
  ok('11 h depois ainda está calado', atendidaPorGente('5511999990003', agora + 11 * HORA).atendida)
  ok('13 h depois volta a atender', !atendidaPorGente('5511999990003', agora + 13 * HORA).atendida)
  ok('a janela padrão é de 12 h', situacao().janelaHoras === 12)
}

// ── Cada conversa é uma ────────────────────────────────────────────────
{
  gentesRespondeu('5511999990004', agora)
  ok('o vizinho continua sendo atendido', !atendidaPorGente('5511999990005', agora).atendida)
}

// ── Bordas ─────────────────────────────────────────────────────────────
ok('número vazio não quebra', !atendidaPorGente('', agora).atendida)
ok('marcar vazio não quebra', (gentesRespondeu(null, agora), true))

// ── Não cresce para sempre ─────────────────────────────────────────────
{
  _limpar()
  for (let i = 0; i < 2100; i++) gentesRespondeu(`551199${String(i).padStart(7, '0')}`, agora)
  const antes = situacao().conversasComGente
  gentesRespondeu('5511988888888', agora + 30 * HORA)
  ok('a limpeza tira as conversas velhas', situacao().conversasComGente < antes)
}

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
