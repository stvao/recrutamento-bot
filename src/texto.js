/**
 * Comparação de texto tolerante a erro de escrita.
 *
 * O robô só reconhecia a palavra exata. Quem digita no celular, na obra, com
 * a mão suja, escreve "pedrero", "eletrecista", "peruibi", "carpinteo" — e
 * ouvia "não entendi", que é a forma mais rápida de fazer alguém desistir.
 *
 * Não é IA: é distância de edição sobre um vocabulário FECHADO de sete vagas
 * e sete cidades. Para escolher entre poucas opções conhecidas, isso acerta
 * mais que um modelo de linguagem, responde na hora e não custa nada por
 * mensagem.
 */

/** Minúsculas, sem acento, sem pontuação. */
export function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // tira acentos
    .replace(/[^a-z0-9\s]/g, ' ')      // pontuação vira espaço
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Distância de Levenshtein: quantas letras é preciso trocar, inserir ou
 * apagar para transformar uma palavra na outra.
 *
 * Duas linhas de matriz em vez da matriz inteira — as palavras aqui são
 * curtas, mas não há razão para alocar o que não se usa.
 */
export function distancia(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  let anterior = Array.from({ length: b.length + 1 }, (_, i) => i)
  let atual = new Array(b.length + 1)

  for (let i = 1; i <= a.length; i++) {
    atual[0] = i
    for (let j = 1; j <= b.length; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1
      atual[j] = Math.min(
        atual[j - 1] + 1,        // inserção
        anterior[j] + 1,         // remoção
        anterior[j - 1] + custo, // substituição
      )
    }
    ;[anterior, atual] = [atual, anterior]
  }
  return anterior[b.length]
}

/**
 * Quantos erros tolerar numa palavra deste tamanho.
 *
 * Proporcional ao comprimento: em "sim" um erro já vira outra palavra, mas
 * em "carpinteiro" dois erros ainda são claramente "carpinteiro". Palavra de
 * até 3 letras não tolera nada — senão "sim" viraria "nao".
 *
 * A faixa de 6 letras só tolera UM erro, e a razão é concreta: "santos" e
 * "bastos" são duas trocas de distância. Santos fica ao lado de Peruíbe;
 * Bastos, a 600 km no interior. Quem escrevesse a própria cidade certa era
 * mandado para a obra errada.
 */
function tolerancia(tamanho) {
  if (tamanho <= 3) return 0
  if (tamanho <= 6) return 1
  if (tamanho <= 9) return 2
  return 3
}

/**
 * Palavras que são elas mesmas, não erro de digitação.
 *
 * "valeu" fica a uma letra de "vale" — quem agradece no fim da conversa
 * receberia uma explicação sobre vale-transporte. "vaga", "nada" e "mais"
 * têm o mesmo problema com outras palavras-chave.
 *
 * Estas só casam por escrito exato: se a pessoa digitou uma palavra que
 * existe, ela quis dizer aquela palavra.
 */
const PALAVRAS_PROPRIAS = new Set([
  'valeu', 'vaga', 'vagas', 'nada', 'mais', 'meu', 'seu', 'sou', 'nome',
  'dia', 'boa', 'bom', 'sem', 'com', 'para', 'pela', 'esse', 'essa',
])

/** A palavra digitada é, provavelmente, o alvo? */
export function pareceCom(palavra, alvo) {
  if (!palavra || !alvo) return false
  if (palavra === alvo) return true
  if (PALAVRAS_PROPRIAS.has(palavra)) return false
  // Prefixo conta: quem escreve "carpint" quer dizer "carpinteiro".
  if (alvo.length >= 5 && palavra.length >= 4 && alvo.startsWith(palavra)) return true
  return distancia(palavra, alvo) <= tolerancia(Math.max(palavra.length, alvo.length))
}

/**
 * Procura o melhor candidato dentro da frase inteira.
 *
 * Testa cada palavra da mensagem — e também pares de palavras seguidas,
 * porque "praia grande" e "engenharia civil" só fazem sentido juntos.
 *
 * `opcoes` é uma lista de { valor, termos[] }. Devolve o `valor` de menor
 * distância, ou null quando nada chega perto o bastante.
 */
export function melhorMatch(mensagem, opcoes) {
  const palavras = norm(mensagem).split(' ').filter(Boolean)
  if (!palavras.length) return null

  // Palavras isoladas e pares seguidos.
  const pedacos = [...palavras]
  for (let i = 0; i < palavras.length - 1; i++) {
    pedacos.push(`${palavras[i]} ${palavras[i + 1]}`)
  }

  let melhor = null
  let menorDistancia = Infinity

  for (const opcao of opcoes) {
    for (const termoBruto of opcao.termos) {
      const termo = norm(termoBruto)
      for (const pedaco of pedacos) {
        if (!pareceCom(pedaco, termo)) continue
        const d = distancia(pedaco, termo)
        // Empate: fica com o primeiro, que é a ordem de prioridade da lista.
        if (d < menorDistancia) {
          menorDistancia = d
          melhor = opcao.valor
        }
      }
    }
  }
  return melhor
}

/**
 * Alguma dessas palavras aparece na mensagem, mesmo escrita errada?
 *
 * Usado no FAQ, onde basta detectar o assunto: "salario", "salrio" e
 * "salário" levam à mesma resposta.
 */
export function contemAlgum(mensagem, termos) {
  const palavras = norm(mensagem).split(' ').filter(Boolean)
  const pedacos = [...palavras]
  for (let i = 0; i < palavras.length - 1; i++) {
    pedacos.push(`${palavras[i]} ${palavras[i + 1]}`)
  }
  return termos.some(t => {
    const termo = norm(t)
    // Termo com espaço só casa contra pedaço composto; sem espaço, palavra.
    return pedacos.some(p => pareceCom(p, termo))
  })
}
