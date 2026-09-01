/**
 * Módulo de gastos.
 *
 * O primeiro bloco é o que mais importa: a lista de autorizados é SEGURANÇA,
 * não organização. Sem ela, quem descobrir o número manda uma foto e cria
 * lançamento no financeiro da empresa. Um teste que prenda isso vale mais
 * que todos os outros juntos.
 *
 * Nada aqui vai à rede: o Gemini e o sistema de obras não são chamados. O
 * que se testa é a decisão — quem passa, o que vira texto, o que a pessoa lê
 * de volta.
 */
process.env.GASTOS_AUTORIZADOS = '5511999998888, 5511977776666'
process.env.GASTOS_GRUPOS = '120363000000000000@g.us'
process.env.OBRAS_API_TOKEN = 'token-de-teste'
process.env.GASTOS_ESPERA_DESCRICAO_MS = '50'

const { autorizado, origemAceita, montarTexto, tratar, _limparPendentes } = await import('./gastos.js')
const { conferir, CATEGORIAS } = await import('./ia-visao.js')
const { parseWebhook } = await import('./connectors.js')

let falhas = 0
function ok(desc, cond) {
  console.log(`${cond ? 'ok ' : 'FALHOU'} ${desc}`)
  if (!cond) falhas++
}

// ── 1. Quem pode lançar ───────────────────────────────────────────────────
ok('autorizado da lista passa', autorizado('5511999998888'))
ok('espaço na lista do .env não atrapalha', autorizado('5511977776666'))
ok('aceita o número formatado', autorizado('+55 (11) 99999-8888'))
ok('DESCONHECIDO NÃO passa', !autorizado('5511900000000'))
ok('vazio não passa', !autorizado(''))
ok('nulo não passa', !autorizado(null))

// ── 2. De onde os comprovantes podem vir ──────────────────────────────────
ok('grupo cadastrado é aceito', origemAceita('120363000000000000@g.us'))
ok('outro grupo NÃO é aceito', !origemAceita('120363999999999999@g.us'))

// ── 3. Estranho mandando foto não vira lançamento ─────────────────────────
// Se este falhar, qualquer um cria custo no financeiro da empresa.
_limparPendentes()
const deEstranho = await tratar({
  de: '5511900000000',
  chat: '120363000000000000@g.us',
  arquivo: Buffer.from('foto'),
  tipo: 'image/jpeg',
  texto: 'gasolina 200 reais',
  idMensagem: 'wamid.INVASOR',
})
ok('foto de não autorizado é IGNORADA', deEstranho === null)

const emOutroGrupo = await tratar({
  de: '5511999998888',
  chat: '120363999999999999@g.us',
  arquivo: Buffer.from('foto'),
  tipo: 'image/jpeg',
  idMensagem: 'wamid.OUTROGRUPO',
})
ok('autorizado em grupo não cadastrado é ignorado', emOutroGrupo === null)

// ── 4. O resumo que aparece na caixa de aprovação ─────────────────────────
// É por esta linha que a pessoa confere sem abrir a foto, então ela sai na
// ordem em que se lê um lançamento: obra, o que foi, tipo, quanto.
const digitado = {
  obra: 'Bastos Tsuya', descricao: 'tijolos e areia', tipo: 'MATERIAL',
  valor: 2500, valorDigitado: true, estabelecimento: 'Deposito Silva',
  formaPagamento: 'Pix', documento: '12345', dataComprovante: '2026-08-28',
}
const texto = montarTexto(digitado, null)
ok('resumo traz a obra', texto.includes('Bastos Tsuya'))
ok('resumo traz a descrição', texto.includes('tijolos e areia'))
ok('resumo traz o tipo legível', texto.includes('material'))
ok('resumo traz o valor em reais', texto.includes('R$ 2.500,00'))
ok('resumo traz a data do comprovante', texto.includes('28/08'))
ok('resumo traz a forma de pagamento', texto.includes('Pix'))
ok('valor digitado NÃO pede conferência', !texto.includes('confira'))

// Valor que veio da imagem avisa; valor digitado por gente, não. Encher de
// alerta o que está certo faz a pessoa parar de ler os alertas.
const lidoDaImagem = montarTexto({ ...digitado, valorDigitado: false }, null)
ok('valor lido da imagem AVISA para conferir', lidoDaImagem.includes('confira'))

const semValor = montarTexto({ obra: 'Peruibe', valor: null }, null)
ok('sem valor, avisa que precisa digitar', semValor.includes('precisa digitar'))

ok('observação da IA aparece', montarTexto(digitado, 'foto cortada').includes('foto cortada'))
ok('sem nada, ainda vai algum texto', montarTexto(null, null).length > 0)

// Milhar precisa sair legível — 1234.5 não pode virar "R$ 1234.5"
ok('milhar sai formatado', montarTexto({ valor: 1234.5 }, null).includes('R$ 1.234,50'))

// ── 5. A conferência do que o modelo leu ──────────────────────────────────
// Mesma regra do atendimento: o modelo é instruído, mas instrução não é
// garantia, e aqui um número errado vira dinheiro errado.
ok('valor zero não vira valor', conferir({ valor: 0, confianca: 'alta' }).valor === null)
ok('valor negativo não vira valor', conferir({ valor: -50, confianca: 'alta' }).valor === null)
ok('valor absurdo não vira valor', conferir({ valor: 99999999, confianca: 'alta' }).valor === null)
ok('valor bom passa', conferir({ valor: 250.5, confianca: 'alta' }).valor === 250.5)
ok('centavo é arredondado', conferir({ valor: 250.567, confianca: 'alta' }).valor === 250.57)

ok('data no futuro é recusada', conferir({ valor: 10, data: '2099-01-01' }).data === null)
ok('data mal formatada é recusada', conferir({ valor: 10, data: '28/08/2026' }).data === null)
ok('data boa passa', conferir({ valor: 10, data: '2026-08-28' }).data === '2026-08-28')

ok('categoria inventada é descartada', conferir({ valor: 10, categoria: 'PIZZA' }).categoria === null)
ok('categoria da lista passa', conferir({ valor: 10, categoria: 'MATERIAL' }).categoria === 'MATERIAL')
ok('a lista de categorias existe', CATEGORIAS.includes('COMBUSTIVEL') && CATEGORIAS.includes('OUTROS'))

// Sem valor legível não existe confiança alta, mesmo o modelo dizendo que sim.
ok('sem valor, a confiança cai para baixa', conferir({ valor: 0, confianca: 'alta' }).confianca === 'baixa')
ok('resposta vazia não quebra', conferir(null) === null)

// ── 6. O webhook oficial reconhece comprovante ────────────────────────────
const comFoto = parseWebhook({
  entry: [{ changes: [{ value: { messages: [{
    from: '5511999998888',
    id: 'wamid.ABC123',
    image: { id: 'MEDIA-1', mime_type: 'image/jpeg', caption: 'posto da BR' },
  }] } }] }],
})
ok('webhook reconhece imagem', comFoto?.mediaId === 'MEDIA-1')
ok('webhook usa a legenda como texto', comFoto?.texto === 'posto da BR')
ok('webhook guarda o id da mensagem (idempotência)', comFoto?.idMensagem === 'wamid.ABC123')
ok('via oficial nunca é grupo', comFoto?.ehGrupo === false)

const comPdf = parseWebhook({
  entry: [{ changes: [{ value: { messages: [{
    from: '5511999998888', id: 'wamid.PDF',
    document: { id: 'MEDIA-2', mime_type: 'application/pdf', filename: 'nota.pdf' },
  }] } }] }],
})
ok('webhook aceita PDF', comPdf?.mediaId === 'MEDIA-2' && comPdf?.nomeArquivo === 'nota.pdf')

const comAudio = parseWebhook({
  entry: [{ changes: [{ value: { messages: [{
    from: '5511999998888', id: 'wamid.AUD',
    audio: { id: 'MEDIA-3', mime_type: 'audio/ogg' },
  }] } }] }],
})
ok('webhook ignora áudio', comAudio === null)

const soTexto = parseWebhook({
  entry: [{ changes: [{ value: { messages: [{
    from: '5511911112222', id: 'wamid.TXT', text: { body: 'quero a vaga' },
  }] } }] }],
})
ok('webhook de texto segue sem mídia', soTexto?.texto === 'quero a vaga' && soTexto?.mediaId === null)

// ── 7. Grupo pelo NOME, e o coringa "*" ───────────────────────────────────
// Ninguém sabe de cabeça que o grupo é "120363...@g.us", mas todo mundo sabe
// que ele se chama "Comprovantes".
{
  const mod = await import('./gastos.js?porNome=1')
  // (mesma configuração do topo do arquivo — o módulo já está carregado)
  ok('grupo pelo identificador continua valendo', mod.origemAceita('120363000000000000@g.us'))
}

// Um processo separado, porque a configuração é lida uma vez só no import.
import { execFileSync } from 'node:child_process'

function comAmbiente(env, script) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  }).trim()
}

const porNome = comAmbiente(
  { GASTOS_GRUPOS: 'Comprovantes', GASTOS_AUTORIZADOS: '5511999998888', OBRAS_API_TOKEN: 'x' },
  `const g = await import('./src/gastos.js')
   console.log(JSON.stringify({
     nomeExato: g.origemAceita('123@g.us', 'Comprovantes'),
     semAcentoNemCaixa: g.origemAceita('123@g.us', 'COMPROVANTES'),
     outroNome: g.origemAceita('123@g.us', 'Futebol'),
     semNome: g.origemAceita('123@g.us', null),
   }))`,
)
const n = JSON.parse(porNome)
ok('grupo reconhecido pelo NOME', n.nomeExato)
ok('nome sem ligar para maiúscula/acento', n.semAcentoNemCaixa)
ok('grupo de outro nome NÃO passa', !n.outroNome)
ok('sem nome e sem id certo, NÃO passa', !n.semNome)

// O coringa: qualquer um do grupo pode lançar.
const coringa = comAmbiente(
  { GASTOS_GRUPOS: 'Comprovantes', GASTOS_AUTORIZADOS: '*', OBRAS_API_TOKEN: 'x' },
  `const g = await import('./src/gastos.js')
   console.log(JSON.stringify({
     ativo: g.gastosAtivo(),
     invalido: g.coringaInvalido(),
     doGrupo: g.autorizado('5511900000000', true),
     doPrivado: g.autorizado('5511900000000', false),
   }))`,
)
const c2 = JSON.parse(coringa)
ok('com "*" o módulo fica ativo', c2.ativo)
ok('"*" com grupo definido é válido', !c2.invalido)
ok('qualquer um DO GRUPO pode lançar', c2.doGrupo)
ok('mas NÃO no privado', !c2.doPrivado)

// E o caso que importa: "*" SEM grupo definido valeria para o privado também,
// e aí qualquer um que descobrisse o número lançaria no financeiro.
const perigo = comAmbiente(
  { GASTOS_GRUPOS: '', GASTOS_AUTORIZADOS: '*', OBRAS_API_TOKEN: 'x' },
  `const g = await import('./src/gastos.js')
   console.log(JSON.stringify({
     ativo: g.gastosAtivo(),
     invalido: g.coringaInvalido(),
     qualquerUm: g.autorizado('5511900000000', true),
   }))`,
)
const p2 = JSON.parse(perigo)
ok('"*" SEM grupo é RECUSADO', p2.invalido)
ok('e o módulo fica INATIVO em vez de abrir a porta', !p2.ativo)
ok('e ninguém lança', !p2.qualquerUm)

// ── 8. Sinal de vida ──────────────────────────────────────────────────────
// O silêncio com texto solto é o certo na operação, e péssimo na instalação:
// não dá para distinguir "funcionando" de "nem conectou".
_limparPendentes()
const noGrupo = { de: '5511999998888', chat: '120363000000000000@g.us', ehGrupo: true, idMensagem: 'm-ping' }

for (const palavra of ['ping', 'teste', 'robo?', 'status']) {
  const r = await tratar({ ...noGrupo, texto: palavra })
  ok(`"${palavra}" responde que está vivo`, typeof r === 'string' && r.includes('Estou aqui'))
}
ok('a resposta ensina o formato', (await tratar({ ...noGrupo, texto: 'ping' })).includes('material'))
ok('"oi" continua sem resposta', (await tratar({ ...noGrupo, texto: 'oi' })) === null)
ok('conversa normal continua sem resposta', (await tratar({ ...noGrupo, texto: 'bom dia pessoal' })) === null)
ok('não autorizado não recebe nem o ping', (await tratar({ ...noGrupo, de: '5511900000000', texto: 'ping' })) === null)

_limparPendentes()
console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
