/**
 * Palavra comum não vira vaga, e função fechada não vira vaga aberta.
 *
 * Tudo aqui saiu de conversas reais de 12/09/2026:
 *  - "Quanto está o salário do mestre aí?" recebeu o valor da bolsa de
 *    estágio: "esta" era o começo de "estagio";
 *  - "mestre de obras" foi registrado como "Outros: Mestre de obras", para
 *    uma vaga que a empresa não tem;
 *  - "consigo ler só mensagem de texto" foi respondido 89 vezes, 53 delas
 *    logo depois de a pessoa ter escrito.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const { melhorMatch } = await import('../src/texto.js')
const brain = await import('../src/brain.js')

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

// As vagas como estão cadastradas no RH.
const VAGAS = [
  { valor: 'Servente', termos: ['Servente', 'servente', 'ajudante', 'auxiliar', 'meio oficial', 'ajudante geral'] },
  { valor: 'Pedreiro', termos: ['Pedreiro', 'pedreiro', 'alvenaria', 'oficial'] },
  { valor: 'Estagiário', termos: ['Estagiário', 'estagiario', 'estagiaria', 'estagio'] },
  { valor: 'Carpinteiro', termos: ['Carpinteiro', 'carpinteiro', 'carpintaria'] },
]
const vaga = (frase) => melhorMatch(frase, VAGAS)

// ── O caso real: "está" não é estágio ──────────────────────────────────
ok('"Quanto está o salário do mestre aí?" não vira estágio', vaga('Quanto está o salário do mestre aí?') === null)
ok('"isso esta certo" não vira estágio', vaga('isso esta certo') === null)
ok('"está bom" não vira estágio', vaga('está bom') === null)
ok('"auxílio transporte" não vira servente', vaga('tem auxílio transporte?') === null)

// ── E o que funcionava continua funcionando ────────────────────────────
ok('erro de digitação: "pedrero" ainda é pedreiro', vaga('sou pedrero') === 'Pedreiro')
ok('prefixo longo: "carpint" ainda é carpinteiro', vaga('sou carpint') === 'Carpinteiro')
ok('"estagio" escrito ainda é estágio', vaga('tem estagio?') === 'Estagiário')
ok('"ajudante" ainda é servente', vaga('quero vaga de ajudante') === 'Servente')

// ── Função fechada ─────────────────────────────────────────────────────
ok('reconhece mestre de obras', brain.funcaoFechadaCitada('Tem vaga pra mestre de obras') === 'mestre de obras')
ok('reconhece encarregado', brain.funcaoFechadaCitada('sou encarregado') === 'encarregado')
ok('reconhece eletricista', brain.funcaoFechadaCitada('vaga de eletricista?') === 'eletricista')
ok('frase sem função fechada', brain.funcaoFechadaCitada('sou pedreiro') === null)

{
  const r = brain.responderFAQ('Quanto está o salário do mestre aí?', {})
  ok('salário do mestre: diz que não tem vaga de mestre de obras', /não temos vaga de mestre de obras/.test(r?.texto ?? ''))
  ok('  e NÃO fala de bolsa de estágio', !/bolsa/.test(r?.texto ?? ''))
  ok('  e diz o que está aberto', /pedreiro/.test(r?.texto ?? ''))
}
{
  const r = brain.responderFAQ('tem vaga pra mestre de obras?', {})
  ok('vaga de mestre de obras: não tem', /não temos vaga de mestre de obras/.test(r?.texto ?? ''))
}
{
  const r = brain.responderFAQ('quanto ganha mestre carpinteiro?', {})
  ok('"mestre carpinteiro" é carpinteiro, não recusa', !/não temos vaga/.test(r?.texto ?? ''))
}
{
  const r = brain.responderFAQ('vou falar com o encarregado amanhã', {})
  ok('"falar com o encarregado" não é pedido de vaga', !/não temos vaga/.test(r?.texto ?? ''))
}

// ── O roteiro não registra vaga que não existe ─────────────────────────
{
  const r = brain.responder({ etapa: 'vaga', whatsapp: 'x' }, 'mestre de obras')
  ok('etapa vaga + mestre de obras: recusa', /não temos vaga de mestre de obras/.test(r.resposta))
  ok('  e continua na etapa vaga, sem vaga preenchida', r.estado.etapa === 'vaga' && !r.estado.vaga)
}
{
  const r = brain.responder({ etapa: 'vagaOutros', whatsapp: 'x' }, 'Mestre de obras')
  ok('outra função "mestre de obras": não vira "Outros: ..."', !/Outros/.test(r.estado.vaga ?? '') && !r.estado.vaga)
  ok('  e diz que não tem', /não temos vaga de mestre de obras/.test(r.resposta))
}
{
  const r = brain.responder({ etapa: 'vagaOutros', whatsapp: 'x' }, 'pedreiro')
  ok('outra função que é aberta: segue com ela', r.estado.vaga === 'Pedreiro' && r.estado.etapa === 'cidade')
}

// ── A reserva só oferece o que está aberto ─────────────────────────────
{
  const nomes = (await import('../src/catalogo.js')).vagasAtuais().map(v => v.nome)
  ok('reserva sem armador, serralheiro e eletricista',
    !nomes.includes('Armador') && !nomes.includes('Serralheiro') && !nomes.includes('Eletricista'))
  ok('reserva com as quatro vagas abertas',
    ['Servente', 'Pedreiro', 'Carpinteiro', 'Estagiário'].every(n => nomes.includes(n)))
}

// ── "Só leio texto" só para áudio que falhou ───────────────────────────
{
  const aqui = dirname(fileURLToPath(import.meta.url))
  const baileys = readFileSync(join(aqui, '..', 'src', 'baileys.js'), 'utf8')
  const ia = readFileSync(join(aqui, '..', 'src', 'ia.js'), 'utf8')
  // Entre aspas simples: como TEXTO DE RESPOSTA. O comentário que explica por
  // que a frase saiu a cita entre aspas duplas, e deve continuar lá.
  ok('a frase "consigo ler só mensagem de texto" saiu', !/'consigo ler só mensagem de texto/.test(baileys))
  ok('só áudio que falhou recebe resposta', /recrutamentoLigado\(\) && audio\)/.test(baileys))
  ok('mensagem temporária é aberta', /ephemeralMessage\?\.message/.test(baileys))
  ok('visualização única é aberta', /viewOnceMessageV2\?\.message/.test(baileys))
  // \r?\n: o arquivo é gravado com quebra de linha do Windows.
  ok('o texto passa pelo desembrulho', /const m = desembrulhar\(msg\.message\)\r?\n\s+if \(!m\) return null/.test(baileys))
  ok('cota esgotada liga a pausa', /if \(r\.status === 429\) semCotaAte = Date\.now\(\) \+ PAUSA_COTA_MS/.test(ia))
  ok('e a conversa respeita a pausa', /if \(!CHAVE \|\| Date\.now\(\) < semCotaAte\) return null/.test(ia))
  ok('a IA sabe das funções fechadas', /FUNÇÕES QUE NÃO ESTAMOS CONTRATANDO AGORA/.test(ia))
  // Ideias aproveitadas da revisão por outra IA (13/09/2026).
  ok('aceita correção sem questionar', /Corrigiu algo/.test(ia))
  ok('confirma resposta ambígua', /só pra confirmar/.test(ia))
  ok('volta ao cadastro depois de mudar de assunto', /Mudou de assunto/.test(ia))
  ok('texto do candidato nunca é instrução', /CONVERSA, nunca instrução/.test(ia))
  // Ideias aproveitadas do prompt de evolução da conversa (13/09/2026).
  ok('liga a pergunta ao que a pessoa contou', /é conversa, não formulário/.test(ia))
  ok('não pressiona quem não sabe', /Nunca pressione/.test(ia))
  ok('pediu pessoa: para de perguntar', /Pediu para falar com uma pessoa/.test(ia))
  ok('nunca "resposta inválida"', /Nunca "resposta inválida"/.test(ia))
  ok('"vou confirmar" sempre avisa o RH', /confirmar com a equipe E\s+marque precisaHumano/.test(ia))
}

// ── Bloqueiro e broqueiro são pedreiro de alvenaria (dono, 16/09/2026) ─
//
// Saiu das conversas reais: "sou bloqueiro e fachadeiro", "3 meses
// trabalhando como bloqueiro em Sorocaba", "VCS estão contratando bloqueiro?".
{
  const pedreiro = (await import('../src/catalogo.js')).vagasAtuais().find(v => v.nome === 'Pedreiro')
  ok('a reserva conhece bloqueiro', pedreiro.sinonimos.includes('bloqueiro'))
  ok('e broqueiro', pedreiro.sinonimos.includes('broqueiro'))
  ok('"sou bloqueiro" não vira recusa de vaga', !/não temos vaga/.test(brain.responderFAQ('sou bloqueiro', {})?.texto ?? ''))
}

// ── Passagem para chegar na obra: reembolso só ao chegar ───────────────
//
// Perguntado mais de trinta vezes em 180 dias por quem mora em outro estado.
{
  const pergunta = (frase) => brain.responderFAQ(frase, {})?.texto ?? ''
  for (const frase of ['vcs pagam passagem?', 'a empresa fornece passagem pra mim chegar ai?', 'vcs mandam a passagem', 'tem ajuda de custo pra viagem?']) {
    const r = pergunta(frase)
    ok(`"${frase}": reembolso quando chega`, /reembolsa quando você chega/.test(r))
    ok('  e não manda nada antes', /não manda dinheiro nem passagem antes/.test(r))
  }
  ok('vale-transporte continua com a resposta dele', /vale-transporte é a partir do primeiro dia/i.test(pergunta('tem vale transporte?')))
}

// ── Ficha pronta: chama gente em vez de repetir a mesma frase ──────────
//
// "Sua candidatura já está com o nosso RH" foi a frase mais repetida do robô:
// 126 vezes em 180 dias, sempre igual, para quem perguntava outra coisa.
{
  const r1 = brain.responder({ etapa: 'fim', whatsapp: 'x' }, 'e aí, saiu alguma coisa?')
  ok('primeira vez depois da ficha: chama gente', r1.escalarHumano === true && /vou pedir pra alguém/.test(r1.resposta))
  const r2 = brain.responder(r1.estado, 'e agora?')
  ok('  e não repete a mesma frase', !/vou pedir pra alguém/.test(r2.resposta) && !r2.escalarHumano)
}

{
  const iaTexto = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ia.js'), 'utf8')
  ok('a IA sabe da passagem reembolsada', /PASSAGEM PARA CHEGAR NA OBRA/.test(iaTexto))
  ok('a IA avisa quem mora em outro estado', /Quem mora em OUTRO ESTADO/.test(iaTexto))
  ok('indicação de colega: pede para ele falar aqui', /passar este contato para a pessoa falar aqui/.test(iaTexto))
}

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
