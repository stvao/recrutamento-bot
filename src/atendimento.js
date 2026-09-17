/**
 * Quem atende: a Maria Vitória, ou o roteiro.
 *
 * Esta camada decide qual dos dois responde e — mais importante — CONFERE o
 * que o modelo diz ter entendido antes de qualquer coisa virar registro.
 *
 * A regra que organiza tudo: o modelo conduz a conversa, o código decide o
 * que é verdade. Se o modelo disser que a pessoa quer a vaga de "Encanador",
 * que não existe na lista da empresa, o código descarta. Se disser que a
 * conversa terminou mas falta o nome, o código não grava.
 *
 * E se o modelo não responder — chave ausente, cota do dia estourada, rede
 * fora —, o roteiro assume na mesma mensagem. O candidato não fica sem
 * resposta por causa de uma dependência externa.
 */
import {
  iniciar as iniciarRoteiro, responder as responderRoteiro, ehReset, JORNADA,
  funcaoFechadaCitada, vagaCitadaExata,
} from './brain.js'
import { conversar, montarFatos, iaDisponivel } from './ia.js'
import { vagasAtuais, cidadesAtuais } from './catalogo.js'
import { norm } from './texto.js'
import { cpfValido } from './ia-documento.js'

/**
 * Quantas mensagens da conversa mandar junto.
 *
 * Eram 20, e em 12/09/2026 17 das 39 conversas já batiam no limite: o que a
 * pessoa respondeu no começo saía da vista do modelo, e ele perguntava de
 * novo. Quarenta cobre a ficha inteira com folga. E o que foi respondido não
 * depende mais disso — vai à parte, em oQueJaSabe().
 */
const LIMITE_HISTORICO = 40

/** Nome da empresa, como ela se apresenta. Mesmo valor que o prompt usa. */
const EMPRESA = process.env.EMPRESA_NOME || 'KE Engenharia'

const PRIMEIRA_MENSAGEM =
  `Oi! Aqui é a Maria Vitória, do RH da ${EMPRESA}. \n`
  + 'Vi que você tem interesse nas nossas vagas. Me conta: qual função você procura?'

/**
 * Confere um nome contra a lista real.
 *
 * O modelo é instruído a devolver o nome exato, mas instrução não é garantia
 * — ele pode devolver "pedreiro" minúsculo, com acento a mais, ou uma função
 * que ele achou razoável e que a empresa não tem.
 */
function conferir(valor, lista) {
  if (!valor || typeof valor !== 'string') return null
  const alvo = norm(valor)
  return lista.find(x => norm(x) === alvo) ?? null
}

function simNaoOuNulo(v) {
  if (v === 'sim') return true
  if (v === 'nao') return false
  return null
}

/**
 * Copia os campos que vieram preenchidos, mantendo os que já existiam.
 *
 * O modelo às vezes devolve vazio um campo que ele já tinha informado — e
 * vazio significa "ainda não sei", não "esqueça o que a pessoa disse".
 */
function manterPreenchidos(estado, saida, campos) {
  const out = {}
  for (const c of campos) {
    const novo = typeof saida[c] === 'string' ? saida[c].trim() : ''
    out[c] = novo || estado[c] || null
  }
  return out
}

/**
 * O que já se sabe desta pessoa, e o que ainda falta — dito ao modelo a cada
 * mensagem.
 *
 * A ficha era gravada, mas o modelo nunca a recebia: via só as últimas
 * mensagens. Em 12/09/2026 ele pediu o nome completo duas ou mais vezes em
 * 10 conversas, registro em carteira em 4, data de nascimento em 3 — a
 * pessoa já tinha respondido, só que longe demais para trás.
 *
 * Com a lista na frente dele, "nunca pergunte de novo" deixa de depender de
 * memória: é uma instrução com o dado do lado.
 *
 * Dado pessoal vai como "já informado", sem o valor. O modelo não precisa da
 * data de nascimento para não perguntá-la de novo.
 */
export function oQueJaSabe(estado = {}, { paradoHa = null, agora = new Date() } = {}) {
  const e = estado ?? {}
  const tem = (v) => v !== null && v !== undefined && String(v).trim() !== ''
  const sabido = []
  const falta = []

  // A ordem da falta é a ordem em que se pergunta (ver ia.js).
  if (tem(e.vaga)) sabido.push(`vaga: ${e.vaga}`)
  else falta.push('qual vaga interessa')

  if (tem(e.cidadeMora)) sabido.push(`mora em: ${e.cidadeMora}`)
  else falta.push('em qual cidade mora')

  if (tem(e.cidade)) sabido.push(`cidade onde quer trabalhar: ${e.cidade}`)
  else falta.push('em qual cidade quer trabalhar')

  if (tem(e.nome)) sabido.push(`nome completo: já informado (${String(e.nome).split(/\s+/)[0]})`)
  else falta.push('o nome completo')

  if (e.temExperiencia === true || e.temExperiencia === false || tem(e.tempoExperiencia)) {
    const quanto = tem(e.tempoExperiencia) ? ` (${e.tempoExperiencia})` : ''
    sabido.push(`experiência na função: ${e.temExperiencia === false ? 'não tem' : 'tem'}${quanto}`)
  } else {
    falta.push('se tem experiência na função, e quanto tempo')
  }

  if (e.temRegistro === true || e.temRegistro === false) {
    sabido.push(`registro em carteira na função: ${e.temRegistro ? 'sim' : 'não'}`)
  } else {
    falta.push('se já teve registro em carteira nesta função')
  }

  if (tem(e.dataNascimento)) sabido.push('data de nascimento: já informada')
  else falta.push('data de nascimento')

  if (tem(e.disponibilidadeInicio)) sabido.push(`pode começar: ${e.disponibilidadeInicio}`)
  else falta.push('quando pode começar')

  if (tem(e.aceitaOutrasObras)) sabido.push(`aceita obra em outra cidade: ${e.aceitaOutrasObras}`)
  else falta.push('se aceita trabalhar em obra de outra cidade')

  // Camisa e bota saíram da ficha (dono, 17/09/2026): metade das fichas
  // ficava incompleta, e esse dado só é usado na contratação.
  if (tem(e.tamanhoCamisa) && tem(e.tamanhoBota)) sabido.push('tamanho de camisa e bota: já informados')

  if (tem(e.contatoRecadoNome) || tem(e.contatoRecadoTelefone)) sabido.push('contato de recado: já informado')
  else falta.push('um contato de recado (nome e telefone de alguém)')

  // Estágio sem curso não é estágio (Lei 11.788): é obrigatório perguntar.
  if (/estagi/i.test(e.vaga ?? '')) {
    if (tem(e.cursoEstagio)) sabido.push(`curso: ${e.cursoEstagio}`)
    else falta.push('curso, semestre e horário da faculdade')
  }

  // O que ajuda quem contrata, se a conversa der (dono, 14/09/2026).
  const seDer = []
  const profissional = /pedreiro|carpinteiro/i.test(e.vaga ?? '')
  for (const [campo, rotulo, soProfissional] of [
    ['especialidade', 'especialidade', true], ['ultimaObra', 'última obra ou empresa', true],
    ['anosRegistro', 'tempo com registro', true], ['nrs', 'NRs', true],
    ['ferramentaPropria', 'ferramenta própria', true], ['conducao', 'como chega na obra', false],
  ]) {
    if (soProfissional && !profissional) continue
    if (tem(e[campo])) sabido.push(`${rotulo}: ${e[campo]}`)
    else seDer.push(rotulo)
  }
  if (tem(e.referenciaNome)) sabido.push('referência: já informada')
  else seDer.push('uma referência (nome e telefone de encarregado ou empresa anterior)')

  // CPF e RG: opcionais (regra do dono, 13/09/2026). Pede uma vez, depois do
  // nome, e não insiste. O número nunca vai para o modelo.
  const opcional = []
  if (tem(e.cpf) || e.cpfJaInformado) sabido.push('CPF: já informado')
  else if (e.recusouDocumentos) sabido.push('CPF e RG: preferiu não informar — NÃO peça de novo')
  else if (tem(e.nome)) opcional.push('CPF e RG, ou foto do documento — opcional, pedir uma vez só')

  // Deixar passar para o responsável ligar é o que separa quem só perguntava
  // de quem quer mesmo a vaga.
  if (e.confirmouInteresse === 'sim') sabido.push('deixou passar a ficha para o responsável ligar')
  else if (e.confirmouInteresse === 'nao') sabido.push('NÃO quis passar a ficha por enquanto — não insista')

  const partes = []

  if (agora) {
    const hora = Number(new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }).format(agora)) % 24
    const periodo = hora < 7 ? 'MADRUGADA' : hora < 12 ? 'manhã' : hora < 19 ? 'tarde' : 'NOITE'
    partes.push(`AGORA SÃO ${String(hora).padStart(2, '0')}h em Brasília (${periodo}).`
      + (hora < 7 || hora >= 19 ? ' Não prometa ligação para hoje: o responsável liga no horário comercial.' : ''))
  }

  if (paradoHa && paradoHa > 6 * 3600_000) {
    const horas = Math.round(paradoHa / 3600_000)
    const quando = horas < 48 ? `${horas} horas` : `${Math.round(horas / 24)} dias`
    partes.push(
      `A PESSOA FICOU ${quando.toUpperCase()} SEM RESPONDER E VOLTOU AGORA. Continue de onde\n`
      + 'parou: não se apresente de novo, não recomece e não repita pergunta respondida.',
    )
  }

  partes.push(sabido.length
    ? `O QUE VOCÊ JÁ SABE DESTA PESSOA — está confirmado, NUNCA pergunte de novo:\n${sabido.map(x => `- ${x}`).join('\n')}`
    : 'Você ainda não sabe nada desta pessoa.')

  partes.push(falta.length
    ? `AINDA FALTA SABER (pergunte só a próxima, uma coisa por vez):\n${falta.map(x => `- ${x}`).join('\n')}`
    : 'A FICHA ESTÁ COMPLETA. Não faça mais nenhuma pergunta de ficha. Responda só o que\n'
      + 'a pessoa perguntar; se ela só agradecer ou se despedir, responda curto e encerre.')

  if (seDer.length && tem(e.nome)) {
    partes.push(`SE A CONVERSA DER (sem alongar, ligado ao que ela contou):\n${seDer.map(x => `- ${x}`).join('\n')}`)
  }

  if (opcional.length) {
    partes.push(`OPCIONAL (peça uma vez, sem insistir; se ela não quiser, siga):\n${opcional.map(x => `- ${x}`).join('\n')}`)
  }

  return { sabido, falta, opcional, seDer, texto: partes.join('\n\n') }
}

/** Um nome completo de verdade tem nome e sobrenome, e não é frase. */
function nomeValido(n) {
  if (!n || typeof n !== 'string') return null
  const limpo = n.trim()
  if (!/^[a-zà-ÿ' ]+$/i.test(limpo.normalize('NFC'))) return null
  const partes = limpo.split(/\s+/).filter(p => p.length >= 2)
  return partes.length >= 2 ? limpo : null
}

/**
 * Traduz o que a Maria Vitória já coletou para o estado do roteiro.
 *
 * Sem isto, o roteiro recomeçaria da primeira pergunta e perguntaria a vaga
 * de novo para quem já respondeu — que é a forma mais rápida de fazer o
 * candidato desistir.
 */
function estadoDeRoteiro(estado) {
  const base = {
    whatsapp: estado.whatsapp,
    tentativasVaga: 0,
    vaga: estado.vaga ?? null,
    cidade: estado.cidade ?? null,
    temExperiencia: estado.temExperiencia ?? null,
    temRegistro: estado.temRegistro ?? null,
    nome: estado.nome ?? null,
  }
  if (!base.vaga) return { ...base, etapa: 'vaga' }
  if (!base.cidade) return { ...base, etapa: 'cidade' }
  if (!base.nome) return { ...base, etapa: 'nome' }
  if (base.temExperiencia === null) return { ...base, etapa: 'experiencia' }
  if (base.temRegistro === null) return { ...base, etapa: 'registro' }

  // Tudo essencial já coletado. Sem este caso o roteiro caía em 'nome' e
  // pedia o nome completo de quem já tinha dado o nome três mensagens antes —
  // que é a forma mais rápida de a pessoa achar que ninguém está prestando
  // atenção.
  return { ...base, etapa: 'fim' }
}

export function iniciarAtendimento(whatsapp) {
  if (!iaDisponivel()) return iniciarRoteiro(whatsapp)

  const estado = {
    modo: 'ia',
    whatsapp,
    historico: [{ de: 'maria', texto: PRIMEIRA_MENSAGEM }],
  }
  return { estado, resposta: PRIMEIRA_MENSAGEM }
}

/**
 * Conduz uma mensagem. Mesmo contrato do roteiro, para o server não precisar
 * saber quem está atendendo:
 *   { estado, resposta, escalarHumano?, acao? }
 */
export async function atender(estado, mensagem, { paradoHa = null } = {}) {
  // Conversa que começou no roteiro continua nele: trocar de atendente no
  // meio faria a Maria Vitória aparecer sem saber o que já foi conversado.
  if (!iaDisponivel() || estado?.modo !== 'ia') {
    return responderRoteiro(estado, mensagem)
  }

  // "Recomeçar" vale também com a Maria Vitória.
  //
  // O comando era tratado só no roteiro, mas quem oferece o comando é a
  // mensagem de retomada do servidor — que aparece justamente quando a IA
  // está atendendo, que é o padrão. A pessoa escrevia "recomeçar", a
  // mensagem ia para o modelo como uma frase qualquer, e nada recomeçava.
  //
  // Quem reconhece o pedido é o brain, para o vocabulário aceito ("reiniciar",
  // "começar de novo", "cancelar tudo") não existir escrito em dois lugares
  // e passar a divergir.
  if (ehReset(mensagem)) return iniciarAtendimento(estado?.whatsapp)

  const vagas = vagasAtuais()
  const cidades = cidadesAtuais()
  const historico = [
    ...(estado.historico ?? []),
    { de: 'candidato', texto: mensagem },
  ].slice(-LIMITE_HISTORICO)

  const fatos = montarFatos({ vagas, cidades, jornada: JORNADA })
  // O que já foi respondido vai à parte, e não só no histórico: ver oQueJaSabe().
  const conhecido = oQueJaSabe(estado, { paradoHa }).texto
  const saida = await conversar({ historico, fatos, conhecido })

  if (!saida) {
    // Ela não respondeu. O roteiro atende ESTA mensagem, mas a conversa
    // continua sendo dela.
    //
    // Uma falha não pode rebaixar a conversa para sempre: medido contra o
    // Gemini, cerca de uma em cada cinco requisições trava, então desistir
    // na primeira faria quase toda conversa terminar no roteiro — que é
    // exatamente o que se estava tentando substituir. Só depois de três
    // falhas seguidas é que se assume que ela está fora do ar.
    const falhas = (estado.falhasIA ?? 0) + 1
    const r = responderRoteiro(estadoDeRoteiro(estado), mensagem)

    // O que a pessoa disse ENTRA no histórico mesmo com a falha.
    //
    // Antes ficava de fora, e o efeito era perder dado: numa conversa real, o
    // candidato mandou o nome completo exatamente no turno em que a IA travou.
    // O roteiro respondeu outra coisa, a mensagem sumiu, e ela pediu o nome de
    // novo depois. Guardando, a próxima resposta dela já enxerga o que foi
    // dito durante a queda.
    const historicoComQueda = [
      ...historico,
      { de: 'maria', texto: r.resposta },
    ].slice(-LIMITE_HISTORICO)

    return {
      ...r,
      estado: falhas >= 3
        ? { ...r.estado, modo: 'roteiro' }
        : { ...estado, ...r.estado, modo: 'ia', falhasIA: falhas, historico: historicoComQueda },
    }
  }

  // ── Confere tudo que ela diz ter entendido ────────────────────────────

  // A pessoa citou uma função que não está aberta, e nenhuma vaga aberta por
  // inteiro: a vaga que o modelo "entendeu" neste turno não vale. Ele tende a
  // escolher a mais parecida da lista — mestre de obras não é pedreiro.
  const vagaDoModelo = conferir(saida.vaga, vagas.map(v => v.nome))
  const trocouAFuncao = Boolean(funcaoFechadaCitada(mensagem)) && !vagaCitadaExata(mensagem)
    && vagaDoModelo && vagaDoModelo !== estado.vaga

  const novo = {
    ...estado,
    falhasIA: 0,
    historico: [...historico, { de: 'maria', texto: saida.resposta }].slice(-LIMITE_HISTORICO),
    vaga:   (trocouAFuncao ? null : vagaDoModelo) ?? estado.vaga ?? null,
    cidade: conferir(saida.cidade, cidades.map(c => c.nome)) ?? estado.cidade ?? null,
    temExperiencia: simNaoOuNulo(saida.temExperiencia) ?? estado.temExperiencia ?? null,
    temRegistro:    simNaoOuNulo(saida.temRegistro) ?? estado.temRegistro ?? null,
    nome: nomeValido(saida.nomeCompleto) ?? estado.nome ?? null,
    // CPF só vale com dígito verificador certo: número digitado errado não
    // vira cadastro único de ninguém.
    cpf: cpfValido(saida.cpf) ? String(saida.cpf).replace(/\D/g, '') : estado.cpf ?? null,
    rg: /^[\dXx.\-\s]{5,15}$/.test(saida.rg?.trim() ?? '') ? saida.rg.trim() : estado.rg ?? null,
    recusouDocumentos: saida.recusouDocumentos === true || Boolean(estado.recusouDocumentos),
    resumo: saida.resumoExperiencia?.trim() || estado.resumo || null,
    // Campos da ficha, em texto livre: valem como a pessoa falou, e quem
    // confere é o RH ao chamar para entrevista.
    ...manterPreenchidos(estado, saida, [
      'tempoExperiencia', 'bairro', 'cidadeMora', 'cep', 'dataNascimento',
      'disponibilidadeInicio', 'tamanhoCamisa', 'tamanhoBota',
      'contatoRecadoNome', 'contatoRecadoTelefone',
      'especialidade', 'ultimaObra', 'anosRegistro', 'nrs', 'ferramentaPropria', 'conducao', 'cursoEstagio', 'referenciaNome', 'referenciaTelefone',
    ]),
    aceitaOutrasObras: saida.aceitaOutrasObras && saida.aceitaOutrasObras !== 'nao_sei'
      ? saida.aceitaOutrasObras
      : estado.aceitaOutrasObras ?? null,
    confirmouInteresse: saida.confirmouInteresse && saida.confirmouInteresse !== 'nao_sei'
      ? saida.confirmouInteresse
      : estado.confirmouInteresse ?? null,
  }

  // Perguntar se é um sistema sempre chama gente: é o momento em que a
  // pessoa quer falar com alguém de verdade, e é o que o RH pediu para saber.
  const perguntouSeEhIA = Boolean(saida.perguntouSeEhIA)

  const resultado = {
    estado: novo,
    resposta: saida.resposta,
    escalarHumano: Boolean(saida.precisaHumano) || perguntouSeEhIA,
    motivoEscalada: perguntouSeEhIA ? 'perguntou_se_e_ia' : 'pediu_atendimento',
    ultimaMensagem: mensagem,
  }

  // ── Registra assim que tem o ESSENCIAL, e reenvia a cada dado novo ─────
  //
  // A ficha completa tem onze perguntas, e ninguém responde onze perguntas no
  // WhatsApp sem desistir no meio. Guardando só no fim, todo mundo que
  // abandona na sétima vira nada. Assim, quem para no meio fica registrado
  // com o que deu, e quem vai até o fim tem a ficha inteira — o RH decide se
  // vale ligar.
  //
  // Quem grava é o RH: a segunda chamada do mesmo número atualiza em vez de
  // duplicar (ver /api/integracao/candidatura).
  //
  // O essencial é nome, vaga e cidade. Sem isso a candidatura chega ao RH
  // como linha inútil, e alguém liga para um número perguntando coisas que a
  // pessoa já respondeu.
  const temEssencial = novo.nome && novo.vaga && novo.cidade
  if (temEssencial) {
    resultado.estado = { ...novo, registrado: true }
    resultado.acao = {
      tipo: 'criar_candidatura',
      primeiraVez: !estado.registrado,
      dados: {
        nomeCompleto: novo.nome,
        vagaPretendida: novo.vaga,
        cidadePreferencia: novo.cidade,
        whatsapp: novo.whatsapp ?? null,
        tempoExperiencia: novo.tempoExperiencia
          || (novo.temExperiencia === true ? 'Com experiência'
            : novo.temExperiencia === false ? 'Sem experiência' : null),
        bairro: novo.bairro ?? null,
        cidade: novo.cidadeMora ?? null,
        cep: novo.cep ?? null,
        dataNascimento: novo.dataNascimento ?? null,
        disponibilidadeInicio: novo.disponibilidadeInicio ?? null,
        aceitaOutrasObras: novo.aceitaOutrasObras === 'sim' ? 'Sim'
          : novo.aceitaOutrasObras === 'nao' ? 'Não' : null,
        tamanhoCamisa: novo.tamanhoCamisa ?? null,
        tamanhoBota: novo.tamanhoBota ?? null,
        contatoRecadoNome: novo.contatoRecadoNome ?? null,
        contatoRecadoTelefone: novo.contatoRecadoTelefone ?? null,
        cpf: novo.cpf ?? null,
        rg: novo.rg ?? null,
        confirmouInteresse: novo.confirmouInteresse === 'sim' ? 'Sim'
          : novo.confirmouInteresse === 'nao' ? 'Não' : null,
        especialidade: novo.especialidade ?? null,
        ultimaObra: novo.ultimaObra ?? null,
        anosRegistro: novo.anosRegistro ?? null,
        nrs: novo.nrs ?? null,
        ferramentaPropria: novo.ferramentaPropria ?? null,
        conducao: novo.conducao ?? null,
        cursoEstagio: novo.cursoEstagio ?? null,
        referenciaNome: novo.referenciaNome ?? null,
        referenciaTelefone: novo.referenciaTelefone ?? null,
        resumoExperiencia: [
          'Conversa por WhatsApp (Maria Vitória).',
          novo.resumo,
          novo.temRegistro === true ? 'Já teve registro em carteira na função.'
            : novo.temRegistro === false ? 'Nunca teve registro na função.' : null,
        ].filter(Boolean).join(' '),
        dadosBrutos: { origem: 'whatsapp-bot', historico: novo.historico },
      },
    }
    resultado.respostaFalha =
      `${saida.resposta}\n\n(Tive um probleminha para salvar aqui no sistema. ` +
      'Já avisei a equipe, pode deixar que a gente registra.)'
  }

  return resultado
}
