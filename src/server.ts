import config from 'virtual:astro-bun-config'
import { createApp } from 'astro/app/entrypoint'
import { setGetEnv } from 'astro/env/setup'
import { type AssetManifest, createStaticHandler } from './static.js'

setGetEnv((key) => Bun.env[key])
const app = createApp()
const manifestURL = new URL('./bun-assets.json', import.meta.url)
const assets = (await Bun.file(manifestURL).json()) as AssetManifest
const serveStatic = createStaticHandler(assets, manifestURL)
const pending = new Set<Promise<unknown>>()
function waitUntil(promise: Promise<unknown>) {
  const task = promise.catch(() => {
    app.adapterLogger.error('Background task failed')
  })
  pending.add(task)
  void task.finally(() => pending.delete(task))
}

export async function handler(request: Request, server?: Bun.Server<undefined>): Promise<Response> {
  const staticResponse = serveStatic(request)
  if (staticResponse) return staticResponse
  const response = await app.render(request, {
    addCookieHeader: true,
    clientAddress: server?.requestIP(request)?.address,
    waitUntil,
    prerenderedErrorPageFetch: async (path) =>
      serveStatic(new Request(new URL(path, request.url))) ?? new Response(null, { status: 404 }),
  })
  if (request.method === 'HEAD') {
    void response.body?.cancel().catch(() => {})
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
  return response
}

export function start(options: { hostname?: string; port?: number } = {}) {
  const port = options.port ?? Number(Bun.env.PORT ?? 4321)
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('PORT must be an integer from 0 to 65535')
  const server = Bun.serve({
    hostname: options.hostname ?? Bun.env.HOST ?? '0.0.0.0',
    port,
    development: false,
    maxRequestBodySize: config.maxRequestBodySize,
    fetch: handler,
    error() {
      app.adapterLogger.error('Request failed')
      return new Response('Internal Server Error', { status: 500 })
    },
  })
  return server
}

if (config.mode === 'standalone' && import.meta.main) {
  const server = start()
  app.adapterLogger.info(`Listening on ${server.url}`)
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    const timeout = setTimeout(() => process.exit(1), 10_000)
    timeout.unref()
    await server.stop()
    await Promise.allSettled(pending)
    clearTimeout(timeout)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
