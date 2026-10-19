export interface AssetManifest {
  client: string
  base: string
  trailingSlash: 'always' | 'never' | 'ignore'
  assets: Record<string, { file: string; headers: Record<string, string> }>
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
    const etag = headers.get('etag')
    const matches = request.headers
      .get('if-none-match')
      ?.split(',')
      .some((value) => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)
    if (matches) return new Response(null, { status: 304, headers })
    const file = Bun.file(new URL(asset.file.split('/').map(encodeURIComponent).join('/'), root))
    return new Response(request.method === 'HEAD' ? null : file, { headers })
  }
}
