/**
 * Testes da comparação tolerante a erro de escrita.
 *
 * São dois riscos opostos e é preciso vigiar os dois. Frouxo demais, "valeu"
 * vira pergunta sobre vale-transporte e "cozinheiro" vira uma vaga que não
 * existe. Rígido demais, "pedrero" ouve "não entendi" e a pessoa desiste.
 *
 *   node src/teste-texto.js
 */
import { melhorMatch, contemAlgum } from './texto.js'

const VAGAS = [
  { valor: 'Servente',    termos: ['servente', 'ajudante', 'auxiliar', 'meio oficial', 'servico geral'] },
  { valor: 'Pedreiro',    termos: ['pedreiro', 'alvenaria'] },
  { valor: 'Serralheiro', termos: ['serralheiro', 'soldador', 'solda'] },
  { valor: 'Armador',     termos: ['armador', 'ferreiro', 'ferragem'] },
  { valor: 'Carpinteiro', termos: ['carpinteiro', 'carpintaria', 'forma'] },
  { valor: 'Eletricista', termos: ['eletricista', 'eletrica'] },
]
const CIDADES = [
  { valor: 'Peruíbe', termos: ['Peruíbe'] },
  { valor: 'Caraguatatuba', termos: ['Caraguatatuba', 'caragua'] },
  { valor: 'Itapevi', termos: ['Itapevi'] },
  { valor: 'Buritama', termos: ['Buritama'] },
  { valor: 'Bastos', termos: ['Bastos'] },
]
const TERMOS_VALE = ['vale', 'passe', 'transporte', 'conducao', 'passagem', 'onibus']
const TERMOS_SIM = ['sim', 'tenho', 'ja tenho', 'ja', 'possuo', 'claro', 'positivo', 'isso']
const TERMOS_NAO = ['nao', 'nunca', 'ainda nao', 'negativo', 'sem experiencia', 'nenhuma']

let falhas = 0
function conf(descricao, obtido, esperado) {
  const ok = obtido === esperado
  if (!ok) falhas++
  console.log(`${ok ? 'ok  ' : 'FALHA '}${descricao} -> ${obtido} (esperado ${esperado})`)
}

console.log('\n— vaga escrita errada ainda é reconhecida —')
for (const [msg, esperado] of [
  ['pedrero', 'Pedreiro'], ['pedreirro', 'Pedreiro'], ['eletrecista', 'Eletricista'],
  ['carpinteo', 'Carpinteiro'], ['carpint', 'Carpinteiro'], ['seralheiro', 'Serralheiro'],
  ['ajudande', 'Servente'], ['sou ferreiro', 'Armador'], ['faco solda', 'Serralheiro'],
  ['quero ser PEDREIRO!!', 'Pedreiro'],
]) conf(`"${msg}"`, melhorMatch(msg, VAGAS), esperado)

console.log('\n— o que não é vaga nossa continua não sendo —')
for (const msg of ['cozinheiro', 'motorista', 'gosto de futebol', 'bom dia', ''])
  conf(`"${msg}"`, melhorMatch(msg, VAGAS), null)

console.log('\n— cidade escrita errada —')
for (const [msg, esperado] of [
  ['peruibi', 'Peruíbe'], ['peruibe', 'Peruíbe'], ['caragua', 'Caraguatatuba'],
  ['itapevy', 'Itapevi'], ['buritma', 'Buritama'], ['moro em bastos', 'Bastos'],
]) conf(`"${msg}"`, melhorMatch(msg, CIDADES), esperado)

console.log('\n— cidade onde não temos obra —')
for (const msg of ['sao paulo', 'santos', 'moro no rio'])
  conf(`"${msg}"`, melhorMatch(msg, CIDADES), null)

console.log('\n— assunto da pergunta, mesmo com erro —')
for (const [msg, termos, esperado] of [
  ['quanto e o salrio?', ['salario', 'remuneracao'], true],
  ['tem alojamneto?', ['alojamento', 'moradia'], true],
  ['me manda o vale trasporte', TERMOS_VALE, true],
  ['tem passgem de onibus?', TERMOS_VALE, true],
  ['gosto de futebol', TERMOS_VALE, false],
]) conf(`"${msg}"`, contemAlgum(msg, termos), esperado)

console.log('\n— palavras parecidas que NÃO podem disparar —')
// "valeu" é obrigado, não vale-transporte. "nada" não é "não".
for (const [msg, termos, esperado] of [
  ['valeu', TERMOS_VALE, false],
  ['valeu obrigado', TERMOS_VALE, false],
  ['quero a vaga', TERMOS_VALE, false],
  ['vale transporte', TERMOS_VALE, true],
  ['nada', TERMOS_NAO, false],
  ['nao tenho', TERMOS_NAO, true],
  ['sou ajudante', TERMOS_SIM, false],
]) conf(`"${msg}"`, contemAlgum(msg, termos), esperado)

console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
