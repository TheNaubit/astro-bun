import config from 'virtual:astro-bun-config'
import { createApp } from 'astro/app/entrypoint'
import { setGetEnv } from 'astro/env/setup'
import {
  createTrustedProxyList,
  getClientAddress,
  resolveServerOptions,
  toBunTLS,
  type ServerOptions,
} from './runtime-options.js'
import { type AssetManifest, createStaticHandler } from './static.js'

setGetEnv((key) => Bun.env[key])
const app = createApp()
const manifestURL = new URL(config.assetManifest, import.meta.url)
const assets = (await Bun.file(manifestURL).json()) as AssetManifest
const serveStatic = createStaticHandler(assets, manifestURL)
const defaultTrustedProxies = createTrustedProxyList(config.server.trustedProxies)
const pending = new Set<Promise<unknown>>()
function waitUntil(promise: Promise<unknown>) {
  const task = promise.catch(() => {
    app.adapterLogger.error('Background task failed')
  })
  pending.add(task)
  void task.finally(() => pending.delete(task))
}

export async function handler(
  request: Request,
  server?: Bun.Server<undefined>,
  trustedProxies?: typeof defaultTrustedProxies | null,
): Promise<Response> {
  const staticResponse = serveStatic(request)
  if (staticResponse) return staticResponse
  const response = await app.render(request, {
    addCookieHeader: true,
    clientAddress: server
      ? getClientAddress(
          request,
          server,
          trustedProxies === undefined ? defaultTrustedProxies : (trustedProxies ?? undefined),
        )
      : undefined,
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

export function start(options: ServerOptions = {}) {
  const runtime = resolveServerOptions(config.server, options)
  const trustedProxies = createTrustedProxyList(runtime.trustedProxies)
  const common = {
    development: false,
    maxRequestBodySize: config.maxRequestBodySize,
    fetch(request: Request, server: Bun.Server<undefined>) {
      return handler(request, server, trustedProxies ?? null)
    },
    error() {
      app.adapterLogger.error('Request failed')
      return new Response('Internal Server Error', { status: 500 })
    },
  }
  const tls = toBunTLS(runtime.tls, runtime.lowMemoryMode)
  if (runtime.unix) {
    return Bun.serve({
      ...common,
      unix: runtime.unix,
      ...(tls ? { tls } : {}),
    })
  }
  return Bun.serve({
    ...common,
    hostname: runtime.hostname!,
    port: runtime.port!,
    ...(runtime.idleTimeout === undefined ? {} : { idleTimeout: runtime.idleTimeout }),
    ...(runtime.reusePort === undefined ? {} : { reusePort: runtime.reusePort }),
    ...(tls ? { tls } : {}),
  })
}

if (config.mode === 'standalone' && import.meta.main) {
  if (config.workers > 1 && !Bun.env.ASTRO_BUN_WORKER) {
    const runtime = resolveServerOptions(config.server)
    if (runtime.unix || runtime.port === 0)
      throw new Error('Multiple Bun workers require a fixed TCP port, not a Unix socket or port 0')
    const { supervise } = await import('./cluster.js')
    await supervise({
      entrypoint: import.meta.path,
      workers: config.workers,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
    })
  } else {
    const server = start(config.workers > 1 ? { reusePort: true } : {})
    app.adapterLogger.info(
      `Listening on ${config.server.unix ? `Unix socket ${config.server.unix}` : server.url}`,
    )
    let stopping = false
    const shutdown = async () => {
      if (stopping) return
      stopping = true
      const timeout = setTimeout(() => process.exit(1), config.shutdownTimeoutMs)
      timeout.unref()
      await server.stop()
      await Promise.allSettled(pending)
      clearTimeout(timeout)
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  }
}
