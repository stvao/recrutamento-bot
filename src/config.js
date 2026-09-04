/**
 * Carrega o `.env` do PROJETO, e não o do diretório de onde alguém rodou.
 *
 * Isto existe por causa de uma noite perdida. O `npm start` usa
 * `--env-file-if-exists=.env`, e esse caminho é resolvido a partir do
 * diretório de trabalho do processo. Rodando à mão dentro da pasta, funciona.
 * Sob o pm2, que inicia de outro lugar, o arquivo não é encontrado — e o
 * `if-exists` manda seguir EM SILÊNCIO.
 *
 * O resultado foi o pior tipo de falha: o robô no ar, respondendo, sem token
 * nenhum. O RH recusava tudo, o WhatsApp não conectava, e a única pista era
 * uma linha de aviso no meio do log dizendo que as variáveis não estavam
 * configuradas — quando o arquivo estava lá, do lado, cheio delas.
 *
 * Aqui o caminho é calculado a partir da localização DESTE arquivo. Não
 * importa de onde o processo foi iniciado.
 *
 * O que já veio do ambiente ganha: quem exporta uma variável na linha de
 * comando (ou nos testes) está dizendo o que quer, e o arquivo não pode
 * atropelar isso.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)))
const CAMINHO = process.env.ENV_FILE || join(RAIZ, '.env')

/**
 * Um parser mínimo, de propósito.
 *
 * `KEY=valor`, comentários com `#`, aspas opcionais em volta do valor. É o
 * que o próprio Node aceita no `--env-file`, e é tudo que este projeto usa —
 * trazer uma dependência para ler doze linhas seria pagar caro por nada.
 */
export function parse(texto) {
  const fora = {}
  for (const linha of (texto || '').split('\n')) {
    const limpa = linha.trim()
    if (!limpa || limpa.startsWith('#')) continue

    const igual = limpa.indexOf('=')
    if (igual < 1) continue

    const chave = limpa.slice(0, igual).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(chave)) continue

    let valor = limpa.slice(igual + 1).trim()
    if ((valor.startsWith('"') && valor.endsWith('"'))
      || (valor.startsWith("'") && valor.endsWith("'"))) {
      valor = valor.slice(1, -1)
    }
    fora[chave] = valor
  }
  return fora
}

/**
 * Põe no ambiente o que ainda não está lá.
 *
 * Devolve o que fez, para o arranque poder dizer em voz alta quando não
 * achou o arquivo — silêncio aqui foi exatamente o problema.
 */
export function carregar() {
  if (!existsSync(CAMINHO)) {
    return { achou: false, caminho: CAMINHO, carregadas: 0 }
  }

  let carregadas = 0
  try {
    for (const [chave, valor] of Object.entries(parse(readFileSync(CAMINHO, 'utf8')))) {
      // O ambiente ganha do arquivo: quem exportou na linha de comando está
      // dizendo o que quer.
      if (process.env[chave] === undefined) {
        process.env[chave] = valor
        carregadas++
      }
    }
  } catch (e) {
    console.error(`[config] não consegui ler ${CAMINHO}:`, e.message)
    return { achou: true, caminho: CAMINHO, carregadas, erro: e.message }
  }

  return { achou: true, caminho: CAMINHO, carregadas }
}

const resultado = carregar()

if (!resultado.achou) {
  console.error(
    `\n❌ NÃO ACHEI O .env em ${resultado.caminho}\n`
    + '   O robô vai subir sem token nenhum: o RH recusa tudo, o sistema de\n'
    + '   obras não recebe comprovante, e a IA não responde.\n\n'
    + '   Crie o arquivo ali, ou aponte outro com ENV_FILE=/caminho/do/.env\n',
  )
} else if (resultado.carregadas) {
  console.log(`[config] ${resultado.carregadas} variáve${resultado.carregadas === 1 ? 'l' : 'is'} de ${resultado.caminho}`)
}

export default resultado
