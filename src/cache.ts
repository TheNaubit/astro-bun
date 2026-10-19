import type { CacheProvider, CacheProviderFactory, InvalidateOptions } from 'astro'
import { BaseApp } from 'astro/app'

declare const __ASTRO_BUN_PRERENDER__: boolean | undefined

/** Configuration for the process-local cache used by the Bun adapter. */
export interface BunCacheOptions {
  /** Maximum cached responses. @default 1_000 */
  maxEntries?: number
  /** Maximum total response-body bytes. @default 64 MiB */
  maxBytes?: number
  /** Maximum bytes buffered for one response. @default 1 MiB */
  maxBodyBytes?: number
  /** Maximum time spent buffering a response clone. @default 1 second */
  maxCacheBodyTimeMs?: number
  /** Maximum origin requests being coalesced or revalidated. @default 100 */
  maxInflight?: number
}

export type CacheOptions = BunCacheOptions

interface Entry {
  body: Uint8Array
  headers: [string, string][]
  storedAt: number
  maxAge: number
  swr: number
  tags: string[]
}

interface FlightResult {
  entry?: Entry
  response: Response
}
interface Flight {
  generation: number
  promise: Promise<FlightResult>
}

const MiB = 1024 * 1024

function cacheKey(request: Request): string {
  const url = new URL(request.url)
  return `${url.origin}${url.pathname}${url.search}`
}

function parseCacheControl(value: string | null): {
  maxAge: number
  swr: number
  cacheable: boolean
} {
  if (!value) return { maxAge: 0, swr: 0, cacheable: false }
  let maxAge = 0
  let swr = 0
  let cacheable = true
  for (const directive of value.split(',')) {
    const part = directive.trim().toLowerCase()
    if (part === 'private' || part === 'no-store') cacheable = false
    else if (part.startsWith('max-age=')) maxAge = Number.parseInt(part.slice(8), 10) || 0
    else if (part.startsWith('stale-while-revalidate='))
      swr = Number.parseInt(part.slice(23), 10) || 0
  }
  return { maxAge, swr, cacheable: cacheable && maxAge > 0 }
}
function hasDisallowedCacheDirective(value: string | null): boolean {
  return (value ?? '').split(',').some((directive) => {
    const name = directive.trim().toLowerCase().split('=', 1)[0]
    return name === 'private' || name === 'no-store' || name === 'no-cache'
  })
}

function validLimit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError('Cache limits must be positive safe integers')
  }
  return resolved
}

function hasDeferredCookies(response: Response): boolean {
  return !BaseApp.getSetCookieFromResponse(response).next().done
}

function age(entry: Entry): number {
  return (Date.now() - entry.storedAt) / 1000
}

function isFresh(entry: Entry): boolean {
  return age(entry) <= entry.maxAge
}

function isStale(entry: Entry): boolean {
  const currentAge = age(entry)
  return currentAge > entry.maxAge && currentAge <= entry.maxAge + entry.swr
}

function responseFrom(entry: Entry, cacheStatus: 'HIT' | 'MISS' | 'STALE'): Response {
  const headers = new Headers(entry.headers)
  headers.set('X-Astro-Cache', cacheStatus)
  return new Response(entry.body.slice(), { status: 200, headers })
}

async function readBody(
  response: Response,
  limit: number,
  timeLimitMs: number,
): Promise<Uint8Array | undefined> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > limit) {
    void response.body?.cancel().catch(() => undefined)
    return undefined
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const deadline = Date.now() + timeLimitMs
  try {
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        void reader.cancel().catch(() => undefined)
        return undefined
      }
      const pending = reader.read()
      const timedOut = Symbol('timedOut')
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<typeof timedOut>((resolve) => {
        timeoutId = setTimeout(() => resolve(timedOut), remaining)
      })
      let step: Awaited<ReturnType<typeof reader.read>> | typeof timedOut
      try {
        step = await Promise.race([pending, timeout])
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId)
      }
      if (step === timedOut) {
        void reader.cancel().catch(() => undefined)
        void pending.catch(() => undefined)
        return undefined
      }
      const { done, value } = step
      if (done) break
      total += value.byteLength
      if (total > limit) {
        void reader.cancel().catch(() => undefined)
        return undefined
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function entryPath(key: string): string {
  const url = new URL(key)
  return `${url.pathname}${url.search}`
}

/**
 * A bounded, process-local ISR cache for Bun deployments.
 *
 * Entries are deliberately opt-in: Astro must have emitted CDN-Cache-Control
 * from `Astro.cache.set()` or configured cache routes. The cache is not shared
 * across Bun processes or deploys.
 */
const createBunCache: CacheProviderFactory<BunCacheOptions> = (options) => {
  const maxEntries = validLimit(options?.maxEntries, 1_000)
  const maxBytes = validLimit(options?.maxBytes, 64 * MiB)
  const maxBodyBytes = Math.min(maxBytes, validLimit(options?.maxBodyBytes, MiB))
  const maxCacheBodyTimeMs = validLimit(options?.maxCacheBodyTimeMs, 1_000)
  const maxInflight = validLimit(options?.maxInflight, 100)
  const entries = new Map<string, Entry>()
  const inflight = new Map<string, Flight>()
  let totalBytes = 0
  let generation = 0

  function get(key: string): Entry | undefined {
    const entry = entries.get(key)
    if (entry) {
      entries.delete(key)
      entries.set(key, entry)
    }
    return entry
  }

  function remove(key: string): void {
    const entry = entries.get(key)
    if (!entry) return
    totalBytes -= entry.body.byteLength
    entries.delete(key)
  }

  function store(key: string, entry: Entry, createdAtGeneration: number): void {
    if (createdAtGeneration !== generation || entry.body.byteLength > maxBytes) return
    remove(key)
    while (entries.size >= maxEntries || totalBytes + entry.body.byteLength > maxBytes) {
      const oldest = entries.keys().next().value as string | undefined
      if (!oldest) return
      remove(oldest)
    }
    entries.set(key, entry)
    totalBytes += entry.body.byteLength
  }

  async function cacheResponse(
    response: Response,
    key: string,
    createdAtGeneration: number,
  ): Promise<Entry | undefined> {
    const directives = parseCacheControl(response.headers.get('cdn-cache-control'))
    if (
      !directives.cacheable ||
      hasDisallowedCacheDirective(response.headers.get('cdn-cache-control')) ||
      hasDisallowedCacheDirective(response.headers.get('cache-control')) ||
      response.status !== 200 ||
      response.headers.has('set-cookie') ||
      hasDeferredCookies(response) ||
      response.headers.has('vary') ||
      response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')
    )
      return undefined

    const body = await readBody(response.clone(), maxBodyBytes, maxCacheBodyTimeMs)
    if (!body) return undefined
    const headers: [string, string][] = []
    response.headers.forEach((value, name) => {
      headers.push([name, value])
    })
    const entry: Entry = {
      body,
      headers,
      storedAt: Date.now(),
      maxAge: directives.maxAge,
      swr: directives.swr,
      tags: (response.headers.get('cache-tag') ?? '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    }
    store(key, entry, createdAtGeneration)
    return generation === createdAtGeneration ? entry : undefined
  }

  function canRead(request: Request): boolean {
    return (
      request.method === 'GET' &&
      !request.headers.has('cookie') &&
      !request.headers.has('authorization')
    )
  }

  function createFlight(
    context: Parameters<NonNullable<CacheProvider['onRequest']>>[0],
    next: Parameters<NonNullable<CacheProvider['onRequest']>>[1],
    key: string,
    replacingStale = false,
  ): Flight {
    const createdAtGeneration = generation
    const flight = (async (): Promise<FlightResult> => {
      const response = await next()
      try {
        const entry = await cacheResponse(response, key, createdAtGeneration)
        if (
          !entry &&
          replacingStale &&
          response.status === 200 &&
          createdAtGeneration === generation
        )
          remove(key)
        return { response, entry }
      } catch (error) {
        context.logger.warn(
          `Unable to cache ${new URL(context.request.url).pathname}: ${String(error)}`,
        )
        return { response }
      } finally {
        if (replacingStale) void response.body?.cancel().catch(() => undefined)
      }
    })()
    const record = { generation: createdAtGeneration, promise: flight }
    inflight.set(key, record)
    void flight
      .finally(() => {
        if (inflight.get(key) === record) inflight.delete(key)
      })
      .catch(() => undefined)
    return record
  }

  function revalidate(
    context: Parameters<NonNullable<CacheProvider['onRequest']>>[0],
    next: Parameters<NonNullable<CacheProvider['onRequest']>>[1],
    key: string,
  ): void {
    if (inflight.has(key) || inflight.size >= maxInflight) return
    const job = createFlight(context, next, key, true).promise
    const handled = job.catch((error) => {
      context.logger.warn(
        `Cache revalidation failed for ${new URL(context.request.url).pathname}: ${String(error)}`,
      )
    })
    context.waitUntil?.(handled)
  }

  return {
    name: 'bun',
    async onRequest(context, next) {
      if (typeof __ASTRO_BUN_PRERENDER__ !== 'undefined' && __ASTRO_BUN_PRERENDER__) return next()
      if (!canRead(context.request)) return next()
      const key = cacheKey(context.request)
      const cached = get(key)
      if (cached && isFresh(cached)) return responseFrom(cached, 'HIT')
      if (cached && isStale(cached)) {
        revalidate(context, next, key)
        return responseFrom(cached, 'STALE')
      }
      if (cached) remove(key)

      const existingFlight = inflight.get(key)
      const currentFlight = existingFlight?.generation === generation ? existingFlight : undefined
      const flight =
        currentFlight ??
        (inflight.size < maxInflight ? createFlight(context, next, key) : undefined)
      if (!flight) return next()
      const result = await flight.promise
      if (result.entry) return responseFrom(result.entry, 'MISS')
      return currentFlight ? next() : result.response
    },
    async invalidate(input: InvalidateOptions) {
      generation++
      const tags = input.tags
        ? new Set(Array.isArray(input.tags) ? input.tags : [input.tags])
        : undefined
      for (const [key, entry] of entries) {
        if (
          (input.path && entryPath(key) === input.path) ||
          (tags && entry.tags.some((tag) => tags.has(tag)))
        )
          remove(key)
      }
    },
  }
}

export default createBunCache
