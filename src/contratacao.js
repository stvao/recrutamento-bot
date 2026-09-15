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

/** O que dizer depois de receber um documento ou o PIX, com o que ainda falta. */
export function respostaDaPendencia({ faltam = [], pixFalta = false } = {}, recebido = 'recebi') {
  const itens = [...faltam.map(t => ROTULO[t] ?? t), ...(pixFalta ? ['sua chave pix'] : [])]
  if (!itens.length) return `${recebido}, obrigada. já tá tudo aqui, o rh vai conferir e te chama`
  return `${recebido}, obrigada. ainda falta: ${listaFalada(itens)}`
}
