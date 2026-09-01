/**
 * Módulo de gastos — comprovante que chega por mensagem vira lançamento
 * esperando aprovação no sistema de obras.
 *
 * O problema que ele resolve: os comprovantes já chegam todo dia num grupo,
 * com a descrição escrita do lado, e alguém precisa olhar cada um e digitar
 * no sistema de custos. São muitos por dia, e nem sempre há tempo.
 *
 * ── Como ele se comporta ─────────────────────────────────────────────────
 *
 * Chega uma foto. Ele lê a legenda, lê a imagem, e:
 *
 *  - Tem obra e valor  → LANÇA como gasto da equipe, já pendente. Você só
 *                        abre "Aprovar gastos" e confirma.
 *  - Falta alguma coisa → PERGUNTA no grupo ("Qual a obra?", "Qual o valor?")
 *                        e lança quando você responder.
 *  - Você não responde  → passado o prazo, manda para a caixa de
 *                        comprovantes, que é onde ficava antes. Comprovante
 *                        na caixa é pior que lançado, e melhor que perdido.
 *
 * ── O que ele NÃO faz ────────────────────────────────────────────────────
 *
 * Aprovar. O gasto nasce PENDENTE e vira despesa só quando uma pessoa
 * confirma — o mesmo botão de sempre. Aprovar sozinho trocaria "trabalho de
 * digitar" por "trabalho de auditar", que é pior.
 *
 * Este arquivo não sabe por onde a mensagem chegou. WhatsApp e Telegram
 * entregam a mesma coisa, e é isso que permite trocar de canal sem tocar
 * aqui.
 */
import { lerComprovante, visaoDisponivel } from './ia-visao.js'
import {
  enviarComprovante, lancarGasto, obrasDoSistema, obrasConfigurado,
} from './obras-client.js'
import { interpretar, combinar, nomesDe } from './lancamento.js'
import { norm } from './texto.js'

/**
 * Quem pode lançar.
 *
 * Isto é SEGURANÇA, não organização. Sem a lista, quem descobrir o número
 * manda uma foto e cria lançamento no financeiro da empresa. Números só com
 * dígitos, separados por vírgula, no .env:
 *
 *   GASTOS_AUTORIZADOS=5511999998888,5511977776666
 *
 * Lista vazia é tratada como "ninguém": um erro de configuração não pode
 * abrir a porta para todo mundo.
 */
const BRUTO_AUTORIZADOS = (process.env.GASTOS_AUTORIZADOS || '').split(',').map(x => x.trim()).filter(Boolean)

/**
 * "*" = qualquer pessoa, mas SÓ de dentro dos grupos cadastrados.
 *
 * Faz sentido quando o grupo é fechado e todo mundo nele pode lançar —
 * evita ter que cadastrar e manter a lista de cada gestor de obra.
 *
 * Só vale COM grupo definido, e é por isso que a checagem existe: sem
 * GASTOS_GRUPOS, o "*" valeria também para quem manda no privado, e aí
 * qualquer um que descubra o número lança no financeiro. Nesse caso ele é
 * recusado e o robô avisa alto, em vez de abrir a porta em silêncio.
 */
const QUALQUER_UM_DO_GRUPO = BRUTO_AUTORIZADOS.includes('*')

const AUTORIZADOS = new Set(
  BRUTO_AUTORIZADOS
    .filter(n => n !== '*')
    .map(n => n.replace(/\D/g, ''))
    .filter(Boolean),
)

/**
 * De onde os comprovantes vêm.
 *
 * Vazio = qualquer conversa, desde que o remetente esteja autorizado (é o
 * caso de quem manda direto no privado do bot). Preenchido, restringe ao
 * grupo: o robô fica calado em todo o resto, que é o que se quer quando ele
 * é membro de vários grupos.
 */
const GRUPOS = new Set(
  (process.env.GASTOS_GRUPOS || '').split(',').map(g => g.trim()).filter(Boolean),
)

/**
 * Também pelo NOME do grupo.
 *
 * Ninguém sabe de cabeça que o grupo dos comprovantes é
 * "120363044...@g.us", mas todo mundo sabe que ele se chama "Comprovantes".
 * Aceitar o nome tira um passo de configuração que só existia por limitação
 * nossa.
 */
const GRUPOS_NORM = new Set([...GRUPOS].map(g => norm(g)))

/**
 * Perigo do nome: qualquer um pode criar um grupo chamado "Comprovantes",
 * botar o robô dentro e mandar comprovante. Por isso o nome só vale junto
 * com a checagem de quem enviou — e é a razão de o coringa "*" exigir que a
 * pessoa esteja num grupo cadastrado, e não só que o grupo tenha o nome
 * certo.
 */

/**
 * Obras de reserva, do .env.
 *
 * A fonte de verdade é o sistema de obras (obrasDoSistema). Esta lista só
 * cobre o intervalo em que ele não responde — sem nome de obra nenhum, toda
 * legenda escrita corrido viraria "faltou a obra".
 */
const OBRAS_RESERVA = (process.env.GASTOS_OBRAS || '')
  .split(',').map(o => o.trim()).filter(Boolean)

/**
 * Quanto esperar por uma descrição que vem em mensagem separada.
 *
 * Muita gente manda a foto e escreve o "o que é" logo em seguida, em outra
 * mensagem. Enviar na hora perderia essa descrição — e é ela que diz de qual
 * obra é o gasto, que o comprovante não informa.
 */
const ESPERA_DESCRICAO_MS = Number(process.env.GASTOS_ESPERA_DESCRICAO_MS || 60000)

/**
 * Quanto esperar pela RESPOSTA a uma pergunta.
 *
 * Bem mais longo que a espera pela legenda: aqui a pessoa já foi
 * interpelada, e no canteiro ela larga o celular no bolso e volta meia hora
 * depois. Passado o prazo, o comprovante vai para a caixa em vez de sumir.
 */
const ESPERA_RESPOSTA_MS = Number(process.env.GASTOS_ESPERA_RESPOSTA_MS || 1000 * 60 * 30)

/**
 * Quantos comprovantes podem ficar esperando resposta ao mesmo tempo.
 *
 * Cada um segura o ARQUIVO em memória — até 20 MB — por até meia hora. Sem
 * teto, um dia movimentado com todo mundo mandando foto e ninguém
 * respondendo encheria a memória do processo e derrubaria o robô, que é bem
 * pior que um comprovante ir para a caixa mais cedo.
 *
 * Estourado o teto, o mais ANTIGO vai para a caixa: ele é o que tem menos
 * chance de ainda receber resposta.
 */
const MAX_AGUARDANDO = Number(process.env.GASTOS_MAX_AGUARDANDO || 30)

/** remetente -> { pendente, prazo, perguntando } */
const aguardando = new Map()

/**
 * Guarda um pendente, abrindo espaço se preciso.
 *
 * O Map preserva a ordem de inserção, então o primeiro é o mais antigo.
 */
function guardar(de, entrada) {
  if (aguardando.size >= MAX_AGUARDANDO && !aguardando.has(de)) {
    const [maisAntigo, velho] = aguardando.entries().next().value ?? []
    if (velho) {
      clearTimeout(velho.prazo)
      aguardando.delete(maisAntigo)
      console.warn(`[gastos] ${MAX_AGUARDANDO} comprovantes esperando — mandando o mais antigo para a caixa.`)
      paraCaixa(velho.pendente).then(r => avisar(velho.pendente, r))
    }
  }
  aguardando.set(de, entrada)
}

export function coringaInvalido() {
  return QUALQUER_UM_DO_GRUPO && GRUPOS.size === 0
}

export function gastosAtivo() {
  if (coringaInvalido()) return false
  const temQuem = AUTORIZADOS.size > 0 || QUALQUER_UM_DO_GRUPO
  return temQuem && obrasConfigurado()
}

/**
 * Este remetente pode lançar gasto?
 *
 * `deGrupoCadastrado` diz se a mensagem veio de um grupo da lista — é o que
 * o coringa exige. Sem isso, "*" valeria para quem manda no privado também.
 */
export function autorizado(de, deGrupoCadastrado = false) {
  if (AUTORIZADOS.has((de || '').replace(/\D/g, ''))) return true
  if (QUALQUER_UM_DO_GRUPO && GRUPOS.size > 0 && deGrupoCadastrado) return true
  return false
}

/**
 * A mensagem veio de onde os comprovantes devem vir?
 *
 * Aceita o identificador técnico do grupo OU o nome dele — quem configura
 * sabe o nome, não o identificador.
 */
export function origemAceita(chat, chatNome) {
  if (GRUPOS.size === 0) return true
  if (GRUPOS.has(String(chat ?? ''))) return true
  if (chatNome && GRUPOS_NORM.has(norm(chatNome))) return true
  return false
}

/** As obras conhecidas agora: as do sistema, ou a reserva do .env. */
async function obrasConhecidas() {
  return (await obrasDoSistema()) ?? OBRAS_RESERVA
}

/** Diagnóstico, para o /metricas. */
export function situacao() {
  return {
    ativo: gastosAtivo(),
    autorizados: AUTORIZADOS.size,
    grupos: GRUPOS.size ? [...GRUPOS] : 'qualquer origem',
    quemPodeLancar: QUALQUER_UM_DO_GRUPO
      ? (GRUPOS.size ? 'qualquer um dos grupos cadastrados' : 'RECUSADO: "*" exige GASTOS_GRUPOS')
      : `${AUTORIZADOS.size} número(s) na lista`,
    leituraPorIA: visaoDisponivel(),
    obras: obrasConfigurado(),
    obrasReserva: OBRAS_RESERVA.length,
    esperandoResposta: aguardando.size,
  }
}

/** "R$ 1.234,50" */
function moeda(v) {
  return v == null ? null : `R$ ${v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`
}

/** "28/08" — o ano só aparece quando não é o corrente, para a linha ficar curta. */
function dataCurta(iso) {
  if (!iso) return null
  const [a, m, d] = iso.split('-')
  return Number(a) === new Date().getFullYear() ? `${d}/${m}` : `${d}/${m}/${a}`
}

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
    dados?.documento ? `doc ${dados.documento}` : null,
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
 * Palavras que perguntam se ele está vivo.
 *
 * Existe porque a primeira coisa que se faz ao ligar o robô é mandar um
 * "oi" no grupo — e ele fica calado, de propósito, já que só reage a
 * comprovante. O silêncio é o certo na operação e é péssimo na hora de
 * instalar: não dá para distinguir "funcionando" de "nem conectou".
 */
const PERGUNTAS_DE_TESTE = /^\s*(ping|teste|testando|robo|robô|status|voce esta ai|você está aí|ta ai|tá aí)\s*[?!.]*\s*$/i

/** Quem desiste de responder. */
const DESISTENCIA = /^\s*(cancelar|cancela|deixa|deixa pra la|deixa pra lá|esquece|nao sei|não sei|depois)\s*[!.]*\s*$/i

export async function tratar(msg) {
  const { de, chat, chatNome, arquivo, nomeArquivo, tipo, texto, idMensagem } = msg

  const daOrigemCerta = origemAceita(chat, chatNome)
  if (!daOrigemCerta) return null

  // O coringa só vale vindo de grupo cadastrado — no privado, nunca.
  if (!autorizado(de, daOrigemCerta && Boolean(msg.ehGrupo))) {
    // Nem responde. Dizer "você não pode" a quem mandou foto num grupo
    // confirma que existe um robô ouvindo e convida a insistir.
    if (arquivo) console.warn(`[gastos] comprovante ignorado: ${de} não está em GASTOS_AUTORIZADOS`)
    return null
  }

  if (!arquivo && PERGUNTAS_DE_TESTE.test(texto ?? '')) return respostaDeTeste()

  // Texto solto: pode ser a resposta a uma pergunta, ou a descrição da foto
  // que acabou de chegar.
  if (!arquivo) return responderPendencia(de, texto)

  // Chegou arquivo — se havia outro esperando, esse não vem mais.
  const anterior = aguardando.get(de)
  if (anterior) {
    clearTimeout(anterior.prazo)
    aguardando.delete(de)
    // A foto nova encerra a espera da anterior: ela vai pelo caminho que der,
    // sem travar esta. Se havia promessa aberta, resolve; senão, avisa pelo
    // canal — de um jeito ou de outro a pessoa fica sabendo o que aconteceu.
    concluir(anterior.pendente).then((r) => {
      if (anterior.pendente.responder) anterior.pendente.responder(r)
      else avisar(anterior.pendente, r)
    })
  }

  const pendente = {
    de, arquivo, nomeArquivo, tipo,
    descricao: texto || null,
    idMensagem,
    enviadoEm: msg.enviadoEm ?? Date.now(),
    // Como falar com quem mandou, quando não for resposta a nada.
    enviar: msg.enviarResposta,
  }

  // Legenda junto da foto: dá para processar já.
  if (texto?.trim()) return processar(pendente)

  // Sem legenda: segura um pouco, porque a descrição costuma vir na
  // mensagem seguinte, e é ela que diz de qual obra é o gasto.
  return esperar(pendente, ESPERA_DESCRICAO_MS)
}

/**
 * Segura o comprovante esperando a legenda que vem na mensagem seguinte.
 *
 * Devolve uma promessa em vez de texto para a confirmação sair como resposta
 * à FOTO, e não à legenda — num grupo com várias pessoas mandando ao mesmo
 * tempo, confirmação solta não diz de qual comprovante é.
 */
function esperar(pendente, ms) {
  return new Promise((resolve) => {
    pendente.responder = resolve
    const prazo = setTimeout(async () => {
      aguardando.delete(pendente.de)
      resolve(await processar(pendente, { acabouOTempo: true }))
    }, ms)
    prazo.unref?.()
    guardar(pendente.de, { pendente, prazo, perguntando: false })
  })
}

/**
 * Diz alguma coisa FORA da resposta a uma mensagem.
 *
 * Precisa existir porque nem tudo acontece em resposta a algo: o prazo da
 * pergunta estoura sozinho, meia hora depois, e o comprovante vai para a
 * caixa — se ninguém for avisado, a pessoa fica achando que ele se perdeu.
 *
 * O canal é quem sabe mandar; aqui só se usa o que ele entregou. Sem isso,
 * registra e segue: falar é desejável, e não conseguir falar não pode
 * derrubar o lançamento.
 */
async function avisar(pendente, texto) {
  if (!texto) return
  try {
    if (typeof pendente.enviar === 'function') await pendente.enviar(texto)
    else console.log(`[gastos] (sem canal para avisar) ${pendente.de}: ${texto.replace(/\n/g, ' / ')}`)
  } catch (e) {
    console.warn('[gastos] não consegui avisar:', e.message)
  }
}

/**
 * Chegou texto de alguém que tem comprovante parado.
 *
 * Pode ser a descrição que faltava, ou a resposta a uma pergunta. Nos dois
 * casos, quem responde é a promessa que ficou aberta lá no tratar(), para a
 * confirmação sair como resposta à FOTO e não a este texto.
 */
function responderPendencia(de, texto) {
  const esperando = aguardando.get(de)
  if (!esperando || !texto?.trim()) return null

  clearTimeout(esperando.prazo)
  aguardando.delete(de)
  const { pendente } = esperando

  if (DESISTENCIA.test(texto)) {
    // Desistiu de responder: manda para a caixa em vez de perder.
    return paraCaixa(pendente)
  }

  if (esperando.perguntando) {
    // É a RESPOSTA à pergunta. Acumula com o que já se sabia, em vez de
    // substituir: quem responde só "1400" não está apagando a obra que
    // tinha escrito antes.
    pendente.respostas = [...(pendente.respostas ?? []), texto.trim()]

    // "1" ou "2" respondendo a uma lista numerada.
    //
    // É o que a pessoa faz quando o robô acabou de listar as opções, e sem
    // isto o número seria lido como VALOR — "1" viraria R$ 1,00 e o gasto
    // entraria errado.
    const so = texto.trim().replace(/[).\s]+$/, '')
    if (/^\d{1,2}$/.test(so) && pendente.opcoes?.length) {
      const i = Number(so) - 1
      if (i >= 0 && i < pendente.opcoes.length) {
        pendente.respostas = pendente.respostas.slice(0, -1)
        pendente.obraEscolhida = pendente.opcoes[i]
      }
    }

    // Aqui a confirmação sai como resposta a ESTA mensagem, e não à foto:
    // a pessoa acabou de responder e é para ela que se está falando.
    return processar(pendente)
  }

  // Era a legenda que faltava. A confirmação pertence à FOTO, então quem
  // responde é a promessa que ficou aberta lá no tratar().
  pendente.descricao = texto.trim()
  processar(pendente).then(r => pendente.responder?.(r))
  return null
}

/**
 * Junta tudo que se sabe, e decide: lança, pergunta, ou manda para a caixa.
 */
async function processar(pendente, { acabouOTempo = false } = {}) {
  const obras = await obrasConhecidas()

  // Tudo que a pessoa escreveu, na legenda e nas respostas, lido junto.
  //
  // Junto e não separado: quem manda a foto com "bastos haia" e depois
  // responde "1400" só tem um lançamento na cabeça, e interpretar as duas
  // frases isoladamente perderia a metade de cada uma.
  const escritoTudo = [pendente.descricao, ...(pendente.respostas ?? [])]
    .filter(Boolean).join(', ')

  const escrito = interpretar(escritoTudo, obras)

  // A imagem é lida uma vez só e guardada: numa segunda passada depois da
  // resposta, reler custaria mais 20 segundos e daria o mesmo resultado.
  if (pendente.lido === undefined) {
    pendente.lido = await lerComprovante({
      arquivo: pendente.arquivo, tipo: pendente.tipo, descricao: escritoTudo,
    }).catch(() => null)
    console.log('[gastos] leitura da imagem:', pendente.lido ? JSON.stringify(pendente.lido) : 'nenhuma')
  }

  const dados = combinar(escrito, pendente.lido)

  // Obra escolhida pelo número da lista manda em tudo: foi a pessoa que
  // apontou, e não há leitura de texto que valha mais que isso.
  if (pendente.obraEscolhida) dados.obra = pendente.obraEscolhida

  pendente.dados = dados

  // Faltando obra ou valor, PERGUNTA — desde que ainda dê para perguntar.
  const falta = []
  if (!dados.obra) falta.push('obra')
  if (dados.valor == null) falta.push('valor')

  if (falta.length && !acabouOTempo && !pendente.jaPerguntou) {
    return perguntar(pendente, falta, obras)
  }

  if (falta.length) return paraCaixa(pendente)

  return lancar(pendente, dados)
}

/** Faz a pergunta e fica esperando a resposta. */
function perguntar(pendente, falta, obras) {
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
    tipicamente, quando há duas obras nela. Aí a pergunta é entre essas
    duas, e não entre todas: é mais curta, e mostra que ele entendeu o que
    foi dito em vez de ignorar.
  */
  const candidatos = d?.candidatos ?? null

  if (candidatos?.length) {
    linhas.push(`Aí tem mais de uma obra. É qual delas?`)
    candidatos.forEach((o, i) => linhas.push(`${i + 1}) ${o}`))
    if (falta.includes('valor')) linhas.push('E qual foi o *valor*?')
  } else if (falta.includes('obra') && falta.includes('valor')) {
    linhas.push('Só faltou a *obra* e o *valor*. Me manda os dois?')
  } else if (falta.includes('obra')) {
    linhas.push('De qual *obra* é esse gasto?')
  } else {
    linhas.push('Qual foi o *valor*?')
  }

  // Oferece as obras quando são poucas: escolher de uma lista é mais rápido
  // e erra menos que lembrar o nome exato.
  const nomes = nomesDe(obras)
  if (!candidatos?.length && falta.includes('obra') && nomes.length && nomes.length <= 12) {
    linhas.push(`(${nomes.join(' · ')})`)
  }

  // Guarda as opções numeradas: responder "1" é o jeito mais rápido, e é o
  // que a pessoa vai fazer se o robô acabou de listar 1) e 2).
  pendente.opcoes = candidatos?.length ? candidatos : (nomes.length <= 12 ? nomes : null)

  // A pergunta sai AGORA, como resposta à foto. A confirmação virá depois,
  // como resposta ao que a pessoa responder — por isso aqui não se abre
  // promessa nenhuma: ela ficaria pendente para sempre.
  const prazo = setTimeout(async () => {
    aguardando.delete(pendente.de)
    // Não respondeu: caixa, que é onde ficava antes. Comprovante na caixa é
    // pior que lançado, e muito melhor que perdido. E precisa ser DITO, ou a
    // pessoa fica achando que sumiu.
    await avisar(pendente, await paraCaixa(pendente))
  }, ESPERA_RESPOSTA_MS)
  prazo.unref?.()
  guardar(pendente.de, { pendente, prazo, perguntando: true })

  return linhas.join('\n')
}

/** Lança como gasto da equipe, pendente de aprovação. */
async function lancar(pendente, dados) {
  const data = new Date(pendente.enviadoEm ?? Date.now()).toISOString().slice(0, 10)

  const r = await lancarGasto({
    arquivo: pendente.arquivo,
    nomeArquivo: pendente.nomeArquivo,
    tipo: pendente.tipo,
    obra: dados.obra,
    valor: dados.valor,
    descricao: dados.descricao || dados.estabelecimento || 'Comprovante enviado pelo WhatsApp',
    categoria: dados.tipo,
    data,
    fornecedor: dados.estabelecimento,
    observacao: dados.valorDigitado ? null : 'Valor lido da imagem pelo robô — confira.',
    idMensagem: pendente.idMensagem,
  })

  if (r.ok) {
    console.log(`[gastos] ${pendente.de} → LANÇADO em ${r.obra} (${moeda(dados.valor)})`)
    const linhas = [`✅ ${r.mensagem || 'Lançado, aguardando aprovação.'}`]
    linhas.push([
      r.obra, dados.descricao,
      dados.tipo ? dados.tipo.replace(/_/g, ' ').toLowerCase() : null,
      moeda(dados.valor),
    ].filter(Boolean).join(' · '))
    if (!dados.valorDigitado) linhas.push('⚠ Esse valor eu li da imagem. Confere ao aprovar.')
    return linhas.join('\n')
  }

  // A obra não foi reconhecida pelo SISTEMA (não pela nossa lista): pergunta
  // com os nomes que ele mesmo devolveu, que são os certos.
  if (r.obraNaoAchada && !pendente.jaPerguntouObra) {
    pendente.jaPerguntouObra = true
    pendente.jaPerguntou = false
    pendente.dados = { ...dados, obra: null }
    return perguntar(pendente, ['obra'], r.obras ?? [])
  }

  // Sem a rota nova no servidor, ou qualquer outra falha: caixa.
  if (r.semRota) {
    console.warn('[gastos] servidor ainda sem /lancar — mandando para a caixa.')
  } else {
    console.warn('[gastos] lançamento falhou:', r.motivo ?? r.status)
  }
  return paraCaixa(pendente)
}

/** Manda para a caixa de comprovantes — o caminho de quando não dá para lançar. */
async function paraCaixa(pendente) {
  const dados = pendente.dados ?? {}
  const envio = await enviarComprovante({
    arquivo: pendente.arquivo,
    nomeArquivo: pendente.nomeArquivo,
    tipo: pendente.tipo,
    texto: montarTexto(dados, pendente.lido?.observacao),
    idMensagem: pendente.idMensagem,
    extras: {
      obra: dados.obra,
      descricao: dados.descricao,
      categoria: dados.tipo,
      valor: dados.valor,
      data: new Date(pendente.enviadoEm ?? Date.now()).toISOString().slice(0, 10),
      dataComprovante: dados.dataComprovante,
      estabelecimento: dados.estabelecimento,
      documento: dados.documento,
      formaPagamento: dados.formaPagamento,
      confianca: dados.confianca,
    },
  })

  console.log(`[gastos] ${pendente.de} → caixa: ${envio.ok ? 'ok' : envio.motivo}`)

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
  if (falta.length) linhas.push(`Faltou ${falta.join(' e ')} — completa na hora de lançar.`)
  return linhas.join('\n')
}

/** Resolve um pendente pelo caminho que der, sem perguntar de novo. */
async function concluir(pendente) {
  return processar(pendente, { acabouOTempo: true })
}

function respostaDeTeste() {
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
  linhas.push('_bastos haia, tijolos e areia, material, 2500,00_')
  linhas.push('Se faltar alguma coisa, eu pergunto.')
  return linhas.join('\n')
}

/**
 * Manda para a caixa tudo que está esperando, antes de o processo morrer.
 *
 * Sem isto, um deploy no meio da tarde perde silenciosamente os
 * comprovantes que estavam esperando resposta: a pessoa respondeu a
 * pergunta e não recebe nada, e a foto se foi. Na caixa ela pelo menos
 * existe, e alguém completa.
 *
 * Devolve quantos foram descarregados, para quem chama registrar.
 */
export async function encerrar() {
  const pendentes = [...aguardando.values()]
  if (!pendentes.length) return 0

  for (const { prazo } of pendentes) clearTimeout(prazo)
  aguardando.clear()

  console.log(`[gastos] encerrando — mandando ${pendentes.length} comprovante(s) que esperavam para a caixa.`)
  await Promise.allSettled(pendentes.map(async ({ pendente }) => {
    const r = await paraCaixa(pendente)
    await avisar(pendente, `⚠ Precisei reiniciar antes de você responder.\n${r}`)
  }))
  return pendentes.length
}

/** Só para teste: esquece as fotos seguradas. */
export function _limparPendentes() {
  for (const { prazo } of aguardando.values()) clearTimeout(prazo)
  aguardando.clear()
}
