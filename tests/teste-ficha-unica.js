/**
 * Uma ficha por pessoa, e a conversa lembrada.
 *
 * Medido em 16/09/2026: 308 fichas no RH, 41 pessoas com 99 delas. Quem
 * voltava depois de 12 horas virava ficha nova e ouvia tudo de novo.
 */
import { readFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.ESTADO_ARQUIVO = join(mkdtempSync(join(tmpdir(), 'ficha-')), 'conversas.json')

const { estadoDaFicha, paradoHaDaFicha } = await import('../src/ficha-rh.js')
const { oQueJaSabe } = await import('../src/atendimento.js')

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

const resposta = {
  tem: true,
  protocolo: 'WZ20260901-1030',
  ultimaConversaEm: '2026-09-14T12:00:00.000Z',
  ficha: {
    nome: 'João Silva', vaga: 'Pedreiro', cidade: 'Bastos', cidadeMora: 'Bastos',
    tempoExperiencia: '9 anos', temExperiencia: true, temRegistro: true,
    dataNascimento: '1990-01-01', aceitaOutrasObras: 'Sim', especialidade: 'Alvenaria',
    temCpf: true, temRg: false,
  },
  conversa: [{ de: 'pessoa', texto: 'sou pedreiro' }, { de: 'maria', texto: 'qual cidade vc mora?' }],
}

// ── A ficha do RH vira o começo da conversa ────────────────────────────
{
  const e = estadoDaFicha(resposta, { modo: 'ia', whatsapp: '5514999990000' })
  ok('traz a vaga e a cidade', e.vaga === 'Pedreiro' && e.cidade === 'Bastos')
  ok('traz o nome', e.nome === 'João Silva')
  ok('experiência e registro viram sim/não', e.temExperiencia === true && e.temRegistro === true)
  ok('aceita outras obras vira "sim"', e.aceitaOutrasObras === 'sim')
  ok('marca que a ficha já está registrada', e.registrado === true && e.protocolo === 'WZ20260901-1030')
  ok('traz a conversa anterior', e.historico.length === 2 && e.historico[0].texto === 'sou pedreiro')
  ok('o CPF entra como marca, nunca o número', e.cpfJaInformado === true && e.cpf === undefined)
  ok('sem ficha no RH, não inventa estado', estadoDaFicha({ tem: false }, {}) === null)
  ok('resposta quebrada não quebra', estadoDaFicha(null, {}) === null)

  const sabe = oQueJaSabe(e)
  ok('o robô não pergunta a vaga de novo', !sabe.falta.includes('qual vaga interessa'))
  ok('nem o nome', !sabe.falta.includes('o nome completo'))
  ok('sabe que o CPF já foi informado', sabe.sabido.includes('CPF: já informado'))
  ok('e o número do CPF não vai para o modelo', !/\d{11}/.test(sabe.texto))
  ok('ainda pergunta o que falta', sabe.falta.length > 0)
}

// ── Quanto tempo a pessoa sumiu ────────────────────────────────────────
{
  const agora = Date.parse('2026-09-16T12:00:00.000Z')
  ok('dois dias parada', paradoHaDaFicha(resposta, agora) === 2 * 24 * 3600_000)
  ok('sem data, null', paradoHaDaFicha({ tem: true }, agora) === null)
}

// ── A ligação ──────────────────────────────────────────────────────────
{
  const aqui = dirname(fileURLToPath(import.meta.url))
  const sv = readFileSync(join(aqui, '..', 'src', 'server.js'), 'utf8')
  const rc = readFileSync(join(aqui, '..', 'src', 'rh-client.js'), 'utf8')
  ok('quem volta carrega a ficha do RH', /const doRH = await fichaDoCandidato\(msg\.de\)/.test(sv))
  ok('  e a conversa continua de onde parou', /paradoHa: paradoHaDaFicha\(doRH\)/.test(sv))
  ok('o cliente do RH busca a ficha', /export async function fichaDoCandidato/.test(rc))
  ok('nenhum caractere invisível entrou', ![sv, rc].some(t => t.includes(String.fromCharCode(8))))
}

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
