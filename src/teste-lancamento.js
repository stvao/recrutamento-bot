/**
 * A linha escrita junto do comprovante.
 *
 * O teste que mais importa é o do valor: "2500,00" tem vírgula, e a linha é
 * separada por vírgula. Uma divisão ingênua parte o valor no meio e lança
 * 2.500 como "2" — erro que ninguém percebe até fechar o mês.
 */
import { interpretar, acharValor, acharTipo, combinar } from './lancamento.js'

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

// ── O valor, que é o campo que não pode errar ─────────────────────────────
const casos = [
  ['2500,00', 2500],
  ['R$ 2.500,00', 2500],
  ['2.500,00', 2500],
  ['1.240,50', 1240.5],
  ['180', 180],
  ['250,9', 250.9],
  ['r$300', 300],
  ['12.345,67', 12345.67],
]
for (const [texto, esperado] of casos) {
  ok(`"${texto}" vira ${esperado}`, acharValor(texto).valor === esperado)
}
ok('sem número nenhum não inventa valor', acharValor('material da obra').valor === null)
ok('texto vazio não quebra', acharValor('').valor === null)
ok('zero não vira valor', acharValor('0').valor === null)

// Quantidade no meio não é confundida com o valor: pega-se o ÚLTIMO número.
ok('quantidade no meio não vira valor', acharValor('20 sacos de cimento, 1.240,50').valor === 1240.5)

// ── O tipo, com a tolerância a erro de escrita ────────────────────────────
ok('"material" → MATERIAL', acharTipo('material') === 'MATERIAL')
ok('"materal" (errado) → MATERIAL', acharTipo('materal') === 'MATERIAL')
ok('"combustivel" → COMBUSTIVEL', acharTipo('combustivel') === 'COMBUSTIVEL')
ok('"gasolina" → COMBUSTIVEL', acharTipo('gasolina') === 'COMBUSTIVEL')
ok('"mao de obra" → MAO_DE_OBRA', acharTipo('mao de obra') === 'MAO_DE_OBRA')
ok('"diaria" → MAO_DE_OBRA', acharTipo('diaria') === 'MAO_DE_OBRA')
ok('"marmita" → ALIMENTACAO', acharTipo('marmita') === 'ALIMENTACAO')
ok('palavra sem relação não vira tipo', acharTipo('xyzabc') === null)

// ── A linha inteira, como ela é escrita de verdade ────────────────────────
const l1 = interpretar('bastos tsuya, tijolos e areia, material, 2500,00')
ok('obra sai certa', l1.obra === 'bastos tsuya')
ok('descrição sai certa', l1.descricao === 'tijolos e areia')
ok('tipo sai certo', l1.tipo === 'MATERIAL')
ok('valor sai certo', l1.valor === 2500)

// "mao de obra" tem três palavras e mesmo assim é o campo do tipo, não
// descrição — porque é EXATAMENTE o nome de uma categoria.
const l2 = interpretar('praia grande, diaria do pedreiro, mao de obra, 250,00')
ok('tipo de três palavras é reconhecido', l2.tipo === 'MAO_DE_OBRA')
ok('e não é engolido pela descrição', l2.descricao === 'diaria do pedreiro')

// Sem o campo de tipo, adivinha pela descrição — é palpite, e só entra
// depois de o campo próprio ter falhado.
const l3 = interpretar('caraguatatuba, 20 sacos de cimento, 1.240,50')
ok('adivinha o tipo pela descrição', l3.tipo === 'MATERIAL')
ok('quantidade não vira o valor', l3.valor === 1240.5)
ok('a obra continua sendo a primeira', l3.obra === 'caraguatatuba')

// Linha curta, sem descrição
const l4 = interpretar('bastos tsuya, combustivel, 300')
ok('linha curta: obra', l4.obra === 'bastos tsuya')
ok('linha curta: tipo', l4.tipo === 'COMBUSTIVEL')
ok('linha curta: valor', l4.valor === 300)

// Separado por travessão em vez de vírgula
const l5 = interpretar('peruibe - marmita da equipe - alimentacao - 180')
ok('aceita travessão como separador', l5.obra === 'peruibe' && l5.valor === 180 && l5.tipo === 'ALIMENTACAO')

// Nada reconhecível não recusa o comprovante: vira obra e segue.
const l6 = interpretar('mandei o pix pro joao')
ok('linha solta não quebra', l6.valor === null && l6.tipo === null)
ok('linha vazia não quebra', interpretar('').obra === null)
ok('nulo não quebra', interpretar(null).obra === null)

// ── O que a pessoa escreveu ganha da IA. Sempre. ──────────────────────────
// É a regra que evita o pior erro possível: lançar 1.500 porque o modelo leu
// errado, num campo em que a pessoa tinha escrito 1.800.
const escrito = { obra: 'bastos tsuya', descricao: 'tijolos', tipo: 'MATERIAL', valor: 1800 }
const lido = { valor: 1500, categoria: 'OUTROS', estabelecimento: 'Loja X', data: '2026-08-20', confianca: 'alta' }

const c = combinar(escrito, lido)
ok('valor DIGITADO ganha do valor lido', c.valor === 1800)
ok('tipo digitado ganha do lido', c.tipo === 'MATERIAL')
ok('descrição digitada ganha', c.descricao === 'tijolos')
ok('marca que o valor foi digitado', c.valorDigitado === true)
ok('confiança vira "digitado"', c.confianca === 'digitado')
ok('a data do comprovante vai junto para conferência', c.dataComprovante === '2026-08-20')

// Sem o que foi escrito, a IA preenche — que é o papel dela.
const so = combinar(interpretar(''), lido)
ok('sem linha escrita, o valor lido vale', so.valor === 1500)
ok('sem linha escrita, marca que NÃO foi digitado', so.valorDigitado === false)
ok('sem linha escrita, o estabelecimento vira descrição', so.descricao === 'Loja X')

// Escreveu a obra mas esqueceu o valor: a IA completa só o buraco.
const meio = combinar(interpretar('bastos tsuya, tijolos e areia'), lido)
ok('completa só o que faltou', meio.obra === 'bastos tsuya' && meio.valor === 1500)
ok('e avisa que esse valor não foi digitado', meio.valorDigitado === false)

// Sem IA nenhuma (leitura falhou), o que foi escrito basta.
const semIA = combinar(escrito, null)
ok('funciona sem a IA', semIA.valor === 1800 && semIA.obra === 'bastos tsuya')

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
