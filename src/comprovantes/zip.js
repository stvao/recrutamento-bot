/**
 * Comprovantes — leitor de zip, o mínimo para abrir a conversa exportada do
 * WhatsApp.
 *
 * Parte do módulo de comprovantes (ver `entrada.js` para a visão geral).
 *
 * Por que escrito à mão, e não uma biblioteca: o robô tem quatro
 * dependências, e cada uma a mais é uma peça para atualizar e uma porta para
 * código de fora. O que se precisa aqui é pouco — listar as entradas e ler
 * uma de cada vez — e o Node já traz a descompressão.
 *
 * O ZIP É DADO DE FORA, e é tratado assim:
 *
 *  - nada é extraído para o disco. Cada arquivo é lido para a memória só na
 *    hora de usar, e quem grava em disco depois escolhe o próprio nome;
 *  - o nome que vem no zip nunca vira caminho. Quem procura um arquivo usa
 *    só o último pedaço do nome (`base`), e é por ele que se compara;
 *  - o tamanho é conferido ANTES de descomprimir, e de novo durante: um zip
 *    pode declarar 1 MB e inflar para gigabytes.
 *
 * O arquivo é lido por partes (não cabe supor que um zip de fotos de dois
 * meses caiba na memória). Entrada cifrada ou com compressão que não seja
 * "guardada" ou "deflate" é ignorada — o WhatsApp não gera nenhuma das duas.
 */
import { openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

/** Mais entradas que isto não é uma conversa exportada. */
const MAX_ENTRADAS = 50000

const ASSINATURA_FIM = 0x06054b50
const ASSINATURA_FIM_64 = 0x06064b50
const ASSINATURA_LOCALIZADOR_64 = 0x07064b50
const ASSINATURA_CENTRAL = 0x02014b50
const ASSINATURA_LOCAL = 0x04034b50

function lerPedaco(fd, posicao, tamanho) {
  const b = Buffer.alloc(tamanho)
  let lidos = 0
  while (lidos < tamanho) {
    const n = readSync(fd, b, lidos, tamanho - lidos, posicao + lidos)
    if (n <= 0) break
    lidos += n
  }
  return lidos === tamanho ? b : b.subarray(0, lidos)
}

/** O último pedaço do nome, sem pasta nenhuma — venha com `/` ou com `\`. */
export function nomeBase(nome) {
  return String(nome ?? '').split(/[\\/]/).pop().normalize('NFC')
}

/**
 * Abre um zip e lista o que tem dentro.
 *
 * Devolve `{ entradas, ler(entrada, maximo), fechar() }`. Lança se o arquivo
 * não é um zip legível — quem chama transforma isso em mensagem para a
 * pessoa.
 */
export function abrirZip(caminho) {
  const fd = openSync(caminho, 'r')
  try {
    const total = fstatSync(fd).size

    // O registro de fim fica nos últimos bytes; pode haver um comentário de
    // até 64 KB depois dele.
    const cauda = lerPedaco(fd, Math.max(0, total - 65557), Math.min(total, 65557))
    let fim = -1
    for (let i = cauda.length - 22; i >= 0; i--) {
      if (cauda.readUInt32LE(i) === ASSINATURA_FIM) { fim = i; break }
    }
    if (fim < 0) throw new Error('não é um arquivo zip')

    let quantas = cauda.readUInt16LE(fim + 10)
    let tamanhoCentral = cauda.readUInt32LE(fim + 12)
    let inicioCentral = cauda.readUInt32LE(fim + 16)

    // Zip grande (mais de 4 GB ou de 65 mil arquivos): os números de verdade
    // estão no registro de 64 bits.
    if (quantas === 0xffff || tamanhoCentral === 0xffffffff || inicioCentral === 0xffffffff) {
      const posLocalizador = Math.max(0, total - 65557) + fim - 20
      const loc = posLocalizador >= 0 ? lerPedaco(fd, posLocalizador, 20) : Buffer.alloc(0)
      if (loc.length < 20 || loc.readUInt32LE(0) !== ASSINATURA_LOCALIZADOR_64) throw new Error('zip grande demais para ler')
      const fim64 = lerPedaco(fd, Number(loc.readBigUInt64LE(8)), 56)
      if (fim64.length < 56 || fim64.readUInt32LE(0) !== ASSINATURA_FIM_64) throw new Error('zip grande demais para ler')
      quantas = Number(fim64.readBigUInt64LE(32))
      tamanhoCentral = Number(fim64.readBigUInt64LE(40))
      inicioCentral = Number(fim64.readBigUInt64LE(48))
    }

    if (quantas > MAX_ENTRADAS) throw new Error('zip com arquivos demais')
    if (inicioCentral + tamanhoCentral > total || tamanhoCentral > 64 * 1024 * 1024) throw new Error('zip corrompido')

    const central = lerPedaco(fd, inicioCentral, tamanhoCentral)
    const entradas = []
    let p = 0
    for (let i = 0; i < quantas && p + 46 <= central.length; i++) {
      if (central.readUInt32LE(p) !== ASSINATURA_CENTRAL) break
      const marcas = central.readUInt16LE(p + 8)
      const metodo = central.readUInt16LE(p + 10)
      let comprimido = central.readUInt32LE(p + 20)
      let tamanho = central.readUInt32LE(p + 24)
      const tamNome = central.readUInt16LE(p + 28)
      const tamExtra = central.readUInt16LE(p + 30)
      const tamComentario = central.readUInt16LE(p + 32)
      let posicao = central.readUInt32LE(p + 42)
      const nome = central.subarray(p + 46, p + 46 + tamNome).toString('utf8')

      // Campo extra de 64 bits: traz, nesta ordem, só os números que não
      // couberam nos 32 bits de cima.
      let e = p + 46 + tamNome
      const fimExtra = e + tamExtra
      while (e + 4 <= fimExtra) {
        const id = central.readUInt16LE(e)
        const tam = central.readUInt16LE(e + 2)
        if (id === 0x0001) {
          let q = e + 4
          if (tamanho === 0xffffffff && q + 8 <= fimExtra) { tamanho = Number(central.readBigUInt64LE(q)); q += 8 }
          if (comprimido === 0xffffffff && q + 8 <= fimExtra) { comprimido = Number(central.readBigUInt64LE(q)); q += 8 }
          if (posicao === 0xffffffff && q + 8 <= fimExtra) { posicao = Number(central.readBigUInt64LE(q)) }
        }
        e += 4 + tam
      }

      const ehPasta = nome.endsWith('/') || nome.endsWith('\\')
      const cifrado = (marcas & 1) === 1
      if (!ehPasta && !cifrado && (metodo === 0 || metodo === 8)) {
        entradas.push({ nome, base: nomeBase(nome), tamanho, comprimido, metodo, posicao })
      }
      p += 46 + tamNome + tamExtra + tamComentario
    }

    return {
      entradas,
      /**
       * O conteúdo de uma entrada. `maximo` é o maior tamanho aceito, já
       * descomprimido; passou disso, lança `grande-demais` sem ler.
       */
      ler(entrada, maximo) {
        if (entrada.tamanho > maximo || entrada.comprimido > maximo * 2 + 1024) throw new Error('grande-demais')
        const cabeca = lerPedaco(fd, entrada.posicao, 30)
        if (cabeca.length < 30 || cabeca.readUInt32LE(0) !== ASSINATURA_LOCAL) throw new Error('zip corrompido')
        const inicio = entrada.posicao + 30 + cabeca.readUInt16LE(26) + cabeca.readUInt16LE(28)
        if (inicio + entrada.comprimido > total) throw new Error('zip corrompido')
        const bruto = lerPedaco(fd, inicio, entrada.comprimido)
        if (entrada.metodo === 0) return bruto
        try {
          // O limite vale DURANTE a descompressão: o tamanho declarado no zip
          // é só o que o zip diz de si mesmo.
          return inflateRawSync(bruto, { maxOutputLength: maximo })
        } catch (e) {
          throw new Error(e.code === 'ERR_BUFFER_TOO_LARGE' ? 'grande-demais' : 'zip corrompido')
        }
      },
      fechar() {
        try { closeSync(fd) } catch { /* já fechado */ }
      },
    }
  } catch (e) {
    try { closeSync(fd) } catch { /* nada a fazer */ }
    throw e
  }
}
