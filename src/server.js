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
import { iniciar, responder } from './brain.js'
import { getEstado, setEstado, limpar } from './store.js'
import { enviarMensagem, parseWebhook } from './connectors.js'
import { enviarCandidatura } from './rh-client.js'

const app = express()
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => res.json({ ok: true, servico: 'recrutamento-bot' }))

// Verificação do webhook (WhatsApp Cloud API oficial)
app.get('/webhook', (req, res) => {
  const verify = process.env.CLOUD_VERIFY_TOKEN
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verify) {
    return res.status(200).send(req.query['hub.challenge'])
  }
  return res.sendStatus(403)
})

// Mensagens recebidas do WhatsApp
app.post('/webhook', async (req, res) => {
  res.sendStatus(200) // responde rápido; processa em seguida
  const msg = parseWebhook(req.body)
  if (!msg) return
  try {
    const resposta = await processar(msg.from, msg.text)
    if (resposta) await enviarMensagem(msg.from, resposta)
  } catch (e) {
    console.error('[webhook] erro:', e.message)
  }
})

// Simulador (sem WhatsApp) — mesma lógica, retorna o texto na resposta HTTP
app.post('/simular', async (req, res) => {
  const { estado, mensagem, whatsapp, persistir } = req.body || {}
  if (!estado) return res.json(iniciar(whatsapp))
  const r = responder(estado, mensagem || '')
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

/** Conduz a conversa de um número e devolve o texto de resposta. */
async function processar(from, text) {
  let estado = getEstado(from)
  if (!estado) {
    const ini = iniciar(from)
    setEstado(from, ini.estado)
    return ini.resposta
  }
  const r = responder(estado, text)
  setEstado(from, r.estado)
  if (r.escalarHumano) {
    console.log(`[ATENDIMENTO HUMANO] ${from} precisa de atendente: "${text}"`)
    // TODO: notificar um humano (ex.: avisar um número do RH / criar tarefa)
  }
  if (r.acao?.tipo === 'criar_candidatura') {
    const env = await enviarCandidatura(r.acao.dados)
    if (env.ok) {
      limpar(from) // conversa concluída com sucesso
      return r.resposta // confirmação só agora, depois de salvar
    }
    console.warn('[processar] candidatura não registrada:', env)
    // mantém o estado p/ permitir nova tentativa; resposta honesta de falha
    return r.respostaFalha || r.resposta
  }
  return r.resposta
}

const PORT = process.env.PORT || 3100
app.listen(PORT, () => console.log(`🤖 recrutamento-bot ouvindo na porta ${PORT} (connector=${process.env.CONNECTOR || 'none'})`))
