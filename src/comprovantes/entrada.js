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
import { visaoDisponivel } from './ia-visao.js'
import { obrasConfigurado } from './obras-client.js'
import { discreto } from '../texto.js'
import {
  AUTORIZADOS, GRUPOS, QUALQUER_UM_DO_GRUPO, gastosAtivo, origemAceita, podeLancarGasto, telefoneDeQuemMandou, ehGrupoDeLeitura, numeroNaLista,
} from './autorizacao.js'
import {
  PERGUNTAS_DE_TESTE, pedeLista, APROVAR, respostaDeAprovar, CANCELAR_TUDO, respostaDeTeste, listar, descartarTudo, responderTexto,
} from './conversa.js'
import { OBRAS_RESERVA, processarUmaVez, entregar, timersLegenda } from './processar.js'
import { remetenteDaResposta } from './atraso.js'
import { tentarCorrecao } from './correcao.js'
import { receberDoGrupoDeLeitura, esperaRespostaEm, conversaDoDestino } from './leitura.js'
import { atendimento } from './saida.js'
import { PEDE_RELATORIO, montarRelatorio } from './relatorio.js'
import { esperarFotosAnteriores, soltarArquivo } from './a-caminho.js'
import * as pendentes from './pendentes.js'
import * as memoria from './memoria.js'

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

/**
 * Quantos comprovantes uma pessoa pode ter esperando.
 *
 * Alto de propósito: o arquivo mora em disco, não na memória, e o custo de
 * mais um esperando é uma ficha de poucos bytes. O teto existe só para um
 * erro (alguém despejando o rolo da câmera) não encher o disco.
 */
const MAX_ESPERANDO = Number(process.env.GASTOS_MAX_AGUARDANDO || 50)

/**
 * Quanto esperar por uma legenda que vem em mensagem separada.
 *
 * Muita gente manda a foto e escreve o "o que é" logo em seguida. Perguntar
 * antes disso seria perguntar o que a pessoa já ia dizer — e é essa descrição
 * que diz de qual obra é o gasto, que o comprovante não informa.
 */
const ESPERA_LEGENDA_MS = Number(process.env.GASTOS_ESPERA_DESCRICAO_MS || 60000)

/**
 * As confirmações "✅ Lançado" que estão para sair.
 *
 * Quem manda a resposta é o conector (ele cita a mensagem, cuida do ritmo).
 * Este módulo só devolve o texto — e por isso não sabe o id da mensagem que
 * saiu. O conector avisa de volta (`respostaEnviada`), e aqui se guarda,
 * por pouco tempo, a QUAL comprovante aquela resposta se refere.
 */
const confirmacoesASair = new Map()   // id da mensagem recebida → { idComprovante, ate }
const VALIDADE_CONFIRMACAO_MS = 5 * 60 * 1000

export async function tratar(msg) {
  // O privado do dono, se ele for o destino das dúvidas, chega às vezes com o
  // número escrito de outro jeito (sem o nono dígito). Daqui em diante vale
  // o endereço como está no destino — é por ele que os comprovantes esperam.
  const chat = conversaDoDestino(msg?.chat, msg?.ehGrupo)
  if (chat !== msg?.chat) msg = { ...msg, chat }

  // Texto: se há foto desta pessoa, mandada ANTES dele, ainda sendo baixada,
  // espera ela chegar — este texto pode ser a legenda dela (a-caminho.js).
  if (!msg?.arquivo && msg?.chaveRemetente) await esperarFotosAnteriores(msg.chaveRemetente, msg.enviadoEm)

  const contexto = { lancados: [] }
  const resposta = await atendimento.run(contexto, () => atender(msg))

  // Um lançamento aconteceu atendendo esta mensagem, e o texto dele está
  // voltando por aqui: a resposta a ESTA mensagem é a confirmação DAQUELE
  // comprovante.
  if (typeof resposta === 'string' && contexto.lancados.length === 1 && msg.idMensagem) {
    const agora = Date.now()
    for (const [id, c] of confirmacoesASair) if (c.ate < agora) confirmacoesASair.delete(id)
    confirmacoesASair.set(String(msg.idMensagem), { idComprovante: contexto.lancados[0], ate: agora + VALIDADE_CONFIRMACAO_MS })
  }
  return resposta
}

/**
 * O conector avisa: a resposta à mensagem `idRecebida` saiu, com o id
 * `idResposta`.
 *
 * Se era a confirmação de um lançamento, o id fica guardado junto dele — e a
 * pessoa passa a poder corrigir o gasto citando o "✅ Lançado", que é o que
 * ela tem na frente, e não só a foto lá em cima.
 */
export function respostaEnviada(idRecebida, idResposta) {
  if (!idRecebida || !idResposta) return false
  const chave = String(idRecebida)
  const esperada = confirmacoesASair.get(chave)
  confirmacoesASair.delete(chave)

  let idComprovante = esperada && esperada.ate >= Date.now() ? esperada.idComprovante : null

  // A foto ficou esperando a legenda e o lançamento saiu atendendo OUTRA
  // mensagem — mas a confirmação responde à foto. Então a própria mensagem
  // respondida é o comprovante.
  if (!idComprovante) {
    const l = memoria.resultadoDe(chave)
    if (l?.resultado === 'lancado' && !l.idConfirmacao && Date.now() - l.quando < VALIDADE_CONFIRMACAO_MS) idComprovante = chave
  }
  return idComprovante ? memoria.anotarConfirmacao(idComprovante, idResposta) : false
}

/**
 * Esta mensagem é resposta a uma pergunta que o robô fez NESTA conversa
 * sobre um comprovante que veio de outro lugar (grupo de leitura, atraso)?
 *
 * No grupo de conversa isso não muda nada — tudo de lá já chega aqui. Serve
 * para o PRIVADO: texto no privado normalmente vai para o recrutamento, e só
 * é assunto de comprovante quando há pergunta do robô esperando ali.
 */
export function esperaRespostaDe(msg) {
  // Só no privado, só de quem está na lista POR NÚMERO, e só enquanto há
  // pergunta do robô ali. O coringa do grupo não vale no privado.
  if (!msg?.chat || msg.ehGrupo) return false
  return numeroNaLista(msg.de) && esperaRespostaEm(conversaDoDestino(msg.chat, false))
}

async function atender(msg) {
  const { de, chat, chatNome, arquivo, nomeArquivo, tipo, texto, idMensagem } = msg

  // Grupo SÓ DE LEITURA: o robô lê o comprovante e fala em outro lugar.
  // Antes de qualquer comando ("ping", "pendentes") — ali nada disso existe.
  if (msg.ehGrupo && ehGrupoDeLeitura(chat, chatNome)) {
    return podeLancarGasto(msg) ? receberDoGrupoDeLeitura(msg) : null
  }

  // No privado, a resposta a uma pergunta que o robô fez ali (o destino das
  // dúvidas de um grupo de leitura pode ser o privado do dono). A origem não
  // está em GASTOS_GRUPOS, e não precisa estar: só passa quem está na lista
  // por número, e só texto.
  const respostaNoPrivado = !arquivo && esperaRespostaDe(msg)

  if (!respostaNoPrivado && !origemAceita(chat, chatNome)) return null

  // O coringa só vale vindo de grupo casado pelo IDENTIFICADOR — no privado
  // nunca, e por nome de grupo também não.
  if (!respostaNoPrivado && !podeLancarGasto(msg)) {
    // Nem responde. Dizer "você não pode" a quem mandou foto num grupo
    // confirma que existe um robô ouvindo e convida a insistir.
    if (arquivo) console.warn(`[gastos] comprovante ignorado: ${discreto(de)} não está em GASTOS_AUTORIZADOS`)
    return null
  }

  if (!arquivo && PERGUNTAS_DE_TESTE.test(texto ?? '')) return respostaDeTeste()
  /*
    Os comprovantes do grupo antigo não foram mandados por quem está
    respondendo — ficam guardados num nome próprio (ver atraso.js). Aqui se
    descobre se esta mensagem é resposta a um deles. Quem tem comprovante
    próprio esperando continua sendo atendido pelo dele, como sempre.

    "cancelar tudo" fica de fora de propósito: mandar de uma vez para a caixa
    dezenas de comprovantes que outra rotina está tratando não é coisa para
    duas palavras num grupo.
  */
  // Citou um gasto JÁ LANÇADO e escreveu uma correção ("valor 1800",
  // "apagar")? Vem antes de tudo: é o único texto que mexe no que já entrou,
  // e só vale com citação. `undefined` = não é correção, segue o de sempre.
  if (!arquivo) {
    const correcao = await tentarCorrecao(msg)
    if (correcao !== undefined) return correcao
  }

  const quem = arquivo ? de : remetenteDaResposta(msg)

  if (!arquivo && pedeLista(texto)) return listar(quem)
  if (!arquivo && APROVAR.test(texto ?? '')) return respostaDeAprovar()
  if (!arquivo && PEDE_RELATORIO.test(texto ?? '')) {
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())
    return montarRelatorio(hoje) ?? 'Ainda não tenho o que contar destes últimos 7 dias.'
  }
  if (!arquivo && CANCELAR_TUDO.test(texto ?? '')) return descartarTudo(de)
  if (!arquivo) return responderTexto(quem, texto, msg.respondendoA, msg.enviarResposta)

  // ── Chegou um comprovante ────────────────────────────────────────────────
  if (pendentes.doRemetente(de).length >= MAX_ESPERANDO) {
    return `⚠ Já tenho ${MAX_ESPERANDO} comprovantes seus esperando. Responde alguns antes de mandar mais, ou escreve *cancelar tudo*.`
  }

  // De onde vêm os comprovantes — o resumo do dia sai por conta própria e
  // precisa saber para onde mandar.
  if (msg.ehGrupo && chat) memoria.lembrarGrupo(chat)

  const p = pendentes.guardar({
    // O endereço da conversa vai para o disco junto: é por ele que o robô
    // consegue falar depois de um reinício, quando a função de envio já não
    // existe mais.
    chat,
    de, arquivo, nomeArquivo, tipo,
    // Para o sistema saber de quem é o reembolso. null quando não se sabe o
    // telefone de verdade — ver `telefoneDeQuemMandou`.
    enviadoPor: telefoneDeQuemMandou(msg),
    descricao: texto || null,
    respostas: [],
    idMensagem,
    enviadoEm: msg.enviadoEm ?? Date.now(),
    criadoEm: Date.now(),
  })
  p.enviar = msg.enviarResposta
  // Guardada: o texto que esperava por ela já pode seguir.
  soltarArquivo(msg.chaveRemetente, idMensagem)

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
      const t = setTimeout(() => {
        timersLegenda.delete(p.id)
        const atual = pendentes.porId(p.id)
        // Já resolvido, ou a legenda chegou e o comprovante seguiu por lá
        // (talvez com uma pergunta no ar). Processar de novo mandava para a
        // caixa o comprovante que esperava a resposta da pessoa.
        if (!atual || !atual.esperandoLegendaAte || atual.perguntadoEm) return
        atual.esperandoLegendaAte = 0
        processarUmaVez(atual).then(t => entregar(atual, t))
      }, ESPERA_LEGENDA_MS)
      t.unref?.()
      timersLegenda.set(p.id, t)
    })
  }

  return processarUmaVez(p)
}

/** Só para teste: esquece o que está esperando. */
export function _limparPendentes() {
  for (const p of pendentes.todos()) pendentes.remover(p.id)
  pendentes._esquecer()
}
