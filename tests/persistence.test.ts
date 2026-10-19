import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createBunCache from '../src/cache.js'

const logger = { info() {}, warn() {}, error() {} }
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

async function cacheDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'astro-bun-isr-'))
  temporaryDirectories.push(directory)
  return directory
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await Bun.file(path).exists()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${path}`)
}

async function waitForChild(child: Bun.Subprocess): Promise<void> {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`Child exited ${exitCode}: ${stdout}${stderr}`)
}

function request(path = '/page'): Request {
  return new Request(`https://example.test${path}`)
}

function cacheable(body: string, headers?: HeadersInit): Response {
  return new Response(body, {
    headers: { 'CDN-Cache-Control': 'max-age=60', ...headers },
  })
}

async function run(
  provider: ReturnType<typeof createBunCache>,
  current: Request,
  next: () => Promise<Response>,
): Promise<Response> {
  return provider.onRequest!({ request: current, url: new URL(current.url), logger }, next)
}

function persistent(directory: string, extra = {}) {
  return {
    persistence: { directory, namespace: 'deploy-2026-10-19', maxDiskBytes: 1024, ...extra },
  }
}

describe('durable Bun ISR cache', () => {
  test('survives a process restart without crossing deployment namespaces', async () => {
    const directory = await cacheDirectory()
    const first = createBunCache(persistent(directory))
    expect(await (await run(first, request(), async () => cacheable('persisted'))).text()).toBe(
      'persisted',
    )

    const restarted = createBunCache(persistent(directory))
    let renders = 0
    expect(
      await (await run(restarted, request(), async () => cacheable(`origin-${++renders}`))).text(),
    ).toBe('persisted')
    expect(renders).toBe(0)

    const newDeploy = createBunCache({
      persistence: { directory, namespace: 'deploy-next', maxDiskBytes: 1024 },
    })
    expect(
      await (await run(newDeploy, request(), async () => cacheable(`origin-${++renders}`))).text(),
    ).toBe('origin-1')
  })

  test('synchronizes cross-process invalidation and rejects an obsolete write', async () => {
    const directory = await cacheDirectory()
    const a = createBunCache(persistent(directory))
    const b = createBunCache(persistent(directory))
    await run(a, request('/post'), async () => cacheable('old', { 'Cache-Tag': 'post:1' }))
    expect(await (await run(b, request('/post'), async () => cacheable('unexpected'))).text()).toBe(
      'old',
    )

    await b.invalidate({ tags: 'post:1' })
    let renders = 0
    expect(
      await (await run(a, request('/post'), async () => cacheable(`new-${++renders}`))).text(),
    ).toBe('new-1')

    let started!: () => void
    let release!: () => void
    const startedPromise = new Promise<void>((resolve) => (started = resolve))
    const releasePromise = new Promise<void>((resolve) => (release = resolve))
    const obsolete = run(a, request('/race'), async () => {
      started()
      await releasePromise
      return cacheable('obsolete')
    })
    await startedPromise
    await b.invalidate({ path: '/race' })
    release()
    await obsolete
    expect(
      await (await run(b, request('/race'), async () => cacheable(`new-${++renders}`))).text(),
    ).toBe('new-2')
  })

  test('a warmed L1 in another Bun process observes SQLite WAL invalidation', async () => {
    const directory = await cacheDirectory()
    const seed = createBunCache(persistent(directory))
    await run(seed, request('/post'), async () => cacheable('old'))

    const ready = join(directory, 'reader-ready')
    const continuePath = join(directory, 'reader-continue')
    const result = join(directory, 'reader-result')
    const cacheModule = new URL('../src/cache.ts', import.meta.url).href
    const readerProgram = `
      const { default: createBunCache } = await import(${JSON.stringify(cacheModule)})
      const [directory, ready, continuePath, result] = process.argv.slice(1)
      const provider = createBunCache({ persistence: { directory, namespace: 'deploy-2026-10-19', maxDiskBytes: 1024 } })
      const request = new Request('https://example.test/post')
      const context = { request, url: new URL(request.url), logger: { info() {}, warn() {}, error() {} } }
      const run = (next) => provider.onRequest(context, next)
      await (await run(async () => new Response('unexpected', { headers: { 'CDN-Cache-Control': 'max-age=60' } }))).text()
      await Bun.write(ready, 'ready')
      while (!(await Bun.file(continuePath).exists())) await Bun.sleep(10)
      const response = await run(async () => new Response('fresh-origin', { headers: { 'CDN-Cache-Control': 'max-age=60' } }))
      await Bun.write(result, await response.text())
    `
    const reader = Bun.spawn(
      [process.execPath, '-e', readerProgram, directory, ready, continuePath, result],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    try {
      await waitForFile(ready)

      const invalidatorProgram = `
      const { default: createBunCache } = await import(${JSON.stringify(cacheModule)})
      const [directory] = process.argv.slice(1)
      const provider = createBunCache({ persistence: { directory, namespace: 'deploy-2026-10-19', maxDiskBytes: 1024 } })
      await provider.invalidate({ path: '/post' })
    `
      const invalidator = Bun.spawn([process.execPath, '-e', invalidatorProgram, directory], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      await waitForChild(invalidator)
      await Bun.write(continuePath, 'continue')
      await waitForChild(reader)
      expect(await Bun.file(result).text()).toBe('fresh-origin')
    } finally {
      reader.kill()
      await reader.exited
    }
  }, 15_000)

  test('uses the global disk budget and only invalidates an exact pathname', async () => {
    const directory = await cacheDirectory()
    const writer = createBunCache(persistent(directory, { maxDiskBytes: 5 }))
    await run(writer, request('/post'), async () => cacheable('aaaa'))
    await run(writer, request('/other/post'), async () => cacheable('bbbb'))
    await writer.invalidate({ path: '/post' })

    const restarted = createBunCache(persistent(directory, { maxDiskBytes: 5 }))
    let renders = 0
    expect(
      await (
        await run(restarted, request('/other/post'), async () => cacheable(`origin-${++renders}`))
      ).text(),
    ).toBe('bbbb')
    expect(
      await (
        await run(restarted, request('/post'), async () => cacheable(`origin-${++renders}`))
      ).text(),
    ).toBe('origin-1')
  })

  test('fails open to SSR when its dedicated database is corrupt', async () => {
    const directory = await cacheDirectory()
    await writeFile(join(directory, 'astro-bun-isr.sqlite'), 'not a sqlite database')
    const provider = createBunCache(persistent(directory))
    expect(
      await (await run(provider, request(), async () => cacheable('safe-origin'))).text(),
    ).toBe('safe-origin')
    let renders = 1
    expect(
      await (
        await run(provider, request(), async () => cacheable(`safe-origin-${++renders}`))
      ).text(),
    ).toBe('safe-origin-2')
  })

  test('accepts standards-based s-maxage as explicit opt-in', async () => {
    const provider = createBunCache()
    let renders = 0
    const next = async () =>
      new Response(`origin-${++renders}`, { headers: { 'Cache-Control': 's-maxage=60' } })
    await run(provider, request(), next)
    expect(await (await run(provider, request(), next)).text()).toBe('origin-1')
  })

  test('does not treat browser max-age as shared-cache permission', async () => {
    const provider = createBunCache()
    let renders = 0
    const next = async () =>
      new Response(`origin-${++renders}`, { headers: { 'Cache-Control': 'max-age=60' } })
    await run(provider, request(), next)
    expect(await (await run(provider, request(), next)).text()).toBe('origin-2')
  })
})
