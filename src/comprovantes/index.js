/**
 * Módulo de comprovantes — o ponto de entrada.
 *
 * O resto do robô (server.js, baileys.js) importa SÓ daqui. O que cada
 * arquivo desta pasta faz está no README.md ao lado.
 */
export {
  coringaInvalido, coringaSoComNome, gastosAtivo, autorizado, podeLancarGasto,
  origemAceita, comoCasouAOrigem,
} from './autorizacao.js'
export { tratar, situacao, _limparPendentes } from './entrada.js'
export { iniciarRonda, encerrar, _rodarRonda } from './ronda.js'
export { montarTexto, diaDoEnvio } from './saida.js'
export { agendar as agendarResumo } from './resumo-diario.js'
