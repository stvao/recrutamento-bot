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

/**
 * Por quanto tempo a conversa simplesmente CONTINUA.
 *
 * Eram 6 horas, que é pouco para quem trabalha em obra: a pessoa escreve de
 * noite e responde de manhã. Com 6 h, a resposta da manhã caía fora do prazo.
 * Três dias cobrem o ritmo real de quem procura serviço sem tratar como
 * "retomada" o que é só a resposta do dia seguinte.
 */
const TTL_MS = 1000 * 60 * 60 * 24 * 3   // 3 dias

/**
 * Quanto tempo a conversa parada fica guardada para RETOMADA.
 *
 * Passado o TTL a conversa não continua sozinha, mas quem volta em até 7
 * dias é recebido de onde parou, em vez de começar de novo.
 */
const RETENCAO_MS = 1000 * 60 * 60 * 24 * 7

/**
 * Esta sessão ainda pode ser retomada?
 *
 * Antes, conversa CONCLUÍDA não podia. Só que "concluída" é marcado quando a
 * ficha é gravada pela primeira vez — logo que há nome, vaga e cidade, bem no
 * começo. Quem respondia isso e voltava no outro dia caía fora da retomada e
 * recebia de novo "qual função você procura?". Agora a retomada vale para
 * qualquer conversa guardada, concluída ou não.
 */
export function podeRetomar(sessao, agora = Date.now()) {
  if (!sessao?.estado) return false
  const parado = agora - sessao.atualizadoEm
  return parado > TTL_MS && parado <= RETENCAO_MS
}

/** Para teste: os prazos em vigor. */
export const _prazos = () => ({ TTL_MS, RETENCAO_MS })

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

/*
  Reinício planejado (deploy) grava antes de sair — e SÓ isso.

  Este arquivo é importado antes de o server.js registrar o desligamento
  organizado dele, e o ouvinte de SIGINT daqui chamava process.exit(0) na
  hora: o handler do server nunca rodava. A cada pm2 restart morriam as
  mensagens em andamento — texto esperando na rajada, chamada ao Gemini,
  resposta na pausa de digitação —, e o WhatsApp já as tinha confirmado, então
  não voltavam. Quem decide quando sair é o server.js; aqui só se grava, no
  'exit', que é síncrono.
*/
process.on('exit', salvar)

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
  if (!podeRetomar(s)) return null
  return { estado: s.estado, paradoHa: Date.now() - s.atualizadoEm }
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

/** As conversas guardadas, para o lembrete de cadastro parado decidir. */
export function sessoesParaLembrete() {
  return [...sessoes.entries()]
}

/**
 * Registra que o lembrete saiu.
 *
 * NÃO mexe em `atualizadoEm`: o relógio da conversa é o da última mensagem
 * de verdade. Se o lembrete reiniciasse o prazo, a conversa nunca expiraria.
 * Entra no histórico para o modelo saber o que foi dito quando ela voltar.
 */
export function marcarLembrado(telefone, texto) {
  const s = sessoes.get(telefone)
  if (!s?.estado) return
  s.estado = {
    ...s.estado,
    lembradoEm: Date.now(),
    historico: [...(s.estado.historico ?? []), { de: 'maria', texto }].slice(-40),
  }
  sujo = true
}

/**
 * Desfaz a marca do lembrete quando o envio falhou.
 *
 * A marca é posta ANTES de enviar, para ninguém receber duas vezes. Se o
 * envio falha, sem isto a pessoa fica marcada como lembrada sem nunca ter
 * recebido nada — e o lembrete é único por regra.
 */
export function desmarcarLembrado(telefone, texto) {
  const s = sessoes.get(telefone)
  if (!s?.estado) return
  const historico = (s.estado.historico ?? []).filter(m => !(m.de === 'maria' && m.texto === texto))
  s.estado = { ...s.estado, lembradoEm: null, historico }
  sujo = true
}

/**
 * O endereço de verdade desta conversa no WhatsApp.
 *
 * Conversa @lid sem telefone conhecido tem como chave os dígitos do próprio
 * LID — um "telefone" que não existe. Guardando o jid original, o lembrete de
 * 24h e o pedido de documentos (que saem fora da conversa, horas depois e
 * sobrevivendo a reinício) chegam a quem devem.
 */
export function anotarJid(telefone, jid) {
  if (!telefone || !jid || telefone === jid) return
  const s = sessoes.get(telefone)
  if (s) {
    if (s.jid === jid) return
    s.jid = jid
  } else {
    sessoes.set(telefone, { jid, atualizadoEm: Date.now(), iniciadoEm: Date.now() })
  }
  sujo = true
}

/** O jid guardado desta conversa, se houver. */
export function jidDe(telefone) {
  return sessoes.get(telefone)?.jid ?? null
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
