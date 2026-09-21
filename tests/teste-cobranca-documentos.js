/**
 * A cobrança de documento para funcionário.
 *
 * O robô foi desligado para funcionário em 12/09/2026. A cobrança é uma
 * exceção estreita, e o que este teste protege é justamente a estreiteza:
 * desligada até alguém ligar, uma vez por semana, texto fixo, nada que a
 * barreira de segurança recusaria se viesse de um modelo.
 */
import {
  cobrancaLigada, deveRodar, diaDaCobranca, textoDaCobranca, textoDoRecebido,
  descrever, MAX_ITENS_NA_MENSAGEM, pausa, PAUSA_MIN_MS, PAUSA_MAX_MS,
} from '../src/cobranca-documentos.js'
import { proibidoEm } from '../src/resposta-segura.js'

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

// 21/09/2026 é segunda. 10h em Brasília = 13h UTC.
const SEGUNDA_10H = new Date('2026-09-21T13:00:00Z')
const SEGUNDA_20H = new Date('2026-09-21T23:00:00Z')
const TERCA_10H = new Date('2026-09-22T13:00:00Z')
const LIGADO = { COBRAR_DOCUMENTOS: 'on' }

// ── Desligada até alguém ligar ─────────────────────────────────────────
ok('sem configuração, está desligada', !cobrancaLigada({}))
ok('qualquer valor que não seja "on" mantém desligada', !cobrancaLigada({ COBRAR_DOCUMENTOS: 'sim' }))
ok('desligada não roda nem no dia certo', !deveRodar({ agora: SEGUNDA_10H, env: {} }).rodar)

// ── Uma vez por semana, em horário comercial ───────────────────────────
ok('segunda às 10h, ligada: roda', deveRodar({ agora: SEGUNDA_10H, env: LIGADO }).rodar)
ok('segunda às 20h: não roda (fora do horário)', !deveRodar({ agora: SEGUNDA_20H, env: LIGADO }).rodar)
ok('terça: não roda (não é o dia)', !deveRodar({ agora: TERCA_10H, env: LIGADO }).rodar)
ok('o dia é configurável', deveRodar({ agora: TERCA_10H, env: { ...LIGADO, COBRANCA_DIA: 'ter' } }).rodar)
ok('dia inválido cai na segunda', diaDaCobranca({ COBRANCA_DIA: 'xyz' }) === 'Mon')

// ── O texto ────────────────────────────────────────────────────────────
const itens = [
  { rotulo: 'RG', motivo: 'FALTANDO' },
  { rotulo: 'Comprovante de residência', motivo: 'FALTANDO' },
  { rotulo: 'CNH', motivo: 'VENCENDO', dias: 15 },
]
const t = textoDaCobranca('Moisés', itens)
ok('chama pelo nome', t.startsWith('oi Moisés'))
ok('diz o nome do documento, não a chave do banco', t.includes('Comprovante de residência') && !t.includes('COMP_RESIDENCIA'))
ok('diz o prazo do que vence', t.includes('vence em 15 dias'))
ok('diz como resolver', t.includes('foto por aqui'))

// Texto fixo, mas passa pela MESMA barreira das respostas do modelo. Se um
// dia alguém escrever valor ou link aqui, este teste pega antes do WhatsApp.
ok('nada que a barreira de segurança recusaria', proibidoEm(t).length === 0)
ok('sem link', !/https?:|www\./.test(t))

const muitos = Array.from({ length: 7 }, (_, i) => ({ rotulo: `Doc ${i}`, motivo: 'FALTANDO' }))
const tm = textoDaCobranca('Ana', muitos)
ok(`não vira uma parede: até ${MAX_ITENS_NA_MENSAGEM}, e "mais N"`, tm.includes('Doc 3') && !tm.includes('Doc 4') && tm.includes('mais 3 documentos'))

ok('sem nome, não inventa um', textoDaCobranca('', itens).startsWith('oi, aqui'))

ok('venceu', descrever({ rotulo: 'ASO', motivo: 'VENCIDO', dias: -3 }) === 'ASO, que venceu')
ok('vence hoje', descrever({ rotulo: 'ASO', motivo: 'VENCENDO', dias: 0 }) === 'ASO, que vence hoje')
ok('singular', descrever({ rotulo: 'ASO', motivo: 'VENCENDO', dias: 1 }) === 'ASO, que vence em 1 dia')

// ── A resposta a quem mandou a foto ────────────────────────────────────
ok('recebido com pendência restante', textoDoRecebido('RG', ['CPF']) === 'recebi RG, obrigada. ainda falta: CPF')
ok('recebido e tudo em dia', textoDoRecebido('RG', []) === 'recebi RG, obrigada. sua ficha tá em dia')
ok('resposta também passa na barreira', proibidoEm(textoDoRecebido('RG', ['CPF', 'PIS / NIT'])).length === 0)

// ── Conta-gotas ────────────────────────────────────────────────────────
//
// Baileys não é oficial. Rajada de mensagens é o que o WhatsApp lê como
// disparo em massa, e o número banido é o mesmo dos candidatos.
const pausas = Array.from({ length: 50 }, pausa)
ok('a pausa entre mensagens nunca é curta', pausas.every(p => p >= PAUSA_MIN_MS && p < PAUSA_MAX_MS))
ok('e varia — intervalo fixo também parece robô', new Set(pausas).size > 1)

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
