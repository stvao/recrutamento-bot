/**
 * Comprovantes — o miolo: junta o que foi escrito com o que foi lido da
 * imagem e decide se lança, pergunta ou manda para a caixa.
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 */
import { lerComprovante } from './ia-visao.js'
import { obrasDoSistema, pagadoresConhecidos } from './obras-client.js'
import { enviarMensagem } from '../connectors.js'
import { interpretar, combinar, acharValor } from './lancamento.js'
import { perguntar, perguntarPagador } from './perguntas.js'
import { lancar, paraCaixa } from './saida.js'
import { moeda } from './formato.js'
import * as pendentes from './pendentes.js'
import * as memoria from './memoria.js'

/**
 * Obras de reserva, do .env.
 *
 * A fonte de verdade é o sistema de obras (obrasDoSistema). Esta lista só
 * cobre o intervalo em que ele não responde — sem nome de obra nenhum, toda
 * legenda escrita corrido viraria "faltou a obra".
 */
export const OBRAS_RESERVA = (process.env.GASTOS_OBRAS || '')
  .split(',').map(o => o.trim()).filter(Boolean)

/**
 * As obras conhecidas agora: as do sistema, ou a reserva do .env.
 *
 * Os apelidos APRENDIDOS entram junto. Eles vêm no campo do endereço, que a
 * busca por palavra distintiva já varre — assim "escola do zé", uma vez
 * confirmado por você, passa a achar a obra sozinho, sem caminho novo.
 */
async function obrasConhecidas() {
  const doSistema = (await obrasDoSistema()) ?? OBRAS_RESERVA
  const aprendidos = memoria.apelidosPorObra(doSistema)
  if (!aprendidos.size) return doSistema

  return doSistema.map((o) => {
    const nome = typeof o === 'string' ? o : o.nome
    const apelidos = aprendidos.get(nome)
    if (!apelidos?.length) return o
    return {
      nome,
      endereco: typeof o === 'string' ? '' : (o.endereco ?? ''),
      apelidos,
    }
  })
}

/**
 * Diz alguma coisa FORA da resposta a uma mensagem.
 *
 * A cobrança sai horas depois, e o prazo estoura sozinho: não há mensagem a
 * que responder. O canal é quem sabe mandar; aqui só se usa o que ele
 * entregou. Sem isso, registra e segue — falar é desejável, e não conseguir
 * falar não pode derrubar o lançamento.
 */
export async function avisar(pendente, texto) {
  if (!texto) return null
  try {
    if (typeof pendente?.enviar === 'function') {
      const r = await pendente.enviar(texto)
      return r?.id ?? null
    }

    /*
      Sem a função de envio, mas com o endereço da conversa.

      É o caso do comprovante recuperado do DISCO depois de um reinício: a
      ficha sobrevive, a função não — ela é um fecho sobre a mensagem que
      chegou. Sem esta saída, a cobrança e o aviso de prazo desses ficariam
      só no log, e a pessoa nunca saberia que o comprovante dela foi para a
      caixa.
    */
    if (pendente?.chat) {
      await enviarMensagem(pendente.chat, texto)
      return null
    }

    console.log(`[gastos] (sem canal para avisar) ${pendente?.de}: ${String(texto).replace(/\n/g, ' / ')}`)
  } catch (e) {
    console.warn('[gastos] não consegui avisar:', e.message)
  }
  return null
}

/** Timers da espera pela legenda, por comprovante. Fora da ficha: não vão para o disco. */
export const timersLegenda = new Map()
/** Comprovantes sendo processados agora (a leitura da foto leva até ~100 s). */
export const emAndamento = new Set()

/** O mesmo comprovante nunca é processado por dois caminhos ao mesmo tempo. */
export function processarUmaVez(p) {
  if (emAndamento.has(p.id)) return Promise.resolve(null)
  emAndamento.add(p.id)
  return resolveDireto(p).finally(() => emAndamento.delete(p.id))
}

/**
 * Processa um comprovante e devolve o texto para quem estiver ouvindo.
 *
 * Resolvido, sai da lista e do disco. Faltando informação, vira pergunta e
 * continua esperando — cada um por conta própria.
 */
async function resolveDireto(p) {
  const r = await processar(p)

  if (!r.perguntando) {
    // A caixa recusou: o comprovante CONTINUA esperando, e a ronda tenta de
    // novo. Apagar aqui era perdê-lo sem rastro.
    if (r.caixaRecusou) pendentes.atualizar(p)
    else pendentes.remover(p.id)
    return r.texto
  }

  // Ficou esperando. Quantos mais estão na mesma situação? Dizer isso evita
  // a sensação de bagunça de quem mandou vários e não sabe o que falta.
  const outros = pendentes.doRemetente(p.de).filter(x => x.id !== p.id && x.perguntadoEm).length
  const texto = outros
    ? `${r.texto}\n_(responde citando esta mensagem — tenho mais ${outros} esperando)_`
    : r.texto

  const idPergunta = await avisar(p, texto)
  if (idPergunta) {
    // Guarda o id da PERGUNTA: citar a pergunta é o jeito mais natural de
    // responder, e sem isto só citar a foto funcionaria.
    p.idPergunta = idPergunta
  }
  p.perguntadoEm = Date.now()
  pendentes.atualizar(p)

  // Já foi dito por `avisar`; devolver de novo mandaria a mesma coisa duas
  // vezes. Quando não há canal, volta como resposta normal.
  return idPergunta ? null : texto
}

/** Entrega pela promessa que ficou aberta, quando existe. */
export function entregar(p, texto) {
  if (p.responder) {
    p.responder(texto)
    p.responder = null
    return null
  }
  return texto
}

/**
 * Junta tudo que se sabe e decide: lança, pergunta, ou manda para a caixa.
 *
 * Devolve `{ perguntando, texto }`. Quem chama precisa saber a diferença:
 * uma pergunta trava a fila esperando resposta; o resto segue adiante.
 */
async function processar(pendente, { acabouOTempo = false } = {}) {
  const obras = await obrasConhecidas()

  /*
    Tudo que a pessoa escreveu, na legenda e nas respostas, lido JUNTO.

    Junto e não separado: quem manda a foto com "haia" e depois responde
    "1400" tem um lançamento só na cabeça, e interpretar as duas frases
    isoladamente perderia a metade de cada uma.
  */
  const escritoTudo = [pendente.descricao, ...(pendente.respostas ?? [])]
    .filter(Boolean).join(', ')

  const escrito = interpretar(escritoTudo, obras, pagadoresConhecidos())

  /*
    Resposta a "Vi dois valores aí... qual é o do comprovante?".

    Tudo é lido junto (legenda + respostas), então a resposta se SOMAVA aos
    dois valores da legenda e o texto continuava ambíguo — a pergunta voltava
    para sempre. A resposta mais recente com um valor só decide.
  */
  if (escrito.valorAmbiguo?.length && pendente.respostas?.length) {
    for (const r of [...pendente.respostas].reverse()) {
      const v = acharValor(r)
      if (v.valor != null && !v.ambiguo) {
        escrito.valor = v.valor
        escrito.valorAmbiguo = null
        escrito.valorIncerto = false
        break
      }
    }
  }

  // A imagem é lida UMA vez e guardada: numa segunda passada, depois da
  // resposta, reler custaria mais 20 segundos e daria o mesmo resultado.
  if (pendente.lido === undefined) {
    pendente.lido = await lerComprovante({
      arquivo: pendentes.arquivoDe(pendente), tipo: pendente.tipo, descricao: escritoTudo,
    }).catch(() => null)
    console.log('[gastos] leitura da imagem:', pendente.lido ? JSON.stringify(pendente.lido) : 'nenhuma')
  }

  const dados = combinar(escrito, pendente.lido)

  // Obra escolhida pelo número da lista manda em tudo: foi a pessoa que
  // apontou, e não há leitura de texto que valha mais que isso.
  if (pendente.obraEscolhida) dados.obra = pendente.obraEscolhida

  // Idem para o sócio apontado na resposta à pergunta "quem pagou?".
  if (pendente.pagadorEscolhido) dados.pagoPor = pendente.pagadorEscolhido

  pendente.dados = dados

  const falta = []
  if (!dados.obra) falta.push('obra')
  if (dados.valor == null) falta.push('valor')

  if (falta.length && !acabouOTempo && !pendente.jaPerguntou) {
    return { perguntando: true, texto: perguntar(pendente, falta, obras) }
  }
  if (falta.length) {
    const cx = await paraCaixa(pendente)
    return { perguntando: false, texto: cx.texto, caixaRecusou: !cx.ok }
  }

  /*
    Obra e valor resolvidos. Falta saber quem bancou — e aí sim se pergunta.

    Depois dos outros dois de propósito: obra e valor decidem SE o gasto pode
    entrar; o sócio decide apenas como ele fica registrado. Perguntar os três
    de uma vez faria a pessoa responder um e esquecer os outros.

    E, ao contrário dos outros dois, esta pergunta NUNCA segura o lançamento.
    Ninguém respondeu? O gasto entra sem o sócio, como entrava antes de esta
    pergunta existir. Trocar um gasto lançado por um campo preenchido seria
    um mau negócio: o campo se completa na aprovação, o gasto perdido não.
  */
  const socios = pagadoresConhecidos()
  if (!dados.pagoPor && socios.length && !pendente.pagadorPerguntado && !acabouOTempo) {
    pendente.pagadorPerguntado = true
    pendente.esperandoPagador = true
    pendente.jaPerguntou = true
    return { perguntando: true, texto: perguntarPagador(pendente, dados, socios) }
  }

  /*
    Mesma obra e mesmo valor de um lançamento recente: pode ser duplicata.

    PERGUNTA, não recusa. Valor repetido é comum de verdade — dois sacos de
    cimento no mesmo dia, a diária do mesmo pedreiro na semana seguinte. Quem
    sabe se é o mesmo pagamento é quem pagou, e barrar sozinho faria o robô
    engolir gasto legítimo em silêncio, que é o pior erro que ele pode
    cometer aqui.
  */
  if (!pendente.duplicataConfirmada) {
    const igual = memoria.parecidoCom(
      { obra: dados.obra, valor: dados.valor }, pendente.idMensagem,
    )
    if (igual) {
      pendente.esperandoDuplicata = true
      pendente.jaPerguntou = true
      const quando = new Date(igual.quando)
      const quandoTexto = quando.toDateString() === new Date().toDateString()
        ? `hoje às ${quando.getHours()}h${String(quando.getMinutes()).padStart(2, '0')}`
        : `em ${quando.getDate()}/${quando.getMonth() + 1}`
      return {
        perguntando: true,
        texto: [
          `⚠ Já lancei um igual a este ${quandoTexto}:`,
          `   ${igual.obra} · ${igual.descricao ?? 'sem descrição'} · ${moeda(igual.valor)}`,
          '',
          'É outro pagamento, ou é o mesmo comprovante?',
          'Responde *outro* para lançar, ou *mesmo* para descartar.',
        ].join('\n'),
      }
    }
  }

  return lancar(pendente, dados)
}
