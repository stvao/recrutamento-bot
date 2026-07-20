/**
 * Cérebro do robô de recrutamento (desenho híbrido). Funções puras: `iniciar()`
 * e `responder(estado, msg)`. A criação da candidatura é feita pelo chamador
 * (rh-client), após a conclusão. Esta é a FONTE DA VERDADE do robô.
 *
 * Melhorias: seleção por número, opção "Outros" (função fora da lista),
 * comando "recomeçar", e confirmação de envio tratada pelo servidor (só diz
 * "registrada" depois de salvar de verdade).
 */

// ─── Base de conhecimento ────────────────────────────────────────────────────
export const VAGAS = [
  { nome: 'Servente',                                       salario: 2302.75, profissional: false },
  { nome: 'Pedreiro',                                       salario: 2801.98, profissional: true },
  { nome: 'Estagiário de Arquitetura ou Engenharia Civil', salario: null,    profissional: false },
  { nome: 'Serralheiro',                                    salario: null,    profissional: true },
  { nome: 'Armador',                                        salario: null,    profissional: true },
  { nome: 'Carpinteiro',                                    salario: null,    profissional: true },
  { nome: 'Eletricista',                                    salario: null,    profissional: true },
]

export const CIDADES = [
  { nome: 'Buritama',      alojamento: true },
  { nome: 'Pereiras',      alojamento: true },
  { nome: 'Bastos',        alojamento: true },
  { nome: 'Caraguatatuba', alojamento: true },
  { nome: 'Praia Grande',  alojamento: true },
  { nome: 'Bertioga',      alojamento: true },
  { nome: 'Peruíbe',       alojamento: true },
  { nome: 'Itapevi',       alojamento: false },
]

export const JORNADA = 'Segunda a quinta das 7h às 17h, e sexta das 7h às 16h.'

// ─── Helpers de texto ────────────────────────────────────────────────────────
function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
}
function fmtMoeda(v) {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}
function temAlguma(msg, termos) {
  const m = norm(msg)
  return termos.some(t => m.includes(norm(t)))
}
/** Se a mensagem é só um número (ex.: "2", "2)", "2."), devolve o índice (1..len). */
function indiceEscolhido(msg, len) {
  const m = (msg || '').trim().match(/^(\d{1,2})[).\s-]*$/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return n >= 1 && n <= len ? n : null
}
function matchVaga(msg) {
  const i = indiceEscolhido(msg, VAGAS.length)
  if (i) return VAGAS[i - 1]
  const m = norm(msg)
  const sin = {
    'servente': 'Servente', 'ajudante': 'Servente', 'auxiliar': 'Servente',
    'pedreiro': 'Pedreiro',
    'estagi': 'Estagiário de Arquitetura ou Engenharia Civil', 'estagio': 'Estagiário de Arquitetura ou Engenharia Civil',
    'serralheiro': 'Serralheiro', 'soldador': 'Serralheiro',
    'armador': 'Armador', 'ferreiro': 'Armador',
    'carpinteiro': 'Carpinteiro',
    'eletricista': 'Eletricista',
  }
  for (const chave of Object.keys(sin)) {
    if (m.includes(chave)) return VAGAS.find(v => v.nome === sin[chave]) || null
  }
  return null
}
function matchCidade(msg) {
  const i = indiceEscolhido(msg, CIDADES.length)
  if (i) return CIDADES[i - 1]
  const m = norm(msg)
  return CIDADES.find(c => m.includes(norm(c.nome))) || null
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
function ehReset(msg) {
  return temAlguma(msg, ['recomecar', 'reiniciar', 'comecar de novo', 'comecar denovo', 'voltar ao inicio', 'cancelar tudo', 'menu inicial'])
}
function querOutros(msg) {
  return temAlguma(msg, ['outro', 'outra', 'nao tem na lista', 'nenhuma dessas', 'nenhuma destas', 'fora da lista', 'minha funcao', 'minha area', 'nao achei'])
}
function listaVagasTexto() {
  return VAGAS.map((v, i) => `${i + 1}. ${v.nome}${v.salario ? ` — ${fmtMoeda(v.salario)}` : ' — a combinar'}`).join('\n') +
    `\n${VAGAS.length + 1}. Outra função (não está na lista)`
}
function listaCidadesTexto() {
  return CIDADES.map((c, i) => `${i + 1}. ${c.nome}`).join('\n')
}

// ─── FAQ ──────────────────────────────────────────────────────────────────────
function responderFAQ(msg, estado) {
  if (temAlguma(msg, ['vale', 'passe', 'transporte', 'conducao', 'passagem', 'onibus'])) {
    const pedeAgora = temAlguma(msg, ['amanha', 'hoje', 'agora', 'ir trabalhar', 'me da', 'me dar', 'manda', 'enviar'])
    return { texto: 'Sobre o vale-transporte: ele é fornecido para quem precisa. Só não conseguimos enviar antes de você começar — assim que estiver trabalhando, o RH envia o vale. 🙂', escalar: pedeAgora }
  }
  if (temAlguma(msg, ['salario', 'quanto ganha', 'quanto paga', 'quanto e', 'remuneracao', 'pagamento'])) {
    const v = estado.vaga ? VAGAS.find(x => x.nome === estado.vaga) : null
    if (v) return { texto: v.salario ? `O salário de ${v.nome} é ${fmtMoeda(v.salario)}.` : `Para ${v.nome} o salário é a combinar, conforme a sua experiência.` }
    return { texto: `Os salários:\n${VAGAS.map(v => `• ${v.nome}: ${v.salario ? fmtMoeda(v.salario) : 'a combinar'}`).join('\n')}` }
  }
  if (temAlguma(msg, ['horario', 'que horas', 'dias', 'jornada', 'expediente', 'turno'])) {
    return { texto: `A jornada é: ${JORNADA}` }
  }
  if (temAlguma(msg, ['alojamento', 'moradia', 'dormir', 'ficar', 'hospeda', 'morar', 'estadia'])) {
    const cMsg = matchCidade(msg)
    const c = cMsg || (estado.cidade ? CIDADES.find(x => x.nome === estado.cidade) : null)
    if (c) return { texto: c.alojamento ? `Sim! Em ${c.nome} temos alojamento. 🏠` : `Em ${c.nome} não temos alojamento. Nas demais cidades onde temos obra, sim.` }
    return { texto: 'Temos alojamento em todas as cidades onde há obra, exceto Itapevi. O alojamento fica na própria cidade da obra.' }
  }
  if (temAlguma(msg, ['registrado', 'registro', 'carteira', 'clt', 'fichado', 'assinada'])) {
    if (temAlguma(msg, ['beneficio', 'bolsa', 'bpc', 'auxilio', 'nao posso registrar', 'perco'])) {
      return { texto: 'A contratação é com registro em carteira (CLT). Se você recebe algum benefício e não pode ser registrado agora, no momento da contratação nós verificamos essa possibilidade com você.' }
    }
    return { texto: 'Sim, a contratação é com registro em carteira (CLT). 👍' }
  }
  if (temAlguma(msg, ['beneficio', 'bolsa familia', 'bpc', 'nao posso registrar', 'perco o'])) {
    return { texto: 'A contratação é registrada (CLT). Se você recebe algum benefício e não pode ser registrado agora, no momento da contratação verificamos essa possibilidade com você.' }
  }
  if (temAlguma(msg, ['experiencia', 'precisa saber', 'sou iniciante', 'nunca trabalhei'])) {
    const v = estado.vaga ? VAGAS.find(x => x.nome === estado.vaga) : null
    if (v && !v.profissional) return { texto: `Para ${v.nome} não é preciso experiência. 🙂` }
    if (v && v.profissional) return { texto: `Para ${v.nome} é necessário ter experiência na função.` }
    return { texto: 'Para Servente e Estágio não precisa de experiência. Para as demais funções é necessário ter experiência.' }
  }
  if (temAlguma(msg, ['cidade', 'onde tem', 'qual cidade', 'tem vaga em', 'regiao', 'local'])) {
    const c = matchCidade(msg)
    if (c) return { texto: `Sim, temos obra em ${c.nome}.${c.alojamento ? ' E tem alojamento. ✅' : ' (Sem alojamento nesta cidade.)'}` }
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
    case 'nome':        return msg.trim().length >= 3 && !ehPergunta(msg)
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
      const idxOutros = indiceEscolhido(mensagem, VAGAS.length + 1)
      if (querOutros(mensagem) || idxOutros === VAGAS.length + 1) {
        return { estado: { ...estado, etapa: 'vagaOutros' }, resposta: 'Sem problema! Qual é a função que você procura? Pode escrever.' }
      }
      const v = matchVaga(mensagem)
      if (!v) {
        const tent = (estado.tentativasVaga || 0) + 1
        const dica = tent >= 2 ? `\n\nSe a sua função não está na lista, escreva *${VAGAS.length + 1}* ou "outra".` : ''
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
      if (nome.length < 3 || !/[a-zA-ZÀ-ÿ]/.test(nome)) return { estado, resposta: 'Pode me mandar seu nome completo, por favor?' }
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
