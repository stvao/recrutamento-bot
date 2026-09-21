/**
 * Documento do candidato: currículo, carteira de trabalho, CPF e RG.
 *
 * Regra do dono (13/09/2026): CPF é o cadastro único no RH e pode ser pedido;
 * é opcional — quem não quiser mandar segue normalmente. Antes, o arquivo
 * recebia "consigo ler só texto" e era jogado fora.
 */
import { readFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.ESTADO_ARQUIVO = join(mkdtempSync(join(tmpdir(), 'documento-')), 'conversas.json')

const { cpfValido, conferirLeitura } = await import('../src/ia-documento.js')
const { oQueJaSabe } = await import('../src/atendimento.js')
const { semDocumento } = await import('../src/observacao.js')
const { _corpoDaCandidatura } = await import('../src/rh-client.js')

let falhas = 0
function ok(nome, condicao) {
  if (condicao) console.log(`ok  ${nome}`)
  else { falhas++; console.log(`FALHOU ${nome}`) }
}

// ── CPF ────────────────────────────────────────────────────────────────
ok('CPF válido com máscara', cpfValido('529.982.247-25'))
ok('CPF válido só números', cpfValido('52998224725'))
ok('dígito errado não vale', !cpfValido('52998224724'))
ok('todos iguais não vale', !cpfValido('11111111111'))
ok('curto não vale', !cpfValido('1234'))

// ── O que o modelo leu é conferido ─────────────────────────────────────
{
  const r = conferirLeitura({ tipo: 'rg', nome: 'Fulano de Tal', cpf: '529.982.247-24', rg: '12.345.678-9', resumo: '', confianca: 'alta' })
  ok('CPF lido errado vira null', r.cpf === null)
  ok('RG lido fica', r.rg === '12.345.678-9')
  ok('resumo vazio vira null', r.resumo === null)
  ok('tipo inventado vira outro', conferirLeitura({ tipo: 'boleto' }).tipo === 'outro')
  ok('lixo não quebra', conferirLeitura('x') === null)
  ok('RG que é frase não vale', conferirLeitura({ rg: 'não tenho rg' }).rg === null)
}

// ── A conversa: opcional, uma vez, sem vazar o número ──────────────────
{
  const base = { vaga: 'Pedreiro', cidadeMora: 'Bastos', cidade: 'Bastos', nome: 'João Silva', temExperiencia: true }
  const pede = oQueJaSabe(base)
  ok('com o nome, o CPF entra como opcional', pede.opcional.length === 1 && /OPCIONAL/.test(pede.texto))
  ok('  e não entra no que falta (não trava a ficha)', !pede.falta.some(x => /CPF/.test(x)))
  ok('sem o nome ainda, não pede CPF', oQueJaSabe({ vaga: 'Pedreiro' }).opcional.length === 0)

  const deu = oQueJaSabe({ ...base, cpf: '52998224725' })
  ok('CPF informado: sabido', deu.sabido.includes('CPF: já informado'))
  ok('  e o número NÃO vai para o modelo', !deu.texto.includes('52998224725'))
  ok('  e não pede de novo', deu.opcional.length === 0)

  const naoQuis = oQueJaSabe({ ...base, recusouDocumentos: true })
  ok('não quis: não pede de novo', naoQuis.opcional.length === 0 && /NÃO peça de novo/.test(naoQuis.texto))
}

// ── Vai para o RH ──────────────────────────────────────────────────────
{
  const corpo = _corpoDaCandidatura({ nomeCompleto: 'João Silva', cpf: '52998224725', rg: '12.345.678-9' })
  ok('a ficha leva o CPF', corpo.cpf === '52998224725')
  ok('a ficha leva o RG', corpo.rg === '12.345.678-9')
}

// ── A observação não guarda o número ───────────────────────────────────
ok('CPF some da observação', semDocumento('meu cpf é 529.982.247-25') === 'meu cpf é [cpf]')
ok('CPF sem máscara também', semDocumento('52998224725') === '[cpf]')
ok('RG some da observação', semDocumento('rg 12.345.678-9') === 'rg [rg]')
ok('texto comum fica igual', semDocumento('sou pedreiro há 8 anos, salário 3500') === 'sou pedreiro há 8 anos, salário 3500')

// ── A ligação ──────────────────────────────────────────────────────────
{
  const aqui = dirname(fileURLToPath(import.meta.url))
  const sv = readFileSync(join(aqui, '..', 'src', 'server.js'), 'utf8')
  const bl = readFileSync(join(aqui, '..', 'src', 'baileys.js'), 'utf8')
  const ia = readFileSync(join(aqui, '..', 'src', 'ia.js'), 'utf8')
  const at = readFileSync(join(aqui, '..', 'src', 'atendimento.js'), 'utf8')
  ok('arquivo não recebe mais "consigo ler só texto"', !/'Recebi seu arquivo/.test(sv))
  ok('arquivo do candidato é anexado', /return receberDocumento\(msg\)/.test(sv))
  // Funcionário mandando documento. Este teste exigia a linha literal
  // `return null` — e com ela travava o defeito: o robô é calado com
  // funcionário (decisão do dono, 12/09/2026), mas o `return null` também
  // JOGAVA A FOTO FORA, sem arquivar nem avisar ninguém. A pessoa mandava o
  // RG e a empresa nunca sabia.
  //
  // O que se protege agora é a intenção, e não o mecanismo: calado com o
  // funcionário enquanto a cobrança estiver desligada, e o documento
  // arquivado e avisado sempre.
  ok('funcionário mandando documento: vai para o caminho próprio',
    /ficha\?\.tipo === 'funcionario'\) return receberDocumentoDeFuncionario\(msg, \{ calado \}\)/.test(sv))
  ok('funcionário mandando documento: calado com a cobrança desligada',
    /!cobranca\.cobrancaLigada\(\)\) return null/.test(sv))
  ok('funcionário mandando documento: arquivado, e não jogado fora',
    /arquivarDocumentoFuncionario\(\{/.test(sv))
  ok('funcionário mandando documento: o RH fica sabendo',
    /async function receberDocumentoDeFuncionario[\s\S]*?avisarRH\(/.test(sv))
  ok('documento guardado vai depois da ficha', /mandarDocumentosGuardados\(from\)/.test(sv))
  ok('o arquivo do privado é baixado com o recrutamento ligado', /gastos\.autorizado\(de, false\) \|\| recrutamentoLigado\(\)/.test(bl))
  ok('a IA pede CPF uma vez, como opcional', /peça UMA vez o CPF e o RG/.test(ia) && /não é obrigatório/.test(ia))
  ok('a IA não pede PIS nem conta', /Não peça PIS,\s+conta bancária/.test(ia))
  ok('CPF só vale com dígito certo', /cpfValido\(saida\.cpf\)/.test(at))
  ok('nenhum \\b virou backspace', ![sv, bl, ia, at].some(t => t.includes(String.fromCharCode(8))))
}

console.log(falhas ? `\n${falhas} falharam.` : '\nTodos passaram.')
process.exit(falhas ? 1 : 0)
