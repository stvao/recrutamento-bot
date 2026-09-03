/**
 * O resumo do fim do dia, no grupo dos comprovantes.
 *
 * Existe porque durante o dia cada comprovante é uma resposta solta no meio
 * da conversa, e ninguém consegue somar isso de cabeça. Uma linha no fim do
 * expediente responde a pergunta que se faz todo dia — "quanto entrou hoje,
 * e o que ficou faltando?" — sem abrir o sistema.
 *
 * O que ele NÃO faz é cobrar. O resumo diz o que aconteceu; se algo ficou
 * pendente, aparece como uma linha, não como bronca. Robô que cobra todo dia
 * vira aquele contato que a gente silencia.
 */
import * as memoria from './memoria.js'
import * as pendentes from './pendentes.js'
import { enviarMensagem } from './connectors.js'

/**
 * A que horas o dia "fecha". Formato 24h, hora local.
 *
 * Fim de expediente e não meia-noite: às 18h a informação ainda serve para
 * alguém fazer alguma coisa hoje; à meia-noite ela só existe.
 */
const HORA = process.env.GASTOS_RESUMO_HORA ?? '18:00'

/** Desligado por padrão: uma mensagem automática por dia é decisão de quem usa. */
const LIGADO = String(process.env.GASTOS_RESUMO ?? 'off').toLowerCase() !== 'off'

const brl = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`

/**
 * Monta o texto do resumo. Devolve null quando não houve nada.
 *
 * Nada acontecido é silêncio, e não "hoje não entrou nenhum comprovante":
 * num sábado, ou numa semana parada, a mensagem diária de "nada" é o tipo de
 * ruído que faz as pessoas silenciarem o robô — e aí ele perde também os
 * dias em que teria algo a dizer.
 */
export function montar({ dia = memoria.comecoDeHoje(), esperando = 0 } = {}) {
  const doDia = memoria.doDia(dia)
  if (!doDia.length && !esperando) return null

  const lancados = doDia.filter(l => l.resultado === 'lancado')
  const naCaixa = doDia.filter(l => l.resultado === 'caixa')
  const total = lancados.reduce((s, l) => s + (l.valor ?? 0), 0)

  const linhas = ['📊 *Fechamento do dia*']

  if (lancados.length) {
    linhas.push(`${lancados.length} comprovante(s) lançado(s) · ${brl(total)}`)

    // Por obra, do maior para o menor: é assim que se olha um custo do dia.
    const porObra = new Map()
    for (const l of lancados) {
      const obra = l.obra ?? 'sem obra'
      porObra.set(obra, (porObra.get(obra) ?? 0) + (l.valor ?? 0))
    }
    for (const [obra, valor] of [...porObra].sort((a, b) => b[1] - a[1])) {
      linhas.push(`  · ${obra}: ${brl(valor)}`)
    }
  } else {
    linhas.push('Nenhum lançamento hoje.')
  }

  // As duas pendências são diferentes e é preciso distinguir: uma espera VOCÊ
  // responder aqui; a outra espera alguém abrir o sistema.
  if (esperando) {
    linhas.push('')
    linhas.push(`⏳ ${esperando} esperando você responder aqui — escreve *pendentes* para ver.`)
  }
  if (naCaixa.length) {
    linhas.push(`📥 ${naCaixa.length} foram para a caixa de comprovantes (falta obra ou valor) — /m/gasto.`)
  }
  if (lancados.length) {
    linhas.push('')
    linhas.push('Os lançados estão em "Aprovar gastos", esperando sua confirmação.')
  }

  return linhas.join('\n')
}

/** Manda o resumo agora, se houver o que dizer e para onde mandar. */
export async function enviarAgora() {
  const texto = montar({ esperando: pendentes.quantos() })
  if (!texto) return null

  const grupo = memoria.grupoLembrado()
  if (!grupo) {
    console.warn('[resumo] não sei para onde mandar — nenhum comprovante chegou ainda.')
    return null
  }

  try {
    await enviarMensagem(grupo, texto)
    console.log('[resumo] fechamento do dia enviado.')
    return texto
  } catch (e) {
    console.error('[resumo] não consegui enviar:', e.message)
    return null
  }
}

/** Quantos milissegundos faltam para a próxima vez que der HORA. */
export function proximoEm(agora = new Date()) {
  const [h, m] = HORA.split(':').map(Number)
  const alvo = new Date(agora)
  alvo.setHours(h || 0, m || 0, 0, 0)
  if (alvo <= agora) alvo.setDate(alvo.getDate() + 1)
  return alvo.getTime() - agora.getTime()
}

/**
 * Agenda o resumo.
 *
 * Reagenda a cada disparo em vez de usar um intervalo de 24 horas: intervalo
 * fixo escorrega com o horário de verão e com o tempo que a máquina passa
 * suspensa, e depois de um mês o "fechamento das 18h" chega às 19h30.
 */
export function agendar() {
  if (!LIGADO) return null

  const proximo = () => {
    const daqui = proximoEm()
    const t = setTimeout(async () => {
      await enviarAgora().catch(e => console.error('[resumo]', e.message))
      proximo()
    }, daqui)
    t.unref?.()
    return t
  }

  const minutos = Math.round(proximoEm() / 60000)
  console.log(`[resumo] fechamento do dia às ${HORA} (próximo em ${minutos} min)`)
  return proximo()
}
