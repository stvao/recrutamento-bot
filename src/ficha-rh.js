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
import { norm } from './texto.js'

/**
 * As duas frases EXATAS de registro em carteira que o RH sabe ler.
 *
 * O RH procura "já teve registro em carteira" e "nunca teve registro" dentro
 * do resumoExperiencia (score-candidatura, agente-rh e a rota /ficha). O
 * roteiro escrevia outra coisa — "Registro em carteira na função: sim." —, que
 * não casa com nenhuma das duas: o critério Registro caía de nota 1 para 0,3
 * ("Não informou"), a frase da ficha perdia o "(já teve registro)" e, quando a
 * pessoa voltava, a /ficha devolvia temRegistro null e o robô perguntava o
 * registro outra vez. Acontecia em toda ficha feita enquanto o Gemini está
 * fora do ar.
 *
 * São dois repositórios: quem fecha este contrato é o teste.
 */
export const FRASE_REGISTRO = {
  teve: 'Já teve registro em carteira na função.',
  nunca: 'Nunca teve registro na função.',
}

/** A frase de registro para um sim/não/não sei. Null quando não se sabe. */
export function fraseDeRegistro(temRegistro) {
  if (temRegistro === true) return FRASE_REGISTRO.teve
  if (temRegistro === false) return FRASE_REGISTRO.nunca
  return null
}

/**
 * O começo do resumo que o robô manda ao RH.
 *
 * Mora aqui porque o importante é saber TIRÁ-LO de volta: quem volta depois
 * de 7 dias tem o estado montado pela ficha do RH, e o resumo volta com este
 * prefixo. Sem tirar, cada reenvio empilharia "Conversa por WhatsApp (Maria
 * Vitória)." mais uma vez no começo do texto.
 */
export const PREFIXO_RESUMO = 'Conversa por WhatsApp (Maria Vitória).'

/** Campos que vêm iguais dos dois lados. */
const DIRETOS = [
  'vaga', 'cidade', 'cidadeMora', 'bairro', 'tempoExperiencia', 'dataNascimento',
  'disponibilidadeInicio', 'tamanhoCamisa', 'tamanhoBota', 'contatoRecadoNome',
  'contatoRecadoTelefone', 'especialidade', 'ultimaObra', 'anosRegistro', 'nrs',
  'ferramentaPropria', 'conducao', 'cursoEstagio', 'referenciaNome',
  /*
    Estes quatro faltavam, e o que se perdia era o trabalho do recrutador.

    Sem `sinais`, juntarSinais() recomeça do zero e o valor novo grava por
    cima do que o próprio robô tinha acumulado antes ("condiciona à passagem
    adiantada; hesitou sobre ficar longe da família"), contra o "o que se
    percebe acumula". Sem `respostasTecnicas` e `referenciaTelefone`, o que a
    pessoa já respondeu some da conversa.
  */
  'referenciaTelefone', 'respostasTecnicas', 'sinais', 'indicadoPor',
]

const texto = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Um "Sim"/"Não" do RH vira o 'sim'/'nao' da conversa. */
function simNao(v, extras = {}) {
  const t = texto(v)
  if (!t) return null
  for (const [rotulo, valor] of Object.entries(extras)) {
    if (norm(t) === norm(rotulo)) return valor
  }
  if (/^sim/i.test(t)) return 'sim'
  if (/^n[aã]o/i.test(t)) return 'nao'
  return null
}

/**
 * O resumo sem o que é acrescentado a cada envio.
 *
 * O prefixo e a frase de registro entram de novo em toda chamada (ver
 * atendimento.js); voltando com eles dentro, o texto cresceria a cada
 * reenvio.
 */
function resumoLimpo(bruto) {
  const t = texto(bruto)
  if (!t) return null
  const limpo = t
    .replace(PREFIXO_RESUMO, '')
    .replace(FRASE_REGISTRO.teve, '')
    .replace(FRASE_REGISTRO.nunca, '')
    .replace(/\s+/g, ' ')
    .trim()
  return limpo || null
}

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
  estado.aceitaOutrasObras = simNao(f.aceitaOutrasObras) ?? base.aceitaOutrasObras ?? null

  /*
    O que o RECRUTADOR já apurou volta junto.

    Sem estes campos, quem voltava depois de 7 dias era submetido de novo à
    pergunta técnica e à do alojamento, e a confirmação da ligação recomeçava
    do zero — oQueJaSabe() consulta exatamente estes campos para não repetir.

    A rota /ficha do RH ainda não devolve todos; enquanto não devolver, eles
    chegam nulos e nada piora. Quando devolver, a tradução já está pronta.
  */
  estado.confirmouInteresse = simNao(f.confirmouInteresse) ?? base.confirmouInteresse ?? null
  estado.alojamentoFirme = simNao(f.alojamentoFirme, { 'Em dúvida': 'duvida' })
    ?? base.alojamentoFirme ?? null
  estado.avaliacaoTecnica = ({ boa: 'boa', fraca: 'fraca', 'nao respondeu': 'nao_respondeu' })[
    norm(texto(f.avaliacaoTecnica) ?? '')
  ] ?? base.avaliacaoTecnica ?? null

  // Quem recusou CPF/RG não ouve o pedido outra vez — é regra do dono.
  estado.recusouDocumentos = Boolean(f.recusouDocumentos ?? f.temRecusaDocumentos ?? base.recusouDocumentos)

  // O resumo volta LIMPO: o prefixo e a frase de registro entram de novo a
  // cada envio, e voltando dentro do texto eles se repetiriam.
  estado.resumo = resumoLimpo(f.resumoExperiencia) ?? base.resumo ?? null

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
