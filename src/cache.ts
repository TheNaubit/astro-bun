import type { CacheProvider, CacheProviderFactory, InvalidateOptions } from 'astro'
import { BaseApp } from 'astro/app'
import { PersistentCacheStore, type PersistentCacheOptions } from './cache-store.js'

declare const __ASTRO_BUN_PRERENDER__: boolean | undefined

/** Durable cache configuration. Persistence is deliberately opt-in. */
export interface BunCachePersistenceOptions {
  /** Directory that contains only this adapter's SQLite database. */
  directory: string
  /** Deployment/build identifier. Entries never cross this boundary. */
  namespace: string
  /** Total response-body bytes across all namespaces in this database. */
  maxDiskBytes?: number
  /** Maximum durable entries across all namespaces. @default maxEntries */
  maxDiskEntries?: number
  /** Load most-recent durable entries into the bounded process cache at startup. */
  preFillMemory?: boolean
}

/** Configuration for the Bun ISR cache used by the adapter. */
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
  /** Optional SQLite disk tier shared by Bun processes. */
  persistence?: BunCachePersistenceOptions
  /** @internal Exact pathname of Astro's image endpoint, supplied by the adapter. */
  imageEndpointRoute?: string
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

type InvalidateableCache = Pick<CacheProvider, 'invalidate'>
// Astro can bundle the provider while leaving package subpath imports external.
// Share the process-local registry across those module instances.
const registryKey = Symbol.for('@nauverse/astro-bun/cache/providers/v1')
const registryHost = globalThis as typeof globalThis & {
  [registryKey]?: Set<WeakRef<InvalidateableCache>>
}
const activeCaches = (registryHost[registryKey] ??= new Set<WeakRef<InvalidateableCache>>())

/** Expire a path in every live Bun cache provider in this process. */
export async function expirePath(path: string): Promise<void> {
  await invalidateLiveCaches({ path })
}

/** Expire all entries in every live Bun cache provider in this process. */
export async function expireAll(): Promise<void> {
  await invalidateLiveCaches({})
}

async function invalidateLiveCaches(input: InvalidateOptions): Promise<void> {
  const invalidations: Promise<void>[] = []
  for (const reference of activeCaches) {
    const cache = reference.deref()
    if (!cache) {
      activeCaches.delete(reference)
      continue
    }
    if (cache.invalidate) invalidations.push(cache.invalidate(input))
  }
  await Promise.all(invalidations)
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
  let sharedMaxAge: number | undefined
  let swr = 0
  let cacheable = true
  for (const directive of value.split(',')) {
    const part = directive.trim().toLowerCase()
    if (part === 'private' || part === 'no-store') cacheable = false
    else if (part.startsWith('max-age=')) maxAge = Number.parseInt(part.slice(8), 10) || 0
    else if (part.startsWith('s-maxage=')) sharedMaxAge = Number.parseInt(part.slice(9), 10) || 0
    else if (part.startsWith('stale-while-revalidate='))
      swr = Number.parseInt(part.slice(23), 10) || 0
  }
  maxAge = sharedMaxAge ?? maxAge
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

function withCacheStatus(response: Response, status: 'BYPASS' | 'MISS'): Response {
  try {
    response.headers.set('X-Astro-Cache', status)
  } catch {
    // Some platform responses expose immutable headers. Preserve the original
    // response rather than cloning or consuming its potentially streaming body.
  }
  return response
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

function normalizePathname(pathname: string): string {
  return new URL(pathname, 'http://astro-bun.invalid').pathname
}

function isConfiguredImageKey(key: string, imageEndpointRoute: string | undefined): boolean {
  return imageEndpointRoute !== undefined && new URL(key).pathname === imageEndpointRoute
}

function normalizedImageKey(key: string): string {
  const url = new URL(key)
  const parameters = [...url.searchParams.entries()]
    .map(([name, value], index) => ({ name, value, index }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.index - right.index)
  const search = new URLSearchParams()
  for (const { name, value } of parameters) search.append(name, value)
  url.search = search.toString()
  return url.toString()
}

/**
 * A bounded Bun ISR cache with an optional durable SQLite tier.
 *
 * Entries are deliberately opt-in: Astro must have emitted CDN-Cache-Control
 * from `Astro.cache.set()`, configured cache routes, or `s-maxage` response
 * headers. Durable entries require an explicit deployment namespace.
 */
const createBunCache: CacheProviderFactory<BunCacheOptions> = (options) => {
  const maxEntries = validLimit(options?.maxEntries, 1_000)
  const maxBytes = validLimit(options?.maxBytes, 64 * MiB)
  const maxBodyBytes = Math.min(maxBytes, validLimit(options?.maxBodyBytes, MiB))
  const maxCacheBodyTimeMs = validLimit(options?.maxCacheBodyTimeMs, 1_000)
  const maxInflight = validLimit(options?.maxInflight, 100)
  const persistence = options?.persistence
  const imageEndpointRoute = options?.imageEndpointRoute
    ? normalizePathname(options.imageEndpointRoute)
    : undefined
  if (persistence && (!persistence.directory || !persistence.namespace))
    throw new TypeError('Cache persistence requires a directory and deployment namespace')
  const maxDiskBytes = persistence ? validLimit(persistence.maxDiskBytes, maxBytes) : undefined
  const maxDiskEntries = persistence
    ? validLimit(persistence.maxDiskEntries, maxEntries)
    : undefined
  const disk = persistence
    ? new PersistentCacheStore({
        directory: persistence.directory,
        namespace: persistence.namespace,
        maxDiskBytes: maxDiskBytes!,
        maxDiskEntries: maxDiskEntries!,
      } satisfies PersistentCacheOptions)
    : undefined
  const entries = new Map<string, Entry>()
  const inflight = new Map<string, Flight>()
  let totalBytes = 0
  let generation = 0
  let diskRevision: number | undefined
  let diskAvailable = true
  let warmed = false

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

  function clearMemory(): void {
    entries.clear()
    totalBytes = 0
  }

  async function synchronizeDisk(): Promise<void> {
    if (!disk) return
    const revision = await disk.revision()
    if (revision === undefined) {
      clearMemory()
      generation++
      diskRevision = undefined
      diskAvailable = false
      return
    }
    diskAvailable = true
    if (diskRevision !== undefined && diskRevision !== revision) {
      clearMemory()
      generation++
    }
    diskRevision = revision
    if (persistence?.preFillMemory && !warmed) {
      warmed = true
      const warmEntries = await disk.warm(maxEntries, maxBytes)
      for (const [key, entry] of warmEntries) store(key, entry, generation)
    }
  }

  async function getCached(key: string): Promise<Entry | undefined> {
    await synchronizeDisk()
    const memory = get(key)
    if (memory || !disk) return memory
    const fromDisk = await disk.get(key)
    if (!fromDisk) return undefined
    store(key, fromDisk, generation)
    return get(key)
  }

  async function cacheResponse(
    response: Response,
    key: string,
    createdAtGeneration: number,
    createdAtDiskRevision: number | undefined,
  ): Promise<Entry | undefined> {
    const cdnCacheControl = response.headers.get('cdn-cache-control')
    const cacheControl = response.headers.get('cache-control')
    const isImageResponse = isConfiguredImageKey(key, imageEndpointRoute)
    // Astro emits CDN-Cache-Control. A shared s-maxage response is also an
    // explicit standard opt-in when Astro's cache API is not used.
    const directives = parseCacheControl(cdnCacheControl)
    const cacheControlDirectives = parseCacheControl(cacheControl)
    if (!cdnCacheControl && !isImageResponse && !/(?:^|,)\s*s-maxage\s*=/i.test(cacheControl ?? ''))
      return undefined
    const policy = cdnCacheControl ? directives : cacheControlDirectives
    if (
      !policy.cacheable ||
      hasDisallowedCacheDirective(cdnCacheControl) ||
      hasDisallowedCacheDirective(cacheControl) ||
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
    if (isImageResponse && !cdnCacheControl) {
      const cacheControlIndex = headers.findIndex(([name]) => name === 'cache-control')
      if (cacheControlIndex >= 0) {
        const [name, value] = headers[cacheControlIndex]
        headers[cacheControlIndex] = [
          name,
          /(?:^|,)\s*s-maxage\s*=/i.test(value) ? value : `${value}, s-maxage=${policy.maxAge}`,
        ]
      }
    }
    const entry: Entry = {
      body,
      headers,
      storedAt: Date.now(),
      maxAge: policy.maxAge,
      swr: policy.swr,
      tags: (response.headers.get('cache-tag') ?? '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    }
    if (disk && createdAtDiskRevision !== undefined) {
      const revision = await disk.set(key, entry, createdAtDiskRevision)
      if (revision === undefined) return undefined
      diskRevision = revision
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
    const createdAtDiskRevision = diskRevision
    const flight = (async (): Promise<FlightResult> => {
      const response = await next()
      try {
        const entry = await cacheResponse(response, key, createdAtGeneration, createdAtDiskRevision)
        if (
          !entry &&
          replacingStale &&
          response.status === 200 &&
          createdAtGeneration === generation
        ) {
          remove(key)
          if (disk && createdAtDiskRevision !== undefined) {
            const revision = await disk.delete(key, createdAtDiskRevision)
            if (revision !== undefined) diskRevision = revision
          }
        }
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

  const provider: CacheProvider = {
    name: 'bun',
    async onRequest(context, next) {
      if (typeof __ASTRO_BUN_PRERENDER__ !== 'undefined' && __ASTRO_BUN_PRERENDER__)
        return withCacheStatus(await next(), 'BYPASS')
      if (!canRead(context.request)) return withCacheStatus(await next(), 'BYPASS')
      const rawKey = cacheKey(context.request)
      const key = isConfiguredImageKey(rawKey, imageEndpointRoute)
        ? normalizedImageKey(rawKey)
        : rawKey
      // Keep the process-local path synchronous through flight creation. Apart
      // from avoiding needless microtasks, this preserves invalidation's
      // generation barrier for an origin request that has already started.
      const cached = disk ? await getCached(key) : get(key)
      if (disk && !diskAvailable) return withCacheStatus(await next(), 'BYPASS')
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
      if (!flight) return withCacheStatus(await next(), 'BYPASS')
      const result = await flight.promise
      if (result.entry) return responseFrom(result.entry, 'MISS')
      return currentFlight
        ? withCacheStatus(await next(), 'BYPASS')
        : withCacheStatus(result.response, 'BYPASS')
    },
    async invalidate(input: InvalidateOptions) {
      generation++
      const tags = input.tags
        ? new Set(Array.isArray(input.tags) ? input.tags : [input.tags])
        : undefined
      if (disk) {
        const revision = await disk.invalidate(input.path, tags ? [...tags] : undefined)
        if (revision !== undefined) diskRevision = revision
      }
      if (!input.path && !tags) {
        clearMemory()
        return
      }
      for (const [key, entry] of entries) {
        if (
          (input.path && entryPath(key) === input.path) ||
          (tags && entry.tags.some((tag) => tags.has(tag)))
        )
          remove(key)
      }
    },
  }
  activeCaches.add(new WeakRef(provider))
  return provider
}

export default createBunCache
