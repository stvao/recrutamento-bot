/**
 * O que o robô lembra de um dia para o outro.
 *
 * Duas coisas, guardadas juntas porque as duas nascem da mesma conversa e
 * morrem no mesmo arquivo:
 *
 * 1. O QUE JÁ FOI LANÇADO. Serve para desconfiar de comprovante repetido e
 *    para o resumo do fim do dia. O sistema de obras sabe disso melhor que
 *    ninguém, mas o token daqui só cria — não lê nada. Então o robô guarda o
 *    que ele mesmo mandou, que é o suficiente: duplicata que interessa é a
 *    que passa por ele duas vezes.
 *
 * 2. OS APELIDOS QUE VOCÊ USA. Quando ele não reconhece o nome escrito,
 *    pergunta e você escolhe da lista — e é aí que ele aprende. "escola do
 *    zé" vira um apelido daquela obra, e da próxima vez ele acerta sozinho.
 *    Sem isto ele erraria igual para sempre, e a mesma pergunta voltaria
 *    toda semana.
 *
 * Um arquivo JSON, como o store.js das conversas e pelo mesmo motivo: são
 * dezenas de lançamentos por dia, não milhares, e banco aqui seria mais peça
 * para manter sem ganho nenhum. Gravação atômica — escreve num temporário e
 * renomeia —, então uma queda no meio não corrompe.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { norm } from './texto.js'

const ARQUIVO = process.env.GASTOS_MEMORIA
  || join(process.cwd(), 'dados', 'memoria-gastos.json')

/**
 * Por quantos dias um lançamento continua servindo de comparação.
 *
 * Curto de propósito. Comprovante repetido aparece em dias próximos — a
 * mesma nota mandada de novo, ou o mesmo pagamento lançado por duas pessoas.
 * Guardar meses transformaria toda compra mensal recorrente (o aluguel da
 * caçamba, a diária do mesmo pedreiro) em suspeita de duplicata, e aí o
 * aviso vira ruído e ninguém lê mais.
 */
const DIAS_DE_COMPARACAO = Number(process.env.GASTOS_DIAS_DUPLICATA || 30)

let dados = { lancamentos: [], apelidos: {}, grupo: null }
let sujo = false

function carregar() {
  try {
    if (!existsSync(ARQUIVO)) return
    const lido = JSON.parse(readFileSync(ARQUIVO, 'utf8'))
    dados = {
      lancamentos: Array.isArray(lido.lancamentos) ? lido.lancamentos : [],
      apelidos: lido.apelidos ?? {},
      grupo: lido.grupo ?? null,
    }
  } catch (e) {
    // Arquivo corrompido não pode derrubar o serviço: melhor começar sem
    // memória e atender do que não atender ninguém.
    console.error('[memoria] não consegui ler, começando vazio:', e.message)
  }
}

function salvar() {
  if (!sujo) return
  try {
    mkdirSync(dirname(ARQUIVO), { recursive: true })
    const temp = `${ARQUIVO}.tmp`
    writeFileSync(temp, JSON.stringify(dados), 'utf8')
    renameSync(temp, ARQUIVO)
    sujo = false
  } catch (e) {
    console.error('[memoria] falha ao gravar:', e.message)
  }
}

carregar()

// Grava de tempos em tempos, e não a cada mudança: numa hora movimentada são
// muitas escritas seguidas, e o que importa é sobreviver ao reinício.
const timer = setInterval(salvar, 5000)
timer.unref?.()
for (const sinal of ['SIGINT', 'SIGTERM', 'beforeExit']) process.on(sinal, salvar)

// ─── 1. O que já foi lançado ───────────────────────────────────────────────

/** Anota um lançamento. `resultado` é 'lancado' ou 'caixa'. */
export function anotarLancamento({ obra, valor, descricao, categoria, de, resultado, idMensagem }) {
  dados.lancamentos.push({
    obra: obra ?? null,
    valor: valor ?? null,
    descricao: descricao ?? null,
    categoria: categoria ?? null,
    de: de ?? null,
    resultado,
    idMensagem: idMensagem ?? null,
    quando: Date.now(),
  })

  // Joga fora o que já não serve para comparar nem para o resumo. Sem isto o
  // arquivo cresceria para sempre e seria relido inteiro a cada arranque.
  const corte = Date.now() - DIAS_DE_COMPARACAO * 24 * 60 * 60 * 1000
  dados.lancamentos = dados.lancamentos.filter(l => l.quando >= corte)

  sujo = true
}

/**
 * Já mandaram um igual a este?
 *
 * "Igual" é MESMA OBRA e MESMO VALOR. Descrição não entra: a mesma compra
 * costuma ser descrita de jeitos diferentes por pessoas diferentes, e exigir
 * que ela bata deixaria passar justamente a duplicata que vem de duas
 * pessoas mandando o mesmo comprovante.
 *
 * Devolve o mais recente, ou null. Nunca decide nada sozinho: valor repetido
 * é comum de verdade — dois sacos de cimento no mesmo dia, a diária do mesmo
 * pedreiro na semana seguinte. Quem sabe se é duplicata é quem pagou.
 */
export function parecidoCom({ obra, valor }, ignorarIdMensagem = null) {
  if (!obra || valor == null) return null

  const alvo = norm(obra)
  const iguais = dados.lancamentos
    .filter(l => l.resultado === 'lancado'
      && l.valor === valor
      && norm(l.obra ?? '') === alvo
      && l.idMensagem !== ignorarIdMensagem)
    .sort((a, b) => b.quando - a.quando)

  return iguais[0] ?? null
}

/** O que entrou num dia. `dia` é o começo do dia, em ms. */
export function doDia(dia = comecoDeHoje()) {
  const fim = dia + 24 * 60 * 60 * 1000
  return dados.lancamentos.filter(l => l.quando >= dia && l.quando < fim)
}

export function comecoDeHoje() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// ─── 2. Os apelidos que você usa ───────────────────────────────────────────

/**
 * Aprende que uma palavra sua quer dizer uma obra.
 *
 * Só é chamado quando a pessoa CONFIRMOU qual era — escolhendo da lista
 * numerada, tipicamente. Aprender de um palpite propagaria o erro: uma vez
 * que ele guardasse "areia" como apelido de uma obra, toda compra de areia
 * iria para lá.
 *
 * Guarda no máximo três palavras: "escola do zé" vale, um parágrafo inteiro
 * não — casaria com qualquer coisa depois.
 */
export function aprenderApelido(termo, obra) {
  const chave = norm(termo)
  if (!chave || !obra) return false
  if (chave.length < 3 || chave.split(' ').length > 3) return false

  // Já conhecido e apontando para a mesma obra: nada a fazer.
  if (dados.apelidos[chave] === obra) return false

  if (dados.apelidos[chave]) {
    console.log(`[memoria] apelido "${chave}" mudou de obra: ${dados.apelidos[chave]} → ${obra}`)
  } else {
    console.log(`[memoria] aprendi que "${chave}" é ${obra}`)
  }
  dados.apelidos[chave] = obra
  sujo = true
  return true
}

/**
 * Os apelidos aprendidos, agrupados por obra.
 *
 * Cada apelido vale como FRASE INTEIRA, e não como palavra solta. "escola do
 * ze" é o nome que a pessoa usa para aquela obra; procurar as palavras dele
 * separadamente não acharia nada, porque "escola" e "do" são genéricas e
 * "ze" é curta demais para valer sozinha.
 *
 * Só valem os apelidos de obras que ainda existem — obra encerrada não deve
 * voltar por um apelido velho.
 */
export function apelidosPorObra(obrasAtuais) {
  const nomes = new Set((obrasAtuais ?? []).map(o => (typeof o === 'string' ? o : o?.nome)).filter(Boolean))
  const porObra = new Map()

  for (const [termo, obra] of Object.entries(dados.apelidos)) {
    if (!nomes.has(obra)) continue
    porObra.set(obra, [...(porObra.get(obra) ?? []), termo])
  }
  return porObra
}

export function apelidosAprendidos() {
  return { ...dados.apelidos }
}

// ─── Onde falar ────────────────────────────────────────────────────────────

/**
 * O grupo de onde vêm os comprovantes.
 *
 * Guardado quando chega o primeiro, e usado pelo resumo do dia — que sai por
 * conta própria, sem ninguém ter escrito nada, e portanto sem uma mensagem a
 * que responder. Sem isto o resumo não teria para onde ir.
 */
export function lembrarGrupo(chat) {
  if (!chat || dados.grupo === chat) return
  dados.grupo = chat
  sujo = true
}

export function grupoLembrado() {
  return dados.grupo
}

/** Só para teste: esquece tudo, sem tocar no disco. */
export function _limpar() {
  dados = { lancamentos: [], apelidos: {}, grupo: null }
}
