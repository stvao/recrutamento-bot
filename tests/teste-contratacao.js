/**
 * Mensagem para quem parou, documentos guardados em disco, e a fase de
 * contratação (documentos e PIX pedidos pelo RH).
 */
import { readFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.ESTADO_ARQUIVO = join(mkdtempSync(join(tmpdir(), 'contratacao-')), 'conversas.json')
process.env.DOCUMENTOS_GUARDADOS_DIR = mkdtempSync(join(tmpdir(), 'guardados-'))

const lembrete = await import('../src/lembrete-cadastro.js')
const guardados = await import('../src/documentos-guardados.js')
const { chavePixNoTexto, respostaDaPendencia } = await import('../src/contratacao.js')

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

const HORA = 3600_000
const agora = Date.now()
const parado = (horas, estado = {}, extra = {}) => ({
  estado: { modo: 'ia', vaga: 'Pedreiro', historico: [{ de: 'pessoa', texto: 'sou pedreiro' }, { de: 'maria', texto: 'qual cidade vc mora?' }], ...estado },
  atualizadoEm: agora - horas * HORA,
  ...extra,
})
const decide = (s, o = {}) => lembrete.decidir(s, { agora, comercial: true, ...o })

// ── A mensagem para quem parou ─────────────────────────────────────────
ok('parado há 25h, ficha incompleta: lembra', decide(parado(25)).lembrar)
ok('texto aprovado, com a vaga', lembrete.texto({ vaga: 'Pedreiro' }) === 'oi, tudo bem? vi que a gente não terminou seu cadastro pra vaga de pedreiro. se ainda tiver interesse é só me responder aqui')
ok('sem vaga, sem "pra vaga de"', !/pra vaga/.test(lembrete.texto({})))
ok('antes de 24h: não', !decide(parado(20)).lembrar)
ok('depois de 72h: não', !decide(parado(80)).lembrar)
ok('uma vez só', !decide(parado(30, { lembradoEm: agora - HORA })).lembrar)
ok('fora do horário comercial: não', !decide(parado(25), { comercial: false }).lembrar)
ok('com atendimento humano (cobrança, pediu gente): não', !decide(parado(25, {}, { escalouEm: agora })).lembrar)
ok('pessoa da empresa atendendo: não', !decide(parado(25), { atendidaPorGente: true }).lembrar)
ok('disse que responde depois: não', !decide(parado(25, { historico: [{ de: 'pessoa', texto: 'to trabalhando agora, respondo depois' }, { de: 'maria', texto: 'tranquilo' }] })).lembrar)
ok('última mensagem foi da pessoa: não', !decide(parado(25, { historico: [{ de: 'maria', texto: 'qual cidade?' }, { de: 'pessoa', texto: 'bastos' }] })).lembrar)
ok('triagem ou funcionário: não', !decide(parado(25, { modo: 'triagem' })).lembrar)
{
  const completa = {
    vaga: 'Pedreiro', cidadeMora: 'Bastos', cidade: 'Bastos', nome: 'Carlos Alberto', temExperiencia: true, temRegistro: true,
    dataNascimento: 'x', disponibilidadeInicio: 'já', aceitaOutrasObras: 'sim', tamanhoCamisa: 'M', tamanhoBota: '41', contatoRecadoNome: 'Manu',
  }
  ok('ficha completa: não', !decide(parado(25, completa)).lembrar)
}
{
  // Domingo 10h e segunda 10h em Brasília (13h UTC).
  ok('domingo não é comercial', !lembrete.horarioComercial(new Date('2026-09-13T13:00:00Z')))
  ok('segunda 10h é comercial', lembrete.horarioComercial(new Date('2026-09-14T13:00:00Z')))
  ok('segunda 22h não é', !lembrete.horarioComercial(new Date('2026-09-15T01:00:00Z')))
}

// ── Documentos guardados em disco ──────────────────────────────────────
{
  const doc = { tipo: 'curriculo', nome: 'cv.pdf', arquivo: Buffer.from('%PDF-1.4 teste'), extraido: { tipo: 'curriculo' } }
  ok('guarda em disco', guardados.guardar('5511999990000', doc) && guardados.quantos() === 1)
  const volta = guardados.retirar('5511999990000')
  ok('retira o mesmo arquivo', volta.length === 1 && volta[0].arquivo.toString() === '%PDF-1.4 teste' && volta[0].tipo === 'curriculo')
  ok('e apaga do disco', guardados.quantos() === 0)
  guardados.guardar('5511888880000', doc, agora - 25 * HORA)
  ok('passou de 24h: some na limpeza', guardados.limpar(agora) === 1)
  for (let i = 0; i < 5; i++) guardados.guardar('5511777770000', doc, agora + i)
  ok('no máximo 3 por pessoa', guardados.quantos() === guardados.MAX_POR_PESSOA)
  guardados.retirar('5511777770000')
}

// ── Chave PIX ──────────────────────────────────────────────────────────
ok('PIX e-mail', chavePixNoTexto('meu pix é Joao.Silva@gmail.com') === 'joao.silva@gmail.com')
ok('PIX CPF válido', chavePixNoTexto('pix 529.982.247-25') === '52998224725')
ok('PIX celular', chavePixNoTexto('é o número (11) 95826-7769') === '+5511958267769')
ok('PIX aleatória', chavePixNoTexto('123e4567-e89b-12d3-a456-426614174000') === '123e4567-e89b-12d3-a456-426614174000')
ok('frase sem chave: nada', chavePixNoTexto('já mandei os documentos') === null)
ok('número solto que não fecha formato: nada', chavePixNoTexto('3500') === null)

ok('resposta com o que falta', respostaDaPendencia({ faltam: ['pis'], pixFalta: true }) === 'recebi, obrigada. ainda falta: PIS e sua chave pix')
ok('resposta quando está tudo', /já tá tudo aqui/.test(respostaDaPendencia({})))

// ── Resumo do recrutamento às 8h ───────────────────────────────────────
{
  process.env.RESUMO_RECRUTAMENTO_ARQUIVO = join(mkdtempSync(join(tmpdir(), 'resumo-')), 'r.json')
  const rr = await import('../src/resumo-recrutamento.js')
  delete process.env.RESUMO_RECRUTAMENTO_PARA
  ok('sem número configurado: não manda', !rr.deveEnviar(new Date('2026-09-15T12:00:00Z')))
  process.env.RESUMO_RECRUTAMENTO_PARA = '5511999998888'
  ok('antes das 8h: não', !rr.deveEnviar(new Date('2026-09-15T10:00:00Z')))
  ok('às 9h: manda', rr.deveEnviar(new Date('2026-09-15T12:00:00Z')))
  rr.marcarEnviado(new Date('2026-09-15T12:00:00Z'))
  ok('uma vez por dia', !rr.deveEnviar(new Date('2026-09-15T15:00:00Z')))
  ok('no dia seguinte, de novo', rr.deveEnviar(new Date('2026-09-16T12:00:00Z')))
  delete process.env.RESUMO_RECRUTAMENTO_PARA
}

// ── A ligação ──────────────────────────────────────────────────────────
{
  const aqui = dirname(fileURLToPath(import.meta.url))
  const sv = readFileSync(join(aqui, '..', 'src', 'server.js'), 'utf8')
  const st = readFileSync(join(aqui, '..', 'src', 'store.js'), 'utf8')
  ok('o RH pede documentos pelo robô', /app\.post\('\/enviar-pedido'/.test(sv))
  ok('  e o pedido exige autorização', /'\/enviar-pedido', async \(req, res\) => \{\s+if \(!simuladorAutorizado\(req\)\)/.test(sv))
  ok('aprovado com pedido tem atendimento próprio', /atenderAprovado\(msg, ficha\)/.test(sv))
  ok('lembrete de cadastro agendado', /lembrete\.decidir\(/.test(sv))
  ok('resumo do recrutamento agendado', /rodarResumoRecrutamento/.test(sv))
  ok('lembrete de documentos agendado', /quemLembrarDocumentos\(\)/.test(sv))
  ok('o lembrete não reinicia o relógio da conversa', /export function marcarLembrado/.test(st) && !/marcarLembrado[\s\S]{0,400}atualizadoEm: Date\.now\(\)/.test(st))
  ok('documento guardado agora é em disco', /guardados\.guardar\(/.test(sv) && !/const documentosGuardados = new Map/.test(sv))
}

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
