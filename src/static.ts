import { selectEncoding, type Encodings, type Encoding } from './compression.js'
export interface AssetManifest {
  client: string
  base: string
  trailingSlash: 'always' | 'never' | 'ignore'
  assets: Record<string, { file: string; headers: Record<string, string>; encodings?: Encodings }>
}

export function createStaticHandler(manifest: AssetManifest, manifestURL: URL) {
  const root = new URL(manifest.client, manifestURL)
  const assets = new Map(Object.entries(manifest.assets))
  return (request: Request): Response | undefined => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return
    const url = new URL(request.url)
    const asset = assets.get(url.pathname)
    if (!asset) return
    const isPage = asset.file.endsWith('.html') && !url.pathname.endsWith('.html')
    if (isPage && url.pathname !== '/') {
      const slash = url.pathname.endsWith('/')
      if (
        (manifest.trailingSlash === 'always' && !slash) ||
        (manifest.trailingSlash === 'never' && slash)
      ) {
        const path = slash ? url.pathname.slice(0, -1) : url.pathname + '/'
        return new Response(null, {
          status: 308,
          headers: { location: path + url.search },
        })
      }
    }
    const headers = new Headers(asset.headers)
    const available = asset.encodings ? (Object.keys(asset.encodings) as Encoding[]) : []
    const transformAllowed = !/(?:^|,)\s*no-transform(?:\s*,|\s*$)/i.test(
      headers.get('cache-control') ?? '',
    )
    const acceptsIdentity =
      selectEncoding(request.headers.get('accept-encoding'), []) === 'identity'
    const encoding =
      request.headers.has('range') && acceptsIdentity
        ? 'identity'
        : selectEncoding(request.headers.get('accept-encoding'), transformAllowed ? available : [])
    if (available.length) {
      const vary = headers.get('vary')
      if (
        vary !== '*' &&
        !vary
          ?.toLowerCase()
          .split(',')
          .map((value) => value.trim())
          .includes('accept-encoding')
      )
        headers.set('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding')
    }
    if (!encoding) return new Response(null, { status: 406, headers: { vary: 'Accept-Encoding' } })
    const variant = encoding === 'identity' ? undefined : asset.encodings?.[encoding]
    if (variant) {
      headers.set('content-encoding', encoding)
      headers.set('etag', variant.etag)
      headers.set('content-length', String(variant.size))
    }
    const etag = headers.get('etag')
    const matches = request.headers
      .get('if-none-match')
      ?.split(',')
      .some((value) => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)
    if (matches) return new Response(null, { status: 304, headers })
    const file = Bun.file(
      variant
        ? new URL(variant.file, manifestURL)
        : new URL(asset.file.split('/').map(encodeURIComponent).join('/'), root),
    )
    if (!headers.has('content-length')) headers.set('content-length', String(file.size))
    return new Response(request.method === 'HEAD' ? null : file, { headers })
  }
}
