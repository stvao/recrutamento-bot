/**
 * O primeiro contato com quem o sistema não conhece.
 *
 * Existe porque o robô tratava TODO desconhecido como candidato. Quem
 * escrevia "boa tarde" recebia "qual vaga você procura?" — e isso é rude com
 * quem só queria uma informação, e absurdo com quem trabalha na empresa há
 * dois anos e mudou de número.
 *
 * A regra aqui é: NÃO PRESUMIR. Ele responde ao que a pessoa falou e vai
 * entendendo pelo caminho se é alguém procurando vaga, alguém que já
 * trabalha, ou alguém com uma dúvida qualquer. Só quando fica claro é que a
 * conversa passa para o módulo certo.
 *
 * Quando a pessoa diz que trabalha na empresa mas o telefone não a
 * reconhece, ele pergunta o nome e procura no RH. Isso é identificação MAIS
 * FRACA que o telefone — qualquer um digita um nome — e é aceitável por um
 * motivo só: reconhecer alguém aqui não libera dado pessoal nenhum. Libera
 * ser chamado pelo nome e receber respostas que valem para todo mundo igual.
 */
import { chamarModelo, iaDisponivel } from './ia.js'
import { norm } from './texto.js'
import { proibidoEm } from './resposta-segura.js'

const EMPRESA = process.env.EMPRESA_NOME || 'KE Engenharia'

/**
 * Sinais fortes, lidos antes de qualquer modelo.
 *
 * Quem escreve "quero trabalhar" não precisa de IA para ser entendido, e
 * uma regra fixa aqui responde na hora, de graça, e sempre igual.
 */
/*
  "serviço" saiu daqui.

  "Preciso falar sobre um serviço que prestei" é um prestador cobrando, e ia
  parar no recrutamento — que perguntava a ele qual vaga procurava. A palavra
  serve para os dois lados e não decide nada; quem decide, nesses casos, é o
  modelo, que lê a frase inteira.
*/
const QUER_VAGA = /\b(vaga|vagas|emprego|trabalhar|contrata|contratando|curr[ií]culo|curriculo|oportunidade|estou procurando|preciso de trabalho|t[oô] procurando)\b/i

const JA_TRABALHA = /\b(j[áa] trabalho|eu trabalho|sou funcion[áa]rio|trabalho (a[íi]|na obra|com voc[êe]s|pra voc[êe]s|na empresa)|sou da obra|estou na obra|sou o pedreiro|meu encarregado)\b/i

/** Cumprimento sem assunto: não diz nada sobre o que a pessoa quer. */
const SO_CUMPRIMENTO = /^\s*(oi+|ol[áa]|opa|e a[íi]|bom dia|boa tarde|boa noite|tudo bem\??|tudo bom\??|blz|beleza)[\s!,.?]*$/i

/**
 * Palavras que nunca aparecem num nome.
 *
 * Sem esta lista, "nao lembro agora" passava como nome: sao tres palavras,
 * so com letras, e o robo ia procurar essa pessoa no cadastro do RH.
 */
const NAO_E_NOME = new Set([
  'nao', 'sim', 'sei', 'lembro', 'agora', 'depois', 'ainda', 'nada', 'tudo',
  'bem', 'bom', 'boa', 'dia', 'tarde', 'noite', 'obrigado', 'obrigada',
  'quero', 'preciso', 'pode', 'favor', 'entao', 'aqui', 'voce', 'meu',
  'minha', 'trabalho', 'vaga', 'emprego', 'oi', 'ola', 'opa', 'blz',
])

/** A resposta a "qual o seu nome" — um nome, e não uma frase. */
export function pareceNome(texto) {
  const limpo = (texto || '')
    .replace(/^\s*(meu nome (é|e)|eu sou o?a?|sou o?a?|aqui (é|e) o?a?|chamo-me|me chamo)\s+/i, '')
    .trim()

  if (!/^[a-zà-ÿ'´`^~\s]+$/i.test(limpo.normalize('NFC'))) return null
  const partes = limpo.split(/\s+/).filter(p => p.length >= 2)
  if (partes.length < 2 || partes.length > 6) return null

  // Uma palavra que nunca aparece num nome derruba a frase inteira: e mais
  // seguro pedir de novo do que sair procurando "nao lembro" no cadastro.
  const temIntruso = partes.some(p => NAO_E_NOME.has(norm(p)))
  return temIntruso ? null : limpo
}

/**
 * O que ele pode dizer antes de saber quem é a pessoa.
 *
 * Nada de específico: nem salário, nem vaga, nem condição. Ele ainda não
 * sabe com quem está falando, e prometer qualquer coisa aqui seria prometer
 * no escuro.
 */
function instrucoes() {
  return `Você é do RH da ${EMPRESA}, uma construtora que reforma escolas
estaduais em São Paulo. Alguém acabou de escrever no WhatsApp e você AINDA
NÃO SABE quem é.

SEU ÚNICO TRABALHO AGORA é responder com educação ao que a pessoa falou e
descobrir, conversando, em qual destas ela se encaixa:

- procura_vaga: quer emprego, quer saber de vaga, quer mandar currículo
- ja_trabalha: já trabalha na empresa (ou diz que trabalha)
- informacao: quer outra coisa — falar com alguém, tirar uma dúvida,
  cobrar, oferecer serviço, vender algo
- nao_sei_ainda: ela só cumprimentou, ou o que disse não deixa claro

COMO VOCÊ FALA
- Português do Brasil, informal e respeitoso, como gente do RH fala.
- Frases curtas, no máximo 2 linhas. É WhatsApp.
- Responda ao que ela falou ANTES de perguntar qualquer coisa. Quem diz
  "boa tarde" recebe um "boa tarde" de volta, não um interrogatório.
- Uma pergunta por vez, e só se precisar.

O QUE VOCÊ NUNCA FAZ
- NUNCA fale de salário, valor, benefício, vaga específica ou condição de
  trabalho. Você ainda não sabe com quem está falando.
- NUNCA mande link, senha ou código.
- NUNCA peça CPF, RG, PIS, conta bancária ou chave PIX.
- NUNCA prometa nada.
- Não se anuncie como robô. Fale normalmente, como gente do RH.

Se a pessoa disser que JÁ TRABALHA na empresa, peça o nome completo dela
para você localizar o cadastro — e marque pedindoNome = true. Só o nome,
mais nada.`
}

const ESQUEMA = {
  type: 'object',
  properties: {
    resposta: { type: 'string', description: 'A mensagem para a pessoa. No maximo 2 linhas.' },
    intencao: {
      type: 'string',
      enum: ['procura_vaga', 'ja_trabalha', 'informacao', 'nao_sei_ainda'],
      description: 'Em que ela se encaixa, pelo que disse ate agora.',
    },
    pedindoNome: { type: 'boolean', description: 'true se voce acabou de pedir o nome completo dela' },
    precisaHumano: { type: 'boolean', description: 'true se e assunto que so uma pessoa resolve' },
    motivo: { type: 'string', description: 'Em poucas palavras, o que ela quer. Vai para o alerta do RH.' },
  },
  required: ['resposta', 'intencao', 'pedindoNome', 'precisaHumano', 'motivo'],
}

/**
 * Confere o que o modelo devolveu.
 *
 * Mesma regra do resto do robô: ele decide o que dizer, o código decide o
 * que vale. Valor, link ou senha numa conversa em que nem se sabe quem é a
 * pessoa é ainda pior que no atendimento a funcionário — aqui pode ser
 * qualquer um do outro lado.
 */
export function conferir(saida) {
  if (!saida?.resposta?.trim()) return null

  const r = saida.resposta

  // As regras vivem em resposta-segura.js, junto com as do atendimento ao
  // funcionário. Estavam copiadas nos dois arquivos e divergiram: lá se
  // passou a barrar "bit.ly" e "código de acesso", aqui não — e ninguém viu,
  // porque não havia lugar onde a diferença aparecesse.
  const proibido = proibidoEm(r)

  if (proibido.length) {
    // O TEXTO não vai para o log: está sendo descartado justamente por conter
    // isso, e escrevê-lo aqui só mudaria o lugar do vazamento para um que é
    // lido por mais gente e guardado por mais tempo.
    console.warn(`[triagem] resposta descartada — continha ${proibido.join(', ')}`)
    return {
      resposta: 'Deixa eu chamar alguém da equipe pra falar com você.',
      intencao: 'informacao',
      pedindoNome: false,
      precisaHumano: true,
      motivo: 'resposta bloqueada por conter valor, link ou senha',
    }
  }

  const intencoes = ['procura_vaga', 'ja_trabalha', 'informacao', 'nao_sei_ainda']
  return {
    resposta: r.trim(),
    intencao: intencoes.includes(saida.intencao) ? saida.intencao : 'nao_sei_ainda',
    pedindoNome: Boolean(saida.pedindoNome),
    precisaHumano: Boolean(saida.precisaHumano),
    motivo: (saida.motivo || 'primeiro contato').slice(0, 120),
  }
}

/** A saudação de quem não disse nada além de "oi". */
export function saudacao() {
  return `Oi! Aqui é do RH da ${EMPRESA}. \nEm que posso ajudar?`
}

/**
 * Atende o primeiro contato.
 *
 * Devolve { resposta, intencao, pedindoNome, nomeInformado, escalarHumano }.
 * `nomeInformado` só vem quando a pessoa acabou de responder o nome a uma
 * pergunta nossa — é o que dispara a busca no RH.
 */
export async function atender({ texto, historico = [], esperandoNome = false }) {
  const t = (texto || '').trim()

  /*
    Estávamos esperando o nome? Então esta mensagem provavelmente é ele.

    Verificado antes de tudo: "José da Silva" não casa com nenhuma regra de
    intenção, e passaria batido para o modelo — que responderia alguma coisa
    genérica em vez de procurar a pessoa.
  */
  if (esperandoNome) {
    const nome = pareceNome(t)
    if (nome) return { resposta: null, intencao: 'ja_trabalha', nomeInformado: nome }
  }

  // Sinais fortes não precisam de modelo: respondem na hora, sempre igual.
  if (JA_TRABALHA.test(t)) {
    return {
      resposta: 'Ah, então você é da equipe! Me diz seu nome completo que eu localizo seu cadastro.',
      intencao: 'ja_trabalha',
      pedindoNome: true,
    }
  }
  if (QUER_VAGA.test(t)) {
    return { resposta: null, intencao: 'procura_vaga' }
  }

  if (!iaDisponivel()) {
    // Sem modelo, a saudação é o melhor que dá — e é melhor que assumir que
    // a pessoa quer vaga.
    if (SO_CUMPRIMENTO.test(t)) return { resposta: saudacao(), intencao: 'nao_sei_ainda' }
    return {
      resposta: 'Deixa eu chamar alguém da equipe pra te atender.',
      intencao: 'informacao',
      escalarHumano: true,
      motivoEscalada: 'primeiro contato sem IA',
    }
  }

  const saida = conferir(await chamarModelo({
    instrucoes: instrucoes(),
    esquema: ESQUEMA,
    historico: [...historico, { de: 'pessoa', texto: t }],
  }).catch(() => null))

  if (!saida) {
    return {
      resposta: SO_CUMPRIMENTO.test(t) ? saudacao() : 'Pode me contar melhor o que você precisa?',
      intencao: 'nao_sei_ainda',
    }
  }

  return {
    resposta: saida.resposta,
    intencao: saida.intencao,
    pedindoNome: saida.pedindoNome,
    escalarHumano: saida.precisaHumano,
    motivoEscalada: saida.precisaHumano ? saida.motivo : undefined,
  }
}

/** Só para teste. */
export const _regras = { QUER_VAGA, JA_TRABALHA, SO_CUMPRIMENTO }
