/**
 * Comprovantes — lê a conversa EXPORTADA do WhatsApp (o `.txt` que vem no
 * zip de "Exportar conversa → Incluir mídia").
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 *
 * Existe para o atraso: o grupo antigo onde os comprovantes caíam, e que
 * ninguém lançou inteiro. Lê-se a exportação, e não o histórico do WhatsApp,
 * porque o histórico só vem em lotes pequenos pedidos ao celular e mídia de
 * dois meses atrás costuma não baixar mais. O zip é completo, não depende de
 * o robô estar naquele grupo, e não põe o número em risco.
 *
 * Os dois formatos, em português:
 *
 *   Android   22/09/2026 14:03 - João: IMG-20260922-WA0001.jpg (arquivo anexado)
 *             cimento haia 250
 *   iPhone    [22/09/2026, 14:03:11] João: <anexado: 00000012-PHOTO-2026-09-22.jpg>
 *
 * A legenda vem na mesma mensagem. E, como no dia a dia, a mensagem de texto
 * que a mesma pessoa manda logo depois da foto vale como descrição dela.
 *
 * Aqui só se lê texto. Quem abre os arquivos e decide o que fazer com cada
 * um é `atraso.js`.
 */

/** Marcas invisíveis que o WhatsApp põe no texto exportado (direção de escrita, BOM). */
const INVISIVEIS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

const CABECA_ANDROID = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),? (\d{1,2}):(\d{2})(?::(\d{2}))? - (.*)$/
const CABECA_IPHONE = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?\] (.*)$/

const ANEXO_ANDROID = /^(.+\.[A-Za-z0-9]{2,5}) \((?:arquivo anexado|file attached)\)$/
const ANEXO_IPHONE = /<(?:anexado|attached): ([^>]+)>/

/** Mídia que não veio no zip (exportado sem mídia, ou apagada do celular). */
const OMITIDA = /<[^>]*(?:m[ií]dia|media)[^>]*(?:ocult|omit)[^>]*>|\b(?:imagem|foto|v[ií]deo|[aá]udio|figurinha|documento|gif|m[ií]dia) (?:ocultad[oa]|omitid[oa])\b/i

/** Quanto tempo depois da foto um texto do mesmo remetente ainda é a descrição dela. */
const JANELA_DESCRICAO_MS = 2 * 60 * 1000

const EXTENSOES = {
  comprovante: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'pdf'],
  audio: ['opus', 'ogg', 'mp3', 'm4a', 'aac', 'wav', 'amr'],
  video: ['mp4', 'mov', '3gp', 'mkv', 'avi', 'webm'],
}

/** O que é este anexo, pelo nome: comprovante, figurinha, áudio, vídeo ou outro. */
export function especieDoAnexo(nome) {
  const n = String(nome ?? '')
  const ext = n.split('.').pop().toLowerCase()
  if (/^STK-|STICKER/i.test(n)) return 'figurinha'
  if (EXTENSOES.comprovante.includes(ext)) return 'comprovante'
  if (EXTENSOES.audio.includes(ext)) return 'audio'
  if (EXTENSOES.video.includes(ext)) return 'video'
  return 'outro'
}

/**
 * Lê o texto da conversa e devolve as mensagens, em ordem.
 *
 * Cada mensagem: `{ dia, quando, remetente, texto, anexo, omitida }`.
 * `dia` é AAAA-MM-DD; `quando`, o instante em milissegundos. A hora do
 * arquivo é a do celular que exportou, sem fuso — vale como hora de
 * Brasília, que é onde a empresa está.
 *
 * Linha que não começa com data é continuação da mensagem anterior (legenda
 * de várias linhas). Aviso do sistema ("Fulano entrou", "as mensagens são
 * protegidas…") não tem remetente e é ignorado.
 */
export function lerConversa(textoBruto) {
  const mensagens = []
  let atual = null

  for (const linhaBruta of String(textoBruto ?? '').split(/\r?\n/)) {
    const linha = linhaBruta.replace(INVISIVEIS, '')
    const m = CABECA_ANDROID.exec(linha) ?? CABECA_IPHONE.exec(linha)

    if (!m) {
      if (atual) atual.linhas.push(linha)
      continue
    }

    const [, d, mes, anoTxt, h, min, seg = '00', resto] = m
    const ano = anoTxt.length === 2 ? 2000 + Number(anoTxt) : Number(anoTxt)
    const dia = `${ano}-${mes.padStart(2, '0')}-${d.padStart(2, '0')}`
    const quando = Date.parse(`${dia}T${h.padStart(2, '0')}:${min}:${seg}-03:00`)

    const sep = resto.indexOf(': ')
    if (Number.isNaN(quando) || sep <= 0) { atual = null; continue }

    atual = { dia, quando, remetente: resto.slice(0, sep).trim(), linhas: [resto.slice(sep + 2)] }
    mensagens.push(atual)
  }

  return mensagens.map(({ linhas, ...msg }) => {
    const primeira = linhas[0] ?? ''
    let anexo = null
    let texto

    const android = ANEXO_ANDROID.exec(primeira.trim())
    const iphone = ANEXO_IPHONE.exec(linhas.join('\n'))
    if (android) {
      anexo = android[1].trim()
      texto = linhas.slice(1).join('\n')
    } else if (iphone) {
      anexo = iphone[1].trim()
      texto = linhas.join('\n').replace(ANEXO_IPHONE, '')
    } else {
      texto = linhas.join('\n')
    }

    const omitida = !anexo && OMITIDA.test(texto)
    return { ...msg, anexo, omitida, texto: omitida ? '' : texto.trim() }
  })
}

/**
 * Da conversa, os comprovantes a tratar.
 *
 * `desde` (AAAA-MM-DD) é o corte: mensagem de antes não entra. Devolve
 * `{ comprovantes, ignorados }`:
 *
 *  - `comprovantes`: `{ arquivo, remetente, dia, quando, legenda }`, em ordem;
 *  - `ignorados`: quantos de cada espécie ficaram de fora — para o relatório
 *    poder dizer que o zip foi lido inteiro, e não só o que interessava.
 */
export function comprovantesDaConversa(textoBruto, { desde } = {}) {
  const mensagens = lerConversa(textoBruto)
  const comprovantes = []
  const ignorados = { antesDoCorte: 0, figurinha: 0, audio: 0, video: 0, outro: 0, midiaOmitida: 0 }

  mensagens.forEach((msg, i) => {
    if (!msg.anexo && !msg.omitida) return
    if (desde && msg.dia < desde) { ignorados.antesDoCorte++; return }
    if (msg.omitida) { ignorados.midiaOmitida++; return }

    const especie = especieDoAnexo(msg.anexo)
    if (especie !== 'comprovante') { ignorados[especie]++; return }

    let legenda = msg.texto
    if (!legenda) {
      // Sem legenda: a mensagem SEGUINTE, se for texto da mesma pessoa e
      // vier em até dois minutos, é a descrição — como no dia a dia.
      const seguinte = mensagens[i + 1]
      if (seguinte && !seguinte.anexo && !seguinte.omitida && seguinte.texto
        && seguinte.remetente === msg.remetente
        && seguinte.quando - msg.quando >= 0
        && seguinte.quando - msg.quando <= JANELA_DESCRICAO_MS) {
        legenda = seguinte.texto
      }
    }

    comprovantes.push({ arquivo: msg.anexo, remetente: msg.remetente, dia: msg.dia, quando: msg.quando, legenda: legenda || '' })
  })

  return { comprovantes, ignorados }
}

/**
 * O tipo REAL de um arquivo, pelos primeiros bytes — e não pela extensão,
 * que é só um nome que veio de fora.
 *
 * Devolve o tipo (os mesmos que o módulo já aceita) ou null.
 */
export function tipoReal(arquivo) {
  if (!arquivo || arquivo.length < 12) return null
  if (arquivo[0] === 0xff && arquivo[1] === 0xd8 && arquivo[2] === 0xff) return 'image/jpeg'
  if (arquivo.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (arquivo.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf'
  if (arquivo.subarray(0, 4).toString('latin1') === 'RIFF' && arquivo.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (arquivo.subarray(4, 8).toString('latin1') === 'ftyp'
    && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(arquivo.subarray(8, 12).toString('latin1'))) return 'image/heic'
  return null
}
