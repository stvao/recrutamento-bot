/**
 * Comprovantes — como valores, datas e itens aparecem nas mensagens.
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 */

/** "R$ 1.234,50" */
export function moeda(v) {
  return v == null ? null : `R$ ${v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`
}

/** "28/08" — o ano só aparece quando não é o corrente, para a linha ficar curta. */
export function dataCurta(iso) {
  if (!iso) return null
  const [a, m, d] = iso.split('-')
  return Number(a) === new Date().getFullYear() ? `${d}/${m}` : `${d}/${m}/${a}`
}

/** Como um comprovante aparece numa lista, em poucas palavras. */
export function apelidoDoItem(p) {
  const d = p.dados ?? {}
  const partes = [d.obra, d.descricao || p.descricao, moeda(d.valor)].filter(Boolean)
  return partes.length ? partes.join(' · ').slice(0, 60) : (p.nomeArquivo || 'comprovante')
}

/** "há 3 horas" — para a cobrança soar como gente. */
export function faz(ms) {
  const min = Math.round(ms / 60000)
  if (min < 60) return `há ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `há ${h} hora${h === 1 ? '' : 's'}`
  return `há ${Math.round(h / 24)} dia(s)`
}
