import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = join(root, 'tests/fixtures/framework')
let loadFixture: string
let server: Bun.Server<undefined>
let origin: string

async function command(args: string[]) {
  const child = Bun.spawn(args, {
    cwd: root,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (status !== 0) throw new Error(stdout + stderr)
}

beforeAll(async () => {
  await command(['bun', 'run', 'build'])
  loadFixture = await mkdtemp(join(tmpdir(), 'astro-bun-load-'))
  await cp(fixture, loadFixture, {
    recursive: true,
    filter: (source) => !source.includes('/node_modules') && !source.includes('/dist'),
  })
  await symlink(join(root, 'node_modules'), join(loadFixture, 'node_modules'), 'dir')
  const config = await Bun.file(join(loadFixture, 'astro.config.mjs')).text()
  await Bun.write(
    join(loadFixture, 'astro.config.mjs'),
    config.replace('../../../dist/index.js', new URL('../dist/index.js', import.meta.url).href),
  )
  await mkdir(join(loadFixture, 'src/assets'), { recursive: true })
  await Bun.write(
    join(loadFixture, 'src/assets/pixel.png'),
    Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL5WAAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    ),
  )
  await command(['bun', '--bun', 'astro', 'build', '--root', loadFixture])
  const { start } = await import(join(loadFixture, 'dist/server/entry.mjs'))
  server = start({ hostname: '127.0.0.1', port: 0 })
  origin = server.url.origin
}, 90_000)

afterAll(async () => {
  await server?.stop(true)
  if (loadFixture) await rm(loadFixture, { recursive: true, force: true })
})

const get = (path: string) => fetch(origin + path)

test('coalesces a cold ISR route under concurrent traffic without sharing corrupt bodies', async () => {
  const responses = await Promise.all(Array.from({ length: 80 }, () => get('/load-cache')))
  expect(responses.every((response) => response.status === 200)).toBe(true)
  const bodies = await Promise.all(responses.map((response) => response.text()))
  expect(new Set(bodies)).toEqual(new Set(['load-cache-1']))
  expect(responses.every((response) => response.headers.get('x-astro-cache') === 'MISS')).toBe(true)
  const hit = await get('/load-cache')
  expect(hit.headers.get('x-astro-cache')).toBe('HIT')
  expect(await hit.text()).toBe('load-cache-1')
})

test('sustained mixed concurrent traffic stays correct within configured cache capacity', async () => {
  const rssBefore = process.memoryUsage.rss()
  const failures: string[] = []
  const urls = ['/route-rule', '/methods', '/', '/route-rule?slot=1', '/route-rule?slot=2']
  const started = performance.now()
  for (let batch = 0; batch < 30; batch++) {
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, index) => get(urls[(batch * 40 + index) % urls.length]!)),
    )
    for (const response of responses) {
      const body = await response.text()
      const validBody =
        body.startsWith('route-rule-') || body === 'get' || body.includes('framework fixture')
      if (response.status !== 200 || !validBody) failures.push(`${response.status}:${body}`)
    }
    const nextBatchAt = started + (batch + 1) * 350
    const delay = nextBatchAt - performance.now()
    if (delay > 0) await Bun.sleep(delay)
  }
  expect(failures).toEqual([])
  expect(performance.now() - started).toBeGreaterThanOrEqual(10_000)

  // The fixture sets maxEntries to 3. Four distinct cache keys force eviction;
  // a later request for the original key must render a new, complete response.
  for (const slot of ['3', '4', '5', '6']) await get(`/route-rule?slot=${slot}`)
  const evicted = await get('/route-rule')
  expect(evicted.headers.get('x-astro-cache')).toBe('MISS')
  expect(await evicted.text()).not.toBe('')

  // This is intentionally a broad leak guard, not a throughput or RSS promise.
  const rssAfter = process.memoryUsage.rss()
  expect(Number.isFinite(rssAfter)).toBe(true)
  expect(rssAfter).toBeLessThan(rssBefore + 512 * 1024 * 1024)
}, 30_000)
