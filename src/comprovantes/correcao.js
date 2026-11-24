/**
 * Comprovantes — corrigir pelo grupo um gasto que já foi lançado.
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 *
 * O robô lança, a pessoa olha a confirmação e vê que o valor saiu errado, ou
 * que era de outra obra. Antes o conserto era abrir o sistema, achar o gasto
 * na fila e editar — o tipo de coisa que fica para depois e acaba aprovada
 * errada. Agora basta CITAR o comprovante (ou a confirmação "✅ Lançado") e
 * escrever a correção:
 *
 *   valor 1800 · era 1.800,00        → o valor
 *   obra haia · é da haia            → a obra
 *   data 30/10                       → a data
 *   material · locação               → a categoria
 *   descrição areia lavada           → a descrição
 *   apagar · cancelar · lancei errado → cancela, depois de UMA confirmação
 *
 * ── As travas ────────────────────────────────────────────────────────────
 *
 * SEM CITAÇÃO, NADA DISTO DISPARA. "valor 1800" solto no grupo continua
 * sendo o que sempre foi — resposta a uma pergunta, ou nada. A citação é o
 * que diz, sem margem para engano, de qual gasto se está falando.
 *
 * Só corrige QUEM MANDOU o comprovante, ou alguém da lista de autorizados
 * por número. O coringa do grupo ("qualquer um do grupo lança") não basta:
 * lançar o próprio gasto é uma coisa, mexer no de outra pessoa é outra.
 *
 * Essa é a barreira DO ROBÔ, e é só a primeira. O sistema tem a dele, pela
 * regra da pessoa: o robô diz o telefone de quem pediu, e o sistema deixa
 * sócio mexer em qualquer gasto e os demais só no que é deles. As duas se
 * somam — passa quem passa nas duas. A do robô continua existindo porque há
 * casos em que o sistema não tem como saber quem pediu (telefone escondido
 * atrás de um "@lid", ou servidor de versão anterior): aí vale o token, que
 * enxerga tudo, e sem a barreira daqui qualquer um do grupo corrigiria o
 * gasto de qualquer outro.
 *
 * Só enquanto o gasto está PENDENTE. Depois de aprovado é despesa, e despesa
 * não se muda por mensagem — o sistema recusa, e o robô diz isso.
 *
 * Cancelar pede confirmação: é a única correção que tira um gasto da fila, e
 * um "apagar" citando a mensagem errada não pode custar um lançamento.
 *
 * Todo texto de resposta é fixo, escrito aqui. Nenhuma IA redige nada: quem
 * lê precisa poder confiar que "Corrigido: A → B" é exatamente o que foi
 * feito.
 */
import { acharValor, acharData, acharObra, categoriaEscrita, nomesDe } from './lancamento.js'
import { corrigirLancado, cancelarLancado, obrasConfigurado } from './obras-client.js'
import { obrasConhecidas } from './processar.js'
import { numeroNaLista, telefoneDeQuemMandou } from './autorizacao.js'
import { CONFIRMA_VALOR, NEGA_VALOR } from './perguntas.js'
import { moeda } from './formato.js'
import { discreto } from '../texto.js'
import * as pendentes from './pendentes.js'
import * as memoria from './memoria.js'

/** "apagar", "cancelar", "lancei errado" — sozinhos, ou apontando ("apaga esse"). */
const CANCELAR = /^\s*(apaga|apagar|cancela|cancelar|exclui|excluir|remove|remover|lancei errado|lan[cç]ou errado|lan[cç]ado errado|foi errado|errei)(\s+(isso|esse|este|ele|o lan[cç]amento|esse lan[cç]amento|este lan[cç]amento))?\s*[!.]*\s*$/i

/** O que vem antes do número em "valor 1800", "era 1.800,00", "o certo é 1800". */
const ROTULO_VALOR = /^\s*(o\s+)?(valor(\s+certo)?|certo|correto|era|foi|na verdade|corrig\w+(\s+o)?(\s+valor)?(\s+para)?)(\s+(é|e|era|foi))?\s*:?\s*/i

const ROTULO_DATA = /^\s*(a\s+)?(data|dia)(\s+(é|e|era|foi|certa))?\s*:?\s*(dia\s+)?/i
const ROTULO_OBRA = /^\s*(a\s+)?(obra(\s+(é|e|era|certa))?|(é|e|era|foi)\s+(da|do|de|na|no)(\s+obra)?|(da|do|na|no)(\s+obra)?)\s*:?\s+/i
const ROTULO_CATEGORIA = /^\s*(a\s+)?((categoria|tipo)(\s+(é|e|era))?|é|e|era)\s*:?\s+/i
const ROTULO_DESCRICAO = /^\s*(a\s+)?(descri[cç][aã]o|desc)(\s+(é|e|era))?\s*:?\s+/i

/** Por quanto tempo uma pergunta ("Cancelo…?", "Qual obra?") espera a resposta. */
const ESPERA_MS = 10 * 60 * 1000

/**
 * As perguntas no ar, por pessoa e conversa. Em memória: se o robô reiniciar
 * no meio, a pessoa pede de novo — nada ficou pela metade no sistema.
 */
const esperas = new Map()
const chaveDe = (msg) => `${msg.chat}|${msg.de}`

function esperaDe(msg) {
  const e = esperas.get(chaveDe(msg))
  if (!e) return null
  if (Date.now() > e.expira) { esperas.delete(chaveDe(msg)); return null }
  return e
}

/**
 * Lê uma correção. Devolve `{ campo, valor }`, `{ cancelar: true }`,
 * `{ campo: 'obra', escrito, candidatos }` quando a obra não ficou clara, ou
 * null quando o texto não é correção nenhuma.
 *
 * Cada forma exige que o texto INTEIRO seja a correção. "valor 1800" é;
 * "acho que o valor tá meio alto, uns 1800" não é — e aí o robô fica calado,
 * que é melhor do que mexer num gasto por causa de um comentário.
 */
export function lerCorrecao(texto, obras = []) {
  const t = String(texto ?? '').trim()
  if (!t) return null

  if (CANCELAR.test(t)) return { cancelar: true }

  // Data antes de valor: "data 30/10" tem números, e não é dinheiro.
  if (ROTULO_DATA.test(t)) {
    const semRotulo = t.replace(ROTULO_DATA, '')
    const { data } = acharData(`dia ${semRotulo}`)
    return data && /^[\d/\s]+$/.test(semRotulo) ? { campo: 'data', valor: data } : null
  }

  if (ROTULO_DESCRICAO.test(t)) {
    const descricao = t.replace(ROTULO_DESCRICAO, '').trim().slice(0, 200)
    return descricao ? { campo: 'descricao', valor: descricao } : null
  }

  // Valor: com rótulo ("valor 1800", "era 1.800,00") ou o número sozinho.
  {
    const temRotulo = ROTULO_VALOR.test(t)
    const semRotulo = t.replace(ROTULO_VALOR, '')
    const v = acharValor(semRotulo)
    const sobrou = (v.resto ?? '').replace(/r\$/i, '').replace(/reais?/i, '').trim()
    // Sem "valor"/"era" na frente, só vale número com CARA de dinheiro
    // ("1.800,00", "R$ 1800"). Um "2" solto citando a confirmação pode ser
    // qualquer coisa — e trocar o valor de um gasto por causa dele, não.
    const caraDeDinheiro = /r\$/i.test(t) || /,\d{1,2}\s*$/.test(t)
    if (v.valor != null && !v.ambiguo && !v.incerto && !sobrou && (temRotulo || caraDeDinheiro)) {
      return { campo: 'valor', valor: v.valor }
    }
  }

  // Categoria: a palavra que diz o tipo, sozinha ("material", "locação").
  {
    const cat = categoriaEscrita(t) ?? (ROTULO_CATEGORIA.test(t) ? categoriaEscrita(t.replace(ROTULO_CATEGORIA, '')) : null)
    if (cat) return { campo: 'categoria', valor: cat }
  }

  // Obra: só com algo que diga que é obra ("obra haia", "é da haia").
  if (ROTULO_OBRA.test(t)) {
    const escrito = t.replace(ROTULO_OBRA, '').trim()
    if (!escrito) return null
    const r = acharObra(escrito, obras)
    // O nome tem de ser a frase toda: "é da haia, e o valor tá errado" não é
    // uma correção de obra limpa.
    if (r.achado && !r.resto.replace(/[\s,.;!]/g, '')) return { campo: 'obra', valor: r.achado }
    return { campo: 'obra', escrito, candidatos: r.candidatos ?? null }
  }

  return null
}

const diaCurto = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : null)
const nomeDaCategoria = (c) => (c ? String(c).replace(/_/g, ' ').toLowerCase() : null)

/** "antes → depois", ou só o depois quando não se sabe o antes. */
function seta(antes, depois) {
  return antes && antes !== depois ? `${antes} → ${depois}` : `${depois}`
}

/** Diz uma pergunta e guarda o id dela, para a resposta poder vir citando. */
async function perguntarE(msg, texto, espera) {
  let idPergunta = null
  let retorno = texto
  if (typeof msg.enviarResposta === 'function') {
    try {
      const r = await msg.enviarResposta(texto)
      idPergunta = r?.id ?? null
      // Já foi dito; devolver de novo mandaria duas vezes.
      retorno = null
    } catch { /* sem canal próprio, volta como resposta normal */ }
  }
  esperas.set(chaveDe(msg), { ...espera, idPergunta, expira: Date.now() + ESPERA_MS })
  return retorno
}

function perguntarObra(msg, alvo, opcoes, escrito) {
  const linhas = [escrito ? `Não achei a obra "${escrito}". É qual destas?` : 'Qual é a obra certa?']
  opcoes.forEach((o, i) => linhas.push(`${i + 1}) ${o}`))
  linhas.push('_(responde o número)_')
  return perguntarE(msg, linhas.join('\n'), { tipo: 'obra', idMensagem: alvo.idMensagem, opcoes })
}

/** O que dizer quando o sistema não deixou. Texto fixo, um por motivo. */
function recusa(r, campo) {
  if (r.status === 409 && r.codigo === 'RATEADO') {
    return campo === 'obra'
      ? 'Esse gasto está dividido entre obras — a obra só se troca pelo sistema.'
      : 'Esse gasto está dividido entre obras e uma das partes mudou no sistema — esse ajuste é só por lá.'
  }
  if (r.status === 409 && r.codigo === 'MUITAS_CORRECOES') {
    return 'Esse gasto já foi corrigido muitas vezes por aqui — o próximo ajuste é pelo sistema.'
  }
  // Rejeitado inclui o que foi cancelado por aqui mesmo: dizer "aprovado"
  // faria a pessoa procurar na despesa um gasto que não existe mais.
  if (r.status === 409 && /rejeit/i.test(String(r.statusDoGasto ?? ''))) return 'Esse já foi rejeitado ou cancelado — não dá mais para mexer nele por aqui.'
  if (r.status === 409) return 'Esse já foi aprovado — agora só pelo sistema.'
  // 404 não é erro: é o sistema dizendo que ESTE lançamento não se mexe por
  // aqui — foi criado antes de existir a correção pelo grupo, está no nome
  // de outra pessoa, ou o servidor ainda não tem essa rota.
  if (r.status === 404) return 'Esse lançamento só dá para corrigir pelo sistema.'
  if (r.status === 401) return '❌ Meu acesso ao sistema de obras foi recusado (token inválido ou revogado). Avisa quem cuida do sistema.'
  if (r.status === 400 || r.status === 422) return 'O sistema não aceitou essa correção — corrige por lá.'
  return '❌ Não consegui falar com o sistema de obras agora. Tenta de novo daqui a pouco.'
}

/** Aplica UMA correção já entendida. Devolve o texto da resposta (ou null, se a resposta já foi dita). */
async function aplicar(msg, alvo, campo, valor) {
  if (campo === 'obra' && alvo.rateado) {
    return 'Esse gasto está dividido entre obras — a obra só se troca pelo sistema.'
  }

  const r = await corrigirLancado(alvo.idGasto, { [campo]: valor }, telefoneDeQuemMandou(msg))

  // O sistema não reconheceu a obra: pergunta com a lista DELE, que é a certa.
  if (!r.ok && r.status === 422 && campo === 'obra' && r.obras?.length) {
    return perguntarObra(msg, alvo, r.obras.slice(0, 12), valor)
  }
  if (!r.ok) return recusa(r, campo)

  // Como ficou — o que o sistema devolveu vale mais que o que foi pedido
  // (ele pode ter trocado o nome da obra pelo oficial, ou redividido).
  const g = r.gasto ?? {}
  let texto
  if (campo === 'valor') {
    const novo = Number(g.valor ?? valor)
    texto = `✏️ Corrigido: ${seta(moeda(alvo.valor), moeda(novo))}`
    memoria.corrigirLancamento(alvo.idMensagem, { valor: novo })
  } else if (campo === 'obra') {
    const nova = g.obra ?? valor
    texto = `✏️ Corrigido: ${seta(alvo.obra, nova)}`
    memoria.corrigirLancamento(alvo.idMensagem, { obra: nova })
  } else if (campo === 'data') {
    const nova = String(g.data ?? valor).slice(0, 10)
    texto = `✏️ Corrigido: data ${seta(diaCurto(alvo.data), diaCurto(nova))}`
    memoria.corrigirLancamento(alvo.idMensagem, { data: nova })
  } else if (campo === 'categoria') {
    const nova = g.categoria ?? valor
    texto = `✏️ Corrigido: ${seta(nomeDaCategoria(alvo.categoria), nomeDaCategoria(nova))}`
    memoria.corrigirLancamento(alvo.idMensagem, { categoria: nova })
  } else {
    const nova = g.descricao ?? valor
    texto = `✏️ Corrigido: ${seta(alvo.descricao ? `"${alvo.descricao}"` : null, `"${nova}"`)}`
    memoria.corrigirLancamento(alvo.idMensagem, { descricao: nova })
  }
  console.log(`[gastos] ${discreto(msg.de)} → corrigiu ${campo} de um lançamento`)
  return texto
}

async function cancelar(msg, alvo) {
  const r = await cancelarLancado(alvo.idGasto, telefoneDeQuemMandou(msg))
  if (!r.ok) return recusa(r, null)
  // Sai da memória: o fechamento do dia não soma o que não existe mais, e o
  // mesmo arquivo pode ser mandado de novo, agora certo.
  memoria.esquecerLancamento(alvo.idMensagem)
  console.log(`[gastos] ${discreto(msg.de)} → cancelou um lançamento`)
  return `🗑️ Cancelado: ${[moeda(alvo.valor), alvo.obra && `em ${alvo.obra}`].filter(Boolean).join(' ')}.`
}

/** Quem pode mexer neste lançamento: quem mandou, ou alguém da lista de números. */
function podeCorrigir(msg, alvo) {
  if ((alvo.de && msg.de === alvo.de) || numeroNaLista(msg.de)) return true
  // Comprovante que veio de outro lugar (grupo só de leitura): quem "mandou"
  // não está nesta conversa. Foi nesta conversa que o robô perguntou e
  // confirmou, e é quem está aqui que responde por ele — a regra da pessoa
  // fica com o sistema, que recebe o telefone de quem pediu.
  return String(alvo.de ?? '').startsWith('atraso:') && Boolean(alvo.chat) && alvo.chat === msg.chat
}

/**
 * Esta mensagem de texto é uma correção?
 *
 * Devolve o texto da resposta (ou null, quando a resposta já foi dita, ou
 * quando o certo é ficar calado). Devolve `undefined` quando a mensagem NÃO é
 * assunto daqui — e aí quem chamou segue com as regras de sempre.
 */
export async function tentarCorrecao(msg) {
  const texto = String(msg.texto ?? '').trim()
  if (!texto || !obrasConfigurado()) return undefined

  const citado = msg.respondendoA ? memoria.lancamentoCitado(msg.respondendoA) : null
  const espera = esperaDe(msg)

  // ── Resposta a uma pergunta nossa ("Cancelo…?", "É qual destas?") ───────
  if (espera) {
    const alvoDaEspera = memoria.resultadoDe(espera.idMensagem)
    const citouIsto = Boolean(msg.respondendoA)
      && (msg.respondendoA === espera.idPergunta || citado?.idMensagem === espera.idMensagem)
    // Sem citar, só vale quando a pessoa não tem comprovante próprio
    // esperando resposta: senão o "sim" poderia ser para ele.
    const soPodeSerIsto = !msg.respondendoA && !pendentes.doRemetente(msg.de).some(p => p.perguntadoEm)

    if ((citouIsto || soPodeSerIsto) && alvoDaEspera?.resultado === 'lancado' && alvoDaEspera.idGasto) {
      if (espera.tipo === 'cancelar') {
        if (CONFIRMA_VALOR.test(texto)) { esperas.delete(chaveDe(msg)); return cancelar(msg, alvoDaEspera) }
        if (NEGA_VALOR.test(texto)) { esperas.delete(chaveDe(msg)); return 'Certo, deixei como está.' }
      }
      if (espera.tipo === 'obra') {
        const so = texto.replace(/[).\s]+$/, '')
        const escolhida = /^\d{1,2}$/.test(so) ? espera.opcoes[Number(so) - 1] : null
        if (escolhida) { esperas.delete(chaveDe(msg)); return aplicar(msg, alvoDaEspera, 'obra', escolhida) }
      }
    }
  }

  // ── Uma correção nova: só CITANDO um gasto lançado ──────────────────────
  if (!citado) return undefined

  const obras = await obrasConhecidas()
  const correcao = lerCorrecao(texto, obras)

  // Citou um lançado e escreveu outra coisa ("obrigado", "esse é o da
  // semana passada"): não é correção, e também não é resposta a outro
  // comprovante. Calado.
  if (!correcao) return null

  if (!podeCorrigir(msg, citado)) {
    return 'Só quem mandou esse comprovante (ou alguém da lista de autorizados) pode mexer nele.'
  }
  if (!citado.idGasto) {
    return 'Esse lançamento só dá para corrigir pelo sistema.'
  }

  if (correcao.cancelar) {
    const pergunta = `Cancelo o lançamento de ${[moeda(citado.valor), citado.obra && `em ${citado.obra}`].filter(Boolean).join(' ')}? Responde *sim*.`
    return perguntarE(msg, pergunta, { tipo: 'cancelar', idMensagem: citado.idMensagem })
  }

  if (correcao.campo === 'obra' && !correcao.valor) {
    const opcoes = correcao.candidatos?.length ? correcao.candidatos : nomesDe(obras).slice(0, 12)
    if (!opcoes.length) return 'Não achei essa obra — corrige pelo sistema.'
    return perguntarObra(msg, citado, opcoes, correcao.candidatos?.length ? null : correcao.escrito)
  }

  return aplicar(msg, citado, correcao.campo, correcao.valor)
}

/** Só para teste: esquece as perguntas no ar. */
export function _limparEsperas() {
  esperas.clear()
}
