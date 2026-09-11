/**
 * Quais mensagens o robô atende — incluindo as que chegaram com ele fora.
 *
 * O WhatsApp entrega as mensagens com um de dois rótulos:
 *
 *   'notify'  chegando agora
 *   'append'  todo o resto: o que chegou ENQUANTO o robô estava desconectado
 *             (reinício, deploy, queda de conexão), o eco do que ele mesmo
 *             enviou, e avisos técnicos sem conteúdo ("fulano entrou").
 *
 * O robô descartava o 'append' inteiro, achando que era histórico sendo
 * sincronizado. Não é: o histórico vem por outro evento
 * (messaging-history.set). O efeito era silencioso e caro — o comprovante
 * mandado no grupo durante um reinício sumia, sem resposta e sem lançamento.
 * E o robô é reiniciado a cada deploy.
 *
 * Agora o 'append' entra, com três cuidados:
 *   - só mensagem com conteúdo de verdade: aviso técnico não é mensagem;
 *   - só se for recente — até 24 horas, que cobre uma queda, e não uma
 *     conversa de semanas atrás;
 *   - nunca a mesma mensagem duas vezes.
 */

/** Até quanto tempo depois uma mensagem que chegou com o robô fora é atendida. */
export const JANELA_FORA_DO_AR_MS = Number(process.env.JANELA_FORA_DO_AR_H || 24) * 60 * 60 * 1000

const MAX_VISTAS = 5000

/**
 * Cria o filtro. Um por conexão: guarda os ids já vistos, para a mesma
 * mensagem não ser atendida duas vezes — uma entregue como 'append' e de novo
 * como 'notify' numa nova tentativa, por exemplo.
 */
export function criarFiltro() {
  const vistas = new Set()

  function primeiraVez(id) {
    if (!id) return true
    if (vistas.has(id)) return false
    vistas.add(id)
    if (vistas.size > MAX_VISTAS) vistas.delete(vistas.values().next().value)
    return true
  }

  /**
   * Esta mensagem deve seguir adiante?
   *
   * Devolve { atender, foraDoAr }. `foraDoAr` diz que ela chegou com o robô
   * desconectado — vale registrar, porque é a prova de que o conserto serve.
   */
  return function deveAtender(msg, type, agora = Date.now()) {
    if (type !== 'notify' && type !== 'append') return { atender: false, foraDoAr: false }

    if (type === 'append') {
      // Aviso técnico: sem conteúdo, ou marcado como "stub" (entrou, saiu,
      // mudou o nome do grupo). Não é algo que alguém disse.
      if (!msg?.message || msg.messageStubType) return { atender: false, foraDoAr: false }
      const quando = Number(msg.messageTimestamp ?? 0) * 1000
      if (!quando || agora - quando > JANELA_FORA_DO_AR_MS) return { atender: false, foraDoAr: false }
    }

    if (!primeiraVez(msg?.key?.id)) return { atender: false, foraDoAr: false }
    return { atender: true, foraDoAr: type === 'append' }
  }
}
