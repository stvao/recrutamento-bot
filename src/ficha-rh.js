/**
 * A ficha que o RH já tem vira o ponto de partida da conversa.
 *
 * Quem escreve hoje e volta na semana que vem tinha a conversa recomeçada do
 * zero: o robô guarda a conversa por 7 dias, mas a FICHA fica no RH para
 * sempre. Sem isto, a pessoa ouvia de novo "qual vaga vc procura?" depois de
 * já ter respondido tudo — e ainda virava uma segunda ficha lá.
 *
 * Aqui só a tradução ficha → estado da conversa, para poder ser testada.
 */

/** Campos que vêm iguais dos dois lados. */
const DIRETOS = [
  'vaga', 'cidade', 'cidadeMora', 'bairro', 'tempoExperiencia', 'dataNascimento',
  'disponibilidadeInicio', 'tamanhoCamisa', 'tamanhoBota', 'contatoRecadoNome',
  'contatoRecadoTelefone', 'especialidade', 'ultimaObra', 'anosRegistro', 'nrs',
  'ferramentaPropria', 'conducao', 'cursoEstagio', 'referenciaNome',
]

const texto = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * Monta o estado da conversa a partir do que o RH respondeu.
 *
 * `base` é o estado novo de sempre (modo, whatsapp). O que o RH sabe entra
 * por cima; o que ele não sabe fica null e volta a ser perguntado.
 *
 * O CPF entra só como MARCA ("já informado"): o número fica no RH, não passa
 * pelo robô nem volta para o modelo.
 */
export function estadoDaFicha(resposta, base = {}) {
  const f = resposta?.ficha
  if (!resposta?.tem || !f) return null

  const estado = { ...base, registrado: true, protocolo: resposta.protocolo ?? null }
  for (const campo of DIRETOS) estado[campo] = texto(f[campo]) ?? base[campo] ?? null
  estado.nome = texto(f.nome) ?? base.nome ?? null

  estado.temExperiencia = typeof f.temExperiencia === 'boolean' ? f.temExperiencia : base.temExperiencia ?? null
  estado.temRegistro = typeof f.temRegistro === 'boolean' ? f.temRegistro : base.temRegistro ?? null
  estado.aceitaOutrasObras = /^sim/i.test(f.aceitaOutrasObras ?? '') ? 'sim'
    : /^n[aã]o/i.test(f.aceitaOutrasObras ?? '') ? 'nao' : base.aceitaOutrasObras ?? null

  // Marca, nunca o número: o robô não tem o que fazer com o CPF de novo.
  estado.cpfJaInformado = Boolean(f.temCpf)
  estado.rgJaInformado = Boolean(f.temRg)

  estado.historico = (Array.isArray(resposta.conversa) ? resposta.conversa : [])
    .filter(m => m && typeof m.texto === 'string')
    .map(m => ({ de: m.de === 'maria' ? 'maria' : 'pessoa', texto: m.texto }))
    .slice(-40)

  return estado
}

/** Há quanto tempo foi a última conversa, em milissegundos. Null se não souber. */
export function paradoHaDaFicha(resposta, agora = Date.now()) {
  const quando = resposta?.ultimaConversaEm ? Date.parse(resposta.ultimaConversaEm) : NaN
  return Number.isFinite(quando) ? Math.max(0, agora - quando) : null
}
