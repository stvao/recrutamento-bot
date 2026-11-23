/**
 * Comprovantes — quem pode lançar, e de onde a mensagem pode vir.
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 * Tudo aqui é lido do .env uma vez, no import.
 */
import { obrasConfigurado } from './obras-client.js'
import { norm } from '../texto.js'

/**
 * Quem pode lançar.
 *
 * Isto é SEGURANÇA, não organização. Sem a lista, quem descobrir o número
 * manda uma foto e cria lançamento no financeiro da empresa. Números só com
 * dígitos, separados por vírgula, no .env:
 *
 *   GASTOS_AUTORIZADOS=5511999998888,5511977776666
 *
 * Lista vazia é tratada como "ninguém": um erro de configuração não pode
 * abrir a porta para todo mundo.
 */
const BRUTO_AUTORIZADOS = (process.env.GASTOS_AUTORIZADOS || '').split(',').map(x => x.trim()).filter(Boolean)

/**
 * "*" = qualquer pessoa, mas SÓ de dentro dos grupos cadastrados.
 *
 * Faz sentido quando o grupo é fechado e todo mundo nele pode lançar —
 * evita ter que cadastrar e manter a lista de cada gestor de obra.
 *
 * Só vale COM grupo definido, e é por isso que a checagem existe: sem
 * GASTOS_GRUPOS, o "*" valeria também para quem manda no privado, e aí
 * qualquer um que descubra o número lança no financeiro. Nesse caso ele é
 * recusado e o robô avisa alto, em vez de abrir a porta em silêncio.
 */
export const QUALQUER_UM_DO_GRUPO = BRUTO_AUTORIZADOS.includes('*')

export const AUTORIZADOS = new Set(
  BRUTO_AUTORIZADOS
    .filter(n => n !== '*')
    .map(n => n.replace(/\D/g, ''))
    .filter(Boolean),
)

/**
 * De onde os comprovantes vêm.
 *
 * Vazio = qualquer conversa, desde que o remetente esteja autorizado (é o
 * caso de quem manda direto no privado do bot). Preenchido, restringe ao
 * grupo: o robô fica calado em todo o resto, que é o que se quer quando ele
 * é membro de vários grupos.
 */
export const GRUPOS = new Set(
  (process.env.GASTOS_GRUPOS || '').split(',').map(g => g.trim()).filter(Boolean),
)

/**
 * Também pelo NOME do grupo.
 *
 * Ninguém sabe de cabeça que o grupo dos comprovantes é
 * "120363044...@g.us", mas todo mundo sabe que ele se chama "Comprovantes".
 * Aceitar o nome tira um passo de configuração que só existia por limitação
 * nossa.
 *
 * Perigo do nome: qualquer um pode criar um grupo chamado "Comprovantes",
 * botar o robô dentro e mandar comprovante.
 *
 * Por isso o nome só serve como FILTRO de onde escutar, nunca como
 * credencial. Quando há lista de números, tudo bem: o nome diz onde o robô
 * presta atenção, e quem autoriza é a lista.
 *
 * Com o coringa "*" é diferente, e era aqui que estava o furo: não há lista,
 * então estar no grupo É a credencial — e o nome, que o atacante escolhe,
 * virava a chave inteira. O coringa passou a exigir que o grupo tenha casado
 * pelo IDENTIFICADOR, que o WhatsApp atribui e ninguém escolhe.
 */
const GRUPOS_NORM = new Set([...GRUPOS].map(g => norm(g)))

export function coringaInvalido() {
  return QUALQUER_UM_DO_GRUPO && GRUPOS.size === 0
}

/** Um identificador de grupo do WhatsApp/Telegram, e não um nome digitado. */
function pareceIdentificador(g) {
  return /@g\.us$/.test(g) || /^-?\d{5,}$/.test(g)
}

/**
 * Coringa configurado só com NOME de grupo — aceito antes, recusado agora.
 *
 * Era um furo: qualquer pessoa criava um grupo com aquele nome, punha o robô
 * dentro e lançava no financeiro. Como agora o coringa exige identificador,
 * essa configuração deixa de autorizar alguém — e ficar em silêncio faria o
 * dono achar que o robô quebrou. Melhor dizer exatamente o que fazer.
 */
export function coringaSoComNome() {
  if (!QUALQUER_UM_DO_GRUPO || GRUPOS.size === 0) return false
  return ![...GRUPOS].some(pareceIdentificador)
}

export function gastosAtivo() {
  if (coringaInvalido()) return false

  // Coringa só com nome de grupo não credencia ninguém, então o módulo não
  // está "no ar" — estava dizendo que sim e recusando todo mundo em seguida,
  // que é a pior forma de falhar: o dono lê "no ar" e vai procurar o defeito
  // em qualquer outro lugar.
  if (coringaSoComNome()) return false

  // Coringa sozinho também não basta: quem o usa depende de casar o grupo
  // pelo identificador, e sem AUTORIZADOS a lista de números fica vazia.
  const temQuem = AUTORIZADOS.size > 0 || QUALQUER_UM_DO_GRUPO
  return temQuem && obrasConfigurado()
}

/**
 * Este remetente pode lançar gasto?
 *
 * `deGrupoCadastrado` diz se a mensagem veio de um grupo da lista — é o que
 * o coringa exige. Sem isso, "*" valeria para quem manda no privado também.
 */
export function autorizado(de, deGrupoCadastrado = false) {
  if (AUTORIZADOS.has((de || '').replace(/\D/g, ''))) return true

  // O coringa exige grupo casado pelo IDENTIFICADOR.
  //
  // Casar pelo nome não serve aqui, e o buraco era real: com
  // GASTOS_AUTORIZADOS=* e GASTOS_GRUPOS=Comprovantes, qualquer pessoa criava
  // um grupo chamado "Comprovantes", punha o robô dentro e lançava no
  // financeiro da empresa. O comentário acima já dizia que o nome só vale
  // "junto com a checagem de quem enviou" — mas com o coringa NÃO HÁ checagem
  // de quem enviou: estar no grupo É a credencial. O nome, que o atacante
  // escolhe, virava a chave inteira.
  //
  // `deGrupoCadastrado` agora significa "grupo casado por id", e é quem
  // chama que garante isso.
  if (QUALQUER_UM_DO_GRUPO && GRUPOS.size > 0 && deGrupoCadastrado) return true
  return false
}

/**
 * O telefone de quem mandou, quando é telefone DE VERDADE.
 *
 * Em grupo o WhatsApp pode entregar o remetente como "@lid" — um
 * identificador que esconde o número. Quando o robô não consegue traduzi-lo,
 * `de` traz os dígitos do lid, que têm cara de telefone e não são de
 * ninguém. Mandar isso ao sistema como "quem enviou" faria o reembolso ir
 * para um desconhecido, ou — pior — casar por acaso com o número de outra
 * pessoa. Então só vale quando quem entregou a mensagem afirma que conhece o
 * telefone, e ele tem forma de número brasileiro (55 + DDD + número).
 *
 * É o que o robô diz ao sistema tanto ao LANÇAR (de quem é o reembolso)
 * quanto ao CORRIGIR (quem pediu a correção).
 */
export function telefoneDeQuemMandou(msg) {
  if (msg?.telefoneConhecido !== true) return null
  const numero = String(msg.de ?? '').replace(/\D/g, '')
  return /^55\d{10,11}$/.test(numero) ? numero : null
}

/**
 * Este número está na lista EXPLÍCITA de autorizados?
 *
 * Mais estreito que `autorizado()`: o coringa do grupo não conta. Serve para
 * o que pede mais do que "pode lançar o próprio gasto" — corrigir ou cancelar
 * o lançamento de outra pessoa, por exemplo.
 */
export function numeroNaLista(de) {
  return AUTORIZADOS.has(String(de ?? '').replace(/\D/g, ''))
}

/**
 * A pergunta completa: esta mensagem pode lançar gasto?
 *
 * Reúne origem e remetente num lugar só. Antes cada chamador combinava as
 * duas por conta própria — e combinar errado é justamente o que abre a porta.
 */
export function podeLancarGasto({ de, chat, chatNome, ehGrupo }) {
  const como = comoCasouAOrigem(chat, chatNome)
  if (como === null) return false
  // Só o casamento por identificador credencia o coringa.
  return autorizado(de, Boolean(ehGrupo) && como === 'id')
}

/**
 * A mensagem veio de onde os comprovantes devem vir?
 *
 * Aceita o identificador técnico do grupo OU o nome dele — quem configura
 * sabe o nome, não o identificador.
 */
export function origemAceita(chat, chatNome) {
  return comoCasouAOrigem(chat, chatNome) !== null
}

/**
 * COMO a origem foi aceita: por identificador, por nome, ou por não haver
 * restrição. Devolve null quando não foi aceita.
 *
 * A distinção existe por segurança, e não por capricho. O identificador de um
 * grupo é atribuído pelo WhatsApp e ninguém escolhe; o NOME é digitado por
 * quem cria o grupo. São garantias completamente diferentes, e o coringa "*"
 * depende dessa diferença — ver `autorizado()`.
 */
export function comoCasouAOrigem(chat, chatNome) {
  if (GRUPOS.size === 0) return 'sem_restricao'
  if (GRUPOS.has(String(chat ?? ''))) return 'id'
  if (chatNome && GRUPOS_NORM.has(norm(chatNome))) return 'nome'
  return null
}
