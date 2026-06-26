/**
 * Estado das conversas em memória (por número de telefone).
 * Para MVP é suficiente; se reiniciar o serviço, conversas em andamento recomeçam.
 * (Depois dá pra trocar por Redis/SQLite sem mudar o resto.)
 */
const sessoes = new Map() // telefone -> { estado, atualizadoEm }
const TTL_MS = 1000 * 60 * 60 * 6 // 6h sem interação → expira

export function getEstado(telefone) {
  const s = sessoes.get(telefone)
  if (!s) return null
  if (Date.now() - s.atualizadoEm > TTL_MS) { sessoes.delete(telefone); return null }
  return s.estado
}

export function setEstado(telefone, estado) {
  sessoes.set(telefone, { estado, atualizadoEm: Date.now() })
}

export function limpar(telefone) {
  sessoes.delete(telefone)
}
