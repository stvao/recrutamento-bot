/**
 * Maria Vitória — a conversa escrita por modelo de linguagem.
 *
 * O robô de roteiro entende o que a pessoa diz, mas responde sempre igual.
 * Aqui o modelo escreve a conversa na hora: entende parágrafo, pergunta fora
 * do roteiro e o jeito de falar de obra.
 *
 * A divisão de responsabilidade é o ponto todo desta camada:
 *
 *   O MODELO decide o que dizer e como dizer.
 *   O CÓDIGO é dono dos fatos e do que fica gravado.
 *
 * Salário, alojamento e jornada entram prontos no texto, vindos do banco.
 * O modelo nunca calcula nem lembra um valor — acabamos de tirar o salário
 * do código justamente para não ficar desatualizado, e deixar um modelo
 * chutar o número seria desfazer isso e piorar: vira promessa escrita,
 * imprevisível, no WhatsApp de um candidato, num contexto onde o que se
 * escreve vira prova.
 *
 * O que ele extrai (vaga, cidade) é CONFERIDO contra a lista real antes de
 * valer. Modelo que inventa uma vaga não cria vaga nenhuma.
 *
 * Privacidade: o telefone nunca é enviado. A conversa coleta nome, vaga,
 * cidade e experiência — não coleta CPF nem RG (isso é do formulário, que
 * não passa por aqui).
 */
import { tetoDe, AUXILIO_TRANSPORTE_ESTAGIO } from './catalogo.js'

const CHAVE = process.env.GEMINI_API_KEY || ''

/** Nome da empresa, como a Maria Vitória se apresenta. */
const EMPRESA = process.env.EMPRESA_NOME || 'KE Engenharia'
const MODELO = process.env.IA_MODELO || 'gemini-flash-lite-latest'

/**
 * Endereço do modelo.
 *
 * Configurável para trocar o Gemini por um modelo rodando na máquina de
 * casa (Ollama) sem mexer em código — só numa linha do .env.
 */
const ENDPOINT = process.env.IA_ENDPOINT
  || `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`

/**
 * Quanto esperar por resposta, e quantas vezes tentar.
 *
 * Medido contra o Gemini: a resposta típica leva ~1 segundo, mas cerca de
 * uma em cada cinco trava e passa de 8s. Esperar mais não resolve — a
 * requisição travada não volta. Tentar de novo resolve, e custa pouco:
 * 4 segundos e uma segunda tentativa cobrem o caso normal e o travado
 * dentro do tempo que uma pessoa aceita esperar num WhatsApp.
 */
const PRAZO_MS = Number(process.env.IA_PRAZO_MS || 4000)
const TENTATIVAS = Number(process.env.IA_TENTATIVAS || 2)

export function iaDisponivel() {
  return Boolean(CHAVE)
}

/**
 * Quem ela é.
 *
 * Escrito na segunda pessoa e em português de obra de propósito: o modelo
 * imita o registro do texto que recebe, e um prompt corporativo produz
 * resposta corporativa.
 */
function instrucoes(fatos, conhecido = '') {
  return `Você é Maria Vitória, do RH da ${EMPRESA}, uma construtora que reforma
escolas estaduais no interior e no litoral de São Paulo. Você conversa por
WhatsApp com pessoas interessadas nas vagas.

COMO VOCÊ FALA — esta é a parte que mais importa

Copie o jeito de quem já atende este WhatsApp. São mensagens assim, de
verdade, tiradas das conversas reais:

  "bom dia"
  "qual cidade vc mora?"
  "tem disponibilidade para ficar em alojamento?"
  "nossas obras não são perto de barretos"
  "pereiras é a cidade mais proxima"
  "vou pedir para o rapaz te ligar"
  "se tiver interesse me avisa"

O que sai daí, e você segue à risca:
- CURTO. Quase toda mensagem tem menos de 100 caracteres. Uma ou duas linhas,
  no máximo.
- NENHUM emoji. Nenhum mesmo.
- NUNCA comece com "Maravilha!", "Legal!", "Certinho!", "Perfeito!", "Que
  bom!", "Bacana!", "Show!". Isso entrega que é robô na primeira frase.
- Não fique repetindo o nome da pessoa. No máximo uma vez, quando ajudar.
- Uma pergunta por vez, direta: "qual cidade vc mora?" — e não "Me conta:
  qual é a cidade onde você mora hoje?".
- Pode escrever como se fala: "vc", "pra", "tá", "aí". Erro de digitação
  acontece e não tem problema.
- Não se anuncie, não explique o que você vai fazer, não faça resumo do que a
  pessoa disse antes de responder. Responda ou pergunte, e pronto.
- A maioria dos candidatos é de obra: pedreiro, servente, carpinteiro. Muitos
  escrevem com erro, tudo em maiúscula, ou mandam áudio transcrito torto.
  Entenda sem corrigir e sem comentar o erro.
- Nada de "prezado", "estou à disposição", "conforme mencionado". Nada de
  marcadores nem de listas. É conversa de WhatsApp.

O QUE VOCÊ PRECISA DESCOBRIR, nesta ordem, sem parecer formulário.
As quatro primeiras são as essenciais — com elas o RH já consegue trabalhar:

1. Qual vaga interessa
2. EM QUAL CIDADE A PESSOA MORA — esta é a que mais decide, e é a primeira
   que quem atende hoje faz. Ajudante a empresa só contrata na cidade da
   obra; se a pessoa mora longe e quer ajudante, diga isso logo, antes de
   perguntar qualquer outra coisa, para ela não perder tempo.
3. Para PEDREIRO que mora longe: se tem disponibilidade de ficar em
   alojamento (só pedreiro fica alojado, e só em Bastos e Pereiras)
4. O nome completo
5. Se tem experiência na função, e quanto tempo

Depois dessas, continue a conversa para completar a ficha. Pergunte de duas
em duas, no máximo, e vá conversando — não despeje tudo de uma vez:

5. Se já teve registro em carteira NESTA função
6. Onde mora: bairro e cidade (e o CEP, se souber de cabeça)
7. Data de nascimento
8. Quando pode começar
9. Se aceita trabalhar em obra de outra cidade
10. Tamanho de camisa e de bota (é para separar o uniforme e o EPI)
11. Um contato de recado: nome e telefone de alguém

Se a pessoa já contou alguma dessas coisas, NÃO pergunte de novo.

Se ela demonstrar pressa, cansaço ou disser que responde depois, PARE de
perguntar e encerre com gentileza. O essencial já está registrado — insistir
só faz a pessoa sumir.

Ter EXPERIÊNCIA e ter REGISTRO EM CARTEIRA são coisas diferentes. Muita gente
da obra trabalhou anos sem registro. Pergunte as duas, separadamente.

A cada resposta sua, preencha os campos com TUDO que você já sabe da conversa
inteira — não só o que a pessoa acabou de falar. Campo em branco quer dizer
"ainda não sei", e some com o que já tinha sido dito.

REGRAS QUE VOCÊ NÃO QUEBRA
- Só fale de salário, alojamento, jornada e vagas usando os FATOS abaixo.
  Se a informação não estiver ali, diga que vai confirmar com a equipe.
  NUNCA estime, arredonde ou lembre um valor de memória.
- Não prometa contratação, data de início, aumento nem benefício que não
  esteja nos fatos.
- Não peça CPF, RG, PIS, conta bancária nem foto de documento. Isso é feito
  depois, pessoalmente.
- NUNCA diga quando o registro em carteira é feito, nem que alguém começa
  sem registro. Se perguntarem se é registrado desde o primeiro dia, diga
  que isso a pessoa combina direto com o responsável quando ele ligar — não
  precisa chamar ninguém. Se misturarem registro com benefício
  (seguro-desemprego, Bolsa Família, BPC, auxílio), diga que o responsável
  conversa com ela e marque precisaHumano. O que você escreve fica no
  celular da pessoa.
- A pessoa escolhe a cidade onde prefere trabalhar: todas estão contratando.
  Quem não precisa de alojamento pode trabalhar numa cidade sem alojamento.
  Confirme a cidade, mas NUNCA prometa a vaga.
- Estágio: são a bolsa e o auxílio-transporte que estão nos FATOS. Nada
  além disso se promete: outro benefício, o responsável combina na
  entrevista.
- Não mande link nenhum. A ficha você mesma preenche aqui, na conversa.
- Salário acima do inicial NUNCA é promessa: diga que depende da
  experiência comprovada e que quem define é o responsável na entrevista.
- Você não precisa se anunciar como assistente. Fale normalmente, como a
  Maria Vitória do RH.
- Se a pessoa perguntar se você é um robô, uma IA ou um sistema, NÃO diga que
  é nem que não é. Desconverse com naturalidade e chame alguém da equipe:
  algo como "deixa eu chamar aqui um colega meu pra falar com você, só um
  minutinho". E marque perguntouSeEhIA = true.
- Se estiver com raiva, se for assunto que não é vaga, ou se pedir algo que
  você não pode resolver, passe para uma pessoa da equipe (precisaHumano).

FATOS DE HOJE (a única fonte de verdade):
${fatos}${conhecido ? `

${conhecido}` : ''}`
}

/** Os fatos que o modelo pode usar, montados a partir do banco. */
export function montarFatos({ vagas, cidades, jornada }) {
  const reais = (n) => `R$ ${n.toFixed(2).replace('.', ',')}`
  const linhasVagas = vagas.map(v => {
    const salario = typeof v.salario === 'number' ? reais(v.salario) : 'a combinar conforme experiência'
    const teto = typeof v.salario === 'number' ? tetoDe(v.nome) : null
    const faixa = teto
      ? ` para quem NÃO tem experiência comprovada; ${reais(teto)} para quem tem experiência COMPROVADA EM CARTEIRA`
      : ''
    const exp = v.profissional ? ' (exige experiência na função)' : ' (não precisa de experiência)'
    return `- ${v.nome}: ${salario}${faixa}${exp}`
  }).join('\n')

  const linhasCidades = cidades.map(c =>
    `- ${c.nome}: ${c.alojamento ? 'tem alojamento' : 'NÃO tem alojamento'}`,
  ).join('\n')

  // Informado pelo dono em 10/09/2026. O que muda com frequência (vagas,
  // salários, cidades, alojamento) vem do RH; isto aqui é política da empresa.
  return `VAGAS ABERTAS E SALÁRIOS:
${linhasVagas}

CIDADES COM OBRA (todas estão contratando):
${linhasCidades}

ALOJAMENTO: só nas cidades marcadas acima, e SÓ PARA PEDREIRO. Ajudante
(servente) a empresa contrata quem MORA na cidade da obra — se a pessoa quer
vaga de ajudante em cidade onde não mora, diga isso antes de qualquer outra
coisa, para ela não viajar à toa.

JORNADA: ${jornada}

FORMAS DE CONTRATAÇÃO: carteira assinada (CLT), diária ou empreita. O formato
é combinado com o responsável na entrevista.
VALE-TRANSPORTE: a partir do primeiro dia de trabalho. Não é adiantado: a
pessoa começa e, chegando na obra, o RH envia o vale.
ALIMENTAÇÃO: almoço na obra. Quem fica no alojamento tem também café da
manhã e janta.
PAGAMENTO: salário no 5º dia útil do mês; vale (adiantamento) no dia 20.
IDADE MÍNIMA: 18 anos.
ESTÁGIO: é preciso estar cursando engenharia, arquitetura ou curso ligado a
obras. O valor da vaga de estágio é BOLSA, não salário, e vem com auxílio-transporte
de ${reais(AUXILIO_TRANSPORTE_ESTAGIO)}. Outros detalhes do estágio: o responsável
combina na entrevista.
CIDADE: a pessoa escolhe onde prefere trabalhar; todas estão contratando.
COMO FUNCIONA: a conversa é aqui pelo WhatsApp, e você mesma preenche a ficha
com a pessoa. Depois o responsável liga, e aí vem a entrevista.`
}

/**
 * O formato exato da resposta.
 *
 * TODOS os campos são obrigatórios de propósito. Com só `resposta` exigida,
 * o modelo preenchia o resto quando lembrava: a conversa ia até o fim, a
 * pessoa dizia o nome, e o campo voltava vazio — a candidatura nunca era
 * gravada. Campo obrigatório força ele a considerar cada um a cada turno.
 *
 * Vazio significa "ainda não sei", e é por isso que o texto de cada campo
 * manda REPETIR o que já foi dito antes: o modelo tende a devolver só a
 * novidade do último turno e apagar o resto.
 */
const ESQUEMA = {
  type: 'object',
  properties: {
    resposta:       { type: 'string', description: 'A mensagem para o candidato' },
    vaga:           { type: 'string', description: 'Nome EXATO da vaga, copiado da lista de vagas. Repita em toda resposta depois que souber. Vazio se ainda não sabe.' },
    cidade:         { type: 'string', description: 'Nome EXATO da cidade, copiado da lista. Repita em toda resposta depois que souber. Vazio se ainda não sabe.' },
    temExperiencia: { type: 'string', enum: ['sim', 'nao', 'nao_sei'], description: 'A pessoa JÁ TRABALHOU na função? Repita depois que souber.' },
    temRegistro:    { type: 'string', enum: ['sim', 'nao', 'nao_sei'], description: 'A pessoa já teve CARTEIRA ASSINADA nesta função? É diferente de ter experiência. Repita depois que souber.' },
    nomeCompleto:   { type: 'string', description: 'Nome e sobrenome da pessoa, exatamente como ela escreveu. Repita em toda resposta depois que souber. Vazio se ainda não disse.' },
    resumoExperiencia: { type: 'string', description: 'O que a pessoa contou da experiência dela, em uma frase. Vazio se não contou.' },
    tempoExperiencia: { type: 'string', description: 'Há quanto tempo trabalha na função, como ela falou (ex.: "8 anos"). Vazio se não disse.' },
    bairro:         { type: 'string', description: 'Bairro onde MORA. Vazio se não disse.' },
    cidadeMora:     { type: 'string', description: 'Cidade onde MORA hoje — pode ser diferente da cidade onde quer trabalhar. Vazio se não disse.' },
    cep:            { type: 'string', description: 'CEP, só números. Vazio se não disse.' },
    dataNascimento: { type: 'string', description: 'Data de nascimento no formato DD/MM/AAAA. Vazio se não disse.' },
    disponibilidadeInicio: { type: 'string', description: 'Quando pode começar, como ela falou (ex.: "na segunda", "imediato"). Vazio se não disse.' },
    aceitaOutrasObras: { type: 'string', enum: ['sim', 'nao', 'nao_sei'], description: 'Aceita trabalhar em obra de outra cidade?' },
    tamanhoCamisa:  { type: 'string', description: 'Tamanho da camisa (P, M, G, GG...). Vazio se não disse.' },
    tamanhoBota:    { type: 'string', description: 'Número da bota. Vazio se não disse.' },
    contatoRecadoNome:     { type: 'string', description: 'Nome do contato de recado. Vazio se não disse.' },
    contatoRecadoTelefone: { type: 'string', description: 'Telefone do contato de recado. Vazio se não disse.' },
    precisaHumano:  { type: 'boolean', description: 'true se precisa de uma pessoa da equipe' },
    perguntouSeEhIA: { type: 'boolean', description: 'true se a pessoa perguntou se está falando com robô, IA, sistema ou pessoa' },
  },
  required: ['resposta', 'vaga', 'cidade', 'temExperiencia', 'temRegistro', 'nomeCompleto', 'resumoExperiencia', 'tempoExperiencia', 'bairro', 'cidadeMora', 'cep',
    'dataNascimento', 'disponibilidadeInicio', 'aceitaOutrasObras',
    'tamanhoCamisa', 'tamanhoBota', 'contatoRecadoNome', 'contatoRecadoTelefone',
    'precisaHumano', 'perguntouSeEhIA'],
}

/**
 * Conversa com o modelo.
 *
 * Devolve null em QUALQUER problema — chave ausente, cota estourada, rede
 * fora, resposta estranha. Quem chama trata null como "atende do jeito
 * antigo", então uma falha aqui nunca deixa o candidato sem resposta.
 */
export async function conversar({ historico, fatos, conhecido = '' }) {
  if (!CHAVE) return null

  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
    const r = await umaTentativa({ historico, fatos, conhecido })
    if (r) return r
    if (tentativa < TENTATIVAS) console.warn(`[ia] tentando de novo (${tentativa + 1}/${TENTATIVAS})`)
  }
  return null
}

/**
 * Uma conversa qualquer com o modelo, com instruções e esquema próprios.
 *
 * Existe para o atendimento a FUNCIONÁRIO reusar toda a plumbing que já
 * estava aqui — prazo, tentativa, filtros de segurança, tratamento de cota
 * estourada — sem herdar o prompt da Maria Vitória, que é de recrutamento e
 * fala de salário de vaga. Misturar os dois seria o caminho mais curto para
 * o robô informar um salário a um funcionário.
 *
 * Devolve null em qualquer problema, como o resto deste arquivo.
 */
export async function chamarModelo({ instrucoes: texto, esquema, historico }) {
  if (!CHAVE) return null

  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
    const r = await umaTentativa({ historico, instrucoesProntas: texto, esquemaProprio: esquema })
    if (r) return r
    if (tentativa < TENTATIVAS) console.warn(`[ia] tentando de novo (${tentativa + 1}/${TENTATIVAS})`)
  }
  return null
}

async function umaTentativa({ historico, fatos, conhecido = '', instrucoesProntas, esquemaProprio }) {

  const corpo = {
    systemInstruction: { parts: [{ text: instrucoesProntas ?? instrucoes(fatos, conhecido) }] },
    contents: historico.map(m => ({
      // "candidato" e "pessoa" são quem escreve; o resto é o robô.
      role: (m.de === 'candidato' || m.de === 'pessoa') ? 'user' : 'model',
      parts: [{ text: m.texto }],
    })),
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: esquemaProprio ?? ESQUEMA,
      // Baixa de propósito: aqui não se quer criatividade, se quer uma
      // atendente consistente que não invente condição de trabalho.
      temperature: 0.4,
      maxOutputTokens: 500,
    },
    // O assunto é trabalho e às vezes saúde (atestado, afastamento). Os
    // filtros padrão barram esse tipo de conversa com frequência.
    safetySettings: [
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_DANGEROUS_CONTENT',
    ].map(category => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
  }

  try {
    const controle = new AbortController()
    const prazo = setTimeout(() => controle.abort(), PRAZO_MS)

    const r = await fetch(`${ENDPOINT}?key=${CHAVE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
      signal: controle.signal,
    })
    clearTimeout(prazo)

    if (!r.ok) {
      // 429 é cota do dia estourada — esperado no plano gratuito, e não é
      // erro de programação. Registrar diferente para não virar ruído.
      const nivel = r.status === 429 ? 'cota esgotada' : `HTTP ${r.status}`
      console.warn(`[ia] ${nivel} — atendendo pelo roteiro.`)
      return null
    }

    const j = await r.json()
    const texto = j?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!texto) {
      console.warn('[ia] resposta sem conteúdo — atendendo pelo roteiro.')
      return null
    }

    const dados = JSON.parse(texto)
    if (!dados?.resposta?.trim()) return null
    return dados
  } catch (e) {
    console.warn('[ia] indisponível:', e.name === 'AbortError' ? `demorou mais de ${PRAZO_MS}ms` : e.message)
    return null
  }
}
