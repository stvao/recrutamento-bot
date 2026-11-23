/**
 * Comprovantes — para onde o comprovante vai: LANÇADO como gasto pendente no
 * sistema de obras, ou mandado para a CAIXA de comprovantes quando não dá.
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 */
import { enviarComprovante, lancarGasto } from './obras-client.js'
import { perguntar } from './perguntas.js'
import { moeda, dataCurta } from './formato.js'
import * as pendentes from './pendentes.js'
import * as memoria from './memoria.js'

/**
 * O resumo que vai no campo `texto` do comprovante.
 *
 * Usado só no caminho da CAIXA — quando não deu para lançar. É por esta
 * linha que a pessoa confere sem abrir a foto, então ela sai na ordem em que
 * se lê um lançamento: obra, o que foi, tipo, quanto.
 */
export function montarTexto(dados, observacao) {
  const linhas = []

  const cabeca = [
    dados?.obra,
    dados?.descricao,
    dados?.tipo ? dados.tipo.replace(/_/g, ' ').toLowerCase() : null,
    moeda(dados?.valor),
  ].filter(Boolean)
  if (cabeca.length) linhas.push(cabeca.join(' · '))

  const detalhe = [
    dados?.estabelecimento && dados.estabelecimento !== dados.descricao ? dados.estabelecimento : null,
    dados?.formaPagamento,
    (dados?.documentoLido ?? dados?.documento) ? `doc ${dados.documentoLido ?? dados.documento}` : null,
    dados?.dataComprovante ? `comprovante de ${dataCurta(dados.dataComprovante)}` : null,
  ].filter(Boolean)
  if (detalhe.length) linhas.push(detalhe.join(' · '))

  if (observacao) linhas.push(`⚠ ${observacao}`)

  // Só avisa quando o valor veio de máquina. Valor digitado por gente não
  // precisa de aviso — e encher de alerta o que está certo faz a pessoa
  // parar de ler os alertas.
  if (dados?.valor != null && !dados.valorDigitado) {
    linhas.push('(valor lido da imagem, não digitado — confira)')
  }
  if (dados?.valor == null) linhas.push('(sem valor — precisa digitar)')

  return linhas.join('\n') || 'Comprovante enviado pelo WhatsApp.'
}

/**
 * O dia em que o comprovante foi mandado, em Brasília.
 *
 * Era toISOString(), que é UTC: o recibo da janta, do hotel ou do
 * combustível mandado depois das 21h entrava com a data do dia seguinte — e
 * no último dia do mês, no mês seguinte.
 */
export function diaDoEnvio(enviadoEm) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' })
    .format(new Date(enviadoEm ?? Date.now()))
}

/**
 * Até quantos dias antes do envio a data lida no papel ainda vale.
 *
 * Comprovante se manda atrasado — uma semana, um mês quando alguém junta
 * tudo. Mas uma data de muito tempo atrás, vinda de leitura de foto, é mais
 * provavelmente um ano lido errado do que um recibo esquecido por quatro
 * meses.
 */
const DATA_LIDA_ATE_DIAS = 120

/** A partir de quantos dias de diferença para o envio a confirmação avisa. */
const AVISAR_DATA_APOS_DIAS = 3

const diasEntre = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / (24 * 60 * 60 * 1000)

/**
 * A data com que o gasto entra.
 *
 * Era sempre o dia do envio. Só que comprovante se manda depois: o recibo do
 * dia 30 mandado no dia 4 entrava no mês seguinte, e o custo da obra saía
 * errado nos dois meses.
 *
 * A ordem é a de sempre — o que a pessoa digitou ganha da IA:
 *
 *  1. a data que a pessoa ESCREVEU ("dia 30/10");
 *  2. a data que a IA LEU no papel, se a leitura é de confiança alta ou
 *     média, não é depois do dia em que a foto foi mandada (recibo do futuro
 *     é leitura errada) e não tem mais de 120 dias;
 *  3. o dia do envio, como era antes.
 */
export function dataDoGasto(pendente, dados) {
  const envio = diaDoEnvio(pendente?.enviadoEm)
  if (dados?.dataEscrita) return dados.dataEscrita

  const lida = dados?.dataComprovante
  if (lida && ['alta', 'media'].includes(dados.confiancaLeitura)
    && lida <= envio && diasEntre(lida, envio) <= DATA_LIDA_ATE_DIAS) {
    return lida
  }
  return envio
}

/** Lança como gasto da equipe, pendente de aprovação. */
export async function lancar(pendente, dados) {
  const data = dataDoGasto(pendente, dados)

  const r = await lancarGasto({
    arquivo: pendentes.arquivoDe(pendente),
    nomeArquivo: pendente.nomeArquivo,
    tipo: pendente.tipo,
    obra: dados.obra,
    valor: dados.valor,
    descricao: dados.descricao || dados.estabelecimento || 'Comprovante enviado pelo WhatsApp',
    categoria: dados.tipo,
    data,
    fornecedor: dados.estabelecimento,
    observacao: dados.valorDigitado ? null : 'Valor lido da imagem pelo robô — confira.',
    rateio: dados.rateio,
    pagoPor: dados.pagoPor,
    // Vira o Idempotency-Key. Tem de ser ESTÁVEL para este comprovante: com
    // `confirmadoOutro` o sistema pula todas as travas de repetido, e a única
    // coisa que impede um reenvio (queda de rede, webhook reentregue) de criar
    // o gasto em dobro é a chave ser a mesma. Sem id da mensagem, vale o id
    // da ficha, que mora em disco e não muda.
    idMensagem: pendente.idMensagem ?? pendente.id,
    // A pessoa disse "é outro". Sem avisar o sistema, a trava de reenvio de
    // lá engolia este segundo gasto como se fosse o primeiro de novo.
    confirmadoOutro: !!pendente.duplicataConfirmada,
    // Pago direto pela empresa: não há reembolso a ninguém.
    //
    // No atraso todo comprovante nasce como "a empresa pagou". Mas se a
    // legenda diz quem pagou ("pago por Fulano"), a legenda ganha — é a regra
    // de sempre, o que a pessoa escreveu vale mais que a suposição.
    empresaPagou: !!pendente.empresaPagou && !(pendente.legendaGanhaPagador && dados.pagoPor),
    // Por onde o sistema reconhece o mesmo comprovante mandado duas vezes.
    documento: dados.documento,
    arquivoHash: pendente.arquivoHash,
    // Quem mandou a mensagem, para o reembolso. O atraso não manda: lá o
    // remetente é um NOME tirado da conversa exportada, não um telefone em
    // que se possa confiar — e a ficha dele nem tem este campo.
    enviadoPor: pendente.enviadoPor ?? null,
  })

  if (r.ok && r.reenvio) {
    // O sistema reconheceu como o MESMO gasto já lançado: não entrou nada
    // novo. Anotar de novo somava o valor duas vezes no resumo do dia.
    console.log(`[gastos] ${pendente.de} → reenvio, o sistema devolveu o gasto já lançado`)
    return { perguntando: false, texto: `ℹ️ ${r.mensagem || 'Esse comprovante já tinha sido lançado.'}`, desfecho: 'reenvio' }
  }

  if (r.ok) {
    console.log(`[gastos] ${pendente.de} → LANÇADO em ${r.obra} (${moeda(dados.valor)})`)
    memoria.anotarLancamento({
      obra: r.obra, valor: dados.valor, descricao: dados.descricao,
      categoria: dados.tipo, de: pendente.de, resultado: 'lancado',
      idMensagem: pendente.idMensagem,
      documento: dados.documento, arquivoHash: pendente.arquivoHash,
      data,
    })
    const linhas = [`✅ ${r.mensagem || 'Lançado, aguardando aprovação.'}`]
    linhas.push([
      r.rateio?.length > 1 ? null : r.obra,
      dados.descricao,
      dados.tipo ? dados.tipo.replace(/_/g, ' ').toLowerCase() : null,
      moeda(dados.valor),
    ].filter(Boolean).join(' · '))

    // Rateado: mostra quanto foi para cada obra. É o que a pessoa precisa
    // conferir — o total ela já sabe, está no comprovante na mão dela.
    if (r.rateio?.length > 1) {
      for (const parte of r.rateio) linhas.push(`  · ${parte.obra}: ${moeda(parte.valor)}`)
    }

    // Quem bancou entra na confirmação: é a informação que some mais fácil,
    // e quem mandou a foto precisa ver que ela foi entendida.
    if (r.pagoPor) {
      linhas.push(`  pago por ${r.pagoPor}`)
    } else if (dados.pagoPor) {
      // Nome escrito que o sistema não reconheceu. O gasto entrou — recusar
      // o comprovante por causa de um nome seria trocar uma informação a
      // menos por um comprovante a menos —, mas quem mandou precisa saber.
      linhas.push(`⚠ Não achei "${dados.pagoPor}" no sistema — lancei sem o pagador.`)
    }

    /*
      De quem é o reembolso.

      Só quando o gasto ficou REEMBOLSÁVEL: nem a empresa pagou direto, nem
      um sócio bancou. Aí alguém tirou do bolso, e o sistema registra a
      dívida no nome de uma pessoa — antes, sempre no de quem é dono do
      token do robô, que não gastou nada.

      O sistema devolve o nome de quem ele reconheceu pelo telefone. Não
      reconheceu? O reembolso ficou no nome de quem aprova, e quem mandou a
      foto precisa saber agora — depois ninguém lembra de quem era.
      Servidor que ainda não conhece o campo não devolve nada, e nada se diz.
    */
    const reembolsavel = !pendente.empresaPagou && !r.pagoPor
    if (reembolsavel && typeof r.enviadoPor === 'string' && r.enviadoPor.trim()) {
      linhas.push(`  reembolso para ${r.enviadoPor.trim()}`)
    } else if (reembolsavel && r.enviadoPor === null && pendente.enviadoPor) {
      linhas.push('⚠ O número de quem mandou não está cadastrado no sistema — o reembolso ficou no nome de quem aprova.')
    }

    // O gasto entrou num dia que não é o de hoje — às vezes em outro mês.
    // Sem dizer, a pessoa procura o lançamento no dia em que mandou a foto e
    // conclui que ele sumiu.
    if (diasEntre(data, diaDoEnvio(pendente.enviadoEm)) > AVISAR_DATA_APOS_DIAS) {
      linhas.push(`  comprovante de ${dataCurta(data)}`)
    }

    if (!dados.valorDigitado) linhas.push('⚠ Esse valor eu li da imagem. Confere ao aprovar.')

    // Dizer que aprendeu não é enfeite: é o que faz a pessoa confiar em
    // escrever daquele jeito de novo, em vez de achar que deu sorte.
    if (pendente.apelidoAprendido) {
      linhas.push(`_(anotei que "${pendente.apelidoAprendido}" é essa obra — da próxima vez já sei)_`)
    }

    return { perguntando: false, texto: linhas.join('\n'), desfecho: 'lancado' }
  }

  // A obra não foi reconhecida pelo SISTEMA (não pela nossa lista): pergunta
  // de novo com os nomes que ele mesmo devolveu, que são os certos.
  if (r.obraNaoAchada && !pendente.jaPerguntouObra) {
    pendente.jaPerguntouObra = true
    pendente.jaPerguntou = false
    // O que a pessoa escreveu COMO obra e o sistema não reconheceu. É daqui
    // que se aprende o apelido quando ela apontar a obra — e não da descrição
    // da compra, que é o que sobrava depois de zerar a obra.
    if (dados.obra) pendente.obraEscrita = String(dados.obra)
    pendente.dados = { ...dados, obra: null }
    return { perguntando: true, texto: perguntar(pendente, ['obra'], r.obras ?? []), desfecho: 'pergunta', pergunta: 'obra' }
  }

  if (r.semRota) console.warn('[gastos] servidor ainda sem /lancar — mandando para a caixa.')
  else console.warn('[gastos] lançamento falhou:', r.motivo ?? r.status)

  const cx = await paraCaixa(pendente)
  return { perguntando: false, texto: cx.texto, caixaRecusou: !cx.ok, desfecho: cx.ok ? 'caixa' : 'caixa-recusou' }
}

/**
 * Manda para a caixa — o caminho de quando não dá para lançar.
 *
 * Devolve { ok, texto }. Quem chama só tira o comprovante da espera com
 * ok: antes ele era apagado mesmo quando a caixa recusava (Obras fora do ar,
 * token revogado, limite de envios) — e não ficava em lugar nenhum.
 */
export async function paraCaixa(pendente) {
  const texto = await textoDaCaixa(pendente)
  const ok = !pendente.caixaRecusouEm
  return { ok, texto }
}

async function textoDaCaixa(pendente) {
  const dados = pendente.dados ?? {}
  const envio = await enviarComprovante({
    arquivo: pendentes.arquivoDe(pendente),
    nomeArquivo: pendente.nomeArquivo,
    tipo: pendente.tipo,
    texto: montarTexto(dados, pendente.lido?.observacao),
    idMensagem: pendente.idMensagem ?? pendente.id,
    extras: {
      obra: dados.obra,
      descricao: dados.descricao,
      categoria: dados.tipo,
      valor: dados.valor,
      // A mesma data que o lançamento usaria: é com ela que o formulário
      // da caixa abre preenchido.
      data: dataDoGasto(pendente, dados),
      dataComprovante: dados.dataComprovante,
      estabelecimento: dados.estabelecimento,
      documento: dados.documento,
      arquivoHash: pendente.arquivoHash,
      enviadoPor: pendente.enviadoPor ?? null,
      formaPagamento: dados.formaPagamento,
      confianca: dados.confianca,
    },
  })

  console.log(`[gastos] ${pendente.de} → caixa: ${envio.ok ? 'ok' : envio.motivo}`)
  if (envio.ok) delete pendente.caixaRecusouEm
  else pendente.caixaRecusouEm = Date.now()
  if (envio.ok) {
    memoria.anotarLancamento({
      obra: dados.obra, valor: dados.valor, descricao: dados.descricao,
      categoria: dados.tipo, de: pendente.de, resultado: 'caixa',
      idMensagem: pendente.idMensagem,
      documento: dados.documento, arquivoHash: pendente.arquivoHash,
      data: dataDoGasto(pendente, dados),
    })
  }

  if (!envio.ok) {
    if (envio.status === 401) return '❌ Meu acesso ao sistema de obras foi recusado (token inválido ou revogado). Avisa quem cuida do sistema.'
    if (envio.status === 429) return '⏳ Muitos envios de uma vez. Manda esse de novo daqui a um minuto, por favor.'
    if (envio.motivo === 'grande-demais') return '❌ O arquivo passou de 20 MB. Manda a foto em vez do PDF, ou tira outra foto.'
    if (envio.status === 400) return `❌ O sistema de obras não aceitou esse arquivo (${envio.motivo}).`
    return '❌ Não consegui falar com o sistema de obras agora. Manda de novo daqui a pouco — não vai duplicar.'
  }

  const linhas = [`📥 ${envio.mensagem || 'Comprovante recebido.'}`]
  const resumo = [
    dados.obra, dados.descricao,
    dados.tipo ? dados.tipo.replace(/_/g, ' ').toLowerCase() : null,
    moeda(dados.valor),
  ].filter(Boolean)
  if (resumo.length) linhas.push(resumo.join(' · '))

  const falta = [!dados.obra && 'a obra', dados.valor == null && 'o valor'].filter(Boolean)
  if (falta.length) linhas.push(`Faltou ${falta.join(' e ')} — completa em /m/gasto, na caixa.`)
  return linhas.join('\n')
}
