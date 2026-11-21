/**
 * Transforma o texto do QR numa grade de quadradinhos ("1" escuro, "0"
 * claro), uma linha por string. O RH desenha a grade na tela — assim ele não
 * precisa de biblioteca de QR, e este robô usa a que já vem com o
 * qrcode-terminal.
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const QRCode = require('qrcode-terminal/vendor/QRCode')
const Nivel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel')

export function desenharQr(texto) {
  const qr = new QRCode(-1, Nivel.L)
  qr.addData(texto)
  qr.make()
  const n = qr.getModuleCount()
  const linhas = []
  for (let l = 0; l < n; l++) {
    let s = ''
    for (let c = 0; c < n; c++) s += qr.isDark(l, c) ? '1' : '0'
    linhas.push(s)
  }
  return linhas
}
