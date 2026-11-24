/**
 * Comprovantes — a conversa: o texto que chega sem arquivo (resposta a uma
 * pergunta, legenda atrasada, "pendentes", "cancelar tudo", "ping").
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 */
import { visaoDisponivel } from './ia-visao.js'
import { obrasConfigurado } from './obras-client.js'
import { ehVocabularioConhecido, temNomeDePessoa, acharObras, acharValor, pagadoresQueServem } from './lancamento.js'
import { lerRespostaDePagador, CONFIRMA_VALOR, NEGA_VALOR, EMPRESA_NO_TEXTO } from './perguntas.js'
import { RESPOSTA_PAGO, RESPOSTA_A_PAGAR } from './a-pagar.js'
import { processarUmaVez, entregar, timersLegenda, obrasConhecidas } from './processar.js'
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
export async function responderTexto(de, texto, respondendoA, enviar) {
  const meus = pendentes.doRemetente(de)
  if (!meus.length || !texto?.trim()) return null

  // 1) Citou alguma coisa: vale o que foi citado.
  let alvo = pendentes.porCitacao(de, respondendoA)

  // 1b) Não citou, e há uma foto RECÉM-CHEGADA sem legenda: este texto é a
  //     legenda dela — antes de ser resposta a um comprovante antigo. Era
  //     assim que "125,42 pedágios…", legenda da foto nova, ia parar no
  //     comprovante anterior.
  if (!alvo) {
    const semLegenda = meus.filter(p => !p.descricao && p.esperandoLegendaAte > Date.now())
    const recente = semLegenda[semLegenda.length - 1]
    if (recente) {
      recente.descricao = texto.trim()
      recente.esperandoLegendaAte = 0
      clearTimeout(timersLegenda.get(recente.id))
      timersLegenda.delete(recente.id)
      pendentes.atualizar(recente)
      if (enviar) recente.enviar = enviar
      return processarUmaVez(recente).then(t => entregar(recente, t))
    }
  }

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

    // "1 praia grande", depois de "Esta é de qual?": o número escolhe o
    // comprovante, e o resto é a resposta para ele. Antes só o número puro
    // valia, e "1 praia grande" trazia a mesma lista de volta.
    const numeroEResto = /^(\d{1,2})\s*[),.;:–-]?\s+(\S.*)$/.exec(texto.trim())
    if (numeroEResto && comLista) {
      const escolhido = pendentes.porId(comLista.opcoesPendentes[Number(numeroEResto[1]) - 1])
      if (escolhido) {
        for (const id of comLista.opcoesPendentes) {
          const outro = pendentes.porId(id)
          if (outro) { delete outro.opcoesPendentes; pendentes.atualizar(outro) }
        }
        if (enviar) escolhido.enviar = enviar
        return aplicarResposta(escolhido, numeroEResto[2].trim())
      }
    }

    // "todos são de praia grande", "os dois caixa empresa": a mesma
    // resposta para cada um que está esperando.
    const paraTodos = perguntados.length > 1 ? PARA_TODOS.exec(texto) : null
    if (paraTodos) {
      const resposta = paraTodos[paraTodos.length - 1].trim()
      const ditos = []
      for (const p of perguntados) {
        delete p.opcoesPendentes
        if (enviar) p.enviar = enviar
        const dito = await aplicarResposta(p, resposta)
        if (dito) ditos.push(dito)
      }
      return ditos.length ? ditos.join('\n\n') : null
    }

    const obras = perguntados.length > 1 ? await obrasConhecidas() : []
    const servem = perguntados.length > 1 ? perguntados.filter(p => aceita(p, texto, obras)) : []

    if (emFoco) alvo = emFoco
    else if (perguntados.length === 1) alvo = perguntados[0]
    // Só UM deles espera esse tipo de resposta ("caixa empresa" com um
    // esperando "quem pagou?" e outro esperando a obra): é ele.
    else if (servem.length === 1) alvo = servem[0]
    else if (perguntados.length > 1) {
      // Vários esperando e nenhuma citação: adivinhar aqui é o que faz
      // resposta cair no comprovante errado, que é pior que perguntar.
      const linhas = [`Tenho ${perguntados.length} comprovantes esperando resposta. Esta é de qual?`]
      perguntados.forEach((p, i) => {
        const falta = oQueFalta(p)
        linhas.push(`${i + 1}) ${apelidoDoItem(p)}${falta ? ` — falta ${falta}` : ''}`)
      })
      linhas.push('')
      linhas.push('Responde *citando* a mensagem dele, ou com o número na frente ("1 praia grande"). Se vale para todos, escreve "todos" na frente.')
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

  // Uma PERGUNTA que não é resposta ao que ele espera ("algum ficou sem
  // lançar?"): mostra o que está esperando, em vez de tomar como resposta e
  // mandar o comprovante para a caixa.
  if (/\?\s*$/.test(texto.trim()) && !aceita(alvo, texto, await obrasConhecidas())) return listar(de)

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
  /*
    O documento foi para a caixa como "a pagar" e ficou esperando só uma
    coisa: alguém dizer que JÁ FOI PAGO. Aí ele é lançado como qualquer
    outro. Qualquer outra resposta não muda nada — ele já está onde devia.
  */
  if (p.naCaixaAPagar) {
    if (!RESPOSTA_PAGO.test(texto)) return Promise.resolve(null)
    p.naCaixaAPagar = false
    p.pagamentoConfirmado = true
    delete p.marcaDaCaixa
    p.jaPerguntou = false
    p.perguntadoEm = null
    pendentes.atualizar(p)
    return processarUmaVez(p)
  }

  /*
    Resposta a "Já foi pago? Responde *pago* ou *a pagar*".

    Antes da desistência de sempre: aqui "não" quer dizer "não foi pago", e
    não "deixa pra lá".
  */
  if (p.esperandoPago) {
    if (RESPOSTA_PAGO.test(texto)) {
      p.esperandoPago = false
      p.pagamentoConfirmado = true
    } else if (RESPOSTA_A_PAGAR.test(texto)) {
      p.esperandoPago = false
      p.aPagarConfirmado = true
    } else if (!DESISTENCIA.test(texto)) {
      // Não respondeu à pergunta: ela volta, do mesmo jeito.
      p.perguntadoEm = null
      pendentes.atualizar(p)
      return processarUmaVez(p)
    }
    if (!p.esperandoPago) {
      p.jaPerguntou = false
      p.perguntadoEm = null
      pendentes.atualizar(p)
      return processarUmaVez(p)
    }
  }

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
    Resposta a "É da <obra>, como das outras vezes?".

    "sim" confirma a obra sugerida — e é a pessoa confirmando, não o robô
    decidindo. "sim, 250" confirma e traz o valor que faltava. Qualquer outra
    coisa é resposta comum: se ela escreveu outra obra, é essa que vale, e se
    não der para entender volta a pergunta de sempre, com a lista.
  */
  if (p.esperandoHabito) {
    const sugerida = p.esperandoHabito
    p.esperandoHabito = null
    const comMais = /^\s*(sim|isso|isso mesmo|é sim|e sim|ok|certo)\b[\s,.;!-]+(\S.*)$/i.exec(texto)
    // Para o relatório: a sugestão (do hábito ou do RH) acertou?
    memoria.contar(CONFIRMA_VALOR.test(texto) || comMais ? 'sugestaoAceita' : 'sugestaoRecusada')
    if (CONFIRMA_VALOR.test(texto)) {
      p.obraEscolhida = sugerida
    } else if (comMais) {
      p.obraEscolhida = sugerida
      p.respostas.push(comMais[2].trim())
    } else if (NEGA_VALOR.test(texto)) {
      // "não", sozinho, não diz qual é a obra — e guardado junto da legenda
      // seria lido como parte dela. Volta a pergunta de sempre, com a lista.
    } else {
      p.respostas.push(texto.trim())
    }
    p.jaPerguntou = false
    p.perguntadoEm = null
    pendentes.atualizar(p)
    return processarUmaVez(p)
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

  /*
    O número da obra E o resto, numa mensagem só: "2 150", "1 - 80,00".

    É como se responde a "Só faltou a obra e o valor" com a lista numerada
    na tela. Lido como texto corrido, "2 150" virava dois números sem obra,
    e a mesma pergunta voltava.
  */
  /*
    MAIS DE UMA obra da lista: "1 e 2", "1, 2 e 3", "as duas", "ambos",
    "todas" — é rateio entre elas.

    Caso real: "1 e 2, ratear quem pagou foi o Estevão", respondendo a
    "É qual delas? 1) Tsuya 2) Haia", virou um gasto de R$ 2,00 com a
    descrição "00, 1 e, ratear". O que vier depois ("quem pagou foi o
    Estevão") segue como resposta comum.
  */
  if (p.opcoes?.length > 1) {
    const varias = lerVariasDaLista(texto, p.opcoes)
    if (varias) {
      p.obraEscolhida = varias.obras[0]
      p.rateioEscolhido = varias.obras.slice(1)
      if (varias.resto) p.respostas.push(varias.resto)
      p.jaPerguntou = false
      p.perguntadoEm = null
      pendentes.atualizar(p)
      return processarUmaVez(p)
    }
  }

  const numeroEResto = /^(\d{1,2})\s*[),.;:–-]?\s+(\S.*)$/.exec(texto.trim())
  if (numeroEResto && p.opcoes?.length) {
    const i = Number(numeroEResto[1]) - 1
    if (i >= 0 && i < p.opcoes.length) {
      p.obraEscolhida = p.opcoes[i]
      p.respostas.push(numeroEResto[2].trim())
      p.jaPerguntou = false
      p.perguntadoEm = null
      pendentes.atualizar(p)
      return processarUmaVez(p)
    }
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
      //
      // NÃO aprende quando a pergunta era entre as obras de uma CIDADE ("É
      // qual delas? 1) Tsuya 2) Haia"): a cidade já disse quase tudo, e o
      // resto da legenda é a pessoa e a compra. Foi assim que o robô anotou
      // que "Thiago Encarregado Bastos" era a Haia.
      if (!p.dados?.obra && !p.dados?.candidatos?.length) {
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
          // Nome de gente também não: "Thiago Encarregado" é uma pessoa, e
          // a pessoa muda de obra.
          if (temNomeDePessoa(candidato)) continue

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
const OUTRO_PAGAMENTO = /^\s*(outro|outro pagamento|e outro|é outro|nao e o mesmo|não é o mesmo|de novo|comprei de novo|sim,? e outro|sim,?\s+(é|e)\s+outro(\s+pagamento)?|(é|e)\s+outro\s+pagamento|pode lancar|pode lançar|lanca|lança)\s*[!.]*\s*$/i

/** "É o mesmo comprovante" — descarta sem lançar. */
const MESMO_PAGAMENTO = /^\s*(mesmo|o mesmo|e o mesmo|é o mesmo|duplicado|duplicata|repetido|ja lancou|já lançou|ja mandei|já mandei|descarta|ignora)\s*[!.]*\s*$/i

/** Quem desiste de responder. */
//
// "Pode manda para o sistema" (caso real, 24/11/2026) é como se pede para
// largar na caixa: virava resposta, e a mesma pergunta voltava.
const DESISTENCIA = /^\s*(cancelar|cancela|deixa|deixa pra la|deixa pra lá|esquece|nao sei|não sei|depois|(pode\s+)?(manda|mandar|joga|jogar|envia|enviar|lan[cç]a|lan[cç]ar)\s+(pro|pra|para\s+o|para\s+a|no|na)\s+(sistema|caixa))\s*[!.]*\s*$/i

/** Comandos de texto que o robô entende no grupo. */
export const LISTAR = /^\s*(pendentes|pendente|faltando|o que falta|lista|listar|fila)\s*[?!.]*\s*$/i
export const CANCELAR_TUDO = /^\s*(cancelar tudo|cancela tudo|limpar tudo|manda tudo pra caixa|manda tudo para a caixa)\s*[!.]*\s*$/i

// ─── Entender a resposta sem citação ───────────────────────────────────────

/**
 * Várias obras da lista numa resposta só: "1 e 2", "1, 2 e 3", "as duas",
 * "ambos", "todas". Devolve { obras, resto } ou null.
 */
export function lerVariasDaLista(texto, opcoes) {
  const t = String(texto ?? '').trim()
  const numeros = /^\s*(\d{1,2}(?:\s*(?:,|\be\b|\+|\/)\s*\d{1,2})+)\s*[,.;:–-]?\s*(.*)$/i.exec(t)
  if (numeros) {
    const idx = [...new Set(numeros[1].match(/\d{1,2}/g).map(Number))]
    if (idx.length > 1 && idx.every(i => i >= 1 && i <= opcoes.length)) {
      return { obras: idx.map(i => opcoes[i - 1]), resto: numeros[2].trim() }
    }
  }
  const todas = /^\s*(as duas|os dois|ambas|ambos|as tr[eê]s|os tr[eê]s|todas|todos)\b[\s,.;:–-]*(.*)$/i.exec(t)
  if (todas) return { obras: [...opcoes], resto: todas[2].trim() }
  return null
}

/** "todos são de praia grande", "os dois: haia", "ambos caixa empresa" — a mesma resposta para todos. */
const PARA_TODOS = /^\s*(todos|todas|os dois|as duas|ambos|ambas|os tr[eê]s|as tr[eê]s)\b(\s+(s[aã]o|eles|elas|é|e|foram|da|do|de|na|no|pra|para|pela|pelo))*[\s,.;:–-]*(\S.*)$/i

/**
 * Este comprovante está esperando o tipo de coisa que a pessoa escreveu?
 *
 * Com dois esperando e nenhuma citação, o robô perguntava "Esta é de qual?"
 * mesmo quando só UM deles podia receber aquela resposta — "caixa empresa"
 * com um esperando "quem pagou?" e outro esperando a obra. Caso real
 * (24/11/2026): cinco vezes seguidas a mesma pergunta.
 */
function aceita(p, texto, obras) {
  const t = texto.trim()
  if (p.esperandoPagador) {
    if (EMPRESA_NO_TEXTO.test(t)) return true
    const r = lerRespostaDePagador(t, p.opcoesPagador ?? [])
    return Boolean(r.nome || r.empresa || r.pulou || r.ambiguo?.length)
  }
  if (p.esperandoValor) return CONFIRMA_VALOR.test(t) || NEGA_VALOR.test(t) || acharValor(t).valor != null
  if (p.esperandoDuplicata) return MESMO_PAGAMENTO.test(t) || OUTRO_PAGAMENTO.test(t)
  if (p.esperandoPago || p.naCaixaAPagar) return RESPOSTA_PAGO.test(t) || RESPOSTA_A_PAGAR.test(t)
  if (p.esperandoHabito && CONFIRMA_VALOR.test(t)) return true
  if (!p.dados?.obra) {
    const achou = acharObras(t, obras)
    if (achou.obras.length || achou.candidatos?.length) return true
    if (p.opcoes?.length && /^\s*\d{1,2}\b/.test(t)) return true
  }
  if (p.dados?.valor == null && acharValor(t).valor != null) return true
  return false
}

/** O que falta neste comprovante, para a lista de "Esta é de qual?". */
function oQueFalta(p) {
  if (p.esperandoPagador) return 'quem pagou'
  if (p.esperandoValor) return 'confirmar o valor'
  if (p.esperandoDuplicata) return 'se é repetido'
  if (p.esperandoPago) return 'se já foi pago'
  const falta = [!p.dados?.obra && 'a obra', p.dados?.valor == null && 'o valor'].filter(Boolean)
  return falta.length ? falta.join(' e ') : null
}

/**
 * É uma pergunta sobre o que está esperando — "quais aguardam lançamento?",
 * "algum ficou sem lançar?"? Caso real: "algum ficou sem lançar?" foi lido
 * como RESPOSTA a um comprovante, que foi parar na caixa.
 */
export function pedeLista(texto) {
  const t = String(texto ?? '').trim()
  if (LISTAR.test(t)) return true
  const n = t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  return /\b(quais|qual|quantos|quantas|algum|alguma|tem|ha|existe)\b.*\b(aguard\w*|esper\w*|falt\w*|pendent\w*|sem lancar|lancad\w*|lancar|lancamento)\b/.test(n)
    && (/\?\s*$/.test(t) || /^(quais|qual|quantos|quantas|algum|alguma)\b/.test(n))
}

/** "aprovar gasto" — o robô não aprova, e diz onde se aprova. */
export const APROVAR = /^\s*(aprovar|aprova|aprove|aprovado|aprovem)(\s+(os|o|esses|esse|todos|tudo))?(\s+(gastos?|lan[cç]amentos?|comprovantes?))?\s*[?!.]*\s*$/i

export function respostaDeAprovar() {
  return 'Quem aprova é gente: abre *Aprovar gastos* no sistema de obras. Eu só lanço, e todo gasto que lanço fica lá esperando a sua confirmação.'
}
