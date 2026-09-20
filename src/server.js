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
// PRIMEIRO import, e a ordem importa: o ESM avalia as dependências na ordem
// em que aparecem, e todo módulo abaixo lê process.env ao ser carregado. Vindo
// depois, o .env chegaria tarde demais.
import { recrutamentoLigado } from './config.js'

import express from 'express'
import { iniciarAtendimento as iniciar, atender } from './atendimento.js'
import { iaDisponivel } from './ia.js'
import {
  getEstado, setEstado, limpar, getAbandonada,
  marcarConcluida, marcarEscalada, metricas, sessoesParaLembrete, marcarLembrado,
} from './store.js'
import { getVagas, origemDaLista, intervaloDeAtualizacao } from './catalogo.js'
import { enviarMensagem, parseWebhook, baixarMidiaCloud } from './connectors.js'
import {
  enviarCandidatura, enviarDocumento, avisarRH, quemE,
  pendenciasDe, salvarPix, quemLembrarDocumentos, marcarLembreteDocumentos, fichaDoCandidato,
} from './rh-client.js'
import * as guardados from './documentos-guardados.js'
import * as lembrete from './lembrete-cadastro.js'
import { estadoDaFicha, paradoHaDaFicha } from './ficha-rh.js'
import { chavePixNoTexto, respostaDaPendencia } from './contratacao.js'
import * as resumoRecrutamento from './resumo-recrutamento.js'
import { lerDocumentoCandidato, MAX_DOCUMENTO_BYTES } from './ia-documento.js'
import * as funcionario from './funcionario.js'
import * as triagem from './triagem.js'
import * as gastos from './gastos.js'
import * as limite from './limite.js'
import { decidir as quemAtender, ehCobranca } from './quem-atender.js'
import * as maoHumana from './mao-humana.js'
import { discreto } from './texto.js'

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
const RECRUTAMENTO_LIGADO = recrutamentoLigado()


app.get('/health', (_req, res) => res.json({ ok: true, servico: 'recrutamento-bot' }))

/**
 * Números da operação.
 *
 * A taxa de conclusão é o indicador que diz se o roteiro está funcionando,
 * e `abandonaramNaEtapa` diz ONDE as pessoas desistem — que é o que aponta
 * qual pergunta rever.
 */
app.get('/metricas', (req, res) => {
  // Mesma porta do simulador: localhost, ou o token compartilhado.
  //
  // Não é só pudor com número de conversa. `gastos.situacao()` devolve a
  // LISTA DE GRUPOS, e o identificador do grupo é exatamente a credencial
  // que o coringa "*" exige — publicá-lo num endereço aberto entrega de
  // graça a informação que decide quem lança no financeiro.
  if (!simuladorAutorizado(req)) {
    return res.sendStatus(404)   // 404, e não 403: não confirma que existe
  }
  res.json({
    ...metricas(),
    vagas: origemDaLista(),
    atendente: iaDisponivel() ? 'Maria Vitória (IA)' : 'roteiro',
    gastos: gastos.situacao(),
    limite: limite.situacao(),
  atendimentoHumano: maoHumana.situacao(),
  })
})

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

/**
 * O RH pede documentos a um aprovado: o robô manda a mensagem.
 *
 * Mesma porta do simulador (localhost ou o token compartilhado). O texto
 * vem pronto do RH, que é quem sabe o que foi pedido.
 */
app.post('/enviar-pedido', async (req, res) => {
  if (!simuladorAutorizado(req)) return res.sendStatus(404)
  const { whatsapp, texto } = req.body || {}
  const numero = String(whatsapp ?? '').replace(/\D/g, '')
  if (numero.length < 10 || typeof texto !== 'string' || !texto.trim() || texto.length > 1000) {
    return res.status(422).json({ ok: false, error: 'whatsapp e texto são obrigatórios' })
  }
  if (!recrutamentoLigado()) return res.status(503).json({ ok: false, error: 'O recrutamento está desligado no robô.' })
  const destino = numero.length <= 11 ? `55${numero}` : numero
  const r = await enviarMensagem(destino, texto.trim())
  console.log(`[contratacao] pedido de documentos para ${discreto(destino)}: ${r?.ok ? 'enviado' : 'falhou'}`)
  res.status(r?.ok ? 200 : 502).json({ ok: Boolean(r?.ok), error: r?.ok ? undefined : 'WhatsApp não enviou (desconectado?)' })
})

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
  // Uma pergunta só, respondida num lugar só.
  //
  // Antes esta linha recombinava origem e remetente por conta própria, e era
  // fácil errar a combinação — foi assim que o coringa passou a aceitar grupo
  // casado pelo NOME, que o atacante escolhe.
  const podeLancar = gastos.podeLancarGasto(msg)

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
    console.log(`[recrutamento] desligado — ignorando mensagem de ${discreto(msg.de)}`)
    return null
  }

  /*
    Daqui para baixo é conversa com desconhecido, e cada mensagem custa uma
    chamada ao modelo.

    O limite vem DEPOIS da chave do recrutamento, e isso custou caro: ele
    estava acima, e em 12/09/2026 quem cobrava pagamento recebeu do robô um
    "preciso de um tempinho" — a única resposta que teve.

    A cota é diária e compartilhada. Um número mandando sem parar — de
    sacanagem, ou um aplicativo repetindo sozinho — gastava a cota do dia, e
    quem pagava era o candidato que escrevesse depois: caindo no roteiro
    fixo, que não sabe salário nem cidade. O prejuízo nunca foi a conta; era
    o atendimento de quem interessa, pelo resto do dia.

    Quem lança gasto já saiu acima, e de propósito: vinte comprovantes
    seguidos no grupo é o uso normal do outro módulo.
  */
  const vez = limite.registrar(msg.de)
  if (!vez.permitido) {
    // Um aviso por janela. Repetir a cada mensagem faria do robô exatamente
    // o que se quer evitar: uma máquina respondendo sem parar.
    if (vez.avisar) {
      console.warn(`[limite] ${discreto(msg.de)} passou do limite de mensagens — avisado uma vez.`)
      return limite.textoDoAviso()
    }
    return null
  }


  /*
    Arquivo de candidato: currículo, carteira de trabalho, RG, CPF.

    Antes a resposta era "consigo ler só texto" e o arquivo era jogado fora.
    Agora ele é lido e anexado à candidatura no RH. Com legenda, a legenda
    segue a conversa normal e o arquivo é anexado em silêncio; onde uma
    pessoa da empresa já está atendendo, também em silêncio.
  */
  if (msg.arquivo) {
    const calado = Boolean(msg.texto) || maoHumana.atendidaPorGente(msg.de).atendida
    if (calado) receberDocumento(msg, { calado: true }).catch(e => console.error('[documento]', e.message))
    else return receberDocumento(msg)
  }
  if (!msg.texto) return null

  /*
    Onde uma pessoa da empresa já está atendendo, o robô cala.

    Minutos depois de o robô ser ligado, ele e o dono responderam o mesmo
    candidato ao mesmo tempo: o dono escreveu "preenche essa ficha que eu
    peço para te ligarem" e, no mesmo minuto, o robô perguntou "você está
    procurando vaga por aqui?". Para quem está do outro lado, é a empresa
    falando duas coisas — e uma delas ignorando a outra.
  */
  const gente = maoHumana.atendidaPorGente(msg.de)
  if (gente.atendida) {
    console.log(`[atendimento] ${discreto(msg.de)}: já atendido por gente há ${gente.faz} min — robô calado.`)
    return null
  }

  /*
    Cobrança de pagamento NUNCA recebe resposta automática.

    Vem antes da consulta ao RH porque não depende dela: quem cobra pode não
    estar cadastrado — foi o caso de 12/09/2026, 64 mensagens de madrugada de
    alguém que trabalhou, não recebeu e, para o robô, seria uma desconhecida
    procurando vaga.

    O robô cala e chama gente. É o RH que responde sobre dinheiro.
  */
  if (ehCobranca(msg.texto)) {
    console.warn(`[atendimento] ${discreto(msg.de)}: cobrança de pagamento — calado, avisando o RH.`)
    marcarEscalada(msg.de)
    avisarRH({
      whatsapp: msg.de,
      motivo: 'Cobrança de pagamento no WhatsApp do recrutamento',
      trecho: msg.texto.slice(0, 300),
    }).catch(() => {})
    return null
  }

  /*
    ANTES de qualquer coisa: quem é essa pessoa?

    O robô tratava todo desconhecido como candidato, e perguntava "qual vaga
    você procura?" para quem só queria uma informação — ou para quem trabalha
    na obra há dois anos.

    Consultado a cada mensagem, mas guardado por meia hora no rh-client. E
    quando o RH não responde, cai na triagem, que funciona sem saber quem é.
  */
  const ficha = await quemE({ whatsapp: msg.de }).catch(() => null)

  /*
    Quem trabalha na empresa fala com gente.

    O módulo de atendimento a funcionário existe e funciona, mas fica
    desligado por decisão do dono (12/09/2026): o robô atende CANDIDATO. Para
    ligar, ATENDER_FUNCIONARIO=on.
  */
  const decisao = quemAtender({ texto: msg.texto, ficha })
  if (!decisao.atender) {
    console.log(`[atendimento] ${discreto(msg.de)}: ${decisao.motivo} — calado, avisando o RH.`)
    marcarEscalada(msg.de)
    avisarRH({
      whatsapp: msg.de,
      motivo: `Mensagem de quem ${decisao.motivo} — ninguém do robô respondeu`,
      trecho: msg.texto.slice(0, 300),
    }).catch(() => {})
    return null
  }

  if (ficha?.tipo === 'funcionario') return atenderFuncionario(msg, ficha)
  if (ficha?.tipo === 'candidato' && ficha.situacao === 'avancou') {
    const r = await atenderAprovado(msg, ficha)
    if (r !== undefined) return r
  }
  if (ficha?.tipo === 'candidato') return atenderCandidatoConhecido(msg, ficha)

  return primeiroContato(msg)
}

/**
 * Documento que chegou antes de a ficha existir no RH.
 *
 * Quem manda o currículo na primeira mensagem ainda não tem candidatura: o
 * RH responde 404. Fica guardado aqui até a ficha ser registrada. Na
 * memória, e com teto — o servidor tem 911 MB e divide a máquina com o RH;
 * perder um currículo num reinício é melhor que derrubar os dois.
 */
async function mandarDocumentosGuardados(de) {
  for (const doc of guardados.retirar(de)) await enviarDocumento(doc)
}

async function receberDocumento(msg, { calado = false } = {}) {
  if (msg.arquivo.length > MAX_DOCUMENTO_BYTES) {
    return calado ? null : 'esse arquivo ficou grande pra mim, consegue mandar uma foto?'
  }
  // Funcionário mandando documento é assunto do RH, não do recrutamento.
  const ficha = await quemE({ whatsapp: msg.de }).catch(() => null)
  if (ficha?.tipo === 'funcionario') return null

  const lido = await lerDocumentoCandidato({ arquivo: msg.arquivo, tipo: msg.tipo })
  const tipo = lido?.tipo ?? 'outro'

  // A conversa fica sabendo: não pede CPF de quem acabou de mandar o RG.
  const estado = getEstado(msg.de)
  if (estado && (estado.modo === 'ia' || estado.modo === 'roteiro')) {
    setEstado(msg.de, {
      ...estado,
      documentos: [...(estado.documentos ?? []), tipo].slice(-10),
      cpf: estado.cpf ?? lido?.cpf ?? null,
      rg: estado.rg ?? lido?.rg ?? null,
    })
  }

  const doc = { whatsapp: msg.de, tipo, nome: msg.nomeArquivo, arquivo: msg.arquivo, extraido: lido }
  const env = await enviarDocumento(doc)
  const guardado = !env.ok && env.status === 404 && guardados.guardar(msg.de, doc)
  console.log(`[documento] ${discreto(msg.de)}: ${tipo} — ${env.ok ? 'anexado à candidatura' : guardado ? 'guardado até a ficha' : 'não enviado'}`)

  if (calado) return null

  // Aprovado com pedido de documentos: diz o que ainda falta.
  if (env.ok) {
    const pend = await pendenciasDe(msg.de)
    if (pend) return respostaDaPendencia(pend)
  }
  if (!lido) console.warn(`[documento] ${discreto(msg.de)}: a leitura automática falhou — o RH vai ver o aviso na ficha`)

  const oQue = { curriculo: 'seu currículo', ctps: 'a foto da carteira', rg: 'o documento', cpf: 'o documento', cnh: 'o documento' }[tipo]
  const recebi = oQue ? `recebi ${oQue}, obrigada` : 'recebi aqui, obrigada'
  return estado?.vaga ? recebi : `${recebi}. qual vaga vc tá procurando?`
}

/**
 * Aprovado a quem o RH pediu documentos.
 *
 * Aqui não se conversa de vaga: o que se espera são fotos e a chave PIX. A
 * chave vai para o RH como "a confirmar". Qualquer outra coisa chama gente —
 * aprovado com dúvida é contratação em andamento, e não é o robô que resolve.
 *
 * Devolve undefined quando não há pedido: segue o atendimento de sempre.
 */
async function atenderAprovado(msg, ficha) {
  const pend = await pendenciasDe(msg.de)
  if (!pend) return undefined

  const chave = chavePixNoTexto(msg.texto)
  if (chave) {
    const r = await salvarPix(msg.de, chave)
    if (r.ok) {
      console.log(`[contratacao] ${discreto(msg.de)}: chave PIX recebida — a confirmar pelo RH`)
      return respostaDaPendencia({ faltam: r.faltam ?? pend.faltam, pixFalta: false }, 'anotei sua chave pix')
    }
  }

  const anterior = getEstado(msg.de)
  marcarEscalada(msg.de)
  avisarRH({ whatsapp: msg.de, motivo: `aprovado ${ficha.primeiroNome} escreveu (fase de documentos)`, trecho: msg.texto })
  if (anterior?.modo === 'aprovado' && Date.now() - (anterior.avisadoEm ?? 0) < 12 * 3600_000) return null
  setEstado(msg.de, { modo: 'aprovado', whatsapp: msg.de, avisadoEm: Date.now() })
  return `oi ${ficha.primeiroNome}, vou pedir pra alguém do rh te responder`
}

/**
 * Quem já se inscreveu, e voltou.
 *
 * Sem isto ele recomeçaria a ficha do zero com quem já respondeu tudo — que
 * é a forma mais rápida de a pessoa achar que ninguém está prestando
 * atenção. E a pergunta que ela faz ao voltar é sempre a mesma: "e aí, saiu
 * alguma coisa?".
 *
 * O andamento é dito por FAIXA, e nunca "reprovado". Essa notícia não é o
 * robô que dá; quando a candidatura foi encerrada, ele chama gente.
 */
async function atenderCandidatoConhecido(msg, ficha) {
  const anterior = getEstado(msg.de)

  /*
    Já está numa conversa de CANDIDATURA em andamento: segue nela.

    Só 'ia' e 'roteiro' valem. Um estado de triagem ou de funcionário tem
    outro formato, e entregá-lo ao cérebro do recrutamento faria ele procurar
    campos que não existem — e responder de acordo.
  */
  if (anterior && (anterior.modo === 'ia' || anterior.modo === 'roteiro')) {
    return aplicarResultado(msg.de, await atender(anterior, msg.texto), msg.texto)
  }

  // A conversa expirou mas ainda está guardada: retoma com tudo que já foi dito.
  const pendente = getAbandonada(msg.de)
  if (pendente && (pendente.estado?.modo === 'ia' || pendente.estado?.modo === 'roteiro')) {
    setEstado(msg.de, pendente.estado)
    return aplicarResultado(msg.de, await atender(pendente.estado, msg.texto, { paradoHa: pendente.paradoHa }), msg.texto)
  }

  if (ficha.situacao === 'encerrada') {
    marcarEscalada(msg.de)
    avisarRH({
      whatsapp: msg.de,
      motivo: `candidato ${ficha.primeiroNome} voltou (candidatura encerrada)`,
      trecho: msg.texto,
    })
    setEstado(msg.de, { modo: 'candidato-conhecido', whatsapp: msg.de })
    return `oi ${ficha.primeiroNome}, vou pedir pra alguém da equipe falar com você`
  }

  /*
    Tem ficha no RH, mas nenhuma conversa guardada — veio pelo formulário, ou
    faz mais de uma semana.

    Antes o robô respondia "Oi de novo! Sua ficha está com a gente" e marcava
    a conversa como 'candidato-conhecido', que não sabia continuar: TODA
    mensagem seguinte recebia a mesma frase. Agora abre uma conversa normal
    já sabendo o que o RH sabe, e responde o que a pessoa perguntou.
  */
  /*
    Sem conversa guardada aqui, mas com ficha no RH: começa a conversa JÁ
    SABENDO o que ela respondeu antes — e com a conversa anterior no
    histórico. A ficha é uma só; o que ela contar agora é acrescentado nela.
  */
  const doRH = await fichaDoCandidato(msg.de).catch(() => null)
  const base = { ...iniciar(msg.de).estado, historico: [], vaga: ficha.vaga ?? null, cidade: ficha.cidade ?? null, registrado: true }
  const semente = estadoDaFicha(doRH, base) ?? base
  setEstado(msg.de, semente)
  return aplicarResultado(msg.de, await atender(semente, msg.texto, { paradoHa: paradoHaDaFicha(doRH) }), msg.texto)
}

/**
 * Primeiro contato de quem o sistema não conhece.
 *
 * Não presume nada. Responde ao que a pessoa falou e vai entendendo pelo
 * caminho — e só passa para o recrutamento quando fica claro que é disso que
 * se trata.
 */
async function primeiroContato(msg) {
  const anterior = getEstado(msg.de)

  // Já está numa candidatura em andamento: segue nela, sem passar pela
  // triagem de novo. Mesma checagem de formato de acima.
  if (anterior && (anterior.modo === 'ia' || anterior.modo === 'roteiro')) {
    return processar(msg.de, msg.texto)
  }

  const historico = (anterior?.historico ?? []).slice(-8)
  const r = await triagem.atender({
    texto: msg.texto,
    historico,
    esperandoNome: Boolean(anterior?.esperandoNome),
  })

  /*
    Disse o nome depois de a gente perguntar: procura no RH.

    Identificação por nome é MAIS FRACA que por telefone — qualquer um
    digita um nome. Vale porque reconhecer alguém aqui não libera dado
    pessoal nenhum: libera ser chamado pelo nome e receber respostas que
    valem para todo mundo igual.
  */
  if (r.nomeInformado) {
    const achado = await quemE({ nome: r.nomeInformado }).catch(() => null)
    if (achado?.tipo === 'funcionario') {
      limpar(msg.de)
      console.log(`[triagem] ${discreto(msg.de)} identificado como ${achado.primeiroNome} pelo NOME (não pelo telefone)`)
      return `achei aqui, ${achado.primeiroNome}. em que posso ajudar?`
    }
    // Não achou: chama gente em vez de insistir. Quem diz que trabalha na
    // empresa e não está no cadastro é exatamente o caso que precisa de
    // alguém olhando.
    limpar(msg.de)
    marcarEscalada(msg.de)
    avisarRH({
      whatsapp: msg.de,
      motivo: `disse que trabalha na empresa mas não achei no cadastro: "${r.nomeInformado}"`,
      trecho: msg.texto,
    })
    return 'não achei seu cadastro com esse nome. já avisei a equipe, alguém vai falar com você'
  }

  /*
    Ficou claro que procura vaga: entrega para o recrutamento.

    E entrega COM o que a pessoa já disse. Antes isto abria uma conversa nova
    e devolvia a mensagem de boas-vindas, descartando o texto: quem escrevia
    "quero uma vaga de pedreiro em Buritama" recebia "para qual vaga você
    quer se candidatar?" — com a vaga e a cidade que ela acabou de informar
    jogadas fora.
  */
  if (r.intencao === 'procura_vaga') {
    // O que já foi conversado na triagem vai junto. Antes a conversa era
    // apagada e o recrutamento começava só com a última mensagem: quem tinha
    // dito "moro em Bastos" três mensagens antes ouvia "qual cidade vc mora?".
    const ini = iniciar(msg.de)
    const estado = ini.estado.modo === 'ia'
      ? {
          ...ini.estado,
          historico: historico.map(m => ({
            de: m.de === 'pessoa' ? 'candidato' : 'maria',
            texto: m.texto,
          })),
        }
      : ini.estado
    setEstado(msg.de, estado)
    return aplicarResultado(msg.de, await atender(estado, msg.texto), msg.texto)
  }

  setEstado(msg.de, {
    modo: 'triagem',
    whatsapp: msg.de,
    esperandoNome: Boolean(r.pedindoNome),
    historico: [...historico, { de: 'pessoa', texto: msg.texto }, { de: 'rh', texto: r.resposta ?? '' }].slice(-8),
  })

  if (r.escalarHumano) {
    marcarEscalada(msg.de)
    console.log(`[TRIAGEM → RH] ${discreto(msg.de)}: ${r.motivoEscalada} — "${msg.texto}"`)
    avisarRH({ whatsapp: msg.de, motivo: r.motivoEscalada, trecho: msg.texto })
  }

  return r.resposta ?? triagem.saudacao()
}

/**
 * Conversa com quem trabalha na empresa.
 *
 * O histórico fica no mesmo store das conversas, com uma marca de modo: sem
 * ele a pessoa repetiria o contexto a cada mensagem, e o robô responderia
 * "de qual obra?" para quem acabou de dizer.
 *
 * Toda escalada vira alerta no sino do RH — inclusive as de assunto pessoal,
 * que são a maioria e o motivo de o módulo existir. Alerta que exige alguém
 * lembrar de ir procurar não é alerta.
 */
async function atenderFuncionario(msg, ficha) {
  const anterior = getEstado(msg.de)
  const historico = (anterior?.modo === 'funcionario' ? anterior.historico ?? [] : []).slice(-10)

  const r = await funcionario.atender({ ficha, texto: msg.texto, historico })

  setEstado(msg.de, {
    modo: 'funcionario',
    whatsapp: msg.de,
    historico: [...historico, { de: 'pessoa', texto: msg.texto }, { de: 'rh', texto: r.resposta }].slice(-10),
  })

  if (r.escalarHumano) {
    marcarEscalada(msg.de)
    console.log(`[FUNCIONÁRIO → RH] ${ficha.primeiroNome} (${discreto(msg.de)}): ${r.motivoEscalada} — "${msg.texto}"`)
    // Sem await: a pessoa não espera o RH ser avisado para receber a resposta.
    avisarRH({
      whatsapp: msg.de,
      motivo: `funcionário ${ficha.primeiroNome}: ${r.motivoEscalada}`,
      trecho: msg.texto,
    })
  }

  return r.resposta
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
    // Número mascarado e mensagem fora do log, como no resto do arquivo.
    //
    // Esta linha era a única que escrevia o número inteiro e o que a pessoa
    // digitou. O log fica no servidor, é lido por mais gente e guardado por
    // mais tempo que a conversa — e quem precisa do número para assumir o
    // atendimento recebe o alerta completo em avisarRH(), logo abaixo.
    console.log(`[ATENDIMENTO HUMANO] ${discreto(from)}: ${r.motivoEscalada ?? 'pediu atendimento'}`)
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
      /*
        A marca de "já está no RH" é dada AQUI, depois do ok — e não no
        atendimento, que não sabe se a gravação deu certo. Com o RH fora do
        ar, a conversa terminava marcada como registrada e nada existia lá.
        É esta marca que faz o reenvio seguinte contar como atualização, e
        não como uma nova conclusão nas métricas.
      */
      setEstado(from, { ...r.estado, registrado: true })
      // O currículo que chegou antes da ficha agora tem onde ficar.
      mandarDocumentosGuardados(from).catch(e => console.error('[documento]', e.message))
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
      // Retoma sem mensagem enlatada. O "Oi de novo! Vi que você começou uma
      // candidatura há 2 dias..." entregava o robô na primeira frase. Quem
      // sabe que a pessoa sumiu e voltou é o modelo (ver oQueJaSabe), e ele
      // continua como uma pessoa continuaria.
      setEstado(from, pendente.estado)
      return aplicarResultado(from, await atender(pendente.estado, text, { paradoHa: pendente.paradoHa }), text)
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

/*
  A mensagem para quem parou no meio do cadastro, e o lembrete de documentos.

  Regras aprovadas pelo dono em 14/09/2026 (ver lembrete-cadastro.js). Para
  desligar: LEMBRETE_CADASTRO=off no .env.
*/
async function rodarLembretes() {
  if (!recrutamentoLigado() || process.env.LEMBRETE_CADASTRO === 'off') return
  if (!lembrete.horarioComercial()) return
  for (const [telefone, sessao] of sessoesParaLembrete()) {
    const d = lembrete.decidir(sessao, { atendidaPorGente: maoHumana.atendidaPorGente(telefone).atendida })
    if (!d.lembrar) continue
    const texto = lembrete.texto(sessao.estado)
    // Marca ANTES de enviar: se o envio travar e o laço rodar de novo, a
    // pessoa não recebe duas vezes. Uma a menos é melhor que uma a mais.
    marcarLembrado(telefone, texto)
    const r = await enviarMensagem(telefone, texto)
    console.log(`[lembrete] cadastro parado ${discreto(telefone)}: ${r?.ok ? 'lembrado' : 'falhou'}`)
  }
  for (const { whatsapp, texto } of await quemLembrarDocumentos()) {
    const numero = String(whatsapp).replace(/\D/g, '')
    await marcarLembreteDocumentos(whatsapp)
    const r = await enviarMensagem(numero.length <= 11 ? `55${numero}` : numero, texto)
    console.log(`[lembrete] documentos ${discreto(numero)}: ${r?.ok ? 'lembrado' : 'falhou'}`)
  }
}
/*
  Resumo do recrutamento às 8h no WhatsApp do gestor. Só com
  RESUMO_RECRUTAMENTO_PARA no .env; sem número, não manda nada.
*/
async function rodarResumoRecrutamento() {
  if (!resumoRecrutamento.deveEnviar()) return
  const texto = await resumoRecrutamento.buscarTexto()
  if (!texto) return
  resumoRecrutamento.marcarEnviado()
  const r = await enviarMensagem(resumoRecrutamento.destino(), texto)
  console.log(`[resumo-recrutamento] ${r?.ok ? 'enviado' : 'falhou'}`)
}
const relogioResumo = setInterval(() => rodarResumoRecrutamento().catch(e => console.error('[resumo-recrutamento]', e.message)), 10 * 60 * 1000)
relogioResumo.unref?.()

const relogioLembretes = setInterval(() => rodarLembretes().catch(e => console.error('[lembrete]', e.message)), 15 * 60 * 1000)
relogioLembretes.unref?.()

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
} else if (gastos.coringaSoComNome()) {
  console.error([
    '[gastos] GASTOS_AUTORIZADOS="*" com GASTOS_GRUPOS só por NOME: ninguém vai',
    '         conseguir lançar. O nome do grupo é escolhido por quem o cria —',
    '         qualquer pessoa criaria um grupo com esse nome, poria o robô',
    '         dentro e lançaria no financeiro. Use o IDENTIFICADOR do grupo',
    '         (algo como 1203630000000000@g.us), ou liste os números.',
  ].join('\n'))
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
