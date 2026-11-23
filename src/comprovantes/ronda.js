/**
 * Comprovantes — a ronda: lembra uma vez quem não respondeu e, passado o
 * prazo, manda o comprovante para a caixa.
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 */
import { processarUmaVez, avisar, emAndamento, timersLegenda } from './processar.js'
import { paraCaixa } from './saida.js'
import { apelidoDoItem, faz } from './formato.js'
import * as pendentes from './pendentes.js'

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
 * A ronda: cobra quem sumiu, e desiste de quem sumiu demais.
 *
 * "Se eu demorar a responder, ele me cobra depois?" Cobra — uma vez. Robô
 * que insiste vira aquele contato que a gente silencia, e aí ele para de
 * servir para qualquer coisa. Passado o prazo maior, o comprovante vai para
 * a caixa: de lá nada se perde, só dá mais trabalho.
 */
async function ronda() {
  const agora = Date.now()

  // Primeiro, os órfãos: comprovante que reiniciou durante a espera pela
  // legenda volta sem `perguntadoEm`, e o laço abaixo pula justamente esses.
  // Sem isto eles ficariam no disco para sempre — e, somando cinquenta,
  // passariam a impedir comprovante novo da mesma pessoa.
  const vencidos = pendentes.limparAntigos(agora)
  if (vencidos) console.log(`[gastos] ${vencidos} comprovante(s) antigos sem resposta — descartados`)

  /*
    Órfãos: voltaram do disco sem pergunta feita e sem timer (o robô
    reiniciou enquanto esperava a legenda ou lia a foto). Ninguém os
    processava: ficavam mudos até serem apagados em 7 dias, sem nunca chegar
    ao Obras. Aqui recebem o que o timer teria feito. Recusado pela caixa há
    pouco, espera a próxima tentativa sem repetir o aviso.
  */
  for (const p of pendentes.todos()) {
    if (p.perguntadoEm || emAndamento.has(p.id) || timersLegenda.has(p.id)) continue
    if (p.esperandoLegendaAte && p.esperandoLegendaAte > agora) continue
    if (p.caixaRecusouEm && agora - p.caixaRecusouEm < 30 * 60 * 1000) continue
    p.esperandoLegendaAte = 0
    const jaRecusadoAntes = !!p.caixaRecusouEm
    const texto = await processarUmaVez(p)
    if (texto && !(jaRecusadoAntes && p.caixaRecusouEm)) await avisar(p, texto)
  }

  for (const p of pendentes.todos()) {
    if (!p.perguntadoEm) continue
    const parado = agora - p.perguntadoEm

    if (parado > DESISTIR_APOS_MS) {
      /*
        Esperando SÓ o nome do sócio? Então lança, sem ele.

        Obra e valor decidem SE o gasto pode entrar — sem um deles o
        comprovante vai mesmo para a caixa, onde alguém completa à mão. Mas o
        sócio decide só COMO o gasto fica registrado, e mandar para a caixa um
        comprovante que está completo seria trocar um lançamento automático por
        trabalho manual, por causa de um campo que a aprovação preenche.

        Sem isto, acrescentar a pergunta do sócio teria PIORADO o módulo: todo
        comprovante sem resposta cairia na caixa, inclusive os que antes
        entravam sozinhos.
      */
      if (p.esperandoPagador && p.dados?.obra && p.dados?.valor != null) {
        p.esperandoPagador = false
        p.pagadorPerguntado = true
        pendentes.atualizar(p)
        const texto = await processarUmaVez(p)
        if (texto) await avisar(p, `⏰ Ninguém disse quem pagou, então lancei sem essa informação.\n${texto}`)
        continue
      }

      const { ok, texto } = await paraCaixa(p)
      if (!ok) {
        // Fica guardado e a próxima ronda tenta de novo — sem avisar a cada
        // 5 minutos que o sistema de obras está fora.
        pendentes.atualizar(p)
        continue
      }
      pendentes.remover(p.id)
      await avisar(p, `⏰ Faz ${faz(parado)} que perguntei sobre este e não tive resposta.\n${texto}`)
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

/**
 * Uma passada da ronda, sem reler o disco. Só para teste.
 *
 * `iniciarRonda` relê a pasta, e a ficha que volta do disco não tem mais o
 * canal de conversa — uma função não sobrevive a ser gravada. Num teste isso
 * esconderia justamente o que se quer conferir: o que o robô FALA ao decidir
 * sozinho.
 */
export async function _rodarRonda() {
  return ronda()
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
