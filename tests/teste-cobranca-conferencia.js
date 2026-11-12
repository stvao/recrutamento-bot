/**
 * Cobrança de diário de obras e presença.
 *
 * O que se protege: desligada até alguém ligar; o ensaio não manda NADA para
 * a equipe; ninguém recebe duas vezes no mesmo dia, nem depois de reiniciar;
 * e quem foi cobrado e responde não cai na conversa de recrutamento.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  modoCobranca, destinoDoEnsaio, deveRodar, montarEnvios, textoDoEnsaio, rodar,
  foiCobradoRecentemente, estadoDoDia, buscarCobrancas, LIMITE_ENSAIO, RODAPE, CABECALHO,
} from '../src/cobranca-conferencia.js'

// 12/11/2026 é quinta. 9h em Brasília = 12h UTC.
const QUINTA_9H = new Date('2026-11-12T12:00:00Z')
const QUINTA_7H = new Date('2026-11-12T10:00:00Z')
const QUINTA_19H = new Date('2026-11-12T22:00:00Z')
const DOMINGO_9H = new Date('2026-11-15T12:00:00Z')
const SEGUNDA_9H = new Date('2026-11-16T12:00:00Z')

const RESPOSTA = {
  modo: 'diaria',
  mensagens: [
    { nome: 'Maria Eduarda', telefone: '5514999990001', texto: 'Olá, Maria. Ficou pendente…' },
    { nome: 'Ricardo', telefone: '5513999990002', texto: 'Olá, Ricardo. Ficou pendente…' },
    { nome: 'Sem número', telefone: null, texto: 'não vai' },
  ],
  gestores: [{ nome: 'Estevão', telefone: '5562981990765', texto: 'Atrasados há mais de 3 dias: …' }],
  semTelefone: [],
}

test('sem configuração, desligada', () => {
  assert.equal(modoCobranca({}), 'off')
  assert.equal(modoCobranca({ COBRAR_CONFERENCIA: 'sim' }), 'off')
  assert.equal(deveRodar({ agora: QUINTA_9H, env: {} }).rodar, false)
})

test('ensaio sem número para onde mandar não roda', () => {
  assert.equal(deveRodar({ agora: QUINTA_9H, env: { COBRAR_CONFERENCIA: 'ensaio' } }).rodar, false)
  assert.equal(destinoDoEnsaio({ CONFERENCIA_ENSAIO_PARA: '62981990765' }), '5562981990765')
})

test('só de manhã até as 18h, nunca no domingo, uma vez por dia', () => {
  const env = { COBRAR_CONFERENCIA: 'on' }
  assert.equal(deveRodar({ agora: QUINTA_9H, env }).rodar, true)
  assert.equal(deveRodar({ agora: QUINTA_7H, env }).rodar, false)
  assert.equal(deveRodar({ agora: QUINTA_19H, env }).rodar, false)
  assert.equal(deveRodar({ agora: DOMINGO_9H, env }).rodar, false)
  assert.equal(deveRodar({ agora: QUINTA_9H, env, estado: { dia: '2026-11-12', concluido: true } }).rodar, false)
  assert.equal(deveRodar({ agora: QUINTA_9H, env, estado: { dia: '2026-11-11', concluido: true } }).rodar, true)
})

test('semanal: só no dia combinado', () => {
  const env = { COBRAR_CONFERENCIA: 'on', CONFERENCIA_FREQUENCIA: 'semanal' }
  assert.equal(deveRodar({ agora: QUINTA_9H, env }).rodar, false)
  assert.equal(deveRodar({ agora: SEGUNDA_9H, env }).rodar, true)
})

test('ensaio: tudo para o dono, uma mensagem por pessoa, como ela receberia', () => {
  const envios = montarEnvios(RESPOSTA, { modo: 'ensaio', ensaioPara: '5562981990765', cabecalho: true })
  assert.equal(envios.length, 5) // abertura + Maria + Ricardo + quem não tem número + gestor
  assert.ok(envios.every(e => e.telefone === '5562981990765' && e.cobrado === false))
  assert.match(envios[0].texto, /Nada foi enviado para a equipe/)
  assert.match(envios[1].texto, /Iria para \*Maria Eduarda\* \(final 0001\)/)
  assert.ok(envios[1].texto.includes(CABECALHO + 'Olá, Maria. Ficou pendente…'))
  assert.match(envios[4].texto, /Estevão\* \(administrador\)/)
  assert.ok(envios.every(e => !e.texto.includes('5514999990001'))) // número inteiro não aparece
  assert.equal(new Set(envios.map(e => e.chave)).size, envios.length) // cada uma marcada à parte
})

test('ensaio sem nada a cobrar: silêncio', () => {
  assert.equal(textoDoEnsaio({ mensagens: [], gestores: [] }), null)
  assert.deepEqual(montarEnvios({ mensagens: [], gestores: [] }, { modo: 'ensaio', ensaioPara: '5562981990765' }), [])
})

test('ensaio grande é cortado e diz onde ver o resto', () => {
  const muitas = Array.from({ length: 40 }, (_, i) => ({ nome: `P${i}`, telefone: `55149999900${String(i).padStart(2, '0')}`, texto: 'x'.repeat(400) }))
  const t = textoDoEnsaio({ mensagens: muitas, gestores: [] })
  assert.ok(t.length <= LIMITE_ENSAIO + 200)
  assert.match(t, /e mais \d+\. Veja todas em Conferência diária/)
})

test('ligada: cada um recebe a sua, sem número não vai, texto não é reescrito', () => {
  const envios = montarEnvios(RESPOSTA, { modo: 'on' })
  assert.deepEqual(envios.map(e => e.telefone), ['5514999990001', '5513999990002', '5562981990765'])
  assert.equal(envios[0].texto, 'Olá, Maria. Ficou pendente…' + RODAPE)
  assert.deepEqual(envios.map(e => e.cobrado), [true, true, false])
})

function memoria(inicial = {}) {
  let salvo = inicial
  return { ler: () => salvo, gravar: (e) => { salvo = JSON.parse(JSON.stringify(e)) }, ver: () => salvo }
}

test('rodada: manda, marca, e não manda de novo no mesmo dia', async () => {
  const m = memoria()
  const enviados = []
  const enviar = async (tel, texto) => { enviados.push(tel); return { ok: true } }
  const env = { COBRAR_CONFERENCIA: 'on', OBRAS_INTEGRACAO_TOKEN: 'x' }
  const r = await rodar({ agora: QUINTA_9H, env, enviar, esperar: async () => {}, buscar: async () => RESPOSTA, ler: m.ler, gravar: m.gravar })
  assert.equal(r.enviados, 3)
  assert.equal(r.concluido, true)

  const deNovo = await rodar({ agora: QUINTA_9H, env, enviar, esperar: async () => {}, buscar: async () => RESPOSTA, ler: m.ler, gravar: m.gravar })
  assert.equal(deNovo.rodou, false)
  assert.equal(enviados.length, 3)
})

test('falha no meio: quem recebeu não recebe de novo; quem faltou recebe na próxima', async () => {
  const m = memoria()
  const enviados = []
  let cair = true
  const enviar = async (tel) => {
    if (tel === '5513999990002' && cair) return { ok: false }
    enviados.push(tel)
    return { ok: true }
  }
  const env = { COBRAR_CONFERENCIA: 'on' }
  const args = { agora: QUINTA_9H, env, enviar, esperar: async () => {}, buscar: async () => RESPOSTA, ler: m.ler, gravar: m.gravar }
  const r1 = await rodar(args)
  assert.equal(r1.concluido, false)
  cair = false
  const r2 = await rodar(args)
  assert.equal(r2.concluido, true)
  assert.deepEqual(enviados, ['5514999990001', '5562981990765', '5513999990002'])
})

test('ensaio não marca ninguém como cobrado', async () => {
  const m = memoria()
  const env = { COBRAR_CONFERENCIA: 'ensaio', CONFERENCIA_ENSAIO_PARA: '5562981990765' }
  await rodar({ agora: QUINTA_9H, env, enviar: async () => ({ ok: true }), esperar: async () => {}, buscar: async () => RESPOSTA, ler: m.ler, gravar: m.gravar })
  assert.deepEqual(m.ver().cobrados, {})
})

test('quem foi cobrado e responde é reconhecido, com ou sem o nono dígito', () => {
  const estado = { cobrados: { '5514999990001': QUINTA_9H.toISOString() } }
  assert.equal(foiCobradoRecentemente('5514999990001@s.whatsapp.net', estado, QUINTA_19H), true)
  assert.equal(foiCobradoRecentemente('551499990001', estado, QUINTA_19H), true)
  assert.equal(foiCobradoRecentemente('14999990001', estado, QUINTA_19H), true)
  assert.equal(foiCobradoRecentemente('5513999990002', estado, QUINTA_19H), false)
  const depois = new Date(QUINTA_9H.getTime() + 4 * 86_400_000)
  assert.equal(foiCobradoRecentemente('5514999990001', estado, depois), false)
})

test('dia novo zera os enviados e esquece cobrança velha', () => {
  const velho = { dia: '2026-11-07', concluido: true, enviados: ['equipe:1'], cobrados: { '5514999990001': '2026-11-07T12:00:00Z', '5513999990002': '2026-11-11T12:00:00Z' } }
  const e = estadoDoDia(velho, QUINTA_9H)
  assert.equal(e.dia, '2026-11-12')
  assert.deepEqual(e.enviados, [])
  assert.deepEqual(Object.keys(e.cobrados), ['5513999990002'])
})

test('do número do dono: abre dizendo que é aviso automático do sistema', () => {
  const envios = montarEnvios(RESPOSTA, { modo: 'on', cabecalho: true })
  assert.equal(envios[0].texto, CABECALHO + 'Olá, Maria. Ficou pendente…')
  assert.ok(envios[0].texto.startsWith('🤖 *Aviso automático — Sistema NovaGestão Obras*'))
  assert.ok(!envios[0].texto.includes(RODAPE))
})

test('busca: usa o token de integração, e falha vira null sem lançar', async () => {
  let chamada
  const ok = await buscarCobrancas('diaria', { OBRAS_INTEGRACAO_TOKEN: 'tok', OBRAS_API_URL: 'https://x' }, async (url, op) => {
    chamada = { url, op }
    return { ok: true, json: async () => RESPOSTA }
  })
  assert.equal(ok.mensagens.length, 3)
  assert.equal(chamada.url, 'https://x/api/integracao-rh/conferencia/cobrancas?modo=diaria')
  assert.equal(chamada.op.headers.Authorization, 'Bearer tok')
  assert.equal(await buscarCobrancas('diaria', {}, async () => { throw new Error('não chama') }), null)
  assert.equal(await buscarCobrancas('diaria', { OBRAS_INTEGRACAO_TOKEN: 't' }, async () => ({ ok: false, status: 401 })), null)
  assert.equal(await buscarCobrancas('diaria', { OBRAS_INTEGRACAO_TOKEN: 't' }, async () => { throw new Error('rede') }), null)
})
