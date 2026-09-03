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
import { interpretar, combinar, nomesDe, ehVocabularioConhecido } from './lancamento.js'
import { norm } from './texto.js'
import * as pendentes from './pendentes.js'
import * as memoria from './memoria.js'

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

/**
 * As obras conhecidas agora: as do sistema, ou a reserva do .env.
 *
 * Os apelidos APRENDIDOS entram junto. Eles vêm no campo do endereço, que a
 * busca por palavra distintiva já varre — assim "escola do zé", uma vez
 * confirmado por você, passa a achar a obra sozinho, sem caminho novo.
 */
async function obrasConhecidas() {
  const doSistema = (await obrasDoSistema()) ?? OBRAS_RESERVA
  const aprendidos = memoria.apelidosPorObra(doSistema)
  if (!aprendidos.size) return doSistema

  return doSistema.map((o) => {
    const nome = typeof o === 'string' ? o : o.nome
    const apelidos = aprendidos.get(nome)
    if (!apelidos?.length) return o
    return {
      nome,
      endereco: typeof o === 'string' ? '' : (o.endereco ?? ''),
      apelidos,
    }
  })
}

/** Diagnóstico, para o /metricas. */
export function situacao() {
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
    esperandoResposta: pendentes.quantos(),
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
 * Quantos comprovantes uma pessoa pode ter esperando.
 *
 * Alto de propósito: o arquivo mora em disco, não na memória, e o custo de
 * mais um esperando é uma ficha de poucos bytes. O teto existe só para um
 * erro (alguém despejando o rolo da câmera) não encher o disco.
 */
const MAX_ESPERANDO = Number(process.env.GASTOS_MAX_AGUARDANDO || 50)

/**
 * Quando cobrar, e quando desistir.
 *
 * "Às vezes estou ocupado, e posso não ver a mensagem." Meia hora não serve
 * para quem está na obra. Então ele espera HORAS, cobra uma vez no meio do
 * caminho, e só no fim manda para a caixa — de onde nada se perde, só dá
 * mais trabalho.
 *
 * A cobrança é UMA. Robô que insiste vira aquele contato que a gente silencia,
 * e aí ele para de servir para qualquer coisa.
 */
const COBRAR_APOS_MS = Number(process.env.GASTOS_COBRAR_APOS_MS || 1000 * 60 * 60 * 3)
const DESISTIR_APOS_MS = Number(process.env.GASTOS_DESISTIR_APOS_MS || 1000 * 60 * 60 * 24)

/** De quanto em quanto tempo olhar quem está esperando demais. */
const RONDA_MS = Number(process.env.GASTOS_RONDA_MS || 1000 * 60 * 5)

/**
 * Quanto esperar por uma legenda que vem em mensagem separada.
 *
 * Muita gente manda a foto e escreve o "o que é" logo em seguida. Perguntar
 * antes disso seria perguntar o que a pessoa já ia dizer.
 */
const ESPERA_LEGENDA_MS = Number(process.env.GASTOS_ESPERA_DESCRICAO_MS || 60000)

/** Como um comprovante aparece numa lista, em poucas palavras. */
function apelidoDoItem(p) {
  const d = p.dados ?? {}
  const partes = [d.obra, d.descricao || p.descricao, moeda(d.valor)].filter(Boolean)
  return partes.length ? partes.join(' · ').slice(0, 60) : (p.nomeArquivo || 'comprovante')
}

/** "há 3 horas" — para a cobrança soar como gente. */
function faz(ms) {
  const min = Math.round(ms / 60000)
  if (min < 60) return `há ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `há ${h} hora${h === 1 ? '' : 's'}`
  return `há ${Math.round(h / 24)} dia(s)`
}

/**
 * Diz alguma coisa FORA da resposta a uma mensagem.
 *
 * A cobrança sai horas depois, e o prazo estoura sozinho: não há mensagem a
 * que responder. O canal é quem sabe mandar; aqui só se usa o que ele
 * entregou. Sem isso, registra e segue — falar é desejável, e não conseguir
 * falar não pode derrubar o lançamento.
 */
async function avisar(pendente, texto) {
  if (!texto) return null
  try {
    if (typeof pendente?.enviar === 'function') {
      const r = await pendente.enviar(texto)
      return r?.id ?? null
    }
    console.log(`[gastos] (sem canal para avisar) ${pendente?.de}: ${String(texto).replace(/\n/g, ' / ')}`)
  } catch (e) {
    console.warn('[gastos] não consegui avisar:', e.message)
  }
  return null
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
  if (!arquivo && LISTAR.test(texto ?? '')) return listar(de)
  if (!arquivo && CANCELAR_TUDO.test(texto ?? '')) return descartarTudo(de)
  if (!arquivo) return responderTexto(de, texto, msg.respondendoA, msg.enviarResposta)

  // ── Chegou um comprovante ────────────────────────────────────────────────
  if (pendentes.doRemetente(de).length >= MAX_ESPERANDO) {
    return `⚠ Já tenho ${MAX_ESPERANDO} comprovantes seus esperando. Responde alguns antes de mandar mais, ou escreve *cancelar tudo*.`
  }

  // De onde vêm os comprovantes — o resumo do dia sai por conta própria e
  // precisa saber para onde mandar.
  if (msg.ehGrupo && chat) memoria.lembrarGrupo(chat)

  const p = pendentes.guardar({
    de, arquivo, nomeArquivo, tipo,
    descricao: texto || null,
    respostas: [],
    idMensagem,
    enviadoEm: msg.enviadoEm ?? Date.now(),
    criadoEm: Date.now(),
  })
  p.enviar = msg.enviarResposta

  /*
    CADA COMPROVANTE ESPERA SOZINHO. Não há fila, e não há sequência.

    A fila veio antes e foi pior: com três esperando, a pessoa tinha que
    responder na ordem que o robô escolheu. Agora ele pergunta sobre cada um
    assim que chega, e a pessoa responde CITANDO — a citação diz sozinha a
    qual comprovante a resposta pertence, e a ordem passa a ser dela.
  */
  if (!texto?.trim()) {
    // Sem legenda: espera um pouco, porque a descrição costuma vir na
    // mensagem seguinte, e é ela que diz de qual obra é o gasto.
    return new Promise((resolve) => {
      p.responder = resolve
      p.esperandoLegendaAte = Date.now() + ESPERA_LEGENDA_MS
      setTimeout(() => {
        if (!pendentes.porId(p.id)) return       // já resolvido pela legenda
        p.esperandoLegendaAte = 0
        resolveDireto(p).then(t => entregar(p, t))
      }, ESPERA_LEGENDA_MS).unref?.()
    })
  }

  return resolveDireto(p)
}

/**
 * Processa um comprovante e devolve o texto para quem estiver ouvindo.
 *
 * Resolvido, sai da lista e do disco. Faltando informação, vira pergunta e
 * continua esperando — cada um por conta própria.
 */
async function resolveDireto(p) {
  const r = await processar(p)

  if (!r.perguntando) {
    pendentes.remover(p.id)
    return r.texto
  }

  // Ficou esperando. Quantos mais estão na mesma situação? Dizer isso evita
  // a sensação de bagunça de quem mandou vários e não sabe o que falta.
  const outros = pendentes.doRemetente(p.de).filter(x => x.id !== p.id && x.perguntadoEm).length
  const texto = outros
    ? `${r.texto}\n_(responde citando esta mensagem — tenho mais ${outros} esperando)_`
    : r.texto

  const idPergunta = await avisar(p, texto)
  if (idPergunta) {
    // Guarda o id da PERGUNTA: citar a pergunta é o jeito mais natural de
    // responder, e sem isto só citar a foto funcionaria.
    p.idPergunta = idPergunta
  }
  p.perguntadoEm = Date.now()
  pendentes.atualizar(p)

  // Já foi dito por `avisar`; devolver de novo mandaria a mesma coisa duas
  // vezes. Quando não há canal, volta como resposta normal.
  return idPergunta ? null : texto
}

/** Entrega pela promessa que ficou aberta, quando existe. */
function entregar(p, texto) {
  if (p.responder) {
    p.responder(texto)
    p.responder = null
    return null
  }
  return texto
}

/**
 * Texto solto: uma resposta, ou a legenda que faltava.
 *
 * A CITAÇÃO manda. Com três comprovantes esperando, é ela que diz a qual a
 * resposta pertence — e é isso que libera responder fora de ordem.
 */
function responderTexto(de, texto, respondendoA, enviar) {
  const meus = pendentes.doRemetente(de)
  if (!meus.length || !texto?.trim()) return null

  // 1) Citou alguma coisa: vale o que foi citado.
  let alvo = pendentes.porCitacao(de, respondendoA)

  // 2) Não citou. Se só um está esperando resposta, é ele — não há dúvida.
  if (!alvo) {
    const perguntados = meus.filter(p => p.perguntadoEm)
    if (perguntados.length === 1) alvo = perguntados[0]
    else if (perguntados.length > 1) {
      // Vários esperando e nenhuma citação: adivinhar aqui é o que faz
      // resposta cair no comprovante errado, que é pior que perguntar.
      const linhas = [`Tenho ${perguntados.length} comprovantes esperando resposta. Esta é de qual?`]
      perguntados.forEach((p, i) => linhas.push(`${i + 1}) ${apelidoDoItem(p)}`))
      linhas.push('')
      linhas.push('Responde *citando* a mensagem daquele comprovante — ou manda o número dele.')
      // Guarda a numeração para "1" funcionar como escolha.
      for (const p of perguntados) { p.opcoesPendentes = perguntados.map(x => x.id); pendentes.atualizar(p) }
      return linhas.join('\n')
    }
  }

  // 3) Ninguém foi perguntado ainda: é a legenda da última foto sem legenda.
  if (!alvo) {
    const semLegenda = meus.filter(p => !p.descricao && p.esperandoLegendaAte > Date.now())
    alvo = semLegenda[semLegenda.length - 1] ?? null
    if (!alvo) return null
    alvo.descricao = texto.trim()
    alvo.esperandoLegendaAte = 0
    pendentes.atualizar(alvo)
    if (enviar) alvo.enviar = enviar
    return resolveDireto(alvo).then(t => entregar(alvo, t))
  }

  if (enviar) alvo.enviar = enviar
  return aplicarResposta(alvo, texto)
}

/** Aplica o que a pessoa respondeu ao comprovante certo. */
function aplicarResposta(p, texto) {
  if (DESISTENCIA.test(texto)) {
    return paraCaixa(p).then((r) => { pendentes.remover(p.id); return r })
  }

  /*
    Respondendo à pergunta de DUPLICATA.

    Descartar aqui é a única coisa que o robô faz que não deixa rastro em
    lugar nenhum — por isso só acontece com a pessoa dizendo, com todas as
    letras, que é o mesmo comprovante.
  */
  if (p.esperandoDuplicata) {
    if (MESMO_PAGAMENTO.test(texto)) {
      console.log(`[gastos] ${p.de} → duplicata confirmada, descartado`)
      pendentes.remover(p.id)
      return Promise.resolve('👍 Beleza, não lancei — era o mesmo que já tinha entrado.')
    }
    if (OUTRO_PAGAMENTO.test(texto)) {
      p.esperandoDuplicata = false
      p.duplicataConfirmada = true
      p.jaPerguntou = false
      p.perguntadoEm = null
      pendentes.atualizar(p)
      return resolveDireto(p)
    }
    // Respondeu outra coisa: trata como informação nova (pode estar
    // corrigindo o valor, que é o que faria os dois deixarem de ser iguais).
    p.esperandoDuplicata = false
    p.duplicataConfirmada = true
  }

  const so = texto.trim().replace(/[).\s]+$/, '')

  // Escolheu um COMPROVANTE pelo número, quando havia vários sem citação.
  if (/^\d{1,2}$/.test(so) && p.opcoesPendentes?.length) {
    const escolhido = pendentes.porId(p.opcoesPendentes[Number(so) - 1])
    for (const id of p.opcoesPendentes) {
      const outro = pendentes.porId(id)
      if (outro) { delete outro.opcoesPendentes; pendentes.atualizar(outro) }
    }
    if (escolhido) {
      return `Certo, é o "${apelidoDoItem(escolhido)}". Agora me responde: ` +
        `${escolhido.ultimaPergunta ?? 'o que falta nele?'}`
    }
  }

  /*
    "1" ou "2" respondendo a uma lista de OBRAS.

    Sem isto o número seria lido como valor — "1" viraria R$ 1,00 e o gasto
    entraria errado.
  */
  if (/^\d{1,2}$/.test(so) && p.opcoes?.length) {
    const i = Number(so) - 1
    if (i >= 0 && i < p.opcoes.length) {
      p.obraEscolhida = p.opcoes[i]

      /*
        APRENDE.

        A pessoa escreveu um nome que o robô não reconheceu, ele perguntou, e
        ela apontou qual era. Esse é o único momento em que se sabe, com
        certeza, o que aquela palavra quer dizer — e é por isso que só se
        aprende aqui. Aprender de um palpite propagaria o erro: bastaria ele
        guardar "areia" como apelido de uma obra para toda compra de areia ir
        parar lá.
      */
      if (!p.dados?.obra) {
        /*
          O que sobrou depois de tirar valor, tipo e obra e a DESCRICAO — e e
          dentro dela que esta o nome que ele nao reconheceu, misturado com o
          que foi comprado ("escola do ze cimento").

          Tenta as tres primeiras palavras, depois as duas, depois a
          primeira: nome de obra vem no comeco do jeito que as pessoas
          escrevem, e o que sobra atras e a compra.
        */
        const sobra = (p.dados?.descricao ?? p.descricao ?? '').trim()
        const palavras = sobra.split(/\s+/).filter(Boolean)

        for (const quantas of [3, 2, 1]) {
          if (palavras.length < quantas) continue
          const candidato = palavras.slice(0, quantas).join(' ')

          // "areia", "cimento", "material" descrevem a compra. Guardar um
          // deles como apelido faria toda compra de areia cair nesta obra.
          if (ehVocabularioConhecido(candidato)) continue

          if (memoria.aprenderApelido(candidato, p.obraEscolhida)) {
            p.apelidoAprendido = candidato
            break
          }
        }
      }
    } else {
      p.respostas.push(texto.trim())
    }
  } else {
    p.respostas.push(texto.trim())
  }

  // Perguntar de novo é permitido depois de uma resposta: a pessoa pode ter
  // dado só metade do que faltava.
  p.jaPerguntou = false
  p.perguntadoEm = null
  pendentes.atualizar(p)
  return resolveDireto(p)
}

/** O que ainda está esperando. */
function listar(de) {
  const meus = pendentes.doRemetente(de)
  if (!meus.length) return '✅ Não tenho nenhum comprovante seu esperando.'

  const linhas = [`Tenho ${meus.length} comprovante(s) seu(s) esperando:`]
  meus.forEach((p, i) => {
    const falta = []
    if (!p.dados?.obra) falta.push('obra')
    if (p.dados?.valor == null) falta.push('valor')
    linhas.push(`${i + 1}) ${apelidoDoItem(p)}${falta.length ? ` — falta ${falta.join(' e ')}` : ''} _(${faz(Date.now() - p.criadoEm)})_`)
  })
  linhas.push('')
  linhas.push('Responde *citando* a mensagem de cada um — pode ser em qualquer ordem.')
  linhas.push('_(ou escreve *cancelar tudo* para mandar todos para a caixa)_')
  return linhas.join('\n')
}

/** Manda tudo que está esperando para a caixa e limpa. */
async function descartarTudo(de) {
  const meus = pendentes.doRemetente(de)
  if (!meus.length) return '✅ Não tinha nada seu esperando.'

  await Promise.allSettled(meus.map(async (p) => {
    await paraCaixa(p)
    pendentes.remover(p.id)
  }))
  return `📥 Mandei os ${meus.length} para a caixa de comprovantes.\nAbre /m/gasto no sistema para lançar cada um.`
}

/**
 * A ronda: cobra quem sumiu, e desiste de quem sumiu demais.
 *
 * "Se eu demorar a responder, ele me cobra depois?" Cobra — uma vez. Robô
 * que insiste vira aquele contato que a gente silencia, e aí ele para de
 * servir para qualquer coisa. Passado o prazo maior, o comprovante vai para
 * a caixa: de lá nada se perde, só dá mais trabalho.
 */
async function ronda() {
  const agora = Date.now()

  for (const p of pendentes.todos()) {
    if (!p.perguntadoEm) continue
    const parado = agora - p.perguntadoEm

    if (parado > DESISTIR_APOS_MS) {
      const r = await paraCaixa(p)
      pendentes.remover(p.id)
      await avisar(p, `⏰ Faz ${faz(parado)} que perguntei sobre este e não tive resposta.\n${r}`)
      continue
    }

    if (parado > COBRAR_APOS_MS && !p.cobradoEm) {
      p.cobradoEm = agora
      pendentes.atualizar(p)
      await avisar(p,
        `🔔 Lembrete: este comprovante ainda está esperando desde ${faz(parado)}.\n`
        + `${apelidoDoItem(p)}\n`
        + `${p.ultimaPergunta ?? 'Falta a obra ou o valor.'}\n`
        + '_(responde citando esta mensagem, ou escreve *cancelar tudo*)_')
    }
  }
}

/** Liga a ronda. Chamado uma vez, no arranque. */
export function iniciarRonda() {
  pendentes.carregar()
  const t = setInterval(() => { ronda().catch(e => console.error('[gastos] ronda:', e.message)) }, RONDA_MS)
  t.unref?.()
  return t
}

/**
 * Encerrando: o que estava esperando FICA, agora que mora em disco.
 *
 * Antes isto despejava tudo na caixa, porque a memória ia embora com o
 * processo. Com o arquivo em disco, um deploy deixou de ser motivo para
 * desistir de um comprovante — ele é relido no arranque e continua
 * esperando a resposta.
 */
export async function encerrar() {
  const quantos = pendentes.quantos()
  if (quantos) console.log(`[gastos] ${quantos} comprovante(s) ficam esperando em disco até a próxima subida.`)
  return quantos
}

/** Só para teste: esquece o que está esperando. */
export function _limparPendentes() {
  for (const p of pendentes.todos()) pendentes.remover(p.id)
  pendentes._esquecer()
}

/**
 * O que ele responde a "ping".
 *
 * Diz o que está e o que NÃO está pronto. Só "estou aqui" enganaria: o robô
 * pode estar conectado e ainda assim sem token de obras, e aí o comprovante
 * some sem ninguém entender por quê.
 */
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
  linhas.push('_haia, tijolos e areia, material, 2500,00_')
  linhas.push('Se faltar alguma coisa, eu pergunto — e você responde citando a mensagem.')
  return linhas.join('\n')
}

/**
 * "É outro pagamento" — segue e lança.
 *
 * "de novo" e "comprei de novo" entram porque é como se responde na prática:
 * a pergunta foi "é outro ou é o mesmo?", e ninguém repete a palavra da
 * pergunta.
 */
const OUTRO_PAGAMENTO = /^\s*(outro|outro pagamento|e outro|é outro|nao e o mesmo|não é o mesmo|de novo|comprei de novo|sim,? e outro|pode lancar|pode lançar|lanca|lança)\s*[!.]*\s*$/i

/** "É o mesmo comprovante" — descarta sem lançar. */
const MESMO_PAGAMENTO = /^\s*(mesmo|o mesmo|e o mesmo|é o mesmo|duplicado|duplicata|repetido|ja lancou|já lançou|ja mandei|já mandei|descarta|ignora)\s*[!.]*\s*$/i

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
      arquivo: pendentes.arquivoDe(pendente), tipo: pendente.tipo, descricao: escritoTudo,
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

  /*
    Mesma obra e mesmo valor de um lançamento recente: pode ser duplicata.

    PERGUNTA, não recusa. Valor repetido é comum de verdade — dois sacos de
    cimento no mesmo dia, a diária do mesmo pedreiro na semana seguinte. Quem
    sabe se é o mesmo pagamento é quem pagou, e barrar sozinho faria o robô
    engolir gasto legítimo em silêncio, que é o pior erro que ele pode
    cometer aqui.
  */
  if (!pendente.duplicataConfirmada) {
    const igual = memoria.parecidoCom(
      { obra: dados.obra, valor: dados.valor }, pendente.idMensagem,
    )
    if (igual) {
      pendente.esperandoDuplicata = true
      pendente.jaPerguntou = true
      const quando = new Date(igual.quando)
      const quandoTexto = quando.toDateString() === new Date().toDateString()
        ? `hoje às ${quando.getHours()}h${String(quando.getMinutes()).padStart(2, '0')}`
        : `em ${quando.getDate()}/${quando.getMonth() + 1}`
      return {
        perguntando: true,
        texto: [
          `⚠ Já lancei um igual a este ${quandoTexto}:`,
          `   ${igual.obra} · ${igual.descricao ?? 'sem descrição'} · ${moeda(igual.valor)}`,
          '',
          'É outro pagamento, ou é o mesmo comprovante?',
          'Responde *outro* para lançar, ou *mesmo* para descartar.',
        ].join('\n'),
      }
    }
  }

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

  /*
    A pergunta em si fica guardada à parte.

    A cobrança, horas depois, repete ELA — não a última linha do que foi
    dito. A última linha costuma ser a lista de obras, e repetir só a lista
    não lembra ninguém do que estava sendo perguntado.
  */
  const pergunta = candidatos?.length
    ? 'Aí tem mais de uma obra. É qual delas?'
    : falta.includes('obra') && falta.includes('valor')
      ? 'Só faltou a *obra* e o *valor*. Me manda os dois?'
      : falta.includes('obra')
        ? 'De qual *obra* é esse gasto?'
        : 'Qual foi o *valor*?'

  pendente.ultimaPergunta = pergunta
  linhas.push(pergunta)

  if (candidatos?.length) {
    candidatos.forEach((o, i) => linhas.push(`${i + 1}) ${o}`))
    if (falta.includes('valor')) linhas.push('E qual foi o *valor*?')
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
    arquivo: pendentes.arquivoDe(pendente),
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
    memoria.anotarLancamento({
      obra: r.obra, valor: dados.valor, descricao: dados.descricao,
      categoria: dados.tipo, de: pendente.de, resultado: 'lancado',
      idMensagem: pendente.idMensagem,
    })
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

    // Dizer que aprendeu não é enfeite: é o que faz a pessoa confiar em
    // escrever daquele jeito de novo, em vez de achar que deu sorte.
    if (pendente.apelidoAprendido) {
      linhas.push(`_(anotei que "${pendente.apelidoAprendido}" é essa obra — da próxima vez já sei)_`)
    }

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
    arquivo: pendentes.arquivoDe(pendente),
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
  if (envio.ok) {
    memoria.anotarLancamento({
      obra: dados.obra, valor: dados.valor, descricao: dados.descricao,
      categoria: dados.tipo, de: pendente.de, resultado: 'caixa',
      idMensagem: pendente.idMensagem,
    })
  }

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
