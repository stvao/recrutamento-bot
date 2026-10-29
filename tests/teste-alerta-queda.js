// Aviso de queda do WhatsApp: quando manda e quando fica quieto.
import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.ALERTA_TELEGRAM_TOKEN = 'teste'
process.env.ALERTA_TELEGRAM_CHAT = '123'

const enviados = []
globalThis.fetch = async (_url, op) => {
  enviados.push(JSON.parse(op.body).text)
  return { json: async () => ({ ok: true }) }
}

const { whatsappCaiu, whatsappConectou, _zerar, alertaConfigurado } = await import('../src/alerta-queda.js')
const esperar = (ms) => new Promise(r => setTimeout(r, ms))

test('configurado pelo .env', () => {
  assert.equal(alertaConfigurado(), true)
})

test('aparelho removido avisa na hora, pedindo o QR', async () => {
  _zerar(); enviados.length = 0
  whatsappCaiu({ motivo: 401, precisaQr: true })
  await esperar(20)
  assert.equal(enviados.length, 1)
  assert.match(enviados[0], /DESCONECTADO/)
  assert.match(enviados[0], /Conectar aparelho/)
})

test('queda curta que volta sozinha não gera mensagem', async () => {
  _zerar(); enviados.length = 0
  whatsappCaiu({ motivo: 515 })
  whatsappConectou('5511999999999')
  await esperar(20)
  assert.equal(enviados.length, 0)
})

test('depois de avisar a queda, avisa que voltou', async () => {
  _zerar(); enviados.length = 0
  whatsappCaiu({ motivo: 401, precisaQr: true })
  await esperar(10)
  whatsappConectou('5511958267769')
  await esperar(20)
  assert.equal(enviados.length, 2)
  assert.match(enviados[1], /voltou/)
  _zerar()
})
