/**
 * A linha escrita junto do comprovante.
 *
 * O teste que mais importa é o do valor: "2500,00" tem vírgula, e a linha é
 * separada por vírgula. Uma divisão ingênua parte o valor no meio e lança
 * 2.500 como "2" — erro que ninguém percebe até fechar o mês.
 */
import { interpretar, acharValor, acharTipo, acharNaFrase, apelidosDe, acharObra, acharPagador, combinar } from './lancamento.js'

/** As obras de verdade, como estão no .env de produção. */
const OBRAS = ['Bastos Tsuya', 'Bastos haia', 'Peruibe', 'Caraguatatuba', 'Praia Grande', 'Buritama', 'Pereiras', 'Itapevi']

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

// ── Legendas REAIS, escritas sem vírgula ──────────────────────────────────
// Estas duas vieram do primeiro uso de verdade. O nome da obra está no
// COMEÇO de uma e no FIM da outra — não há como separar isso de texto
// corrido sem saber quais obras existem, e é por isso que a lista entra.
{
  const a = interpretar('Bastos Tsuya bomba para concreto locação 1.400,00', OBRAS)
  ok('real 1: acha a obra no começo', a.obra === 'Bastos Tsuya')
  ok('real 1: "locação" é o tipo', a.tipo === 'LOCACAO')
  ok('real 1: a descrição sobrevive inteira', a.descricao === 'bomba para concreto')
  ok('real 1: o valor sai certo', a.valor === 1400)

  const b = interpretar('bombeamento de concreto bastos tsuya', OBRAS)
  ok('real 2: acha a obra no FIM', b.obra === 'Bastos Tsuya')
  ok('real 2: deduz LOCACAO de "bombeamento"', b.tipo === 'LOCACAO')
  ok('real 2: a descrição sobrevive inteira', b.descricao === 'bombeamento de concreto')
  ok('real 2: sem valor na legenda, fica nulo p/ a IA preencher', b.valor === null)
}

// A obra mais longa ganha da mais curta: "Bastos Tsuya" e "Bastos" são obras
// diferentes, e casar a errada manda o custo para o lugar errado.
{
  const r = interpretar('Bastos Tsuya cimento 100', OBRAS)
  ok('a obra mais específica ganha', r.obra === 'Bastos Tsuya')
  const r2 = interpretar('Bastos haia cimento 100', OBRAS)
  ok('e a outra "Bastos" é reconhecida', r2.obra === 'Bastos haia')
}

ok('obra em maiúscula é reconhecida', interpretar('PRAIA GRANDE marmita 90', OBRAS).obra === 'Praia Grande')

// ── Erro de escrita no nome da obra ───────────────────────────────────────
// Quem digita está na obra, no celular, com pressa. Exigir o nome exato
// devolveria "faltou a obra" o tempo todo.
const comErro = [
  ['bastos haya cimento 200', 'Bastos haia'],
  ['bastos aia cimento 200', 'Bastos haia'],
  ['bastos tsuia cimento 200', 'Bastos Tsuya'],
  ['caraguatatuva areia 100', 'Caraguatatuba'],
  ['praia grand marmita 50', 'Praia Grande'],
  ['buritma cimento 80', 'Buritama'],
]
for (const [linha, esperada] of comErro) {
  ok(`"${linha}" → ${esperada}`, interpretar(linha, OBRAS).obra === esperada)
}

// O caso que mais importa: duas obras parecidas NÃO podem se confundir.
// Mandar o custo para a obra errada é o pior erro que este arquivo comete,
// porque ninguém percebe.
ok('"bastos haia" NÃO vira Bastos Tsuya', interpretar('bastos haia cimento 10', OBRAS).obra === 'Bastos haia')
ok('"bastos tsuya" NÃO vira Bastos haia', interpretar('bastos tsuya cimento 10', OBRAS).obra === 'Bastos Tsuya')

// Fora de ordem: a obra pode estar em qualquer lugar da frase.
ok('obra no fim', interpretar('cimento 200 buritama', OBRAS).obra === 'Buritama')
ok('obra no meio', interpretar('nota de peruibe do mes', OBRAS).obra === 'Peruibe')

// Faltando itens: cada campo é opcional, e o que falta fica nulo em vez de
// derrubar o resto.
{
  const soObra = interpretar('buritama', OBRAS)
  ok('só a obra: reconhece', soObra.obra === 'Buritama')
  ok('só a obra: valor fica nulo p/ a IA', soObra.valor === null)

  const semObra = interpretar('cimento 200', OBRAS)
  ok('sem obra: não inventa', semObra.obra === null)
  ok('sem obra: mas pega o resto', semObra.valor === 200 && semObra.tipo === 'MATERIAL')
}

// Nome curto demais não perdoa erro: com 4 letras ou menos, uma troca já é
// outra palavra, e o risco de casar errado supera a conveniência.
ok('palavra curta não casa por semelhança', interpretar('itapevo cimento 10', ['Ita']).obra === null)

// ── Classificador sai da frase; pista fica ────────────────────────────────
// Tratar os dois iguais arrancava "tijolos" da descrição como se fosse a
// classificação, e sobrava "e areia".
{
  const r = interpretar('bastos tsuya, tijolos e areia, material, 2500,00', OBRAS)
  ok('classificador "material" sai da descrição', r.descricao === 'tijolos e areia')
  ok('e vira o tipo', r.tipo === 'MATERIAL')

  const r2 = interpretar('caraguatatuba 20 sacos de cimento 1.240,50', OBRAS)
  ok('pista "cimento" FICA na descrição', r2.descricao === '20 sacos de cimento')
  ok('e ainda assim define o tipo', r2.tipo === 'MATERIAL')
}

// ── Locação é um tipo próprio ─────────────────────────────────────────────
ok('"locacao" é classificador', acharTipo('locacao') === 'LOCACAO')
ok('"aluguel" também', acharTipo('aluguel') === 'LOCACAO')
ok('"betoneira" leva a LOCACAO', acharTipo('betoneira') === 'LOCACAO')
ok('"andaime" leva a LOCACAO', acharTipo('andaime') === 'LOCACAO')

// ── A busca por janela de palavras ────────────────────────────────────────
{
  const r = acharNaFrase('nota fiscal praia grande urgente', ['Praia Grande', 'Bastos'])
  ok('acha o nome no meio da frase', r.achado === 'Praia Grande')
  ok('e devolve o resto sem ele', r.resto === 'nota fiscal urgente')

  ok('não inventa quando não tem', acharNaFrase('nota fiscal', ['Bastos']).achado === null)
  ok('lista vazia não quebra', acharNaFrase('qualquer coisa', []).achado === null)
  ok('texto vazio não quebra', acharNaFrase('', ['Bastos']).achado === null)
}

// Sem a lista de obras, texto corrido NÃO chuta um nome de obra: melhor
// admitir que não sabe do que mandar o custo para a obra errada.
{
  const semLista = interpretar('bombeamento de concreto bastos tsuya', [])
  ok('sem a lista, não inventa obra em texto corrido', semLista.obra === null)
  ok('mas guarda tudo na descrição', semLista.descricao?.includes('bastos tsuya'))
}

// ── Apelido: o nome que a pessoa REALMENTE escreve ────────────────────────
// Os nomes cadastrados são o nome oficial da escola. Ninguém escreve isso no
// WhatsApp — e comparar o nome inteiro por semelhança nunca casaria, porque a
// diferença é grande demais.
const REAIS = [
  'EE DR FRANCISCO PEREIRA DA ROCHA',
  'EE OSWALDO LUIZ SANCHES TOSCHI',
  'EE PROFA TSUYA OHNO KIMURA',
  'EE VER EGILDO PASCHOALUCCI',
  'EE/ETEC AGUIA DE HAIA',
  'Escola Ambiental - Itapevi',
]

{
  const ap = apelidosDe(REAIS)
  ok('"tsuya" vira apelido', ap.get('tsuya') === 'EE PROFA TSUYA OHNO KIMURA')
  ok('"haia" vira apelido', ap.get('haia') === 'EE/ETEC AGUIA DE HAIA')
  ok('"itapevi" vira apelido', ap.get('itapevi') === 'Escola Ambiental - Itapevi')

  // "EE" está em cinco das seis: casaria com todas e apontaria para a errada.
  ok('"ee" NÃO vira apelido', !ap.has('ee'))
  ok('"escola" NÃO vira apelido', !ap.has('escola'))
  ok('"profa" NÃO vira apelido', !ap.has('profa'))
  ok('"de" NÃO vira apelido', !ap.has('de'))
}

// As legendas que ele escreve de verdade, contra os nomes de verdade.
const reais = [
  ['bastos haia bomba para concreto locação 1.400,00', 'EE/ETEC AGUIA DE HAIA'],
  ['bombeamento de concreto bastos tsuya', 'EE PROFA TSUYA OHNO KIMURA'],
  ['tsuya cimento 200', 'EE PROFA TSUYA OHNO KIMURA'],
  ['haia marmita 90', 'EE/ETEC AGUIA DE HAIA'],
  ['itapevi andaime 300', 'Escola Ambiental - Itapevi'],
  ['toschi tijolos 500', 'EE OSWALDO LUIZ SANCHES TOSCHI'],
  ['kimura areia 100', 'EE PROFA TSUYA OHNO KIMURA'],
]
for (const [linha, esperada] of reais) {
  ok(`"${linha}" → ${esperada}`, interpretar(linha, REAIS).obra === esperada)
}

// Erro de escrita no apelido vale — mas só em apelido LONGO o bastante.
ok('"tsuia" acha a obra', interpretar('tsuia cimento 10', REAIS).obra === 'EE PROFA TSUYA OHNO KIMURA')
ok('"kimurra" acha a obra', interpretar('kimurra cimento 10', REAIS).obra === 'EE PROFA TSUYA OHNO KIMURA')

// "haia" tem 4 letras, e apelido curto exige acerto exato. Numa palavra
// dessas, uma letra trocada vira outra palavra válida — e casar errado
// mandaria o custo para a obra errada, calado. Perguntar custa uma mensagem;
// o erro custa o fechamento do mês.
ok('apelido curto errado NÃO vira palpite', interpretar('haya cimento 10', REAIS).obra === null)

// "bastos" é o nome da cidade, e não está em nome de obra nenhum: sozinho
// não pode virar palpite, senão o custo iria para uma obra ao acaso.
ok('"bastos" sozinho NÃO escolhe obra', interpretar('bastos cimento 100', REAIS).obra === null)

// O nome completo, quando escrito, continua ganhando.
ok('nome completo ainda casa', interpretar('EE PROFA TSUYA OHNO KIMURA cimento 50', REAIS).obra === 'EE PROFA TSUYA OHNO KIMURA')

// E o resto da linha sobrevive ao apelido.
{
  const r = interpretar('haia bomba para concreto locação 1400', REAIS)
  ok('apelido não come a descrição', r.descricao === 'bomba para concreto')
  ok('apelido não come o tipo', r.tipo === 'LOCACAO')
  ok('apelido não come o valor', r.valor === 1400)
}

// Sem obras conhecidas, não inventa apelido nenhum.
ok('lista vazia não quebra', acharObra('qualquer coisa', []).achado === null)

// ── Quem bancou ────────────────────────────────
//
// O nome do pagador é um nome próprio solto no meio da frase. Se não sair da
// linha antes de tudo, ele vira descrição ou, pior, é confundido com o nome de
// uma obra — e aí o custo vai para a escola errada.

const SOCIOS = ['Estevao Bandeira', 'Joao Carlos Silva', 'Ana Paula Souza', 'Joao Pedro Lima']

{
  const r = interpretar('haia cimento 250 pago por joao carlos', REAIS, SOCIOS)
  ok('nome completo casa', r.pagoPor === 'Joao Carlos Silva')
  ok('pagador sai da descricao', r.descricao === 'cimento')
  ok('obra sobrevive ao pagador', r.obra === 'EE/ETEC AGUIA DE HAIA')
  ok('valor sobrevive ao pagador', r.valor === 250)
}

{
  const r = interpretar('haia, tijolos e areia, material, 2500,00, pago pelo Estevao', REAIS, SOCIOS)
  ok('"pago pelo" tambem casa', r.pagoPor === 'Estevao Bandeira')
  ok('valor com virgula intacto', r.valor === 2500)
  ok('tipo intacto', r.tipo === 'MATERIAL')
}

{
  const r = interpretar('tsuya areia 300 quem pagou foi a ana', REAIS, SOCIOS)
  ok('"quem pagou foi a" casa', r.pagoPor === 'Ana Paula Souza')
}

// Dois Joaos: escolher um seria por o gasto no nome do socio errado, e isso
// ninguem percebe olhando o relatorio. Prefere nao saber.
{
  const r = interpretar('haia cimento 250 pago por joao', REAIS, SOCIOS)
  ok('primeiro nome ambiguo NAO escolhe', r.pagoPor === null)
}

// Nome que nao existe: o gasto entra sem pagador, e quem aprova completa.
{
  const r = interpretar('haia cimento 250 pago por fulano', REAIS, SOCIOS)
  ok('nome desconhecido nao vira pagador', r.pagoPor === null)
}

// Sem a preposicao nao ha pagador: um nome solto na linha e adivinhacao.
{
  const r = interpretar('haia cimento 250 estevao', REAIS, SOCIOS)
  ok('nome solto sem "pago por" nao conta', r.pagoPor === null)
}

// Sem lista de socios o robo nao inventa ninguem.
ok('sem lista, sem pagador', acharPagador('haia cimento pago por joao', []).achado === null)
ok('texto vazio nao quebra', acharPagador('', SOCIOS).achado === null)

// E a linha sem pagador segue igual ao que ja era.
ok('linha sem pagador continua igual', interpretar('haia cimento 250', REAIS, SOCIOS).pagoPor === null)

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
