/**
 * O que o robô NÃO pode dizer, num lugar só.
 *
 * Duas conversas usam esta barreira — a triagem de quem o sistema não conhece
 * e o atendimento de quem já trabalha aqui. As duas fazem a mesma pergunta:
 * "o modelo escreveu algo que não deveria sair daqui?".
 *
 * As regras moravam copiadas nos dois arquivos, e a cópia cobrou o preço de
 * sempre: elas divergiram. O atendimento ao funcionário passou a barrar
 * "bit.ly" e "código de acesso"; a triagem, não — e ninguém percebeu, porque
 * não havia um lugar onde a diferença ficasse visível.
 *
 * Pior: um mesmo conserto aplicado aos dois arquivos sem ler os dois quebrou
 * a triagem, e a barreira passou a lançar erro EXATAMENTE quando disparava.
 * Uma barreira que só falha quando tem trabalho a fazer é pior que barreira
 * nenhuma, porque ninguém sabe que ela não está lá.
 */

/**
 * Valor em dinheiro, inclusive escrito por extenso.
 *
 * "R$ 2.500" e "2500 reais" eram pegos; "dois mil reais" passava — e é
 * exatamente assim que um modelo de linguagem escreve, porque soa mais
 * natural. Salário dito no WhatsApp vira prova; a forma de escrever não muda
 * isso.
 */
const NUMERO_POR_EXTENSO = 'zero|um|uma|dois|duas|tr[êe]s|quatro|cinco|seis|sete|oito|nove|dez'
  + '|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito|dezenove'
  + '|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa'
  + '|cem|cento|duzentos|trezentos|quatrocentos|quinhentos|seiscentos|setecentos|oitocentos|novecentos'
  + '|mil|milh[ãa]o|milh[õo]es'

export const REGRAS = {
  /*
    Erra para o lado cauteloso, de propósito.

    Falso positivo aqui custa uma conversa passada para um humano. Falso
    negativo custa um salário dito por escrito no WhatsApp de um candidato,
    que vira prova. Por isso "mil" sozinho basta: em conversa de vaga, "mil"
    quase nunca aparece fora de dinheiro, e quando aparecer o preço é só um
    atendimento humano a mais.
  */
  valor: new RegExp(
    'R\\$\\s*\\d'                                   // R$ 2.500
    + '|\\d+\\s*(reais|mil reais)'                  // 2500 reais
    + `|(${NUMERO_POR_EXTENSO})\\s+(${NUMERO_POR_EXTENSO})?\\s*reais`  // dois mil reais
    + '|\\bmil\\b'                                  // mil e quinhentos
    + '|\\bsal[áa]rio\\s+(de|é|e)\\b',              // "o salário de..."
    'i',
  ),

  // bit.ly veio do atendimento ao funcionário e faltava na triagem.
  link: /https?:\/\/|www\.|\.com|\.br\/|bit\.ly/i,

  // "código de acesso" idem.
  senha: /senha|token|c[óo]digo de acesso/i,
}

/**
 * O que há de proibido nesta resposta.
 *
 * Devolve a lista de categorias encontradas — vazia quando a resposta pode
 * sair. A lista é o que vai para o log: o TEXTO nunca vai, porque está sendo
 * descartado justamente por conter isso, e escrevê-lo no arquivo de log só
 * mudaria o lugar do vazamento para um que é lido por mais gente e guardado
 * por mais tempo.
 */
export function proibidoEm(texto) {
  const r = String(texto ?? '')
  return Object.entries(REGRAS)
    .filter(([, regra]) => regra.test(r))
    .map(([nome]) => nome)
}
