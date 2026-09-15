/**
 * O comprovante que fica esperando — e o que expira.
 *
 * A ronda do módulo de gastos cuida de quem RECEBEU pergunta. O caso que
 * escapava dela é o órfão: comprovante que chega sem legenda espera um minuto
 * pela descrição, e se o robô reiniciar nesse minuto a ficha volta do disco
 * sem `perguntadoEm` — que é exatamente o campo que a ronda usa para decidir.
 *
 * Ficavam para sempre. Somando cinquenta, passavam a impedir comprovante novo
 * da mesma pessoa: uma foto órfã de dois meses atrás barrando o gasto de hoje.
 */
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A pasta tem que ser escolhida ANTES de importar o módulo: ele lê a variável
// ao ser carregado.
const PASTA = mkdtempSync(join(tmpdir(), 'pendentes-teste-'))
process.env.GASTOS_PENDENTES_DIR = PASTA
process.env.GASTOS_VALIDADE_DIAS = '7'

const pendentes = await import('../src/pendentes.js')

let falhas = 0
function ok(nome, condicao) {
  if (condicao) {
    console.log(`ok  ${nome}`)
  } else {
    falhas++
    console.log(`FALHOU ${nome}`)
  }
}

const DIA = 24 * 60 * 60 * 1000
const agora = Date.now()

function guardar(id, criadoEm, extra = {}) {
  return pendentes.guardar({
    id,
    idMensagem: id,
    de: '5511999999999',
    arquivo: Buffer.from('foto de mentira'),
    criadoEm,
    ...extra,
  })
}

// ── O recente fica ─────────────────────────────────────────────────────
//
// O caso mais importante: expirar cedo demais jogaria fora comprovante que
// a pessoa ainda vai responder — e aí o gasto some sem ninguém notar.
pendentes._esquecer()
guardar('recente', agora - 1 * DIA)
guardar('ontem', agora - 2 * DIA)
{
  const removidos = pendentes.limparAntigos(agora)
  ok('não descarta o que é recente', removidos === 0)
  ok('os dois continuam esperando', pendentes.quantos() === 2)
}

// ── O antigo sai ───────────────────────────────────────────────────────
{
  guardar('esquecido', agora - 30 * DIA)
  ok('o antigo entrou', pendentes.quantos() === 3)

  const removidos = pendentes.limparAntigos(agora)
  ok('o antigo é descartado', removidos === 1)
  ok('só ele saiu', pendentes.quantos() === 2)
  ok('o recente sobreviveu', pendentes.porId('recente') !== null)
  ok('o antigo se foi', pendentes.porId('esquecido') === null)
}

// ── O ÓRFÃO: sem perguntadoEm, que é o que a ronda pula ────────────────
{
  const orfao = guardar('orfao', agora - 20 * DIA)
  ok('o órfão não tem perguntadoEm', !orfao.perguntadoEm)

  pendentes.limparAntigos(agora)
  ok('o órfão também é descartado', pendentes.porId('orfao') === null)
}

// ── E o arquivo sai do disco junto ─────────────────────────────────────
//
// Remover só da memória deixaria a foto ocupando disco para sempre — que é
// metade do problema que isto conserta.
{
  pendentes._esquecer()
  guardar('comArquivo', agora - 40 * DIA)
  const antes = readdirSync(PASTA).length
  ok('gravou ficha e arquivo', antes >= 2)

  pendentes.limparAntigos(agora)
  const depois = readdirSync(PASTA).filter(n => n.startsWith('comArquivo'))
  ok('a foto saiu do disco', depois.length === 0)
}

// ── Ficha de formato antigo, sem data ──────────────────────────────────
//
// Foi gravada antes desta regra existir: conta como velha, senão ficaria
// imune para sempre — justamente o que se está consertando.
{
  pendentes._esquecer()
  guardar('semData', undefined)
  pendentes.limparAntigos(agora)
  ok('ficha sem data é descartada', pendentes.porId('semData') === null)
}

// ── Desligável ─────────────────────────────────────────────────────────
ok('a validade é configurável', process.env.GASTOS_VALIDADE_DIAS === '7')

// Limpeza do próprio teste.
try { rmSync(PASTA, { recursive: true, force: true }) } catch { /* tanto faz */ }
ok('a pasta de teste foi removida', !existsSync(PASTA))

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
