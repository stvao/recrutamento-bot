/**
 * De quem é a mensagem.
 *
 * O caso que motivou este arquivo: o WhatsApp passou a endereçar boa parte
 * das conversas por @lid, que esconde o telefone, e o robô só aceitava o
 * endereço de telefone. Toda mensagem de candidato morria no filtro, calada,
 * enquanto o grupo de comprovantes seguia funcionando.
 */
import { ehConversaPessoal, tipoIgnorado, telefoneDe, numeroDoJid } from './endereco.js'

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

const privado = (remoteJid, extra = {}) => ({ key: { remoteJid, fromMe: false, ...extra } })
const deGrupo = (participant, extra = {}) => ({
  key: { remoteJid: '120363413147794205@g.us', participant, fromMe: false, ...extra },
})

// Um mapa como o da sessão: sabe um @lid, não sabe outro.
const mapa = {
  async getPNForLID(lid) {
    return lid === '238412339847203@lid' ? '5511912345678:0@s.whatsapp.net' : null
  },
}

// ── O defeito: @lid é conversa pessoal ─────────────────────────────────
ok('@lid é conversa com pessoa', ehConversaPessoal(privado('238412339847203@lid')))
ok('telefone continua sendo', ehConversaPessoal(privado('5511912345678@s.whatsapp.net')))

// ── E o que não é, continua não sendo ──────────────────────────────────
ok('grupo não é conversa pessoal', !ehConversaPessoal(privado('120363413147794205@g.us')))
ok('status não é', !ehConversaPessoal(privado('status@broadcast')))
ok('canal não é', !ehConversaPessoal(privado('123@newsletter')))
ok('eco da própria resposta não é',
  !ehConversaPessoal({ key: { remoteJid: '238412339847203@lid', fromMe: true } }))

// ── Tipo desconhecido é registrado, não engolido ───────────────────────
ok('@lid não é "ignorado"', tipoIgnorado(privado('238412339847203@lid')) === null)
ok('grupo não é "ignorado"', tipoIgnorado(privado('1@g.us')) === null)
ok('um formato novo aparece no log', tipoIgnorado(privado('999@algo.novo')) === 'algo.novo')

// ── O telefone, pelos três caminhos ────────────────────────────────────
{
  const r = await telefoneDe(privado('5511912345678@s.whatsapp.net'))
  ok('telefone direto', r.numero === '5511912345678' && r.telefoneConhecido)
}
{
  const r = await telefoneDe(privado('238412339847203@lid', { remoteJidAlt: '5511912345678@s.whatsapp.net' }))
  ok('@lid com o telefone no campo alternativo', r.numero === '5511912345678' && r.telefoneConhecido)
}
{
  const r = await telefoneDe(privado('238412339847203@lid'), { lidMapping: mapa })
  ok('@lid resolvido pelo mapa da sessão', r.numero === '5511912345678' && r.telefoneConhecido)
}
{
  const r = await telefoneDe(privado('555000111222333@lid'), { lidMapping: mapa })
  ok('@lid sem telefone: conversa segue pelo identificador', r.numero === '555000111222333')
  ok('e avisa que o telefone é desconhecido', r.telefoneConhecido === false)
}
{
  const quebrado = { async getPNForLID() { throw new Error('mapa fora') } }
  const r = await telefoneDe(privado('238412339847203@lid'), { lidMapping: quebrado })
  ok('mapa quebrado não derruba o atendimento', r.numero === '238412339847203' && !r.telefoneConhecido)
}

// ── No grupo, quem falou é o participante ──────────────────────────────
//
// A lista de autorizados a lançar compara com o telefone. Participante como
// @lid, sem isto, faria um autorizado deixar de ser reconhecido.
{
  const r = await telefoneDe(deGrupo('238412339847203@lid', { participantAlt: '5511912345678@s.whatsapp.net' }), { grupo: true })
  ok('participante @lid com telefone alternativo', r.numero === '5511912345678' && r.telefoneConhecido)
}
{
  const r = await telefoneDe(deGrupo('5511912345678@s.whatsapp.net'), { grupo: true })
  ok('participante com telefone direto', r.numero === '5511912345678')
}
{
  const r = await telefoneDe(deGrupo('238412339847203@lid'), { grupo: true, lidMapping: mapa })
  ok('participante @lid pelo mapa', r.numero === '5511912345678')
}

// ── Bordas ─────────────────────────────────────────────────────────────
ok('tira o sufixo de aparelho', numeroDoJid('5511912345678:12@s.whatsapp.net') === '5511912345678')
ok('mensagem vazia não quebra', !ehConversaPessoal({}) && (await telefoneDe({})).numero === '')

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
