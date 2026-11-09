import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formasDoNumero } from '../src/baileys.js'

test('celular digitado com o 9 também tenta sem o 9', () => {
  assert.deepEqual(formasDoNumero('(48) 99636-0367'), ['5548996360367', '554896360367'])
})
test('celular sem o 9 também tenta com o 9', () => {
  assert.deepEqual(formasDoNumero('554896360367'), ['554896360367', '5548996360367'])
})
test('fixo não ganha 9', () => {
  assert.deepEqual(formasDoNumero('1432631000'), ['551432631000'])
})
