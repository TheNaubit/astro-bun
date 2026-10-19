import type { PreviewServerParams } from 'astro'

export default async function preview(params: PreviewServerParams) {
  const { handler } = await import(params.serverEntrypoint.href)
  const server = Bun.serve({
    hostname: params.host ?? 'localhost',
    port: params.port,
    development: false,
    async fetch(request, server) {
      const hostname = new URL(request.url).hostname
      const allowed = params.allowedHosts
      if (
        allowed !== true &&
        hostname !== 'localhost' &&
        hostname !== '127.0.0.1' &&
        hostname !== '[::1]' &&
        !allowed?.some(
          (value) =>
            value === hostname ||
            (value.startsWith('.') && (hostname === value.slice(1) || hostname.endsWith(value))),
        )
      ) {
        return new Response('Forbidden', { status: 403 })
      }
      // Preview remains a local development surface: it does not inherit
      // production proxy trust from the standalone server configuration.
      const response = await handler(request, server, null)
      for (const [key, value] of Object.entries(params.headers ?? {})) {
        if (value !== undefined)
          response.headers.set(key, Array.isArray(value) ? value.join(', ') : String(value))
      }
      return response
    },
    error() {
      return new Response('Internal Server Error', { status: 500 })
    },
  })
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  return {
    host: server.hostname,
    port: server.port!,
    closed: () => closed,
    async stop() {
      await server.stop(true)
      resolveClosed()
    },
  }
}
