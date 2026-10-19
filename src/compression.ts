import { rm } from 'node:fs/promises'

export type Encoding = 'br' | 'gzip'
export interface EncodedAsset {
  file: string
  etag: string
  size: number
}
export type Encodings = Partial<Record<Encoding, EncodedAsset>>

/** Returns undefined only when every available representation is forbidden. */
export function selectEncoding(
  header: string | null,
  available: readonly Encoding[],
): Encoding | 'identity' | undefined {
  if (!header?.trim()) return 'identity'
  const qualities = new Map<string, number>()
  for (const item of header.split(',')) {
    const [name, ...parameters] = item.trim().toLowerCase().split(';')
    const quality = parameters
      .map((p) => p.trim())
      .find((p) => p.startsWith('q='))
      ?.slice(2)
    const q =
      quality === undefined
        ? 1
        : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(quality)
          ? Number(quality)
          : 0
    qualities.set(name.trim(), Math.min(qualities.get(name.trim()) ?? 1, q))
  }
  const wildcard = qualities.get('*')
  const candidates: Array<[Encoding | 'identity', number]> = available.map((encoding) => [
    encoding,
    qualities.get(encoding) ?? wildcard ?? 0,
  ])
  candidates.push(['identity', qualities.get('identity') ?? (wildcard === 0 ? 0 : 0.001)])
  candidates.sort((a, b) => b[1] - a[1])
  return candidates[0]?.[1] > 0 ? candidates[0][0] : undefined
}

/** Streams build-time compression through Bun's native Web CompressionStream. */
export async function compressAsset(path: string, serverDir: URL): Promise<Encodings> {
  const input = Bun.file(path)
  const result: Encodings = {}
  const sourceHasher = new Bun.CryptoHasher('sha256')
  for await (const chunk of input.stream()) sourceHasher.update(chunk)
  const id = sourceHasher.digest('hex')
  for (const encoding of ['br', 'gzip'] as const) {
    const relative = `bun-compressed/${id}.${encoding === 'br' ? 'br' : 'gz'}`
    const target = new URL(relative, serverDir)
    // Bun supports Brotli here; TypeScript's DOM union only lists web-standard formats.
    const stream = input
      .stream()
      .pipeThrough(
        new CompressionStream(encoding === 'br' ? ('brotli' as CompressionFormat) : 'gzip'),
      )
    await Bun.write(target, new Response(stream))
    const compressed = Bun.file(target)
    if (compressed.size >= input.size) {
      await rm(target)
      continue
    }
    const hasher = new Bun.CryptoHasher('sha256')
    for await (const chunk of compressed.stream()) hasher.update(chunk)
    result[encoding] = { file: relative, etag: `"${hasher.digest('hex')}"`, size: compressed.size }
  }
  return result
}
