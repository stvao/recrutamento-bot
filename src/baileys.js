/**
 * Conexão com o WhatsApp pelo Baileys.
 *
 * É a via NÃO OFICIAL: o robô se conecta como se fosse mais um aparelho seu,
 * lendo um QR code igual ao WhatsApp Web. Funciona hoje e não custa nada,
 * mas o número pode ser bloqueado pelo WhatsApp — por isso ele nunca deve ser
 * o número principal da empresa.
 *
 * Enquanto a verificação da Meta não sai (1 a 2 semanas), é isto que põe a
 * Maria Vitória no ar. Quando sair, troca-se CONNECTOR=cloud no .env e este
 * arquivo pode ficar como estava, sem mexer no resto.
 *
 * Cuidados que reduzem o risco de bloqueio, e por quê:
 *
 *  - Só responde conversa de UMA pessoa, e os grupos que estiverem em
 *    GASTOS_GRUPOS. Lista de transmissão, status e todo grupo não listado
 *    são ignorados: robô que fala em grupo é o padrão que mais leva a
 *    denúncia, e o robô só tem o que fazer no grupo dos comprovantes.
 *  - Nunca inicia conversa. Só responde quem falou primeiro.
 *  - Espera alguns segundos e mostra "digitando…" antes de responder. Robô
 *    que responde em 200ms é reconhecível por qualquer sistema antifraude.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import * as gastos from './gastos.js'
import { ehConversaPessoal, tipoIgnorado, telefoneDe, numeroDoJid } from './endereco.js'
import { recrutamentoLigado } from './config.js'
import * as observacao from './observacao.js'
import { criarFiltro } from './recebimento.js'
import * as maoHumana from './mao-humana.js'
import { criarAgrupador } from './rajada.js'
import { transcrever, audioDisponivel } from './ia-audio.js'

/** Onde a sessão fica guardada. */
const PASTA_SESSAO = process.env.BAILEYS_SESSAO || join(process.cwd(), 'dados', 'whatsapp')

/**
 * Quanto esperar antes de responder.
 *
 * Uma pessoa do RH não responde no mesmo segundo. O intervalo é sorteado
 * dentro desta faixa para o ritmo não ficar mecânico.
 */
const ESPERA_MIN_MS = Number(process.env.BAILEYS_ESPERA_MIN || 2000)
const ESPERA_MAX_MS = Number(process.env.BAILEYS_ESPERA_MAX || 5000)

let sock = null
let conectado = false

function espera(ms) {
  return new Promise(r => setTimeout(r, ms))
}

/** Espera um tempo variável, proporcional ao tamanho da resposta. */
function tempoDeDigitacao(texto) {
  const base = ESPERA_MIN_MS + Math.random() * (ESPERA_MAX_MS - ESPERA_MIN_MS)
  // ~40ms por caractere, com teto: resposta longa demora mais, mas ninguém
  // espera meio minuto.
  return Math.min(base + texto.length * 40, 12000)
}

/**
 * Os grupos onde o robô tem o que fazer.
 *
 * Só o dos comprovantes. Estar num grupo e ficar calado é o padrão; a
 * exceção é explícita e vem da mesma variável que o módulo de gastos usa,
 * para não haver duas listas divergindo.
 */
const GRUPOS_ATENDIDOS = new Set(
  (process.env.GASTOS_GRUPOS || '').split(',').map(g => g.trim()).filter(Boolean),
)


/**
 * Tira os embrulhos da mensagem.
 *
 * Mensagem temporária, de visualização única e documento com legenda chegam
 * DENTRO de outra mensagem. Sem abrir, o texto não aparecia — e o robô
 * respondia "consigo ler só mensagem de texto" para quem tinha escrito.
 */
function desembrulhar(m) {
  let atual = m
  for (let i = 0; i < 4 && atual; i++) {
    const dentro = atual.ephemeralMessage?.message
      ?? atual.viewOnceMessage?.message
      ?? atual.viewOnceMessageV2?.message
      ?? atual.viewOnceMessageV2Extension?.message
      ?? atual.documentWithCaptionMessage?.message
      ?? null
    if (!dentro) break
    atual = dentro
  }
  return atual
}

/** O texto da mensagem, em qualquer um dos formatos que o WhatsApp usa. */
function textoDaMensagem(msg) {
  const m = desembrulhar(msg.message)
  if (!m) return null
  return m.conversation
    ?? m.extendedTextMessage?.text
    ?? m.imageMessage?.caption
    ?? m.videoMessage?.caption
    ?? m.documentMessage?.caption
    ?? m.buttonsResponseMessage?.selectedDisplayText
    ?? m.listResponseMessage?.title
    ?? null
}

/**
 * Modo descoberta.
 *
 * Ninguém sabe de cabeça o identificador de um grupo do WhatsApp, e sem ele
 * não dá para preencher GASTOS_GRUPOS. Com GASTOS_DESCOBRIR_GRUPOS=1 o robô
 * imprime o identificador de cada grupo em que vê mensagem — é só mandar um
 * "oi" no grupo dos comprovantes, copiar a linha e desligar.
 *
 * Fica desligado por padrão: é diagnóstico, e ligado o tempo todo encheria o
 * log com todo grupo de que o número participa.
 */
const DESCOBRIR = process.env.GASTOS_DESCOBRIR_GRUPOS === '1'
const jaMostrados = new Set()

function mostrarGrupo(jid, msg) {
  if (!DESCOBRIR || jaMostrados.has(jid)) return
  jaMostrados.add(jid)
  console.log(
    `\n[descoberta] grupo "${nomeDoGrupo.get(jid) ?? msg.pushName ?? '?'}" → GASTOS_GRUPOS=${jid}`
    + `\n             quem falou → GASTOS_AUTORIZADOS=${numeroDoJid(msg.key.participant ?? '')}\n`,
  )
}

/**
 * Nome de cada grupo, por identificador.
 *
 * Carregado quando a conexão abre e mantido pelos eventos do WhatsApp. Serve
 * para o GASTOS_GRUPOS poder ser escrito como "Comprovantes" em vez de
 * "120363044...@g.us", que ninguém sabe de cabeça.
 */
const nomeDoGrupo = new Map()

/** Sem acento e sem maiúscula, para comparar com o que está no .env. */
function normalizar(t) {
  return (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim()
}

async function carregarGrupos() {
  try {
    const todos = await sock.groupFetchAllParticipating()
    for (const [jid, info] of Object.entries(todos ?? {})) {
      if (info?.subject) nomeDoGrupo.set(jid, info.subject)
    }
    console.log(`[whatsapp] ${nomeDoGrupo.size} grupo(s) conhecido(s)`)

    // Diz de cara se o grupo configurado foi encontrado. Descobrir que o
    // nome está errado só quando o primeiro comprovante se perde é tarde.
    for (const alvo of GRUPOS_ATENDIDOS) {
      const achado = [...nomeDoGrupo.entries()]
        .find(([jid, nome]) => jid === alvo || normalizar(nome) === normalizar(alvo))
      console.log(achado
        ? `[whatsapp]  grupo "${achado[1]}" encontrado (${achado[0]})`
        : `[whatsapp]  NÃO achei nenhum grupo chamado "${alvo}" — confira o nome em GASTOS_GRUPOS`)
    }
  } catch (e) {
    console.warn('[whatsapp] não consegui listar os grupos:', e.message)
  }
}

/** É um grupo que o robô acompanha? Por identificador OU por nome. */
function ehGrupoAtendido(msg) {
  const jid = msg.key?.remoteJid ?? ''
  if (msg.key?.fromMe) return false
  if (!jid.endsWith('@g.us')) return false
  if (GRUPOS_ATENDIDOS.has(jid) || GRUPOS_ATENDIDOS.has(jid.split('@')[0])) return true

  const nome = nomeDoGrupo.get(jid)
  if (!nome) return false
  const alvo = normalizar(nome)
  return [...GRUPOS_ATENDIDOS].some(g => normalizar(g) === alvo)
}

/**
 * A parte da mensagem que carrega um arquivo, se houver.
 *
 * PDF chega como documentMessage e foto como imageMessage — os dois valem
 * como comprovante. Áudio, vídeo e figurinha não.
 */
function anexoDaMensagem(msg) {
  const m = desembrulhar(msg.message) ?? {}
  const img = m.imageMessage
  if (img) {
    return { tipo: img.mimetype || 'image/jpeg', nome: 'comprovante.jpg', tamanho: Number(img.fileLength ?? 0) }
  }
  const doc = m.documentMessage ?? m.documentWithCaptionMessage?.message?.documentMessage
  if (doc) {
    const tipo = doc.mimetype || ''
    if (tipo.startsWith('image/') || tipo === 'application/pdf') {
      return { tipo, nome: doc.fileName || 'comprovante', tamanho: Number(doc.fileLength ?? 0) }
    }
  }
  return null
}

/**
 * O áudio da mensagem, se houver.
 *
 * Separado do anexo de comprovante de propósito: comprovante é imagem ou
 * PDF, e áudio não serve para o módulo de gastos. Aqui ele serve para
 * conversar — 6% do que chega de candidato é áudio, e quem está na obra fala
 * em vez de digitar.
 */
function audioDaMensagem(msg) {
  const m = desembrulhar(msg.message) ?? {}
  const a = m.audioMessage
  if (!a) return null
  return { tipo: a.mimetype || 'audio/ogg', tamanho: Number(a.fileLength ?? 0) }
}

/**
 * O maior arquivo que vale a pena baixar.
 *
 * Comprovante e foto de cupom ou PDF de nota: alguns MB. O WhatsApp, porem,
 * aceita documento de ate 2 GB, e `baixar` monta o arquivo INTEIRO na
 * memoria antes de qualquer conferencia.
 *
 * Este servidor tem 911 MB e divide a maquina com o sistema de RH. Um PDF
 * grande — de sacanagem ou de engano, tanto faz — derrubaria os dois, e o
 * RH nao tem nada a ver com o assunto. Vinte e cinco megas cobre com folga
 * qualquer comprovante de verdade.
 */
const MAX_ARQUIVO_BYTES = Number(process.env.GASTOS_MAX_ARQUIVO_MB || 25) * 1024 * 1024

/**
 * A mensagem que esta está CITANDO, se houver.
 *
 * É o que permite responder fora de ordem: com três comprovantes esperando,
 * citar a foto (ou a pergunta do robô) diz sozinho a qual deles a resposta
 * pertence. Sem isso a resposta só pode valer para o último, e quem manda
 * vários fica preso a uma sequência.
 */
function citada(msg) {
  const m = msg.message ?? {}
  const contexto = m.extendedTextMessage?.contextInfo
    ?? m.imageMessage?.contextInfo
    ?? m.documentMessage?.contextInfo
    ?? m.conversation?.contextInfo
  return contexto?.stanzaId ?? null
}


/**
 * Abre a conexão.
 *
 * `aoReceber(numero, texto)` deve devolver o texto da resposta (ou nada).
 */
export async function conectar(aoReceber) {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } =
    await import('@whiskeysockets/baileys')

  if (!existsSync(PASTA_SESSAO)) mkdirSync(PASTA_SESSAO, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    // O Baileys é falante demais no nível padrão; só o que importa aparece.
    logger: pino({ level: 'error' }),
    // Marcar-se como online o tempo todo faz o celular da pessoa parar de
    // receber notificação das mensagens — e ela reclama que "não chega nada".
    markOnlineOnConnect: false,
    browser: ['Nova Gestão RH', 'Chrome', '1.0.0'],
  })

  sock.ev.on('creds.update', saveCreds)

  // Grupo renomeado, ou o robô adicionado num grupo novo: o nome muda depois
  // da carga inicial, e sem isto ele pararia de reconhecer o grupo certo.
  sock.ev.on('groups.update', (novidades) => {
    for (const g of novidades ?? []) {
      if (g?.id && g?.subject) nomeDoGrupo.set(g.id, g.subject)
    }
  })
  sock.ev.on('groups.upsert', (novos) => {
    for (const g of novos ?? []) {
      if (g?.id && g?.subject) nomeDoGrupo.set(g.id, g.subject)
    }
  })

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u

    if (qr) {
      console.log('\n Leia este QR code no WhatsApp do número do robô:')
      console.log('   WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho\n')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'open') {
      conectado = true
      const meu = numeroDoJid(sock.user?.id)
      console.log(`\n WhatsApp conectado no número ${meu}. A Maria Vitória está atendendo.\n`)
      carregarGrupos()
    }

    if (connection === 'close') {
      conectado = false
      const motivo = lastDisconnect?.error?.output?.statusCode

      // Sessão encerrada de propósito (desconectado no celular) — reconectar
      // em laço só geraria erro infinito. Precisa ler o QR de novo.
      if (motivo === DisconnectReason.loggedOut) {
        console.error(
          '\n A sessão foi encerrada no celular.\n'
          + `   Apague a pasta ${PASTA_SESSAO} e rode de novo para ler outro QR code.\n`,
        )
        return
      }

      console.warn(`[whatsapp] conexão caiu (${motivo ?? 'motivo desconhecido'}) — reconectando em 5s…`)
      setTimeout(() => conectar(aoReceber), 5000)
    }
  })

  // Um filtro por conexão: lembra o que já foi atendido (ver recebimento.js).
  const deveAtender = criarFiltro()

  // Espera a pessoa terminar de escrever antes de responder (ver rajada.js).
  const agrupar = criarAgrupador()

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' é o que chega agora; 'append' inclui o que chegou com o robô
    // FORA DO AR. Antes o 'append' era descartado inteiro, e o comprovante
    // mandado no grupo durante um reinício sumia. Quem decide o que entra é
    // o recebimento.js: só mensagem de verdade, recente, e uma vez só.
    if (type !== 'notify' && type !== 'append') return

    for (const msg of messages) {
      const { atender, foraDoAr } = deveAtender(msg, type)
      if (!atender) continue

      // Olha ANTES de qualquer filtro: as respostas do dono, digitadas no
      // celular, chegam como mensagens "minhas", e o filtro abaixo as
      // descarta. São justamente elas que ensinam como responder.
      await observar(msg, type)

      /*
        Gente da empresa respondeu: daqui em diante o robô cala nesta conversa.
        Fora da observação de propósito — a regra vale com OBSERVAR desligado.
      */
      if (ehMaoDaEmpresa(msg, type)) {
        const { numero } = await telefoneDe(msg, { lidMapping: sock?.signalRepository?.lidMapping })
        maoHumana.gentesRespondeu(numero, msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now())
      }

      const pessoal = ehConversaPessoal(msg)
      const grupo = !pessoal && ehGrupoAtendido(msg)

      // Endereço de um tipo que o robô não atende: registra. Foi o descarte
      // calado que escondeu por dias as conversas que chegavam como @lid.
      const ignorado = tipoIgnorado(msg)
      if (ignorado) console.warn(`[whatsapp] mensagem ignorada — endereço do tipo "${ignorado}"`)

      if (!pessoal && !grupo) {
        if (!msg.key?.fromMe && (msg.key?.remoteJid ?? '').endsWith('@g.us')) {
          mostrarGrupo(msg.key.remoteJid, msg)
        }
        continue
      }

      const jid = msg.key.remoteJid
      const texto = textoDaMensagem(msg)
      if (foraDoAr) {
        console.log(`[whatsapp] mensagem que chegou com o robô fora do ar — atendendo agora (${grupo ? 'grupo' : 'privado'})`)
      }
      const anexo = anexoDaMensagem(msg)

      // Num grupo, quem falou é o participante — remoteJid é o grupo. Sem
      // isso a lista de autorizados compararia com o id do grupo, e nunca
      // ninguém passaria.
      //
      // E o endereço pode ser @lid, que esconde o telefone: o número de
      // verdade vem do campo alternativo ou do mapa da sessão. É ele que acha
      // a pessoa no RH. A resposta continua indo para `jid`, o endereço
      // original — responder para um @lid funciona.
      const { numero: de, telefoneConhecido } = await telefoneDe(msg, {
        grupo,
        lidMapping: sock.signalRepository?.lidMapping,
      })
      if (pessoal && !telefoneConhecido) {
        console.warn(`[whatsapp] conversa @lid sem telefone conhecido — atendendo pelo identificador`)
      }

      /*
        Este arquivo vai servir para alguma coisa?

        Em grupo cadastrado, comprovante é o propósito do lugar. No privado,
        quem lança gasto é só quem está na lista explícita — para todo o
        resto, arquivo não serve para nada: a Maria Vitória lê texto.

        Antes o arquivo era baixado sempre, inclusive o de quem nunca
        poderia lançá-lo. Era memória e banda gastas para jogar fora, e um
        desconhecido conseguia fazê-lo de propósito, quantas vezes quisesse.

        A pergunta é respondida aqui em cima porque a resposta muda duas
        coisas: se vale a pena baixar, e o que dizer a quem mandou.
      */
      // No privado, com o recrutamento ligado, o arquivo também serve: é o
      // currículo, a carteira de trabalho ou o documento do candidato.
      const vaiServir = Boolean(anexo) && (grupo || gastos.autorizado(de, false) || recrutamentoLigado())

      /*
        Áudio: ouve, em vez de mandar a pessoa digitar.

        A transcrição entra na conversa como se ela tivesse escrito — quem
        conduz continua sendo o mesmo cérebro, com as mesmas regras.
      */
      let doAudio = null
      const audio = pessoal && !texto?.trim() ? audioDaMensagem(msg) : null
      if (audio && audioDisponivel() && recrutamentoLigado()) {
        const bytes = await baixar(msg, audio.tamanho)
        if (bytes) doAudio = await transcrever({ arquivo: bytes, tipo: audio.tipo })
        console.log(doAudio
          ? `[whatsapp] áudio ouvido (${doAudio.length} caracteres)`
          : '[whatsapp] não consegui ouvir o áudio')
      }

      if (pessoal && !vaiServir && !texto?.trim() && !doAudio) {
        /*
          Sem texto: só o ÁUDIO que não deu para ouvir recebe resposta.

          Antes qualquer coisa sem texto recebia "consigo ler só mensagem de
          texto". Em 12/09/2026 foram 89 vezes — 53 delas logo depois de a
          pessoa ter escrito, porque o que disparava a frase era uma reação,
          uma mensagem apagada ou editada, que chegam como evento sem texto.
          Para quem escreveu, o robô parecia não ter lido nada.

          Foto, vídeo, documento, figurinha e contato ficam sem resposta
          automática: a conversa segue na próxima mensagem de texto.
        */
        /*
          O áudio que não deu para ouvir vai para o ROTEADOR, marcado.

          Respondendo aqui, a frase saía por fora de todas as regras: ia para
          funcionário, para quem está cobrando pagamento e para conversa em
          que uma pessoa da empresa já assumiu.
        */
        if (audio) {
          const resposta = await aoReceber({
            canal: 'whatsapp', de, chat: de, ehGrupo: false, texto: null,
            jidOriginal: jid, audioIlegivel: true,
            idMensagem: msg.key.id,
            enviadoEm: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
          }).catch(e => {
            console.error('[whatsapp] erro ao atender áudio ilegível:', e.message)
            return null
          })
          if (resposta) await responder(jid, resposta)
        }
        continue
      }

      try {
        const arquivo = vaiServir ? await baixar(msg, anexo.tamanho) : null

        /*
          Na conversa com uma pessoa, espera a rajada terminar.

          Ninguém escreve um parágrafo no WhatsApp: escreve em pedaços. Sem
          isto o robô responde CADA pedaço — um candidato mandou o telefone,
          o nome e "minha filha" em dez segundos e recebeu a mesma frase de
          encerramento três vezes.

          No grupo de comprovantes, não: lá cada foto é um lançamento, e
          juntar duas seria pior que responder duas vezes.
        */
        let textoAtendido = texto?.trim() || doAudio || null
        if (!grupo && textoAtendido && !arquivo) {
          textoAtendido = await agrupar(jid, textoAtendido)
          if (textoAtendido === null) continue
        }

        const resposta = await aoReceber({
          canal: 'whatsapp',
          de,
          chat: grupo ? jid : de,
          // O endereço ORIGINAL desta conversa. Em @lid sem telefone conhecido,
          // `de` são os dígitos do LID — um número que não existe. É por este
          // jid que o lembrete de 24h e o pedido de documentos chegam.
          jidOriginal: pessoal ? jid : null,
          chatNome: grupo ? (nomeDoGrupo.get(jid) ?? null) : null,
          ehGrupo: grupo,
          texto: textoAtendido,
          arquivo,
          tipo: anexo?.tipo ?? null,
          nomeArquivo: anexo?.nome ?? null,
          // Id da mensagem do WhatsApp: é o que garante a idempotência do
          // envio ao sistema de obras, e é estável entre reentregas.
          idMensagem: msg.key.id,
          // Quando a mensagem foi enviada — é esta a data do lançamento, e
          // não a que a IA leu no papel. Vem em segundos, não milissegundos.
          enviadoEm: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
          // Como falar com esta conversa fora da resposta a uma mensagem.
          // O módulo de gastos precisa disso para avisar quando o prazo de
          // uma pergunta estoura — meia hora depois, sem nada a que responder.
          enviarResposta: (t) => responder(jid, t, { citar: grupo ? msg : null, rapido: grupo }),
          // A qual mensagem esta responde — a foto, ou a pergunta do robô.
          respondendoA: citada(msg),
        })
        // Em grupo, responde citando a mensagem: com várias pessoas mandando
        // comprovante junto, confirmação solta não diz de qual foto é.
        if (resposta) await responder(jid, resposta, { citar: grupo ? msg : null, rapido: grupo })
      } catch (e) {
        console.error('[whatsapp] erro ao atender:', e.message)
        if (pessoal && recrutamentoLigado()) await responder(jid, 'Tive um probleminha aqui no sistema. Pode repetir, por favor?')
      }
    }
  })

  return sock
}

/**
 * Baixa o arquivo da mensagem.
 *
 * Devolve null se não der: o comprovante não chega ao sistema de obras, mas
 * a conexão não cai e as outras mensagens seguem sendo atendidas.
 */
async function baixar(msg, tamanhoDeclarado = 0) {
  // Recusa ANTES de baixar, pelo tamanho que a propria mensagem declara.
  // Conferir depois nao adianta: o estrago da memoria ja aconteceu.
  if (tamanhoDeclarado > MAX_ARQUIVO_BYTES) {
    const mb = (tamanhoDeclarado / 1024 / 1024).toFixed(0)
    console.warn(`[whatsapp] arquivo de ${mb} MB recusado sem baixar (limite ${MAX_ARQUIVO_BYTES / 1024 / 1024} MB)`)
    return null
  }

  try {
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys')

    // Baixa em fluxo e conta os bytes na chegada.
    //
    // O tamanho declarado acima é só uma promessa de quem enviou: nada impede
    // declarar 1 KB e mandar 2 GB. Baixando para um buffer, a checagem
    // posterior só constata o estrago — a memória já foi consumida, e neste
    // servidor de 911 MB isso derruba o robô E o sistema de RH, que divide a
    // máquina e não tem nada a ver com o assunto.
    //
    // Em fluxo, o download é abortado no primeiro byte que passa do limite.
    const fluxo = await downloadMediaMessage(msg, 'stream', {}, {
      logger: pino({ level: 'error' }),
      reuploadRequest: sock.updateMediaMessage,
    })

    const pedacos = []
    let recebidos = 0
    for await (const pedaco of fluxo) {
      recebidos += pedaco.length
      if (recebidos > MAX_ARQUIVO_BYTES) {
        fluxo.destroy()
        console.warn(
          `[whatsapp] download abortado ao passar de ${MAX_ARQUIVO_BYTES / 1024 / 1024} MB `
          + `(declarado: ${(tamanhoDeclarado / 1024 / 1024).toFixed(1)} MB)`,
        )
        return null
      }
      pedacos.push(pedaco)
    }

    const buffer = Buffer.concat(pedacos)
    return buffer.length ? buffer : null
  } catch (e) {
    console.error('[whatsapp] não consegui baixar o arquivo:', e.message)
    return null
  }
}

/** Conversa privada com uma pessoa — telefone ou @lid. */
const ehPrivado = (jid) => typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))

/**
 * É gente da empresa respondendo pelo celular?
 *
 * A marca de "mão humana" vivia DENTRO de observar(), que sai fora quando
 * OBSERVAR=off — e a observação é da fase de aprendizado, feita para ser
 * desligada. Desligada, o dono respondia o candidato e o robô continuava
 * falando por cima: foi o incidente de 12/09/2026.
 *
 * Aqui não se exige tipo de mensagem: figurinha, foto e áudio do dono também
 * significam que uma pessoa assumiu a conversa. O eco do que o robô mandou
 * chega como 'append' e é descartado.
 */
export function ehMaoDaEmpresa(msg, type = 'notify') {
  if (!msg?.key?.fromMe) return false
  if (type === 'append') return false
  if (!ehPrivado(msg.key.remoteJid)) return false
  return !observacao.foiORobo(msg.key.id)
}

/**
 * Anota a mensagem privada, dos dois lados, para o robô aprender.
 *
 * Nunca lança: observar é secundário, e um erro aqui não pode impedir a
 * mensagem de ser atendida.
 */
async function observar(msg, type = 'notify') {
  try {
    if (!observacao.ligado()) return
    // O eco do que o próprio robô enviou chega como 'append', e ANTES de ele
    // ter marcado a mensagem como dele. Sem isto, a observação gravaria a
    // resposta do robô como se fosse do dono. As respostas do dono chegam
    // como 'notify'; o que se perde é só a que ele digitou com o robô fora.
    if (msg.key?.fromMe && type === 'append') return
    const jid = msg.key?.remoteJid
    if (!ehPrivado(jid)) return
    const tipo = observacao.tipoDe(msg.message)
    if (!tipo) return

    const autor = !msg.key.fromMe ? 'candidato'
      : observacao.foiORobo(msg.key.id) ? 'robo' : 'empresa'
    // O robô já anotou o que ele mesmo mandou, na hora de enviar.
    if (autor === 'robo') return

    const { numero, telefoneConhecido } = await telefoneDe(msg, {
      lidMapping: sock?.signalRepository?.lidMapping,
    })
    const em = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()

    observacao.anotar({
      chave: jid,
      final: telefoneConhecido ? numero : null,
      autor,
      tipo,
      texto: textoDaMensagem(msg),
      em,
    })
  } catch (e) {
    console.error('[observacao] falhou ao olhar a mensagem:', e.message)
  }
}

/** Envia, com a pausa e o "digitando…" que fazem parecer gente. */
/**
 * O que o robô acabou de dizer em cada conversa.
 *
 * Rede de segurança contra repetição: duas mensagens iguais seguidas, no
 * mesmo minuto, nunca são intenção — são duas entregas do mesmo raciocínio.
 * No grupo de comprovantes NÃO vale: lá duas fotos iguais geram, de
 * propósito, duas confirmações iguais.
 */
const ultimaFalada = new Map()
const REPETICAO_MS = 120_000

function jaFalouIgual(jid, texto, agora = Date.now()) {
  if (jid.endsWith('@g.us')) return false
  const anterior = ultimaFalada.get(jid)
  if (anterior && anterior.texto === texto && agora - anterior.em < REPETICAO_MS) return true
  ultimaFalada.set(jid, { texto, em: agora })
  if (ultimaFalada.size > 2000) ultimaFalada.delete(ultimaFalada.keys().next().value)
  return false
}

async function responder(jid, texto, { citar = null, rapido = false } = {}) {
  if (!sock) return { ok: false }
  if (jaFalouIgual(jid, texto)) {
    console.log('[whatsapp] mesma frase de novo no mesmo minuto — não repeti.')
    return { ok: true, id: null, repetida: true }
  }
  try {
    // A pausa existe para o robô não se denunciar na conversa com candidato.
    // No grupo interno todo mundo sabe que é robô, e demorar 10 segundos
    // para confirmar um comprovante só atrapalha quem está mandando vinte.
    if (!rapido) {
      await sock.presenceSubscribe(jid)
      await sock.sendPresenceUpdate('composing', jid)
      await espera(tempoDeDigitacao(texto))
      await sock.sendPresenceUpdate('paused', jid)
    }
    // O id do que ACABOU de sair importa: é por ele que a pessoa vai citar a
    // pergunta ao responder, e é assim que o robô sabe de qual comprovante
    // ela está falando.
    const enviada = await sock.sendMessage(jid, { text: texto }, citar ? { quoted: citar } : {})

    // Anota o que o robô disse no privado, e marca o id: a mesma mensagem
    // pode voltar como "minha", e não pode ser confundida com o dono.
    observacao.marcarDoRobo(enviada?.key?.id)
    if (ehPrivado(jid)) observacao.anotar({ chave: jid, autor: 'robo', tipo: 'texto', texto })

    return { ok: true, id: enviada?.key?.id ?? null }
  } catch (e) {
    console.error('[whatsapp] não consegui enviar:', e.message)
    return { ok: false, erro: e.message }
  }
}

/** Envio avulso, para o resto do serviço usar. */
export async function enviarPorBaileys(numero, texto) {
  const jid = numero.includes('@') ? numero : `${numero.replace(/\D/g, '')}@s.whatsapp.net`
  return responder(jid, texto)
}

export function estaConectado() {
  return conectado
}
