import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = join(root, 'tests/fixtures/site')
let server: Bun.Server<undefined>
let relocated: string
let origin: string
async function command(args: string[]) {
  const child = Bun.spawn(args, {
    cwd: root,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(out + err)
}
beforeAll(async () => {
  await command(['bun', 'run', 'build'])
  await command(['bun', '--bun', 'astro', 'build', '--root', fixture])
  relocated = await mkdtemp(join(tmpdir(), 'astro-bun-test-'))
  await cp(join(fixture, 'dist'), relocated, { recursive: true })
  // Dependencies remain external; relocation must not retain the original client directory.
  const { symlink } = await import('node:fs/promises')
  await symlink(join(root, 'node_modules'), join(relocated, 'node_modules'), 'dir')
  await rm(join(fixture, 'dist'), { recursive: true })
  const { start } = await import(join(relocated, 'server/entry.mjs'))
  server = start({ hostname: '127.0.0.1', port: 0 })
  origin = server.url.origin
}, 60_000)
afterAll(async () => {
  await server?.stop(true)
  if (relocated) await rm(relocated, { recursive: true, force: true })
})
const get = (path: string, init?: RequestInit) => fetch(origin + path, init)

test('relocated build serves prerendered page, headers, assets and conditional requests', async () => {
  const response = await get('/')
  expect(response.status).toBe(200)
  expect(response.headers.get('x-static-header')).toBe('preserved')
  expect(await response.text()).toContain('Static home')
  const asset = await get('/asset.txt')
  expect(await asset.text()).toBe('native static file\n')
  const cached = await get('/asset.txt', {
    headers: { 'if-none-match': asset.headers.get('etag')! },
  })
  expect(cached.status).toBe(304)
  expect(await cached.text()).toBe('')
  const head = await get('/', { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(await head.text()).toBe('')
})
test('native file responses support byte ranges', async () => {
  const response = await get('/asset.txt', { headers: { range: 'bytes=0-5' } })
  expect(response.status).toBe(206)
  expect(await response.text()).toBe('native')
})
test('SSR renders on every request and preserves HEAD semantics', async () => {
  expect(await (await get('/ssr')).text()).not.toBe(await (await get('/ssr')).text())
  expect(await (await get('/ssr', { method: 'HEAD' })).text()).toBe('')
})
test('SSR handles bodies, multiple cookies and native client address', async () => {
  const response = await get('/api/echo', { method: 'POST', body: 'hello' })
  expect(await response.json()).toEqual({
    text: 'hello',
    clientAddress: '127.0.0.1',
  })
  expect(response.headers.getSetCookie()).toHaveLength(2)
})
test('ISR hits, varies by query, bypasses credentials and invalidates tags', async () => {
  const first = await (await get('/isr')).text()
  expect(await (await get('/isr')).text()).toBe(first)
  expect(await (await get('/isr?variant=2')).text()).not.toBe(first)
  expect(await (await get('/isr', { headers: { cookie: 'session=private' } })).text()).not.toBe(
    first,
  )
  expect(await (await get('/isr', { headers: { authorization: 'Bearer test' } })).text()).not.toBe(
    first,
  )
  await get('/api/invalidate', { method: 'POST' })
  expect(await (await get('/isr')).text()).not.toBe(first)
})
test('ISR serves stale while regenerating', async () => {
  const first = await (await get('/isr?swr=1')).text()
  await Bun.sleep(1100)
  expect(await (await get('/isr?swr=1')).text()).toBe(first)
  let fresh = first
  for (let n = 0; n < 40 && fresh === first; n++) {
    await Bun.sleep(25)
    fresh = await (await get('/isr?swr=1')).text()
  }
  expect(fresh).not.toBe(first)
})
test('SSR streams without waiting for the full body', async () => {
  const response = await get('/api/stream')
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first\n')
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('last\n')
})
test('custom errors and malicious paths do not expose server files', async () => {
  const missing = await get('/missing')
  expect(missing.status).toBe(404)
  expect(await missing.text()).toContain('Custom missing page')
  for (const path of [
    '/entry.mjs',
    '/bun-assets.json',
    '/%2e%2e/server/entry.mjs',
    '/%2f..%2fserver%2fentry.mjs',
    '/%00',
    '/%ZZ',
  ]) {
    const response = await get(path)
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await response.text()).not.toContain('createApp')
  }
})
test('framework cookie responses bypass ISR and redirects retain status', async () => {
  const one = await get('/api/private')
  const two = await get('/api/private')
  expect(one.headers.getSetCookie()).toHaveLength(1)
  expect(two.headers.getSetCookie()).toHaveLength(1)
  expect(await one.text()).not.toBe(await two.text())
  const redirect = await get('/api/redirect', { redirect: 'manual' })
  expect(redirect.status).toBe(302)
  expect(redirect.headers.get('location')).toBe('/ssr')
})
test('SSR exceptions return a custom 500 page without exposing internal details', async () => {
  const response = await get('/api/error')
  expect(response.status).toBe(500)
  const body = await response.text()
  expect(body).toContain('Custom server error')
  expect(body).not.toContain('private-error-marker')
})
