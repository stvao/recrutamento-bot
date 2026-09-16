/**
 * Cliente do sistema Nova Gestão RH — envia a candidatura (ficha) para a porta
 * de entrada do recrutamento. É aqui (e só aqui) que o robô "conversa" com o RH.
 */
const RH_API_URL = process.env.RH_API_URL || ''
const RH_API_TOKEN = process.env.RH_API_TOKEN || ''

/**
 * Os campos da ficha que vão para o RH.
 *
 * É uma lista explícita, e não um repasse cego do objeto inteiro, porque
 * este arquivo é o contrato entre os dois sistemas: quem lê aqui tem que
 * conseguir ver o que o RH recebe sem abrir o outro repositório.
 *
 * Mas ela precisa acompanhar o que o atendimento coleta. Antes eram sete
 * campos escritos à mão enquanto o atendimento montava dezesseis, e os nove
 * que sobravam — bairro, CEP, nascimento, quando pode começar, tamanho de
 * camisa e de bota, contato de recado — eram montados a cada conversa e
 * jogados fora aqui na saída. O RH nunca viu nenhum deles.
 *
 * Mexeu nesta lista, confira o DTO do lado do RH (/api/integracao/candidatura).
 */
const CAMPOS_DA_FICHA = [
  'nomeCompleto', 'vagaPretendida', 'cidadePreferencia', 'whatsapp',
  'tempoExperiencia', 'resumoExperiencia',
  'bairro', 'cidade', 'cep', 'dataNascimento', 'disponibilidadeInicio',
  'aceitaOutrasObras', 'tamanhoCamisa', 'tamanhoBota',
  'contatoRecadoNome', 'contatoRecadoTelefone',
  // CPF é o cadastro único no RH; os dois são opcionais para o candidato.
  'cpf', 'rg',
  // O que ajuda quem contrata (dono, 14/09/2026).
  'especialidade', 'ultimaObra', 'anosRegistro', 'nrs', 'ferramentaPropria', 'conducao', 'cursoEstagio', 'referenciaNome', 'referenciaTelefone',
]

/**
 * Monta o corpo do POST.
 *
 * `dadosBrutos` carrega a conversa inteira, e é o que tem valor de prova: o
 * que a Maria Vitória informou por escrito sobre salário e alojamento fica
 * registrado junto da ficha. Os dois caminhos de atendimento nomeiam isso
 * diferente — o roteiro manda `transcricao`, a IA manda `dadosBrutos` — e
 * aceitar os dois aqui é mais barato que uniformizar os dois lados.
 */
function montarCorpo(dados) {
  const ficha = {}
  for (const campo of CAMPOS_DA_FICHA) {
    ficha[campo] = dados[campo] ?? null
  }

  const bruto = dados.dadosBrutos ?? dados.transcricao ?? {}
  return JSON.stringify({
    ...ficha,
    dadosBrutos: JSON.stringify({ origem: 'whatsapp-bot', ...bruto }),
  })
}

export async function enviarCandidatura(dados) {
  if (!RH_API_URL || !RH_API_TOKEN) {
    console.warn('[rh-client] RH_API_URL/RH_API_TOKEN não configurados — candidatura NÃO enviada.')
    return { ok: false, motivo: 'nao-configurado' }
  }

  const body = montarCorpo(dados)

  // Tenta até 2 vezes (a 2ª só em falha de rede/timeout — não repete em erro 4xx)
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const r = await fetch(`${RH_API_URL}/api/integracao/candidatura`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RH_API_TOKEN}` },
        body,
        signal: AbortSignal.timeout(8000),
      })
      const j = await r.json().catch(() => ({}))
      if (r.ok) return { ok: true, protocolo: j.protocolo, id: j.id }
      // erro do servidor (token, validação) → não adianta repetir
      console.error('[rh-client] RH respondeu', r.status, j)
      return { ok: false, status: r.status, ...j }
    } catch (e) {
      console.error(`[rh-client] tentativa ${tentativa} falhou:`, e.message)
      if (tentativa === 2) return { ok: false, motivo: e.message }
      await new Promise(res => setTimeout(res, 1000)) // espera 1s e tenta de novo
    }
  }
  return { ok: false, motivo: 'desconhecido' }
}

/**
 * Anexa à candidatura um documento que o candidato mandou.
 *
 * 404 quer dizer "ainda não tem candidatura deste número": quem chama guarda
 * o documento e manda de novo depois que a ficha for registrada.
 */
export async function enviarDocumento({ whatsapp, tipo, nome, arquivo, extraido }) {
  if (!RH_API_URL || !RH_API_TOKEN) return { ok: false, motivo: 'nao-configurado' }
  try {
    const r = await fetch(`${RH_API_URL}/api/integracao/candidatura/documento`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RH_API_TOKEN}` },
      body: JSON.stringify({ whatsapp, tipo, nome, extraido, base64: Buffer.from(arquivo).toString('base64') }),
      signal: AbortSignal.timeout(20000),
    })
    const j = await r.json().catch(() => ({}))
    if (r.ok) return { ok: true, ...j }
    if (r.status !== 404) console.error('[rh-client] documento recusado pelo RH:', r.status, j.error)
    return { ok: false, status: r.status }
  } catch (e) {
    console.error('[rh-client] documento não enviado:', e.message)
    return { ok: false, motivo: e.message }
  }
}

/**
 * A ficha que o RH já tem desta pessoa.
 *
 * É o que deixa a conversa continuar de onde parou mesmo semanas depois: o
 * robô guarda a conversa por 7 dias, a ficha fica no RH para sempre.
 * Devolve null quando não há ficha aberta ou o RH não respondeu.
 */
export async function fichaDoCandidato(whatsapp) {
  if (!RH_API_URL || !RH_API_TOKEN) return null
  try {
    const r = await fetch(`${RH_API_URL}/api/integracao/candidatura/ficha?whatsapp=${encodeURIComponent(whatsapp)}`, {
      headers: { Authorization: `Bearer ${RH_API_TOKEN}` }, signal: AbortSignal.timeout(8000),
    })
    const j = await r.json().catch(() => null)
    return r.ok && j?.tem ? j : null
  } catch (e) {
    console.warn('[rh-client] ficha indisponível:', e.message)
    return null
  }
}

/**
 * Fase de contratação: o que o RH pediu a este número e o que falta.
 * Null quando não há pedido ou o RH não respondeu.
 */
export async function pendenciasDe(whatsapp) {
  if (!RH_API_URL || !RH_API_TOKEN) return null
  try {
    const r = await fetch(`${RH_API_URL}/api/integracao/candidatura/pendencias?whatsapp=${encodeURIComponent(whatsapp)}`, {
      headers: { Authorization: `Bearer ${RH_API_TOKEN}` }, signal: AbortSignal.timeout(8000),
    })
    const j = await r.json().catch(() => null)
    return r.ok && j?.pedido ? j : null
  } catch (e) {
    console.warn('[rh-client] pendências indisponíveis:', e.message)
    return null
  }
}

async function postarPendencia(corpo) {
  if (!RH_API_URL || !RH_API_TOKEN) return { ok: false }
  try {
    const r = await fetch(`${RH_API_URL}/api/integracao/candidatura/pendencias`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RH_API_TOKEN}` },
      body: JSON.stringify(corpo), signal: AbortSignal.timeout(8000),
    })
    const j = await r.json().catch(() => ({}))
    return { ok: r.ok, ...j }
  } catch (e) {
    console.warn('[rh-client] pendência não enviada:', e.message)
    return { ok: false }
  }
}

/** Guarda a chave PIX na candidatura, como "a confirmar". */
export const salvarPix = (whatsapp, chavePix) => postarPendencia({ whatsapp, chavePix })
/** Marca que o lembrete de documentos saiu (o RH não devolve de novo). */
export const marcarLembreteDocumentos = (whatsapp) => postarPendencia({ whatsapp, lembrado: true })

/** Quem recebeu o pedido há 2+ dias e ainda deve algo: [{ whatsapp, texto }]. */
export async function quemLembrarDocumentos() {
  if (!RH_API_URL || !RH_API_TOKEN) return []
  try {
    const r = await fetch(`${RH_API_URL}/api/integracao/candidatura/pendencias?lembrar=1`, {
      headers: { Authorization: `Bearer ${RH_API_TOKEN}` }, signal: AbortSignal.timeout(10000),
    })
    const j = await r.json().catch(() => ({}))
    return r.ok && Array.isArray(j.lembrar) ? j.lembrar : []
  } catch {
    return []
  }
}

/**
 * Avisa o RH que uma conversa precisa de gente.
 *
 * Cai no sino de notificações que o RH já usa. Antes isso era só uma linha
 * de log no servidor — alerta que exige alguém lembrar de ir procurar não é
 * alerta, e a pessoa do outro lado fica esperando.
 *
 * Nunca lança: falhar em avisar não pode derrubar o atendimento em curso.
 */
export async function avisarRH({ whatsapp, motivo, trecho }) {
  if (!RH_API_URL || !RH_API_TOKEN) {
    console.warn('[rh-client] RH não configurado — alerta NÃO enviado.')
    return { ok: false }
  }
  try {
    const r = await fetch(`${RH_API_URL}/api/integracao/alerta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RH_API_TOKEN}` },
      body: JSON.stringify({ whatsapp, motivo, trecho }),
    })
    if (!r.ok) {
      console.warn(`[rh-client] alerta recusado pelo RH: ${r.status}`)
      return { ok: false }
    }
    return { ok: true }
  } catch (e) {
    console.warn('[rh-client] não consegui avisar o RH:', e.message)
    return { ok: false }
  }
}

/**
 * Quem é este número — funcionário, candidato já inscrito, ou ninguém.
 *
 * Existe porque o robô tratava todo desconhecido como candidato, e
 * perguntava "qual vaga você procura?" para quem só queria uma informação.
 *
 * Também busca por NOME, quando o telefone não diz nada: alguém escreve de
 * um número novo e conta que trabalha na empresa. Isso é identificação MAIS
 * FRACA que o telefone e vem marcado como tal na resposta — é aceitável
 * porque reconhecer alguém aqui não libera dado pessoal nenhum, só libera
 * ser chamado pelo nome.
 *
 * Guardado por um tempo: a pergunta se repete a cada mensagem da conversa, e
 * consultar o RH em todas acrescentaria a latência da rede a cada frase.
 *
 * Nunca lança. Sem resposta, a pessoa cai na triagem, que não presume nada.
 */
const VALIDADE_QUEM_MS = 1000 * 60 * 30
const cacheQuem = new Map()   // chave -> { ficha, buscadoEm }

export async function quemE({ whatsapp, nome } = {}) {
  if (!RH_API_URL || !RH_API_TOKEN) return null

  const telefone = String(whatsapp ?? '').replace(/\D/g, '')
  const chave = nome ? `nome:${nome}` : `tel:${telefone}`
  if (!telefone && !nome) return null

  const guardado = cacheQuem.get(chave)
  if (guardado && Date.now() - guardado.buscadoEm < VALIDADE_QUEM_MS) {
    return guardado.ficha
  }

  const params = new URLSearchParams()
  if (telefone) params.set('whatsapp', telefone)
  if (nome) params.set('nome', nome)

  try {
    const r = await fetch(`${RH_API_URL}/api/integracao/quem?${params}`, {
      headers: { Authorization: `Bearer ${RH_API_TOKEN}` },
      signal: AbortSignal.timeout(6000),
    })
    if (!r.ok) {
      // 404 = RH numa versão sem esta rota. Não é erro de configuração: a
      // pessoa cai na triagem, que funciona sem saber quem ela é.
      if (r.status !== 404) console.warn(`[rh-client] consulta "quem": HTTP ${r.status}`)
      return null
    }
    const j = await r.json()
    const ficha = j?.tipo && j.tipo !== 'desconhecido' ? j : null

    // Busca por nome NÃO é guardada: a próxima mensagem vem do mesmo
    // telefone, e guardar por nome faria o resultado de uma pessoa valer
    // para quem escrevesse o mesmo nome depois.
    if (!nome) cacheQuem.set(chave, { ficha, buscadoEm: Date.now() })
    return ficha
  } catch (e) {
    console.warn('[rh-client] não consegui consultar quem é:', e.message)
    return null
  }
}

/** Só para teste: esquece quem já foi consultado. */
export function _limparCacheQuem() {
  cacheQuem.clear()
}

/** Só para teste: o corpo que sairia daqui, sem enviar nada. */
export function _corpoDaCandidatura(dados) {
  return JSON.parse(montarCorpo(dados))
}
