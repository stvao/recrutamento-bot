/**
 * Comprovantes — o miolo: junta o que foi escrito com o que foi lido da
 * imagem e decide se lança, pergunta ou manda para a caixa.
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 */
import { lerComprovante } from './ia-visao.js'
import { obrasDoSistema, pagadoresConhecidos, lancadosDoSistema } from './obras-client.js'
import { enviarMensagem } from '../connectors.js'
import { interpretar, combinar, acharValor, nomesDe } from './lancamento.js'
import { perguntar, perguntarPagador, perguntarValorLido, perguntarObraDoHabito } from './perguntas.js'
import { fornecedorDe, habitoDe } from './habito.js'
import { lancar, paraCaixa, diaDoEnvio, dataDoGasto, mandarParaContasAPagar } from './saida.js'
import { pagoOuAPagar, perguntaDePago } from './a-pagar.js'
import {
  mesmoArquivo, parecido, classificar, avisoDeMesmoArquivo, avisoDeJaLancado, perguntaDeRepetido, documentoComparavel,
} from './duplicata.js'
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
export async function obrasConhecidas() {
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

  // Comprovante que não chegou pela conversa (veio do grupo antigo): tudo que
  // se diz sobre ele começa dizendo DE QUAL se está falando — data, quem
  // mandou, o que escreveu. Não há foto ali para a pessoa olhar.
  if (pendente?.prefixo) texto = `${pendente.prefixo}\n${texto}`

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
      // O id da mensagem volta para quem chamou: é por ele que a pessoa
      // responde CITANDO. Antes era jogado fora, e uma pergunta feita por
      // este caminho saía duas vezes — quem chamava, sem o id, concluía que
      // nada tinha sido dito e mandava de novo.
      const r = await enviarMensagem(pendente.chat, texto)
      return r?.id ?? null
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

  // Como terminou, para quem está acompanhando de fora (o atraso). Fica no
  // objeto, que continua na mão de quem chamou mesmo depois de sair do disco.
  p.desfecho = r.desfecho ?? null

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
 *
 * Devolve também `desfecho` — 'lancado', 'reenvio', 'mesmo-arquivo',
 * 'ja-lancado', 'caixa', 'caixa-recusou', 'pergunta' (com `pergunta` dizendo
 * qual) — e, quando bateu com um lançamento, o `item`.
 *
 * Com `ensaio`, decide tudo igual e NÃO ESCREVE nada: não lança, não manda
 * para a caixa. Onde lançaria, devolve o desfecho 'lancaria'. É o que permite
 * ao atraso mostrar o que faria antes de fazer — pela MESMA decisão, e não
 * por uma cópia dela que um dia divergiria.
 */
export async function processar(pendente, { ensaio = false } = {}) {
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

  /*
    É O MESMO ARQUIVO de um gasto já lançado? Então não há o que perguntar.

    Antes de ler a imagem, e antes de perguntar obra ou valor: a impressão
    digital não depende de nada disso, e fazer a pessoa responder duas
    perguntas para só então ouvir "esse já entrou" seria gastar o tempo dela
    — e uma leitura da IA — à toa.

    É a ÚNICA situação em que o robô deixa de lançar sem ninguém dizer "é o
    mesmo". Vale porque aqui não há palpite: bytes iguais são o mesmo
    comprovante, e não dois pagamentos de mesmo valor.
  */
  // Ficha gravada por uma versão anterior não tem a impressão: calcula agora.
  if (!pendente.arquivoHash) pendente.arquivoHash = pendentes.impressaoDigital(pendentes.arquivoDe(pendente))

  // Comprovante do atraso é de semanas atrás: a comparação com o sistema
  // tem de começar antes dele, e não nos últimos 30 dias.
  const desde = pendente.atraso?.desde
    ?? diaDoEnvio(Date.now() - memoria.DIAS_DE_COMPARACAO * 24 * 60 * 60 * 1000)
  const jaLancados = {
    // `simulados`: num ensaio, o que os comprovantes anteriores DO MESMO
    // ensaio lançariam — senão dois iguais no mesmo zip passariam os dois.
    locais: [...memoria.lancadosRecentes(), ...(pendente.simulados ?? [])],
    doSistema: await lancadosDoSistema(desde),
  }

  const identico = mesmoArquivo(
    { arquivoHash: pendente.arquivoHash, idMensagem: pendente.idMensagem }, jaLancados,
  )
  if (identico) {
    console.log(`[gastos] ${pendente.de} → mesmo arquivo de um gasto já lançado, não lancei de novo`)
    return { perguntando: false, texto: avisoDeMesmoArquivo(identico), desfecho: 'mesmo-arquivo', item: identico }
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

  /*
    O nº do documento, numa forma só — aqui, antes de mandar, guardar ou
    comparar.

    O sistema de obras grava o que recebe e compara letra por letra: "000123"
    e "123" são, para ele, dois documentos. E a IA lê o mesmo cupom de um
    jeito numa foto e de outro na seguinte. Mandando cada leitura como veio,
    a trava de repetido do sistema nunca fecharia.

    O que foi lido fica guardado à parte (`documentoLido`), para o texto da
    caixa mostrar o número como está no papel.
  */
  dados.documentoLido = dados.documento
  dados.documento = documentoComparavel(dados.documento)

  // A pessoa confirmou o valor lido ("sim"): passa a valer como digitado —
  // sai o aviso de "confira", e a pergunta não se repete. Só enquanto o
  // valor for AQUELE: se uma resposta posterior trouxer outro número, é o
  // número novo que vale, e ele já é digitado por conta própria.
  if (dados.valorDaImagem && pendente.valorConfirmado != null
    && Math.abs(dados.valor - pendente.valorConfirmado) < 0.005) {
    dados.valorDaImagem = false
    dados.valorDigitado = true
    dados.confianca = 'digitado'
  }

  /*
    O hábito do fornecedor (ver habito.js): de qual obra e de qual categoria
    costumam ser os gastos dele.

    A CATEGORIA entra direto quando nem a legenda nem a imagem deram — errar
    a categoria é barato, quem aprova vê e troca. A OBRA nunca entra direto:
    vira pergunta, mais abaixo.
  */
  const habito = habitoDe(memoria.habitosDe(fornecedorDe(dados)), { obrasAtuais: nomesDe(obras) })
  if (!dados.tipo && habito?.categoria) {
    dados.tipo = habito.categoria
    dados.tipoDoHabito = true
  }

  pendente.dados = dados

  /*
    É PAGAMENTO FEITO, ou conta a pagar? (ver a-pagar.js)

    Antes de qualquer outra pergunta: não faz sentido pedir a obra de um
    boleto que nem vai virar gasto.

    Boleto ou orçamento sem prova de pagamento não é lançado. Vai para a
    caixa, marcado, e o robô avisa — e o comprovante CONTINUA esperando: se
    já foi pago, a pessoa responde *pago* e ele segue daqui como qualquer
    outro. No atraso não fica esperando (lá cada espera segura o lote de
    perguntas): vai para a caixa e pronto.
  */
  const pg = pagoOuAPagar({
    tipoDocumento: dados.tipoDocumento,
    pagamentoComprovado: dados.pagamentoComprovado,
    vencimento: dados.vencimento,
    escrito: escritoTudo,
    respondeu: pendente.pagamentoConfirmado ? 'pago' : pendente.aPagarConfirmado ? 'a-pagar' : null,
    hoje: diaDoEnvio(pendente.enviadoEm),
  })

  if (pg?.decisao === 'a-pagar') {
    if (ensaio) return { perguntando: false, texto: null, desfecho: 'a-pagar', aPagar: pg }
    const saida = await mandarParaContasAPagar(pendente, pg)
    if (!saida.ok) return { perguntando: false, texto: saida.texto, caixaRecusou: true, desfecho: 'caixa-recusou' }
    if (pendente.atraso) return { perguntando: false, texto: saida.texto, desfecho: 'a-pagar', aPagar: pg }
    pendente.naCaixaAPagar = true
    pendente.jaPerguntou = true
    pendente.ultimaPergunta = 'Se já foi pago, responde *pago*.'
    return { perguntando: true, texto: saida.texto, desfecho: 'a-pagar', aPagar: pg }
  }

  if (pg?.decisao === 'perguntar') {
    pendente.esperandoPago = true
    pendente.jaPerguntou = true
    const pergunta = perguntaDePago(pg)
    pendente.ultimaPergunta = pergunta
    return { perguntando: true, texto: pergunta, desfecho: 'pergunta', pergunta: 'se já foi pago' }
  }

  const falta = []
  if (!dados.obra) falta.push('obra')
  if (dados.valor == null) falta.push('valor')

  /*
    Falta a obra, e este fornecedor é quase sempre da mesma: pergunta "é da
    <obra>, como das outras vezes?" em vez de mostrar a lista inteira.

    Uma vez só por comprovante. Se a pessoa escreveu algo que serve para mais
    de uma obra (a cidade), vale a pergunta entre aquelas — ela já disse
    alguma coisa, e o hábito não deve passar por cima.
  */
  if (falta.includes('obra') && habito?.obra && !pendente.habitoPerguntado
    && !dados.candidatos?.length && (!pendente.jaPerguntou || ensaio)) {
    pendente.habitoPerguntado = true
    pendente.esperandoHabito = habito.obra
    pendente.jaPerguntou = true
    return {
      perguntando: true,
      texto: perguntarObraDoHabito(pendente, dados, habito.obra, falta),
      desfecho: 'pergunta',
      pergunta: `${falta.join(' e ')} (pelo hábito do fornecedor, seria ${habito.obra})`,
    }
  }

  if (falta.length && (!pendente.jaPerguntou || ensaio)) {
    return { perguntando: true, texto: perguntar(pendente, falta, obras), desfecho: 'pergunta', pergunta: falta.join(' e ') }
  }
  if (falta.length) {
    const cx = await paraCaixa(pendente)
    return { perguntando: false, texto: cx.texto, caixaRecusou: !cx.ok, desfecho: cx.ok ? 'caixa' : 'caixa-recusou' }
  }

  /*
    O valor veio só da imagem, e a leitura não é de confiança alta: confirma
    antes de lançar.

    Depois da obra — sem ela o comprovante nem pode entrar, e perguntar as
    duas coisas juntas faz a pessoa responder uma e esquecer a outra — e
    antes de "quem pagou" e da suspeita de repetido, que dependem de o valor
    estar certo. Quando falta o valor INTEIRO a pergunta já foi feita acima
    ("qual foi o valor?"), e a resposta dela é digitada: não há segunda
    pergunta.

    Sem resposta, a ronda cuida como dos outros: um lembrete e, no prazo, a
    caixa — com o valor lido indo como sugestão para quem completar à mão.
  */
  if (dados.valorDaImagem && dados.confiancaLeitura !== 'alta') {
    pendente.esperandoValor = true
    pendente.jaPerguntou = true
    return { perguntando: true, texto: perguntarValorLido(pendente, dados), desfecho: 'pergunta', pergunta: 'confirmar o valor lido' }
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
  if (!dados.pagoPor && socios.length && !pendente.pagadorPerguntado) {
    pendente.pagadorPerguntado = true
    pendente.esperandoPagador = true
    pendente.jaPerguntou = true
    return { perguntando: true, texto: perguntarPagador(pendente, dados, socios), desfecho: 'pergunta', pergunta: 'quem pagou' }
  }

  /*
    Parece com um lançamento recente: pode ser duplicata.

    PERGUNTA, não recusa. Valor repetido é comum de verdade — dois sacos de
    cimento no mesmo dia, a diária do mesmo pedreiro na semana seguinte. Quem
    sabe se é o mesmo pagamento é quem pagou, e barrar sozinho faria o robô
    engolir gasto legítimo em silêncio, que é o pior erro que ele pode
    cometer aqui.

    O que conta como "parece" está em duplicata.js. Olha a memória do robô e
    o que está no sistema — inclusive o que foi lançado à mão.
  */
  if (!pendente.duplicataConfirmada) {
    const novo = {
      obra: dados.obra,
      valor: dados.valor,
      documento: dados.documento,
      // A data com que este gasto vai entrar — a do comprovante, quando é
      // conhecida, que é a que quem lança à mão também usa — e o dia em que
      // foi mandado. A data lida no papel entra mesmo quando a leitura não
      // foi boa o bastante para valer no lançamento: aqui ela só serve para
      // PERGUNTAR, e perguntar a mais custa menos que deixar passar.
      datas: [dataDoGasto(pendente, dados), diaDoEnvio(pendente.enviadoEm), dados.dataComprovante],
      idMensagem: pendente.idMensagem,
    }

    /*
      No ATRASO a régua é outra, e mais graduada (ver `classificar`, em
      duplicata.js). Ali o robô não está conversando com quem acabou de
      pagar: está passando por centenas de comprovantes antigos, parte já
      digitada à mão. Mesmo documento e mesmo valor é "já lançado" e segue
      sem pergunta — perguntar cem vezes o óbvio faria a pessoa parar de
      responder antes de chegar nas dúvidas de verdade.
    */
    const igual = pendente.atraso ? classificar(novo, jaLancados) : parecido(novo, jaLancados)

    if (igual?.grau === 'ja-lancado') {
      console.log(`[gastos] ${pendente.de} → já lançado (mesmo documento e valor), não lancei de novo`)
      return { perguntando: false, texto: avisoDeJaLancado(igual), desfecho: 'ja-lancado', item: igual }
    }

    if (igual) {
      pendente.esperandoDuplicata = true
      pendente.jaPerguntou = true
      return {
        perguntando: true,
        texto: perguntaDeRepetido(igual),
        desfecho: 'pergunta',
        pergunta: igual.grau === 'duvida' ? 'dúvida de repetido' : 'provável repetido',
        item: igual,
      }
    }
  }

  if (ensaio) return { perguntando: false, texto: null, desfecho: 'lancaria' }

  return lancar(pendente, dados)
}
