/**
 * Comprovantes — a conversa: o texto que chega sem arquivo (resposta a uma
 * pergunta, legenda atrasada, "pendentes", "cancelar tudo", "ping").
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 */
import { visaoDisponivel } from './ia-visao.js'
import { obrasConfigurado } from './obras-client.js'
import { ehVocabularioConhecido } from './lancamento.js'
import { lerRespostaDePagador, CONFIRMA_VALOR, NEGA_VALOR } from './perguntas.js'
import { processarUmaVez, entregar, timersLegenda } from './processar.js'
import { paraCaixa } from './saida.js'
import { apelidoDoItem, faz } from './formato.js'
import * as pendentes from './pendentes.js'
import * as memoria from './memoria.js'

/**
 * Palavras que perguntam se ele está vivo.
 *
 * Existe porque a primeira coisa que se faz ao ligar o robô é mandar um
 * "oi" no grupo — e ele fica calado, de propósito, já que só reage a
 * comprovante. O silêncio é o certo na operação e é péssimo na hora de
 * instalar: não dá para distinguir "funcionando" de "nem conectou".
 */
export const PERGUNTAS_DE_TESTE = /^\s*(ping|teste|testando|robo|robô|status|voce esta ai|você está aí|ta ai|tá aí)\s*[?!.]*\s*$/i

/**
 * Texto solto: uma resposta, ou a legenda que faltava.
 *
 * A CITAÇÃO manda. Com três comprovantes esperando, é ela que diz a qual a
 * resposta pertence — e é isso que libera responder fora de ordem.
 */
export function responderTexto(de, texto, respondendoA, enviar) {
  const meus = pendentes.doRemetente(de)
  if (!meus.length || !texto?.trim()) return null

  // 1) Citou alguma coisa: vale o que foi citado.
  let alvo = pendentes.porCitacao(de, respondendoA)

  // 2) Não citou. Se só um está esperando resposta, é ele — não há dúvida.
  if (!alvo) {
    const perguntados = meus.filter(p => p.perguntadoEm)

    /*
      "Manda o número dele": o robô pedia, mas o número nunca funcionava —
      a lista voltava, porque a escolha só era lida DEPOIS de já haver um
      comprovante-alvo. E, escolhido, a resposta seguinte sem citação caía
      de novo na lista. Agora o número escolhe aqui, e o escolhido fica em
      foco por alguns minutos para as respostas seguintes.
    */
    const so = texto.trim().replace(/[).\s]+$/, '')
    const comLista = perguntados.find(p => p.opcoesPendentes?.length)
    if (/^\d{1,2}$/.test(so) && comLista) {
      const dito = escolherPeloNumero(comLista.opcoesPendentes, so)
      if (dito) return dito
    }
    const emFoco = perguntados.find(p => p.focoAte > Date.now())

    if (emFoco) alvo = emFoco
    else if (perguntados.length === 1) alvo = perguntados[0]
    else if (perguntados.length > 1) {
      // Vários esperando e nenhuma citação: adivinhar aqui é o que faz
      // resposta cair no comprovante errado, que é pior que perguntar.
      const linhas = [`Tenho ${perguntados.length} comprovantes esperando resposta. Esta é de qual?`]
      perguntados.forEach((p, i) => linhas.push(`${i + 1}) ${apelidoDoItem(p)}`))
      linhas.push('')
      linhas.push('Responde *citando* a mensagem daquele comprovante — ou manda o número dele.')
      // Guarda a numeração para "1" funcionar como escolha.
      for (const p of perguntados) { p.opcoesPendentes = perguntados.map(x => x.id); pendentes.atualizar(p) }
      return linhas.join('\n')
    }
  }

  // 3) Ninguém foi perguntado ainda: é a legenda da última foto sem legenda.
  if (!alvo) {
    const semLegenda = meus.filter(p => !p.descricao && p.esperandoLegendaAte > Date.now())
    alvo = semLegenda[semLegenda.length - 1] ?? null
    if (!alvo) return null
    alvo.descricao = texto.trim()
    alvo.esperandoLegendaAte = 0
    clearTimeout(timersLegenda.get(alvo.id))
    timersLegenda.delete(alvo.id)
    pendentes.atualizar(alvo)
    if (enviar) alvo.enviar = enviar
    return processarUmaVez(alvo).then(t => entregar(alvo, t))
  }

  if (enviar) alvo.enviar = enviar
  return aplicarResposta(alvo, texto)
}

/**
 * A pessoa mandou o número de um comprovante da lista ("Esta é de qual?").
 *
 * Desfaz a numeração em todos, e deixa o escolhido em FOCO por alguns
 * minutos: é o que faz a resposta seguinte, sem citação, ir para ele em vez
 * de a lista voltar. Devolve o que dizer, ou null se o número não existe.
 */
function escolherPeloNumero(opcoes, so) {
  const escolhido = pendentes.porId(opcoes[Number(so) - 1])
  for (const id of opcoes) {
    const outro = pendentes.porId(id)
    if (outro) { delete outro.opcoesPendentes; pendentes.atualizar(outro) }
  }
  if (!escolhido) return null
  escolhido.focoAte = Date.now() + 15 * 60 * 1000
  pendentes.atualizar(escolhido)
  return `Certo, é o "${apelidoDoItem(escolhido)}". Agora me responde: ` +
    `${escolhido.ultimaPergunta ?? 'o que falta nele?'}`
}

/** Aplica o que a pessoa respondeu ao comprovante certo. */
function aplicarResposta(p, texto) {
  if (DESISTENCIA.test(texto)) {
    return paraCaixa(p).then(({ ok, texto }) => {
      if (ok) pendentes.remover(p.id)
      else pendentes.atualizar(p)
      return texto
    })
  }

  /*
    Respondendo à pergunta de DUPLICATA.

    Descartar aqui é a única coisa que o robô faz que não deixa rastro em
    lugar nenhum — por isso só acontece com a pessoa dizendo, com todas as
    letras, que é o mesmo comprovante.
  */
  if (p.esperandoDuplicata) {
    if (MESMO_PAGAMENTO.test(texto)) {
      console.log(`[gastos] ${p.de} → duplicata confirmada, descartado`)
      pendentes.remover(p.id)
      return Promise.resolve('👍 Beleza, não lancei — era o mesmo que já tinha entrado.')
    }
    if (OUTRO_PAGAMENTO.test(texto)) {
      p.esperandoDuplicata = false
      p.duplicataConfirmada = true
      p.jaPerguntou = false
      p.perguntadoEm = null
      pendentes.atualizar(p)
      return processarUmaVez(p)
    }
    // Respondeu outra coisa: trata como informação nova (pode estar
    // corrigindo o valor, que é o que faria os dois deixarem de ser iguais).
    p.esperandoDuplicata = false
    p.duplicataConfirmada = true
  }

  const so = texto.trim().replace(/[).\s]+$/, '')

  // Escolheu um COMPROVANTE pelo número, quando havia vários sem citação.
  //
  // Chega aqui quem respondeu o número CITANDO uma mensagem. Antes este
  // caminho escolhia sem pôr o comprovante em foco, e a resposta seguinte
  // sem citação fazia a lista voltar — o mesmo defeito já corrigido no
  // caminho sem citação.
  if (/^\d{1,2}$/.test(so) && p.opcoesPendentes?.length) {
    const dito = escolherPeloNumero(p.opcoesPendentes, so)
    if (dito) return dito
  }

  /*
    Resposta a "Li R$ X no comprovante. Confirma?".

    Tratada ANTES da lista de obras: a resposta aqui é um número, e "3" tem
    de ser R$ 3,00, não "a obra 3".

    "sim" confirma o valor lido, que passa a valer como digitado. Um número
    entra como resposta comum e, sendo o que a pessoa escreveu, ganha da
    imagem. "não", sozinho, não informa nada: o robô pergunta de novo, e a
    palavra não vai parar na descrição do gasto.
  */
  if (p.esperandoValor) {
    p.esperandoValor = false
    if (CONFIRMA_VALOR.test(texto)) {
      if (p.dados?.valor != null) p.valorConfirmado = p.dados.valor
    } else if (!NEGA_VALOR.test(texto)) {
      p.respostas.push(texto.trim())
    }
    p.jaPerguntou = false
    p.perguntadoEm = null
    pendentes.atualizar(p)
    return processarUmaVez(p)
  }

  /*
    "1" ou "2" respondendo a uma lista de OBRAS.

    Sem isto o número seria lido como valor — "1" viraria R$ 1,00 e o gasto
    entraria errado.
  */
  /*
    Resposta à pergunta "quem pagou?".

    Tratada ANTES da lista de obras, e por um motivo prático: as duas
    respondem com número, e nesta altura a obra já está resolvida — "1"
    aqui só pode ser um sócio.
  */
  if (p.esperandoPagador) {
    p.esperandoPagador = false
    const escolhido = lerRespostaDePagador(texto, p.opcoesPagador ?? [])
    delete p.opcoesPagador

    if (escolhido.empresa) {
      p.empresaPagou = true
    } else if (escolhido.nome) {
      p.pagadorEscolhido = escolhido.nome
    } else if (escolhido.ambiguo?.length) {
      // Dois sócios servem para o que foi escrito. Perguntar de novo entre
      // esses dois é melhor que escolher um: gasto no nome do sócio errado
      // ninguém percebe olhando o relatório.
      p.esperandoPagador = true
      p.opcoesPagador = escolhido.ambiguo
      p.perguntadoEm = Date.now()
      pendentes.atualizar(p)
      return [
        `Tem mais de um: ${escolhido.ambiguo.join(' e ')}.`,
        ...escolhido.ambiguo.map((nome, i) => `${i + 1}) ${nome}`),
        '_(responde o número)_',
      ].join('\n')
    } else if (!escolhido.pulou) {
      // Nome que não casou com ninguém. Não é motivo para segurar o
      // comprovante: vira resposta comum, e o gasto entra sem o sócio.
      p.respostas.push(texto.trim())
    }

    p.jaPerguntou = false
    p.perguntadoEm = null
    pendentes.atualizar(p)
    return processarUmaVez(p)
  }

  if (/^\d{1,2}$/.test(so) && p.opcoes?.length) {
    const i = Number(so) - 1
    if (i >= 0 && i < p.opcoes.length) {
      p.obraEscolhida = p.opcoes[i]

      /*
        APRENDE.

        A pessoa escreveu um nome que o robô não reconheceu, ele perguntou, e
        ela apontou qual era. Esse é o único momento em que se sabe, com
        certeza, o que aquela palavra quer dizer — e é por isso que só se
        aprende aqui. Aprender de um palpite propagaria o erro: bastaria ele
        guardar "areia" como apelido de uma obra para toda compra de areia ir
        parar lá.
      */
      if (!p.dados?.obra) {
        /*
          O que sobrou depois de tirar valor, tipo e obra e a DESCRICAO — e e
          dentro dela que esta o nome que ele nao reconheceu, misturado com o
          que foi comprado ("escola do ze cimento").

          Tenta as tres primeiras palavras, depois as duas, depois a
          primeira: nome de obra vem no comeco do jeito que as pessoas
          escrevem, e o que sobra atras e a compra.
        */
        //
        // Se a obra veio escrita no lugar dela ("ze do posto, pedreiro joao,
        // 150") e o sistema a recusou, o nome é ESSE texto. Aprender da
        // descrição ali guardava "pedreiro joao" como apelido de obra, e toda
        // diária dele passava a cair (ou ser rateada) numa obra errada.
        const sobra = (p.obraEscrita ?? p.dados?.descricao ?? p.descricao ?? '').trim()
        const palavras = sobra.split(/\s+/).filter(Boolean)

        for (const quantas of [3, 2, 1]) {
          if (palavras.length < quantas) continue
          const candidato = palavras.slice(0, quantas).join(' ')

          // "areia", "cimento", "material" descrevem a compra. Guardar um
          // deles como apelido faria toda compra de areia cair nesta obra.
          if (ehVocabularioConhecido(candidato)) continue

          if (memoria.aprenderApelido(candidato, p.obraEscolhida)) {
            p.apelidoAprendido = candidato
            break
          }
        }
      }
    } else {
      p.respostas.push(texto.trim())
    }
  } else {
    p.respostas.push(texto.trim())
  }

  // Perguntar de novo é permitido depois de uma resposta: a pessoa pode ter
  // dado só metade do que faltava.
  p.jaPerguntou = false
  p.perguntadoEm = null
  pendentes.atualizar(p)
  return processarUmaVez(p)
}

/** O que ainda está esperando. */
export function listar(de) {
  const meus = pendentes.doRemetente(de)
  if (!meus.length) return '✅ Não tenho nenhum comprovante seu esperando.'

  const linhas = [`Tenho ${meus.length} comprovante(s) seu(s) esperando:`]
  meus.forEach((p, i) => {
    const falta = []
    if (!p.dados?.obra) falta.push('obra')
    if (p.dados?.valor == null) falta.push('valor')
    linhas.push(`${i + 1}) ${apelidoDoItem(p)}${falta.length ? ` — falta ${falta.join(' e ')}` : ''} _(${faz(Date.now() - p.criadoEm)})_`)
  })
  linhas.push('')
  linhas.push('Responde *citando* a mensagem de cada um — pode ser em qualquer ordem.')
  linhas.push('_(ou escreve *cancelar tudo* para mandar todos para a caixa)_')
  return linhas.join('\n')
}

/** Manda tudo que está esperando para a caixa e limpa. */
export async function descartarTudo(de) {
  const meus = pendentes.doRemetente(de)
  if (!meus.length) return '✅ Não tinha nada seu esperando.'

  // Um por vez: a caixa aceita 30 por minuto, e 40 de uma vez faziam os
  // últimos voltarem recusados — e eram apagados mesmo assim, com a
  // resposta dizendo que todos tinham ido.
  let foram = 0
  for (const p of meus) {
    const { ok } = await paraCaixa(p)
    if (ok) { pendentes.remover(p.id); foram++ }
    else pendentes.atualizar(p)
  }
  const ficaram = meus.length - foram
  if (!ficaram) return `📥 Mandei os ${foram} para a caixa de comprovantes.\nAbre /m/gasto no sistema para lançar cada um.`
  return `📥 Mandei ${foram} de ${meus.length} para a caixa.\n`
    + `⚠️ ${ficaram} não foram aceitos agora e continuam guardados comigo — escreve *cancelar tudo* de novo daqui a alguns minutos.`
}

/**
 * O que ele responde a "ping".
 *
 * Diz o que está e o que NÃO está pronto. Só "estou aqui" enganaria: o robô
 * pode estar conectado e ainda assim sem token de obras, e aí o comprovante
 * some sem ninguém entender por quê.
 */
export function respostaDeTeste() {
  const linhas = ['👋 Estou aqui, ouvindo este grupo.']

  if (!obrasConfigurado()) {
    linhas.push('❌ Mas SEM acesso ao sistema de obras — comprovante não vai chegar lá. Falta o token.')
  } else if (!visaoDisponivel()) {
    linhas.push('⚠ Sem leitura automática da imagem. O comprovante chega, mas só com o que você escrever.')
  } else {
    linhas.push('✅ Sistema de obras e leitura de imagem prontos.')
  }

  linhas.push('')
  linhas.push('Manda o comprovante com uma linha assim:')
  linhas.push('_haia, tijolos e areia, material, 2500,00_')
  linhas.push('Se faltar alguma coisa, eu pergunto — e você responde citando a mensagem.')
  return linhas.join('\n')
}

/**
 * "É outro pagamento" — segue e lança.
 *
 * "de novo" e "comprei de novo" entram porque é como se responde na prática:
 * a pergunta foi "é outro ou é o mesmo?", e ninguém repete a palavra da
 * pergunta.
 */
const OUTRO_PAGAMENTO = /^\s*(outro|outro pagamento|e outro|é outro|nao e o mesmo|não é o mesmo|de novo|comprei de novo|sim,? e outro|pode lancar|pode lançar|lanca|lança)\s*[!.]*\s*$/i

/** "É o mesmo comprovante" — descarta sem lançar. */
const MESMO_PAGAMENTO = /^\s*(mesmo|o mesmo|e o mesmo|é o mesmo|duplicado|duplicata|repetido|ja lancou|já lançou|ja mandei|já mandei|descarta|ignora)\s*[!.]*\s*$/i

/** Quem desiste de responder. */
const DESISTENCIA = /^\s*(cancelar|cancela|deixa|deixa pra la|deixa pra lá|esquece|nao sei|não sei|depois)\s*[!.]*\s*$/i

/** Comandos de texto que o robô entende no grupo. */
export const LISTAR = /^\s*(pendentes|pendente|faltando|o que falta|lista|listar|fila)\s*[?!.]*\s*$/i
export const CANCELAR_TUDO = /^\s*(cancelar tudo|cancela tudo|limpar tudo|manda tudo pra caixa|manda tudo para a caixa)\s*[!.]*\s*$/i
