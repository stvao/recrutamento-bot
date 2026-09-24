/**
 * As correções da revisão de 19 a 23/09/2026 — cada uma nasceu de um defeito
 * reproduzido no código pelos revisores.
 */
import { readFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.ESTADO_ARQUIVO = join(mkdtempSync(join(tmpdir(), 'revisao-')), 'conversas.json')
process.env.CANDIDATURAS_PENDENTES_DIR = mkdtempSync(join(tmpdir(), 'pendentes-'))

const { ehCobranca } = await import('../src/quem-atender.js')
const { mensagemEhChavePix } = await import('../src/contratacao.js')
const lembrete = await import('../src/lembrete-cadastro.js')
const fichas = await import('../src/candidaturas-pendentes.js')
const store = await import('../src/store.js')
const { oQueJaSabe } = await import('../src/atendimento.js')

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

// ── Cobrança não cala candidato que conta a experiência ────────────────
{
  const candidato = [
    'trabalhei 5 anos de pedreiro com carteira assinada',
    'minha ultima obra: trabalhei na MRV em Marilia',
    'quanto voces vao me pagar por dia?',
    'nunca trabalhei registrado mas tenho experiencia',
    'ja trabalhei sim',
    'meus dias de folga sao quais?',
  ]
  for (const f of candidato) ok(`candidato: "${f.slice(0, 38)}"`, !ehCobranca(f))
  const cobra = [
    'trabalhei 3 dias e nada',
    'quando voces vao me pagar',
    'nao recebi meu pagamento',
    'so o dinheiro do Renato vai cair hj?',
    'fui o unico que nao recebeu nada',
    'trabalhamos a semana passada e nao caiu',
  ]
  for (const f of cobra) ok(`cobrança: "${f.slice(0, 38)}"`, ehCobranca(f))
}

// ── Chave PIX só quando é chave ────────────────────────────────────────
ok('telefone da esposa não é chave PIX', !mensagemEhChavePix('se nao me achar liga no 14 99812-3456 que é da minha esposa'))
ok('"meu cpf é ..." não é chave PIX', !mensagemEhChavePix('meu cpf é 529.982.247-25'))
ok('"meu pix é ..." é chave', mensagemEhChavePix('meu pix é 529.982.247-25'))
ok('a chave sozinha é chave', mensagemEhChavePix('529.982.247-25') && mensagemEhChavePix('joao@gmail.com'))
ok('frase sem chave não é', !mensagemEhChavePix('ja mandei os documentos'))

// ── Lembrete não vai para conversa fechada ─────────────────────────────
{
  const HORA = 3600_000
  const base = (estado) => ({
    estado: { modo: 'ia', vaga: 'Pedreiro', nome: 'João Silva', historico: [{ de: 'pessoa', texto: 'oi' }, { de: 'maria', texto: 'qual cidade vc mora?' }], ...estado },
    atualizadoEm: Date.now() - 25 * HORA,
  })
  const decide = (estado) => lembrete.decidir(base(estado), { comercial: true })
  ok('quem deixou passar a ficha não recebe lembrete', !decide({ confirmouInteresse: 'sim' }).lembrar)
  ok('quem não quis também não', !decide({ confirmouInteresse: 'nao' }).lembrar)
  ok('conversa que o roteiro concluiu não recebe', !decide({ modo: 'roteiro', etapa: 'fim' }).lembrar)
  ok('cadastro parado de verdade recebe', decide({}).lembrar)
  // O que falta por conta do ROBÔ (conferir o que sabe fazer, pedir a
  // confirmação) não conta como cadastro não terminado.
  const completaMenosRobo = {
    vaga: 'Pedreiro', cidadeMora: 'Bastos', cidade: 'Bastos', nome: 'Carlos Alberto', temExperiencia: true,
    temRegistro: true, dataNascimento: 'x', disponibilidadeInicio: 'já', aceitaOutrasObras: 'sim',
    contatoRecadoNome: 'Manu',
  }
  ok('só falta o que depende do robô: não lembra', !decide(completaMenosRobo).lembrar)
}

// ── Documento já recebido não é pedido de novo ─────────────────────────
{
  const comFoto = oQueJaSabe({ vaga: 'Pedreiro', nome: 'João Silva', rg: '12.345.678-9', documentos: ['rg'] })
  ok('foto recebida entra no que já se sabe', comFoto.sabido.some(x => /foto de documento/.test(x)))
  ok('  e o opcional não pede foto de novo', !comFoto.opcional.some(x => /foto do documento —/.test(x)))
}

// ── Candidatura que o RH não recebeu fica guardada ─────────────────────
{
  const dados = { nomeCompleto: 'João Silva', vagaPretendida: 'Pedreiro' }
  ok('guarda a ficha que falhou', fichas.guardar('5514999990000', dados, { primeiraVez: true }))
  const fila = fichas.pendentes()
  ok('  e ela aparece na fila', fila.length === 1 && fila[0].dados.nomeCompleto === 'João Silva')
  ok('  com a marca de primeira vez', fila[0].primeiraVez === true)
  fichas.guardar('5514999990000', { ...dados, cidadePreferencia: 'Bastos' })
  const depois = fichas.pendentes()
  ok('reenvio atualiza a mesma ficha, não duplica', depois.length === 1 && depois[0].dados.cidadePreferencia === 'Bastos')
  ok('  e mantém a marca de primeira vez', depois[0].primeiraVez === true)
  fichas.remover('5514999990000')
  ok('com o ok do RH, sai da fila', fichas.quantas() === 0)
  fichas.guardar('5514888880000', dados, { agora: Date.now() - 8 * 24 * 3600_000 })
  ok('passou de 7 dias: não insiste mais', fichas.pendentes().length === 0)
}

// ── O endereço @lid guardado, para o lembrete chegar ──────────────────
{
  store.anotarJid('555000111222333', '555000111222333@lid')
  ok('guarda o jid da conversa @lid', store.jidDe('555000111222333') === '555000111222333@lid')
  ok('número comum não guarda nada', store.jidDe('5514999990001') === null)
  store.setEstado('5514999990002', { modo: 'ia', historico: [{ de: 'maria', texto: 'oi de novo' }] })
  store.marcarLembrado('5514999990002', 'oi de novo')
  store.desmarcarLembrado('5514999990002', 'oi de novo')
  const e = store.getEstado('5514999990002')
  ok('envio falhou: a marca do lembrete é desfeita', !e.lembradoEm && !e.historico.some(m => m.texto === 'oi de novo'))
}

// ── A ligação ─────────────────────────────────────────────────────────
{
  const aqui = dirname(fileURLToPath(import.meta.url))
  const sv = readFileSync(join(aqui, '..', 'src', 'server.js'), 'utf8')
  const bl = readFileSync(join(aqui, '..', 'src', 'baileys.js'), 'utf8')
  const st = readFileSync(join(aqui, '..', 'src', 'store.js'), 'utf8')
  ok('uma mensagem por vez, por número', /return naFila\(msg\.de, \(\) => atenderRecrutamento\(msg\)\)/.test(sv))
  ok('o silêncio da cobrança fica gravado', /modo: 'calado'/.test(sv) && /motivoCalado/.test(sv))
  ok('  e o RH é avisado no máximo uma vez a cada 12h', /AVISO_MS = 12 \* 3600_000/.test(sv))
  ok('áudio ilegível passa pelo roteador', /audioIlegivel: true/.test(bl) && /if \(msg\.audioIlegivel\)/.test(sv))
  ok('lembrete só com o WhatsApp conectado', /if \(!\(await conectado\(\)\)\)/.test(sv))
  ok('lembrete de documentos respeita atendimento humano', /maoHumana\.atendidaPorGente\(numero\)\.atendida/.test(sv))
  ok('candidatura que falhou é reenviada', /reenviarCandidaturasPendentes/.test(sv))
  ok('mão humana marcada fora da observação', /export function ehMaoDaEmpresa/.test(bl))
  ok('o log não guarda o texto da escalada', !/motivoEscalada\} — "\$\{msg\.texto\}"/.test(sv))
  // O comentário explica o process.exit que existia ali; o que não pode voltar
  // é a CHAMADA. Por isso os comentários saem antes de conferir.
  const semComentarios = st.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  ok('o store não mata mais o processo',
    /process\.on\('exit', salvar\)/.test(st) && !/process\.exit/.test(semComentarios))
  ok('nenhum caractere invisível', ![sv, bl, st].some(t => t.includes(String.fromCharCode(8))))
}

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
