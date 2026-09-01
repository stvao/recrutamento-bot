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
 * O token é restrito a criar comprovante: não lê nada, não lança conta, não
 * aprova. Gera-se em "Enviar pelo iPhone" (/m/atalho), aparece uma vez só, e
 * é revogável na mesma tela.
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

/** Só para teste: esquece o que foi descoberto sobre os campos extras. */
export function _esquecerDescoberta() {
  extrasRecusados = false
}
