/**
 * O robô olhando as conversas — sem guardar o que não deve.
 *
 * O que estes testes protegem, em ordem de gravidade: o telefone não vai
 * para o arquivo; o prazo apaga o que passou dele; e nada disso derruba o
 * atendimento.
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A pasta e as chaves precisam existir ANTES do import: a pasta é lida no
// carregamento do módulo.
const PASTA = mkdtempSync(join(tmpdir(), 'observacao-teste-'))
process.env.OBSERVACAO_DIR = PASTA
process.env.OBSERVAR = 'on'
process.env.OBSERVACAO_DIAS = '180'

const obs = await import('../src/observacao.js')

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

const TELEFONE = '5511912345678'
const JID = `${TELEFONE}@s.whatsapp.net`
const agora = Date.now()

// ── Anota os dois lados ────────────────────────────────────────────────
ok('anota o candidato', obs.anotar({ chave: JID, final: TELEFONE, autor: 'candidato', tipo: 'texto', texto: 'boa tarde, tem vaga de pedreiro?', em: agora }))
ok('anota a resposta do dono', obs.anotar({ chave: JID, final: TELEFONE, autor: 'empresa', tipo: 'texto', texto: 'tem sim, em Buritama', em: agora + 60000 }))
ok('anota áudio sem texto', obs.anotar({ chave: JID, autor: 'candidato', tipo: 'audio', em: agora + 120000 }))

const registros = obs.lerTudo()
ok('três registros', registros.length === 3)
ok('em ordem de tempo', registros[0].autor === 'candidato' && registros[1].autor === 'empresa')

// ── O telefone NÃO vai para o arquivo ──────────────────────────────────
//
// O mais importante do arquivo. Conversa de candidato vazada com o número
// dele é o tipo de coisa que vira processo.
{
  const bruto = readdirSync(PASTA).filter(n => n.endsWith('.jsonl'))
    .map(n => readFileSync(join(PASTA, n), 'utf8')).join('')
  ok('o telefone inteiro não aparece', !bruto.includes(TELEFONE))
  ok('nem o endereço do WhatsApp', !bruto.includes('@s.whatsapp.net'))
  ok('ficam só os 4 últimos dígitos', registros[0].final === '5678')
}

// ── O código da conversa ───────────────────────────────────────────────
ok('mesma conversa, mesmo código', registros[0].conversa === registros[1].conversa)
ok('outra conversa, outro código', obs.codigoDaConversa('outro@lid') !== registros[0].conversa)
ok('o código tem cara de código', /^c_[0-9a-f]{10}$/.test(registros[0].conversa))
ok('o sal ficou só no servidor', existsSync(join(PASTA, '.sal')))

// ── Tipos ──────────────────────────────────────────────────────────────
ok('texto simples', obs.tipoDe({ conversation: 'oi' }) === 'texto')
ok('texto com citação', obs.tipoDe({ extendedTextMessage: { text: 'oi' } }) === 'texto')
ok('áudio', obs.tipoDe({ audioMessage: {} }) === 'audio')
ok('figurinha', obs.tipoDe({ stickerMessage: {} }) === 'figurinha')
ok('reação não é conversa', obs.tipoDe({ reactionMessage: {} }) === null)
ok('mensagem apagada não é', obs.tipoDe({ protocolMessage: {} }) === null)
ok('só criptografia não é', obs.tipoDe({ senderKeyDistributionMessage: {}, messageContextInfo: {} }) === null)
ok('vazia não é', obs.tipoDe(null) === null)

// ── O que o robô mandou ────────────────────────────────────────────────
obs.marcarDoRobo('ABC123')
ok('reconhece o que o robô enviou', obs.foiORobo('ABC123'))
ok('e não confunde com o dono', !obs.foiORobo('XYZ999'))

// ── Texto enorme é cortado ─────────────────────────────────────────────
{
  obs.anotar({ chave: 'x@lid', autor: 'candidato', tipo: 'texto', texto: 'a'.repeat(10000), em: agora })
  const ultimo = obs.lerTudo().find(r => r.conversa === obs.codigoDaConversa('x@lid'))
  ok('texto cortado em 2000', ultimo.texto.length === 2000)
}

// ── Sem o essencial, não anota ─────────────────────────────────────────
ok('sem autor não anota', !obs.anotar({ chave: JID, tipo: 'texto', texto: 'x' }))
ok('sem conversa não anota', !obs.anotar({ autor: 'candidato', tipo: 'texto', texto: 'x' }))

// ── Desligado não anota ────────────────────────────────────────────────
process.env.OBSERVAR = 'off'
ok('OBSERVAR=off não anota', !obs.anotar({ chave: JID, autor: 'candidato', tipo: 'texto', texto: 'x' }))
process.env.OBSERVAR = 'on'

// ── O prazo apaga o mês inteiro que passou ─────────────────────────────
{
  writeFileSync(join(PASTA, '2020-01.jsonl'), '{"em":"2020-01-05T10:00:00.000Z"}\n')
  const apagados = obs.limparAntigos(agora)
  ok('o mês velho saiu', apagados === 1 && !existsSync(join(PASTA, '2020-01.jsonl')))
  ok('o mês atual ficou', obs.lerTudo().length >= 3)
}

// ── Linha quebrada não impede a leitura ────────────────────────────────
{
  const d = new Date(agora)
  const mes = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`
  writeFileSync(join(PASTA, mes), readFileSync(join(PASTA, mes), 'utf8') + '{"em": "quebrad\n')
  let leu = false
  try { leu = obs.lerTudo().length >= 3 } catch { leu = false }
  ok('linha pela metade é pulada', leu)
}

try { rmSync(PASTA, { recursive: true, force: true }) } catch { /* tanto faz */ }

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
