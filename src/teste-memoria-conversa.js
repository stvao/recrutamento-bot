/**
 * O robô lembra do que já foi dito.
 *
 * Medido nas conversas reais de 12/09/2026: o nome completo foi pedido duas
 * ou mais vezes em 10 conversas, registro em carteira em 4, data de
 * nascimento em 3. O modelo recebia só as últimas mensagens, e nunca a ficha.
 *
 * E quem voltava depois de 6 horas, com a ficha já gravada, ouviria de novo
 * "qual função você procura?" — ainda não tinha acontecido só porque o
 * recrutamento acabara de ser ligado.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

// O store grava num arquivo; o teste usa um descartável.
process.env.ESTADO_ARQUIVO = join(mkdtempSync(join(tmpdir(), 'memoria-')), 'conversas.json')

const { oQueJaSabe } = await import('./atendimento.js')
const { podeRetomar, _prazos } = await import('./store.js')

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

const HORA = 3600_000
const DIA = 24 * HORA

// ── Conversa começando: tudo falta, na ordem certa ─────────────────────
{
  const r = oQueJaSabe({})
  ok('sem nada, diz que não sabe nada', /ainda não sabe nada/i.test(r.texto))
  ok('a primeira coisa a saber é a vaga', r.falta[0] === 'qual vaga interessa')
  ok('a segunda é onde mora', r.falta[1] === 'em qual cidade mora')
}

// ── O caso real: nome pedido de novo ───────────────────────────────────
{
  const estado = {
    vaga: 'Pedreiro', cidadeMora: 'Jacareí', cidade: 'Pereiras',
    nome: 'Emanuel Isaque Fidelis do Carmo', temExperiencia: true, tempoExperiencia: '5 anos',
    temRegistro: true,
  }
  const r = oQueJaSabe(estado)
  ok('o nome aparece como já informado', r.sabido.some(x => /nome completo: já informado/.test(x)))
  ok('e NÃO está entre o que falta', !r.falta.includes('o nome completo'))
  ok('registro em carteira: sabido, não falta', r.sabido.some(x => /registro em carteira na função: sim/.test(x))
    && !r.falta.some(x => /registro/.test(x)))
  ok('experiência com o tempo', r.sabido.some(x => /tem \(5 anos\)/.test(x)))
  ok('a instrução é "nunca pergunte de novo"', /NUNCA pergunte de novo/.test(r.texto))
  ok('a próxima pergunta é a data de nascimento', r.falta[0] === 'data de nascimento')
}

// ── Dado pessoal não vai para o modelo ─────────────────────────────────
{
  const r = oQueJaSabe({
    nome: 'Carlos Alberto Souza', dataNascimento: '16/04/1974',
    contatoRecadoNome: 'Manu', contatoRecadoTelefone: '3584387250',
  })
  ok('a data de nascimento não vai', !r.texto.includes('1974'))
  ok('o telefone do contato não vai', !r.texto.includes('3584387250'))
  ok('o sobrenome não vai', !r.texto.includes('Souza'))
  ok('mas o modelo sabe que já foi informado', /data de nascimento: já informada/.test(r.texto))
}

// ── Ficha completa: para de perguntar ──────────────────────────────────
//
// O Carlos terminou a ficha, mandou "🙏" e ouviu "Boa tarde! Tudo bem por aí?".
{
  const completa = {
    vaga: 'Pedreiro', cidadeMora: 'Bastos', cidade: 'Bastos', nome: 'Carlos Alberto',
    temExperiencia: true, temRegistro: true, dataNascimento: 'x', disponibilidadeInicio: 'já',
    aceitaOutrasObras: 'sim', tamanhoCamisa: 'M', tamanhoBota: '41', contatoRecadoNome: 'Manu',
  }
  const r = oQueJaSabe(completa)
  ok('ficha completa: nada falta', r.falta.length === 0)
  ok('e manda parar de perguntar', /FICHA ESTÁ COMPLETA/.test(r.texto) && /Não faça mais nenhuma pergunta/.test(r.texto))
}

// ── Quem volta depois de horas ─────────────────────────────────────────
{
  const r = oQueJaSabe({ vaga: 'Servente' }, { paradoHa: 20 * HORA })
  ok('avisa que a pessoa sumiu e voltou', /FICOU 20 HORAS SEM RESPONDER/.test(r.texto))
  ok('e manda não se apresentar de novo', /não se apresente de novo/.test(r.texto))
  ok('dias quando passa de dois', /FICOU 3 DIAS/.test(oQueJaSabe({}, { paradoHa: 3 * DIA }).texto))
  ok('uma pausa curta não vira "voltou"', !/SEM RESPONDER/.test(oQueJaSabe({}, { paradoHa: 2 * HORA }).texto))
}

// ── Os prazos da conversa ──────────────────────────────────────────────
{
  const { TTL_MS, RETENCAO_MS } = _prazos()
  ok('a conversa continua por 3 dias (eram 6 horas)', TTL_MS === 3 * DIA)
  ok('e fica guardada para retomar por 7', RETENCAO_MS === 7 * DIA)
}

// ── Retomada: agora vale para ficha já gravada ─────────────────────────
{
  const agora = Date.now()
  const concluida = { estado: { modo: 'ia' }, atualizadoEm: agora - 4 * DIA, concluidoEm: agora - 5 * DIA }
  ok('conversa CONCLUÍDA parada há 4 dias pode ser retomada', podeRetomar(concluida, agora))
  ok('dentro dos 3 dias não é retomada — só continua', !podeRetomar({ ...concluida, atualizadoEm: agora - 2 * DIA }, agora))
  ok('depois de 7 dias, não', !podeRetomar({ ...concluida, atualizadoEm: agora - 8 * DIA }, agora))
  ok('sessão sem estado, não', !podeRetomar({ atualizadoEm: agora - 4 * DIA }, agora))
}

// ── A ligação: o modelo recebe mesmo o que já sabe ─────────────────────
{
  const aqui = dirname(fileURLToPath(import.meta.url))
  const ia = readFileSync(join(aqui, 'ia.js'), 'utf8')
  const at = readFileSync(join(aqui, 'atendimento.js'), 'utf8')
  const sv = readFileSync(join(aqui, 'server.js'), 'utf8')
  ok('atender manda o conhecido ao modelo', /conversar\(\{ historico, fatos, conhecido \}\)/.test(at))
  ok('as instruções incluem o conhecido', /instrucoes\(fatos, conhecido\)/.test(ia))
  ok('histórico de 40 mensagens', /LIMITE_HISTORICO = 40/.test(at))
  // Procura a mensagem como CÓDIGO (aberta por crase), e não como citação:
  // os comentários que explicam por que ela saiu citam o texto antigo entre
  // aspas, e são justamente eles que devem continuar lá.
  ok('a retomada não tem mais mensagem enlatada', !/`Oi de novo/.test(sv))
  ok('candidato conhecido não trava mais na mesma frase', !/Sua ficha\$\{onde/.test(sv))
  ok('a triagem passa o que foi dito ao recrutamento', /historico\.map\(m => \(\{\s*de: m\.de === 'pessoa'/.test(sv))
}

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
