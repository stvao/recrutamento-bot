/**
 * Comprovantes — ler o grupo antigo PELA CONTA DO DONO.
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 *
 * A leitura do grupo antigo (atraso.js) parte da conversa exportada pelo
 * celular. Exportar é um trabalho manual que o dono não quer fazer. Esta
 * ferramenta faz o mesmo por outro caminho: entra no WhatsApp DELE como
 * "aparelho conectado", lê só aquele grupo, baixa os comprovantes e monta um
 * zip IGUAL ao da exportação — de modo que o resto (ensaio, execução) roda
 * sem mudar nada.
 *
 * É uma ferramenta avulsa, de rodar UMA vez, num computador — e não dentro
 * do robô. Tem sessão própria: a do robô e a da cobrança de obras não são
 * tocadas, porque duas conexões com a mesma sessão se derrubam.
 *
 * ── O que ela não faz, e não pode fazer ──────────────────────────────────
 *
 * ESCREVER. Não manda mensagem, não marca como lido, não aparece online, não
 * reage. Este arquivo não chama nenhuma função de envio — e o teste falha se
 * alguma for chamada. (Pedir mais histórico e pedir o reenvio de uma mídia
 * antiga são conversas entre este aparelho e o celular do próprio dono:
 * ninguém do grupo vê.)
 *
 * GUARDAR O QUE NÃO É DO GRUPO. Conectada à conta do dono, a ferramenta
 * recebe TUDO — as conversas pessoais dele inclusive. O que não é do grupo
 * pedido é descartado na hora, na memória: não vai para o disco, não vai
 * para o log, não é contado, não é olhado. É a primeira coisa que o código
 * faz com cada mensagem, antes de qualquer outra.
 *
 * Este arquivo não conhece o Baileys: recebe um `sock` com o pouco que usa
 * (eventos, lista de grupos, pedido de histórico) e uma função `baixar`.
 * Quem conecta de verdade é `scripts/ler-grupo-pela-conta.js`; no teste, o
 * `sock` é de mentira.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { escreverZip } from './zip.js'
import { tipoReal } from './exportacao.js'
import { norm } from '../texto.js'

const MAX_ARQUIVO = 20 * 1024 * 1024
const EXTENSAO = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' }

const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms))

/** O conteúdo de verdade de uma mensagem, tirando os invólucros (temporária, visualização única, documento com legenda). */
function conteudoDe(mensagem) {
  let m = mensagem
  for (let i = 0; i < 4 && m; i++) {
    const dentro = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message
      ?? m.viewOnceMessageV2Extension?.message ?? m.documentWithCaptionMessage?.message
    if (!dentro) break
    m = dentro
  }
  return m ?? null
}

/** O instante da mensagem, em milissegundos. O WhatsApp manda em segundos, às vezes num objeto de 64 bits. */
function instanteDe(msg) {
  const t = msg?.messageTimestamp
  const segundos = typeof t === 'object' && t !== null ? Number(t.toNumber ? t.toNumber() : (t.low ?? 0)) : Number(t)
  return Number.isFinite(segundos) && segundos > 0 ? segundos * 1000 : null
}

/** O que guardar de uma mensagem do grupo — ou null se não é conversa (reação, aviso do sistema, apagada). */
function resumir(msg) {
  const c = conteudoDe(msg.message)
  const quando = instanteDe(msg)
  if (!c || !quando || !msg.key?.id) return null

  const basico = {
    id: msg.key.id,
    quando,
    // A chave inteira: é com ela que se pede ao celular o que veio ANTES.
    chave: { remoteJid: msg.key.remoteJid, id: msg.key.id, fromMe: Boolean(msg.key.fromMe), participant: msg.key.participant ?? undefined },
    // Dois-pontos e quebra de linha estragariam o formato "Nome: texto".
    remetente: msg.key.fromMe ? 'Você' : (String(msg.pushName ?? '').replace(/[:\r\n]/g, ' ').trim() || `final ${String(msg.key.participant ?? '').replace(/\D/g, '').slice(-4) || '????'}`),
  }

  const texto = c.conversation ?? c.extendedTextMessage?.text
  if (typeof texto === 'string' && texto.trim()) return { ...basico, especie: 'texto', texto }

  if (c.imageMessage) return { ...basico, especie: 'comprovante', mime: c.imageMessage.mimetype ?? 'image/jpeg', texto: c.imageMessage.caption ?? '', bruta: msg }
  if (c.documentMessage) {
    const mime = c.documentMessage.mimetype ?? ''
    // Documento que é imagem ou PDF é comprovante; planilha, contato e afins, não.
    if (mime === 'application/pdf' || mime.startsWith('image/')) {
      return { ...basico, especie: 'comprovante', mime, texto: c.documentMessage.caption ?? '', bruta: msg }
    }
    return { ...basico, especie: 'outro', texto: '' }
  }
  if (c.stickerMessage) return { ...basico, especie: 'figurinha', texto: '' }
  if (c.audioMessage) return { ...basico, especie: 'audio', texto: '' }
  if (c.videoMessage) return { ...basico, especie: 'video', texto: c.videoMessage.caption ?? '' }
  return null
}

/** Bytes dentro de JSON: a mensagem de mídia traz chaves em binário, e sem elas não se baixa depois. */
const paraJson = (_k, v) => {
  if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) return { __bytes: Buffer.from(v.data).toString('base64') }
  if (v instanceof Uint8Array) return { __bytes: Buffer.from(v).toString('base64') }
  return v
}
const deJson = (_k, v) => (v && typeof v === 'object' && typeof v.__bytes === 'string' ? Buffer.from(v.__bytes, 'base64') : v)

const emBrasilia = (ms, opcoes) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', ...opcoes }).format(new Date(ms))
const diaIso = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ms))

/**
 * A conversa, no formato do arquivo que o WhatsApp do Android exporta:
 *
 *   22/09/2026 14:03 - João: IMG-20260922-ab12cd34.jpg (arquivo anexado)
 *   haia cimento 250
 *
 * É o formato que `exportacao.js` já lê. A legenda vai na mesma mensagem, e
 * as mensagens de texto ficam na ordem — é assim que o passo seguinte acha a
 * descrição que a pessoa mandou logo depois da foto.
 *
 * O que não é comprovante entra com o nome que o WhatsApp daria (figurinha,
 * áudio, vídeo), só para o relatório poder contar. Mídia que não deu para
 * baixar entra como "mídia oculta", que é o que ela é.
 */
export function montarConversa(mensagens) {
  const linhas = []
  for (const m of [...mensagens].sort((a, b) => a.quando - b.quando || a.id.localeCompare(b.id))) {
    const data = emBrasilia(m.quando, { day: '2-digit', month: '2-digit', year: 'numeric' })
    const hora = emBrasilia(m.quando, { hour: '2-digit', minute: '2-digit', hour12: false })
    const cabeca = `${data} ${hora} - ${m.remetente}: `
    const texto = String(m.texto ?? '').replace(/\r/g, '').trim()
    const marca = diaIso(m.quando).replace(/-/g, '')

    if (m.especie === 'texto') linhas.push(cabeca + texto)
    else if (m.especie === 'comprovante' && m.arquivo) linhas.push(`${cabeca}${m.arquivo} (arquivo anexado)${texto ? `\n${texto}` : ''}`)
    else if (m.especie === 'comprovante') linhas.push(`${cabeca}<Mídia oculta>`)
    else if (m.especie === 'figurinha') linhas.push(`${cabeca}STK-${marca}-${m.id.slice(-6)}.webp (arquivo anexado)`)
    else if (m.especie === 'audio') linhas.push(`${cabeca}PTT-${marca}-${m.id.slice(-6)}.opus (arquivo anexado)`)
    else if (m.especie === 'video') linhas.push(`${cabeca}VID-${marca}-${m.id.slice(-6)}.mp4 (arquivo anexado)`)
    else linhas.push(`${cabeca}DOC-${marca}-${m.id.slice(-6)}.bin (arquivo anexado)`)
  }
  return `${linhas.join('\n')}\n`
}

/**
 * O leitor de UM grupo.
 *
 * `pasta` guarda o estado (as mensagens do grupo e as mídias baixadas) — é o
 * que torna a leitura retomável. `saida` recebe o zip, o resumo e a lista de
 * falhas. `baixar(mensagemBruta)` devolve os bytes da mídia, ou lança.
 */
export class LeitorDeGrupo {
  constructor({ pasta, saida, grupoNome, grupoId = null, desde = '2026-09-22', baixar, tempos = {}, avisar = console.log }) {
    // `grupoId` só é preciso quando há dois grupos com o mesmo nome: aí é ele
    // que diz qual.
    this.grupoIdPedido = grupoId
    this.pasta = pasta
    this.saida = saida ?? pasta
    this.grupoNome = grupoNome
    this.desde = desde
    this.corte = Date.parse(`${desde}T00:00:00-03:00`)
    this.baixar = baixar
    this.avisar = avisar
    this.tempos = {
      // Quanto esperar, sem chegar nada, para dar a sincronização inicial por terminada.
      inicial: 30000,
      // O máximo que se espera por ela.
      inicialMaximo: 5 * 60 * 1000,
      // Quanto esperar a resposta de um pedido de histórico.
      resposta: 40000,
      // Entre um pedido e o seguinte. Calmo de propósito: é a conta do dono.
      pausa: 5000,
      // Entre as tentativas de baixar a mesma mídia.
      tentativa: 8000,
      // Entre uma mídia e a seguinte.
      entreMidias: 700,
      ...tempos,
    }
    this.sock = null
    this.grupoId = null
    /** id da mensagem → o que se guardou dela. Só mensagens do grupo. */
    this.mensagens = new Map()
    /** O que chegou antes de se saber qual é o grupo. Só em memória; filtrado e esvaziado assim que se sabe. */
    this.aguardando = []
    this.ultimaChegada = 0
    this.pedidos = 0
    this.carregar()
  }

  // ─── Estado em disco (só o grupo) ────────────────────────────────────────

  get arquivoEstado() { return join(this.pasta, 'estado.json') }
  get pastaMidia() { return join(this.pasta, 'midia') }

  carregar() {
    try {
      if (!existsSync(this.arquivoEstado)) return
      const e = JSON.parse(readFileSync(this.arquivoEstado, 'utf8'), deJson)
      // Estado de OUTRO grupo não serve para este: começa do zero em vez de misturar.
      if (norm(e.grupoNome ?? '') !== norm(this.grupoNome ?? '')) return
      this.grupoId = e.grupoId ?? null
      for (const m of e.mensagens ?? []) this.mensagens.set(m.id, m)
    } catch (erro) {
      this.avisar(`[leitor] não consegui ler o estado anterior, começando do zero: ${erro.message}`)
    }
  }

  salvar() {
    mkdirSync(this.pasta, { recursive: true })
    const temp = `${this.arquivoEstado}.tmp`
    writeFileSync(temp, JSON.stringify({ grupoNome: this.grupoNome, grupoId: this.grupoId, mensagens: [...this.mensagens.values()] }, paraJson), 'utf8')
    renameSync(temp, this.arquivoEstado)
  }

  // ─── O que chega ─────────────────────────────────────────────────────────

  /** Liga a um socket. Pode ser chamado de novo depois de uma reconexão. */
  ligar(sock) {
    this.sock = sock
    sock.ev.on('messaging-history.set', ({ messages }) => this.receber(messages))
    sock.ev.on('messages.upsert', ({ messages }) => this.receber(messages))
  }

  /**
   * Recebe um lote de mensagens — de QUALQUER conversa da conta.
   *
   * A primeira coisa, antes de olhar qualquer outra, é o endereço: não é do
   * grupo, some. Não é guardado, não é contado, não é registrado.
   */
  receber(lote) {
    this.ultimaChegada = Date.now()
    if (!Array.isArray(lote) || !lote.length) return

    if (!this.grupoId) {
      // Ainda não se sabe qual é o grupo (a lista de grupos está sendo
      // buscada). Guarda em MEMÓRIA só o que veio de grupo, e só até saber.
      for (const m of lote) if (m?.key?.remoteJid?.endsWith('@g.us')) this.aguardando.push(m)
      return
    }

    let novas = 0
    for (const m of lote) {
      if (m?.key?.remoteJid !== this.grupoId) continue
      if (this.mensagens.has(m.key.id)) continue
      const r = resumir(m)
      if (!r) continue
      this.mensagens.set(r.id, r)
      novas++
    }
    if (novas) this.salvar()
  }

  /** Acha o grupo pelo nome. Um só — com dois de mesmo nome, para e mostra os dois. */
  async acharGrupo() {
    if (!this.grupoId) {
      const grupos = Object.values(await this.sock.groupFetchAllParticipating())
      const alvo = norm(this.grupoNome)
      let iguais = grupos.filter(g => norm(g.subject ?? '') === alvo)
      if (this.grupoIdPedido) iguais = iguais.filter(g => g.id === this.grupoIdPedido)

      if (!iguais.length) {
        this.aguardando = []
        throw new Error(`Não achei nenhum grupo chamado "${this.grupoNome}" nesta conta. Confira o nome exato (como aparece no WhatsApp).`)
      }
      if (iguais.length > 1) {
        this.aguardando = []
        const lista = iguais.map(g => `  - "${g.subject}", ${g.size ?? g.participants?.length ?? '?'} participantes, criado em ${g.creation ? emBrasilia(g.creation * 1000, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '?'} (--grupo-id ${g.id})`).join('\n')
        throw new Error(`Há ${iguais.length} grupos chamados "${this.grupoNome}":\n${lista}\nRode de novo dizendo qual, com --grupo-id.`)
      }
      this.grupoId = iguais[0].id
    }

    // Agora que se sabe qual é: do que esperava, fica só o do grupo. O resto some.
    const esperando = this.aguardando
    this.aguardando = []
    this.receber(esperando)
    this.salvar()
  }

  // ─── Ler para trás ───────────────────────────────────────────────────────

  maisAntiga() {
    let antiga = null
    for (const m of this.mensagens.values()) if (!antiga || m.quando < antiga.quando) antiga = m
    return antiga
  }

  /** Espera a conta parar de mandar a sincronização inicial. */
  async esperarSincronizacao() {
    const comeco = Date.now()
    this.ultimaChegada = Date.now()
    while (Date.now() - comeco < this.tempos.inicialMaximo) {
      if (Date.now() - this.ultimaChegada >= this.tempos.inicial) break
      await pausa(Math.min(500, this.tempos.inicial))
    }
  }

  /**
   * Pede ao celular o que veio antes da mensagem mais antiga conhecida, até
   * passar do corte ou parar de chegar coisa nova.
   */
  async lerParaTras() {
    let semNovidade = 0
    while (semNovidade < 2 && this.pedidos < 600) {
      const antiga = this.maisAntiga()
      if (!antiga || antiga.quando < this.corte) return 'corte'

      const antes = this.mensagens.size
      const idAntes = antiga.id
      try {
        await this.sock.fetchMessageHistory(50, antiga.chave, antiga.quando)
        this.pedidos++
      } catch (erro) {
        this.avisar(`[leitor] o pedido de histórico falhou (${erro.message}) — tentando de novo`)
      }

      const prazo = Date.now() + this.tempos.resposta
      while (Date.now() < prazo && this.maisAntiga().id === idAntes) await pausa(Math.min(300, this.tempos.resposta))

      if (this.maisAntiga().id === idAntes) semNovidade++
      else {
        semNovidade = 0
        this.avisar(`[leitor] ${this.mensagens.size} mensagens do grupo, a mais antiga de ${emBrasilia(this.maisAntiga().quando, { day: '2-digit', month: '2-digit', year: 'numeric' })} (+${this.mensagens.size - antes})`)
      }
      await pausa(this.tempos.pausa)
    }
    return 'acabou'
  }

  // ─── As mídias ───────────────────────────────────────────────────────────

  /** Os comprovantes de `desde` para cá, do mais antigo para o mais novo. */
  comprovantes() {
    return [...this.mensagens.values()].filter(m => m.especie === 'comprovante' && m.quando >= this.corte).sort((a, b) => a.quando - b.quando)
  }

  async baixarMidias() {
    mkdirSync(this.pastaMidia, { recursive: true })
    const jaTem = new Set(existsSync(this.pastaMidia) ? readdirSync(this.pastaMidia) : [])

    for (const m of this.comprovantes()) {
      // Já baixada numa rodada anterior, e o arquivo está lá: não baixa de novo.
      if (m.arquivo && jaTem.has(m.arquivo)) continue
      m.arquivo = null
      if (!m.bruta) { m.falha = 'a mensagem não trouxe a mídia'; continue }

      let erro = null
      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        try {
          const dados = Buffer.from(await this.baixar(m.bruta))
          if (!dados.length) throw new Error('veio vazia')
          if (dados.length > MAX_ARQUIVO) throw new Error('passa de 20 MB')
          // O tipo é o que os bytes dizem, não o que a mensagem diz.
          const tipo = tipoReal(dados)
          if (!tipo) throw new Error('não é imagem nem PDF')
          // Nome nosso: data + impressão digital. Nada do nome original.
          const nome = `${tipo === 'application/pdf' ? 'DOC' : 'IMG'}-${diaIso(m.quando).replace(/-/g, '')}-${createHash('sha256').update(dados).digest('hex').slice(0, 10)}-${m.id.slice(-4)}.${EXTENSAO[tipo]}`
          writeFileSync(join(this.pastaMidia, nome), dados)
          m.arquivo = nome
          delete m.falha
          erro = null
          break
        } catch (e) {
          erro = e
          // Não adianta insistir no que não é rede: arquivo grande demais, ou de outro tipo.
          if (/20 MB|não é imagem/.test(e.message)) break
          if (tentativa < 3) await pausa(this.tempos.tentativa)
        }
      }
      if (erro) m.falha = erro.message
      this.salvar()
      await pausa(this.tempos.entreMidias)
    }
  }

  // ─── A saída ─────────────────────────────────────────────────────────────

  /** Escreve o zip (igual ao da exportação), o resumo e a lista do que não baixou. */
  gerarSaida(motivoDoFim) {
    mkdirSync(this.saida, { recursive: true })
    const todas = [...this.mensagens.values()]
    const comprovantes = this.comprovantes()
    const baixadas = comprovantes.filter(m => m.arquivo)
    const falhas = comprovantes.filter(m => !m.arquivo)

    const zip = join(this.saida, 'grupo-antigo.zip')
    escreverZip(zip, [
      { nome: `Conversa do WhatsApp com ${String(this.grupoNome).replace(/[\\/:*?"<>|]/g, ' ')}.txt`, dados: Buffer.from(montarConversa(todas), 'utf8') },
      ...baixadas.map(m => ({ nome: m.arquivo, dados: () => readFileSync(join(this.pastaMidia, m.arquivo)) })),
    ])

    const celula = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`
    const csv = ['"Data";"Hora";"Remetente";"Legenda";"Motivo"', ...falhas.map(m => [
      emBrasilia(m.quando, { day: '2-digit', month: '2-digit', year: 'numeric' }),
      emBrasilia(m.quando, { hour: '2-digit', minute: '2-digit', hour12: false }),
      m.remetente, m.texto, m.falha ?? 'não baixou',
    ].map(celula).join(';'))]
    const arquivoFalhas = join(this.saida, 'falhas.csv')
    writeFileSync(arquivoFalhas, `${String.fromCharCode(0xfeff)}${csv.join('\r\n')}\r\n`, 'utf8')

    const antiga = this.maisAntiga()
    const data = (ms) => emBrasilia(ms, { day: '2-digit', month: '2-digit', year: 'numeric' })
    const chegou = antiga && antiga.quando < this.corte
    const resumo = {
      grupo: this.grupoNome,
      desde: this.desde,
      mensagensLidas: todas.length,
      comprovantes: comprovantes.length,
      midiasBaixadas: baixadas.length,
      midiasQueFalharam: falhas.length,
      maisAntigaAlcancada: antiga ? data(antiga.quando) : null,
      chegouAoCorte: Boolean(chegou),
      zip,
      falhas: arquivoFalhas,
    }
    const texto = [
      `Grupo "${this.grupoNome}" — lido pela conta, de ${data(this.corte)} para cá.`,
      '',
      `${resumo.mensagensLidas} mensagens lidas do grupo`,
      `${resumo.comprovantes} comprovantes (imagem ou PDF) no período`,
      `${resumo.midiasBaixadas} mídias baixadas`,
      `${resumo.midiasQueFalharam} mídias que NÃO baixaram${resumo.midiasQueFalharam ? ' — lista em falhas.csv, para achar à mão' : ''}`,
      `Mensagem mais antiga alcançada: ${resumo.maisAntigaAlcancada ?? 'nenhuma'}`,
      chegou
        ? 'A leitura chegou até antes da data de corte: o período está inteiro.'
        : `ATENÇÃO: a leitura NÃO chegou à data de corte (${motivoDoFim === 'acabou' ? 'o celular parou de mandar mensagens mais antigas' : 'interrompida'}). O que é de antes de ${resumo.maisAntigaAlcancada ?? '?'} não está no zip — rode de novo para continuar, ou exporte a conversa pelo celular.`,
      '',
      `Zip (mesmo formato da "Exportar conversa"): ${zip}`,
      '',
      'TERMINOU? Desconecte este aparelho: rode o comando "sair", ou no celular',
      'WhatsApp → Aparelhos conectados → toque no aparelho → Desconectar.',
    ].join('\n')
    writeFileSync(join(this.saida, 'resumo.txt'), `${texto}\n`, 'utf8')
    return { ...resumo, texto }
  }

  /** Tudo, do começo ao fim. Devolve o resumo. Lança, com mensagem clara, quando não dá para continuar. */
  async rodar() {
    await this.acharGrupo()
    const retomando = this.mensagens.size > 0
    this.avisar(retomando
      ? `[leitor] retomando: já tenho ${this.mensagens.size} mensagens do grupo.`
      : '[leitor] esperando a conta mandar o histórico inicial (pode levar alguns minutos)…')

    await this.esperarSincronizacao()

    if (!this.mensagens.size) {
      throw new Error(
        `A conta sincronizou, mas não veio nenhuma mensagem do grupo "${this.grupoNome}". `
        + 'Isso acontece quando o grupo está parado há muito tempo: o WhatsApp só manda a um aparelho novo as conversas recentes. '
        + 'Sem uma mensagem do grupo como ponto de partida não há como pedir as anteriores. '
        + 'Saída: exportar a conversa pelo celular (Exportar conversa → Incluir mídia).')
    }

    const fim = await this.lerParaTras()
    await this.baixarMidias()
    return this.gerarSaida(fim)
  }
}
