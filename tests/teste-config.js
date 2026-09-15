/**
 * O carregamento do `.env`.
 *
 * Motivo real: o robô subiu no servidor sob o pm2 SEM configuração nenhuma,
 * e ficou assim por horas. O `--env-file-if-exists` resolve o caminho a
 * partir do diretório de onde o processo foi iniciado; o pm2 inicia de outro
 * lugar, o arquivo não foi encontrado, e o "if-exists" mandou seguir em
 * silêncio.
 *
 * O resultado foi o pior tipo de falha: no ar, respondendo, e sem token. O RH
 * recusava tudo e a única pista era uma linha dizendo que as variáveis não
 * estavam configuradas — com o arquivo cheio delas do lado.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../src/config.js'

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

// ── O parser ──────────────────────────────────────────────────────────────
{
  const r = parse(`
# um comentário
PORT=3100
RH_API_URL=http://localhost:3000

  ESPACO_ANTES=vale
COM_ASPAS="entre aspas"
COM_SIMPLES='simples'
VAZIO=
IGUAL_NO_VALOR=a=b=c
  # comentário indentado
SEM_IGUAL
=SEM_CHAVE
CHAVE-INVALIDA=x
`)

  ok('lê chave e valor', r.PORT === '3100')
  ok('valor com "//" e ":" sobrevive', r.RH_API_URL === 'http://localhost:3000')
  ok('espaço antes da chave não atrapalha', r.ESPACO_ANTES === 'vale')
  ok('tira aspas duplas', r.COM_ASPAS === 'entre aspas')
  ok('tira aspas simples', r.COM_SIMPLES === 'simples')
  ok('valor vazio vira string vazia', r.VAZIO === '')

  // O primeiro "=" separa; o resto é valor. Um token pode ter "=" dentro.
  ok('só o primeiro = separa', r.IGUAL_NO_VALOR === 'a=b=c')

  ok('ignora comentário', !('#' in r))
  ok('ignora linha sem =', !('SEM_IGUAL' in r))
  ok('ignora linha sem chave', !('' in r))
  ok('ignora chave inválida', !('CHAVE-INVALIDA' in r))
  ok('texto vazio não quebra', Object.keys(parse('')).length === 0)
  ok('nulo não quebra', Object.keys(parse(null)).length === 0)
}

// ── Acha o arquivo do PROJETO, venha de onde vier ─────────────────────────
// É o defeito que motivou o módulo: o pm2 inicia de outro diretório.
{
  const pasta = join(process.cwd(), 'dados', 'teste-config')
  rmSync(pasta, { recursive: true, force: true })
  mkdirSync(pasta, { recursive: true })
  const arquivo = join(pasta, '.env-de-teste')
  writeFileSync(arquivo, 'VAR_DO_ARQUIVO=veio-do-arquivo\nVAR_JA_NO_AMBIENTE=do-arquivo\n', 'utf8')

  // O ambiente ganha do arquivo: quem exporta na linha de comando está
  // dizendo o que quer, e o arquivo não pode atropelar.
  process.env.VAR_JA_NO_AMBIENTE = 'do-ambiente'
  process.env.ENV_FILE = arquivo

  const { carregar } = await import(`../src/config.js?t=${Date.now()}`)
  const r = carregar()

  ok('achou o arquivo apontado', r.achou === true)
  ok('carregou o que faltava', process.env.VAR_DO_ARQUIVO === 'veio-do-arquivo')
  ok('e NÃO atropelou o que já estava no ambiente', process.env.VAR_JA_NO_AMBIENTE === 'do-ambiente')
  // Chamar de novo não recarrega nada: o que já está no ambiente ganha, e
  // isso vale também para o que ele mesmo acabou de pôr lá. É o que impede
  // uma segunda leitura de desfazer um valor mudado em tempo de execução.
  ok('carregar de novo não mexe em nada', r.carregadas === 0)

  rmSync(pasta, { recursive: true, force: true })
}

// ── Arquivo ausente é dito em voz alta, não engolido ──────────────────────
{
  process.env.ENV_FILE = join(process.cwd(), 'dados', 'nao-existe', '.env')
  const { carregar } = await import(`../src/config.js?t=${Date.now()}b`)
  const r = carregar()
  ok('diz que não achou', r.achou === false)
  ok('e informa onde procurou', r.caminho.includes('nao-existe'))
}

delete process.env.ENV_FILE
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exitCode = falhas ? 1 : 0
