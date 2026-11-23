/**
 * Cliente do Nova Gestão Obras — envia o comprovante para a caixa de
 * aprovação. É aqui (e só aqui) que o robô "conversa" com o sistema de obras,
 * pela mesma convenção do rh-client.js.
 *
 * O comprovante NÃO vira custo direto. Ele cai na caixa "Comprovantes
 * recebidos", no topo de /m/gasto e /m/gasto-campo, e alguém toca em
 * "Lançar", confere e salva. A IA erra — lê 1.500 onde era 1.800, troca a
 * data, erra a categoria — e lançar direto no custo trocaria "trabalho de
 * digitar" por "trabalho de auditar", que é pior.
 *
 * O token é restrito: cria comprovante e gasto pendente, lista as obras e
 * consulta o que já foi lançado (para reconhecer repetido). Não lança conta
 * e não aprova. Gera-se em "Enviar pelo iPhone" (/m/atalho), aparece uma vez
 * só, e é revogável na mesma tela.
 */
const OBRAS_API_URL = process.env.OBRAS_API_URL || 'https://novagestaoobras.duckdns.org'
const OBRAS_API_TOKEN = process.env.OBRAS_API_TOKEN || ''

/**
 * Mandar também os campos estruturados que a IA leu.
 *
 * O contrato de hoje aceita só `arquivo` e `texto` livre — nesse caminho a
 * pessoa lê o resumo na caixa e digita o valor à mão. Quando o endpoint
 * ganhar `valor`, `data`, `categoria` e `obraId`, o formulário passa a abrir
 * preenchido, que é onde está o ganho de verdade.
 *
 * Enquanto isso, os campos vão junto: multipart com campo que o servidor não
 * conhece é ignorado sem erro. Se a validação do lado de lá for estrita e
 * recusar, desligue com OBRAS_CAMPOS_EXTRA=0 — o envio continua funcionando
 * pelo caminho do texto.
 */
const MANDAR_CAMPOS_EXTRA = process.env.OBRAS_CAMPOS_EXTRA !== '0'

/**
 * O endpoint já recusou os campos extras?
 *
 * Descoberto na primeira tentativa e lembrado daí em diante. Sem isso, todo
 * comprovante seria enviado duas vezes — a primeira para tomar 400 — e o
 * limite de 30 envios por minuto chegaria na metade do tempo.
 *
 * Volta a false quando o serviço reinicia, que é de propósito: é assim que
 * ele descobre sozinho, sem ninguém mexer em configuração, no dia em que o
 * DTO do outro lado passar a aceitar os campos.
 */
let extrasRecusados = false

/** Acima disso a Meta/Telegram já teriam recusado, mas o limite é do endpoint. */
const TAMANHO_MAXIMO = 20 * 1024 * 1024

const TIPOS_ACEITOS = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']

export function obrasConfigurado() {
  return Boolean(OBRAS_API_TOKEN)
}

/**
 * Envia um comprovante.
 *
 * `idMensagem` é o id da mensagem do WhatsApp/Telegram, e vira o
 * Idempotency-Key. Isso não é detalhe: a Meta reentrega webhooks, e sem a
 * chave o mesmo gasto entraria duas vezes no financeiro. O servidor guarda a
 * resposta e, no reenvio da mesma chave, devolve a mesma resposta sem criar
 * outro registro. O id é estável entre reentregas; um id gerado aqui não
 * seria.
 *
 * Nunca lança: quem chama precisa poder responder alguma coisa a quem mandou
 * a foto, mesmo quando o sistema de obras está fora.
 */
export async function enviarComprovante({ arquivo, nomeArquivo, tipo, texto, idMensagem, extras }) {
  if (!OBRAS_API_TOKEN) {
    console.warn('[obras] OBRAS_API_TOKEN não configurado — comprovante NÃO enviado.')
    return { ok: false, motivo: 'nao-configurado' }
  }
  if (!arquivo?.byteLength) return { ok: false, motivo: 'arquivo-vazio' }
  if (arquivo.byteLength > TAMANHO_MAXIMO) {
    return { ok: false, motivo: 'grande-demais', status: 400 }
  }
  if (tipo && !TIPOS_ACEITOS.includes(tipo)) {
    return { ok: false, motivo: `tipo recusado: ${tipo}`, status: 400 }
  }

  const comExtras = MANDAR_CAMPOS_EXTRA && extras && !extrasRecusados

  const r = await postar({ arquivo, nomeArquivo, tipo, texto, idMensagem, extras: comExtras ? extras : null })
  if (r.ok || r.status !== 400 || !comExtras) return r

  /**
   * 400 mandando os campos extras: quase sempre é o endpoint recusando o
   * que ele não conhece.
   *
   * O contrato de hoje aceita só `arquivo` e `texto`. Os campos estruturados
   * vão junto na aposta de que um servidor os ignore em silêncio — e quando
   * ele valida estrito, recusa tudo, e o comprovante se perde por causa de
   * um campo que era só bônus.
   *
   * Então tenta de novo sem eles. Perder o preenchimento automático é ruim;
   * perder o comprovante é pior. E a mesma Idempotency-Key garante que, se o
   * primeiro envio tiver passado por outro motivo, este não duplica.
   */
  console.warn('[obras] 400 com os campos estruturados — tentando sem eles.')
  const semExtras = await postar({ arquivo, nomeArquivo, tipo, texto, idMensagem, extras: null })

  if (semExtras.ok) {
    extrasRecusados = true
    console.warn(
      '[obras] ⚠ O endpoint NÃO aceita valor/data/categoria/obra ainda.\n'
      + '        Os comprovantes seguem chegando, mas com tudo no campo de texto —\n'
      + '        quem aprova vai digitar. Para o formulário abrir preenchido, o DTO\n'
      + '        de /api/comprovantes/receber precisa aceitar esses campos.',
    )
  }
  return semExtras
}

/** Uma tentativa de envio. Duas de rede; erro do servidor não se repete. */
async function postar({ arquivo, nomeArquivo, tipo, texto, idMensagem, extras }) {
  const form = new FormData()
  form.append('arquivo', new Blob([arquivo], { type: tipo || 'application/octet-stream' }), nomeArquivo || 'comprovante')
  if (texto) form.append('texto', texto)

  if (extras) {
    for (const [chave, valor] of Object.entries(extras)) {
      if (valor !== null && valor !== undefined && valor !== '') form.append(chave, String(valor))
    }
  }

  // Duas tentativas, e a segunda só em falha de rede. Repetir com a mesma
  // Idempotency-Key é seguro de propósito — é para isso que ela existe.
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const r = await fetch(`${OBRAS_API_URL}/api/comprovantes/receber`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OBRAS_API_TOKEN}`,
          'Idempotency-Key': String(idMensagem),
        },
        body: form,
        signal: AbortSignal.timeout(30000),   // arquivo grande em 4G leva tempo
      })

      const cru = await r.text()
      let j = {}
      try { j = cru ? JSON.parse(cru) : {} } catch { j = {} }

      if (r.ok) return { ok: true, id: j.id, mensagem: j.mensagem, pendentes: j.pendentes }

      // 401 token revogado · 400 sem arquivo ou tipo recusado · 429 acima de
      // 30 envios por minuto. Nenhum melhora repetindo agora.
      //
      // A resposta CRUA vai para o log, e não só o campo que se espera: num
      // 400 o que interessa é o que o servidor achou errado, e ele nem sempre
      // devolve isso no formato combinado.
      console.error(`[obras] recusou ${r.status}${extras ? ' (com campos extras)' : ''}: ${cru.slice(0, 500)}`)
      return {
        ok: false,
        status: r.status,
        motivo: j.mensagem || j.erro || j.message || cru.slice(0, 200) || `HTTP ${r.status}`,
      }
    } catch (e) {
      console.error(`[obras] tentativa ${tentativa} falhou:`, e.message)
      if (tentativa === 2) return { ok: false, motivo: e.message }
      await new Promise(res => setTimeout(res, 1500))
    }
  }
  return { ok: false, motivo: 'desconhecido' }
}

/**
 * As obras abertas, vindas do sistema.
 *
 * Substitui a lista escrita à mão no .env, que envelhecia calada: obra nova
 * entrava no sistema e o robô seguia sem reconhecê-la, devolvendo "faltou a
 * obra" para um nome que existe.
 *
 * Guardada por um tempo porque o cérebro que interpreta a legenda é síncrono
 * — buscar no sistema a cada foto acrescentaria a latência da rede a todo
 * comprovante. Mesma ideia do catalogo.js com as vagas do RH.
 *
 * Nunca lança. Sem resposta, quem chama usa a reserva do .env.
 */
const VALIDADE_OBRAS_MS = 1000 * 60 * 30
let cacheObras = null   // { lista, buscadoEm }
let cachePagadores = []

/** Quem pode aparecer como "quem pagou". Vem junto com as obras. */
export function pagadoresConhecidos() {
  return [...cachePagadores]
}

export async function obrasDoSistema() {
  if (cacheObras && Date.now() - cacheObras.buscadoEm < VALIDADE_OBRAS_MS) {
    return cacheObras.lista
  }
  if (!OBRAS_API_TOKEN) return null

  try {
    const r = await fetch(`${OBRAS_API_URL}/api/comprovantes/obras`, {
      headers: { Authorization: `Bearer ${OBRAS_API_TOKEN}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) {
      // 404 = servidor ainda sem a rota nova. Não é erro de configuração, é
      // versão antiga do outro lado, e a reserva do .env cobre isso.
      console.warn(`[obras] não consegui listar as obras (${r.status}) — usando a lista do .env.`)
      return null
    }
    const j = await r.json()

    // `detalhes` traz nome e endereço; `obras` traz só os nomes e é o formato
    // antigo. Aceitar os dois deixa o robô funcionar contra um servidor que
    // ainda não subiu a versão nova — e é o caso normal logo depois de um
    // deploy de um lado só.
    const lista = Array.isArray(j.detalhes) && j.detalhes.length
      ? j.detalhes.filter(o => o?.nome)
      : (Array.isArray(j.obras) ? j.obras.filter(Boolean) : [])

    if (!lista.length) return null

    // Quem pode aparecer como "quem pagou". Vem na mesma resposta de
    // propósito: são as duas listas que o robô consulta a cada comprovante,
    // e duas chamadas seriam duas chances de o sistema estar fora.
    cachePagadores = Array.isArray(j.pagadores) ? j.pagadores.filter(Boolean) : []

    cacheObras = { lista, buscadoEm: Date.now() }
    const comEndereco = lista.filter(o => typeof o === 'object' && o.endereco).length
    console.log(`[obras] ${lista.length} obra(s) do sistema${comEndereco ? `, ${comEndereco} com endereço` : ''}`)
    return lista
  } catch (e) {
    console.warn('[obras] falha ao listar as obras:', e.message)
    return null
  }
}

/**
 * Lança o comprovante direto como GASTO DA EQUIPE, já pendente de aprovação.
 *
 * É o caminho que economiza o trabalho de verdade: em vez de o comprovante
 * esperar numa caixa para alguém digitar obra e valor, ele já nasce como
 * lançamento na fila — e só falta abrir "Aprovar gastos" e confirmar.
 *
 * Exige obra e valor. Quem chama só usa este caminho quando tem os dois; sem
 * eles, cai no enviarComprovante(), que põe na caixa.
 *
 * O 422 é resposta esperada, não falha: quer dizer que o sistema não
 * reconheceu a obra, e vem com a lista para o robô PERGUNTAR qual é.
 */
export async function lancarGasto(dados) {
  if (!OBRAS_API_TOKEN) return { ok: false, motivo: 'nao-configurado' }
  if (!dados.arquivo?.byteLength) return { ok: false, motivo: 'arquivo-vazio' }
  if (!dados.obra || dados.valor == null) return { ok: false, motivo: 'faltam-dados' }

  const comDuplicata = !camposDeDuplicataRecusados && Boolean(dados.documento || dados.arquivoHash || dados.enviadoPor)
  const r = await postarLancamento(dados, comDuplicata)
  if (r.ok || r.status !== 400 || !comDuplicata) return r

  /*
    400 mandando `documento`, `arquivoHash` ou `enviadoPor`: servidor de
    versão anterior, com validação estrita, recusando campo que ele ainda
    não conhece.

    Os dois primeiros servem para o sistema reconhecer comprovante repetido;
    o terceiro, para o reembolso ir no nome de quem mandou. Perder isso é
    ruim; perder o lançamento por causa disso é pior — então vai de novo
    sem eles, como sempre foi. A mesma Idempotency-Key garante que não
    entram dois.
  */
  console.warn('[obras] /lancar: 400 com os campos novos (documento/arquivoHash/enviadoPor) — tentando sem eles.')
  const sem = await postarLancamento(dados, false)
  if (sem.ok) {
    camposDeDuplicataRecusados = true
    console.warn('[obras] ⚠ O servidor ainda não aceita documento/arquivoHash/enviadoPor no /lancar. Sigo lançando sem eles.')
  }
  return sem
}

/**
 * O /lancar já recusou `documento` e `arquivoHash`?
 *
 * Mesma ideia de `extrasRecusados`: descobre na primeira tentativa, lembra
 * daí em diante, e esquece no reinício — que é como ele percebe sozinho o dia
 * em que o servidor passar a aceitar.
 */
let camposDeDuplicataRecusados = false

/** Uma tentativa de lançamento. */
async function postarLancamento({ arquivo, nomeArquivo, tipo, obra, valor, descricao, categoria, data, fornecedor, observacao, rateio, pagoPor, idMensagem, confirmadoOutro, empresaPagou, documento, arquivoHash, enviadoPor }, comDuplicata) {
  const form = new FormData()
  form.append('arquivo', new Blob([arquivo], { type: tipo || 'application/octet-stream' }), nomeArquivo || 'comprovante')
  form.append('obra', String(obra))
  form.append('valor', String(valor))
  if (descricao) form.append('descricao', descricao)
  if (categoria) form.append('categoria', categoria)
  if (data) form.append('data', data)
  if (fornecedor) form.append('fornecedor', fornecedor)
  if (observacao) form.append('observacao', observacao)
  // Nomes separados por vírgula: em multipart não há array, e exigir JSON
  // aqui só daria mais chance de erro.
  if (rateio?.length) form.append('rateio', rateio.join(','))
  if (pagoPor) form.append('pagoPor', pagoPor)
  if (confirmadoOutro) form.append('confirmadoOutro', 'true')
  if (empresaPagou) form.append('empresaPagou', 'true')
  // O nº do cupom/NSU que a IA leu e a impressão digital do arquivo: é por
  // eles que o sistema reconhece o MESMO comprovante mandado duas vezes, em
  // vez de desconfiar de todo valor repetido.
  if (comDuplicata && documento) form.append('documento', String(documento).trim().slice(0, 60))
  if (comDuplicata && arquivoHash) form.append('arquivoHash', arquivoHash)
  // O telefone de quem mandou a mensagem (só dígitos, com 55). O sistema
  // procura o usuário que tem esse WhatsApp cadastrado: é no nome dele que o
  // reembolso fica, em vez de ficar no de quem é dono do token do robô.
  if (comDuplicata && enviadoPor) form.append('enviadoPor', enviadoPor)

  try {
    const r = await fetch(`${OBRAS_API_URL}/api/comprovantes/lancar`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OBRAS_API_TOKEN}`,
        'Idempotency-Key': String(idMensagem),
      },
      body: form,
      signal: AbortSignal.timeout(30000),
    })
    const cru = await r.text()
    let j = {}
    try { j = cru ? JSON.parse(cru) : {} } catch { j = {} }

    // `reenvio`: o sistema reconheceu o comprovante como um que já estava
    // lançado e devolveu o existente — nada novo entrou. Não repassar isto
    // fazia quem chama comemorar ("✅ Lançado") e anotar de novo na memória.
    // `enviadoPor`: o NOME de quem o sistema reconheceu pelo telefone, ou
    // null se não reconheceu. `undefined` é servidor que ainda não sabe do
    // campo — e aí não há o que dizer a respeito.
    if (r.ok) return { ok: true, reenvio: j.reenvio === true, id: j.id, ids: j.ids, obra: j.obra, obras: j.obras, rateio: j.rateio, pagoPor: j.pagoPor, enviadoPor: j.enviadoPor, mensagem: j.mensagem }

    if (r.status === 422) {
      // Obra não reconhecida: quem chama pergunta, oferecendo as opções.
      return { ok: false, status: 422, obraNaoAchada: true, obras: j.obras ?? j.message?.obras ?? [] }
    }
    if (r.status === 404) {
      // Servidor sem a rota nova. Quem chama cai para a caixa, que sempre
      // existiu — melhor o caminho antigo que comprovante nenhum.
      return { ok: false, status: 404, semRota: true }
    }
    console.error(`[obras] /lancar recusou ${r.status}: ${cru.slice(0, 300)}`)
    return { ok: false, status: r.status, motivo: j.message || j.mensagem || `HTTP ${r.status}` }
  } catch (e) {
    console.error('[obras] /lancar falhou:', e.message)
    return { ok: false, motivo: e.message }
  }
}

/**
 * Corrige um gasto que ainda está PENDENTE: `campos` é um subconjunto de
 * valor, obra, descricao, categoria e data.
 *
 * Devolve `{ ok, gasto }` com o gasto como ficou, ou `{ ok: false, status }`:
 * 409 = já foi aprovado ou rejeitado (ou é rateio e pediu-se trocar a obra);
 * 422 = não reconheceu a obra, e vem a lista em `obras`; 404 = o token não
 * pode ver esse gasto, ou o servidor ainda não tem a rota. Nunca lança.
 */
export async function corrigirLancado(id, campos) {
  return mexerNoLancado('PATCH', id, campos)
}

/** Cancela um gasto PENDENTE (fica como rejeitado, com rastro). Mesmas respostas de `corrigirLancado`. */
export async function cancelarLancado(id) {
  return mexerNoLancado('DELETE', id, null)
}

async function mexerNoLancado(metodo, id, campos) {
  if (!OBRAS_API_TOKEN) return { ok: false, motivo: 'nao-configurado' }
  if (!id) return { ok: false, status: 404, motivo: 'sem-id' }
  try {
    const r = await fetch(`${OBRAS_API_URL}/api/comprovantes/lancados/${encodeURIComponent(String(id))}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${OBRAS_API_TOKEN}`,
        ...(campos ? { 'Content-Type': 'application/json' } : {}),
      },
      body: campos ? JSON.stringify(campos) : undefined,
      signal: AbortSignal.timeout(15000),
    })
    const cru = await r.text()
    let j = {}
    try { j = cru ? JSON.parse(cru) : {} } catch { j = {} }

    if (r.ok) return { ok: true, gasto: j.gasto ?? j }
    if (r.status !== 409 && r.status !== 422 && r.status !== 404) {
      console.error(`[obras] ${metodo} /lancados recusou ${r.status}: ${cru.slice(0, 300)}`)
    }
    return {
      ok: false,
      status: r.status,
      motivo: j.mensagem || (typeof j.message === 'string' ? j.message : null) || `HTTP ${r.status}`,
      obras: j.obras ?? j.message?.obras ?? null,
    }
  } catch (e) {
    console.error(`[obras] ${metodo} /lancados falhou:`, e.message)
    return { ok: false, motivo: e.message }
  }
}

/**
 * O que já está lançado no sistema, de uma data para cá.
 *
 * É o que deixa o robô desconfiar de repetido olhando o SISTEMA, e não só a
 * própria memória: o gasto que o dono lançou à mão, a conta cadastrada pelo
 * escritório, o que entrou enquanto o robô estava fora do ar. Sem isto ele
 * só reconhece o que passou por ele.
 *
 * Devolve a lista, ou null quando não dá para saber — sem token, rede fora,
 * ou servidor de versão anterior (404: a rota ainda não existe). Null quer
 * dizer "compare só com a memória", que é o que sempre se fez. Nunca lança.
 *
 * Guardada por pouco tempo. Curto de propósito: a lista muda a cada
 * lançamento, e o que o próprio robô acabou de mandar já está na memória
 * dele. O 404 é lembrado por mais tempo — versão antiga não muda de um
 * minuto para o outro, e perguntar a cada comprovante seria só ruído no log.
 */
const VALIDADE_LANCADOS_MS = 1000 * 60 * 2
const VALIDADE_SEM_ROTA_MS = 1000 * 60 * 30
let cacheLancados = null   // { desde, lista, buscadoEm, validade }

export async function lancadosDoSistema(desde) {
  try {
    if (!OBRAS_API_TOKEN || !/^\d{4}-\d{2}-\d{2}$/.test(String(desde ?? ''))) return null

    if (cacheLancados && cacheLancados.desde === desde
      && Date.now() - cacheLancados.buscadoEm < cacheLancados.validade) {
      return cacheLancados.lista
    }

    const guardar = (lista, validade = VALIDADE_LANCADOS_MS) => {
      cacheLancados = { desde, lista, buscadoEm: Date.now(), validade }
      return lista
    }

    const r = await fetch(`${OBRAS_API_URL}/api/comprovantes/lancados?desde=${desde}`, {
      headers: { Authorization: `Bearer ${OBRAS_API_TOKEN}` },
      signal: AbortSignal.timeout(8000),
    })
    if (r.status === 404) return guardar(null, VALIDADE_SEM_ROTA_MS)
    if (!r.ok) {
      console.warn(`[obras] não consegui consultar os lançados (${r.status}) — comparo só com a minha memória.`)
      return guardar(null)
    }

    const j = await r.json()
    if (!Array.isArray(j?.lancados)) return guardar(null)
    const lista = j.lancados.filter(l => l && typeof l === 'object')

    /*
      O sistema devolve no máximo 2.000 itens, do mais recente para o mais
      antigo, e avisa quando cortou. Cortada, a lista NÃO é o período
      inteiro: faltam justamente os mais antigos — e não há como pedi-los,
      porque a consulta só aceita "de quando para cá" (um `desde` mais
      recente devolve os mesmos itens, não os que faltaram).

      Então a lista vai MARCADA, com a data a partir da qual está completa.
      Quem compara decide o que fazer: no dia a dia ela continua servindo (o
      que interessa ali é recente); no atraso, que compara meses, a leitura
      para em vez de tratar "não veio" como "não existe".
    */
    if (j.truncado === true) {
      lista.truncado = true
      lista.cobreDesde = completaDesde(lista)
      console.warn(`[obras] ⚠ a lista de lançados veio CORTADA em ${lista.length} itens — só está completa de ${lista.cobreDesde ?? '?'} para cá. O que for mais antigo não entra na comparação de repetido.`)
    }
    return guardar(lista)
  } catch (e) {
    console.warn('[obras] falha ao consultar os lançados:', e.message)
    return null
  }
}

/**
 * A partir de que dia uma lista cortada está completa.
 *
 * Gastos e contas são cortados cada um por conta própria, do mais recente
 * para o mais antigo. Não se sabe qual dos dois estourou — então vale o mais
 * prudente: o dia SEGUINTE ao mais antigo que veio, na origem que alcança
 * menos longe. Daí para cá, nada faltou.
 */
function completaDesde(lista) {
  const maisAntigoPorOrigem = new Map()
  for (const l of lista) {
    const dia = String(l.data ?? '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) continue
    const origem = l.origem ?? '?'
    if (!maisAntigoPorOrigem.has(origem) || dia < maisAntigoPorOrigem.get(origem)) maisAntigoPorOrigem.set(origem, dia)
  }
  if (!maisAntigoPorOrigem.size) return null
  const limite = [...maisAntigoPorOrigem.values()].sort().at(-1)
  return new Date(Date.parse(`${limite}T12:00:00Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** Só para teste: esquece as obras guardadas (e os lançados consultados). */
export function _limparCacheObras() {
  cacheObras = null
  cachePagadores = []
  cacheLancados = null
}

/** Só para teste: esquece o que foi descoberto sobre os campos extras. */
export function _esquecerDescoberta() {
  extrasRecusados = false
  camposDeDuplicataRecusados = false
}
