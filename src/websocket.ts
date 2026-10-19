/** Data and optional native handshake headers accepted for a WebSocket upgrade. */
export interface WebSocketUpgrade<Data extends object> {
  data: Data
  headers?: HeadersInit
}

/**
 * A WebSocket endpoint must make its own authentication and authorization
 * decision in `upgrade`. Routes are never upgraded implicitly.
 */
export interface WebSocketEndpoint<Data extends object> {
  upgrade(
    request: Request,
  ): WebSocketUpgrade<Data> | Response | Promise<WebSocketUpgrade<Data> | Response>
  websocket: Bun.WebSocketHandler<Data>
}

export interface WebSocketUpgradeConfig {
  /** Exact pathname reserved for this endpoint. */
  path: string
  /** Explicit browser origins that replace the same-origin default. */
  allowedOrigins?: string[]
}

type UpgradeServer = Pick<Bun.Server<object>, 'upgrade'>

function originAllowed(request: Request, allowedOrigins: string[] | undefined): boolean {
  const origin = request.headers.get('origin')
  if (origin === null) return true
  if (!origin) return false
  try {
    const parsedOrigin = new URL(origin)
    if (
      (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') ||
      parsedOrigin.origin !== origin
    )
      return false
    if (allowedOrigins) return allowedOrigins.includes(origin)
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

function isUpgradeRequest(request: Request): boolean {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket'
}

/**
 * Handles one exact WebSocket route. `false` means the request belongs to a
 * different route; `undefined` means Bun completed the upgrade.
 */
export async function handleWebSocketUpgrade<Data extends object>(
  request: Request,
  server: UpgradeServer,
  endpoint: WebSocketEndpoint<Data>,
  config: WebSocketUpgradeConfig,
): Promise<Response | undefined | false> {
  if (new URL(request.url).pathname !== config.path) return false
  if (request.method !== 'GET')
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } })
  if (!isUpgradeRequest(request))
    return new Response('Upgrade Required', { status: 426, headers: { upgrade: 'websocket' } })
  if (!originAllowed(request, config.allowedOrigins))
    return new Response('Forbidden', { status: 403 })

  let result: WebSocketUpgrade<Data> | Response
  try {
    result = await endpoint.upgrade(request)
  } catch {
    return new Response('Forbidden', { status: 403 })
  }
  if (result instanceof Response) return result
  if (!result || typeof result.data !== 'object' || result.data === null)
    return new Response('Forbidden', { status: 403 })

  const upgraded = server.upgrade(request, {
    data: result.data as object,
    headers: result.headers,
  })
  return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 })
}
