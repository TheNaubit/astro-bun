import { BlockList, isIP } from 'node:net'

/**
 * Server settings embedded in the built entrypoint. They deliberately only
 * contain JSON-serializable values: certificates are opened by Bun at runtime.
 */
export interface ServerOptions {
  hostname?: string
  port?: number
  /** Listen on a Unix-domain socket instead of TCP. */
  unix?: string
  /** Seconds to retain an inactive TCP connection. `0` disables the timeout. */
  idleTimeout?: number
  /**
   * Experimental native HTTP/2. Bun uses ALPN with TLS and HTTP/2 prior
   * knowledge without TLS. Unix sockets do not support this Bun option.
   */
  http2?: boolean
  /**
   * Maximum seconds an SSE stream may remain idle. `false` or `0` disables
   * the adapter-level timeout; Bun has no SSE-specific server option.
   */
  sseIdleTimeout?: number | false
  reusePort?: boolean
  /** Passed to Bun's TLS implementation when TLS is enabled. */
  lowMemoryMode?: boolean
  tls?: {
    certPath: string
    keyPath: string
    caPath?: string
  }
  /**
   * Explicit proxy source addresses or CIDRs allowed to supply X-Forwarded-For.
   * A proxy trust list never has a catch-all CIDR.
   */
  trustedProxies?: string[]
}

export interface ResolvedServerOptions extends ServerOptions {
  hostname?: string
  port?: number
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function assertBoolean(name: string, value: unknown) {
  if (value !== undefined && typeof value !== 'boolean')
    throw new Error(`${name} must be a boolean`)
}

function assertPath(name: string, value: unknown) {
  if (!isNonEmptyString(value)) throw new Error(`${name} must be a non-empty path`)
}

function assertTimeout(name: string, value: unknown, allowFalse = false) {
  if (value === undefined || (allowFalse && value === false)) return
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 255)
    throw new Error(`${name} must be a safe integer from 0 to 255${allowFalse ? ' or false' : ''}`)
}

function parseTrustedProxy(value: string): {
  address: string
  prefix?: number
  family: 'ipv4' | 'ipv6'
} {
  const parts = value.split('/')
  if (parts.length > 2 || !isNonEmptyString(parts[0]))
    throw new Error(`trustedProxies contains an invalid address: ${value}`)
  const family = isIP(parts[0])
  if (family === 0) throw new Error(`trustedProxies contains an invalid IP address: ${value}`)
  if (parts.length === 1) return { address: parts[0], family: family === 4 ? 'ipv4' : 'ipv6' }

  const prefix = Number(parts[1])
  const maximum = family === 4 ? 32 : 128
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > maximum)
    throw new Error(`trustedProxies contains an invalid or catch-all CIDR: ${value}`)
  return { address: parts[0], prefix, family: family === 4 ? 'ipv4' : 'ipv6' }
}

/** Validate integration options before they are serialized into the server bundle. */
export function validateServerOptions(options: ServerOptions | undefined): void {
  if (!options) return
  if (!isNonEmptyString(options.hostname) && options.hostname !== undefined)
    throw new Error('server.hostname must be a non-empty string')
  if (
    options.port !== undefined &&
    (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)
  )
    throw new Error('server.port must be an integer from 0 to 65535')
  if (options.unix !== undefined) assertPath('server.unix', options.unix)
  assertTimeout('server.idleTimeout', options.idleTimeout)
  assertTimeout('server.sseIdleTimeout', options.sseIdleTimeout, true)
  assertBoolean('server.reusePort', options.reusePort)
  assertBoolean('server.http2', options.http2)
  assertBoolean('server.lowMemoryMode', options.lowMemoryMode)

  if (options.tls) {
    assertPath('server.tls.certPath', options.tls.certPath)
    assertPath('server.tls.keyPath', options.tls.keyPath)
    if (options.tls.caPath !== undefined) assertPath('server.tls.caPath', options.tls.caPath)
  }
  if (options.trustedProxies !== undefined) {
    if (!Array.isArray(options.trustedProxies))
      throw new Error('server.trustedProxies must be an array')
    for (const proxy of options.trustedProxies) {
      if (!isNonEmptyString(proxy))
        throw new Error('server.trustedProxies must contain only IP addresses')
      parseTrustedProxy(proxy)
    }
  }
  if (
    options.unix &&
    (options.hostname !== undefined ||
      options.port !== undefined ||
      options.reusePort !== undefined ||
      options.http2 === true)
  )
    throw new Error('server.unix cannot be combined with hostname, port, reusePort, or http2')
}

/** Build an address matcher after validation, without accepting wildcard proxy trust. */
export function createTrustedProxyList(
  trustedProxies: readonly string[] | undefined,
): BlockList | undefined {
  if (!trustedProxies?.length) return
  const list = new BlockList()
  for (const value of trustedProxies) {
    const proxy = parseTrustedProxy(value)
    if (proxy.prefix === undefined) list.addAddress(proxy.address, proxy.family)
    else list.addSubnet(proxy.address, proxy.prefix, proxy.family)
  }
  return list
}

function isTrusted(address: string, trustedProxies: BlockList): boolean {
  return trustedProxies.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')
}

function forwardedAddress(request: Request, trustedProxies: BlockList): string | undefined {
  const header = request.headers.get('x-forwarded-for')
  if (!header) return
  const values = header.split(',').map((value) => value.trim())
  if (values.length === 0 || values.some((value) => isIP(value) === 0)) return
  return values.reverse().find((value) => !isTrusted(value, trustedProxies))
}

/**
 * Return an X-Forwarded-For client only when the socket peer is explicitly
 * trusted. Trusted proxy hops are removed right-to-left, so a trusted proxy's
 * appended peer address wins over values prepended by a client.
 */
export function getClientAddress(
  request: Request,
  server: Pick<Bun.Server<undefined>, 'requestIP'>,
  trustedProxies: BlockList | undefined,
): string | undefined {
  const peer = server.requestIP(request)?.address
  if (!peer) return
  if (!trustedProxies || !isTrusted(peer, trustedProxies)) return peer
  return forwardedAddress(request, trustedProxies) ?? peer
}

export function resolveServerOptions(
  configured: ServerOptions | undefined,
  overrides: ServerOptions | undefined = undefined,
  environment: Record<string, string | undefined> = Bun.env,
): ResolvedServerOptions {
  validateServerOptions(configured)
  validateServerOptions(overrides)
  const options = { ...configured, ...overrides }
  const hasTCPOverride =
    overrides?.hostname !== undefined ||
    overrides?.port !== undefined ||
    overrides?.reusePort !== undefined ||
    overrides?.http2 === true
  if (Object.hasOwn(environment, 'UNIX') && !isNonEmptyString(environment.UNIX))
    throw new Error('UNIX must be a non-empty socket path')
  const unix = hasTCPOverride
    ? undefined
    : (overrides?.unix ?? environment.UNIX ?? configured?.unix)
  if (
    !overrides?.tls &&
    (environment.TLS_CERT_PATH === undefined) !== (environment.TLS_KEY_PATH === undefined)
  )
    throw new Error('TLS_CERT_PATH and TLS_KEY_PATH must be configured together')
  const configuredTLS = overrides?.tls ?? configured?.tls
  const certPath = overrides?.tls?.certPath ?? environment.TLS_CERT_PATH ?? configuredTLS?.certPath
  const keyPath = overrides?.tls?.keyPath ?? environment.TLS_KEY_PATH ?? configuredTLS?.keyPath
  if ((certPath === undefined) !== (keyPath === undefined))
    throw new Error('TLS_CERT_PATH and TLS_KEY_PATH must be configured together')
  const tls = certPath && keyPath ? { ...configuredTLS, certPath, keyPath } : undefined
  if (unix) {
    if (options.http2) throw new Error('server.http2 requires TCP, not a Unix socket')
    return {
      unix,
      tls,
      ...(options.idleTimeout === undefined ? {} : { idleTimeout: options.idleTimeout }),
      ...(options.sseIdleTimeout === undefined ? {} : { sseIdleTimeout: options.sseIdleTimeout }),
      lowMemoryMode: options.lowMemoryMode,
      trustedProxies: options.trustedProxies,
    }
  }

  const port =
    overrides?.port ??
    (environment.PORT === undefined ? (configured?.port ?? 4321) : Number(environment.PORT))
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('PORT must be an integer from 0 to 65535')
  const { unix: _unix, ...tcpOptions } = options
  return {
    ...tcpOptions,
    hostname: overrides?.hostname ?? environment.HOST ?? configured?.hostname ?? '0.0.0.0',
    port,
    tls,
  }
}

export function toBunTLS(
  tls: ServerOptions['tls'],
  lowMemoryMode: boolean | undefined,
): Bun.TLSOptions | undefined {
  if (!tls) return
  return {
    cert: Bun.file(tls.certPath),
    key: Bun.file(tls.keyPath),
    ...(tls.caPath ? { ca: Bun.file(tls.caPath) } : {}),
    ...(lowMemoryMode === undefined ? {} : { lowMemoryMode }),
  }
}
