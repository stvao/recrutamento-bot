/**
 * Quem o robô atende — e quem ele NUNCA atende.
 *
 * A Maria Vitória conversa com CANDIDATO. Quem trabalha ou trabalhou na
 * empresa fala com gente, sempre.
 *
 * Duas travas, porque uma só não segura:
 *
 *  1. Quem está no RH como funcionário não recebe resposta automática.
 *  2. Quem MANDA MENSAGEM DE COBRANÇA também não — mesmo sem estar
 *     cadastrado. Em 12/09/2026 alguém que trabalhou e não recebeu mandou 64
 *     mensagens de madrugada perguntando por que só o colega tinha sido
 *     pago. Essa pessoa não estava no cadastro; para o robô ela seria uma
 *     desconhecida, e a resposta teria sido "para qual vaga você procura?".
 *
 * A segunda trava reconhece a conversa pelo que ela diz, e é conservadora de
 * propósito: exige primeira pessoa ou passado ("não recebi", "meu
 * pagamento", "trabalhei"). "Quanto paga?" e "tem vale-transporte?" são
 * perguntas de candidato e continuam sendo atendidas.
 */
import { norm } from './texto.js'

/** O robô responde quem já trabalha na empresa? Por padrão, NÃO. */
export const atendeFuncionario = () => (process.env.ATENDER_FUNCIONARIO ?? 'off').toLowerCase() === 'on'

/*
  Cada linha é uma forma de dizer "vocês me devem" ou "eu trabalhei aí".

  Sem "quando recebo" nem "quando cai o pagamento": essas são perguntas de
  candidato sobre o dia do pagamento, e o robô sabe responder.
*/
const COBRANCA = [
  'nao recebi', 'nao recebemos', 'nao me pagaram', 'nao pagaram', 'nao caiu',
  'nao foi pago', 'nao vou receber', 'vou receber algo', 'vou receber nada',
  'meu pagamento', 'meu dinheiro', 'meu salario', 'meu vale', 'meu acerto',
  'meu deposito', 'meu pix', 'minha diaria', 'minhas diarias',
  'meu dia de trabalho', 'me paguem', 'estao devendo', 'ta devendo',
  'esta devendo', 'devendo meu', 'fui demitido',
  'fui demitida', 'fui mandado embora', 'me mandaram embora', 'rescisao',
  'verbas rescisorias', 'meu acerto', 'meu ultimo dia',
  // Do caso real: "so o dinheiro do Renato vai cair hj?" e "fui o unico que
  // nao recebeu nada". Falam de dinheiro de OUTRA pessoa e de quem ja
  // trabalhou — nenhum candidato escreve assim.
  'dinheiro do', 'vai cair hj', 'vai cair hoje', 'vai cair ainda', 'cair algo',
  'recebeu nada', 'recebi nada', 'unico que nao',
]

/*
  Palavras que o CANDIDATO também usa, e que por isso não bastam sozinhas.

  "trabalhei 5 anos de pedreiro com carteira" e "quanto vocês vão me pagar por
  dia?" eram lidas como cobrança: o robô ficava mudo no meio do cadastro,
  marcava a conversa como escalada (o lembrete de 24h nunca saía) e mandava ao
  RH um alerta de cobrança sobre um candidato comum. E é o próprio robô que
  pergunta pela última obra e pela experiência.

  "trabalhei"/"trabalhamos"/"meus dias" só contam como cobrança quando a
  mensagem TAMBÉM fala de dinheiro; "me pagar" só nas frases de cobrança.
*/
const SO_COM_DINHEIRO = ['trabalhei', 'trabalhamos', 'meus dias']
// Com fronteira de palavra: sem ela, "carteira assiNADA" casava com "nada", e
// "trabalhei 5 anos de pedreiro com carteira assinada" virava cobrança.
const FALA_DE_DINHEIRO = /\bnao receb|\bnao pag|\bnao caiu|\bnada\b|\bdinheiro\b|\bacerto\b|\bpagament|\bpix\b|\bdevendo\b|\bdeposit|\bsalario\b|\bdiaria|semana passada|mes passado/
const FRASES_DE_COBRANCA = [
  'quando vao me pagar', 'quando voces vao me pagar', 'quando vai me pagar',
  'nao vao me pagar', 'nao vai me pagar', 'vao me pagar ou', 'falta me pagar',
  'tem que me pagar', 'preciso que me pague',
]

/**
 * Isto é cobrança de quem trabalhou, e não pergunta de candidato?
 *
 * Comparação exata sobre o texto normalizado: aqui uma letra muda o sentido,
 * e a tolerância a erro de digitação do resto do robô confundiria "meu
 * salario" com "qual salario".
 */
export function ehCobranca(texto) {
  const t = norm(texto ?? '')
  if (!t) return false
  if (COBRANCA.some(termo => t.includes(termo))) return true
  // "trabalhei" só é cobrança junto de dinheiro.
  if (SO_COM_DINHEIRO.some(termo => t.includes(termo)) && FALA_DE_DINHEIRO.test(t)) return true
  return FRASES_DE_COBRANCA.some(termo => t.includes(termo))
}

/**
 * O que fazer com esta mensagem.
 *
 * Devolve { atender, motivo } — `motivo` vai para o log e para o alerta do
 * RH, para alguém saber que a pessoa está esperando.
 */
export function decidir({ texto, ficha }) {
  if (ehCobranca(texto)) {
    return { atender: false, motivo: 'cobrança de pagamento — nunca por robô' }
  }
  if (ficha?.tipo === 'funcionario' && !atendeFuncionario()) {
    return { atender: false, motivo: 'é funcionário da empresa' }
  }
  return { atender: true, motivo: null }
}
