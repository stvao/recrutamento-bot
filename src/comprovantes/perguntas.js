/**
 * Comprovantes — as perguntas que o robô faz ("qual a obra?", "qual o
 * valor?", "quem pagou?") e a leitura da resposta de "quem pagou?".
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 */
import { nomesDe, pagadoresQueServem, cidadeDe } from './lancamento.js'
import { moeda } from './formato.js'

/**
 * "Quem pagou?" — com a lista numerada, que é como se responde mais rápido.
 *
 * Mostra o que já entendeu antes de perguntar, igual à pergunta da obra: sem
 * isso a pessoa não sabe se ele leu o resto e acaba redigitando tudo.
 *
 * A saída faz parte da pergunta. Comprovante de material comprado pela
 * empresa não foi bancado por sócio nenhum, e sem uma forma de dizer isso a
 * pessoa ficaria sem resposta possível — e o comprovante, parado.
 */
export function perguntarPagador(pendente, dados, socios) {
  const linhas = []

  const sabido = [
    dados.obra, dados.descricao,
    dados.tipo ? dados.tipo.replace(/_/g, ' ').toLowerCase() : null,
    moeda(dados.valor),
  ].filter(Boolean)
  if (sabido.length) linhas.push(`Anotei: ${sabido.join(' · ')}`)

  const pergunta = 'Só falta: *quem pagou*?'
  pendente.ultimaPergunta = pergunta
  linhas.push(pergunta)

  socios.forEach((nome, i) => linhas.push(`${i + 1}) ${nome}`))
  linhas.push('_(responde o número, o nome, *empresa* se a empresa pagou direto, ou *pular* se não sabe)_')

  pendente.opcoesPagador = socios
  return linhas.join('\n')
}

/**
 * "Li R$ X no comprovante. Confirma?" — quando o valor veio só da imagem e a
 * leitura não é de confiança alta.
 *
 * Antes esse valor era lançado direto, com um aviso para conferir na
 * aprovação. Só que quem aprova vê dezenas de gastos e o aviso vira
 * paisagem: 1.500 lido onde era 1.800 passava, e só aparecia no fechamento
 * do mês. Quem mandou a foto tem o papel na mão — é a pessoa certa para
 * conferir, e a hora certa é agora.
 *
 * A lista de obras numerada é apagada aqui: a resposta a esta pergunta é um
 * número, e com a lista guardada um "3" (um café de R$ 3) trocaria a obra
 * que já estava certa.
 */
export function perguntarValorLido(pendente, dados) {
  const linhas = []

  const sabido = [
    dados.obra, dados.descricao,
    dados.tipo ? dados.tipo.replace(/_/g, ' ').toLowerCase() : null,
  ].filter(Boolean)
  if (sabido.length) linhas.push(`Anotei: ${sabido.join(' · ')}`)

  const pergunta = `Li *${moeda(dados.valor)}* no comprovante. Confirma? Responde *sim* ou manda o valor certo.`
  pendente.ultimaPergunta = pergunta
  pendente.opcoes = null
  linhas.push(pergunta)
  return linhas.join('\n')
}

/**
 * "É da <obra>, como das outras vezes?" — quando falta a obra e o fornecedor
 * tem hábito (ver habito.js).
 *
 * No lugar da lista inteira de obras. É uma PERGUNTA: o robô nunca lança por
 * hábito — obra errada é o pior erro, e ninguém percebe. "sim" confirma;
 * qualquer outra coisa segue o caminho de sempre.
 */
export function perguntarObraDoHabito(pendente, dados, obra, falta) {
  const linhas = []
  const sabido = [
    dados.estabelecimento, dados.descricao !== dados.estabelecimento ? dados.descricao : null,
    dados.tipo ? dados.tipo.replace(/_/g, ' ').toLowerCase() : null,
    moeda(dados.valor),
  ].filter(Boolean)
  if (sabido.length) linhas.push(`Anotei: ${sabido.join(' · ')}`)

  const pergunta = `É da *${obra}*, como das outras vezes? Responde *sim* ou diz a obra.`
  pendente.ultimaPergunta = pergunta
  pendente.opcoes = null
  linhas.push(pergunta)
  if (falta.includes('valor')) linhas.push('E qual foi o *valor*?')
  return linhas.join('\n')
}

/** "é isso mesmo" — as formas de confirmar o valor lido. */
export const CONFIRMA_VALOR = /^\s*(sim|s|isso|isso mesmo|[eé] isso|[eé] isso mesmo|confirma|confirmo|confirmado|ok|okay|certo|correto|t[aá] certo|est[aá] certo|exato|exatamente|👍)\s*[!.]*\s*$/i

/**
 * "não é esse" — sem dizer qual é.
 *
 * Separado do resto porque esta resposta não é informação sobre o gasto:
 * guardada junto com a legenda, "não" iria parar na descrição do lançamento.
 * O robô só pergunta de novo.
 */
export const NEGA_VALOR = /^\s*(n|n[aã]o|errado|t[aá] errado|est[aá] errado|n[aã]o [eé] isso|n[aã]o [eé] esse|incorreto)\s*[!.]*\s*$/i

/** "não foi sócio nenhum" — as formas de dizer isso. */
const PULAR_PAGADOR = /^\s*(pular|pula|nenhum|ningu[eé]m|n[aã]o sei|nao sei|sei l[aá]|-)\s*[?!.]*\s*$/i

/**
 * "A empresa pagou" é uma resposta, não um "pular".
 *
 * Tratada como pular, o gasto ia sem pagador — e o sistema de obras grava
 * gasto sem pagador como reembolso devido a quem o lançou, que no robô é o
 * dono do token. Uma dívida com quem não gastou nada, e o custo arriscando
 * sair duas vezes: para o fornecedor e como "reembolso".
 */
const EMPRESA_PAGOU = /^\s*(a\s+)?(empresa|firma)(\s+pagou)?\s*[?!.]*\s*$|^\s*(foi\s+a\s+empresa|pela\s+empresa|pago\s+pela\s+empresa)\s*[?!.]*\s*$/i

/**
 * Lê a resposta de "quem pagou?": número, nome, ou uma saída.
 *
 * O número é o caminho mais usado, porque a lista acabou de ser mostrada. O
 * nome existe para quem responde sem olhar a lista, que é o normal de quem
 * está na obra com o celular na mão.
 */
export function lerRespostaDePagador(texto, opcoes) {
  const bruto = (texto ?? '').trim()
  if (!bruto) return { nome: null, pulou: false }

  if (EMPRESA_PAGOU.test(bruto)) return { nome: null, pulou: true, empresa: true }
  if (PULAR_PAGADOR.test(bruto)) return { nome: null, pulou: true }

  const so = bruto.replace(/[^\d]/g, '')
  if (/^\d{1,2}$/.test(bruto.replace(/[^\d]/g, '')) && so && opcoes.length) {
    const i = Number(so) - 1
    if (i >= 0 && i < opcoes.length) return { nome: opcoes[i], pulou: false }
  }

  const servem = pagadoresQueServem(bruto, opcoes)
  if (servem.length === 1) return { nome: servem[0], pulou: false }
  if (servem.length > 1) return { nome: null, pulou: false, ambiguo: servem }

  return { nome: null, pulou: false }
}

/** Monta a pergunta. Quem controla a espera é a fila. */
export function perguntar(pendente, falta, obras) {
  pendente.jaPerguntou = true

  const linhas = []
  const d = pendente.dados

  // Mostra o que JÁ entendeu antes de perguntar. Sem isso a pessoa não sabe
  // se ele leu o resto, e acaba redigitando tudo.
  const sabido = [
    d.obra, d.descricao,
    d.tipo ? d.tipo.replace(/_/g, ' ').toLowerCase() : null,
    moeda(d.valor),
  ].filter(Boolean)
  if (sabido.length) linhas.push(`Anotei: ${sabido.join(' · ')}`)

  /*
    A pessoa escreveu algo que serve para MAIS DE UMA obra — a cidade,
    tipicamente. Aí a pergunta é entre essas, e não entre todas: é mais
    curta, e mostra que ele entendeu o que foi dito em vez de ignorar.
  */
  const candidatos = d?.candidatos ?? null
  const nomes = nomesDe(obras)

  /*
    A pergunta em si fica guardada à parte.

    A cobrança, horas depois, repete ELA — não a última linha do que foi
    dito. A última linha costuma ser a lista de obras, e repetir só a lista
    não lembra ninguém do que estava sendo perguntado.
  */
  /*
    Dois valores na mesma linha — a pergunta diz QUAIS.

    Sem isso, quem escreveu "material 2500,00 e frete 300,00" recebia um
    "qual foi o valor?" seco e concluía que o robô não tinha lido nada. E
    escolher um dos dois em silêncio era pior: lançava o número errado, que
    ninguém percebe até fechar o mês.
  */
  const doisValores = d?.valorAmbiguo?.length > 1 ? d.valorAmbiguo : null

  const pergunta = candidatos?.length
    ? 'Aí tem mais de uma obra. É qual delas?'
    : doisValores
      ? `Vi dois valores aí (${doisValores.join(' e ')}). Qual é o do comprovante?`
      : falta.includes('obra') && falta.includes('valor')
        ? 'Só faltou a *obra* e o *valor*. Me manda os dois?'
        : falta.includes('obra')
          ? 'De qual *obra* é esse gasto?'
          : 'Qual foi o *valor*?'

  pendente.ultimaPergunta = pergunta
  linhas.push(pergunta)

  /*
    A lista é NUMERADA, e cada obra vem com a cidade.

    Antes saía "(EE PROFA TSUYA OHNO KIMURA · EE OSWALDO LUIZ SANCHES
    TOSCHI · …)" numa linha só: ninguém sabia que dava para responder "2", e
    o nome oficial da escola não diz que ela é a de Praia Grande — que é como
    a equipe a chama.
  */
  const comCidade = (nome) => {
    const o = (obras ?? []).find(x => (typeof x === 'string' ? x : x?.nome) === nome)
    const cidade = cidadeDe(o)
    return cidade && cidade.length <= 40 ? `${nome} — ${cidade}` : nome
  }

  if (candidatos?.length) {
    candidatos.forEach((o, i) => linhas.push(`${i + 1}) ${comCidade(o)}`))
    if (falta.includes('valor')) linhas.push('E qual foi o *valor*?')
  }

  if (!candidatos?.length && falta.includes('obra') && nomes.length && nomes.length <= 12) {
    nomes.forEach((o, i) => linhas.push(`${i + 1}) ${comCidade(o)}`))
  }

  if (candidatos?.length || (falta.includes('obra') && nomes.length && nomes.length <= 12)) {
    linhas.push(falta.includes('valor')
      ? '_(responde o número e o valor, tipo "2 150" — ou escreve a obra)_'
      : '_(responde o número — ou escreve a obra ou a cidade)_')
  }

  // Guarda as opções numeradas: responder "1" é o jeito mais rápido, e é o
  // que a pessoa vai fazer se o robô acabou de listar 1) e 2).
  //
  // SÓ quando a pergunta é sobre a obra. Guardadas também ao perguntar o
  // valor, a resposta "3" (um café de R$ 3) virava "a obra 3" e trocava a
  // obra que já estava certa.
  const perguntaObra = candidatos?.length || falta.includes('obra')
  pendente.opcoes = !perguntaObra ? null
    : candidatos?.length ? candidatos : (nomes.length <= 12 ? nomes : null)

  return linhas.join('\n')
}
