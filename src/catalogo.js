/**
 * O catálogo do RH: vagas, salários e cidades com obra.
 *
 * Antes a lista morava escrita à mão aqui no robô, salário incluído. O robô
 * informa o valor POR ESCRITO no WhatsApp do candidato — quando a convenção
 * coletiva reajustava o piso, alguém tinha que lembrar de editar um arquivo
 * .js, e enquanto não lembrasse o robô prometia o que a empresa não ia pagar,
 * com a conversa registrada.
 *
 * As cidades vêm junto pelo mesmo motivo: o robô diz "tem alojamento" por
 * escrito para quem está decidindo se muda de cidade. Errar isso faz alguém
 * largar o que tem e chegar sem ter onde dormir.
 *
 * Agora o RH é a fonte, e as duas listas são editadas pela tela.
 *
 * Duas decisões que importam:
 *
 *  1. RESERVA LOCAL. Se o RH estiver fora do ar, o robô continua atendendo
 *     com a última lista que recebeu — e, na falta dela, com a lista abaixo.
 *     Robô mudo é pior que robô com salário de ontem, e ficar mudo por causa
 *     do RH transforma uma indisponibilidade em duas.
 *  2. A reserva NÃO tem salário. Se não dá para confirmar o valor com o RH,
 *     o robô diz "a combinar" em vez de arriscar um número velho. Não saber
 *     é aceitável; prometer errado por escrito, não.
 */
import { norm } from './texto.js'

const RH_API_URL = process.env.RH_API_URL || ''
const RH_API_TOKEN = process.env.RH_API_TOKEN || ''

/** De quanto em quanto tempo reconsultar o RH, quando já se tem a lista. */
const VALIDADE_MS = 1000 * 60 * 15   // 15 min

/**
 * De quanto em quanto tempo tentar, enquanto NUNCA se conseguiu falar com o RH.
 *
 * Num reinício de servidor os dois sobem juntos, e o robô costuma ficar
 * pronto antes: a primeira busca falha. Com um intervalo só, ele passaria os
 * 15 minutos seguintes dizendo "a combinar" para todo mundo, com o RH no ar
 * do lado. Enquanto está na reserva, insiste de minuto em minuto.
 */
const REPETIR_MS = 1000 * 60        // 1 min

/**
 * Lista de reserva, sem salário de propósito (ver decisão 2 acima).
 * Serve só para o robô conseguir conversar enquanto o RH não responde.
 */
const RESERVA = [
  { nome: 'Servente',    salario: null, profissional: false, sinonimos: ['servente', 'ajudante', 'auxiliar', 'meio oficial'] },
  { nome: 'Pedreiro',    salario: null, profissional: true,  sinonimos: ['pedreiro', 'alvenaria'] },
  { nome: 'Carpinteiro', salario: null, profissional: true,  sinonimos: ['carpinteiro', 'carpintaria'] },
  { nome: 'Armador',     salario: null, profissional: true,  sinonimos: ['armador', 'ferreiro'] },
  { nome: 'Serralheiro', salario: null, profissional: true,  sinonimos: ['serralheiro', 'soldador'] },
  { nome: 'Eletricista', salario: null, profissional: true,  sinonimos: ['eletricista', 'eletrica'] },
]

/**
 * Cidades de reserva.
 *
 * Diferente das vagas, aqui o alojamento vem como FALSE em todas: se não dá
 * para confirmar com o RH, é melhor dizer "vou confirmar" do que prometer
 * alojamento que talvez não exista. Prometer errado custa a mudança de
 * alguém.
 */
const CIDADES_RESERVA = [
  { nome: 'Buritama', uf: 'SP', alojamento: false },
  { nome: 'Pereiras', uf: 'SP', alojamento: false },
  { nome: 'Bastos', uf: 'SP', alojamento: false },
  { nome: 'Caraguatatuba', uf: 'SP', alojamento: false },
  { nome: 'Praia Grande', uf: 'SP', alojamento: false },
  { nome: 'Peruíbe', uf: 'SP', alojamento: false },
  { nome: 'Itapevi', uf: 'SP', alojamento: false },
]

let cache = null          // { vagas, cidades, buscadoEm, doRH }
let buscando = null       // promessa em andamento, p/ não consultar em paralelo

/** A lista está boa o bastante para usar sem reconsultar? */
function estaFresca() {
  if (!cache) return false
  const validade = cache.doRH ? VALIDADE_MS : REPETIR_MS
  return cache.doRH && Date.now() - cache.buscadoEm < validade
}

/** Quanto esperar até a próxima tentativa automática. */
export function intervaloDeAtualizacao() {
  return cache?.doRH ? VALIDADE_MS : REPETIR_MS
}

async function buscarNoRH() {
  if (!RH_API_URL || !RH_API_TOKEN) {
    console.warn('[vagas] RH_API_URL/RH_API_TOKEN não configurados — usando a lista de reserva (sem salário).')
    return null
  }
  try {
    const controle = new AbortController()
    const prazo = setTimeout(() => controle.abort(), 5000)
    const r = await fetch(`${RH_API_URL}/api/integracao/vagas`, {
      headers: { Authorization: `Bearer ${RH_API_TOKEN}` },
      signal: controle.signal,
    })
    clearTimeout(prazo)

    if (!r.ok) {
      console.warn(`[vagas] RH respondeu ${r.status} — mantendo a lista anterior.`)
      return null
    }
    const j = await r.json()
    if (!Array.isArray(j.vagas) || j.vagas.length === 0) {
      // Lista vazia é quase certamente erro de configuração, não a empresa
      // sem vagas. Trocar a lista boa por uma vazia deixaria o robô sem ter
      // o que oferecer.
      console.warn('[vagas] RH devolveu lista vazia — mantendo a anterior.')
      return null
    }
    return {
      vagas: j.vagas.map(v => ({
        nome: String(v.nome),
        salario: typeof v.salario === 'number' ? v.salario : null,
        profissional: Boolean(v.profissional),
        sinonimos: Array.isArray(v.sinonimos) ? v.sinonimos : [],
      })),
      cidades: Array.isArray(j.cidades) && j.cidades.length
        ? j.cidades.map(c => ({
            nome: String(c.nome),
            uf: String(c.uf ?? 'SP'),
            alojamento: Boolean(c.alojamento),
          }))
        : CIDADES_RESERVA,
    }
  } catch (e) {
    console.warn('[vagas] não consegui falar com o RH:', e.message)
    return null
  }
}

/**
 * As vagas de agora. Nunca lança e nunca devolve vazio — na pior hipótese
 * devolve a reserva.
 */
export async function getVagas() {
  if (estaFresca()) return cache.vagas

  // Várias mensagens chegando juntas não devem virar várias consultas.
  if (!buscando) {
    buscando = buscarNoRH().finally(() => { buscando = null })
  }
  const doRH = await buscando

  if (doRH) {
    cache = { ...doRH, buscadoEm: Date.now(), doRH: true }
  } else if (!cache) {
    cache = { vagas: RESERVA, cidades: CIDADES_RESERVA, buscadoEm: Date.now(), doRH: false }
  }
  return cache.vagas
}

/** Os apelidos de cada vaga, no formato que o melhorMatch() espera. */
export function termosDasVagas(vagas) {
  return vagas.map(v => ({
    valor: v.nome,
    // O próprio nome sempre entra: uma vaga sem apelido cadastrado ainda
    // precisa ser reconhecida por quem escreve o nome dela.
    termos: [v.nome, ...(v.sinonimos ?? [])].filter(t => norm(t).length > 0),
  }))
}

/**
 * A lista de agora, SEM esperar.
 *
 * O cérebro do robô é síncrono e responde a uma mensagem por vez; fazer ele
 * esperar o RH a cada frase acrescentaria latência a toda conversa. Quem
 * mantém a lista fresca é o server, chamando getVagas() de tempos em tempos.
 * Aqui só se lê o que já está em mãos.
 */
export function vagasAtuais() {
  return cache?.vagas ?? RESERVA
}

/** As cidades de agora, sem esperar. Mesma ideia de vagasAtuais(). */
export function cidadesAtuais() {
  return cache?.cidades ?? CIDADES_RESERVA
}

/** Só para teste: esquece o que foi buscado. */
export function _limparCache() {
  cache = null
  buscando = null
}

/** Diagnóstico: de onde veio a lista que está em uso. */
export function origemDaLista() {
  if (!cache) return 'ainda não buscada'
  return cache.doRH ? 'RH' : 'reserva local (sem salário)'
}
