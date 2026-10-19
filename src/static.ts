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
    if (!isPublicPath(url.pathname, manifest.base)) return
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
    }
    const etag = headers.get('etag')
    const lastModified = parseHttpDate(headers.get('last-modified'))
    const ifMatch = request.headers.get('if-match')
    if (ifMatch !== null && !matchesIfMatch(ifMatch, etag))
      return new Response(null, { status: 412, headers: validatorHeaders(headers) })
    if (ifMatch === null) {
      const ifUnmodifiedSince = parseHttpDate(request.headers.get('if-unmodified-since'))
      if (
        ifUnmodifiedSince !== undefined &&
        lastModified !== undefined &&
        lastModified > ifUnmodifiedSince
      )
        return new Response(null, { status: 412, headers: validatorHeaders(headers) })
    }
    const ifNoneMatch = request.headers.get('if-none-match')
    if (ifNoneMatch !== null) {
      if (matchesIfNoneMatch(ifNoneMatch, etag)) return new Response(null, { status: 304, headers })
    } else {
      const ifModifiedSince = parseHttpDate(request.headers.get('if-modified-since'))
      if (
        ifModifiedSince !== undefined &&
        lastModified !== undefined &&
        lastModified <= ifModifiedSince
      )
        return new Response(null, { status: 304, headers })
    }
    if (variant) headers.set('content-length', String(variant.size))
    const file = Bun.file(
      variant
        ? new URL(variant.file, manifestURL)
        : new URL(asset.file.split('/').map(encodeURIComponent).join('/'), root),
    )
    if (!headers.has('content-length')) headers.set('content-length', String(file.size))
    return new Response(request.method === 'HEAD' ? null : file, { headers })
  }
}

function isPublicPath(pathname: string, base: string) {
  const basePath = base === '/' ? '' : base.replace(/\/$/, '')
  if (basePath && pathname !== basePath && !pathname.startsWith(basePath + '/')) return false
  const relative = basePath ? pathname.slice(basePath.length) : pathname
  const segments = relative.split('/').filter(Boolean)
  let decoded: string[]
  try {
    decoded = segments.map(decodeURIComponent)
  } catch {
    return false
  }
  if (decoded.some((segment) => segment === '.' || segment === '..' || /[\\/]/.test(segment)))
    return false
  if (decoded[0] === '.well-known') return true
  return !decoded.some((segment) => segment.startsWith('.'))
}

function parseHttpDate(value: string | null) {
  if (!value) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) * 1000 : undefined
}

function matchesIfMatch(value: string, etag: string | null) {
  if (value.trim() === '*') return true
  if (!etag || etag.startsWith('W/')) return false
  return value.split(',').some((candidate) => {
    const tag = candidate.trim()
    return !tag.startsWith('W/') && tag === etag
  })
}

function matchesIfNoneMatch(value: string, etag: string | null) {
  if (value.trim() === '*') return true
  if (!etag) return false
  const weakETag = etag.replace(/^W\//, '')
  return value.split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === weakETag)
}

function validatorHeaders(headers: Headers) {
  const validators = new Headers()
  for (const name of ['etag', 'last-modified']) {
    const value = headers.get(name)
    if (value) validators.set(name, value)
  }
  return validators
}
