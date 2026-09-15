/**
 * Teste rápido do cérebro (sem servidor, sem RH). Roda uma conversa de exemplo.
 *   node src/teste-conversa.js
 */
import { iniciar, responder } from '../src/brain.js'

const roteiro = [
  'vi o anuncio, tenho interesse',
  'quanto e o salario do pedreiro?',
  'pedreiro',
  'tem alojamento em itapevi?',
  'Buritama',
  'tem como me dar o vale transporte pra ir amanha?',
  'sim, tenho experiencia',
  'sim, ja tive registro',
  'Maria Aparecida Teste',
]

let r = iniciar('5514999990000')
console.log('🤖', r.resposta.split('\n')[0])
let estado = r.estado
for (const msg of roteiro) {
  console.log('\n👤', msg)
  r = responder(estado, msg)
  estado = r.estado
  console.log('🤖', r.resposta.split('\n')[0], r.escalarHumano ? '  [→ humano]' : '')
  if (r.acao?.tipo === 'criar_candidatura') {
    console.log('   ✅ CANDIDATURA:', JSON.stringify({
      nome: r.acao.dados.nomeCompleto, vaga: r.acao.dados.vagaPretendida,
      cidade: r.acao.dados.cidadePreferencia, exp: r.acao.dados.tempoExperiencia,
    }))
  }
}
