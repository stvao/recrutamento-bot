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
 * Este telefone é de alguém que trabalha na empresa?
 *
 * Devolve { primeiroNome, funcao, obra, obraEndereco } ou null. É de
 * propósito que não venha mais nada: número de WhatsApp é identificação
 * fraca — celular emprestado é rotina em obra — e o que o robô escreve vira
 * prova. Dado pessoal se resolve com gente.
 *
 * Guardado por um tempo: a pergunta se repete a cada mensagem da conversa, e
 * consultar o RH em todas acrescentaria a latência da rede a cada frase.
 *
 * Nunca lança. Sem resposta, a pessoa é atendida como candidato — que é o
 * comportamento de sempre e não expõe nada.
 */
const VALIDADE_FUNCIONARIO_MS = 1000 * 60 * 30
const cacheFuncionarios = new Map()   // telefone -> { ficha, buscadoEm }

export async function buscarFuncionario(whatsapp) {
  const chave = String(whatsapp ?? '').replace(/\D/g, '')
  if (!chave || !RH_API_URL || !RH_API_TOKEN) return null

  const guardado = cacheFuncionarios.get(chave)
  if (guardado && Date.now() - guardado.buscadoEm < VALIDADE_FUNCIONARIO_MS) {
    return guardado.ficha
  }

  try {
    const r = await fetch(`${RH_API_URL}/api/integracao/funcionario?whatsapp=${encodeURIComponent(chave)}`, {
      headers: { Authorization: `Bearer ${RH_API_TOKEN}` },
      signal: AbortSignal.timeout(6000),
    })
    if (!r.ok) {
      // 404 = RH numa versão sem esta rota. Não é erro de configuração, e
      // atender como candidato continua sendo seguro.
      if (r.status !== 404) console.warn(`[rh-client] consulta de funcionário: HTTP ${r.status}`)
      return null
    }
    const j = await r.json()
    const ficha = j?.encontrado ? j : null
    cacheFuncionarios.set(chave, { ficha, buscadoEm: Date.now() })
    return ficha
  } catch (e) {
    console.warn('[rh-client] não consegui consultar funcionário:', e.message)
    return null
  }
}

/** Só para teste: esquece quem já foi consultado. */
export function _limparCacheFuncionarios() {
  cacheFuncionarios.clear()
}

/** Só para teste: o corpo que sairia daqui, sem enviar nada. */
export function _corpoDaCandidatura(dados) {
  return JSON.parse(montarCorpo(dados))
}
