import { describe, expect, test } from 'bun:test'
import createBunCache, { expireAll, expirePath } from '../src/cache.js'

const logger = { info() {}, warn() {}, error() {} }

function request(url = 'https://example.test/page', init?: RequestInit): Request {
  return new Request(url, init)
}

async function run(
  provider: ReturnType<typeof createBunCache>,
  current: Request,
  next: () => Promise<Response>,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  return provider.onRequest!(
    { request: current, url: new URL(current.url), logger, waitUntil },
    next,
  )
}

function cacheable(body: string, maxAge = 60, swr = 0, extra?: HeadersInit): Response {
  const headers = new Headers(extra)
  headers.set(
    'CDN-Cache-Control',
    `max-age=${maxAge}${swr ? `, stale-while-revalidate=${swr}` : ''}`,
  )
  return new Response(body, { status: 200, headers })
}

describe('Bun ISR cache provider', () => {
  test('uses Astro CDN-Cache-Control as explicit opt-in and keys the full URL', async () => {
    const provider = createBunCache()
    let renders = 0
    const next = async () => cacheable(`render-${++renders}`)

    expect(await (await run(provider, request('https://example.test/a?q=1'), next)).text()).toBe(
      'render-1',
    )
    expect(await (await run(provider, request('https://example.test/a?q=1'), next)).text()).toBe(
      'render-1',
    )
    expect(await (await run(provider, request('https://example.test/a?q=2'), next)).text()).toBe(
      'render-2',
    )
    expect(renders).toBe(2)
  })

  test('caches only the exact configured Astro image endpoint with its max-age policy', async () => {
    const provider = createBunCache({ imageEndpointRoute: '_image' })
    let renders = 0
    const image = request('https://example.test/_image?href=%2Fphoto.png&w=640&custom=one')
    const next = async () =>
      new Response(`image-${++renders}`, { headers: { 'Cache-Control': 'public, max-age=60' } })
    expect(await (await run(provider, image, next)).text()).toBe('image-1')
    const cached = await run(provider, image, next)
    expect(await cached.text()).toBe('image-1')
    expect(cached.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=60')
    expect(renders).toBe(1)

    const reordered = request('https://example.test/_image?w=640&custom=one&href=%2Fphoto.png')
    expect(await (await run(provider, reordered, next)).text()).toBe('image-1')
    expect(renders).toBe(1)

    const customVariant = request('https://example.test/_image?href=%2Fphoto.png&w=640&custom=two')
    expect(await (await run(provider, customVariant, next)).text()).toBe('image-2')
    expect(renders).toBe(2)

    const lookalike = request('https://example.test/_image/other?href=%2Fphoto.png')
    await run(provider, lookalike, next)
    await run(provider, lookalike, next)
    expect(renders).toBe(4)
  })

  test('never treats an ordinary browser max-age response as ISR cacheable', async () => {
    const provider = createBunCache({ imageEndpointRoute: '_image' })
    let renders = 0
    const next = async () =>
      new Response(`page-${++renders}`, { headers: { 'Cache-Control': 'public, max-age=60' } })
    await run(provider, request('https://example.test/page'), next)
    expect(await (await run(provider, request('https://example.test/page'), next)).text()).toBe(
      'page-2',
    )
  })

  test('serves stale during SWR and coalesces concurrent revalidation through waitUntil', async () => {
    const provider = createBunCache()
    let renders = 0
    const originalNow = Date.now
    let now = 1_000
    Date.now = () => now
    const first = await run(provider, request(), async () => cacheable(`render-${++renders}`, 1, 1))
    expect(await first.text()).toBe('render-1')
    now += 1_001
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const background: Promise<unknown>[] = []
    const next = async () => {
      await pending
      return cacheable(`render-${++renders}`, 60)
    }
    const stale = await Promise.all([
      run(provider, request(), next, (job) => background.push(job)),
      run(provider, request(), next, (job) => background.push(job)),
    ])
    expect(await stale[0].text()).toBe('render-1')
    expect(await stale[1].text()).toBe('render-1')
    expect(renders).toBe(1)
    try {
      release()
      await Promise.all(background)
      expect(await (await run(provider, request(), next)).text()).toBe('render-2')
      expect(renders).toBe(2)
    } finally {
      Date.now = originalNow
    }
  })

  test('coalesces a cold miss without sharing a consumed response body', async () => {
    const provider = createBunCache()
    let renders = 0
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const next = async () => {
      await pending
      return cacheable(`render-${++renders}`)
    }
    const responses = [run(provider, request(), next), run(provider, request(), next)]
    release()
    expect(await (await responses[0]).text()).toBe('render-1')
    expect(await (await responses[1]).text()).toBe('render-1')
    expect(renders).toBe(1)
  })

  test('does not replay an uncached in-flight response to another request', async () => {
    const provider = createBunCache()
    let renders = 0
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = run(provider, request(), async () => {
      await pending
      return cacheable(`origin-${++renders}`, 60, 0, { Vary: 'Cookie' })
    })
    const second = run(provider, request(), async () =>
      cacheable(`origin-${++renders}`, 60, 0, { Vary: 'Cookie' }),
    )
    release()
    expect(await (await first).text()).toBe('origin-1')
    expect(await (await second).text()).toBe('origin-2')
    expect(renders).toBe(2)
  })

  test('never reads or writes personalized, varying, unsafe, non-GET, or failed responses', async () => {
    const cases: Array<[Request, () => Response]> = [
      [
        request('https://example.test/cookie', {
          headers: { Cookie: 'session=1' },
        }),
        () => cacheable('cookie'),
      ],
      [
        request('https://example.test/auth', {
          headers: { Authorization: 'Bearer secret' },
        }),
        () => cacheable('auth'),
      ],
      [request('https://example.test/head', { method: 'HEAD' }), () => cacheable('head')],
      [
        request('https://example.test/vary'),
        () => cacheable('vary', 60, 0, { Vary: 'Accept-Language' }),
      ],
      [
        request('https://example.test/set-cookie'),
        () => cacheable('set-cookie', 60, 0, { 'Set-Cookie': 'session=1' }),
      ],
      [
        request('https://example.test/private'),
        () =>
          new Response('private', {
            headers: { 'CDN-Cache-Control': 'private, max-age=60' },
          }),
      ],
      [
        request('https://example.test/error'),
        () =>
          new Response('error', {
            status: 500,
            headers: { 'CDN-Cache-Control': 'max-age=60' },
          }),
      ],
    ]
    for (const [current, makeResponse] of cases) {
      const provider = createBunCache()
      let renders = 0
      const next = async () => {
        renders++
        return makeResponse()
      }
      await run(provider, current, next)
      await run(provider, current, next)
      expect(renders).toBe(2)
    }
  })

  test('invalidates exact paths and tags, including an in-flight response', async () => {
    const provider = createBunCache()
    let renders = 0
    const tagged = async () => cacheable(`render-${++renders}`, 60, 0, { 'Cache-Tag': 'post:1' })
    await run(provider, request('https://example.test/post?preview=0'), tagged)
    await provider.invalidate({ path: '/post?preview=0' })
    expect(
      await (await run(provider, request('https://example.test/post?preview=0'), tagged)).text(),
    ).toBe('render-2')
    await provider.invalidate({ tags: 'post:1' })
    expect(
      await (await run(provider, request('https://example.test/post?preview=0'), tagged)).text(),
    ).toBe('render-3')

    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const flight = run(provider, request('https://example.test/race'), async () => {
      await pending
      return cacheable(`render-${++renders}`)
    })
    await provider.invalidate({ path: '/race' })
    release()
    await flight
    await run(provider, request('https://example.test/race'), tagged)
    expect(renders).toBe(5)
  })

  test('bounds entry count and body size', async () => {
    const provider = createBunCache({
      maxEntries: 1,
      maxBytes: 8,
      maxBodyBytes: 8,
    })
    let renders = 0
    const next = (body: string) => async () => cacheable(`${body}-${++renders}`)
    await run(provider, request('https://example.test/a'), next('a'))
    await run(provider, request('https://example.test/b'), next('b'))
    await run(provider, request('https://example.test/a'), next('a'))
    expect(renders).toBe(3)
    const tooLarge = request('https://example.test/large')
    await run(provider, tooLarge, next('this-is-too-large'))
    await run(provider, tooLarge, next('this-is-too-large'))
    expect(renders).toBe(5)
  })

  test('returns a never-ending response after its cache-read deadline without storing it', async () => {
    const provider = createBunCache({ maxCacheBodyTimeMs: 5 })
    let renders = 0
    const next = async () => {
      renders++
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        headers: { 'CDN-Cache-Control': 'max-age=60' },
      })
    }
    const started = performance.now()
    const first = await run(provider, request(), next)
    expect(performance.now() - started).toBeLessThan(100)
    void first.body?.cancel()
    const second = await run(provider, request(), next)
    void second.body?.cancel()
    expect(renders).toBe(2)
  })

  test('passes through an oversized streamed response without caching its body', async () => {
    const provider = createBunCache({ maxBodyBytes: 4 })
    let renders = 0
    const next = async () => {
      renders++
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('too-large'))
            controller.close()
          },
        }),
        { headers: { 'CDN-Cache-Control': 'max-age=60' } },
      )
    }
    expect(await (await run(provider, request(), next)).text()).toBe('too-large')
    expect(await (await run(provider, request(), next)).text()).toBe('too-large')
    expect(renders).toBe(2)
  })

  test('starts a new origin request after invalidation instead of joining the obsolete flight', async () => {
    const provider = createBunCache()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const old = run(provider, request(), async () => {
      await pending
      return cacheable('old')
    })
    await provider.invalidate({ path: '/page' })
    expect(await (await run(provider, request(), async () => cacheable('new'))).text()).toBe('new')
    release()
    await old
    expect(await (await run(provider, request(), async () => cacheable('wrong'))).text()).toBe(
      'new',
    )
  })

  test('keeps stale content after failed refresh but evicts it after a successful unsafe refresh', async () => {
    const originalNow = Date.now
    let now = 1_000
    Date.now = () => now
    try {
      const failed = createBunCache()
      await run(failed, request(), async () => cacheable('stale', 1, 10))
      now += 1_001
      const jobs: Promise<unknown>[] = []
      expect(
        await (
          await run(
            failed,
            request(),
            async () => new Response('failed', { status: 500 }),
            (job) => jobs.push(job),
          )
        ).text(),
      ).toBe('stale')
      await Promise.all(jobs)
      expect(
        await (
          await run(failed, request(), async () => new Response('failed', { status: 500 }))
        ).text(),
      ).toBe('stale')

      const unsafe = createBunCache()
      await run(unsafe, request(), async () => cacheable('stale', 1, 10))
      now += 1_001
      const unsafeJobs: Promise<unknown>[] = []
      const unsafeResponse = () =>
        new Response('unsafe', {
          headers: { 'CDN-Cache-Control': 'max-age=60', 'Cache-Control': 'no-cache' },
        })
      expect(
        await (
          await run(
            unsafe,
            request(),
            async () => unsafeResponse(),
            (job) => unsafeJobs.push(job),
          )
        ).text(),
      ).toBe('stale')
      await Promise.all(unsafeJobs)
      expect(await (await run(unsafe, request(), async () => unsafeResponse())).text()).toBe(
        'unsafe',
      )
    } finally {
      Date.now = originalNow
    }
  })

  test('expires live providers through the public helpers', async () => {
    const provider = createBunCache()
    let renders = 0
    const next = async () => cacheable(`render-${++renders}`)
    const helpers = request('https://example.test/helpers')
    await run(provider, helpers, next)
    await expirePath('/helpers')
    expect(await (await run(provider, helpers, next)).text()).toBe('render-2')
    await expireAll()
    expect(await (await run(provider, helpers, next)).text()).toBe('render-3')
  })
})
