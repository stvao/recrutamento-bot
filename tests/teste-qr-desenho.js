/** A grade do QR que o RH desenha: quadrada, só 0 e 1, com os três cantos. */
import { desenharQr } from '../src/qr-desenho.js'
let falhas = 0
const ok = (n, c) => { if (c) console.log(`ok  ${n}`); else { falhas++; console.log(`FALHOU ${n}`) } }
const g = desenharQr('2@AbCdEfGhIjKlMnOpQrStUvWxYz0123456789,chave+base64/abc==,outra+chave/def==,id==')
ok('é quadrada', g.length > 20 && g.every(l => l.length === g.length))
ok('só 0 e 1', g.every(l => /^[01]+$/.test(l)))
const canto = (l0, c0) => [0, 1, 2, 3, 4, 5, 6].every(i => g[l0][c0 + i] === '1' && g[l0 + 6][c0 + i] === '1' && g[l0 + i][c0] === '1' && g[l0 + i][c0 + 6] === '1')
ok('tem os três cantos de mira', canto(0, 0) && canto(0, g.length - 7) && canto(g.length - 7, 0))
ok('textos diferentes dão grades diferentes', desenharQr('a').join() !== desenharQr('b').join())
console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo'); process.exit(falhas ? 1 : 0)
