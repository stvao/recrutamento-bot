/**
 * A fase depois da aprovação: documentos e chave PIX pedidos pelo RH.
 *
 * O RH marca na ficha o que precisa e o robô pede no WhatsApp. O que chega
 * vai para a candidatura; a chave PIX fica "a confirmar" até alguém do RH
 * olhar — trocar a chave de pagamento de alguém sem conferência é o golpe
 * que a confirmação evita.
 */
import { cpfValido } from './ia-documento.js'

const ROTULO = {
  rg: 'RG', cpf: 'CPF', ctps: 'carteira de trabalho', comprovante_residencia: 'comprovante de endereço',
  pis: 'PIS', titulo_eleitor: 'título de eleitor', reservista: 'reservista',
  certidao: 'certidão de nascimento ou casamento', foto3x4: 'foto 3x4', cnh: 'CNH',
}

export function listaFalada(itens) {
  if (itens.length <= 1) return itens[0] ?? ''
  return `${itens.slice(0, -1).join(', ')} e ${itens[itens.length - 1]}`
}

/**
 * A chave PIX escrita na mensagem, se houver.
 *
 * E-mail, CPF válido, CNPJ, telefone ou chave aleatória. Número solto que não
 * fecha nenhum formato não vira chave: melhor perguntar de novo do que pagar
 * no lugar errado.
 */
export function chavePixNoTexto(texto) {
  const t = String(texto ?? '')
  const email = t.match(/[\w.+-]+@[\w-]+\.[\w.]+/)
  if (email) return email[0].toLowerCase()
  const aleatoria = t.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)
  if (aleatoria) return aleatoria[0].toLowerCase()
  for (const bruto of t.match(/\+?[\d][\d.\-/() ]{9,20}\d/g) ?? []) {
    const d = bruto.replace(/\D/g, '')
    if (d.length === 11 && cpfValido(d)) return d
    if (d.length === 14) return d
    const tel = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d
    if ((tel.length === 11 && tel[2] === '9') || tel.length === 10) return `+55${tel}`
  }
  return null
}

/**
 * A mensagem é a CHAVE, e não uma frase que por acaso tem número?
 *
 * chavePixNoTexto pega o primeiro telefone, CPF ou e-mail que encontra. Sem
 * esta pergunta, "se não me achar liga no 14 99812-3456 que é da minha
 * esposa" virava chave PIX, e "meu cpf é ..." (quando o RH pediu o CPF como
 * documento) virava chave também — por cima de uma chave que o RH já tinha
 * conferido.
 *
 * Vale quando a pessoa fala "pix", ou quando o que sobra da mensagem, tirando
 * as palavras de recheio, é só a chave.
 */
const RECHEIO = /\b(meu|minha|meus|minhas|o|a|e|eh|[ée]|chave|pix|numero|n[úu]mero|do|da|de|banco|conta|nubank|caixa|itau|ita[úu]|bradesco|santander|inter|pode|anota|anotar|ai|a[íi]|t[áa]|tudo|bem|obrigado|obrigada|por|favor|sim|ok)\b/gi

export function mensagemEhChavePix(texto) {
  const t = String(texto ?? '')
  if (!t.trim()) return false
  if (/\bpix\b/i.test(t)) return true
  /*
    Falando de DOCUMENTO, não é chave.

    O RH pede o CPF como documento na mesma conversa, e "meu cpf é ..." virava
    chave de pagamento — por cima da chave que o RH já tinha conferido.
  */
  if (/\b(cpf|rg|documento|documentos|carteira|pis|titulo|t[íi]tulo|reservista|certidao|certid[ãa]o)\b/i.test(t)) return false
  const chave = chavePixNoTexto(t)
  if (!chave) return false
  const sobra = t.replace(RECHEIO, ' ').replace(/[^\w@.+-]+/g, ' ').replace(/\s+/g, ' ').trim()
  // Sobrou só a chave (ou quase): no máximo duas "palavras" além dela.
  return sobra.split(' ').filter(Boolean).length <= 2
}

/** O que dizer depois de receber um documento ou o PIX, com o que ainda falta. */
export function respostaDaPendencia({ faltam = [], pixFalta = false } = {}, recebido = 'recebi') {
  const itens = [...faltam.map(t => ROTULO[t] ?? t), ...(pixFalta ? ['sua chave pix'] : [])]
  if (!itens.length) return `${recebido}, obrigada. já tá tudo aqui, o rh vai conferir e te chama`
  return `${recebido}, obrigada. ainda falta: ${listaFalada(itens)}`
}
