/**
 * Módulo de gastos — comprovante que chega por mensagem vira item na caixa
 * de aprovação do sistema de obras.
 *
 * O problema que ele resolve: os comprovantes já chegam todo dia num grupo,
 * com a descrição escrita do lado, e alguém precisa olhar cada um e digitar
 * no sistema de custos. São muitos por dia, e nem sempre há tempo.
 *
 * O que ele NÃO faz: lançar no custo. O comprovante vai para a caixa
 * "Comprovantes recebidos", já com o resumo do que a IA leu, e a pessoa toca
 * em "Lançar", confere e salva. Lançar direto trocaria "trabalho de digitar"
 * por "trabalho de auditar", que é pior.
 *
 * Este arquivo não sabe por onde a mensagem chegou. WhatsApp e Telegram
 * entregam a mesma coisa, e é isso que permite trocar de canal sem tocar
 * aqui.
 */
import { lerComprovante, visaoDisponivel } from './ia-visao.js'
import { enviarComprovante, obrasConfigurado } from './obras-client.js'

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
const AUTORIZADOS = new Set(
  (process.env.GASTOS_AUTORIZADOS || '')
    .split(',')
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
 * Quanto esperar por uma descrição que vem em mensagem separada.
 *
 * Muita gente manda a foto e escreve o "o que é" logo em seguida, em outra
 * mensagem. Enviar na hora perderia essa descrição — e é ela que diz de qual
 * obra é o gasto, que o comprovante não informa. Enviar só depois de esperar
 * atrasa a confirmação de quem já escreveu a legenda junto.
 *
 * Então: legenda junto da foto, envia na hora. Foto sem legenda, segura por
 * este tempo esperando o complemento.
 */
const ESPERA_DESCRICAO_MS = Number(process.env.GASTOS_ESPERA_DESCRICAO_MS || 60000)

/** telefone -> { pendente, prazo } — foto segurada esperando descrição. */
const aguardando = new Map()

export function gastosAtivo() {
  return AUTORIZADOS.size > 0 && obrasConfigurado()
}

/** Este remetente pode lançar gasto? */
export function autorizado(de) {
  return AUTORIZADOS.has((de || '').replace(/\D/g, ''))
}

/** A mensagem veio de onde os comprovantes devem vir? */
export function origemAceita(chat) {
  if (GRUPOS.size === 0) return true
  return GRUPOS.has(String(chat ?? ''))
}

/** Diagnóstico, para o /metricas. */
export function situacao() {
  return {
    ativo: gastosAtivo(),
    autorizados: AUTORIZADOS.size,
    grupos: GRUPOS.size ? [...GRUPOS] : 'qualquer origem',
    leituraPorIA: visaoDisponivel(),
    obras: obrasConfigurado(),
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
 * Enquanto o endpoint aceitar só arquivo e texto livre, é esta linha que
 * aparece na caixa e permite a pessoa conferir sem abrir a foto. Quando ele
 * passar a aceitar valor/data/categoria, ela continua útil como descrição.
 */
export function montarTexto(leitura, descricao) {
  const partes = []
  if (leitura?.estabelecimento) partes.push(leitura.estabelecimento)
  if (leitura?.valor) partes.push(moeda(leitura.valor))
  if (leitura?.data) partes.push(dataCurta(leitura.data))
  if (leitura?.formaPagamento) partes.push(leitura.formaPagamento)

  const linhas = []
  if (partes.length) linhas.push(partes.join(' · '))
  if (descricao?.trim()) linhas.push(descricao.trim())
  if (leitura?.observacao) linhas.push(`⚠ ${leitura.observacao}`)
  if (leitura && leitura.confianca !== 'alta') {
    linhas.push('(leitura automática incerta — confira o valor)')
  }
  return linhas.join('\n') || 'Comprovante enviado pelo WhatsApp.'
}

/** A resposta para quem mandou a foto. */
function montarResposta(leitura, envio) {
  if (!envio.ok) {
    if (envio.status === 401) return '❌ Meu acesso ao sistema de obras foi recusado (token inválido ou revogado). Avisa quem cuida do sistema.'
    if (envio.status === 429) return '⏳ Muitos envios de uma vez. Manda esse de novo daqui a um minuto, por favor.'
    if (envio.motivo === 'grande-demais') return '❌ O arquivo passou de 20 MB. Manda a foto em vez do PDF, ou tira outra foto.'
    if (envio.status === 400) return `❌ O sistema de obras não aceitou esse arquivo (${envio.motivo}).`
    return '❌ Não consegui falar com o sistema de obras agora. Manda de novo daqui a pouco — não vai duplicar.'
  }

  const linhas = []
  // A mensagem vem do próprio endpoint ("Comprovante recebido. Você tem 3
  // esperando lançamento") de propósito: quem sabe quantos estão pendentes é
  // o sistema de obras, não o robô.
  linhas.push(`✅ ${envio.mensagem || 'Comprovante recebido.'}`)

  if (leitura?.valor) {
    const detalhe = [leitura.estabelecimento, moeda(leitura.valor), dataCurta(leitura.data)]
      .filter(Boolean).join(' · ')
    linhas.push(detalhe)
    if (leitura.confianca !== 'alta') linhas.push('⚠ Não consegui ler com certeza — confere o valor na hora de lançar.')
  } else if (visaoDisponivel()) {
    linhas.push('Não consegui ler o valor nesse aqui — vai precisar digitar na hora de lançar.')
  }
  return linhas.join('\n')
}

/**
 * Trata uma mensagem que pode ser um comprovante.
 *
 * Devolve o texto da resposta, ou null quando não há nada a dizer — mensagem
 * de gente não autorizada, ou texto solto que não complementa foto nenhuma.
 * Ficar calado é o certo aqui: o robô é membro de um grupo de trabalho, e
 * robô que comenta tudo é insuportável.
 */
export async function tratar(msg) {
  const { de, chat, arquivo, nomeArquivo, tipo, texto, idMensagem } = msg

  if (!origemAceita(chat)) return null

  if (!autorizado(de)) {
    // Nem responde. Dizer "você não pode" a quem mandou foto num grupo
    // confirma que existe um robô ouvindo e convida a insistir.
    if (arquivo) console.warn(`[gastos] comprovante ignorado: ${de} não está em GASTOS_AUTORIZADOS`)
    return null
  }

  // Texto solto: pode ser a descrição da foto que acabou de chegar.
  if (!arquivo) return completarDescricao(de, texto)

  // Chegou arquivo — se havia outro esperando descrição, esse não vem mais.
  const anterior = aguardando.get(de)
  if (anterior) {
    clearTimeout(anterior.prazo)
    aguardando.delete(de)
    enviar(anterior.pendente).then(r => anterior.pendente.responder?.(r))
  }

  const pendente = { de, arquivo, nomeArquivo, tipo, descricao: texto || null, idMensagem }

  // Legenda junto da foto: não há o que esperar.
  if (texto?.trim()) return enviar(pendente)

  // Sem legenda: segura um pouco, porque a descrição costuma vir na
  // mensagem seguinte, e é ela que diz de qual obra é o gasto.
  return new Promise((resolve) => {
    pendente.responder = resolve
    const prazo = setTimeout(async () => {
      aguardando.delete(de)
      resolve(await enviar(pendente))
    }, ESPERA_DESCRICAO_MS)
    prazo.unref?.()
    aguardando.set(de, { pendente, prazo })
  })
}

/** Texto que chega logo depois de uma foto vira a descrição dela. */
function completarDescricao(de, texto) {
  const esperando = aguardando.get(de)
  if (!esperando || !texto?.trim()) return null

  clearTimeout(esperando.prazo)
  aguardando.delete(de)
  esperando.pendente.descricao = texto.trim()

  // Quem responde é a promessa que ficou aberta lá no tratar(), para a
  // confirmação sair como resposta à FOTO, e não a este texto.
  enviar(esperando.pendente).then(r => esperando.pendente.responder?.(r))
  return null
}

/** Lê, envia e monta a resposta. */
async function enviar(pendente) {
  const { arquivo, nomeArquivo, tipo, descricao, idMensagem } = pendente

  // Se a leitura falhar, o comprovante vai assim mesmo: a foto no lugar
  // certo, com a descrição de quem enviou, já economiza o trabalho de achar
  // a imagem depois. A leitura é o bônus, não o requisito.
  const leitura = await lerComprovante({ arquivo, tipo, descricao }).catch(() => null)

  const envio = await enviarComprovante({
    arquivo,
    nomeArquivo,
    tipo,
    texto: montarTexto(leitura, descricao),
    idMensagem,
    extras: leitura ? {
      valor: leitura.valor,
      data: leitura.data,
      categoria: leitura.categoria,
      estabelecimento: leitura.estabelecimento,
      documento: leitura.documento,
      formaPagamento: leitura.formaPagamento,
      confianca: leitura.confianca,
    } : null,
  })

  console.log(`[gastos] ${pendente.de} → ${envio.ok ? `ok (${moeda(leitura?.valor) ?? 'sem valor lido'})` : `falhou: ${envio.motivo}`}`)
  return montarResposta(leitura, envio)
}

/** Só para teste: esquece as fotos seguradas. */
export function _limparPendentes() {
  for (const { prazo } of aguardando.values()) clearTimeout(prazo)
  aguardando.clear()
}
