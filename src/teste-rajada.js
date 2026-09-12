/**
 * Esperar a pessoa terminar de escrever.
 *
 * Caso real, 12/09/2026: "3584387250", "Manu", "Minha filha" em dez segundos,
 * e o robô respondeu as três com a mesma frase de encerramento.
 */
import { criarAgrupador } from './rajada.js'

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}
const espera = (ms) => new Promise(r => setTimeout(r, ms))

/*
  Segura o processo no ar durante o teste.

  Os temporizadores da rajada sao `unref`: em producao isso e o certo — uma
  espera pendente nao pode impedir o robo de encerrar. Mas aqui nao ha um
  soquete aberto segurando o laco de eventos, e o Node sairia antes de a
  espera vencer.
*/
const manterVivo = setInterval(() => {}, 1000)

// Tempos curtos: o que se testa é a regra, não a paciência.
const agrupar = criarAgrupador({ espera: 40, maximo: 200 })

// ── Uma mensagem só: responde ela mesma ────────────────────────────────
{
  const r = await agrupar('joao', 'bom dia')
  ok('mensagem sozinha é atendida', r === 'bom dia')
}

// ── A rajada vira uma resposta só ──────────────────────────────────────
{
  const p1 = agrupar('maria', '3584387250')
  await espera(10)
  const p2 = agrupar('maria', 'Manu')
  await espera(10)
  const p3 = agrupar('maria', 'Minha filha')

  const [r1, r2, r3] = await Promise.all([p1, p2, p3])
  ok('as duas primeiras não são atendidas sozinhas', r1 === null && r2 === null)
  ok('a última responde por todas', r3 === '3584387250\nManu\nMinha filha')
}

// ── Nada se perde ──────────────────────────────────────────────────────
{
  const p1 = agrupar('ana', 'sou pedreiro')
  await espera(10)
  const p2 = agrupar('ana', 'moro em bastos')
  const [, r2] = await Promise.all([p1, p2])
  ok('o texto inteiro chega junto', r2.includes('sou pedreiro') && r2.includes('moro em bastos'))
}

// ── Quem escreve sem parar recebe resposta assim mesmo ─────────────────
//
// Sem teto, quem digita de dez em dez segundos nunca seria atendido.
{
  const inicio = Date.now()
  const todas = []
  for (let i = 0; i < 12; i++) {
    todas.push(agrupar('teimoso', `msg ${i}`))
    await espera(25)   // sempre antes da espera de 40ms
  }
  const resultados = await Promise.all(todas)
  const atendidas = resultados.filter(r => r !== null)
  ok('o teto força uma resposta', atendidas.length >= 1)
  ok('e ela sai dentro do teto', Date.now() - inicio < 600)
  ok('com o que já tinha chegado', atendidas[0].includes('msg 0'))
}

// ── Conversas diferentes não se misturam ───────────────────────────────
{
  const pA = agrupar('pedro', 'sou carpinteiro')
  const pB = agrupar('lucas', 'sou servente')
  const [rA, rB] = await Promise.all([pA, pB])
  ok('cada conversa tem a sua rajada', rA === 'sou carpinteiro' && rB === 'sou servente')
}

// ── Depois que fecha, a próxima mensagem começa outra ──────────────────
{
  const r1 = await agrupar('carlos', 'oi')
  const r2 = await agrupar('carlos', 'tem vaga?')
  ok('nova rajada depois da anterior fechar', r1 === 'oi' && r2 === 'tem vaga?')
}

clearInterval(manterVivo)
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
