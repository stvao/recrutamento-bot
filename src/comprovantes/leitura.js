/**
 * Comprovantes — o grupo SÓ DE LEITURA.
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 *
 * Há um grupo onde a equipe manda comprovante todo dia e onde o robô não
 * deve falar: tem gente demais ali, e o grupo não é dele. O que se quer é
 * que ele LEIA o que chega, lance, e — quando tiver dúvida — pergunte em
 * outro lugar: no grupo de conversa com o robô, ou direto ao dono.
 *
 * É o caminho de sempre (`processar`), com três diferenças:
 *
 *  - nada é dito no grupo de onde o comprovante veio. Nem pergunta, nem
 *    confirmação, nem "estou aqui". Tudo sai para o DESTINO configurado;
 *  - como a pergunta vai parar longe da foto, ela diz de que grupo veio,
 *    quando, quem mandou e o que estava escrito;
 *  - quem responde não é quem mandou. Os comprovantes ficam guardados num
 *    nome próprio do destino (o mesmo do atraso), e qualquer pessoa
 *    autorizada de lá responde por eles, citando.
 *
 * Para isso o NÚMERO DO ROBÔ tem de estar no grupo — é por ser membro que
 * ele recebe as mensagens. Ele entra e fica calado.
 *
 * Quem pode lançar continua sendo decidido em `autorizacao.js`, pelas mesmas
 * regras: o grupo de leitura é uma origem como as outras (e, com o coringa
 * "*", tem de estar cadastrado pelo identificador, não pelo nome).
 */
import { ehGrupoDeLeitura, telefoneDeQuemMandou } from './autorizacao.js'
import { processarUmaVez, avisar, timersLegenda } from './processar.js'
import { deDoAtraso } from './atraso.js'
import { enviarMensagem } from '../connectors.js'
import { discreto } from '../texto.js'
import * as pendentes from './pendentes.js'
import * as memoria from './memoria.js'

/** Quanto esperar pela descrição que vem em mensagem separada — o mesmo do dia a dia. */
const ESPERA_LEGENDA_MS = Number(process.env.GASTOS_ESPERA_DESCRICAO_MS || 60000)

/** O teto de comprovantes esperando resposta. Alto: o grupo é da equipe inteira. */
const MAX_ESPERANDO = Number(process.env.GASTOS_LEITURA_MAX_AGUARDANDO || 200)

let enviar = enviarMensagem
let avisouSemDestino = false

/**
 * Para onde vão as perguntas e as confirmações.
 *
 * `GASTOS_LEITURA_DESTINO`: o identificador do grupo de conversa, ou o número
 * de uma pessoa (só dígitos) para falar no privado. Sem ele, vale o grupo do
 * atraso, e depois o grupo de onde os comprovantes do dia a dia já vêm.
 *
 * Nunca um grupo de leitura — seria o robô respondendo justamente onde não
 * deve.
 */
export function destinoDaLeitura() {
  const destino = (process.env.GASTOS_LEITURA_DESTINO || process.env.GASTOS_ATRASO_GRUPO || '').trim() || memoria.grupoLembrado() || null
  return destino && !ehGrupoDeLeitura(destino) ? destino : null
}

/**
 * As formas de escrever um celular brasileiro: com e sem o nono dígito.
 *
 * O WhatsApp nem sempre entrega o número do jeito que foi configurado — o
 * mesmo celular chega como 5511988880000 numa hora e 551188880000 na outra.
 * Sem isto, a resposta do dono no privado não casaria com o destino
 * configurado, e a pergunta ficaria sem resposta para sempre.
 */
function formasDoTelefone(numero) {
  const d = String(numero ?? '').split('@')[0].replace(/\D/g, '')
  if (!/^55\d{10,11}$/.test(d)) return []
  const out = new Set([d])
  if (d.length === 13 && d[4] === '9') out.add(d.slice(0, 4) + d.slice(5))
  if (d.length === 12 && /[6-9]/.test(d[4])) out.add(`${d.slice(0, 4)}9${d.slice(4)}`)
  return [...out]
}

/**
 * O endereço de uma conversa PRIVADA, do jeito que está no destino.
 *
 * Se o destino é um número e esta conversa é com o mesmo celular (escrito de
 * outro jeito), devolve o destino como configurado; senão, a própria
 * conversa. Só para conversa privada — grupo não tem essa história.
 */
export function conversaDoDestino(chat, ehGrupo) {
  if (ehGrupo || !chat) return chat
  const destino = destinoDaLeitura()
  if (!destino || destino.endsWith('@g.us')) return chat
  const formas = formasDoTelefone(destino)
  return formas.length && formas.some(f => formasDoTelefone(chat).includes(f)) ? destino : chat
}

/** Quem pagou, por padrão: a empresa. `perguntar` faz o robô perguntar, como no dia a dia. */
const empresaPagaPorPadrao = () => String(process.env.GASTOS_LEITURA_PAGADOR ?? 'empresa').toLowerCase() !== 'perguntar'

/** Manda o "✅ Lançado" de cada um? Sim, a não ser que se desligue — é citando ele que se corrige depois. */
const confirma = () => String(process.env.GASTOS_LEITURA_CONFIRMA ?? 'on').toLowerCase() !== 'off'

const hora = (ms) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date(ms))
const dia = (ms) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }).format(new Date(ms))

/** O que abre toda mensagem sobre o comprovante: de onde veio, quando, de quem, e o que estava escrito. */
function prefixoDe(p) {
  const l = p.leitura
  const legenda = (p.descricao ?? '').trim()
  return `📎 Do grupo "${l.grupo ?? 'de comprovantes'}" — ${dia(p.enviadoEm)} às ${hora(p.enviadoEm)}, de ${l.nome}\n${legenda ? `"${legenda.slice(0, 200)}"` : '(sem legenda)'}`
}

/**
 * Processa e diz o resultado NO DESTINO.
 *
 * As perguntas já saem por dentro (a máquina de sempre manda e guarda o id,
 * para a resposta poder citar). O que chega aqui é o que não é pergunta: a
 * confirmação do lançamento, "esse já estava lançado", a recusa da caixa.
 */
async function concluir(p) {
  const texto = await processarUmaVez(p)
  if (!texto) return
  // Ficou esperando resposta: a pergunta já foi dita lá dentro.
  if (pendentes.porId(p.id)?.perguntadoEm) return
  if (p.desfecho === 'lancado' && !confirma()) return

  const id = await avisar(p, texto)
  if (id && p.desfecho === 'lancado') memoria.anotarConfirmacao(p.idMensagem, id)
}

/**
 * Uma mensagem chegou de um grupo de leitura. Devolve SEMPRE null: nada é
 * respondido ali.
 */
export async function receberDoGrupoDeLeitura(msg) {
  const { de, chat, chatNome, arquivo, nomeArquivo, tipo, texto, idMensagem } = msg

  const destino = destinoDaLeitura()
  if (!destino) {
    if (!avisouSemDestino) {
      avisouSemDestino = true
      console.error('[gastos] há grupo de leitura (GASTOS_GRUPOS_LEITURA), mas não sei onde perguntar. Defina GASTOS_LEITURA_DESTINO. Os comprovantes de lá NÃO estão sendo lidos.')
    }
    return null
  }

  const dono = deDoAtraso(destino)
  const doMesmoRemetente = (p) => p.leitura?.chat === chat && p.leitura.de === de

  // ── Texto: só serve como a descrição que veio depois da foto ────────────
  // Nenhum comando funciona aqui ("ping", "pendentes", "cancelar tudo"), e
  // conversa do grupo não é assunto do robô.
  if (!arquivo) {
    if (!texto?.trim()) return null
    const alvo = pendentes.doRemetente(dono)
      .filter(p => doMesmoRemetente(p) && !p.descricao && p.esperandoLegendaAte > Date.now()).at(-1)
    if (!alvo) return null
    alvo.descricao = texto.trim()
    alvo.esperandoLegendaAte = 0
    alvo.prefixo = prefixoDe(alvo)
    clearTimeout(timersLegenda.get(alvo.id))
    timersLegenda.delete(alvo.id)
    pendentes.atualizar(alvo)
    await concluir(alvo)
    return null
  }

  // ── Um comprovante ──────────────────────────────────────────────────────
  if (pendentes.doRemetente(dono).length >= MAX_ESPERANDO) {
    console.warn(`[gastos] grupo de leitura: já há ${MAX_ESPERANDO} comprovantes esperando resposta — este não entrou. Responda os pendentes.`)
    return null
  }

  const empresa = empresaPagaPorPadrao()
  const p = pendentes.guardar({
    // O endereço guardado é o do DESTINO: é para lá que vai tudo que se
    // disser sobre este comprovante, hoje ou depois de um reinício.
    chat: destino,
    de: dono,
    arquivo, nomeArquivo, tipo,
    enviadoPor: telefoneDeQuemMandou(msg),
    descricao: texto?.trim() || null,
    respostas: [],
    idMensagem,
    enviadoEm: msg.enviadoEm ?? Date.now(),
    criadoEm: Date.now(),
    // De onde veio de verdade, e de quem.
    leitura: { chat, grupo: chatNome ?? null, de, nome: String(msg.nomeRemetente ?? '').replace(/[\r\n]/g, ' ').trim() || discreto(de) },
    empresaPagou: empresa,
    // "Pago por Fulano" na legenda ganha de "a empresa pagou".
    legendaGanhaPagador: true,
    pagadorPerguntado: empresa,
  })
  p.prefixo = prefixoDe(p)
  p.enviar = (t) => enviar(destino, t)
  pendentes.atualizar(p)

  if (!p.descricao) {
    // Sem legenda: espera um pouco, porque a descrição costuma vir na
    // mensagem seguinte.
    p.esperandoLegendaAte = Date.now() + ESPERA_LEGENDA_MS
    pendentes.atualizar(p)
    const t = setTimeout(() => {
      timersLegenda.delete(p.id)
      const atual = pendentes.porId(p.id)
      if (!atual || !atual.esperandoLegendaAte || atual.perguntadoEm) return
      atual.esperandoLegendaAte = 0
      concluir(atual).catch(e => console.error('[gastos] grupo de leitura:', e.message))
    }, ESPERA_LEGENDA_MS)
    t.unref?.()
    timersLegenda.set(p.id, t)
    return null
  }

  await concluir(p)
  return null
}

/**
 * Esta conversa tem pergunta do robô esperando resposta?
 *
 * Serve para o privado: mensagem de texto no privado normalmente não é
 * assunto do módulo de comprovantes, mas passa a ser quando o robô perguntou
 * algo ali.
 */
export function esperaRespostaEm(chat) {
  return pendentes.doRemetente(deDoAtraso(chat)).some(p => p.perguntadoEm)
}

/** Só para teste: troca por onde se fala. */
export function _usarEnvio(fn) {
  enviar = fn ?? enviarMensagem
  avisouSemDestino = false
}
