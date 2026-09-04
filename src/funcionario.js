/**
 * Atendimento a quem JÁ TRABALHA na empresa.
 *
 * Diferente do recrutamento, e a diferença é a regra que organiza este
 * arquivo inteiro:
 *
 *   NADA PESSOAL SAI POR AQUI.
 *
 * Sem salário, sem holerite, sem saldo de férias, sem desconto, sem CPF, sem
 * chave PIX. E sem LINK — nem para portal, nem com senha, nem "clique aqui".
 *
 * Duas razões, e as duas bastam sozinhas:
 *
 * 1. Número de WhatsApp é identificação FRACA. Celular emprestado é rotina
 *    em obra e chip pré-pago troca de dono. Qualquer dado pessoal que saia
 *    daqui pode chegar à pessoa errada.
 *
 * 2. O que o robô escreve fica escrito. Num contexto trabalhista isso vira
 *    prova, e um valor errado informado por robô é um problema que ninguém
 *    quer ter — nem a empresa, nem quem recebeu.
 *
 * O que ele faz é o que é INSTITUCIONAL e verificável: horário da obra, onde
 * ela fica, como pedir EPI, qual é o procedimento para atestado ou férias.
 * Coisas que valem para todo mundo igual e que não mudam conforme a pessoa.
 *
 * Para todo o resto ele chama gente. Chamar gente não é o plano B: é o
 * comportamento correto, e o alerta chega ao RH pelo mesmo sino que já
 * existe.
 */
import { chamarModelo, iaDisponivel } from './ia.js'

/**
 * O que ele NUNCA responde, por mais que pareça simples.
 *
 * A lista existe além do prompt de propósito. O modelo é instruído a não
 * falar disso, mas instrução não é garantia — e aqui a falha não é uma
 * resposta esquisita, é um valor de salário escrito no WhatsApp de alguém.
 * Batendo antes de chamar o modelo, a pergunta nem chega nele.
 */
const ASSUNTO_PESSOAL = new RegExp([
  // Radicais: pegam as variações sem precisar listar todas.
  'salari', 'salári', 'holerite', 'contra ?cheque', 'rescis', 'adiantament',
  'fgts', 'inss', 'irrf', 'imposto de renda', 'demonstrativo',
  'decimo terceiro', 'décimo terceiro',
  // Palavras inteiras. Sem a fronteira, "vale" casava com "valeu" e com
  // "cavalete" — alguém agradecendo virava alerta para o RH, e alerta falso
  // repetido faz quem recebe parar de olhar o sino.
  '\\b(vale|vales)\\b', '\\b(ferias|férias)\\b', '\\b(desconto|descontos|descontaram)\\b',
  '\\b(acerto|verbas)\\b', '\\b(saldo)\\b', '\\b13[oº]\\b',
  // Frases: só como frase mesmo, para não pegar conversa comum.
  'quanto (eu )?(ganho|recebo|vou receber)', 'meu pagamento',
  'meu cpf', 'minha conta', 'minha chave', 'meu pix', 'meu banco',
  'quanto (tem|falta|sobrou)',
].join('|'), 'i')

/**
 * O que ele responde direto, sem modelo nenhum.
 *
 * Não é economia de cota: é previsibilidade. Estas são as perguntas que mais
 * chegam, e a resposta delas não pode variar de um dia para o outro conforme
 * o humor do modelo.
 */
/**
 * Isto é um PEDIDO, e não uma pergunta?
 *
 * A diferença decide quem responde. "Que horas eu entro?" é um fato, e o
 * robô sabe. "Preciso trocar meu horário" é um pedido, e quem decide é
 * gente — responder com a tabela da jornada seria ignorar o que a pessoa
 * falou, que é a forma mais rápida de ela desistir de escrever de novo.
 */
const EH_PEDIDO = /\b(preciso|precisava|queria|quero|posso|poderia|pode|consigo|autoriza|libera|troco|trocar|mudar|remarcar|adiantar|adiar|folga|faltar|vou faltar)\b/i

function respostaFixa(texto, ficha) {
  const t = (texto || '').toLowerCase()

  // Pedido não tem resposta pronta: vai para uma pessoa.
  if (EH_PEDIDO.test(t)) return null

  if (/(que horas|horario|horário|expediente|entrada|saida|saída)/.test(t)) {
    return `${JORNADA_TEXTO}\nSe a sua obra tiver horário diferente, quem confirma é o encarregado.`
  }
  if (/(onde (fica|é|e) a obra|endereco|endereço|como chego|localiza)/.test(t)) {
    return ficha.obraEndereco
      ? `A obra ${ficha.obra ?? ''} fica em: ${ficha.obraEndereco}`.trim()
      : 'Não tenho o endereço aqui — o encarregado da obra te passa certinho.'
  }
  if (/(epi|capacete|bota|botina|luva|uniforme|camisa)/.test(t)) {
    return 'EPI e uniforme são fornecidos pela empresa. Fala com o encarregado da obra que ele solicita a reposição.'
  }
  if (/(atestado|medico|médico|consulta|afastad)/.test(t)) {
    return 'Atestado precisa ser entregue em até 48 horas. Manda uma foto para o encarregado da obra e leva o original quando puder.'
  }
  return null
}

const JORNADA_TEXTO = process.env.JORNADA_TEXTO
  || 'A jornada é de segunda a quinta das 7h às 17h, e sexta das 7h às 16h.'

const EMPRESA = process.env.EMPRESA_NOME || 'KE Engenharia'

/**
 * O que o modelo pode dizer.
 *
 * Curto e fechado. Quanto menos assunto ele tem, menos chance de inventar —
 * e aqui inventar tem consequência trabalhista.
 */
function instrucoes(ficha) {
  return `Você é do RH da ${EMPRESA}, uma construtora que reforma escolas
estaduais em São Paulo. Está conversando por WhatsApp com ${ficha.primeiroNome},
que TRABALHA na empresa${ficha.funcao ? ` como ${ficha.funcao}` : ''}${ficha.obra ? `, na obra ${ficha.obra}` : ''}.

COMO VOCÊ FALA
- Português do Brasil, informal e respeitoso, como gente do RH fala.
- Frases curtas. No máximo 3 linhas.
- Sem "prezado", sem "estou à disposição", sem marcadores. É WhatsApp.

O QUE VOCÊ PODE RESPONDER
Só o que vale igual para todo mundo e está nos FATOS abaixo: horário,
endereço da obra, como pedir EPI, o procedimento para atestado e para pedir
férias. Nada além disso.

O QUE VOCÊ NUNCA FAZ — e isto não tem exceção
- NUNCA fale de salário, valor a receber, holerite, desconto, vale,
  adiantamento, FGTS, INSS, saldo de férias, décimo terceiro ou rescisão.
  Nem confirme, nem negue, nem dê ordem de grandeza. Não é seu assunto.
- NUNCA mande link, endereço de site, senha ou código.
- NUNCA peça nem confirme CPF, PIS, RG, conta bancária ou chave PIX.
- NUNCA prometa nada — aumento, promoção, data de pagamento, folga.
- Se não estiver nos fatos abaixo, você NÃO SABE. Diga que vai confirmar com
  a equipe, e marque precisaHumano.

Quando o assunto for pessoal (o dinheiro dele, os documentos dele, a
situação dele), a resposta é sempre a mesma: diga com naturalidade que isso
é com uma pessoa do RH, que você já avisou, e que vão falar com ele. Marque
precisaHumano = true. Não é desculpa — é o certo, e ele vai ser atendido.

FATOS DE HOJE (a única fonte de verdade):
${JORNADA_TEXTO}
Contratação: registro em carteira (CLT).
EPI e uniforme: fornecidos pela empresa, pedidos ao encarregado da obra.
Atestado: entregar em até 48 horas ao encarregado.
Férias e folga: pedidos ao encarregado, que fala com o RH.
${ficha.obra ? `Obra dele: ${ficha.obra}.` : ''}
${ficha.obraEndereco ? `Endereço da obra: ${ficha.obraEndereco}.` : ''}`
}

const ESQUEMA = {
  type: 'object',
  properties: {
    resposta: { type: 'string', description: 'A mensagem para a pessoa. No maximo 3 linhas.' },
    precisaHumano: { type: 'boolean', description: 'true se o assunto e pessoal, ou se voce nao sabe' },
    motivo: { type: 'string', description: 'Em poucas palavras, o que ela quer. Vai para o alerta do RH.' },
  },
  required: ['resposta', 'precisaHumano', 'motivo'],
}

/**
 * Confere o que o modelo devolveu antes de mandar.
 *
 * Última barreira, e a que importa mais. O prompt manda não falar de
 * dinheiro e não mandar link; isto GARANTE. Se escapar qualquer coisa
 * parecida com valor em reais ou endereço de site, a resposta inteira é
 * descartada e vira "vou chamar alguém" — porque uma resposta genérica a
 * mais não custa nada, e um valor errado por escrito custa caro.
 */
export function conferir(saida) {
  if (!saida?.resposta?.trim()) return null

  const r = saida.resposta

  const temValor = /R\$\s*\d|\d+\s*(reais|mil reais)/i.test(r)
  const temLink = /https?:\/\/|www\.|\.com|\.br\/|bit\.ly/i.test(r)
  const temSenha = /senha|token|código de acesso|codigo de acesso/i.test(r)

  if (temValor || temLink || temSenha) {
    // O TEXTO não vai para o log.
    //
    // Ele está sendo descartado justamente por conter valor, link ou senha
    // — escrevê-lo aqui só mudaria o lugar do vazamento, do WhatsApp do
    // funcionário para o arquivo de log do servidor, que é lido por mais
    // gente e guardado por mais tempo. O motivo basta para investigar.
    console.warn(`[funcionario] resposta descartada — continha ${[
      temValor && 'valor', temLink && 'link', temSenha && 'senha',
    ].filter(Boolean).join(', ')}`)
    return {
      resposta: 'Isso aí eu prefiro que uma pessoa do RH veja com você — já avisei a equipe, alguém te chama.',
      precisaHumano: true,
      motivo: 'resposta bloqueada por conter valor, link ou senha',
    }
  }

  return {
    resposta: r.trim(),
    precisaHumano: Boolean(saida.precisaHumano),
    motivo: (saida.motivo || 'dúvida de funcionário').slice(0, 120),
  }
}

/** A resposta padrão para tudo que é pessoal. */
export function respostaDeAssuntoPessoal(nome) {
  return `${nome ? `${nome}, ` : ''}isso eu não consigo ver por aqui — é com uma pessoa do RH. `
    + 'Já avisei a equipe, vão falar com você. 👍'
}

/**
 * Atende uma mensagem de funcionário.
 *
 * Devolve { resposta, escalarHumano, motivoEscalada }. Nunca lança: falha de
 * modelo ou de rede vira "vou chamar alguém", que é uma resposta correta.
 */
export async function atender({ ficha, texto, historico = [] }) {
  const nome = ficha?.primeiroNome ?? ''

  // Assunto pessoal nem chega ao modelo.
  if (ASSUNTO_PESSOAL.test(texto || '')) {
    return {
      resposta: respostaDeAssuntoPessoal(nome),
      escalarHumano: true,
      motivoEscalada: 'assunto pessoal (salário, holerite, férias ou documento)',
    }
  }

  const fixa = respostaFixa(texto, ficha ?? {})
  if (fixa) return { resposta: fixa, escalarHumano: false }

  if (!iaDisponivel()) {
    return {
      resposta: `${nome ? `Oi, ${nome}! ` : ''}Deixa eu chamar alguém do RH pra te responder direitinho.`,
      escalarHumano: true,
      motivoEscalada: 'sem IA disponível',
    }
  }

  const saida = conferir(await chamarModelo({
    instrucoes: instrucoes(ficha ?? {}),
    esquema: ESQUEMA,
    historico: [...historico, { de: 'pessoa', texto }],
  }).catch(() => null))

  if (!saida) {
    return {
      resposta: `${nome ? `Oi, ${nome}! ` : ''}Vou chamar alguém do RH pra falar com você, tá?`,
      escalarHumano: true,
      motivoEscalada: 'modelo não respondeu',
    }
  }

  return {
    resposta: saida.resposta,
    escalarHumano: saida.precisaHumano,
    motivoEscalada: saida.precisaHumano ? saida.motivo : undefined,
  }
}

/** Só para teste: a lista de assuntos que nunca passam. */
export function ehAssuntoPessoal(texto) {
  return ASSUNTO_PESSOAL.test(texto || '')
}
