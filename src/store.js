/**
 * Estado das conversas, em arquivo.
 *
 * Antes ficava só na memória: reiniciar o serviço — o que acontece a cada
 * deploy — apagava toda conversa em andamento, e quem estava respondendo a
 * terceira pergunta voltava para a primeira. Candidato que recomeça do zero
 * costuma desistir.
 *
 * Um arquivo JSON basta e é de propósito: são dezenas de conversas, não
 * milhares. Banco de dados aqui seria mais peça para manter sem ganho
 * nenhum. A gravação é atômica (escreve num temporário e renomeia), então
 * uma queda no meio da escrita não corrompe o arquivo.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ARQUIVO = process.env.ESTADO_ARQUIVO
  || join(process.cwd(), 'dados', 'conversas.json')

/** Sem interação por este tempo, a conversa é considerada abandonada. */
const TTL_MS = 1000 * 60 * 60 * 6      // 6 horas

/**
 * Quanto tempo a conversa abandonada fica guardada para RETOMADA.
 *
 * Diferente do TTL: passadas as 6h a conversa não continua sozinha, mas
 * quem volta em até 7 dias é recebido de onde parou, em vez de começar de
 * novo. É a diferença entre "recomeça tudo" e "só falta o seu nome".
 */
const RETENCAO_MS = 1000 * 60 * 60 * 24 * 7

/** telefone -> { estado, atualizadoEm, iniciadoEm, concluidoEm, escalouEm } */
let sessoes = new Map()
let sujo = false

function carregar() {
  try {
    if (!existsSync(ARQUIVO)) return
    const bruto = JSON.parse(readFileSync(ARQUIVO, 'utf8'))
    sessoes = new Map(Object.entries(bruto.sessoes ?? {}))
    console.log(`[store] ${sessoes.size} conversa(s) recuperada(s) do disco`)
  } catch (e) {
    // Arquivo corrompido não pode derrubar o serviço: melhor começar limpo
    // e atender do que não atender ninguém.
    console.error('[store] não consegui ler o arquivo, começando vazio:', e.message)
    sessoes = new Map()
  }
}

function salvar() {
  if (!sujo) return
  try {
    mkdirSync(dirname(ARQUIVO), { recursive: true })
    const temp = `${ARQUIVO}.tmp`
    writeFileSync(temp, JSON.stringify({
      versao: 1,
      salvoEm: new Date().toISOString(),
      sessoes: Object.fromEntries(sessoes),
    }), 'utf8')
    // Renomear é atômico: ou o arquivo antigo, ou o novo — nunca metade.
    renameSync(temp, ARQUIVO)
    sujo = false
  } catch (e) {
    console.error('[store] falha ao gravar:', e.message)
  }
}

/**
 * Joga fora o que não serve mais para nada.
 *
 * Nada removia sessão: passados os 7 dias de retenção a conversa deixava de
 * ser retomável, mas continuava no Map e no arquivo — carregada inteira na
 * memória a cada arranque e reescrita a cada 5 segundos, com até 20
 * mensagens de histórico cada. Em alguns meses de operação isso vira um
 * arquivo grande sendo regravado o tempo todo por nada.
 *
 * E contaminava as métricas: `iniciadas` contava desde o começo dos tempos,
 * então a taxa de conclusão deste mês vinha diluída por candidato de meio
 * ano atrás — justamente o número que deveria dizer se uma pergunta nova
 * está espantando gente.
 *
 * O corte é a RETENÇÃO, não o TTL: enquanto der para retomar, a conversa
 * fica. Concluída também sai, passado o mesmo prazo — o registro dela já
 * está no RH, que é onde ele importa.
 */
function expirar() {
  const agora = Date.now()
  let removidas = 0
  for (const [telefone, s] of sessoes) {
    if (agora - s.atualizadoEm > RETENCAO_MS) {
      sessoes.delete(telefone)
      removidas++
    }
  }
  if (removidas) {
    console.log(`[store] ${removidas} conversa(s) antiga(s) descartada(s)`)
    sujo = true
  }
  return removidas
}

carregar()
expirar()

// De hora em hora: não é urgente, e varrer o Map a cada mensagem seria
// trabalho repetido para remover o que só muda de status uma vez por dia.
const limpeza = setInterval(expirar, 1000 * 60 * 60)
limpeza.unref?.()

// Grava periodicamente em vez de a cada mensagem: numa conversa ativa são
// muitas escritas seguidas, e o que importa é sobreviver ao reinício.
const timer = setInterval(salvar, 5000)
timer.unref?.()

// Reinício planejado (deploy) grava antes de sair.
for (const sinal of ['SIGINT', 'SIGTERM', 'beforeExit']) {
  process.on(sinal, () => { salvar(); if (sinal !== 'beforeExit') process.exit(0) })
}

export function getEstado(telefone) {
  const s = sessoes.get(telefone)
  if (!s) return null
  if (Date.now() - s.atualizadoEm > TTL_MS) return null
  return s.estado
}

/**
 * Conversa que expirou mas ainda dá para retomar.
 *
 * Devolve null quando não há nada aproveitável: sem sessão, já concluída,
 * ou parada há tempo demais.
 */
export function getAbandonada(telefone) {
  const s = sessoes.get(telefone)
  if (!s || s.concluidoEm) return null
  const parado = Date.now() - s.atualizadoEm
  if (parado <= TTL_MS || parado > RETENCAO_MS) return null
  return { estado: s.estado, paradoHa: parado }
}

export function setEstado(telefone, estado) {
  const anterior = sessoes.get(telefone)
  sessoes.set(telefone, {
    ...anterior,
    estado,
    atualizadoEm: Date.now(),
    iniciadoEm: anterior?.iniciadoEm ?? Date.now(),
  })
  sujo = true
}

/** Marca a conclusão — é o que separa "abandonou" de "terminou". */
export function marcarConcluida(telefone) {
  const s = sessoes.get(telefone)
  if (!s) return
  s.concluidoEm = Date.now()
  sujo = true
}

export function marcarEscalada(telefone) {
  const s = sessoes.get(telefone)
  if (!s || s.escalouEm) return
  s.escalouEm = Date.now()
  sujo = true
}

export function limpar(telefone) {
  sessoes.delete(telefone)
  sujo = true
}

/**
 * Números da operação.
 *
 * A pesquisa sobre triagem por WhatsApp é unânime num ponto: o indicador
 * que importa é a TAXA DE CONCLUSÃO, e quase ninguém mede. Sem isto não dá
 * para saber se uma pergunta a mais no roteiro está espantando candidato.
 */
export function metricas() {
  const agora = Date.now()
  let iniciadas = 0, concluidas = 0, emAndamento = 0, abandonadas = 0, escaladas = 0
  const duracoes = []
  const pararamEm = {}

  for (const s of sessoes.values()) {
    iniciadas++
    if (s.escalouEm) escaladas++
    if (s.concluidoEm) {
      concluidas++
      if (s.iniciadoEm) duracoes.push(s.concluidoEm - s.iniciadoEm)
    } else if (agora - s.atualizadoEm <= TTL_MS) {
      emAndamento++
    } else {
      abandonadas++
      // Em que pergunta a pessoa desistiu. É o que aponta onde mexer.
      const etapa = s.estado?.etapa ?? 'desconhecida'
      pararamEm[etapa] = (pararamEm[etapa] ?? 0) + 1
    }
  }

  const finalizaveis = concluidas + abandonadas
  return {
    iniciadas,
    concluidas,
    emAndamento,
    abandonadas,
    escaladas,
    taxaConclusao: finalizaveis ? Math.round((concluidas / finalizaveis) * 100) : null,
    minutosMedios: duracoes.length
      ? Math.round(duracoes.reduce((a, b) => a + b, 0) / duracoes.length / 60000)
      : null,
    abandonaramNaEtapa: pararamEm,
  }
}

/** Só para teste: finge que a conversa parou há X ms. */
export function _envelhecer(telefone, ms) {
  const s = sessoes.get(telefone)
  if (s) s.atualizadoEm = Date.now() - ms
}

/** Só para teste: força a varredura das antigas. */
export function _expirar() {
  return expirar()
}

/** Só para teste: esvazia sem tocar no disco. */
export function _limparTudo() {
  sessoes = new Map()
}
