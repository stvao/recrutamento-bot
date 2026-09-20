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

/*
  ── A barreira da CONVERSA DE RECRUTAMENTO ────────────────────────────────

  A triagem e o atendimento ao funcionário passavam por proibidoEm(); a
  conversa da Maria Vitória, não — e é justamente a que fica no celular da
  pessoa, mensagem por mensagem, por meses. As regras do dono viviam só como
  instrução no prompt, e instrução não é garantia: com o modelo devolvendo
  "vc começa sem registro e a gente registra depois dos 90 dias. me passa seu
  pix e o numero do pis", a frase saía inteira para o candidato.

  As regras daqui miram a AFIRMAÇÃO, não o assunto. Barrar o assunto barraria
  o robô fazendo o que deve: ele PRECISA perguntar "já teve registro em
  carteira?" e PRECISA dizer que a passagem é reembolsada na chegada.

  REGRAS.valor NÃO entra: recrutamento informa salário, esse é o trabalho.
*/

/** A resposta fala de registro em carteira? */
function falaDeRegistro(t) {
  return /registr|carteira|assinad|fichad|\bclt\b/i.test(t)
}

/**
 * ...e diz QUANDO o registro acontece?
 *
 * Regra do dono: o robô nunca diz quando a carteira é assinada, nem que
 * alguém começa sem registro. "Já teve registro em carteira nessa função?" é
 * pergunta legítima e não casa com nenhum destes.
 */
const QUANDO_REGISTRA = [
  /come[çc]a\w*\s+sem\s+(registro|carteira)/i,
  /trabalha\w*\s+sem\s+(registro|carteira)/i,
  /sem\s+(registro|carteira)\s+(no|nos|na|nas|por|durante|os)\b/i,
  /(registr|assin|fich)\w*\s+(a\s+carteira\s+|te\s+|vc\s+|voc[êe]\s+)?(s[óo]\s+)?(depois|ap[óo]s)\b/i,
  /(carteira|registro)\s+(vem|sai|fica|[ée]|s[óo])\s+(depois|ap[óo]s)/i,
  /(depois|ap[óo]s)\s+d[eo]s?\s+\d+\s*(dias?|m[êe]s|meses|semanas?)/i,
]

/**
 * Pede dado bancário, PIS ou senha.
 *
 * Regra do dono: nada de PIS nem conta bancária por chat, e PIX só depois de
 * aprovado — o que é outro caminho no servidor (atenderAprovado), que não
 * passa por aqui. Na conversa de recrutamento, nenhum dos dois tem o que
 * fazer.
 */
const DADO_BANCARIO = new RegExp(
  '\\b(pis|pasep|nit)\\b'
  + '|\\bpix\\b'
  + '|conta\\s+(banc[áa]ria|corrente|poupan[çc]a)'
  + '|\\bag[êe]ncia\\b'
  + '|\\b(senha|token)\\b',
  'i',
)

/**
 * Promete adiantar a passagem.
 *
 * A regra é: a empresa NÃO adianta, e reembolsa quando a pessoa chega na
 * obra. A resposta certa fala de passagem e de adiantar — por isso o que se
 * procura é a PROMESSA, e ela é descartada quando vem negada.
 */
const PROMESSAS_DE_PASSAGEM = [
  /(vou|vamos|posso|podemos|a gente vai|a empresa vai)\s+(te\s+)?adiantar/i,
  /(mando|mandamos|envio|enviamos|compro|compramos|pago|pagamos)\s+(a\s+|sua\s+|tua\s+)?passagem/i,
  /(a gente|a empresa|n[óo]s)\s+(manda|envia|compra|paga)\s+(a\s+|sua\s+|tua\s+)?passagem/i,
]

function prometePassagem(t) {
  return PROMESSAS_DE_PASSAGEM.some((re) => {
    const achado = re.exec(t)
    if (!achado) return false
    const antes = t.slice(Math.max(0, achado.index - 25), achado.index)
    return !/\bn[ãa]o\b|\bnunca\b|\bnem\b/i.test(antes)
  })
}

/** O que a Maria Vitória diz quando a resposta dela foi barrada. */
export const FRASE_SEGURA =
  'deixa eu chamar aqui uma pessoa da equipe pra falar com você sobre isso, só um minutinho'

/**
 * O que há de proibido nesta resposta da conversa de recrutamento.
 *
 * Devolve a lista de categorias — vazia quando a resposta pode sair. Como em
 * proibidoEm(), o TEXTO nunca entra no retorno: ele está sendo descartado
 * justamente por conter isso.
 */
export function proibidoNaConversa(texto) {
  const t = String(texto ?? '')
  const achados = []
  if (falaDeRegistro(t) && QUANDO_REGISTRA.some(re => re.test(t))) achados.push('quando_registra')
  if (DADO_BANCARIO.test(t)) achados.push('dado_bancario')
  if (REGRAS.link.test(t)) achados.push('link')
  if (prometePassagem(t)) achados.push('passagem_adiantada')
  return achados
}
