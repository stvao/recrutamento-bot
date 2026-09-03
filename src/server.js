/**
 * Serviço do robô de recrutamento (WhatsApp) — separado do sistema RH.
 * Fluxo: WhatsApp → /webhook → cérebro → resposta no WhatsApp; ao concluir,
 * envia a candidatura para o RH (/api/integracao/candidatura).
 *
 * Rotas:
 *   GET  /health     — status
 *   GET  /webhook    — verificação do webhook (Cloud API oficial)
 *   POST /webhook    — mensagens recebidas do WhatsApp
 *   POST /simular    — testar a conversa sem WhatsApp (usado pelo simulador do RH)
 */
import express from 'express'
import { iniciarAtendimento as iniciar, atender } from './atendimento.js'
import { iaDisponivel } from './ia.js'
import {
  getEstado, setEstado, limpar, getAbandonada,
  marcarConcluida, marcarEscalada, metricas,
} from './store.js'
import { getVagas, origemDaLista, intervaloDeAtualizacao } from './catalogo.js'
import { enviarMensagem, parseWebhook, baixarMidiaCloud } from './connectors.js'
import { enviarCandidatura, avisarRH } from './rh-client.js'
import * as gastos from './gastos.js'

const app = express()
app.use(express.json({ limit: '1mb' }))

/**
 * O recrutamento está ligado?
 *
 * Existe porque os dois módulos dividem o mesmo número, e há situação em que
 * só um deles deve responder. A que motivou isto: o robô rodando na máquina
 * de quem cuida dos gastos, sem alcançar o RH — a Maria Vitória atendia o
 * candidato normalmente e a candidatura não era registrada em lugar nenhum.
 * A pessoa saía achando que tinha se candidatado.
 *
 * Ligado por padrão: quem não configurou nada tem o comportamento de sempre.
 */
const RECRUTAMENTO_LIGADO = (process.env.RECRUTAMENTO ?? 'on').toLowerCase() !== 'off'


app.get('/health', (_req, res) => res.json({ ok: true, servico: 'recrutamento-bot' }))

/**
 * Números da operação.
 *
 * A taxa de conclusão é o indicador que diz se o roteiro está funcionando,
 * e `abandonaramNaEtapa` diz ONDE as pessoas desistem — que é o que aponta
 * qual pergunta rever.
 */
app.get('/metricas', (_req, res) => res.json({
  ...metricas(),
  vagas: origemDaLista(),
  atendente: iaDisponivel() ? 'Maria Vitória (IA)' : 'roteiro',
  gastos: gastos.situacao(),
}))

/**
 * Mantém a lista de vagas fresca em segundo plano.
 *
 * O cérebro lê a lista de forma síncrona, a cada mensagem — buscar no RH ali
 * acrescentaria a latência da rede a toda frase da conversa. Então a busca
 * acontece aqui: uma vez ao subir, e de tempos em tempos depois.
 *
 * Falha não derruba nada: getVagas() nunca lança, e na pior hipótese o robô
 * atende com a lista de reserva (que não tem salário, de propósito).
 */
let ultimaOrigem = null
async function atualizarVagas() {
  await getVagas()
  const origem = origemDaLista()
  // Só registra quando MUDA: insistindo de minuto em minuto, repetir a mesma
  // linha encheria o log e esconderia o que importa.
  if (origem !== ultimaOrigem) {
    console.log(`[vagas] lista carregada de: ${origem}`)
    ultimaOrigem = origem
  }
  setTimeout(atualizarVagas, intervaloDeAtualizacao()).unref?.()
}
atualizarVagas()
if (!RECRUTAMENTO_LIGADO) {
  console.log('[atendimento] recrutamento DESLIGADO (RECRUTAMENTO=off) — só o módulo de gastos responde.')
} else {
  console.log(iaDisponivel()
    ? '[atendimento] Maria Vitória no ar (com queda para o roteiro)'
    : '[atendimento] sem GEMINI_API_KEY — atendendo pelo roteiro')

  /*
    Confere o RH ANTES de alguém escrever.

    Sem isto o problema só aparecia no log de uma linha ("[vagas] não
    consegui falar com o RH") no meio do arranque, e o robô seguia atendendo
    candidato sem ter onde gravar a ficha. Quem escreve conversa, responde
    tudo, e a candidatura não existe em lugar nenhum.
  */
  const rhUrl = process.env.RH_API_URL || ''
  fetch(`${rhUrl}/api/integracao/vagas`, {
    headers: { Authorization: `Bearer ${process.env.RH_API_TOKEN || ''}` },
    signal: AbortSignal.timeout(8000),
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    console.log(`[atendimento] RH respondendo em ${rhUrl}`)
  }).catch((e) => {
    console.error(
      `\n⚠️  O RECRUTAMENTO ESTÁ LIGADO E O RH NÃO RESPONDE (${rhUrl}: ${e.message}).\n`
      + '   A Maria Vitória vai atender quem escrever, e a CANDIDATURA NÃO SERÁ\n'
      + '   REGISTRADA — a pessoa sai achando que se candidatou.\n\n'
      + '   Aponte RH_API_URL para o servidor do RH, ou desligue o recrutamento\n'
      + '   com RECRUTAMENTO=off enquanto só o módulo de gastos estiver em uso.\n',
    )
  })
}

// Verificação do webhook (WhatsApp Cloud API oficial)
app.get('/webhook', (req, res) => {
  const verify = process.env.CLOUD_VERIFY_TOKEN
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verify) {
    return res.status(200).send(req.query['hub.challenge'])
  }
  return res.sendStatus(403)
})

/**
 * Segredo do webhook.
 *
 * O endereço fica aberto na internet, e a Z-API não assina as requisições
 * que envia — não há como distinguir uma mensagem dela de uma forjada. Sem
 * proteção, quem descobrisse a URL criaria candidaturas falsas em nome de
 * qualquer número, e o RH ligaria para gente que nunca se candidatou.
 *
 * A proteção possível para um provedor que não assina é um segredo na
 * própria URL: o painel da Z-API aceita qualquer endereço, então cadastra-se
 * .../webhook/<segredo>. Quem não sabe o segredo não passa.
 */
const WEBHOOK_SEGREDO = process.env.WEBHOOK_SEGREDO || ''

if (!WEBHOOK_SEGREDO) {
  console.warn(
    '[webhook] SEM WEBHOOK_SEGREDO: qualquer um que descobrir a URL pode '
    + 'criar candidatura falsa. Defina antes de expor o serviço na internet.',
  )
}

async function tratarWebhook(req, res) {
  if (WEBHOOK_SEGREDO && req.params.segredo !== WEBHOOK_SEGREDO) {
    return res.sendStatus(404)   // 404, e não 403: não confirma que existe
  }
  res.sendStatus(200) // responde rápido; processa em seguida

  const msg = parseWebhook(req.body)
  if (!msg) return
  try {
    // O download da mídia acontece DEPOIS do 200 acima, de propósito: a Meta
    // reentrega o webhook que demora a responder, e baixar um PDF de 15 MB
    // antes de responder viraria a mesma mensagem chegando várias vezes.
    if (msg.mediaId) msg.arquivo = await baixarMidiaCloud(msg.mediaId)

    // Como falar com quem enviou fora da resposta imediata — o módulo de
    // gastos usa isso quando o prazo de uma pergunta estoura.
    msg.enviarResposta = (t) => enviarMensagem(msg.de, t)

    const resposta = await rotear(msg)
    if (resposta) await enviarMensagem(msg.de, resposta)
  } catch (e) {
    console.error('[webhook] erro:', e.message)
  }
}

// Mensagens recebidas do WhatsApp
app.post('/webhook/:segredo', tratarWebhook)
// Sem segredo — só funciona quando WEBHOOK_SEGREDO não está definido.
app.post('/webhook', tratarWebhook)

/**
 * O simulador é server-to-server, e precisa provar que é.
 *
 * A rota não tinha proteção nenhuma. O RH confere a sessão do lado dele,
 * mas o robô aceitava qualquer um: quem alcançasse a porta conduzia
 * conversas — gastando a cota do modelo — e, com `persistir: true`, criava
 * CANDIDATURA no RH em nome de qualquer telefone. O mesmo buraco que o
 * WEBHOOK_SEGREDO fecha no webhook estava aberto aqui do lado.
 *
 * Duas provas, e basta uma:
 *
 *  - vir da própria máquina. O RH chama em http://localhost:3100, e é o
 *    caso normal em produção;
 *  - trazer o RH_API_TOKEN, que já é o segredo compartilhado entre os dois.
 *
 * Aceitar o localhost mantém o simulador funcionando sem mexer no RH — mas
 * o RH manda o token de qualquer forma, para o dia em que os dois estiverem
 * em máquinas diferentes.
 */
function ehDaPropriaMaquina(req) {
  const ip = req.socket?.remoteAddress ?? ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

function simuladorAutorizado(req) {
  if (ehDaPropriaMaquina(req)) return true
  const token = process.env.RH_API_TOKEN || ''
  if (!token) return false
  const cabecalho = req.headers.authorization ?? ''
  return cabecalho.startsWith('Bearer ') && cabecalho.slice(7).trim() === token
}

// Simulador (sem WhatsApp) — mesma lógica, retorna o texto na resposta HTTP
app.post('/simular', async (req, res) => {
  if (!simuladorAutorizado(req)) {
    console.warn(`[simular] recusado — veio de ${req.socket?.remoteAddress} sem token.`)
    return res.sendStatus(404)   // 404, e não 403: não confirma que existe
  }

  const { estado, mensagem, whatsapp, persistir } = req.body || {}
  if (!estado) return res.json(iniciar(whatsapp))
  const r = await atender(estado, mensagem || '')
  let protocolo = null
  let registroOk = null
  if (persistir && r.acao?.tipo === 'criar_candidatura') {
    const env = await enviarCandidatura(r.acao.dados)
    registroOk = env.ok
    protocolo = env.protocolo || null
    if (!env.ok && r.respostaFalha) r.resposta = r.respostaFalha
  }
  res.json({ ...r, protocolo, registroOk })
})

/** "há 3 horas", "há 2 dias" — para a mensagem de retomada soar natural. */
function tempoDecorrido(ms) {
  const horas = Math.round(ms / 3600000)
  if (horas < 24) return `há ${horas} hora${horas === 1 ? '' : 's'}`
  const dias = Math.round(horas / 24)
  return `há ${dias} dia${dias === 1 ? '' : 's'}`
}

/**
 * Quem atende esta mensagem.
 *
 * O robô tem dois módulos, e a regra de qual atende é de SEGURANÇA, não de
 * organização: sem ela, quem descobrir o número manda uma foto e cria
 * lançamento no financeiro da empresa.
 *
 * Por isso a ordem é esta. Primeiro pergunta-se se o remetente está na lista
 * de autorizados a lançar gasto; só quem está entra no módulo de gastos.
 * Todo o resto — que é a esmagadora maioria — vai para o recrutamento, como
 * sempre foi.
 *
 * Mensagem de grupo nunca chega ao recrutamento. A Maria Vitória conversa
 * com um candidato por vez, e não teria o que fazer num grupo de trabalho.
 */
async function rotear(msg) {
  const daOrigemCerta = gastos.origemAceita(msg.chat, msg.chatNome)
  const podeLancar = daOrigemCerta && gastos.autorizado(msg.de, daOrigemCerta && Boolean(msg.ehGrupo))

  if (podeLancar && (msg.arquivo || msg.ehGrupo)) {
    return gastos.tratar(msg)
  }

  if (msg.ehGrupo) return null

  // Recrutamento desligado: fica calado em vez de atender e perder a ficha.
  //
  // Calado, e não "estamos fora do ar": o número pode estar em anúncio, e
  // uma resposta automática dizendo que o sistema caiu é pior para a empresa
  // do que nenhuma resposta — quem não recebe resposta liga; quem recebe
  // "estamos com problema" desiste.
  if (!RECRUTAMENTO_LIGADO) {
    console.log(`[recrutamento] desligado — ignorando mensagem de ${msg.de}`)
    return null
  }

  // Arquivo de candidato: ela não lê, mas ficar muda faz a pessoa achar que
  // não chegou.
  if (msg.arquivo && !msg.texto) {
    return 'Recebi seu arquivo, mas aqui eu consigo ler só texto. Pode escrever pra mim? 🙂'
  }
  if (!msg.texto) return null

  return processar(msg.de, msg.texto)
}

/**
 * Trata o resultado de uma mensagem: escalada, registro no RH, resposta.
 *
 * Vive separado porque há DOIS caminhos que produzem um resultado — a
 * conversa normal e a retomada de quem sumiu e voltou. O da retomada só
 * gravava o estado e devolvia o texto: se a pessoa completasse nome, vaga e
 * cidade justamente na mensagem de volta, a `acao` era descartada e a
 * candidatura nunca chegava ao RH. Com um caminho só, não dá para um deles
 * esquecer o que o outro faz.
 */
async function aplicarResultado(from, r, text) {
  setEstado(from, r.estado)

  if (r.escalarHumano) {
    marcarEscalada(from)
    console.log(`[ATENDIMENTO HUMANO] ${from}: ${r.motivoEscalada ?? 'pediu atendimento'} — "${text}"`)
    // Sem await: o candidato não espera o RH ser avisado para receber a
    // resposta dele. Se o aviso falhar, avisarRH() registra e segue.
    avisarRH({ whatsapp: from, motivo: r.motivoEscalada, trecho: text })
  }

  if (r.acao?.tipo === 'criar_candidatura') {
    const env = await enviarCandidatura(r.acao.dados)
    if (env.ok) {
      // A conversa NÃO é encerrada aqui.
      //
      // A candidatura é gravada assim que há nome, vaga e cidade, e a Maria
      // Vitória segue perguntando o resto da ficha — endereço, disponibilidade,
      // tamanho de bota. Limpar no primeiro registro descartaria tudo que
      // viesse depois, que é justamente a parte que o RH usa para decidir.
      // Cada dado novo reenvia, e o RH atualiza a mesma candidatura.
      //
      // Marcar a conclusão na PRIMEIRA gravação é o que diferencia "concluiu"
      // de "abandonou" nas métricas; sem isso, toda conclusão viraria abandono
      // quando a conversa expirasse sozinha.
      if (r.acao.primeiraVez) marcarConcluida(from)
      return r.resposta
    }
    console.warn('[processar] candidatura não registrada:', env)
    // mantém o estado p/ permitir nova tentativa; resposta honesta de falha
    return r.respostaFalha || r.resposta
  }
  return r.resposta
}

/** Conduz a conversa de um número e devolve o texto de resposta. */
async function processar(from, text) {
  const estado = getEstado(from)

  if (!estado) {
    // Quem parou no meio e voltou continua de onde estava.
    //
    // Recomeçar do zero é a razão mais comum de desistência na segunda
    // tentativa: a pessoa já respondeu vaga e cidade, some por um dia, e o
    // robô pergunta tudo outra vez. Aqui ela só responde o que falta.
    const pendente = getAbandonada(from)
    if (pendente) {
      setEstado(from, pendente.estado)
      const r = await atender(pendente.estado, text)
      const resposta = await aplicarResultado(from, r, text)
      return `Oi de novo! 👋 Vi que você começou uma candidatura ${tempoDecorrido(pendente.paradoHa)} `
        + `e parou no meio — dá para continuar de onde estava.
`
        + `(se preferir começar de novo, é só escrever *recomeçar*)

`
        + resposta
    }

    const ini = iniciar(from)
    setEstado(from, ini.estado)
    return ini.resposta
  }

  return aplicarResultado(from, await atender(estado, text), text)
}

/**
 * Conexão com o WhatsApp pelo Baileys.
 *
 * Só sobe quando CONNECTOR=baileys. Sem isso o serviço continua atendendo
 * pelo simulador, como até agora — quem não configurou não é surpreendido
 * por um QR code aparecendo no terminal.
 */
if (process.env.CONNECTOR === 'baileys') {
  const { conectar } = await import('./baileys.js')
  conectar(rotear)
    .catch(e => console.error('[whatsapp] não consegui conectar:', e.message))
}

/**
 * Conexão com o Telegram.
 *
 * Sobe em PARALELO ao WhatsApp, não no lugar dele. Os dois canais servem a
 * públicos diferentes: candidato está no WhatsApp e não vai instalar outro
 * aplicativo para se candidatar; o grupo dos comprovantes é de gente da casa,
 * e ali o Telegram lê grupo sem risco de bloquear número nenhum.
 */
if (process.env.TELEGRAM_TOKEN) {
  const { conectar: conectarTelegram } = await import('./telegram.js')
  conectarTelegram(rotear)
    .catch(e => console.error('[telegram] não consegui conectar:', e.message))
}

/*
  Relê o que ficou esperando e liga a ronda que cobra quem sumiu.

  Vem antes do aviso abaixo de propósito: se houver comprovante recuperado
  do disco, a linha de recuperação aparece junto com a de estado, e fica
  claro que o robô subiu com trabalho pendente.
*/
gastos.iniciarRonda()

// Fechamento do dia no grupo dos comprovantes. Desligado por padrão — uma
// mensagem automática diária é decisão de quem usa, não do código.
const { agendar: agendarResumo } = await import('./resumo-diario.js')
agendarResumo()

if (gastos.gastosAtivo()) {
  const s = gastos.situacao()
  console.log(
    `[gastos] no ar — quem pode lançar: ${s.quemPodeLancar}`
    + ` | origem: ${Array.isArray(s.grupos) ? s.grupos.join(', ') : s.grupos}`
    + ` | leitura por IA: ${s.leituraPorIA ? 'sim' : 'não'}`,
  )
} else if (gastos.coringaInvalido()) {
  console.error(
    '[gastos] GASTOS_AUTORIZADOS="*" RECUSADO: sem GASTOS_GRUPOS ele valeria também\n'
    + '         para quem manda no privado, e qualquer um que descobrisse o número\n'
    + '         lançaria no financeiro. Defina o grupo, ou liste os números.',
  )
} else if (process.env.OBRAS_API_TOKEN || process.env.GASTOS_AUTORIZADOS) {
  console.warn('[gastos] configuração incompleta — falta OBRAS_API_TOKEN ou GASTOS_AUTORIZADOS. Comprovantes NÃO serão enviados.')
}

/**
 * Reinício planejado não pode engolir comprovante.
 *
 * O módulo de gastos segura fotos esperando resposta, em memória. Um deploy
 * no meio da tarde as perderia calado: a pessoa responderia a pergunta e não
 * receberia nada de volta. Aqui elas vão para a caixa antes de o processo
 * sair — na caixa pelo menos existem.
 *
 * O prazo é curto de propósito: se o envio ao sistema de obras estiver
 * lento, é melhor sair do que travar o deploy.
 */
let saindo = false
for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, async () => {
    if (saindo) process.exit(0)
    saindo = true
    await Promise.race([
      gastos.encerrar().catch(e => console.error('[gastos] falha ao encerrar:', e.message)),
      new Promise(r => setTimeout(r, 8000)),
    ])
    process.exit(0)
  })
}

const PORT = process.env.PORT || 3100

const servidor = app.listen(PORT, () =>
  console.log(`🤖 recrutamento-bot ouvindo na porta ${PORT} (connector=${process.env.CONNECTOR || 'none'})`))

/**
 * Porta ocupada é o erro mais comum aqui — acontece toda vez que se esquece
 * uma janela antiga aberta. O rastro de pilha do Node não ajuda ninguém a
 * resolver; o comando que mata o processo, sim.
 */
servidor.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e

  const comoMatar = process.platform === 'win32'
    ? `Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`
    : `kill $(lsof -ti:${PORT})`

  console.error([
    '',
    `❌ A porta ${PORT} já está em uso — provavelmente outra janela com o robô rodando.`,
    '',
    '   Para encerrar o que está lá:',
    `   ${comoMatar}`,
    '',
    `   Ou suba numa porta diferente:  PORT=${Number(PORT) + 1} npm start`,
    '',
  ].join('\n'))
  process.exit(1)
})
