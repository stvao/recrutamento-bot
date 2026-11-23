/**
 * Comprovantes — o ATRASO: o grupo antigo, lido de uma vez.
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 *
 * O problema: os comprovantes caíam num grupo de WhatsApp, e uma parte foi
 * lançada à mão e outra não. Ninguém sabe mais qual é qual. Lançar tudo de
 * novo duplicaria o que já entrou; conferir um por um é o trabalho que o
 * robô existe para tirar.
 *
 * A entrada é a conversa EXPORTADA pelo dono (zip com o texto e as fotos).
 * Cada comprovante de `desde` para cá passa pela MESMA decisão do dia a dia
 * (`processar`), com três diferenças:
 *
 *  - a "data do envio" é a da mensagem original, não a de hoje;
 *  - nasce como pago pela empresa — e por isso ninguém pergunta "quem
 *    pagou?". Se a legenda diz quem pagou, a legenda ganha;
 *  - a régua de repetido é a do atraso (`classificar`, em duplicata.js).
 *
 * ── As travas ────────────────────────────────────────────────────────────
 *
 * DESLIGADO por padrão (`GASTOS_ATRASO=off`). Em `ensaio` não lança, não
 * manda para a caixa e não escreve em conversa nenhuma: só produz o
 * relatório do que FARIA, para o dono ler antes de ligar. Em `on`, executa.
 *
 * Nada é dito ao grupo antigo, em nenhuma hipótese — este código nem sabe o
 * endereço dele. Tudo que se fala sai para UM lugar: o grupo de conversa
 * (`GASTOS_ATRASO_GRUPO`, ou o grupo de onde os comprovantes do dia a dia já
 * vêm), que tem de passar pela mesma checagem de origem de `autorizacao.js`.
 *
 * As perguntas saem em LOTES de 5, e o lote seguinte só depois de o
 * anterior estar resolvido. Cem perguntas de uma vez é uma parede que
 * ninguém lê; cinco é uma conversa.
 *
 * RETOMÁVEL: o que foi feito com cada arquivo fica em disco, pela impressão
 * digital dele. Mandar o mesmo zip de novo — ou reiniciar o robô no meio —
 * não lança duas vezes nem pergunta duas vezes.
 */
import {
  createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync,
} from 'node:fs'
import { join, basename } from 'node:path'
import { abrirZip, nomeBase } from './zip.js'
import { comprovantesDaConversa, tipoReal } from './exportacao.js'
import { processar, processarUmaVez } from './processar.js'
import { dataDoGasto, diaDoEnvio } from './saida.js'
import { gastosAtivo, origemAceita } from './autorizacao.js'
import { obrasConfigurado } from './obras-client.js'
import { visaoDisponivel } from './ia-visao.js'
import { enviarMensagem } from '../connectors.js'
import { moeda } from './formato.js'
import * as pendentes from './pendentes.js'
import * as memoria from './memoria.js'

const PASTA = process.env.GASTOS_ATRASO_DIR || join(process.cwd(), 'dados', 'atraso')

/** De quando para cá. É a data em que o dono parou de lançar tudo. */
const DESDE_PADRAO = process.env.GASTOS_ATRASO_DESDE || '2026-09-22'

/** Quantas perguntas no ar de cada vez. */
const LOTE = Number(process.env.GASTOS_ATRASO_LOTE || 5)

/**
 * Quanto esperar entre um comprovante e o seguinte.
 *
 * São centenas de arquivos, e os dois lados têm teto: o sistema de obras
 * aceita 30 envios por minuto, e a leitura da imagem tem cota. Devagar é
 * aceitável — ninguém está esperando do outro lado —; bater no teto e
 * transformar metade do zip em "não consegui ler" não é.
 */
const PAUSA_MS = Number(process.env.GASTOS_ATRASO_PAUSA_MS || 4000)

/** De quanto em quanto tempo olhar se o lote de perguntas já foi respondido. */
const TIQUE_MS = Number(process.env.GASTOS_ATRASO_TIQUE_MS || 15000)

/** Tamanho máximo do zip recebido por HTTP. */
const MAX_ZIP = Number(process.env.GASTOS_ATRASO_MAX_MB || 2048) * 1024 * 1024

/** O mesmo limite de arquivo do resto do módulo. */
const MAX_ARQUIVO = 20 * 1024 * 1024

/** Quantas vezes insistir num comprovante que deu erro antes de desistir dele. */
const MAX_TENTATIVAS = 3

/** Estados em que não há mais nada a fazer com o arquivo. */
const TERMINAIS = new Set(['lancado', 'ja-lancado', 'caixa', 'resolvido', 'falhou'])

const EXTENSAO = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' }

/** Lido a cada chamada, e não no import: é o que deixa o dono trocar de ensaio para on sem surpresa de cache. */
export function modoDoAtraso() {
  const m = String(process.env.GASTOS_ATRASO ?? 'off').trim().toLowerCase()
  return m === 'ensaio' || m === 'on' ? m : 'off'
}

/** Onde as perguntas e o resumo saem. Nunca é o grupo antigo. */
function grupoDeConversa() {
  return (process.env.GASTOS_ATRASO_GRUPO || '').trim() || memoria.grupoLembrado() || null
}

/** "Pago por Fulano" na legenda ganha de "a empresa pagou"? Sim, a não ser que se desligue. */
const legendaGanhaPagador = () => String(process.env.GASTOS_ATRASO_PAGADOR ?? 'legenda').toLowerCase() !== 'empresa'

/**
 * De quem são os comprovantes do atraso, para a máquina de pendentes.
 *
 * Ela guarda cada comprovante no nome de quem o mandou, e é por esse nome
 * que acha a quem pertence uma resposta. Os do atraso não foram mandados por
 * ninguém da conversa — então ficam num nome próprio, por grupo, e qualquer
 * pessoa autorizada daquele grupo pode responder por eles.
 */
export function deDoAtraso(chat) {
  return `atraso:${chat ?? 'ensaio'}`
}

/**
 * Esta mensagem de texto responde a um comprovante do atraso?
 *
 * Devolve o nome sob o qual procurar o comprovante: o do atraso, quando a
 * pessoa CITOU uma pergunta dele, ou quando ela não tem nada próprio
 * esperando e o atraso tem. Senão, o dela mesma — o dia a dia não muda.
 */
export function remetenteDaResposta({ de, chat, respondendoA }) {
  const doAtraso = deDoAtraso(chat)
  if (!pendentes.doRemetente(doAtraso).length) return de
  if (respondendoA && pendentes.porCitacao(doAtraso, respondendoA)) return doAtraso
  if (!pendentes.doRemetente(de).length) return doAtraso
  return de
}

// ─── Estado em disco ───────────────────────────────────────────────────────

const ARQUIVO_ESTADO = join(PASTA, 'estado.json')
const ARQUIVO_RELATORIO = join(PASTA, 'relatorio.csv')
const ARQUIVO_RESUMO = join(PASTA, 'resumo.txt')

/**
 * { trabalho, itens, leituras, hashes }
 *
 *  - `itens`: por impressão digital, o que foi feito com cada arquivo. É a
 *    retomada.
 *  - `leituras`: o que a IA leu de cada arquivo. O ensaio lê, e a execução
 *    aproveita — ler duas vezes gastaria a cota em dobro para o mesmo
 *    resultado.
 *  - `hashes`: nome no zip → impressão digital, para não reabrir cada foto
 *    só para descobrir que ela já foi tratada.
 */
let estado = null
let rodando = null
let parar = false
let enviar = enviarMensagem

function lerEstado() {
  if (estado) return estado
  estado = { trabalho: null, itens: {}, leituras: {}, hashes: {} }
  try {
    if (existsSync(ARQUIVO_ESTADO)) {
      const lido = JSON.parse(readFileSync(ARQUIVO_ESTADO, 'utf8'))
      estado = { trabalho: lido.trabalho ?? null, itens: lido.itens ?? {}, leituras: lido.leituras ?? {}, hashes: lido.hashes ?? {} }
    }
  } catch (e) {
    console.error('[atraso] não consegui ler o estado, começando do zero:', e.message)
  }
  return estado
}

function gravar(caminho, conteudo) {
  mkdirSync(PASTA, { recursive: true })
  const temp = `${caminho}.tmp`
  writeFileSync(temp, conteudo, 'utf8')
  renameSync(temp, caminho)
}

function salvarEstado() {
  try {
    gravar(ARQUIVO_ESTADO, JSON.stringify(estado))
  } catch (e) {
    console.error('[atraso] falha ao gravar o estado:', e.message)
  }
}

// ─── Leitura do zip ────────────────────────────────────────────────────────

/**
 * Abre o zip e devolve os comprovantes a tratar.
 *
 * O nome que a conversa cita é procurado entre as entradas pelo ÚLTIMO
 * pedaço do nome, e só. Um zip montado por alguém mal-intencionado pode
 * trazer "../../etc/passwd" como nome: aqui isso é só um texto que não bate
 * com nada.
 */
function lerZip(caminho, desde) {
  const zip = abrirZip(caminho)
  try {
    const texto = zip.entradas.find(e => /\.txt$/i.test(e.base))
    if (!texto) throw new Error('o zip não tem o arquivo de texto da conversa')

    const conversa = zip.ler(texto, 64 * 1024 * 1024).toString('utf8')
    const { comprovantes, ignorados } = comprovantesDaConversa(conversa, { desde })

    const porNome = new Map()
    for (const e of zip.entradas) if (!porNome.has(e.base)) porNome.set(e.base, e)

    const comArquivo = []
    ignorados.semArquivoNoZip = 0
    for (const c of comprovantes) {
      const entrada = porNome.get(nomeBase(c.arquivo))
      if (!entrada) { ignorados.semArquivoNoZip++; continue }
      comArquivo.push({ ...c, entrada })
    }
    return { zip, comprovantes: comArquivo, ignorados }
  } catch (e) {
    zip.fechar()
    throw e
  }
}

/** Lê um arquivo do zip: bytes, tipo real e impressão digital. Devolve null (com o motivo) se não serve. */
function abrirComprovante(zip, c) {
  let arquivo
  try {
    arquivo = zip.ler(c.entrada, MAX_ARQUIVO)
  } catch (e) {
    return { motivo: e.message === 'grande-demais' ? 'grandeDemais' : 'ilegivel' }
  }
  const tipo = tipoReal(arquivo)
  if (!tipo) return { motivo: 'tipoNaoAceito' }
  return { arquivo, tipo, hash: pendentes.impressaoDigital(arquivo) }
}

// ─── Um comprovante ────────────────────────────────────────────────────────

const hora = (ms) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date(ms))
const diaCurto = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/**
 * A ficha de um comprovante do atraso, no formato da máquina de pendentes.
 *
 * `prefixo` é o que abre toda mensagem sobre ele: de que dia é, quem mandou
 * e o que escreveu. No dia a dia a pergunta responde a uma foto que está
 * logo acima; aqui a foto está em outro grupo, de semanas atrás.
 */
function fichaDe(c, { arquivo, tipo, hash }, trabalho) {
  const chat = trabalho.grupo ?? null
  const legenda = (c.legenda ?? '').trim()
  return {
    chat,
    de: deDoAtraso(chat),
    arquivo,
    // O nome vem daqui, não do zip: nome de arquivo de fora não vira nome de
    // arquivo nosso.
    nomeArquivo: `comprovante-${hash.slice(0, 10)}.${EXTENSAO[tipo]}`,
    tipo,
    descricao: legenda || null,
    respostas: [],
    // Estável, e é ele que vira o Idempotency-Key: o mesmo arquivo, tratado
    // de novo, é o mesmo lançamento para o sistema.
    idMensagem: `atraso-${hash.slice(0, 32)}`,
    enviadoEm: c.quando,
    criadoEm: Date.now(),
    arquivoHash: hash,
    atraso: { remetente: c.remetente, dia: c.dia, desde: trabalho.desdeConsulta },
    prefixo: `📎 Do grupo antigo — ${diaCurto(c.dia)} às ${hora(c.quando)}, de ${c.remetente}\n${legenda ? `"${legenda.slice(0, 200)}"` : '(sem legenda)'}`,
    empresaPagou: true,
    legendaGanhaPagador: legendaGanhaPagador(),
    // Já é caixa da empresa: "quem pagou?" não se pergunta aqui.
    pagadorPerguntado: true,
  }
}

/** O que se decidiria, SEM escrever nada. `simulados` = o que os anteriores do mesmo ensaio lançariam. */
async function avaliar(c, aberto, trabalho, simulados = []) {
  const e = lerEstado()
  const falso = { ...fichaDe(c, aberto, trabalho), id: `ensaio-${aberto.hash.slice(0, 16)}`, simulados }
  const guardada = e.leituras[aberto.hash]
  if (guardada !== undefined) falso.lido = guardada

  const r = await processar(falso, { ensaio: true })

  // Só leitura que DEU CERTO fica guardada: null é "a IA não respondeu
  // agora", e guardar isso seria nunca mais tentar.
  const leuAgora = guardada === undefined && falso.lido !== undefined && visaoDisponivel()
  if (falso.lido) e.leituras[aberto.hash] = falso.lido
  return { r, falso, leuAgora }
}

const pausa = (ms = PAUSA_MS) => new Promise((ok) => { const t = setTimeout(ok, ms); t.unref?.() })

// ─── O ensaio ──────────────────────────────────────────────────────────────

/** De onde veio o valor, em palavras de quem lê o relatório. */
function origemDoValor(d) {
  if (d?.valor == null) return ''
  if (d.valorDigitado) return 'digitado'
  if (d.valorDaImagem) return `lido da imagem (confiança ${d.confiancaLeitura ?? 'baixa'})`
  return 'palpite entre os números da legenda'
}

/** Com qual lançamento bateu, numa linha. */
function descreverItem(item) {
  if (!item) return ''
  const de = item.fonte === 'sistema' ? 'no sistema' : 'lançado pelo robô'
  const dia = item.data ? String(item.data).slice(0, 10) : (item.quando ? diaDoEnvio(item.quando) : '')
  return [de, item.obra, item.descricao ?? item.fornecedor, moeda(Number(item.valor)), dia && diaCurto(dia), item.documento && `doc ${item.documento}`]
    .filter(Boolean).join(' · ')
}

function linhaDoRelatorio(c, r, falso) {
  const d = falso?.dados ?? {}
  let destino
  let detalhe = ''

  if (r.desfecho === 'lancaria') destino = 'lançaria'
  else if (r.desfecho === 'mesmo-arquivo') { destino = 'já lançado'; detalhe = `mesmo arquivo — ${descreverItem(r.item)}` }
  else if (r.desfecho === 'ja-lancado') { destino = 'já lançado'; detalhe = `mesmo documento e valor — ${descreverItem(r.item)}` }
  else if (r.pergunta === 'provável repetido') { destino = 'provável repetido'; detalhe = descreverItem(r.item) }
  else if (r.pergunta === 'dúvida de repetido') { destino = 'perguntaria'; detalhe = `dúvida de repetido — ${descreverItem(r.item)}` }
  else { destino = 'perguntaria'; detalhe = `falta: ${r.pergunta ?? 'informação'}` }

  if (falso && !falso.lido && visaoDisponivel()) detalhe += `${detalhe ? ' | ' : ''}a IA não leu a imagem`

  return {
    data: c.dia,
    hora: hora(c.quando),
    remetente: c.remetente,
    arquivo: nomeBase(c.arquivo),
    legenda: c.legenda ?? '',
    obra: d.obra ?? '',
    valor: d.valor != null ? d.valor.toFixed(2).replace('.', ',') : '',
    origemDoValor: origemDoValor(d),
    dataUsada: falso?.dados ? dataDoGasto(falso, d) : '',
    destino,
    detalhe,
  }
}

const COLUNAS = [
  ['data', 'Data'], ['hora', 'Hora'], ['remetente', 'Remetente'], ['arquivo', 'Arquivo'], ['legenda', 'Legenda'],
  ['obra', 'Obra'], ['valor', 'Valor'], ['origemDoValor', 'De onde veio o valor'], ['dataUsada', 'Data que seria usada'],
  ['destino', 'Destino'], ['detalhe', 'Detalhe'],
]

/** CSV com ponto e vírgula e BOM: é o que o Excel em português abre certo com dois cliques. */
function montarCsv(linhas) {
  const celula = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`
  const corpo = [COLUNAS.map(([, titulo]) => celula(titulo)).join(';')]
  for (const l of linhas) corpo.push(COLUNAS.map(([chave]) => celula(l[chave])).join(';'))
  return `\ufeff${corpo.join('\r\n')}\r\n`
}

function textoDosIgnorados(ig) {
  const partes = [
    ig.antesDoCorte && `${ig.antesDoCorte} de antes do corte`,
    ig.figurinha && `${ig.figurinha} figurinha(s)`,
    ig.audio && `${ig.audio} áudio(s)`,
    ig.video && `${ig.video} vídeo(s)`,
    ig.outro && `${ig.outro} de outro tipo`,
    ig.midiaOmitida && `${ig.midiaOmitida} com mídia omitida`,
    ig.semArquivoNoZip && `${ig.semArquivoNoZip} citado(s) na conversa sem o arquivo no zip`,
    ig.tipoNaoAceito && `${ig.tipoNaoAceito} que não é imagem nem PDF de verdade`,
    ig.grandeDemais && `${ig.grandeDemais} acima de 20 MB`,
    ig.ilegivel && `${ig.ilegivel} ilegível(is) no zip`,
    ig.repetidoNoZip && `${ig.repetidoNoZip} arquivo(s) repetido(s) dentro do próprio zip`,
  ].filter(Boolean)
  return partes.length ? `Ficaram de fora: ${partes.join(', ')}.` : ''
}

async function ensaiar({ zip, comprovantes, ignorados }, trabalho) {
  const linhas = []
  const simulados = []
  const vistos = new Set()

  for (const c of comprovantes) {
    if (parar) break
    const aberto = abrirComprovante(zip, c)
    if (aberto.motivo) { ignorados[aberto.motivo] = (ignorados[aberto.motivo] ?? 0) + 1; continue }
    if (vistos.has(aberto.hash)) { ignorados.repetidoNoZip = (ignorados.repetidoNoZip ?? 0) + 1; continue }
    vistos.add(aberto.hash)

    try {
      const { r, falso, leuAgora } = await avaliar(c, aberto, trabalho, simulados)
      linhas.push(linhaDoRelatorio(c, r, falso))

      if (r.desfecho === 'lancaria') {
        const d = falso.dados
        simulados.push({
          obra: d.obra, valor: d.valor, descricao: d.descricao, documento: d.documento, arquivoHash: aberto.hash,
          data: dataDoGasto(falso, d), idMensagem: falso.idMensagem, resultado: 'lancado', quando: Date.now(),
        })
      }
      trabalho.feitos = linhas.length
      salvarEstado()
      if (leuAgora) await pausa()
    } catch (e) {
      console.error('[atraso] ensaio: erro num comprovante:', e.message)
      linhas.push({ ...linhaDoRelatorio(c, { pergunta: 'erro ao avaliar' }, null), destino: 'erro', detalhe: e.message })
    }
  }

  const conta = (destino) => linhas.filter(l => l.destino === destino)
  const somaLancaria = conta('lançaria').reduce((s, l) => s + Number(l.valor.replace(',', '.')), 0)
  const resumo = [
    `ENSAIO do grupo antigo — de ${diaCurto(trabalho.desde)} para cá. Nada foi lançado nem perguntado.`,
    '',
    `${linhas.length} comprovante(s) avaliados:`,
    `  ${conta('lançaria').length} seriam lançados (${moeda(somaLancaria)})`,
    `  ${conta('já lançado').length} já estão lançados`,
    `  ${conta('provável repetido').length} parecem repetidos (seriam perguntados)`,
    `  ${conta('perguntaria').length} seriam perguntados (falta obra ou valor, valor inseguro, ou dúvida)`,
    conta('erro').length ? `  ${conta('erro').length} deram erro ao avaliar` : null,
    '',
    textoDosIgnorados(ignorados),
    '',
    'O detalhe de cada um está no relatório (relatorio.csv).',
    'Para executar: GASTOS_ATRASO=on, reiniciar o robô, e mandar o mesmo zip de novo.',
  ].filter(l => l !== null).join('\n')

  gravar(ARQUIVO_RELATORIO, montarCsv(linhas))
  gravar(ARQUIVO_RESUMO, resumo)
  trabalho.terminadoEm = Date.now()
  trabalho.resumo = resumo
  salvarEstado()
  console.log(`[atraso] ensaio pronto: ${linhas.length} comprovante(s). Relatório em ${ARQUIVO_RELATORIO}`)
}

// ─── A execução ────────────────────────────────────────────────────────────

const abertos = () => Object.values(lerEstado().itens).filter(i => i.estado === 'perguntando').length

/**
 * Confere o que aconteceu com as perguntas que estavam no ar.
 *
 * A resposta chega pela conversa e é tratada pelo caminho de sempre, que não
 * sabe do atraso. Então é aqui que se descobre: o comprovante saiu da
 * espera? O que a memória diz que foi feito com ele?
 */
function reconciliar() {
  const e = lerEstado()
  let mudou = false
  for (const item of Object.values(e.itens)) {
    if (item.estado !== 'perguntando') continue
    if (pendentes.porId(item.idPendente)) continue

    const fim = memoria.resultadoDe(item.idMensagem)
    if (fim?.resultado === 'lancado') { item.estado = 'lancado'; item.valor = fim.valor }
    else if (fim?.resultado === 'caixa') item.estado = 'caixa'
    // Saiu sem lançar: a pessoa disse que era o mesmo, ou o sistema
    // respondeu que já tinha.
    else item.estado = 'resolvido'
    mudou = true
  }
  if (e.trabalho?.loteFechado && abertos() === 0) { e.trabalho.loteFechado = false; mudou = true }
  if (mudou) salvarEstado()
}

/** Cabe mais uma pergunta agora? O lote enche em LOTE e só reabre quando esvazia de todo. */
function cabeNoLote(trabalho) {
  return !trabalho.loteFechado && abertos() < LOTE
}

async function tratarUm(c, aberto, trabalho) {
  const e = lerEstado()
  const reg = e.itens[aberto.hash] ?? { tentativas: 0 }
  e.itens[aberto.hash] = reg
  Object.assign(reg, { arquivo: nomeBase(c.arquivo), dia: c.dia, remetente: c.remetente })

  // Primeiro, sem escrever nada: vai precisar de pergunta?
  const { r, falso, leuAgora } = await avaliar(c, aberto, trabalho)

  if (r.desfecho === 'pergunta' && !cabeNoLote(trabalho)) {
    reg.estado = 'adiado'
    reg.pergunta = r.pergunta
    salvarEstado()
    return { escreveu: false, leuAgora }
  }

  // Agora de verdade, pela máquina de sempre.
  const ficha = fichaDe(c, aberto, trabalho)
  if (falso.lido) ficha.lido = falso.lido
  const p = pendentes.guardar(ficha)
  p.enviar = (texto) => enviar(trabalho.grupo, texto)

  reg.idPendente = p.id
  reg.idMensagem = p.idMensagem
  reg.estado = 'perguntando'      // até prova em contrário; se cair aqui, a retomada confere
  salvarEstado()

  await processarUmaVez(p)

  if (pendentes.porId(p.id)) {
    // Ficou esperando: uma pergunta foi feita (ou a caixa recusou e a ronda
    // vai tentar de novo).
    reg.estado = 'perguntando'
    reg.pergunta = r.pergunta ?? null
    if (abertos() >= LOTE) trabalho.loteFechado = true
  } else if (p.desfecho === 'lancado') {
    reg.estado = 'lancado'
    reg.valor = p.dados?.valor ?? null
  } else if (p.desfecho === 'caixa') {
    reg.estado = 'caixa'
  } else {
    // mesmo arquivo, mesmo documento, ou o sistema respondeu "reenvio".
    reg.estado = 'ja-lancado'
  }
  salvarEstado()
  return { escreveu: true, leuAgora }
}

function contagem() {
  const itens = Object.values(lerEstado().itens)
  const conta = (...estados) => itens.filter(i => estados.includes(i.estado))
  return {
    lancados: conta('lancado').length,
    totalLancado: conta('lancado').reduce((s, i) => s + (Number(i.valor) || 0), 0),
    jaLancados: conta('ja-lancado', 'resolvido').length,
    esperando: conta('perguntando', 'adiado').length,
    perguntando: conta('perguntando').length,
    naCaixa: conta('caixa').length,
    comErro: conta('erro', 'falhou').length,
  }
}

function textoDoResumo(trabalho) {
  const n = contagem()
  return [
    `📋 Grupo antigo, de ${diaCurto(trabalho.desde)} para cá — terminei de passar pelos comprovantes.`,
    `✅ ${n.lancados} lançado(s) (${moeda(n.totalLancado)}), aguardando aprovação`,
    `ℹ️ ${n.jaLancados} já estavam no sistema`,
    `❓ ${n.esperando} esperando resposta${n.esperando ? ` — pergunto aqui, de ${LOTE} em ${LOTE}` : ''}`,
    `📥 ${n.naCaixa} na caixa de comprovantes`,
    n.comErro ? `⚠ ${n.comErro} não consegui tratar` : null,
    textoDosIgnorados(trabalho.ignorados ?? {}) || null,
  ].filter(Boolean).join('\n')
}

async function executar({ zip, comprovantes, ignorados }, trabalho) {
  const e = lerEstado()

  for (;;) {
    reconciliar()
    // Os arquivos já encontrados NESTA passada: o mesmo arquivo duas vezes
    // no zip (encaminhado de novo no grupo) é tratado uma vez só.
    const vistos = new Set()

    for (const c of comprovantes) {
      if (parar) return

      // Já se sabe a impressão deste arquivo e ele está resolvido (ou com
      // pergunta no ar)? Então nem abre.
      const conhecido = e.hashes[c.entrada.nome]
      if (conhecido?.startsWith('fora:')) continue
      const regAntes = conhecido ? e.itens[conhecido] : null
      if (regAntes && (TERMINAIS.has(regAntes.estado) || regAntes.estado === 'perguntando')) { vistos.add(conhecido); continue }
      if (regAntes?.estado === 'adiado' && !cabeNoLote(trabalho)) { vistos.add(conhecido); continue }

      const aberto = abrirComprovante(zip, c)
      if (aberto.motivo) {
        if (!conhecido) { ignorados[aberto.motivo] = (ignorados[aberto.motivo] ?? 0) + 1; e.hashes[c.entrada.nome] = `fora:${aberto.motivo}` }
        continue
      }
      e.hashes[c.entrada.nome] = aberto.hash

      if (vistos.has(aberto.hash)) {
        if (!conhecido) ignorados.repetidoNoZip = (ignorados.repetidoNoZip ?? 0) + 1
        continue
      }
      vistos.add(aberto.hash)

      const reg = e.itens[aberto.hash]
      if (reg && (TERMINAIS.has(reg.estado) || reg.estado === 'perguntando')) continue

      try {
        const { escreveu, leuAgora } = await tratarUm(c, aberto, trabalho)
        if (escreveu || leuAgora) await pausa()
      } catch (erro) {
        const r = e.itens[aberto.hash] ?? (e.itens[aberto.hash] = { tentativas: 0 })
        r.tentativas = (r.tentativas ?? 0) + 1
        r.estado = r.tentativas >= MAX_TENTATIVAS ? 'falhou' : 'erro'
        r.erro = erro.message
        salvarEstado()
        console.error(`[atraso] erro num comprovante (tentativa ${r.tentativas}):`, erro.message)
      }
    }

    trabalho.ignorados = ignorados
    reconciliar()

    // UMA mensagem, quando todos os arquivos já passaram uma vez. As
    // perguntas que faltam continuam saindo em lotes, sem novo resumo.
    if (!trabalho.resumoEnviadoEm) {
      trabalho.resumoEnviadoEm = Date.now()
      trabalho.resumo = textoDoResumo(trabalho)
      salvarEstado()
      await enviar(trabalho.grupo, trabalho.resumo)
    }

    const n = contagem()
    const haErro = Object.values(e.itens).some(i => i.estado === 'erro')
    if (!n.esperando && !haErro) break

    // Há pergunta no ar ou na fila: espera, e olha de novo.
    await pausa(TIQUE_MS)
    if (parar) return
  }

  trabalho.terminadoEm = Date.now()
  salvarEstado()
  console.log('[atraso] terminado:', JSON.stringify(contagem()))
}

// ─── Disparar, retomar, acompanhar ─────────────────────────────────────────

function hojeMenos(dias) {
  return diaDoEnvio(Date.now() - dias * 24 * 60 * 60 * 1000)
}

function rodar(trabalho) {
  const e = lerEstado()
  e.trabalho = trabalho
  parar = false
  rodando = (async () => {
    let lido = null
    try {
      lido = lerZip(trabalho.zip, trabalho.desde)
      trabalho.total = lido.comprovantes.length
      trabalho.ignorados = lido.ignorados
      salvarEstado()
      if (trabalho.modo === 'ensaio') await ensaiar(lido, trabalho)
      else await executar(lido, trabalho)
    } catch (erro) {
      trabalho.erro = erro.message
      salvarEstado()
      console.error('[atraso] parou com erro:', erro.message)
    } finally {
      lido?.zip.fechar()
      rodando = null
    }
  })()
  return rodando
}

/**
 * Começa (ou recomeça) a leitura de um zip.
 *
 * Devolve na hora; o trabalho segue em segundo plano. `{ ok, modo, ... }` ou
 * `{ ok: false, status, motivo }` dizendo por que não começou.
 */
export async function iniciarAtraso({ zip, desde } = {}) {
  const modo = modoDoAtraso()
  if (modo === 'off') return { ok: false, status: 409, motivo: 'A leitura do grupo antigo está desligada (GASTOS_ATRASO=off).' }
  if (rodando) return { ok: false, status: 409, motivo: 'Já há uma leitura em andamento.' }
  if (!obrasConfigurado()) return { ok: false, status: 409, motivo: 'Sem acesso ao sistema de obras (OBRAS_API_TOKEN).' }

  const corte = desde ?? DESDE_PADRAO
  if (!/^\d{4}-\d{2}-\d{2}$/.test(corte)) return { ok: false, status: 422, motivo: 'A data de corte tem de ser AAAA-MM-DD.' }
  if (!zip || !existsSync(zip)) return { ok: false, status: 422, motivo: 'Não achei o zip.' }

  let grupo = null
  if (modo === 'on') {
    // As mesmas regras do dia a dia valem para onde o robô vai falar: tem de
    // ser uma origem que `autorizacao.js` aceita, e o módulo tem de estar no
    // ar.
    grupo = grupoDeConversa()
    if (!gastosAtivo()) return { ok: false, status: 409, motivo: 'O módulo de gastos não está ativo.' }
    if (!grupo) return { ok: false, status: 409, motivo: 'Não sei em qual grupo perguntar. Defina GASTOS_ATRASO_GRUPO.' }
    if (!origemAceita(grupo)) return { ok: false, status: 409, motivo: 'O grupo de conversa não está em GASTOS_GRUPOS.' }
  }

  // Confere que abre ANTES de responder que começou.
  let contado
  try {
    const lido = lerZip(zip, corte)
    contado = { total: lido.comprovantes.length, ignorados: lido.ignorados }
    lido.zip.fechar()
  } catch (erro) {
    return { ok: false, status: 422, motivo: `Não consegui ler o zip: ${erro.message}` }
  }

  // O sistema devolve no máximo 120 dias; alguns dias antes do corte cobrem
  // o que foi lançado à mão com a data do papel.
  const cincoAntes = diaDoEnvio(Date.parse(`${corte}T12:00:00-03:00`) - 5 * 24 * 60 * 60 * 1000)
  const limite = hojeMenos(119)
  const trabalho = {
    zip, modo, grupo, desde: corte,
    desdeConsulta: cincoAntes > limite ? cincoAntes : limite,
    iniciadoEm: Date.now(), total: contado.total, ignorados: contado.ignorados,
  }
  // Zip novo: o que se sabia dos NOMES de arquivo não vale mais (dois zips
  // podem ter um "IMG-0001.jpg" cada). O que se sabe por impressão digital
  // continua valendo — é ela que impede lançar de novo.
  const e = lerEstado()
  if (e.trabalho?.zip !== zip) e.hashes = {}

  // Uma execução que ainda não terminou, e o zip chega de novo (o dono não
  // sabia se tinha ido, ou o robô reiniciou e ele mandou outra vez): é a
  // MESMA execução continuando. O resumo que já saiu não sai de novo, e o
  // lote de perguntas que está no ar continua fechado até ser respondido.
  const anterior = e.trabalho
  if (modo === 'on' && anterior?.modo === 'on' && !anterior.terminadoEm && anterior.desde === corte) {
    trabalho.iniciadoEm = anterior.iniciadoEm
    trabalho.resumoEnviadoEm = anterior.resumoEnviadoEm
    trabalho.resumo = anterior.resumo
    trabalho.loteFechado = anterior.loteFechado
  }
  rodar(trabalho)
  salvarEstado()
  return { ok: true, modo, desde: corte, comprovantes: contado.total, ignorados: contado.ignorados }
}

/**
 * No arranque: continua a execução que estava no meio.
 *
 * Só em `on`. Um ensaio interrompido não se retoma sozinho — ele não deixa
 * nada pela metade no sistema, e basta pedir de novo.
 */
export function retomarAtraso() {
  if (modoDoAtraso() !== 'on' || rodando) return false
  const t = lerEstado().trabalho
  if (!t || t.modo !== 'on' || t.terminadoEm || !existsSync(t.zip)) return false
  console.log('[atraso] retomando a leitura do grupo antigo de onde parou.')
  delete t.erro
  rodar(t)
  return true
}

/** Como está, para quem pergunta por HTTP. */
export function situacaoDoAtraso() {
  const t = lerEstado().trabalho
  return {
    modo: modoDoAtraso(),
    rodando: Boolean(rodando),
    trabalho: t ? {
      modo: t.modo, desde: t.desde, comprovantes: t.total, feitos: t.feitos,
      iniciadoEm: t.iniciadoEm, terminadoEm: t.terminadoEm ?? null, erro: t.erro ?? null,
      ignorados: t.ignorados ?? {},
    } : null,
    contagem: t?.modo === 'on' ? contagem() : null,
    resumo: t?.resumo ?? null,
    relatorio: t?.modo === 'ensaio' && t.terminadoEm && existsSync(ARQUIVO_RELATORIO) ? '/comprovantes/atraso/relatorio.csv' : null,
  }
}

// ─── HTTP ──────────────────────────────────────────────────────────────────

/**
 * Quem pode disparar.
 *
 * Isto cria lançamento no financeiro, então a porta é estreita: só de dentro
 * da própria máquina (e sem ter passado por um proxy — atrás de um, TODO
 * pedido parece vir de dentro), ou com um token próprio, que só existe se
 * alguém o definir.
 */
function podeDisparar(req) {
  const token = process.env.GASTOS_ATRASO_TOKEN || ''
  const cabecalho = req.headers.authorization ?? ''
  if (token && cabecalho.startsWith('Bearer ') && cabecalho.slice(7).trim() === token) return true

  const ip = req.socket?.remoteAddress ?? ''
  const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
  return local && !req.headers['x-forwarded-for']
}

/** Grava o corpo do pedido (o zip) na pasta do atraso, com teto de tamanho. */
function receberZip(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > MAX_ZIP) return reject(new Error('grande-demais'))
    mkdirSync(PASTA, { recursive: true })
    const destino = join(PASTA, `exportacao-${Date.now()}.zip`)
    const saida = createWriteStream(destino)
    let recebido = 0
    const falhar = (erro) => {
      saida.destroy()
      try { unlinkSync(destino) } catch { /* não chegou a existir */ }
      reject(erro)
    }
    req.on('data', (pedaco) => {
      recebido += pedaco.length
      if (recebido > MAX_ZIP) { req.destroy(); falhar(new Error('grande-demais')) }
    })
    req.on('error', falhar)
    saida.on('error', falhar)
    saida.on('finish', () => (recebido ? resolve(destino) : falhar(new Error('vazio'))))
    req.pipe(saida)
  })
}

/**
 * As rotas do atraso.
 *
 *   POST /comprovantes/atraso              corpo = o zip          → começa
 *   POST /comprovantes/atraso?arquivo=x.zip  zip já em dados/atraso → começa
 *   GET  /comprovantes/atraso              → como está, e o resumo
 *   GET  /comprovantes/atraso/relatorio.csv → o relatório do ensaio
 *
 * `?desde=AAAA-MM-DD` muda o corte. O modo (ensaio ou on) NÃO vem no pedido:
 * vem do .env, para que ligar de verdade seja um ato de quem cuida do
 * servidor, e não um parâmetro que alguém esquece numa URL.
 */
export function registrarRotasDoAtraso(app) {
  app.post('/comprovantes/atraso', async (req, res) => {
    if (!podeDisparar(req)) return res.sendStatus(404)
    try {
      let zip
      if (req.query.arquivo) {
        // Só o nome, e só dentro da pasta do atraso.
        zip = join(PASTA, basename(String(req.query.arquivo)))
      } else {
        if (modoDoAtraso() === 'off') return res.status(409).json({ ok: false, motivo: 'A leitura do grupo antigo está desligada (GASTOS_ATRASO=off).' })
        zip = await receberZip(req)
      }
      const r = await iniciarAtraso({ zip, desde: req.query.desde ? String(req.query.desde) : undefined })
      res.status(r.ok ? 202 : (r.status ?? 400)).json(r)
    } catch (erro) {
      const grande = erro.message === 'grande-demais'
      res.status(grande ? 413 : 400).json({ ok: false, motivo: grande ? 'O zip passou do tamanho máximo.' : 'Não recebi o zip.' })
    }
  })

  app.get('/comprovantes/atraso', (req, res) => {
    if (!podeDisparar(req)) return res.sendStatus(404)
    res.set('Cache-Control', 'no-store').json(situacaoDoAtraso())
  })

  app.get('/comprovantes/atraso/relatorio.csv', (req, res) => {
    if (!podeDisparar(req)) return res.sendStatus(404)
    if (!existsSync(ARQUIVO_RELATORIO)) return res.status(404).json({ ok: false, motivo: 'Ainda não há relatório.' })
    res.set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', 'attachment; filename="grupo-antigo-ensaio.csv"')
      .send(readFileSync(ARQUIVO_RELATORIO))
  })
}

// ─── Só para teste ─────────────────────────────────────────────────────────

/** Troca por onde o atraso fala. */
export function _usarEnvio(fn) {
  enviar = fn ?? enviarMensagem
}

/** Espera a leitura em andamento parar (terminar, ou chegar num ponto de espera e ser interrompida). */
export async function _parar() {
  parar = true
  await rodando
  parar = false
}

/** Espera terminar por conta própria. */
export function _aguardar() {
  return rodando ?? Promise.resolve()
}

/** Esquece o que está na memória — como um reinício do robô. O disco fica. */
export function _reiniciar() {
  estado = null
}

/** Uma passada de conferência das perguntas, sem esperar o relógio. */
export function _reconciliar() {
  reconciliar()
}
