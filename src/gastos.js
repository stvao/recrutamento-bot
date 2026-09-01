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
import { interpretar, combinar } from './lancamento.js'

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
 * Enquanto o endpoint aceitar só arquivo e texto livre, é ESTA linha que
 * aparece na caixa de aprovação, e é por ela que a pessoa confere sem abrir
 * a foto. Por isso ela é montada na ordem em que se lê um lançamento —
 * obra, o que foi, tipo, quanto — e não na ordem em que os dados chegaram.
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
  if (dados?.valor == null) {
    linhas.push('(sem valor — precisa digitar)')
  }

  return linhas.join('\n') || 'Comprovante enviado pelo WhatsApp.'
}

/** A resposta para quem mandou a foto. */
function montarResposta(dados, envio) {
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

  // Repete o que ENTENDEU, e não o que recebeu.
  //
  // É a única chance de você perceber, no momento em que ainda lembra do
  // gasto, que a obra saiu errada ou o valor veio torto. Descobrir isso na
  // hora de aprovar, dias depois, custa a mesma conferência que se estava
  // tentando evitar.
  const resumo = [
    dados?.obra,
    dados?.descricao,
    dados?.tipo ? dados.tipo.replace(/_/g, ' ').toLowerCase() : null,
    moeda(dados?.valor),
  ].filter(Boolean)
  if (resumo.length) linhas.push(resumo.join(' · '))

  const faltando = []
  if (!dados?.obra) faltando.push('a obra')
  if (!dados?.valor) faltando.push('o valor')
  if (!dados?.tipo) faltando.push('o tipo')
  if (faltando.length) {
    linhas.push(`Faltou ${faltando.join(' e ')} — dá para completar na hora de aprovar.`)
  } else if (dados?.valor != null && !dados.valorDigitado) {
    linhas.push('⚠ Esse valor eu li da imagem. Confere na hora de aprovar.')
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

  const pendente = { de, arquivo, nomeArquivo, tipo, descricao: texto || null, idMensagem, enviadoEm: msg.enviadoEm ?? Date.now() }

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

/** Interpreta, lê, envia e monta a resposta. */
async function enviar(pendente) {
  const { arquivo, nomeArquivo, tipo, descricao, idMensagem, enviadoEm } = pendente

  // O que a pessoa escreveu vem primeiro, e é o que vale.
  const escrito = interpretar(descricao)

  // A imagem é lida para preencher o que faltou e para conferência — nunca
  // para corrigir quem digitou. Se a leitura falhar, o comprovante vai assim
  // mesmo: a foto no lugar certo, com a linha que a pessoa escreveu, já
  // resolve a maior parte. A leitura é o bônus, não o requisito.
  const lido = await lerComprovante({ arquivo, tipo, descricao }).catch(() => null)
  const dados = combinar(escrito, lido)

  // A DATA do lançamento é a do envio, não a que a IA leu no papel.
  //
  // É o combinado, e é o que corresponde ao fluxo real: manda-se o
  // comprovante no dia em que se pagou. A data lida do papel vai junto como
  // `dataComprovante`, para quem aprova ver se as duas batem.
  const data = new Date(enviadoEm ?? Date.now()).toISOString().slice(0, 10)

  const envio = await enviarComprovante({
    arquivo,
    nomeArquivo,
    tipo,
    texto: montarTexto(dados, lido?.observacao),
    idMensagem,
    extras: {
      obra: dados.obra,
      descricao: dados.descricao,
      categoria: dados.tipo,
      valor: dados.valor,
      data,
      dataComprovante: dados.dataComprovante,
      estabelecimento: dados.estabelecimento,
      documento: dados.documento,
      formaPagamento: dados.formaPagamento,
      // "digitado" quer dizer que uma pessoa escreveu o valor. É a diferença
      // entre um número em que se pode confiar e um que precisa de conferência.
      confianca: dados.confianca,
    },
  })

  console.log(
    `[gastos] ${pendente.de} → ${envio.ok ? 'ok' : `falhou: ${envio.motivo}`}`
    + ` | obra=${dados.obra ?? '?'} tipo=${dados.tipo ?? '?'} valor=${moeda(dados.valor) ?? '?'}`
    + ` (${dados.valorDigitado ? 'digitado' : 'lido da imagem'})`,
  )
  return montarResposta(dados, envio)
}

/** Só para teste: esquece as fotos seguradas. */
export function _limparPendentes() {
  for (const { prazo } of aguardando.values()) clearTimeout(prazo)
  aguardando.clear()
}
