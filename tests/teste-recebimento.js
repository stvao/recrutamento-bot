/**
 * O robô atende o que chegou enquanto ele estava fora.
 *
 * O caso que motivou isto: o robô descartava toda mensagem rotulada 'append'
 * achando que era histórico — e é assim que o WhatsApp entrega o que chegou
 * durante um reinício. Um comprovante mandado no grupo naquele minuto sumia.
 */
import { criarFiltro, JANELA_FORA_DO_AR_MS } from '../src/recebimento.js'

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

const agora = Date.parse('2026-09-11T12:00:00Z')
const seg = (ms) => Math.floor(ms / 1000)
let n = 0
const mensagem = (extra = {}) => ({
  key: { id: `id-${++n}`, remoteJid: '120363413147794205@g.us', fromMe: false },
  message: { conversation: 'haia cimento 250' },
  messageTimestamp: seg(agora - 60_000),
  ...extra,
})

// ── Chegando agora: atende, como sempre ────────────────────────────────
{
  const f = criarFiltro()
  const r = f(mensagem(), 'notify', agora)
  ok('notify é atendida', r.atender)
  ok('e não é marcada como fora do ar', !r.foraDoAr)
}

// ── O CONSERTO: chegou com o robô fora do ar ───────────────────────────
{
  const f = criarFiltro()
  const r = f(mensagem({ messageTimestamp: seg(agora - 5 * 60_000) }), 'append', agora)
  ok('append recente é atendida (o comprovante do reinício)', r.atender)
  ok('e fica marcada como fora do ar', r.foraDoAr)
}
{
  const f = criarFiltro()
  ok('append de 23 h atrás ainda é atendida',
    f(mensagem({ messageTimestamp: seg(agora - 23 * 3600_000) }), 'append', agora).atender)
  ok('append de 2 dias atrás NÃO — não é queda, é conversa velha',
    !f(mensagem({ messageTimestamp: seg(agora - 48 * 3600_000) }), 'append', agora).atender)
  ok('a janela padrão é de 24 h', JANELA_FORA_DO_AR_MS === 24 * 3600_000)
}

// ── Aviso técnico não é mensagem ───────────────────────────────────────
{
  const f = criarFiltro()
  ok('"fulano entrou no grupo" não é atendido',
    !f(mensagem({ message: null, messageStubType: 27 }), 'append', agora).atender)
  ok('stub com conteúdo também não',
    !f(mensagem({ messageStubType: 32 }), 'append', agora).atender)
  ok('append sem data não é atendido', !f(mensagem({ messageTimestamp: 0 }), 'append', agora).atender)
}

// ── Nunca duas vezes ───────────────────────────────────────────────────
//
// Responder duas vezes no grupo ao mesmo comprovante confunde quem mandou; e
// no privado parece robô quebrado.
{
  const f = criarFiltro()
  const m = mensagem()
  ok('primeira entrega atende', f(m, 'append', agora).atender)
  ok('a mesma mensagem de novo, não', !f(m, 'notify', agora).atender)
}
{
  const a = criarFiltro()
  const b = criarFiltro()
  const m = mensagem()
  a(m, 'notify', agora)
  ok('cada conexão tem sua memória', b(m, 'notify', agora).atender)
}

// ── Outros rótulos ─────────────────────────────────────────────────────
ok('rótulo desconhecido não passa', !criarFiltro()(mensagem(), 'last', agora).atender)
ok('notify sem id ainda é atendida', criarFiltro()({ ...mensagem(), key: { remoteJid: 'x@lid' } }, 'notify', agora).atender)

// ── Não cresce para sempre ─────────────────────────────────────────────
{
  const f = criarFiltro()
  const primeira = mensagem()
  f(primeira, 'notify', agora)
  for (let i = 0; i < 5100; i++) f(mensagem(), 'notify', agora)
  ok('depois de 5000, as mais antigas são esquecidas', f(primeira, 'notify', agora).atender)
}

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
