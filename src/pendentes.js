/**
 * Comprovantes esperando você responder.
 *
 * Existe separado por duas razões que se juntam:
 *
 * 1. ESPERAR HORAS. "Às vezes estou ocupado, e posso não ver a mensagem."
 *    Meia hora não serve — quem está na obra vê o celular quando dá. Mas
 *    esperar um dia segurando arquivos de 20 MB na memória derrubaria o
 *    processo, então o arquivo vai para o DISCO e só volta na hora de enviar.
 *
 * 2. SOBREVIVER AO REINÍCIO. Estando em disco, um deploy no meio da tarde
 *    não engole mais nada: ao subir, o robô relê o que estava esperando e
 *    continua de onde parou. Antes a foto sumia e quem tinha respondido não
 *    recebia nada.
 *
 * O que fica na memória é só a ficha — quem mandou, o que escreveu, a qual
 * pergunta pertence. Poucos bytes por comprovante.
 */
import {
  readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, renameSync,
} from 'node:fs'
import { join } from 'node:path'

const PASTA = process.env.GASTOS_PENDENTES_DIR
  || join(process.cwd(), 'dados', 'pendentes')

/** id -> ficha (sem o arquivo, que fica no disco). */
const fichas = new Map()

function garantirPasta() {
  if (!existsSync(PASTA)) mkdirSync(PASTA, { recursive: true })
}

const caminhoArquivo = (id) => join(PASTA, `${id}.bin`)
const caminhoFicha = (id) => join(PASTA, `${id}.json`)

/**
 * Um id de arquivo que não dependa do id da mensagem.
 *
 * O id do WhatsApp vem do provedor e pode conter qualquer coisa; usado como
 * nome de arquivo, uma barra ou um ".." escreveria fora da pasta.
 */
function idSeguro(idMensagem) {
  return String(idMensagem ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60)
    || `p${Date.now()}${Math.random().toString(36).slice(2, 8)}`
}

/** Grava a ficha. Atômico: escreve num temporário e renomeia. */
function gravarFicha(p) {
  try {
    garantirPasta()
    const { arquivo, enviar, ...ficha } = p
    const temp = `${caminhoFicha(p.id)}.tmp`
    writeFileSync(temp, JSON.stringify(ficha), 'utf8')
    renameSync(temp, caminhoFicha(p.id))
  } catch (e) {
    console.error('[pendentes] não consegui gravar a ficha:', e.message)
  }
}

/**
 * Guarda um comprovante que vai esperar.
 *
 * O arquivo sai da memória aqui: quem precisar dele depois chama
 * `arquivoDe()`. Falhar em gravar não é fatal — o comprovante continua na
 * memória desta execução e só se perde num reinício, o que é melhor que
 * recusá-lo por causa de disco cheio.
 */
export function guardar(p) {
  const id = p.id ?? idSeguro(p.idMensagem)
  const ficha = { ...p, id }

  try {
    garantirPasta()
    writeFileSync(caminhoArquivo(id), p.arquivo)
    ficha.emDisco = true
    // Só solta da memória depois de ter certeza de que o disco tem.
    delete ficha.arquivo
  } catch (e) {
    console.error('[pendentes] não consegui gravar o arquivo, mantendo em memória:', e.message)
    ficha.emDisco = false
  }

  fichas.set(id, ficha)
  gravarFicha(ficha)
  return ficha
}

/** Anota o que mudou (uma resposta nova, a pergunta que foi feita). */
export function atualizar(p) {
  fichas.set(p.id, p)
  gravarFicha(p)
  return p
}

/** O arquivo, venha ele do disco ou da memória. */
export function arquivoDe(p) {
  if (p.arquivo) return p.arquivo
  try {
    return readFileSync(caminhoArquivo(p.id))
  } catch (e) {
    console.error(`[pendentes] arquivo de ${p.id} não está mais no disco:`, e.message)
    return null
  }
}

/** Tira da lista e apaga do disco — resolvido, não some sem deixar rastro. */
export function remover(id) {
  fichas.delete(id)
  for (const caminho of [caminhoArquivo(id), caminhoFicha(id)]) {
    try { if (existsSync(caminho)) unlinkSync(caminho) } catch { /* disco não é crítico aqui */ }
  }
}

export function porId(id) {
  return fichas.get(id) ?? null
}

/** Os de uma pessoa, do mais antigo para o mais novo. */
export function doRemetente(de) {
  return [...fichas.values()].filter(p => p.de === de).sort((a, b) => a.criadoEm - b.criadoEm)
}

export function todos() {
  return [...fichas.values()]
}

export function quantos() {
  return fichas.size
}

/**
 * Acha o comprovante a que uma mensagem citada se refere.
 *
 * Vale citar a FOTO ou a PERGUNTA que o robô fez — quem responde no WhatsApp
 * faz as duas coisas, e as duas querem dizer a mesma. É isto que permite
 * responder fora de ordem: cada resposta diz sozinha a qual comprovante
 * pertence, sem depender de sequência.
 */
export function porCitacao(de, idCitado) {
  if (!idCitado) return null
  return doRemetente(de).find(p =>
    p.idMensagem === idCitado || p.idPergunta === idCitado) ?? null
}

/**
 * Relê do disco o que ficou esperando.
 *
 * Chamado no arranque. O arquivo continua onde estava; só a ficha volta para
 * a memória. Ficha sem arquivo (disco mexido à mão, limpeza pela metade) é
 * descartada em silêncio: melhor perder uma que subir e quebrar em todas.
 */
export function carregar() {
  try {
    if (!existsSync(PASTA)) return 0
    let recuperados = 0

    for (const nome of readdirSync(PASTA)) {
      if (!nome.endsWith('.json')) continue
      try {
        const ficha = JSON.parse(readFileSync(join(PASTA, nome), 'utf8'))
        if (!ficha?.id) continue
        if (ficha.emDisco && !existsSync(caminhoArquivo(ficha.id))) {
          remover(ficha.id)
          continue
        }
        // O canal de envio é uma função: não sobrevive ao disco, e quem
        // reprocessar precisa reencontrá-lo. Fica sem, e o aviso vira log.
        fichas.set(ficha.id, ficha)
        recuperados++
      } catch {
        // Ficha corrompida não pode impedir o robô de subir.
      }
    }

    if (recuperados) console.log(`[pendentes] ${recuperados} comprovante(s) recuperado(s) do disco`)
    return recuperados
  } catch (e) {
    console.error('[pendentes] não consegui reler a pasta:', e.message)
    return 0
  }
}

/** Só para teste: esvazia a memória sem apagar o disco. */
export function _esquecer() {
  fichas.clear()
}
