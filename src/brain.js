/**
 * Cérebro do robô de recrutamento (desenho híbrido). Funções puras: `iniciar()`
 * e `responder(estado, msg)`. A criação da candidatura é feita pelo chamador
 * (rh-client), após a conclusão. Esta é a FONTE DA VERDADE do robô.
 *
 * Melhorias: seleção por número, opção "Outros" (função fora da lista),
 * comando "recomeçar", e confirmação de envio tratada pelo servidor (só diz
 * "registrada" depois de salvar de verdade).
 */

import { norm, melhorMatch, contemAlgum } from './texto.js'
import {
  vagasAtuais, cidadesAtuais, termosDasVagas, tetoDe, alojamentoVale,
  AUXILIO_TRANSPORTE_ESTAGIO,
} from './catalogo.js'

// ─── Base de conhecimento ────────────────────────────────────────────────────
// As vagas vêm do RH (ver vagas.js). Antes moravam aqui, com salário escrito
// à mão — e o robô informa o valor por escrito, no WhatsApp do candidato.

// As cidades também. Moravam aqui escritas à mão, e a lista dizia que SEIS
// tinham alojamento quando só duas têm: alguém podia largar o que tem e
// chegar numa cidade sem onde dormir, com a promessa por escrito no celular.
// Agora vêm do RH, pelo catálogo — a mesma fonte da Maria Vitória.

export const JORNADA = 'Segunda a quinta das 7h às 17h, e sexta das 7h às 16h.'

// ─── Helpers de texto ────────────────────────────────────────────────────────
// norm() agora vem de texto.js — mesma ideia, mas também tira pontuação.
function fmtMoeda(v) {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}
/**
 * O termo aparece na mensagem, ainda que escrito errado?
 *
 * Era comparação exata: "salrio" e "alojamneto" não casavam, e a pessoa
 * ouvia "não entendi" por ter errado uma letra. Trocando só esta função,
 * todo o robô — FAQ, sim/não, comandos — passa a tolerar erro de escrita.
 */
function temAlguma(msg, termos) {
  return contemAlgum(msg, termos)
}
/** Se a mensagem é só um número (ex.: "2", "2)", "2."), devolve o índice (1..len). */
function indiceEscolhido(msg, len) {
  const m = (msg || '').trim().match(/^(\d{1,2})[).\s-]*$/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return n >= 1 && n <= len ? n : null
}
/**
 * Como cada vaga pode ser chamada.
 *
 * Inclui o jeito que se fala na obra, não só o nome do cargo: "meio
 * oficial" é servente, "ferreiro" é armador, "soldador" é serralheiro.
 */

function matchVaga(msg) {
  const i = indiceEscolhido(msg, vagasAtuais().length)
  if (i) return vagasAtuais()[i - 1]
  const nome = melhorMatch(msg, termosDasVagas(vagasAtuais()))
  return nome ? vagasAtuais().find(v => v.nome === nome) || null : null
}
/** Apelidos que a gente da região usa. */
const APELIDOS_CIDADE = {
  'Caraguatatuba': ['caragua'],
  'Praia Grande': ['pg'],
}

function matchCidade(msg) {
  const i = indiceEscolhido(msg, cidadesAtuais().length)
  if (i) return cidadesAtuais()[i - 1]
  const nome = melhorMatch(msg, cidadesAtuais().map(c => ({
    valor: c.nome,
    termos: [c.nome, ...(APELIDOS_CIDADE[c.nome] ?? [])],
  })))
  return nome ? cidadesAtuais().find(c => c.nome === nome) || null : null
}
function ehSim(msg) {
  return temAlguma(msg, ['sim', 'tenho', 'ja tenho', 'ja', 'possuo', 'claro', 'positivo', 'isso', 'com certeza'])
}
function ehNao(msg) {
  return temAlguma(msg, ['nao', 'nunca', 'ainda nao', 'negativo', 'sem experiencia', 'nenhuma'])
}
function ehPergunta(msg) {
  return /\?/.test(msg) || temAlguma(msg, ['quanto', 'qual', 'quais', 'quando', 'como', 'onde', 'porque', 'por que', ' tem ', 'possui', 'pode', 'posso', 'sera', 'voces'])
}
export function ehReset(msg) {
  return temAlguma(msg, ['recomecar', 'reiniciar', 'comecar de novo', 'comecar denovo', 'voltar ao inicio', 'cancelar tudo', 'menu inicial'])
}
/**
 * Isto parece um nome completo?
 *
 * Bastava ter 3 letras, então "valeu" e "ok" viravam o nome do candidato e
 * chegavam assim ao RH. Agora exige nome E sobrenome — que é o que a
 * pergunta pede e o que o registro em carteira precisa — e recusa as
 * palavras de conversa que não são nome de ninguém.
 */
const NAO_SAO_NOMES = new Set([
  'valeu', 'obrigado', 'obrigada', 'ok', 'sim', 'nao', 'blz', 'beleza',
  'bom dia', 'boa tarde', 'boa noite', 'oi', 'ola', 'tudo bem', 'quero',
  'vaga', 'trabalho', 'emprego', 'nome', 'meu nome',
])

function pareceNome(msg) {
  const limpo = (msg || '').trim()
  if (ehPergunta(limpo)) return false
  const n = norm(limpo)
  if (!n || NAO_SAO_NOMES.has(n)) return false
  // Só letras e espaço: número ou símbolo no meio não é nome.
  if (!/^[a-zÀ-ÿ ]+$/i.test(limpo.normalize('NFC'))) return false
  // Nome e sobrenome, cada um com 2 letras no mínimo.
  const partes = n.split(' ').filter(p => p.length >= 2)
  return partes.length >= 2
}

function querOutros(msg) {
  return temAlguma(msg, ['outro', 'outra', 'nao tem na lista', 'nenhuma dessas', 'nenhuma destas', 'fora da lista', 'minha funcao', 'minha area', 'nao achei'])
}
function listaVagasTexto() {
  return vagasAtuais().map((v, i) => `${i + 1}. ${v.nome}${v.salario ? ` — ${fmtMoeda(v.salario)}` : ' — a combinar'}`).join('\n') +
    `\n${vagasAtuais().length + 1}. Outra função (não está na lista)`
}
function listaCidadesTexto() {
  return cidadesAtuais().map((c, i) => `${i + 1}. ${c.nome}`).join('\n')
}

// ─── FAQ ────────────────────────────────────────────────────────────────────────────
/** "a, b e c" */
function juntar(nomes) {
  return nomes.length <= 1 ? (nomes[0] ?? '') : `${nomes.slice(0, -1).join(', ')} e ${nomes.at(-1)}`
}

/** "R$ 2.803,00 (inicial — com experiência comprovada pode chegar a R$ 3.500,00)" */
function faixaSalarial(v) {
  if (!v.salario) return 'a combinar'
  const teto = tetoDe(v.nome)
  return teto
    ? `${fmtMoeda(v.salario)} sem experiência comprovada, e ${fmtMoeda(teto)} para quem tem experiência comprovada em carteira`
    : fmtMoeda(v.salario)
}

/** O que o estágio exige. Informado pelo dono em 11/09/2026. */
const REQUISITO_ESTAGIO = 'É preciso estar cursando engenharia, arquitetura ou algum curso ligado a obras.'

const ehVagaDeEstagio = (v) => norm(v?.nome ?? '').startsWith('estagi')

/** A conversa é sobre estágio: citado na mensagem, ou a vaga escolhida. */
function ehEstagio(t, estado) {
  return /(^| )estagi/.test(t) || norm(estado?.vaga ?? '').startsWith('estagi')
}

export function responderFAQ(msg, estado = {}) {
  /*
    As perguntas novas usam comparação EXATA, e não a tolerância a erro de
    digitação do resto do arquivo. Nelas uma letra muda o sentido: com
    tolerância, "quanto paga pedreiro?" casava com "quando paga" e recebia o
    dia do pagamento, e "quais cidades têm vaga?" casava com "idade" e
    recebia "precisa ter 18 anos".
  */
  const t = norm(msg)
  /*
    Benefício e registro, ANTES de tudo — e sem resposta pronta.

    "Recebo seguro-desemprego, dá pra não registrar?" é uma pergunta cuja
    resposta escrita, qualquer que seja, vira prova. A resposta antiga dizia
    que "no momento da contratação verificamos essa possibilidade": por
    escrito, a empresa se oferecendo para não registrar alguém que recebe
    benefício. Isto quem conversa é uma pessoa.
  */
  // Sem "auxilio": com tolerância ou sem, fica perto demais de "auxiliar",
  // que é como muita gente chama a vaga de servente.
  if (/\b(beneficio|bolsa familia|bpc|seguro desemprego)\b|nao (posso )?registrar|(perco|perder) o beneficio/.test(t)) {
    return { texto: 'Essa parte eu prefiro que o responsável converse direto com você, tá? Vou pedir pra ele te chamar. 🙂', escalar: true }
  }
  /*
    Registro: diz as formas de contratação, e NUNCA quando o registro é
    feito. "Sim, é CLT 👍" era promessa escrita de carteira assinada — e
    a contratação também é por diária e por empreita.
  */
  if (temAlguma(msg, ['registrado', 'registro', 'registra', 'registram', 'carteira', 'clt', 'fichado', 'assinada'])) {
    if (/primeiro dia|desde o (inicio|comeco)|quando (registra|vou ser)|quanto tempo|demora (pra|para) registrar/.test(t)) {
      // O dono decidiu (11/09/2026): isto se combina com o responsável, e o
      // robô pode dizer exatamente isso — sem chamar ninguém. Continua sem
      // dizer QUANDO registra.
      return { texto: 'Isso você combina direto com o responsável quando ele te ligar. 🙂' }
    }
    return { texto: 'Trabalhamos com carteira assinada (CLT), diária ou empreita — o formato é combinado com o responsável na entrevista. 🙂' }
  }
  // O DIA do pagamento antes do salário: "quando cai o pagamento" não é
  // "quanto paga".
  if (/quando (cai|paga|recebe|e o pagamento)|dia (do|de) pagamento|que dia (paga|cai|recebe)|quinto dia|dia util|adiantamento/.test(t)) {
    return { texto: 'O pagamento é no 5º dia útil de cada mês, e no dia 20 tem o vale (adiantamento). 🙂' }
  }
  if (ehEstagio(t, estado)) {
    /*
      O estágio tem bolsa e auxílio-transporte (R$ 300), e é isso que se diz.
      Vem antes do vale dos contratados: "estagiário tem vale?" recebia a
      regra deles — "a partir do primeiro dia, sem adiantamento" —, que não é
      a do estágio.

      O resto (almoço, qualquer outro benefício) quem combina é o
      responsável: o dono informou bolsa e auxílio, e nada além disso se
      promete por escrito.
    */
    if (/(^| )(vale|transporte|passe|passagem|conducao|onibus)( |$)/.test(t)) {
      return { texto: `No estágio, além da bolsa, tem ${fmtMoeda(AUXILIO_TRANSPORTE_ESTAGIO)} de auxílio-transporte. 🙂` }
    }
    if (/(^| )(almoco|comida|refeicao|alimentacao|beneficios?|auxilio)( |$)/.test(t)) {
      return { texto: `No estágio são a bolsa e o auxílio-transporte de ${fmtMoeda(AUXILIO_TRANSPORTE_ESTAGIO)}. Outros detalhes o responsável combina com você na entrevista. 🙂` }
    }
    if (/(^| )(precisa|requisito|estudando|estudar|faculdade|curso|cursando|matriculad)/.test(t)) {
      return { texto: REQUISITO_ESTAGIO }
    }
  }
  if (temAlguma(msg, ['vale', 'passe', 'transporte', 'conducao', 'passagem', 'onibus'])) {
    const pedeAgora = temAlguma(msg, ['amanha', 'hoje', 'agora', 'ir trabalhar', 'me da', 'me dar', 'manda', 'enviar'])
    return { texto: 'O vale-transporte é a partir do primeiro dia de trabalho. A gente não consegue adiantar: você começa e, chegando lá, o RH envia o vale. 🙂', escalar: pedeAgora }
  }
  if (temAlguma(msg, ['salario', 'quanto ganha', 'quanto paga', 'quanto e', 'remuneracao', 'pagamento'])) {
    // A vaga citada na pergunta vem antes da já escolhida: quem pergunta
    // "e o do pedreiro?" quer o do pedreiro, não a lista inteira.
    const v = matchVaga(msg) || (estado.vaga ? vagasAtuais().find(x => x.nome === estado.vaga) : null)
    if (v && ehVagaDeEstagio(v)) {
      return { texto: `A bolsa de estágio é de ${faixaSalarial(v)}, mais ${fmtMoeda(AUXILIO_TRANSPORTE_ESTAGIO)} de auxílio-transporte. ${REQUISITO_ESTAGIO}` }
    }
    if (v) return { texto: v.salario ? `O salário de ${v.nome} é ${faixaSalarial(v)}.` : `Para ${v.nome} o salário é a combinar, conforme a sua experiência.` }
    return { texto: `Os salários:\n${vagasAtuais().map(v => `• ${v.nome}: ${faixaSalarial(v)}`).join('\n')}` }
  }
  if (temAlguma(msg, ['horario', 'que horas', 'dias', 'jornada', 'expediente', 'turno'])) {
    return { texto: `A jornada é: ${JORNADA}` }
  }
  // Alimentação antes do alojamento: "quem fica no alojamento tem janta?" é
  // pergunta de comida.
  if (/\b(almoco|comida|refeicao|alimentacao|marmita|janta|jantar)\b|cafe da manha/.test(t)) {
    return { texto: 'A empresa fornece o almoço na obra. Quem fica no alojamento tem também café da manhã e janta. 🍽️' }
  }
  if (temAlguma(msg, ['alojamento', 'moradia', 'dormir', 'ficar', 'hospeda', 'morar', 'estadia'])) {
    /*
      O alojamento depende da FUNÇÃO antes de depender da cidade.

      Hoje só pedreiro fica alojado; ajudante precisa morar na cidade da obra
      (dono, 12/09/2026). Dizer isso na primeira pergunta evita o pior
      desfecho: o ajudante de outra cidade que só descobre na entrevista, e
      viajou à toa.
    */
    const vagaEmJogo = matchVaga(msg)?.nome ?? estado.vaga ?? null
    if (vagaEmJogo && alojamentoVale(vagaEmJogo) === false) {
      return { texto: `O alojamento hoje é só para pedreiro. Para ${vagaEmJogo.toLowerCase()}, a gente contrata quem mora na cidade da obra. 🙂` }
    }

    const cidades = cidadesAtuais()
    const comAlojamento = cidades.filter(c => c.alojamento).map(c => c.nome)
    const onde = comAlojamento.length ? ` Hoje o alojamento é em ${juntar(comAlojamento)}.` : ''
    const c = matchCidade(msg) || (estado.cidade ? cidades.find(x => x.nome === estado.cidade) : null)
    // Sem alojamento não quer dizer sem vaga: quem não precisa de onde
    // dormir trabalha na cidade que preferir (decisão do dono, 11/09/2026).
    // Confirma a cidade, não promete a vaga.
    if (c) return { texto: c.alojamento
      ? `Sim! Em ${c.nome} temos alojamento. 🏠`
      : `Em ${c.nome} não temos alojamento.${onde} Se você não precisar de alojamento, pode trabalhar em ${c.nome} sim — a cidade você escolhe. 🙂` }
    return { texto: comAlojamento.length
      ? `Hoje temos alojamento em ${juntar(comAlojamento)}. O alojamento fica na própria cidade da obra.`
      : 'No momento não temos alojamento disponível.' }
  }
  if (/idade minima|menor de idade|(qual|que) (a )?idade|quantos anos (precisa|tem que)|tenho 1[4-7] anos/.test(t)) {
    return { texto: 'É preciso ter 18 anos ou mais. 🙂' }
  }
  if (/como funciona|proximo passo|como e o processo|tem entrevista|quando (me )?chamam/.test(t)) {
    return { texto: 'Funciona assim: a gente conversa aqui e eu já preencho a sua ficha. Depois o responsável te liga, e aí marcamos a entrevista. 🙂' }
  }
  if (temAlguma(msg, ['experiencia', 'precisa saber', 'sou iniciante', 'nunca trabalhei'])) {
    const v = matchVaga(msg) || (estado.vaga ? vagasAtuais().find(x => x.nome === estado.vaga) : null)
    /*
      Experiência deixou de ser porta e virou FAIXA (dono, 12/09/2026): para
      pedreiro e carpinteiro dá para começar sem experiência, e quem tem
      carteira assinada na função entra na faixa maior. Dizer "precisa de
      experiência" espantaria quem a empresa contrata.
    */
    if (v) {
      const teto = tetoDe(v.nome)
      if (teto && v.salario) {
        return { texto: `Para ${v.nome} dá para começar sem experiência (${fmtMoeda(v.salario)}); com experiência comprovada em carteira, ${fmtMoeda(teto)}. 🙂` }
      }
      if (!v.profissional) return { texto: `Para ${v.nome} não é preciso experiência. 🙂` }
      return { texto: `Para ${v.nome} é necessário ter experiência na função.` }
    }
    return { texto: `Para Servente não precisa de experiência. Para Pedreiro e Carpinteiro dá para começar sem, e quem tem experiência comprovada em carteira entra numa faixa maior. Para estágio, ${REQUISITO_ESTAGIO.charAt(0).toLowerCase()}${REQUISITO_ESTAGIO.slice(1)}` }
  }
  if (temAlguma(msg, ['cidade', 'onde tem', 'qual cidade', 'tem vaga em', 'regiao', 'local'])) {
    const c = matchCidade(msg)
    if (c) return { texto: `Sim, temos obra em ${c.nome}, e você pode escolher trabalhar lá.${c.alojamento ? ' E tem alojamento. ✅' : ' (Sem alojamento nesta cidade.)'}` }
    return { texto: `Hoje temos vagas nestas cidades:\n${listaCidadesTexto()}` }
  }
  return null
}

// ─── Fluxo ────────────────────────────────────────────────────────────────────
export function iniciar(whatsapp) {
  return {
    estado: { etapa: 'vaga', whatsapp },
    resposta:
      'Olá! 👷 Que bom seu interesse em fazer parte da nossa equipe!\n\n' +
      'Vou te ajudar com a candidatura, é rapidinho. Para qual vaga você quer se candidatar?\n' +
      '(responda o número ou o nome)\n\n' +
      listaVagasTexto(),
  }
}

function promptAtual(estado) {
  switch (estado.etapa) {
    case 'vaga':        return `Para qual vaga você quer se candidatar? (número ou nome)\n\n${listaVagasTexto()}`
    case 'vagaOutros':  return 'Qual é a função que você procura? Pode escrever.'
    case 'cidade':      return `Em qual cidade você quer trabalhar? (número ou nome)\n\n${listaCidadesTexto()}`
    case 'experiencia': return `Você tem experiência na função de ${estado.vaga}?`
    case 'registro':    return 'Você já tem (ou já teve) registro em carteira nessa função?'
    case 'nome':        return 'Para finalizar, qual é o seu nome completo?'
    default:            return 'Se tiver mais alguma dúvida, é só perguntar! 🙂'
  }
}

function respostaSatisfazEtapa(estado, msg) {
  switch (estado.etapa) {
    case 'vaga':        return !!matchVaga(msg) && !ehPergunta(msg)
    case 'vagaOutros':  return msg.trim().length >= 2 && !ehPergunta(msg)
    case 'cidade':      return !!matchCidade(msg) && !ehPergunta(msg)
    case 'experiencia':
    case 'registro':    return ehSim(msg) || ehNao(msg)
    case 'nome':        return pareceNome(msg)
    default:            return false
  }
}

export function responder(estado, mensagem) {
  // Comando de recomeçar a qualquer momento
  if (ehReset(mensagem)) return iniciar(estado.whatsapp)
  // 1) Responde à etapa atual?
  if (respostaSatisfazEtapa(estado, mensagem)) return avancar(estado, mensagem)
  // 2) Dúvida conhecida → responde e repete a etapa
  const faq = responderFAQ(mensagem, estado)
  if (faq) return { estado, resposta: `${faq.texto}\n\n${promptAtual(estado)}`, escalarHumano: faq.escalar }
  // 3) Não entendi → valida/repergunta
  return avancar(estado, mensagem)
}

function avancar(estado, mensagem) {
  switch (estado.etapa) {
    case 'vaga': {
      // "Outras" = item N+1 da lista, ou pedido explícito
      const idxOutros = indiceEscolhido(mensagem, vagasAtuais().length + 1)
      if (querOutros(mensagem) || idxOutros === vagasAtuais().length + 1) {
        return { estado: { ...estado, etapa: 'vagaOutros' }, resposta: 'Sem problema! Qual é a função que você procura? Pode escrever.' }
      }
      const v = matchVaga(mensagem)
      if (!v) {
        const tent = (estado.tentativasVaga || 0) + 1
        const dica = tent >= 2 ? `\n\nSe a sua função não está na lista, escreva *${vagasAtuais().length + 1}* ou "outra".` : ''
        return { estado: { ...estado, tentativasVaga: tent }, resposta: `Não consegui identificar a vaga. Pode me dizer o número ou o nome?\n\n${listaVagasTexto()}${dica}` }
      }
      return {
        estado: { ...estado, etapa: 'cidade', vaga: v.nome, vagaProfissional: v.profissional, tentativasVaga: 0 },
        resposta: `Boa escolha! Vaga de *${v.nome}*${v.salario ? ` (${fmtMoeda(v.salario)})` : ' (salário a combinar)'}.\n\nEm qual cidade você quer trabalhar? (número ou nome)\n\n${listaCidadesTexto()}`,
      }
    }
    case 'vagaOutros': {
      const funcao = mensagem.trim()
      if (funcao.length < 2) return { estado, resposta: 'Pode escrever a função que você procura?' }
      // Função fora da lista → tratada como profissional (perguntamos experiência/registro)
      return {
        estado: { ...estado, etapa: 'cidade', vaga: `Outros: ${funcao}`, vagaProfissional: true },
        resposta: `Anotado: *${funcao}*. Vou registrar e o RH avalia. 👍\n\nEm qual cidade você quer trabalhar? (número ou nome)\n\n${listaCidadesTexto()}`,
      }
    }
    case 'cidade': {
      const c = matchCidade(mensagem)
      if (!c) return { estado, resposta: `Não encontrei essa cidade. Responda o número ou o nome:\n\n${listaCidadesTexto()}` }
      if (estado.vagaProfissional) {
        return {
          estado: { ...estado, etapa: 'experiencia', cidade: c.nome },
          resposta: `Perfeito, ${c.nome}.${c.alojamento ? ' (Temos alojamento aí. 🏠)' : ''}\n\nVocê tem experiência na função de ${estado.vaga}? (sim ou não)`,
        }
      }
      return {
        estado: { ...estado, etapa: 'nome', cidade: c.nome },
        resposta: `Perfeito, ${c.nome}.${c.alojamento ? ' (Temos alojamento aí. 🏠)' : ''}\n\nPara finalizar, qual é o seu nome completo?`,
      }
    }
    case 'experiencia': {
      const sim = ehSim(mensagem), nao = ehNao(mensagem)
      if (!sim && !nao) return { estado, resposta: `Só para eu registrar: você *tem* experiência como ${estado.vaga}? (sim ou não)` }
      return {
        estado: { ...estado, etapa: 'registro', temExperiencia: sim },
        resposta: sim
          ? `Ótimo! E você já tem (ou já teve) registro em carteira nessa função? (sim ou não)`
          : `Entendi. Para ${estado.vaga} normalmente é preciso experiência, mas vou registrar e o RH avalia. Você já teve registro em carteira nessa função? (sim ou não)`,
      }
    }
    case 'registro': {
      const sim = ehSim(mensagem), nao = ehNao(mensagem)
      if (!sim && !nao) return { estado, resposta: 'Você já tem ou já teve registro em carteira nessa função? (sim ou não)' }
      return { estado: { ...estado, etapa: 'nome', temRegistro: sim }, resposta: 'Anotado! Para finalizar, qual é o seu nome completo?' }
    }
    case 'nome': {
      const nome = mensagem.trim()
      if (!pareceNome(nome)) {
        return { estado, resposta: 'Preciso do seu *nome completo* (nome e sobrenome), para o registro. 🙂' }
      }
      const estadoFinal = { ...estado, etapa: 'fim', nome }
      const dados = {
        nomeCompleto: nome,
        vagaPretendida: estado.vaga || null,
        cidadePreferencia: estado.cidade || null,
        whatsapp: estado.whatsapp || null,
        tempoExperiencia: estado.vagaProfissional ? (estado.temExperiencia ? 'Com experiência' : 'Sem experiência') : null,
        resumoExperiencia: estado.vagaProfissional
          ? `Via WhatsApp. Experiência: ${estado.temExperiencia ? 'sim' : 'não'}. Registro em carteira na função: ${estado.temRegistro ? 'sim' : 'não'}.`
          : 'Candidatura via WhatsApp.',
        transcricao: estadoFinal,
      }
      // A confirmação de sucesso é enviada pelo SERVIDOR só depois de salvar.
      return {
        estado: estadoFinal,
        acao: { tipo: 'criar_candidatura', dados },
        resposta: `Prontinho, ${nome.split(' ')[0]}! ✅ Sua candidatura para *${estado.vaga}* em *${estado.cidade}* foi registrada.\n\nO nosso RH vai analisar e entrar em contato por aqui. Qualquer dúvida (salário, horário, alojamento), pode perguntar! 🙂`,
        respostaFalha: `${nome.split(' ')[0]}, recebi todos os seus dados! Tive um probleminha técnico para registrar agora, mas já anotei tudo e o RH vai te procurar. 🙏`,
      }
    }
    default:
      return { estado, resposta: 'Sua candidatura já está com o nosso RH. 🙌 Se tiver mais alguma dúvida, é só perguntar! (ou escreva "recomeçar" para uma nova candidatura)' }
  }
}
