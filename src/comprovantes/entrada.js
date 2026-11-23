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
  AUTORIZADOS, GRUPOS, QUALQUER_UM_DO_GRUPO, gastosAtivo, origemAceita, podeLancarGasto,
} from './autorizacao.js'
import {
  PERGUNTAS_DE_TESTE, LISTAR, CANCELAR_TUDO, respostaDeTeste, listar, descartarTudo, responderTexto,
} from './conversa.js'
import { OBRAS_RESERVA, processarUmaVez, entregar, timersLegenda } from './processar.js'
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

export async function tratar(msg) {
  const { de, chat, chatNome, arquivo, nomeArquivo, tipo, texto, idMensagem } = msg

  if (!origemAceita(chat, chatNome)) return null

  // O coringa só vale vindo de grupo casado pelo IDENTIFICADOR — no privado
  // nunca, e por nome de grupo também não.
  if (!podeLancarGasto(msg)) {
    // Nem responde. Dizer "você não pode" a quem mandou foto num grupo
    // confirma que existe um robô ouvindo e convida a insistir.
    if (arquivo) console.warn(`[gastos] comprovante ignorado: ${discreto(de)} não está em GASTOS_AUTORIZADOS`)
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
    // O endereço da conversa vai para o disco junto: é por ele que o robô
    // consegue falar depois de um reinício, quando a função de envio já não
    // existe mais.
    chat,
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
