/**
 * Cliente do sistema Nova Gestão RH — envia a candidatura (ficha) para a porta
 * de entrada do recrutamento. É aqui (e só aqui) que o robô "conversa" com o RH.
 */
const RH_API_URL = process.env.RH_API_URL || ''
const RH_API_TOKEN = process.env.RH_API_TOKEN || ''

export async function enviarCandidatura(dados) {
  if (!RH_API_URL || !RH_API_TOKEN) {
    console.warn('[rh-client] RH_API_URL/RH_API_TOKEN não configurados — candidatura NÃO enviada.')
    return { ok: false, motivo: 'nao-configurado' }
  }
  try {
    const r = await fetch(`${RH_API_URL}/api/integracao/candidatura`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RH_API_TOKEN}` },
      body: JSON.stringify({
        nomeCompleto: dados.nomeCompleto,
        vagaPretendida: dados.vagaPretendida,
        cidadePreferencia: dados.cidadePreferencia,
        whatsapp: dados.whatsapp,
        tempoExperiencia: dados.tempoExperiencia,
        resumoExperiencia: dados.resumoExperiencia,
        dadosBrutos: JSON.stringify({ origem: 'whatsapp-bot', ...dados.transcricao }),
      }),
      signal: AbortSignal.timeout(8000),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      console.error('[rh-client] RH respondeu', r.status, j)
      return { ok: false, status: r.status, ...j }
    }
    return { ok: true, protocolo: j.protocolo, id: j.id }
  } catch (e) {
    console.error('[rh-client] falha ao enviar candidatura:', e.message)
    return { ok: false, motivo: e.message }
  }
}
