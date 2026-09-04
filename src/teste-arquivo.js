/**
 * O tamanho do arquivo que o robô aceita baixar.
 *
 * Este servidor tem 911 MB e divide a máquina com o sistema de RH. O
 * WhatsApp aceita documento de até 2 GB, e o download monta o arquivo INTEIRO
 * na memória antes de qualquer conferência — um PDF grande derrubaria os
 * dois serviços, e o RH não tem nada a ver com o assunto.
 *
 * As funções ficam dentro do módulo do WhatsApp, que só carrega com sessão
 * aberta. Então o teste repete aqui a MESMA regra e prova que o arquivo real
 * a contém — assim, mudar o limite no código sem mudar aqui quebra o teste.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let falhas = 0
function ok(nome, condicao) {
  if (condicao) {
    console.log(`ok  ${nome}`)
  } else {
    falhas++
    console.log(`FALHOU ${nome}`)
  }
}

const AQUI = dirname(fileURLToPath(import.meta.url))
const fonte = readFileSync(join(AQUI, 'baileys.js'), 'utf8')

// ── A regra existe no código ───────────────────────────────────────────
ok('o limite de tamanho está definido', /MAX_ARQUIVO_BYTES\s*=/.test(fonte))
ok('o limite é configurável', /GASTOS_MAX_ARQUIVO_MB/.test(fonte))

// ── Recusa ANTES de baixar ─────────────────────────────────────────────
//
// Conferir depois não adianta: o estrago na memória já aconteceu. Este é o
// ponto do conserto, e é o que o teste precisa garantir que não se perca.
ok('recusa pelo tamanho declarado, antes do download',
  /if \(tamanhoDeclarado > MAX_ARQUIVO_BYTES\)[\s\S]{0,400}?return null/.test(fonte))

const posDeclarado = fonte.indexOf('tamanhoDeclarado > MAX_ARQUIVO_BYTES')
const posDownload = fonte.indexOf('downloadMediaMessage(msg')
ok('a recusa vem ANTES da chamada de download',
  posDeclarado > 0 && posDownload > 0 && posDeclarado < posDownload)

// ── E confere de novo depois ───────────────────────────────────────────
//
// O tamanho declarado é só uma promessa de quem enviou.
ok('confere também o tamanho real', /buffer\.length > MAX_ARQUIVO_BYTES/.test(fonte))

// ── Só baixa o que serve ───────────────────────────────────────────────
ok('não baixa arquivo de quem não pode lançar', /const vaiServir = /.test(fonte))
ok('o download depende disso', /vaiServir \? await baixar\(/.test(fonte))

// Quem manda foto sem legenda no privado tem que receber resposta. Sem esta
// ordem, a foto do desconhecido deixaria de ser baixada E de ser respondida.
const posVaiServir = fonte.indexOf('const vaiServir =')
const posResposta = fonte.indexOf('Consigo ler s')
ok('a decisão vem antes da resposta padrão',
  posVaiServir > 0 && posResposta > 0 && posVaiServir < posResposta)

// ── O anexo carrega o tamanho ──────────────────────────────────────────
ok('imagem informa o tamanho', /imageMessage[\s\S]{0,200}?fileLength/.test(fonte))
ok('documento informa o tamanho', /documentMessage[\s\S]{0,600}?fileLength/.test(fonte))

// ── O limite tem um valor de gente ─────────────────────────────────────
//
// Alto demais não protege; baixo demais recusa comprovante de verdade.
const achado = /GASTOS_MAX_ARQUIVO_MB \|\| (\d+)/.exec(fonte)
ok('o padrão está entre 10 e 60 MB',
  achado && Number(achado[1]) >= 10 && Number(achado[1]) <= 60)

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
