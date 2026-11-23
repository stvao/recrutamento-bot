/**
 * Ler o grupo antigo pela conta do dono — com um WhatsApp de mentira.
 *
 * A ferramenta entra na CONTA do dono, e por isso recebe tudo: as conversas
 * pessoais dele inclusive. O que se confere aqui, antes de qualquer outra
 * coisa:
 *
 *  - o que não é do grupo pedido não vai para o disco nem para o log;
 *  - NADA é enviado: qualquer função de envio chamada falha o teste;
 *
 * e depois o resto: para no corte, retoma sem baixar de novo, mídia que não
 * baixa vira relatório, e o zip que sai é lido pelo mesmo código que lê a
 * conversa exportada pelo celular.
 */
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { LeitorDeGrupo, montarConversa } = await import('../src/comprovantes/leitor-conta.js')
const { abrirZip } = await import('../src/comprovantes/zip.js')
const { comprovantesDaConversa } = await import('../src/comprovantes/exportacao.js')

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

const DIA = 24 * 60 * 60 * 1000
const GRUPO = '120363000000000001@g.us'
const OUTRO_GRUPO = '120363000000000002@g.us'
const PESSOAL = '5511977776666@s.whatsapp.net'
const SEGREDO = 'SEGREDO-PESSOAL-DO-DONO'
const emBrasilia = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ms))
const HOJE = Date.now()
const CORTE_DIAS = 40
const DESDE = emBrasilia(HOJE - CORTE_DIAS * DIA)
const TEMPOS = { inicial: 40, inicialMaximo: 600, resposta: 90, pausa: 1, tentativa: 1, entreMidias: 0 }

let nId = 0
function msg(jid, quando, conteudo, { nome = 'João Pedreiro', deMim = false, id } = {}) {
  return {
    key: { remoteJid: jid, id: id ?? `MSG${String(++nId).padStart(6, '0')}`, fromMe: deMim, participant: jid.endsWith('@g.us') ? '5511988887777@s.whatsapp.net' : undefined },
    messageTimestamp: Math.floor(quando / 1000),
    pushName: nome,
    message: conteudo,
  }
}
const texto = (t) => ({ conversation: t })
const foto = (legenda = '') => ({ imageMessage: { mimetype: 'image/jpeg', caption: legenda, mediaKey: new Uint8Array([1, 2, 3, 4]), url: 'https://mmg.whatsapp.net/x' } })
const pdf = (legenda = '') => ({ documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/pdf', caption: legenda, fileName: '../../fora.pdf', mediaKey: new Uint8Array([9, 9]) } } } })

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const bytesDaFoto = (id) => Buffer.concat([JPEG, Buffer.from(`foto-${id}`)])
const bytesDoPdf = (id) => Buffer.from(`%PDF-1.7 documento ${id}`)

/**
 * Uma conta de WhatsApp de mentira.
 *
 * `historico` é tudo que existe na conta, de todas as conversas. Na
 * sincronização inicial vem só o mais recente de cada conversa; o resto, só
 * pedindo. Qualquer coisa que não seja LER é registrada como violação.
 */
function contaDeMentira({ historico, grupos, recentes = 5, limiteDoCelular = Infinity }) {
  const ouvintes = new Map()
  const violacoes = []
  const pedidos = []
  const ev = {
    on: (evento, fn) => { ouvintes.set(evento, [...(ouvintes.get(evento) ?? []), fn]) },
    emit: (evento, dado) => { for (const fn of ouvintes.get(evento) ?? []) fn(dado) },
  }
  const porConversa = (jid) => historico.filter(m => m.key.remoteJid === jid).sort((a, b) => b.messageTimestamp - a.messageTimestamp)
  const conversas = [...new Set(historico.map(m => m.key.remoteJid))]

  const permitido = {
    ev,
    user: { id: '5511999990000:7@s.whatsapp.net' },
    groupFetchAllParticipating: async () => Object.fromEntries(grupos.map(g => [g.id, g])),
    fetchMessageHistory: async (quantas, chave, quandoMs) => {
      pedidos.push({ quantas, chave, quandoMs })
      const antigas = porConversa(chave.remoteJid).filter(m => m.messageTimestamp * 1000 < quandoMs)
      const lote = pedidos.length > limiteDoCelular ? [] : antigas.slice(0, quantas)
      setTimeout(() => ev.emit('messaging-history.set', { messages: lote, syncType: 6 }), 3)
      return 'pedido-1'
    },
    updateMediaMessage: async (m) => m,
  }
  // Tudo que não está na lista de cima é escrita, presença ou leitura marcada.
  const sock = new Proxy(permitido, {
    get(alvo, nome) {
      if (nome in alvo || typeof nome === 'symbol' || nome === 'then') return alvo[nome]
      return (...argumentos) => { violacoes.push({ nome, argumentos }); throw new Error(`o leitor chamou ${String(nome)}()`) }
    },
  })

  return {
    sock, violacoes, pedidos, ev,
    /** A sincronização inicial: o mais recente de CADA conversa — pessoais inclusive. */
    sincronizar: () => { for (const jid of conversas) ev.emit('messaging-history.set', { messages: porConversa(jid).slice(0, recentes), syncType: 0 }) },
  }
}

/** Todos os arquivos de uma pasta, recursivamente. */
function arquivosDe(pasta) {
  if (!existsSync(pasta)) return []
  return readdirSync(pasta).flatMap((n) => { const c = join(pasta, n); return statSync(c).isDirectory() ? arquivosDe(c) : [c] })
}

/** Um grupo com `dias` dias de história: uma foto com legenda por dia, mais conversa. */
function historiaDoGrupo(dias) {
  const h = []
  for (let d = dias; d >= 0; d--) {
    const t = HOJE - d * DIA - 3 * 60 * 60 * 1000
    h.push(msg(GRUPO, t, foto(`haia cimento ${100 + d}`)))
    h.push(msg(GRUPO, t + 60000, texto(`bom dia ${d}`), { nome: 'Maria' }))
  }
  return h
}
const conversasPessoais = () => [
  msg(PESSOAL, HOJE - 2 * DIA, texto(`${SEGREDO}: senha do banco 1234`), { nome: 'Esposa' }),
  msg(PESSOAL, HOJE - 1 * DIA, foto(`${SEGREDO} foto de família`), { nome: 'Esposa' }),
  msg(OUTRO_GRUPO, HOJE - 1 * DIA, texto(`${SEGREDO} do grupo da família`), { nome: 'Tio' }),
  msg(OUTRO_GRUPO, HOJE - 1 * DIA + 1000, foto(`${SEGREDO} churrasco`), { nome: 'Tio' }),
]
const GRUPOS = [{ id: GRUPO, subject: 'Comprovantes Obras', size: 8 }, { id: OUTRO_GRUPO, subject: 'Família', size: 12 }]

function novoLeitor(pasta, conta, { baixar, nome = 'comprovantes obras', grupoId, desde = DESDE } = {}) {
  const ditos = []
  const baixadas = []
  const leitor = new LeitorDeGrupo({
    pasta: join(pasta, 'estado'), saida: join(pasta, 'saida'), grupoNome: nome, grupoId, desde, tempos: TEMPOS,
    avisar: (t) => ditos.push(String(t)),
    baixar: baixar ?? (async (m) => { baixadas.push(m.key.id); return m.message.imageMessage ? bytesDaFoto(m.key.id) : bytesDoPdf(m.key.id) }),
  })
  leitor.ligar(conta.sock)
  return { leitor, ditos, baixadas }
}

// ══ 1. Só o grupo. O resto não vai para lugar nenhum ══════════════════════
{
  const pasta = mkdtempSync(join(tmpdir(), 'teste-leitor-1-'))
  const conta = contaDeMentira({ historico: [...historiaDoGrupo(50), ...conversasPessoais()], grupos: GRUPOS, recentes: 6 })
  const { leitor, ditos, baixadas } = novoLeitor(pasta, conta)

  conta.sincronizar()                       // chega ANTES de se saber qual é o grupo
  setTimeout(() => conta.sincronizar(), 10) // e de novo depois
  const resumo = await leitor.rodar()

  const tudoEmDisco = arquivosDe(pasta).map(c => readFileSync(c).toString('latin1')).join('\n')
  ok('nada das conversas pessoais vai para o disco', !tudoEmDisco.includes(SEGREDO))
  ok('nem para o que a ferramenta diz na tela', !ditos.join('\n').includes(SEGREDO) && !resumo.texto.includes(SEGREDO))
  ok('nem o endereço das outras conversas', !tudoEmDisco.includes('5511977776666') && !tudoEmDisco.includes(OUTRO_GRUPO))
  ok('mídia de outra conversa nunca é baixada', baixadas.length > 0 && baixadas.every(id => conta.pedidos.length >= 0 && leitor.mensagens.has(id)))
  ok('só se pede histórico DO GRUPO', conta.pedidos.length > 0 && conta.pedidos.every(p => p.chave.remoteJid === GRUPO))
  ok('NADA foi enviado, marcado como lido ou sinalizado', conta.violacoes.length === 0)

  // ── para no corte ──
  const antiga = leitor.maisAntiga()
  ok('leu para trás até passar da data de corte', antiga.quando < leitor.corte && resumo.chegouAoCorte === true)
  // 102 mensagens no grupo; 6 vieram na sincronização; cada pedido traz 50.
  // Passado o corte (a ~82 mensagens do fim), não se pede mais.
  ok('e parou de pedir assim que passou do corte', conta.pedidos.length === 2)
  ok('em lotes pequenos, a partir da mais antiga conhecida', conta.pedidos.every(p => p.quantas === 50) && conta.pedidos[1].quandoMs < conta.pedidos[0].quandoMs)

  // ── o que sai ──
  ok('resumo: mensagens, comprovantes e mídias', resumo.mensagensLidas === 102 && resumo.comprovantes === CORTE_DIAS + 1
    && resumo.midiasBaixadas === CORTE_DIAS + 1 && resumo.midiasQueFalharam === 0)
  ok('só baixa o que é do período', baixadas.length === CORTE_DIAS + 1)
  ok('o resumo lembra de desconectar o aparelho', /Aparelhos conectados/.test(resumo.texto) && /"sair"/.test(resumo.texto))
  ok('e fica em arquivo', existsSync(join(pasta, 'saida', 'resumo.txt')) && existsSync(join(pasta, 'saida', 'falhas.csv')))

  // ── o zip é lido pelo MESMO código que lê a exportação do celular ──
  const zip = abrirZip(resumo.zip)
  const txt = zip.entradas.find(e => /\.txt$/.test(e.base))
  const conversa = zip.ler(txt, 1e7).toString('utf8')
  const lido = comprovantesDaConversa(conversa, { desde: DESDE })
  ok('o zip tem o texto da conversa e os arquivos', Boolean(txt) && zip.entradas.length === 1 + CORTE_DIAS + 1)
  ok('o leitor da exportação acha os mesmos comprovantes', lido.comprovantes.length === CORTE_DIAS + 1)
  ok('com a legenda junto da mídia', lido.comprovantes.every(c => /^haia cimento \d+$/.test(c.legenda)))
  ok('e o remetente', lido.comprovantes.every(c => c.remetente === 'João Pedreiro'))
  ok('o que é de antes do corte fica de fora, contado', lido.ignorados.antesDoCorte > 0)
  const porNome = new Map(zip.entradas.map(e => [e.base, e]))
  ok('cada comprovante citado tem o arquivo no zip', lido.comprovantes.every(c => porNome.has(c.arquivo)))
  ok('e é a imagem de verdade', lido.comprovantes.every(c => zip.ler(porNome.get(c.arquivo), 1e6).subarray(0, 3).equals(JPEG.subarray(0, 3))))
  ok('o nome do arquivo é nosso, sem nada do original', lido.comprovantes.every(c => /^IMG-\d{8}-[0-9a-f]{10}-\w{4}\.jpg$/.test(c.arquivo)))
  zip.fechar()
}

// ══ 2. Os tipos de mensagem, e a descrição que vem logo depois ════════════
{
  const pasta = mkdtempSync(join(tmpdir(), 'teste-leitor-2-'))
  const t0 = HOJE - 5 * DIA
  const historico = [
    msg(GRUPO, t0, foto('')),                                                  // sem legenda…
    msg(GRUPO, t0 + 30000, texto('tsuya areia 90')),                           // …e a descrição logo depois
    msg(GRUPO, t0 + 10 * 60000, pdf('haia nota 4521')),
    msg(GRUPO, t0 + 20 * 60000, { ephemeralMessage: { message: foto('haia tinta 77') } }),
    msg(GRUPO, t0 + 30 * 60000, { stickerMessage: {} }),
    msg(GRUPO, t0 + 31 * 60000, { audioMessage: {} }),
    msg(GRUPO, t0 + 32 * 60000, { videoMessage: { caption: 'vídeo da obra' } }),
    msg(GRUPO, t0 + 33 * 60000, { documentMessage: { mimetype: 'application/vnd.ms-excel', fileName: 'planilha.xls' } }),
    msg(GRUPO, t0 + 34 * 60000, { reactionMessage: { text: '👍' } }),
    msg(GRUPO, t0 + 35 * 60000, { protocolMessage: { type: 0 } }),
    msg(GRUPO, t0 + 36 * 60000, texto('mandei eu mesmo'), { deMim: true }),
    msg(GRUPO, t0 + 37 * 60000, texto('nome: com dois pontos'), { nome: 'Zé: da Obra' }),
    msg(GRUPO, HOJE - (CORTE_DIAS + 3) * DIA, texto('mensagem de antes do corte')),
  ]
  const conta = contaDeMentira({ historico, grupos: GRUPOS, recentes: 50 })
  const { leitor } = novoLeitor(pasta, conta)
  setTimeout(() => conta.sincronizar(), 5)
  // Uma mensagem nova chega no grupo enquanto a leitura roda.
  setTimeout(() => conta.ev.emit('messages.upsert', { type: 'notify', messages: [msg(GRUPO, HOJE - 1000, foto('haia prego 12')), msg(PESSOAL, HOJE, texto(SEGREDO))] }), 15)
  const resumo = await leitor.rodar()

  const zip = abrirZip(resumo.zip)
  const conversa = zip.ler(zip.entradas.find(e => /\.txt$/.test(e.base)), 1e7).toString('utf8')
  const lido = comprovantesDaConversa(conversa, { desde: DESDE })
  ok('foto, PDF com legenda, mensagem temporária e a que chegou durante a leitura', lido.comprovantes.length === 4)
  ok('texto do mesmo remetente logo depois da foto vira a descrição dela', lido.comprovantes[0].legenda === 'tsuya areia 90')
  ok('PDF é PDF, com a legenda', /^DOC-.*\.pdf$/.test(lido.comprovantes[1].arquivo) && lido.comprovantes[1].legenda === 'haia nota 4521')
  ok('o nome original do documento não é usado', !conversa.includes('fora.pdf') && !zip.entradas.some(e => e.nome.includes('..')))
  ok('figurinha, áudio, vídeo e planilha entram só para a contagem', lido.ignorados.figurinha === 1 && lido.ignorados.audio === 1 && lido.ignorados.video === 1 && lido.ignorados.outro === 1)
  ok('reação e aviso do sistema não são conversa', !conversa.includes('👍') && leitor.mensagens.size === 12)
  ok('mensagem do próprio dono aparece como "Você"', /- Você: mandei eu mesmo/.test(conversa))
  ok('dois-pontos no nome não quebram o formato', /- Zé  da Obra: nome: com dois pontos/.test(conversa))
  ok('a mensagem pessoal que chegou no meio não entrou', !conversa.includes(SEGREDO))
  ok('nada enviado', conta.violacoes.length === 0)
  zip.fechar()
}

// ══ 3. O formato da linha ═════════════════════════════════════════════════
{
  const quando = Date.parse('2026-09-22T14:03:20-03:00')
  const linhas = montarConversa([
    { id: 'A1', quando, remetente: 'João', especie: 'comprovante', arquivo: 'IMG-20260922-abc.jpg', texto: 'haia cimento 250\nsegunda linha' },
    { id: 'A2', quando: quando + 60000, remetente: 'João', especie: 'texto', texto: 'obrigado' },
    { id: 'A3', quando: quando + 120000, remetente: 'Maria', especie: 'comprovante', arquivo: null, texto: 'não baixou' },
  ])
  ok('linha no formato do Android, na hora de Brasília',
    linhas === '22/09/2026 14:03 - João: IMG-20260922-abc.jpg (arquivo anexado)\nhaia cimento 250\nsegunda linha\n22/09/2026 14:04 - João: obrigado\n22/09/2026 14:05 - Maria: <Mídia oculta>\n')
}

// ══ 4. Mídia que não baixa vira relatório ═════════════════════════════════
{
  const pasta = mkdtempSync(join(tmpdir(), 'teste-leitor-4-'))
  const t0 = HOJE - 3 * DIA
  const historico = [
    msg(GRUPO, t0, foto('haia some 10'), { id: 'SOME0001' }),             // nunca baixa (o celular não tem mais)
    msg(GRUPO, t0 + 60000, foto('haia teima 20'), { id: 'TEIMA001' }),    // falha uma vez, depois vem
    msg(GRUPO, t0 + 120000, foto('haia texto 30'), { id: 'TEXTO001' }),   // "foto" que não é imagem
    msg(GRUPO, t0 + 180000, foto('haia boa 40'), { id: 'BOA00001' }),
    msg(GRUPO, HOJE - (CORTE_DIAS + 2) * DIA, texto('antes do corte')),
  ]
  const conta = contaDeMentira({ historico, grupos: GRUPOS, recentes: 50 })
  const tentativas = {}
  const baixar = async (m) => {
    const id = m.key.id
    tentativas[id] = (tentativas[id] ?? 0) + 1
    if (id === 'SOME0001') throw new Error('mídia expirada')
    if (id === 'TEIMA001' && tentativas[id] === 1) throw new Error('rede')
    if (id === 'TEXTO001') return Buffer.from('isto não é uma imagem de verdade, é texto')
    return bytesDaFoto(id)
  }
  const { leitor } = novoLeitor(pasta, conta, { baixar })
  setTimeout(() => conta.sincronizar(), 5)
  const resumo = await leitor.rodar()

  ok('conta o que baixou e o que não', resumo.comprovantes === 4 && resumo.midiasBaixadas === 2 && resumo.midiasQueFalharam === 2)
  ok('tenta de novo o que falhou por rede (3 vezes no máximo)', tentativas.TEIMA001 === 2 && tentativas.SOME0001 === 3)
  ok('mas não insiste no que não é imagem', tentativas.TEXTO001 === 1)
  const csv = readFileSync(resumo.falhas, 'utf8')
  ok('o relatório de falhas tem data, remetente e legenda', /"João Pedreiro";"haia some 10";"mídia expirada"/.test(csv) && /"haia texto 30";"não é imagem nem PDF"/.test(csv))
  ok('e só as que falharam', csv.trim().split('\r\n').length === 3)
  ok('o resumo manda achar à mão', /2 mídias que NÃO baixaram — lista em falhas\.csv/.test(resumo.texto))

  const zip = abrirZip(resumo.zip)
  const lido = comprovantesDaConversa(zip.ler(zip.entradas.find(e => /\.txt$/.test(e.base)), 1e7).toString('utf8'), { desde: DESDE })
  ok('no zip, o que não baixou aparece como mídia que falta', lido.comprovantes.length === 2 && lido.ignorados.midiaOmitida === 2)
  zip.fechar()

  // ── retomada: roda de novo, e o celular agora tem a mídia ──
  const conta2 = contaDeMentira({ historico, grupos: GRUPOS, recentes: 50 })
  const denovo = {}
  const { leitor: leitor2 } = novoLeitor(pasta, conta2, { baixar: async (m) => { denovo[m.key.id] = (denovo[m.key.id] ?? 0) + 1; return bytesDaFoto(m.key.id) } })
  ok('RETOMADA: o que já foi lido volta do disco', leitor2.mensagens.size === 5)
  const resumo2 = await leitor2.rodar()                 // sem sincronização nenhuma desta vez
  ok('RETOMADA: não baixa de novo o que já tinha', !denovo.BOA00001 && !denovo.TEIMA001)
  ok('RETOMADA: baixa só o que faltava', denovo.SOME0001 === 1 && denovo.TEXTO001 === 1 && resumo2.midiasBaixadas === 4 && resumo2.midiasQueFalharam === 0)
  ok('RETOMADA: já tinha passado do corte, não pede mais histórico', conta2.pedidos.length === 0)
  ok('RETOMADA: a mídia binária voltou inteira do disco', Buffer.isBuffer(leitor2.mensagens.get('BOA00001').bruta.message.imageMessage.mediaKey))
  ok('nada enviado nas duas rodadas', conta.violacoes.length === 0 && conta2.violacoes.length === 0)
}

// ══ 5. O celular para de mandar antes do corte ════════════════════════════
{
  const pasta = mkdtempSync(join(tmpdir(), 'teste-leitor-5-'))
  const historico = historiaDoGrupo(60)
  const conta = contaDeMentira({ historico, grupos: GRUPOS, recentes: 4, limiteDoCelular: 1 })
  const { leitor } = novoLeitor(pasta, conta)
  setTimeout(() => conta.sincronizar(), 5)
  const resumo = await leitor.rodar()
  ok('parou de vir coisa nova: desiste depois de duas tentativas sem resposta', conta.pedidos.length === 3)
  ok('e diz que NÃO chegou ao corte', resumo.chegouAoCorte === false && /ATENÇÃO: a leitura NÃO chegou à data de corte/.test(resumo.texto))
  ok('entrega o que conseguiu', resumo.mensagensLidas === 54 && existsSync(resumo.zip))

  // Rodando de novo, com o celular respondendo: continua da mais antiga conhecida.
  const conta2 = contaDeMentira({ historico, grupos: GRUPOS, recentes: 4 })
  const { leitor: leitor2 } = novoLeitor(pasta, conta2)
  const resumo2 = await leitor2.rodar()
  ok('RETOMADA: continua de onde parou, e agora chega ao corte', resumo2.chegouAoCorte === true && conta2.pedidos[0].quandoMs === leitor.maisAntiga().quando)
}

// ══ 6. Quando não dá para começar ═════════════════════════════════════════
{
  const pasta = mkdtempSync(join(tmpdir(), 'teste-leitor-6-'))
  const conta = contaDeMentira({ historico: conversasPessoais(), grupos: GRUPOS })
  const tentar = async (opcoes) => { try { await novoLeitor(mkdtempSync(join(tmpdir(), 'teste-leitor-6x-')), conta, opcoes).leitor.rodar(); return null } catch (e) { return e.message } }

  ok('grupo que não existe: para, dizendo', /Não achei nenhum grupo chamado "Obras Antigas"/.test(await tentar({ nome: 'Obras Antigas' }) ?? ''))

  // O nome não precisa vir igualzinho: maiúsculas, espaços a mais, acento e pontuação não contam.
  for (const escrito of ['  COMPROVANTES   pgto  Obras ', 'comprovantes pgto. obras', 'Comprovantes Pgto Obras']) {
    const c = contaDeMentira({ historico: historiaDoGrupo(CORTE_DIAS + 2), grupos: [{ id: GRUPO, subject: 'Comprovantes Pgto obras' }, GRUPOS[1]], recentes: 200 })
    const l = novoLeitor(mkdtempSync(join(tmpdir(), 'teste-leitor-6n-')), c, { nome: escrito }).leitor
    setTimeout(() => c.sincronizar(), 5)
    let e = null
    try { await l.rodar() } catch (x) { e = x.message }
    ok(`o grupo "Comprovantes Pgto obras" é achado escrevendo "${escrito}"`, e === null && l.grupoId === GRUPO)
  }

  // Não achou: lista os PARECIDOS — e só eles.
  const variosGrupos = [
    { id: '120363000000000011@g.us', subject: 'Comprovantes Pgto obras' },
    { id: '120363000000000012@g.us', subject: 'Comprovantes RH' },
    { id: '120363000000000013@g.us', subject: 'Obras - diário' },
    { id: '120363000000000014@g.us', subject: 'Família Silva' },
    { id: '120363000000000015@g.us', subject: 'Futebol de quinta' },
  ]
  const erroParecidos = await (async () => {
    const c = contaDeMentira({ historico: [], grupos: variosGrupos })
    try { await novoLeitor(mkdtempSync(join(tmpdir(), 'teste-leitor-6p-')), c, { nome: 'Comprovantes pagamento obras' }).leitor.rodar(); return '' } catch (x) { return x.message }
  })()
  ok('nome que não bate: lista os parecidos', /Parecidos nesta conta/.test(erroParecidos)
    && erroParecidos.includes('"Comprovantes Pgto obras"') && erroParecidos.includes('"Comprovantes RH"') && erroParecidos.includes('"Obras - diário"'))
  ok('e NÃO põe na tela os grupos que não têm a ver', !erroParecidos.includes('Família') && !erroParecidos.includes('Futebol'))
  ok('sem mostrar o endereço de nenhum', !erroParecidos.includes('@g.us'))
  const erroSemParecido = await tentar({ nome: 'Xyzw Qwert' })
  ok('sem nenhum parecido, diz isso', /Não há nenhum de nome parecido/.test(erroSemParecido ?? '') && !erroSemParecido.includes('Família'))

  const duplicados = contaDeMentira({ historico: [], grupos: [...GRUPOS, { id: '120363000000000009@g.us', subject: 'COMPROVANTES OBRAS', size: 3 }] })
  const { leitor } = novoLeitor(pasta, duplicados)
  let erro = null
  try { await leitor.rodar() } catch (e) { erro = e.message }
  ok('dois grupos com o mesmo nome: para e lista os dois', /Há 2 grupos chamados/.test(erro ?? '') && erro.includes(GRUPO) && erro.includes('120363000000000009@g.us'))
  ok('sem pedir histórico de nenhum', duplicados.pedidos.length === 0)

  const comId = novoLeitor(mkdtempSync(join(tmpdir(), 'teste-leitor-6y-')), contaDeMentira({ historico: historiaDoGrupo(CORTE_DIAS + 2), grupos: [...GRUPOS, { id: '120363000000000009@g.us', subject: 'Comprovantes Obras' }], recentes: 200 }), { grupoId: GRUPO })
  setTimeout(() => comId.leitor.sock.ev.emit('messaging-history.set', { messages: historiaDoGrupo(1) }), 5)
  let erroComId = null
  try { await comId.leitor.rodar() } catch (e) { erroComId = e.message }
  ok('dizendo qual (--grupo-id), segue', erroComId === null && comId.leitor.grupoId === GRUPO)

  // O grupo existe, mas a sincronização não trouxe nenhuma mensagem dele.
  const calado = contaDeMentira({ historico: conversasPessoais(), grupos: GRUPOS })
  const { leitor: l3 } = novoLeitor(mkdtempSync(join(tmpdir(), 'teste-leitor-6z-')), calado)
  setTimeout(() => calado.sincronizar(), 5)
  let erro3 = null
  try { await l3.rodar() } catch (e) { erro3 = e.message }
  ok('grupo sem mensagem na sincronização: para com explicação e saída', /não veio nenhuma mensagem do grupo/.test(erro3 ?? '') && /Exportar conversa/.test(erro3 ?? ''))
  ok('sem pedir ao dono para escrever no grupo', !/mand(e|ar) (uma|qualquer)/i.test(erro3 ?? ''))
  ok('e sem pedir histórico às cegas', calado.pedidos.length === 0 && calado.violacoes.length === 0)
}

// ══ 7. O ensaio local: do zip ao relatório, sem escrever em lugar nenhum ══
{
  const { createServer } = await import('node:http')
  const { execFile } = await import('node:child_process')
  const pasta = mkdtempSync(join(tmpdir(), 'teste-leitor-7-'))
  const t0 = HOJE - 4 * DIA
  const conta = contaDeMentira({ historico: [
    msg(GRUPO, t0, foto('haia cimento 250')),
    msg(GRUPO, t0 + 60000, foto('compra sem obra 80')),
    msg(GRUPO, HOJE - (CORTE_DIAS + 2) * DIA, texto('antes do corte')),
  ], grupos: GRUPOS, recentes: 50 })
  const { leitor } = novoLeitor(pasta, conta)
  setTimeout(() => conta.sincronizar(), 5)
  await leitor.rodar()

  // O sistema de obras, de mentira: anota tudo que lhe pedem.
  const pedidosAoObras = []
  const obras = createServer((req, res) => {
    pedidosAoObras.push(`${req.method} ${req.url.split('?')[0]}`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(req.url.includes('/lancados') ? { lancados: [] } : { obras: ['EE/ETEC AGUIA DE HAIA'] }))
  })
  await new Promise(r => obras.listen(0, '127.0.0.1', r))

  const saida = await new Promise((resolve) => {
    execFile(process.execPath, ['scripts/ler-grupo-pela-conta.js', 'ensaio', '--saida', join(pasta, 'saida'), '--desde', DESDE], {
      env: {
        ...process.env,
        OBRAS_API_URL: `http://127.0.0.1:${obras.address().port}`, OBRAS_API_TOKEN: 'token-de-teste',
        GEMINI_API_KEY: '', GASTOS_ATRASO_PAUSA_MS: '0', GASTOS_ATRASO: 'on',   // "on" de propósito: o script tem de impor o ensaio
        GASTOS_AUTORIZADOS: '', GASTOS_GRUPOS: '',
      },
      encoding: 'utf8',
    }, (erro, stdout, stderr) => resolve({ codigo: erro?.code ?? 0, texto: `${stdout}\n${stderr}` }))
  })
  obras.close()

  const csv = join(pasta, 'saida', 'grupo-antigo-ensaio.csv')
  if (saida.codigo !== 0) console.log('SAIDA DO ENSAIO:', saida.codigo, saida.texto.slice(-1500))
  ok('o comando "ensaio" roda sobre o zip gerado e termina bem', saida.codigo === 0 && existsSync(csv))
  const relatorio = existsSync(csv) ? readFileSync(csv, 'utf8') : ''
  ok('o relatório sai ao lado do zip, com um destino por comprovante', /"lançaria"/.test(relatorio) && /"perguntaria"/.test(relatorio))
  ok('mesmo com GASTOS_ATRASO=on no ambiente, é ENSAIO', /ENSAIO do grupo antigo/.test(saida.texto) && /Nada foi lançado nem perguntado/.test(saida.texto))
  ok('no sistema de obras, só leitura', pedidosAoObras.length > 0 && pedidosAoObras.every(p => p.startsWith('GET ')))
  ok('e não conecta ao WhatsApp para isso', !/CÓDIGO DE CONEXÃO|conectado na conta/.test(saida.texto))
}

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
