import config from 'virtual:astro-bun-config'
import websocketEndpoint from 'virtual:astro-bun-websocket'
import { handleWebSocketUpgrade } from './websocket.js'
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

if (
  config.websocket &&
  (!websocketEndpoint ||
    typeof websocketEndpoint.upgrade !== 'function' ||
    !websocketEndpoint.websocket ||
    typeof websocketEndpoint.websocket.message !== 'function')
)
  throw new Error(
    'WebSocket module must export an upgrade function and a websocket message handler',
  )

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
  server?: Pick<Bun.Server<object>, 'requestIP' | 'timeout'>,
  trustedProxies?: typeof defaultTrustedProxies | null,
  sseIdleTimeout: number | false = config.server.sseIdleTimeout ?? 0,
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
  if (
    server &&
    sseIdleTimeout !== false &&
    request.method !== 'HEAD' &&
    response.status === 200 &&
    response.body &&
    response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ===
      'text/event-stream'
  )
    server.timeout(request, sseIdleTimeout)
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

export const websocket = websocketEndpoint?.websocket

export async function upgrade(request: Request, server: Pick<Bun.Server<object>, 'upgrade'>) {
  if (!websocketEndpoint || !config.websocket) return false as const
  return handleWebSocketUpgrade(request, server, websocketEndpoint, config.websocket)
}

export function start(options: ServerOptions = {}) {
  const runtime = resolveServerOptions(config.server, options)
  const trustedProxies = createTrustedProxyList(runtime.trustedProxies)
  const common = {
    development: false,
    maxRequestBodySize: config.maxRequestBodySize,
    error() {
      app.adapterLogger.error('Request failed')
      return new Response('Internal Server Error', { status: 500 })
    },
  }
  const tls = toBunTLS(runtime.tls, runtime.lowMemoryMode)
  const settings = runtime.unix
    ? { ...common, unix: runtime.unix, ...(tls ? { tls } : {}) }
    : {
        ...common,
        hostname: runtime.hostname!,
        port: runtime.port!,
        ...(runtime.idleTimeout === undefined ? {} : { idleTimeout: runtime.idleTimeout }),
        ...(runtime.reusePort === undefined ? {} : { reusePort: runtime.reusePort }),
        ...(runtime.http2 === undefined ? {} : { http2: runtime.http2 }),
        ...(tls ? { tls } : {}),
      }
  const fetchHTTP = (request: Request, server: Bun.Server<object>) =>
    handler(request, server, trustedProxies ?? null, runtime.sseIdleTimeout ?? 0)
  if (websocket) {
    return Bun.serve<object>({
      ...settings,
      websocket,
      async fetch(request, server) {
        const upgraded = await upgrade(request, server)
        return upgraded === false ? fetchHTTP(request, server) : upgraded
      },
    })
  }
  return Bun.serve<object>({ ...settings, fetch: fetchHTTP })
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
