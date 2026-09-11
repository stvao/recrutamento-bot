/**
 * O código-fonte não tem caractere invisível.
 *
 * Aconteceu duas vezes neste projeto, pelo mesmo caminho: um script de
 * edição escreveu `\b` ("fronteira de palavra", numa expressão regular) como
 * o caractere de controle 0x08. No editor não aparece nada; a sintaxe
 * continua válida; e a expressão simplesmente nunca mais casa com nada.
 *
 * Da segunda vez, o estrago seria este: "recebo BPC" deixava de ir para uma
 * pessoa, e o robô passava a responder sozinho, por escrito, uma pergunta
 * sobre registro e benefício. Nenhum teste de comportamento aponta a causa —
 * só o sintoma. Este aponta a causa, em qualquer arquivo.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

const PASTA = dirname(fileURLToPath(import.meta.url))

// Tudo abaixo do espaço, menos tabulação, quebra de linha e retorno de carro.
const INVISIVEL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

const arquivos = readdirSync(PASTA).filter(n => n.endsWith('.js'))
ok('há arquivos para conferir', arquivos.length > 10)

for (const nome of arquivos) {
  const linhas = readFileSync(join(PASTA, nome), 'utf8').split('\n')
  const ruins = linhas
    .map((l, i) => (INVISIVEL.test(l) ? i + 1 : null))
    .filter(Boolean)
  ok(`${nome} sem caractere invisível${ruins.length ? ` (linhas ${ruins.join(', ')})` : ''}`, ruins.length === 0)
}

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
