/**
 * Comprovantes — o relatório da semana: quanto o robô acertou sozinho.
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 *
 * "Ficar mais inteligente" só quer dizer alguma coisa se dá para medir. Toda
 * semana (segunda, de manhã) o robô manda um resumo: quantos lançou, quantos
 * sem perguntar nada, quantas obras acertou pelo hábito, quantas vezes foi
 * corrigido. Comparado com a semana anterior — subir o "sem pergunta" e
 * baixar as correções é ele aprendendo.
 *
 * Vai para quem recebe as dúvidas: GASTOS_RELATORIO_PARA, ou o destino do
 * grupo de leitura (o privado do dono), ou o grupo dos comprovantes. Também
 * sai na hora, quando alguém escreve "relatório" no grupo.
 *
 * Ligado por padrão (decisão do dono, 24/11/2026); GASTOS_RELATORIO=off
 * desliga.
 */
import * as memoria from './memoria.js'
import { enviarMensagem, conectado } from '../connectors.js'

const ligado = () => String(process.env.GASTOS_RELATORIO ?? 'on').toLowerCase() !== 'off'

/** Dia da semana (0 = domingo) e hora em que sai. Padrão: segunda, 8h. */
const DIA_DA_SEMANA = Number(process.env.GASTOS_RELATORIO_DIA ?? 1)
const HORA = Number(process.env.GASTOS_RELATORIO_HORA ?? 8)

/** "relatório", "como você está indo?" — pede o relatório na hora. */
export const PEDE_RELATORIO = /^\s*(relat[oó]rio|relat[oó]rio da semana|como (voc[eê] )?(est[aá]|t[aá]) indo|como foi a semana)\s*[?!.]*\s*$/i

const emBrasilia = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ms))
const curta = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
const DIA = 24 * 60 * 60 * 1000
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—')

/** Para onde o relatório vai. */
function destino() {
  return (process.env.GASTOS_RELATORIO_PARA || process.env.GASTOS_LEITURA_DESTINO || '').trim() || memoria.grupoLembrado() || null
}

/**
 * O texto do relatório de uma semana (`fim` é o último dia, incluído).
 * Devolve null quando não houve nada na semana.
 */
export function montarRelatorio(fim = emBrasilia(Date.now() - DIA)) {
  const fimMs = Date.parse(`${fim}T12:00:00-03:00`)
  const inicio = emBrasilia(fimMs - 6 * DIA)
  const c = memoria.contagemEntre(inicio, fim)
  const antes = memoria.contagemEntre(emBrasilia(fimMs - 13 * DIA), emBrasilia(fimMs - 7 * DIA))
  const n = (k, de = c) => de[k] ?? 0

  if (!n('lancado') && !n('caixa') && !n('pergunta')) return null

  const linhas = [`📈 *Como eu fui na semana* (${curta(inicio)} a ${curta(fim)})`]
  const semPerg = pct(n('semPergunta'), n('lancado'))
  const semPergAntes = n('lancado', antes) ? ` (semana anterior: ${pct(n('semPergunta', antes), n('lancado', antes))})` : ''
  linhas.push(`✅ ${n('lancado')} lançado(s) · ${n('semPergunta')} sem nenhuma pergunta — ${semPerg}${semPergAntes}`)
  linhas.push(`❓ ${n('pergunta')} pergunta(s) feita(s)`)
  if (n('habitoDireto') || n('sugestaoAceita') || n('sugestaoRecusada')) {
    linhas.push(`📌 ${n('habitoDireto')} obra(s) pelo hábito, lançadas direto · sugestões: ${n('sugestaoAceita')} aceita(s), ${n('sugestaoRecusada')} recusada(s)`)
  }
  if (n('ia')) linhas.push(`🧠 ${n('ia')} frase(s) que só entendi com a IA`)
  linhas.push(`✏️ ${n('corrigido')} correção(ões) · ${n('cancelado')} cancelado(s)`)
  linhas.push(`📥 ${n('caixa')} na caixa · ${n('repetidoBarrado')} repetido(s) barrado(s)`)
  const conhecidos = memoria.fornecedoresConhecidos()
  if (conhecidos) linhas.push(`Já sei de que obra costumam ser ${conhecidos} fornecedor(es).`)
  return linhas.join('\n')
}

/** Manda agora, se é a hora e ainda não foi esta semana. Devolve o texto mandado, ou null. */
export async function talvezMandar(agora = new Date()) {
  if (!ligado()) return null
  const hoje = emBrasilia(agora.getTime())
  const semana = hoje   // a segunda-feira em que saiu identifica a semana
  // Dia da semana e hora em Brasília, seja qual for o fuso do servidor.
  const partes = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(agora).map(p => [p.type, p.value]))
  const diaDaSemana = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(partes.weekday)
  if (diaDaSemana !== DIA_DA_SEMANA || Number(partes.hour) < HORA) return null
  if (memoria.relatorioDaSemana() === semana) return null

  // A semana que acabou ontem. Sem nada para contar, marca e não manda.
  const texto = montarRelatorio(emBrasilia(agora.getTime() - DIA))
  const para = destino()
  if (!texto || !para) { memoria.marcarRelatorio(semana); return null }
  // Com o WhatsApp caído, não marca: tenta de novo na próxima volta.
  if (!(await conectado())) return null
  const r = await enviarMensagem(para, texto)
  if (r?.ok === false) {
    console.error('[relatorio] não consegui enviar:', r.motivo)
    return null
  }
  memoria.marcarRelatorio(semana)
  console.log('[relatorio] relatório da semana enviado.')
  return texto
}

/** Olha de tempos em tempos se é hora do relatório. Chamado uma vez, no arranque. */
export function agendarRelatorio() {
  if (!ligado()) return null
  const t = setInterval(() => { talvezMandar().catch(e => console.error('[relatorio]', e.message)) }, 10 * 60 * 1000)
  t.unref?.()
  console.log(`[relatorio] relatório semanal ligado (dia ${DIA_DA_SEMANA} da semana, a partir das ${HORA}h)`)
  return t
}
