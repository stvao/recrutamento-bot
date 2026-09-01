/**
 * Módulo de gastos — comprovante que chega por mensagem vira lançamento
 * esperando aprovação no sistema de obras.
 *
 * O problema que ele resolve: os comprovantes já chegam todo dia num grupo,
 * com a descrição escrita do lado, e alguém precisa olhar cada um e digitar
 * no sistema de custos. São muitos por dia, e nem sempre há tempo.
 *
 * ── Como ele se comporta ─────────────────────────────────────────────────
 *
 * Chega uma foto. Ele lê a legenda, lê a imagem, e:
 *
 *  - Tem obra e valor  → LANÇA como gasto da equipe, já pendente. Você só
 *                        abre "Aprovar gastos" e confirma.
 *  - Falta alguma coisa → PERGUNTA no grupo ("Qual a obra?", "Qual o valor?")
 *                        e lança quando você responder.
 *  - Você não responde  → passado o prazo, manda para a caixa de
 *                        comprovantes, que é onde ficava antes. Comprovante
 *                        na caixa é pior que lançado, e melhor que perdido.
 *
 * ── O que ele NÃO faz ────────────────────────────────────────────────────
 *
 * Aprovar. O gasto nasce PENDENTE e vira despesa só quando uma pessoa
 * confirma — o mesmo botão de sempre. Aprovar sozinho trocaria "trabalho de
 * digitar" por "trabalho de auditar", que é pior.
 *
 * Este arquivo não sabe por onde a mensagem chegou. WhatsApp e Telegram
 * entregam a mesma coisa, e é isso que permite trocar de canal sem tocar
 * aqui.
 */
import { lerComprovante, visaoDisponivel } from './ia-visao.js'
import {
  enviarComprovante, lancarGasto, obrasDoSistema, obrasConfigurado,
} from './obras-client.js'
import { interpretar, combinar, nomesDe } from './lancamento.js'
import { norm } from './texto.js'

/**
 * Quem pode lançar.
 *
 * Isto é SEGURANÇA, não organização. Sem a lista, quem descobrir o número
 * manda uma foto e cria lançamento no financeiro da empresa. Números só com
 * dígitos, separados por vírgula, no .env:
 *
 *   GASTOS_AUTORIZADOS=5511999998888,5511977776666
 *
 * Lista vazia é tratada como "ninguém": um erro de configuração não pode
 * abrir a porta para todo mundo.
 */
const BRUTO_AUTORIZADOS = (process.env.GASTOS_AUTORIZADOS || '').split(',').map(x => x.trim()).filter(Boolean)

/**
 * "*" = qualquer pessoa, mas SÓ de dentro dos grupos cadastrados.
 *
 * Faz sentido quando o grupo é fechado e todo mundo nele pode lançar —
 * evita ter que cadastrar e manter a lista de cada gestor de obra.
 *
 * Só vale COM grupo definido, e é por isso que a checagem existe: sem
 * GASTOS_GRUPOS, o "*" valeria também para quem manda no privado, e aí
 * qualquer um que descubra o número lança no financeiro. Nesse caso ele é
 * recusado e o robô avisa alto, em vez de abrir a porta em silêncio.
 */
const QUALQUER_UM_DO_GRUPO = BRUTO_AUTORIZADOS.includes('*')

const AUTORIZADOS = new Set(
  BRUTO_AUTORIZADOS
    .filter(n => n !== '*')
    .map(n => n.replace(/\D/g, ''))
    .filter(Boolean),
)

/**
 * De onde os comprovantes vêm.
 *
 * Vazio = qualquer conversa, desde que o remetente esteja autorizado (é o
 * caso de quem manda direto no privado do bot). Preenchido, restringe ao
 * grupo: o robô fica calado em todo o resto, que é o que se quer quando ele
 * é membro de vários grupos.
 */
const GRUPOS = new Set(
  (process.env.GASTOS_GRUPOS || '').split(',').map(g => g.trim()).filter(Boolean),
)

/**
 * Também pelo NOME do grupo.
 *
 * Ninguém sabe de cabeça que o grupo dos comprovantes é
 * "120363044...@g.us", mas todo mundo sabe que ele se chama "Comprovantes".
 * Aceitar o nome tira um passo de configuração que só existia por limitação
 * nossa.
 */
const GRUPOS_NORM = new Set([...GRUPOS].map(g => norm(g)))

/**
 * Perigo do nome: qualquer um pode criar um grupo chamado "Comprovantes",
 * botar o robô dentro e mandar comprovante. Por isso o nome só vale junto
 * com a checagem de quem enviou — e é a razão de o coringa "*" exigir que a
 * pessoa esteja num grupo cadastrado, e não só que o grupo tenha o nome
 * certo.
 */

/**
 * Obras de reserva, do .env.
 *
 * A fonte de verdade é o sistema de obras (obrasDoSistema). Esta lista só
 * cobre o intervalo em que ele não responde — sem nome de obra nenhum, toda
 * legenda escrita corrido viraria "faltou a obra".
 */
const OBRAS_RESERVA = (process.env.GASTOS_OBRAS || '')
  .split(',').map(o => o.trim()).filter(Boolean)

/**
 * Quanto esperar por uma descrição que vem em mensagem separada.
 *
 * Muita gente manda a foto e escreve o "o que é" logo em seguida, em outra
 * mensagem. Enviar na hora perderia essa descrição — e é ela que diz de qual
 * obra é o gasto, que o comprovante não informa.
 */
const ESPERA_DESCRICAO_MS = Number(process.env.GASTOS_ESPERA_DESCRICAO_MS || 60000)

/**
 * Quanto esperar pela RESPOSTA a uma pergunta.
 *
 * Bem mais longo que a espera pela legenda: aqui a pessoa já foi
 * interpelada, e no canteiro ela larga o celular no bolso e volta meia hora
 * depois. Passado o prazo, o comprovante vai para a caixa em vez de sumir.
 */
const ESPERA_RESPOSTA_MS = Number(process.env.GASTOS_ESPERA_RESPOSTA_MS || 1000 * 60 * 30)

export function coringaInvalido() {
  return QUALQUER_UM_DO_GRUPO && GRUPOS.size === 0
}

export function gastosAtivo() {
  if (coringaInvalido()) return false
  const temQuem = AUTORIZADOS.size > 0 || QUALQUER_UM_DO_GRUPO
  return temQuem && obrasConfigurado()
}

/**
 * Este remetente pode lançar gasto?
 *
 * `deGrupoCadastrado` diz se a mensagem veio de um grupo da lista — é o que
 * o coringa exige. Sem isso, "*" valeria para quem manda no privado também.
 */
export function autorizado(de, deGrupoCadastrado = false) {
  if (AUTORIZADOS.has((de || '').replace(/\D/g, ''))) return true
  if (QUALQUER_UM_DO_GRUPO && GRUPOS.size > 0 && deGrupoCadastrado) return true
  return false
}

/**
 * A mensagem veio de onde os comprovantes devem vir?
 *
 * Aceita o identificador técnico do grupo OU o nome dele — quem configura
 * sabe o nome, não o identificador.
 */
export function origemAceita(chat, chatNome) {
  if (GRUPOS.size === 0) return true
  if (GRUPOS.has(String(chat ?? ''))) return true
  if (chatNome && GRUPOS_NORM.has(norm(chatNome))) return true
  return false
}

/** As obras conhecidas agora: as do sistema, ou a reserva do .env. */
async function obrasConhecidas() {
  return (await obrasDoSistema()) ?? OBRAS_RESERVA
}

/** Diagnóstico, para o /metricas. */
export function situacao() {
  let esperando = 0
  for (const f of filas.values()) esperando += f.itens.length + (f.perguntandoAgora ? 1 : 0)

  return {
    ativo: gastosAtivo(),
    autorizados: AUTORIZADOS.size,
    grupos: GRUPOS.size ? [...GRUPOS] : 'qualquer origem',
    quemPodeLancar: QUALQUER_UM_DO_GRUPO
      ? (GRUPOS.size ? 'qualquer um dos grupos cadastrados' : 'RECUSADO: "*" exige GASTOS_GRUPOS')
      : `${AUTORIZADOS.size} número(s) na lista`,
    leituraPorIA: visaoDisponivel(),
    obras: obrasConfigurado(),
    obrasReserva: OBRAS_RESERVA.length,
    esperandoResposta: esperando,
  }
}

/** "R$ 1.234,50" */
function moeda(v) {
  return v == null ? null : `R$ ${v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`
}

/** "28/08" — o ano só aparece quando não é o corrente, para a linha ficar curta. */
function dataCurta(iso) {
  if (!iso) return null
  const [a, m, d] = iso.split('-')
  return Number(a) === new Date().getFullYear() ? `${d}/${m}` : `${d}/${m}/${a}`
}

/**
 * O resumo que vai no campo `texto` do comprovante.
 *
 * Usado só no caminho da CAIXA — quando não deu para lançar. É por esta
 * linha que a pessoa confere sem abrir a foto, então ela sai na ordem em que
 * se lê um lançamento: obra, o que foi, tipo, quanto.
 */
export function montarTexto(dados, observacao) {
  const linhas = []

  const cabeca = [
    dados?.obra,
    dados?.descricao,
    dados?.tipo ? dados.tipo.replace(/_/g, ' ').toLowerCase() : null,
    moeda(dados?.valor),
  ].filter(Boolean)
  if (cabeca.length) linhas.push(cabeca.join(' · '))

  const detalhe = [
    dados?.estabelecimento && dados.estabelecimento !== dados.descricao ? dados.estabelecimento : null,
    dados?.formaPagamento,
    dados?.documento ? `doc ${dados.documento}` : null,
    dados?.dataComprovante ? `comprovante de ${dataCurta(dados.dataComprovante)}` : null,
  ].filter(Boolean)
  if (detalhe.length) linhas.push(detalhe.join(' · '))

  if (observacao) linhas.push(`⚠ ${observacao}`)

  // Só avisa quando o valor veio de máquina. Valor digitado por gente não
  // precisa de aviso — e encher de alerta o que está certo faz a pessoa
  // parar de ler os alertas.
  if (dados?.valor != null && !dados.valorDigitado) {
    linhas.push('(valor lido da imagem, não digitado — confira)')
  }
  if (dados?.valor == null) linhas.push('(sem valor — precisa digitar)')

  return linhas.join('\n') || 'Comprovante enviado pelo WhatsApp.'
}

/**
 * Palavras que perguntam se ele está vivo.
 *
 * Existe porque a primeira coisa que se faz ao ligar o robô é mandar um
 * "oi" no grupo — e ele fica calado, de propósito, já que só reage a
 * comprovante. O silêncio é o certo na operação e é péssimo na hora de
 * instalar: não dá para distinguir "funcionando" de "nem conectou".
 */
const PERGUNTAS_DE_TESTE = /^\s*(ping|teste|testando|robo|robô|status|voce esta ai|você está aí|ta ai|tá aí)\s*[?!.]*\s*$/i

/**
 * Quantos comprovantes cabem na fila de uma pessoa.
 *
 * Cada um segura o ARQUIVO em memória — até 20 MB — enquanto espera. Sem
 * teto, um dia movimentado com todo mundo mandando foto e ninguém
 * respondendo encheria a memória e derrubaria o robô, que é bem pior que um
 * comprovante ir para a caixa mais cedo.
 */
const MAX_NA_FILA = Number(process.env.GASTOS_MAX_AGUARDANDO || 30)

/**
 * A fila de cada pessoa.
 *
 * FILA, e não um comprovante só, porque foi assim que quebrou no uso real:
 * mandando cinco fotos seguidas, cada uma cancelava a anterior, e as
 * respostas não tinham a qual pergunta pertencer — "acabou que misturou".
 *
 * A regra que organiza tudo agora: UMA PERGUNTA POR VEZ. O robô resolve o
 * primeiro da fila, e só depois pergunta sobre o próximo. É como uma pessoa
 * faria, e é o que torna "2500" uma resposta sem ambiguidade.
 *
 * remetente -> { itens: [pendente], prazo, perguntandoAgora: pendente|null }
 */
const filas = new Map()

function filaDe(de) {
  let f = filas.get(de)
  if (!f) {
    f = { itens: [], prazo: null, perguntandoAgora: null }
    filas.set(de, f)
  }
  return f
}

function limparPrazo(f) {
  if (f.prazo) clearTimeout(f.prazo)
  f.prazo = null
}

/** Some com a fila quando não sobra nada nela. */
function recolher(de) {
  const f = filas.get(de)
  if (f && !f.itens.length && !f.perguntandoAgora) {
    limparPrazo(f)
    filas.delete(de)
  }
}

/**
 * Diz alguma coisa FORA da resposta a uma mensagem.
 *
 * Precisa existir porque nem tudo acontece em resposta a algo: o prazo da
 * pergunta estoura sozinho, e o próximo da fila é perguntado depois que o
 * anterior foi resolvido — sem nada a que responder.
 *
 * O canal é quem sabe mandar; aqui só se usa o que ele entregou. Sem isso,
 * registra e segue: falar é desejável, e não conseguir falar não pode
 * derrubar o lançamento.
 */
async function avisar(pendente, texto) {
  if (!texto) return
  try {
    if (typeof pendente?.enviar === 'function') await pendente.enviar(texto)
    else console.log(`[gastos] (sem canal para avisar) ${pendente?.de}: ${String(texto).replace(/\n/g, ' / ')}`)
  } catch (e) {
    console.warn('[gastos] não consegui avisar:', e.message)
  }
}

/** Como um comprovante aparece numa lista, em poucas palavras. */
function apelidoDoItem(p) {
  const d = p.dados ?? {}
  const partes = [d.obra, d.descricao || p.descricao, moeda(d.valor)].filter(Boolean)
  return partes.length ? partes.join(' · ').slice(0, 60) : (p.nomeArquivo || 'comprovante')
}

export async function tratar(msg) {
  const { de, chat, chatNome, arquivo, nomeArquivo, tipo, texto, idMensagem } = msg

  const daOrigemCerta = origemAceita(chat, chatNome)
  if (!daOrigemCerta) return null

  // O coringa só vale vindo de grupo cadastrado — no privado, nunca.
  if (!autorizado(de, daOrigemCerta && Boolean(msg.ehGrupo))) {
    // Nem responde. Dizer "você não pode" a quem mandou foto num grupo
    // confirma que existe um robô ouvindo e convida a insistir.
    if (arquivo) console.warn(`[gastos] comprovante ignorado: ${de} não está em GASTOS_AUTORIZADOS`)
    return null
  }

  if (!arquivo && PERGUNTAS_DE_TESTE.test(texto ?? '')) return respostaDeTeste()
  if (!arquivo && LISTAR.test(texto ?? '')) return listarFila(de)
  if (!arquivo && CANCELAR_TUDO.test(texto ?? '')) return descartarFila(de)

  if (!arquivo) return responderTexto(de, texto, msg.respondendoA)

  // ── Chegou um comprovante ────────────────────────────────────────────────
  const f = filaDe(de)

  if (f.itens.length + (f.perguntandoAgora ? 1 : 0) >= MAX_NA_FILA) {
    return `⚠ Já tenho ${MAX_NA_FILA} comprovantes seus esperando. Responde os que faltam antes de mandar mais, ou escreve *cancelar tudo*.`
  }

  const pendente = {
    de, arquivo, nomeArquivo, tipo,
    descricao: texto || null,
    respostas: [],
    idMensagem,
    enviadoEm: msg.enviadoEm ?? Date.now(),
    // Como falar com quem mandou, quando não for resposta a nada.
    enviar: msg.enviarResposta,
  }
  f.itens.push(pendente)

  /*
    Já estou perguntando sobre outro? Então este espera a vez.

    Antes a foto nova CANCELAVA a anterior, e foi exatamente o que bagunçou:
    quem manda cinco de uma vez perdia quatro. Agora ele entra na fila e a
    pessoa fica sabendo em que posição está.
  */
  if (f.perguntandoAgora) {
    return `📎 Recebi, é o ${f.itens.length + 1}º da fila. Vamos um de cada vez.`
  }

  /*
    Sem legenda, segura um pouco: a descrição costuma vir na mensagem
    seguinte, e é ela que diz de qual obra é o gasto. Com legenda, resolve já.
  */
  if (!texto?.trim()) {
    return new Promise((resolve) => {
      pendente.responder = resolve
      limparPrazo(f)
      f.prazo = setTimeout(() => { bombear(de) }, ESPERA_DESCRICAO_MS)
      f.prazo.unref?.()
    })
  }

  return bombear(de)
}

/**
 * Resolve o primeiro da fila, e segue até precisar perguntar algo.
 *
 * Devolve o texto para quem chamou (a mensagem que disparou), e o que vier
 * depois — o próximo da fila — sai por `avisar`, porque já não há mensagem a
 * que responder.
 */
async function bombear(de) {
  const f = filas.get(de)
  if (!f || f.perguntandoAgora) return null

  limparPrazo(f)
  let paraQuemChamou = null

  while (f.itens.length) {
    const pendente = f.itens[0]
    const r = await processar(pendente)

    if (r?.perguntando) {
      // Parou aqui: precisa de resposta antes de seguir.
      f.itens.shift()
      f.perguntandoAgora = pendente
      limparPrazo(f)
      f.prazo = setTimeout(async () => {
        f.perguntandoAgora = null
        // Não respondeu: caixa, que é onde ficava antes. Comprovante na
        // caixa é pior que lançado, e muito melhor que perdido.
        await avisar(pendente, await paraCaixa(pendente))
        recolher(de)
        const seguinte = await bombear(de)
        if (seguinte) await avisar(pendente, seguinte)
      }, ESPERA_RESPOSTA_MS)
      f.prazo.unref?.()

      const texto = f.itens.length
        ? `${r.texto}\n_(faltam mais ${f.itens.length} depois deste)_`
        : r.texto

      if (paraQuemChamou === null) return entregar(pendente, texto)
      await avisar(pendente, texto)
      return paraQuemChamou
    }

    // Resolvido (lançado ou mandado para a caixa).
    f.itens.shift()
    if (paraQuemChamou === null) paraQuemChamou = entregar(pendente, r.texto)
    else await avisar(pendente, r.texto)
  }

  recolher(de)
  return paraQuemChamou
}

/**
 * Entrega o texto pela promessa que ficou aberta, quando existe.
 *
 * A promessa existe quando o comprovante veio sem legenda: a confirmação
 * pertence à FOTO, e não à legenda que chegou depois. Num grupo com várias
 * pessoas mandando ao mesmo tempo, confirmação solta não diz de qual é.
 */
function entregar(pendente, texto) {
  if (pendente.responder) {
    pendente.responder(texto)
    pendente.responder = null
    return null
  }
  return texto
}

/** Texto solto: resposta a uma pergunta, ou legenda que faltava. */
function responderTexto(de, texto, respondendoA) {
  const f = filas.get(de)
  if (!f || !texto?.trim()) return null

  /*
    Respondeu CITANDO uma foto específica?

    É o que a pessoa faz quando percebe que se perdeu — e citar é a única
    forma de dizer, sem ambiguidade, sobre qual comprovante ela está falando.
  */
  if (respondendoA) {
    const naFila = f.itens.find(p => p.idMensagem === respondendoA)
    if (naFila) {
      naFila.respostas.push(texto.trim())
      return null   // será usado quando chegar a vez dele
    }
    if (f.perguntandoAgora?.idMensagem === respondendoA) {
      return aplicarResposta(de, f, texto)
    }
  }

  if (f.perguntandoAgora) return aplicarResposta(de, f, texto)

  // Ninguém foi perguntado ainda: é a legenda da última foto sem legenda.
  const ultimo = f.itens[f.itens.length - 1]
  if (!ultimo || ultimo.descricao) return null
  ultimo.descricao = texto.trim()
  return bombear(de)
}

/** Aplica o que a pessoa respondeu ao comprovante que está sendo perguntado. */
function aplicarResposta(de, f, texto) {
  const pendente = f.perguntandoAgora
  limparPrazo(f)

  if (DESISTENCIA.test(texto)) {
    f.perguntandoAgora = null
    return paraCaixa(pendente).then(async (r) => {
      const seguinte = await bombear(de)
      return seguinte ? `${r}\n\n${seguinte}` : r
    })
  }

  /*
    "1" ou "2" respondendo a uma lista numerada.

    É o que a pessoa faz quando o robô acabou de listar as opções, e sem isto
    o número seria lido como VALOR — "1" viraria R$ 1,00 e o gasto entraria
    errado.
  */
  const so = texto.trim().replace(/[).\s]+$/, '')
  if (/^\d{1,2}$/.test(so) && pendente.opcoes?.length) {
    const i = Number(so) - 1
    if (i >= 0 && i < pendente.opcoes.length) {
      pendente.obraEscolhida = pendente.opcoes[i]
    } else {
      pendente.respostas.push(texto.trim())
    }
  } else {
    pendente.respostas.push(texto.trim())
  }

  f.perguntandoAgora = null
  f.itens.unshift(pendente)   // volta para a frente da fila
  return bombear(de)
}

/** O que ainda está esperando. */
function listarFila(de) {
  const f = filas.get(de)
  const todos = [...(f?.perguntandoAgora ? [f.perguntandoAgora] : []), ...(f?.itens ?? [])]
  if (!todos.length) return '✅ Não tenho nenhum comprovante seu esperando.'

  const linhas = [`Tenho ${todos.length} comprovante(s) seu(s) esperando:`]
  todos.forEach((p, i) => linhas.push(`${i + 1}) ${apelidoDoItem(p)}`))
  linhas.push('')
  linhas.push('Estou perguntando sobre o primeiro. Responde ele que eu sigo para o próximo.')
  linhas.push('_(ou escreve *cancelar tudo* para mandar todos para a caixa)_')
  return linhas.join('\n')
}

/** Manda tudo que está esperando para a caixa e limpa. */
async function descartarFila(de) {
  const f = filas.get(de)
  const todos = [...(f?.perguntandoAgora ? [f.perguntandoAgora] : []), ...(f?.itens ?? [])]
  if (!todos.length) return '✅ Não tinha nada seu esperando.'

  limparPrazo(f)
  filas.delete(de)

  await Promise.allSettled(todos.map(p => paraCaixa(p)))
  return `📥 Mandei os ${todos.length} para a caixa de comprovantes.\nAbre /m/gasto no sistema para lançar cada um.`
}

/**
 * Manda para a caixa tudo que está esperando, antes de o processo morrer.
 *
 * Sem isto, um deploy no meio da tarde perde silenciosamente os comprovantes
 * que estavam na fila: a pessoa respondeu a pergunta e não recebe nada, e a
 * foto se foi. Na caixa ela pelo menos existe, e alguém completa.
 */
export async function encerrar() {
  const todos = []
  for (const f of filas.values()) {
    limparPrazo(f)
    if (f.perguntandoAgora) todos.push(f.perguntandoAgora)
    todos.push(...f.itens)
  }
  filas.clear()
  if (!todos.length) return 0

  console.log(`[gastos] encerrando — mandando ${todos.length} comprovante(s) que esperavam para a caixa.`)
  await Promise.allSettled(todos.map(async (p) => {
    const r = await paraCaixa(p)
    await avisar(p, `⚠ Precisei reiniciar antes de você responder.\n${r}`)
  }))
  return todos.length
}

/** Só para teste: esquece as fotos seguradas. */
export function _limparPendentes() {
  for (const f of filas.values()) limparPrazo(f)
  filas.clear()
}

function respostaDeTeste() {
  const linhas = ['👋 Estou aqui, ouvindo este grupo.']

  if (!obrasConfigurado()) {
    linhas.push('❌ Mas SEM acesso ao sistema de obras — comprovante não vai chegar lá. Falta o token.')
  } else if (!visaoDisponivel()) {
    linhas.push('⚠ Sem leitura automática da imagem. O comprovante chega, mas só com o que você escrever.')
  } else {
    linhas.push('✅ Sistema de obras e leitura de imagem prontos.')
  }

  linhas.push('')
  linhas.push('Manda o comprovante com uma linha assim:')
  linhas.push('_bastos haia, tijolos e areia, material, 2500,00_')
  linhas.push('Se faltar alguma coisa, eu pergunto.')
  return linhas.join('\n')
}

/**
 * Manda para a caixa tudo que está esperando, antes de o processo morrer.
 *
 * Sem isto, um deploy no meio da tarde perde silenciosamente os
 * comprovantes que estavam esperando resposta: a pessoa respondeu a
 * pergunta e não recebe nada, e a foto se foi. Na caixa ela pelo menos
 * existe, e alguém completa.
 *
 * Devolve quantos foram descarregados, para quem chama registrar.
 */

/** Quem desiste de responder. */
const DESISTENCIA = /^\s*(cancelar|cancela|deixa|deixa pra la|deixa pra lá|esquece|nao sei|não sei|depois)\s*[!.]*\s*$/i

/** Comandos de texto que o robô entende no grupo. */
const LISTAR = /^\s*(pendentes|pendente|faltando|o que falta|lista|listar|fila)\s*[?!.]*\s*$/i
const CANCELAR_TUDO = /^\s*(cancelar tudo|cancela tudo|limpar tudo|manda tudo pra caixa|manda tudo para a caixa)\s*[!.]*\s*$/i

/**
 * Junta tudo que se sabe e decide: lança, pergunta, ou manda para a caixa.
 *
 * Devolve `{ perguntando, texto }`. Quem chama precisa saber a diferença:
 * uma pergunta trava a fila esperando resposta; o resto segue adiante.
 */
async function processar(pendente, { acabouOTempo = false } = {}) {
  const obras = await obrasConhecidas()

  /*
    Tudo que a pessoa escreveu, na legenda e nas respostas, lido JUNTO.

    Junto e não separado: quem manda a foto com "haia" e depois responde
    "1400" tem um lançamento só na cabeça, e interpretar as duas frases
    isoladamente perderia a metade de cada uma.
  */
  const escritoTudo = [pendente.descricao, ...(pendente.respostas ?? [])]
    .filter(Boolean).join(', ')

  const escrito = interpretar(escritoTudo, obras)

  // A imagem é lida UMA vez e guardada: numa segunda passada, depois da
  // resposta, reler custaria mais 20 segundos e daria o mesmo resultado.
  if (pendente.lido === undefined) {
    pendente.lido = await lerComprovante({
      arquivo: pendente.arquivo, tipo: pendente.tipo, descricao: escritoTudo,
    }).catch(() => null)
    console.log('[gastos] leitura da imagem:', pendente.lido ? JSON.stringify(pendente.lido) : 'nenhuma')
  }

  const dados = combinar(escrito, pendente.lido)

  // Obra escolhida pelo número da lista manda em tudo: foi a pessoa que
  // apontou, e não há leitura de texto que valha mais que isso.
  if (pendente.obraEscolhida) dados.obra = pendente.obraEscolhida

  pendente.dados = dados

  const falta = []
  if (!dados.obra) falta.push('obra')
  if (dados.valor == null) falta.push('valor')

  if (falta.length && !acabouOTempo && !pendente.jaPerguntou) {
    return { perguntando: true, texto: perguntar(pendente, falta, obras) }
  }
  if (falta.length) return { perguntando: false, texto: await paraCaixa(pendente) }

  return lancar(pendente, dados)
}

/** Monta a pergunta. Quem controla a espera é a fila. */
function perguntar(pendente, falta, obras) {
  pendente.jaPerguntou = true

  const linhas = []
  const d = pendente.dados

  // Mostra o que JÁ entendeu antes de perguntar. Sem isso a pessoa não sabe
  // se ele leu o resto, e acaba redigitando tudo.
  const sabido = [
    d.obra, d.descricao,
    d.tipo ? d.tipo.replace(/_/g, ' ').toLowerCase() : null,
    moeda(d.valor),
  ].filter(Boolean)
  if (sabido.length) linhas.push(`Anotei: ${sabido.join(' · ')}`)

  /*
    A pessoa escreveu algo que serve para MAIS DE UMA obra — a cidade,
    tipicamente. Aí a pergunta é entre essas, e não entre todas: é mais
    curta, e mostra que ele entendeu o que foi dito em vez de ignorar.
  */
  const candidatos = d?.candidatos ?? null
  const nomes = nomesDe(obras)

  if (candidatos?.length) {
    linhas.push('Aí tem mais de uma obra. É qual delas?')
    candidatos.forEach((o, i) => linhas.push(`${i + 1}) ${o}`))
    if (falta.includes('valor')) linhas.push('E qual foi o *valor*?')
  } else if (falta.includes('obra') && falta.includes('valor')) {
    linhas.push('Só faltou a *obra* e o *valor*. Me manda os dois?')
  } else if (falta.includes('obra')) {
    linhas.push('De qual *obra* é esse gasto?')
  } else {
    linhas.push('Qual foi o *valor*?')
  }

  if (!candidatos?.length && falta.includes('obra') && nomes.length && nomes.length <= 12) {
    linhas.push(`(${nomes.join(' · ')})`)
  }

  // Guarda as opções numeradas: responder "1" é o jeito mais rápido, e é o
  // que a pessoa vai fazer se o robô acabou de listar 1) e 2).
  pendente.opcoes = candidatos?.length ? candidatos : (nomes.length <= 12 ? nomes : null)

  return linhas.join('\n')
}

/** Lança como gasto da equipe, pendente de aprovação. */
async function lancar(pendente, dados) {
  const data = new Date(pendente.enviadoEm ?? Date.now()).toISOString().slice(0, 10)

  const r = await lancarGasto({
    arquivo: pendente.arquivo,
    nomeArquivo: pendente.nomeArquivo,
    tipo: pendente.tipo,
    obra: dados.obra,
    valor: dados.valor,
    descricao: dados.descricao || dados.estabelecimento || 'Comprovante enviado pelo WhatsApp',
    categoria: dados.tipo,
    data,
    fornecedor: dados.estabelecimento,
    observacao: dados.valorDigitado ? null : 'Valor lido da imagem pelo robô — confira.',
    rateio: dados.rateio,
    idMensagem: pendente.idMensagem,
  })

  if (r.ok) {
    console.log(`[gastos] ${pendente.de} → LANÇADO em ${r.obra} (${moeda(dados.valor)})`)
    const linhas = [`✅ ${r.mensagem || 'Lançado, aguardando aprovação.'}`]
    linhas.push([
      r.rateio?.length > 1 ? null : r.obra,
      dados.descricao,
      dados.tipo ? dados.tipo.replace(/_/g, ' ').toLowerCase() : null,
      moeda(dados.valor),
    ].filter(Boolean).join(' · '))

    // Rateado: mostra quanto foi para cada obra. É o que a pessoa precisa
    // conferir — o total ela já sabe, está no comprovante na mão dela.
    if (r.rateio?.length > 1) {
      for (const parte of r.rateio) linhas.push(`  · ${parte.obra}: ${moeda(parte.valor)}`)
    }

    if (!dados.valorDigitado) linhas.push('⚠ Esse valor eu li da imagem. Confere ao aprovar.')
    return { perguntando: false, texto: linhas.join('\n') }
  }

  // A obra não foi reconhecida pelo SISTEMA (não pela nossa lista): pergunta
  // de novo com os nomes que ele mesmo devolveu, que são os certos.
  if (r.obraNaoAchada && !pendente.jaPerguntouObra) {
    pendente.jaPerguntouObra = true
    pendente.jaPerguntou = false
    pendente.dados = { ...dados, obra: null }
    return { perguntando: true, texto: perguntar(pendente, ['obra'], r.obras ?? []) }
  }

  if (r.semRota) console.warn('[gastos] servidor ainda sem /lancar — mandando para a caixa.')
  else console.warn('[gastos] lançamento falhou:', r.motivo ?? r.status)

  return { perguntando: false, texto: await paraCaixa(pendente) }
}

/** Manda para a caixa — o caminho de quando não dá para lançar. */
async function paraCaixa(pendente) {
  const dados = pendente.dados ?? {}
  const envio = await enviarComprovante({
    arquivo: pendente.arquivo,
    nomeArquivo: pendente.nomeArquivo,
    tipo: pendente.tipo,
    texto: montarTexto(dados, pendente.lido?.observacao),
    idMensagem: pendente.idMensagem,
    extras: {
      obra: dados.obra,
      descricao: dados.descricao,
      categoria: dados.tipo,
      valor: dados.valor,
      data: new Date(pendente.enviadoEm ?? Date.now()).toISOString().slice(0, 10),
      dataComprovante: dados.dataComprovante,
      estabelecimento: dados.estabelecimento,
      documento: dados.documento,
      formaPagamento: dados.formaPagamento,
      confianca: dados.confianca,
    },
  })

  console.log(`[gastos] ${pendente.de} → caixa: ${envio.ok ? 'ok' : envio.motivo}`)

  if (!envio.ok) {
    if (envio.status === 401) return '❌ Meu acesso ao sistema de obras foi recusado (token inválido ou revogado). Avisa quem cuida do sistema.'
    if (envio.status === 429) return '⏳ Muitos envios de uma vez. Manda esse de novo daqui a um minuto, por favor.'
    if (envio.motivo === 'grande-demais') return '❌ O arquivo passou de 20 MB. Manda a foto em vez do PDF, ou tira outra foto.'
    if (envio.status === 400) return `❌ O sistema de obras não aceitou esse arquivo (${envio.motivo}).`
    return '❌ Não consegui falar com o sistema de obras agora. Manda de novo daqui a pouco — não vai duplicar.'
  }

  const linhas = [`📥 ${envio.mensagem || 'Comprovante recebido.'}`]
  const resumo = [
    dados.obra, dados.descricao,
    dados.tipo ? dados.tipo.replace(/_/g, ' ').toLowerCase() : null,
    moeda(dados.valor),
  ].filter(Boolean)
  if (resumo.length) linhas.push(resumo.join(' · '))

  const falta = [!dados.obra && 'a obra', dados.valor == null && 'o valor'].filter(Boolean)
  if (falta.length) linhas.push(`Faltou ${falta.join(' e ')} — completa em /m/gasto, na caixa.`)
  return linhas.join('\n')
}
