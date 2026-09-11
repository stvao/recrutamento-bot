/**
 * De quem é a mensagem — e se é conversa com uma pessoa.
 *
 * O WhatsApp tem dois jeitos de endereçar alguém:
 *
 *   5511958267769@s.whatsapp.net   o telefone, como sempre foi
 *   238412339847203@lid            um identificador que ESCONDE o telefone
 *
 * O segundo passou a ser o padrão em boa parte das conversas. O robô só
 * aceitava o primeiro, e descartava o resto em silêncio: toda mensagem de
 * candidato que chegava como @lid morria no filtro, sem uma linha no log. O
 * grupo de comprovantes seguia funcionando — tem filtro próprio —, então
 * por fora parecia tudo bem, e o número recebia candidato o dia inteiro sem
 * que o robô visse nenhum.
 *
 * Aceitar o @lid não basta: o número serve para achar a pessoa no RH, para a
 * lista de autorizados e para o log. Por isso o telefone de verdade é
 * procurado, nesta ordem:
 *
 *   1. no campo alternativo que a própria mensagem traz (remoteJidAlt no
 *      privado, participantAlt no grupo) — o WhatsApp manda quando pode;
 *   2. no mapa @lid → telefone que a sessão vai montando;
 *   3. não achando, fica o identificador do @lid. A conversa segue — ele é
 *      estável e serve para lembrar onde ela parou —, mas avisa que o
 *      telefone é desconhecido, para ninguém tratá-lo como um.
 */

const PESSOA = '@s.whatsapp.net'
const LID = '@lid'

const ehTelefone = (jid) => typeof jid === 'string' && jid.endsWith(PESSOA)
const ehLid = (jid) => typeof jid === 'string' && jid.endsWith(LID)

/** "5511958267769:12@s.whatsapp.net" → "5511958267769". */
export function numeroDoJid(jid) {
  return (jid ?? '').split('@')[0].split(':')[0]
}

/**
 * É conversa privada com uma pessoa?
 *
 * Eco da própria resposta, grupo, status, lista de transmissão e canal não
 * são. Pessoa é tanto o endereço de telefone quanto o @lid.
 */
export function ehConversaPessoal(msg) {
  const jid = msg?.key?.remoteJid ?? ''
  if (msg?.key?.fromMe) return false
  return ehTelefone(jid) || ehLid(jid)
}

/**
 * Tipo de endereço que o robô não atende — para registrar, e não descartar
 * calado. Foi o silêncio que escondeu o defeito do @lid por dias.
 */
export function tipoIgnorado(msg) {
  const jid = msg?.key?.remoteJid ?? ''
  if (msg?.key?.fromMe) return null
  if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return null
  if (ehTelefone(jid) || ehLid(jid)) return null
  return jid.split('@')[1] || 'sem endereço'
}

/**
 * O telefone de quem escreveu.
 *
 * `grupo` diz se a mensagem veio de grupo: aí quem falou é o participante, e
 * não o chat. `lidMapping` é o mapa da sessão (sock.signalRepository.lidMapping);
 * sem ele, só os dois primeiros passos valem.
 *
 * Devolve { numero, telefoneConhecido }.
 */
export async function telefoneDe(msg, { grupo = false, lidMapping = null } = {}) {
  const key = msg?.key ?? {}
  const principal = grupo ? key.participant : key.remoteJid
  const alternativo = grupo ? key.participantAlt : key.remoteJidAlt

  if (ehTelefone(principal)) return { numero: numeroDoJid(principal), telefoneConhecido: true }
  if (ehTelefone(alternativo)) return { numero: numeroDoJid(alternativo), telefoneConhecido: true }

  if (ehLid(principal) && lidMapping?.getPNForLID) {
    try {
      const pn = await lidMapping.getPNForLID(principal)
      if (ehTelefone(pn)) return { numero: numeroDoJid(pn), telefoneConhecido: true }
    } catch {
      // Mapa indisponível não pode derrubar o atendimento: cai no passo 3.
    }
  }

  return { numero: numeroDoJid(principal ?? ''), telefoneConhecido: false }
}
