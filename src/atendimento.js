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
  funcaoFechadaCitada, vagaCitadaExata, responderFAQ,
} from './brain.js'
import { conversar, montarFatos, iaDisponivel } from './ia.js'
import { vagasAtuais, cidadesAtuais, perguntaExperiencia } from './catalogo.js'
import { proibidoNaConversa, FRASE_SEGURA } from './resposta-segura.js'
import { fraseDeRegistro, PREFIXO_RESUMO } from './ficha-rh.js'
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
 * Duas cidades são a mesma?
 *
 * A cidade onde a pessoa mora vem em texto livre do modelo, do jeito que ela
 * escreveu: "Peruibe" sem acento, "Bastos - SP" com a UF colada. A comparação
 * era só toLowerCase(), então "Peruibe" e "Peruíbe" eram cidades diferentes —
 * e quem mora na própria cidade da obra ouvia a pergunta de ficar longe de
 * casa sem ter saído de casa.
 */
function mesmaCidade(a, b) {
  const soONome = (c) => norm(String(c ?? '').split(/\s+-\s+|\//)[0])
  const x = soONome(a)
  return Boolean(x) && x === soONome(b)
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
 * O que o robô percebeu da pessoa, acumulado entre as mensagens.
 *
 * O modelo vê o que já foi percebido e costuma devolver tudo de novo, às
 * vezes com um detalhe a mais. Juntar às cegas repetia o mesmo texto a cada
 * mensagem ("animado; animado, quer começar já; ..."). Se o novo já contém o
 * antigo, o novo substitui; se não, acrescenta.
 */
export function juntarSinais(antes, agora) {
  const a = String(antes ?? '').trim()
  const n = String(agora ?? '').trim()
  if (!n) return a || null
  if (!a || n.toLowerCase().includes(a.toLowerCase())) return n.slice(0, 400)
  if (a.toLowerCase().includes(n.toLowerCase())) return a
  return `${a}; ${n}`.slice(-400)
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
  //
  // A CIDADE ONDE A PESSOA MORA vem primeiro (dono, 17/09/2026, commit
  // 83579c3): é ela que decide quase tudo — ajudante só se contrata na
  // cidade da obra, e alojamento só existe em duas cidades. O commit mudou o
  // prompt e o roteiro, mas esta lista continuava pedindo a vaga primeiro, e
  // o modelo recebia duas ordens opostas na mesma mensagem.
  if (tem(e.cidadeMora)) sabido.push(`mora em: ${e.cidadeMora}`)
  else falta.push('em qual cidade mora')

  if (tem(e.vaga)) sabido.push(`vaga: ${e.vaga}`)
  else falta.push('qual vaga interessa')

  if (tem(e.cidade)) sabido.push(`cidade onde quer trabalhar: ${e.cidade}`)
  else falta.push('em qual cidade quer trabalhar')

  if (tem(e.nome)) sabido.push(`nome completo: já informado (${String(e.nome).split(/\s+/)[0]})`)
  else falta.push('o nome completo')

  // Estágio não tem experiência na função nem registro em carteira: quem
  // estagia está começando, e estágio não é vínculo de carteira (Lei 11.788).
  // Perguntar as duas coisas a um estudante é conversa que não leva a nada —
  // o que decide o estágio é o curso, logo abaixo.
  const ehEstagio = /estagi/i.test(e.vaga ?? '')

  if (e.temExperiencia === true || e.temExperiencia === false || tem(e.tempoExperiencia)) {
    const quanto = tem(e.tempoExperiencia) ? ` (${e.tempoExperiencia})` : ''
    sabido.push(`experiência na função: ${e.temExperiencia === false ? 'não tem' : 'tem'}${quanto}`)
  } else if (!ehEstagio) {
    falta.push('se tem experiência na função, e quanto tempo')
  }

  if (e.temRegistro === true || e.temRegistro === false) {
    sabido.push(`registro em carteira na função: ${e.temRegistro ? 'sim' : 'não'}`)
  } else if (!ehEstagio) {
    falta.push('se já teve registro em carteira nesta função')
  }

  if (tem(e.dataNascimento)) sabido.push('data de nascimento: já informada')
  else falta.push('data de nascimento')

  if (tem(e.disponibilidadeInicio)) sabido.push(`pode começar: ${e.disponibilidadeInicio}`)
  else falta.push('quando pode começar')

  // Obra em outra cidade não se pergunta a AJUDANTE.
  //
  // A empresa só contrata servente/ajudante na cidade onde ele mora (dono,
  // 12/09/2026). A pergunta ia assim mesmo, e o "Sim" chegava à ficha do RH:
  // uma disponibilidade registrada que a empresa não tem como aproveitar, e
  // uma expectativa criada por escrito no celular da pessoa.
  const ehAjudante = /servente|ajudante/i.test(e.vaga ?? '')
  if (tem(e.aceitaOutrasObras)) sabido.push(`aceita obra em outra cidade: ${e.aceitaOutrasObras}`)
  else if (!ehAjudante) falta.push('se aceita trabalhar em obra de outra cidade')

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

  /*
    Quem mandou a foto do documento não é mandado mandar a foto do documento.

    receberDocumento() grava `documentos`, `cpf` e `rg` no estado, e a ficha do
    RH traz `rgJaInformado` — e nada disso era olhado aqui: só `cpf` e
    `cpfJaInformado`. Quem mandava a foto de um RG antigo, sem CPF impresso
    (ou quando a leitura automática falhava), ouvia em seguida "manda foto do
    documento". O comentário do server ("não pede CPF de quem acabou de mandar
    o RG") prometia o contrário.
  */
  const mandouDocumento = tem(e.rg) || Boolean(e.rgJaInformado) || (e.documentos?.length ?? 0) > 0
  if (mandouDocumento) sabido.push('mandou foto de documento')

  if (tem(e.cpf) || e.cpfJaInformado) sabido.push('CPF: já informado')
  else if (e.recusouDocumentos) sabido.push('CPF e RG: preferiu não informar — NÃO peça de novo')
  else if (mandouDocumento) {
    // A foto chegou mas não trouxe o número: pede só o número, uma vez.
    opcional.push('só o NÚMERO do CPF, se ela quiser — a foto do documento já chegou, não peça de novo')
  } else if (tem(e.nome)) opcional.push('CPF e RG, ou foto do documento — opcional, pedir uma vez só')

  // O que o recrutador já conferiu: não pergunta de novo.
  if (e.avaliacaoTecnica) sabido.push(`já conferiu o que sabe fazer (${e.avaliacaoTecnica})`)
  // Estágio não tem pergunta de obra: o que decide é o curso.
  else if (tem(e.vaga) && tem(e.nome) && !/estagi/i.test(e.vaga)) falta.push('uma ou duas perguntas do que sabe fazer na função')
  /*
    Alojamento só se pergunta onde ele existe.

    A condição olhava só "é pedreiro" e "mora em outra cidade", sem conferir
    se a cidade DA OBRA tem alojamento. Um pedreiro de Marília que escolhia
    Buritama era perguntado se aceita ficar no alojamento — de uma cidade que
    não tem alojamento nenhum. Ele podia chegar lá achando que tinha onde
    dormir, contra a regra do dono (alojamento só em Bastos e Pereiras).

    Onde não há alojamento a pergunta continua existindo, com outro texto: o
    que o RH precisa saber é a mesma coisa — se o pedreiro de fora realmente
    consegue vir e ficar. Por isso a resposta vai no MESMO campo
    alojamentoFirme, e o selo "pronto para ligar" do RH continua acendendo.
  */
  if (/pedreiro/i.test(e.vaga ?? '') && tem(e.cidadeMora) && tem(e.cidade)
    && !mesmaCidade(e.cidadeMora, e.cidade)) {
    const cidadeDaObra = cidadesAtuais().find(c => mesmaCidade(c.nome, e.cidade))
    if (e.alojamentoFirme) sabido.push(`disponibilidade real de ficar longe de casa: ${e.alojamentoFirme}`)
    else if (cidadeDaObra?.alojamento) falta.push('se tem disponibilidade REAL de ficar no alojamento, longe de casa')
    else falta.push(`se consegue chegar e se manter em ${e.cidade} por conta própria (lá não tem alojamento)`)
  }
  if (tem(e.sinais)) sabido.push(`o que você já percebeu dela: ${e.sinais}`)

  // Disse uma função que não está aberta: o modelo precisa saber, ou registra
  // a vaga mais parecida no lugar dela (ver a marca funcaoFechada em atender).
  if (tem(e.funcaoFechada)) {
    sabido.push(`disse que é ${e.funcaoFechada}, e NÃO temos essa vaga aberta — diga isso e`
      + ' ofereça as vagas que estão abertas; nunca registre outra função no lugar')
  }

  // Deixar passar para o responsável ligar é o que separa quem só perguntava
  // de quem quer mesmo a vaga.
  const jaPerguntouALigacao = (e.historico ?? []).some(m =>
    m?.de === 'maria' && /passar sua ficha|respons[aá]vel te ligar/i.test(m.texto ?? ''))
  if (e.confirmouInteresse === 'sim') sabido.push('deixou passar a ficha para o responsável ligar')
  else if (e.confirmouInteresse === 'nao') sabido.push('NÃO quis passar a ficha por enquanto — não insista')
  else if (jaPerguntouALigacao) sabido.push('já perguntou se pode passar a ficha — não pergunte de novo')

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

  /*
    Ficha completa, mas ainda sem a confirmação de que pode passar para ligar.

    O bloco dizia "A FICHA ESTÁ COMPLETA. Não faça mais nenhuma pergunta de
    ficha" — uma ordem mais direta, e mais perto do fim do prompt, do que a
    regra fixa ("pergunte UMA vez se pode passar para o responsável ligar",
    ia.js). O modelo obedecia à última: confirmouInteresse ficava nulo, e o
    selo "pronto para ligar" do RH, que exige essa resposta, não acendia — o
    gestor via "confirmar que quer a ligação" em ficha atrás de ficha.

    A confirmação NÃO entra em `falta`, de propósito: quem deixa de responder
    aqui é a pessoa, e o lembrete de cadastro (que olha falta.length) passaria
    a cobrar "não terminamos seu cadastro" de quem já terminou. E entrando em
    falta, o modelo repetiria a pergunta a cada turno, contra o "não insista".
  */
  const faltaConfirmarALigacao = !falta.length && !e.confirmouInteresse && !jaPerguntouALigacao

  partes.push(falta.length
    ? `AINDA FALTA SABER (pergunte só a próxima, uma coisa por vez):\n${falta.map(x => `- ${x}`).join('\n')}`
    : faltaConfirmarALigacao
      ? 'A FICHA ESTÁ COMPLETA. Falta só UMA coisa: pergunte uma vez "posso passar sua ficha\n'
        + 'pro responsável te ligar?" e registre a resposta em confirmouInteresse. Depois disso\n'
        + 'não faça mais nenhuma pergunta de ficha.'
      : 'A FICHA ESTÁ COMPLETA. Não faça mais nenhuma pergunta de ficha. Responda só o que\n'
        + 'a pessoa perguntar; se ela só agradecer ou se despedir, responda curto e encerre.')

  // Com a ficha completa não se puxa mais assunto: o bloco abaixo convidava a
  // perguntar mais coisas logo depois de mandar parar de perguntar.
  if (seDer.length && tem(e.nome) && falta.length) {
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
    // Sem isto o roteiro não sabia se a vaga pede experiência: depois da
    // cidade ele ia direto para o nome, e a ficha chegava ao RH sem o
    // registro em carteira — o dado que decide a faixa salarial.
    vagaProfissional: perguntaExperiencia(estado.vaga),
    // Levado junto para o roteiro não repetir a frase de escalada a cada
    // falha do modelo: o estado era montado do zero e esta marca se perdia.
    avisouPosFicha: Boolean(estado.avisouPosFicha),
  }
  if (!base.vaga) return { ...base, etapa: 'vaga' }
  if (!base.cidade) return { ...base, etapa: 'cidade' }
  // Experiência e registro ANTES do nome, quando a vaga tem faixa: é o que
  // decide entre o salário inicial e o teto, e é o que o RH precisa ter.
  if (base.vagaProfissional && base.temExperiencia === null) return { ...base, etapa: 'experiencia' }
  if (base.vagaProfissional && base.temRegistro === null) return { ...base, etapa: 'registro' }
  if (!base.nome) return { ...base, etapa: 'nome' }
  if (base.temExperiencia === null) return { ...base, etapa: 'experiencia' }
  if (base.temRegistro === null) return { ...base, etapa: 'registro' }

  // Tudo essencial já coletado. Sem este caso o roteiro caía em 'nome' e
  // pedia o nome completo de quem já tinha dado o nome três mensagens antes —
  // que é a forma mais rápida de a pessoa achar que ninguém está prestando
  // atenção.
  return { ...base, etapa: 'fim' }
}

/**
 * Quanto tempo a conversa fica no roteiro depois de três falhas seguidas.
 *
 * A queda quase sempre é a cota do Gemini, que devolve null na hora por dez
 * minutos. Sem prazo de volta, três mensagens dentro desses dez minutos
 * prendiam a conversa no roteiro pelo resto do TTL — três dias — mesmo com a
 * Maria Vitória de volta minutos depois.
 */
const VOLTAR_IA_MS = 10 * 60 * 1000

/**
 * A pergunta fixa de cada item da ficha, para quando o modelo está fora.
 *
 * [ trecho do item em `falta`, como a pergunta já feita se parece, a pergunta ]
 *
 * O segundo campo existe porque `falta` é calculado com o estado de ANTES da
 * mensagem: o primeiro item costuma ser exatamente o que a pessoa acabou de
 * responder, e perguntar de novo é o jeito mais rápido de ela achar que
 * ninguém leu.
 *
 * "uma ou duas perguntas do que sabe fazer" não está aqui de propósito: quem
 * deixa de fazer essa é o robô, não a pessoa.
 */
const PERGUNTAS_DA_QUEDA = [
  ['em qual cidade mora', /mora/i, 'em qual cidade vc mora?'],
  ['qual vaga interessa', /fun[çc][ãa]o|vaga/i, 'qual função vc procura?'],
  ['em qual cidade quer trabalhar', /cidade/i, 'em qual das nossas cidades vc quer trabalhar?'],
  ['o nome completo', /nome/i, 'qual seu nome completo?'],
  ['se tem experiência na função', /experi[êe]ncia/i, 'vc tem experiência na função? quanto tempo?'],
  ['registro em carteira', /registro|carteira/i, 'vc já teve registro em carteira nessa função?'],
  ['data de nascimento', /nascimento|nasceu/i, 'qual sua data de nascimento?'],
  ['quando pode começar', /come[çc]ar/i, 'quando vc pode começar?'],
  ['obra de outra cidade', /outra cidade/i, 'vc aceita trabalhar em obra de outra cidade?'],
  ['contato de recado', /recado/i, 'me passa um contato de recado? nome e telefone de alguém'],
  ['curso, semestre', /curso|faculdade/i, 'qual curso vc faz, que semestre e qual horário?'],
  ['ficar no alojamento', /alojamento/i, 'vc tem disponibilidade de ficar no alojamento durante a semana?'],
  ['se manter em', /se manter/i, 'vc consegue chegar e se manter nessa cidade por conta própria?'],
]

/**
 * O que responder quando o modelo caiu e o roteiro não tem mais o que perguntar.
 *
 * Sem isto, o `default` do roteiro respondia "sua ficha já está com o rh. vou
 * pedir pra alguém te responder por aqui" — com escalarHumano — para quem só
 * estava respondendo a ficha. O candidato ficava esperando uma pessoa que
 * ninguém chamou, e o `escalouEm` gravado no store desligava para sempre o
 * lembrete de cadastro daquela conversa.
 *
 * Aqui não se escala e não se promete ninguém: a mensagem dela já fica no
 * histórico, e a Maria Vitória a lê no turno seguinte.
 */
function respostaDeQueda(estado, mensagem) {
  const faq = responderFAQ(mensagem, estado)
  if (faq) return { estado, resposta: faq.texto, escalarHumano: Boolean(faq.escalar) }

  const ultimaDaMaria = [...(estado.historico ?? [])].reverse()
    .find(m => m?.de === 'maria')?.texto ?? ''

  for (const item of oQueJaSabe(estado).falta) {
    const achado = PERGUNTAS_DA_QUEDA.find(([trecho]) => item.includes(trecho))
    if (!achado) continue
    const [, jaPerguntada, pergunta] = achado
    if (jaPerguntada.test(ultimaDaMaria)) continue
    return { estado, resposta: `anotado. ${pergunta}` }
  }
  return { estado, resposta: 'anotado' }
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
  /*
    Conversa rebaixada por queda da IA volta para a Maria Vitória.

    A queda de três falhas é quase sempre a cota do Gemini, que volta em
    minutos; a conversa é que não voltava, e seguia no roteiro pelos três dias
    de TTL. Quem começou no roteiro puro não tem `voltarIAEm` e continua nele:
    trocar de atendente no meio faria a Maria Vitória aparecer sem saber o que
    já foi conversado.
  */
  if (estado?.modo === 'roteiro' && estado.voltarIAEm
    && Date.now() >= estado.voltarIAEm && iaDisponivel()) {
    estado = { ...estado, modo: 'ia', falhasIA: 0, voltarIAEm: null }
  }

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
    const doRoteiro = estadoDeRoteiro(estado)
    /*
      Com o essencial já coletado o roteiro não tem o que perguntar, e o
      `default` dele chama gente e diz "sua ficha já está com o rh" — para
      quem só estava respondendo a ficha. Ver respostaDeQueda().
    */
    const r = doRoteiro.etapa === 'fim'
      ? respostaDeQueda(estado, mensagem)
      : responderRoteiro(doRoteiro, mensagem)

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
        ? {
            /*
              Rebaixar não pode APAGAR a ficha.

              Era `{ ...r.estado, modo: 'roteiro' }`, e o estado do roteiro tem
              sete campos: sumiam historico, cidadeMora, dataNascimento,
              sinais, recusouDocumentos, avaliacaoTecnica e alojamentoFirme. Com
              a cota do Gemini estourada (66 vezes em 12/09/2026), três
              mensagens dentro dos dez minutos de espera bastavam.
            */
            ...estado, ...r.estado, modo: 'roteiro',
            historico: historicoComQueda,
            voltarIAEm: Date.now() + VOLTAR_IA_MS,
          }
        : { ...estado, ...r.estado, modo: 'ia', falhasIA: falhas, historico: historicoComQueda },
    }
  }

  // ── Confere tudo que ela diz ter entendido ────────────────────────────

  /*
    A função fechada dita fica MARCADA na conversa, e não só no turno.

    A trava olhava apenas a mensagem da vez. Testado com o modelo simulado:
    turno 1 "sou mestre de obras, 20 anos" com o modelo devolvendo "Pedreiro"
    → a vaga fica null, a trava funciona. Turno 2 "moro em bastos", o modelo
    repete "Pedreiro" (o ESQUEMA manda repetir o que já sabe) → a vaga vira
    Pedreiro, e no turno 3 sai criar_candidatura de Pedreiro. É exatamente o
    caso de 12/09/2026 que o dono pediu para não acontecer, e o alerta
    "Função não aberta" do RH não pega, porque a ficha chega já como Pedreiro.

    A marca só sai quando a pessoa disser uma vaga ABERTA por inteiro.
  */
  const abertaNestaMensagem = vagaCitadaExata(mensagem)
  const funcaoFechada = abertaNestaMensagem
    ? null
    : funcaoFechadaCitada(mensagem) ?? estado.funcaoFechada ?? null

  // Enquanto a marca estiver de pé, a vaga que o modelo devolve não vale: ele
  // tende a escolher a mais parecida da lista — mestre de obras não é pedreiro.
  const vagaDoModelo = conferir(saida.vaga, vagas.map(v => v.nome))
  const vagaConferida = funcaoFechada && vagaDoModelo !== estado.vaga ? null : vagaDoModelo

  /*
    ── A barreira de saída da conversa ────────────────────────────────────

    Até aqui nada conferia o que a Maria Vitória escreve — e é o texto que
    fica no celular da pessoa. As regras do dono (nunca dizer quando o
    registro é feito, nada de PIS/conta/PIX por chat, nada de link, nunca
    prometer adiantar passagem) existiam só como instrução no prompt.
    Ver proibidoNaConversa().
  */
  const proibido = proibidoNaConversa(saida.resposta)
  if (proibido.length) {
    console.warn(`[atendimento] resposta barrada (${proibido.join(', ')}) — chamando gente.`)
  }
  // O histórico guarda o que FOI ENVIADO: guardando a frase descartada, o
  // modelo a leria no turno seguinte e a repetiria.
  const resposta = proibido.length ? FRASE_SEGURA : saida.resposta

  const novo = {
    ...estado,
    falhasIA: 0,
    funcaoFechada,
    historico: [...historico, { de: 'maria', texto: resposta }].slice(-LIMITE_HISTORICO),
    vaga:   vagaConferida ?? estado.vaga ?? null,
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
      'respostasTecnicas', 'indicadoPor',
    ]),
    aceitaOutrasObras: saida.aceitaOutrasObras && saida.aceitaOutrasObras !== 'nao_sei'
      ? saida.aceitaOutrasObras
      : estado.aceitaOutrasObras ?? null,
    confirmouInteresse: saida.confirmouInteresse && saida.confirmouInteresse !== 'nao_sei'
      ? saida.confirmouInteresse
      : estado.confirmouInteresse ?? null,
    alojamentoFirme: saida.alojamentoFirme && saida.alojamentoFirme !== 'nao_sei'
      ? saida.alojamentoFirme
      : estado.alojamentoFirme ?? null,
    avaliacaoTecnica: saida.avaliacaoTecnica && saida.avaliacaoTecnica !== 'nao_sei'
      ? saida.avaliacaoTecnica
      : estado.avaliacaoTecnica ?? null,
    // O que se percebe acumula: um sinal da primeira conversa continua valendo.
    sinais: juntarSinais(estado.sinais, saida.sinais),
  }

  // Perguntar se é um sistema sempre chama gente: é o momento em que a
  // pessoa quer falar com alguém de verdade, e é o que o RH pediu para saber.
  const perguntouSeEhIA = Boolean(saida.perguntouSeEhIA)

  const resultado = {
    estado: novo,
    resposta,
    escalarHumano: Boolean(saida.precisaHumano) || perguntouSeEhIA || proibido.length > 0,
    motivoEscalada: proibido.length ? `resposta barrada: ${proibido.join(', ')}`
      : perguntouSeEhIA ? 'perguntou_se_e_ia' : 'pediu_atendimento',
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
    // `registrado` é marcado pelo SERVIDOR, depois de o RH confirmar. Marcar
    // aqui dizia que a ficha estava salva antes de saber se estava: com o RH
    // fora do ar, a conversa terminava com registrado=true e nada no RH.
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
        // Quem recusou não deve ouvir o pedido de novo, nem depois de 7 dias:
        // é o RH que guarda essa memória.
        recusouDocumentos: novo.recusouDocumentos ? 'Sim' : null,
        // A recusa de documento precisa sobreviver à conversa: sem ela no RH,
        // quem volta depois de 7 dias (quando a conversa já saiu do store)
        // ouve o pedido de CPF outra vez, contra a regra de pedir uma vez só.
        recusouDocumentos: novo.recusouDocumentos ? true : null,
        confirmouInteresse: novo.confirmouInteresse === 'sim' ? 'Sim'
          : novo.confirmouInteresse === 'nao' ? 'Não' : null,
        alojamentoFirme: { sim: 'Sim', nao: 'Não', duvida: 'Em dúvida' }[novo.alojamentoFirme] ?? null,
        avaliacaoTecnica: { boa: 'Boa', fraca: 'Fraca', nao_respondeu: 'Não respondeu' }[novo.avaliacaoTecnica] ?? null,
        respostasTecnicas: novo.respostasTecnicas ?? null,
        sinais: novo.sinais ?? null,
        indicadoPor: novo.indicadoPor ?? null,
        especialidade: novo.especialidade ?? null,
        ultimaObra: novo.ultimaObra ?? null,
        anosRegistro: novo.anosRegistro ?? null,
        nrs: novo.nrs ?? null,
        ferramentaPropria: novo.ferramentaPropria ?? null,
        conducao: novo.conducao ?? null,
        cursoEstagio: novo.cursoEstagio ?? null,
        referenciaNome: novo.referenciaNome ?? null,
        referenciaTelefone: novo.referenciaTelefone ?? null,
        // A frase de registro é a que o RH sabe ler, e é a MESMA do roteiro
        // (ver ficha-rh.js): é ela que vira a nota do critério Registro lá.
        resumoExperiencia: [
          PREFIXO_RESUMO,
          novo.resumo,
          fraseDeRegistro(novo.temRegistro),
        ].filter(Boolean).join(' '),
        dadosBrutos: { origem: 'whatsapp-bot', historico: novo.historico },
      },
    }
    /*
      Sem prometer que alguém já foi avisado.

      Dizia "Já avisei a equipe" e ninguém era avisado: o servidor só escrevia
      um console.warn. Agora o texto diz o que é verdade — ficou anotado aqui,
      e o servidor tenta de novo até dar certo (ver a fila de reenvio no
      server.js).
    */
    resultado.respostaFalha =
      `${resposta}\n\n(Tive um probleminha para salvar aqui no sistema, ` +
      'mas já anotei tudo aqui e a equipe vai ver seu cadastro.)'
  }

  return resultado
}
