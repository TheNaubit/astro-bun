import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = join(root, 'tests/fixtures/framework')
let server: Bun.Server<undefined>
let origin: string
let disabledServer: Bun.Server<undefined>
let customProviderServer: Bun.Server<undefined>

async function command(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(args, {
    cwd: root,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', ...env },
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
  // The image fixture is deliberately created as bytes, so Astro's Sharp pipeline
  // handles a real raster source rather than merely copying an SVG.
  await mkdir(join(fixture, 'src/assets'), { recursive: true })
  await Bun.write(
    join(fixture, 'src/assets/pixel.png'),
    Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL5WAAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    ),
  )
  await command(['bun', '--bun', 'astro', 'build', '--root', fixture])
  await command(['bun', '--bun', 'astro', 'build', '--root', join(fixture, 'cache-disabled')])
  await command(['bun', '--bun', 'astro', 'build', '--root', join(fixture, 'custom-provider')])
  const { start } = await import(join(fixture, 'dist/server/entry.mjs'))
  const { start: startDisabled } = await import(
    join(fixture, 'cache-disabled/dist/server/entry.mjs')
  )
  const { start: startCustomProvider } = await import(
    join(fixture, 'custom-provider/dist/server/entry.mjs')
  )
  process.env.FRAMEWORK_RUNTIME_SECRET = 'runtime-only-secret'
  server = start({ hostname: '127.0.0.1', port: 0 })
  disabledServer = startDisabled({ hostname: '127.0.0.1', port: 0 })
  customProviderServer = startCustomProvider({ hostname: '127.0.0.1', port: 0 })
  origin = server.url.origin
}, 90_000)

afterAll(async () => {
  await rm(join(fixture, 'src/assets/pixel.png'), { force: true })
  await server?.stop(true)
  await disabledServer?.stop(true)
  await customProviderServer?.stop(true)
  await rm(join(fixture, 'dist'), { recursive: true, force: true })
  await rm(join(fixture, '.astro'), { recursive: true, force: true })
  await rm(join(fixture, 'cache-disabled/dist'), { recursive: true, force: true })
  await rm(join(fixture, 'cache-disabled/.astro'), { recursive: true, force: true })
  await rm(join(fixture, 'custom-provider/dist'), { recursive: true, force: true })
  await rm(join(fixture, 'custom-provider/.astro'), { recursive: true, force: true })
})

const get = (path: string, init?: RequestInit) => fetch(origin + path, init)

test('uses the built-in Sharp image service for a raster asset', async () => {
  const response = await get('/')
  expect(response.status).toBe(200)
  const html = await response.text()
  const source = html.match(/src="([^"]+)"/)?.[1]
  expect(source).toStartWith('/_image?')
  const image = await get(source!.replaceAll('&amp;', '&'))
  expect(image.status).toBe(200)
  expect(image.headers.get('content-type')).toMatch(/^image\//)
  expect(image.headers.get('x-astro-cache')).toBe('MISS')
  const bytes = new Uint8Array(await image.arrayBuffer())
  expect(bytes.byteLength).toBeGreaterThan(0)
  const cached = await get(source!.replaceAll('&amp;', '&'))
  expect(cached.headers.get('x-astro-cache')).toBe('HIT')
  expect(new Uint8Array(await cached.arrayBuffer())).toEqual(bytes)
})

test('persists session data through an explicit session driver', async () => {
  const first = await get('/session')
  expect(await first.text()).toBe('1')
  const cookie = first.headers.getSetCookie()[0]?.split(';', 1)[0]
  expect(cookie).toStartWith('framework-session=')
  const second = await get('/session', { headers: { cookie: cookie! } })
  expect(await second.text()).toBe('2')
})

test('serves runtime secrets through Astro env without build-time inlining', async () => {
  expect(await (await get('/secret')).text()).toBe('runtime-only-secret')
})

test('runs action RPC and rejects cross-origin form submissions', async () => {
  const rpc = await get('/_actions/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hello' }),
  })
  expect(rpc.status).toBe(200)
  expect(await rpc.text()).toContain('hello')

  const csrf = await get('/action-form?_action=formEcho', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://attacker.example.test',
    },
    body: 'message=blocked',
  })
  expect(csrf.status).toBe(403)

  const sameOrigin = await get('/action-form?_action=formEcho', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin,
    },
    body: 'message=accepted',
  })
  expect(sameOrigin.status).toBe(200)
  expect(await sameOrigin.text()).toContain('accepted')
})

test('streams deferred server islands through SSR', async () => {
  const response = await get('/island')
  expect(response.status).toBe(200)
  const body = await response.text()
  expect(body).toContain('island fallback')
  const island = body.match(/href="([^"]+_server-islands[^"]+)"/)?.[1]
  expect(island).toBeDefined()
  const deferred = await get(island!.replaceAll('&amp;', '&'))
  expect(deferred.status).toBe(200)
  expect(deferred.headers.get('x-astro-cache')).toBe('BYPASS')
  expect(await deferred.text()).toContain('deferred island complete')
  const repeated = await get(island!.replaceAll('&amp;', '&'))
  expect(repeated.status).toBe(200)
  expect(repeated.headers.get('x-astro-cache')).toBe('BYPASS')
  expect(await repeated.text()).toContain('deferred island complete')
})

test('enforces i18n domains and resolves each locale route', async () => {
  const english = await get('/en', { headers: { host: 'en.example.test' } })
  expect(english.status).toBe(200)
  expect(await english.text()).toContain('english domain')
  const french = await get('/fr', { headers: { host: 'fr.example.test' } })
  expect(french.status).toBe(200)
  expect(await french.text()).toContain('french domain')
})

test('applies routeRules through the adapter cache provider', async () => {
  const first = await get('/route-rule')
  expect(first.headers.get('x-astro-cache')).toBe('MISS')
  expect(await first.text()).toBe('route-rule-1')
  const second = await get('/route-rule')
  expect(second.headers.get('x-astro-cache')).toBe('HIT')
  expect(await second.text()).toBe('route-rule-1')
})

test('runs middleware for SSR while prerendered output retains build middleware state', async () => {
  const disabledOrigin = disabledServer.url.origin
  const ssr = await fetch(disabledOrigin + '/middleware-ssr')
  expect(ssr.headers.get('x-framework-middleware')).toBe('runtime')
  expect(await ssr.text()).toContain('ssr middleware: ran')

  const prerendered = await fetch(disabledOrigin + '/middleware-static')
  expect(prerendered.headers.get('x-framework-middleware')).toBe('build')
  expect(await prerendered.text()).toContain('static middleware: ran')
})

test('honors cache false and leaves an application cache provider in control', async () => {
  const disabledOrigin = disabledServer.url.origin
  expect(await (await fetch(disabledOrigin + '/counter')).text()).toBe('1')
  expect(await (await fetch(disabledOrigin + '/counter')).text()).toBe('2')

  const customOrigin = customProviderServer.url.origin
  const first = await fetch(customOrigin + '/counter')
  expect(first.headers.get('x-fixture-custom-cache')).toBe('used')
  expect(await first.text()).toBe('1')
  const second = await fetch(customOrigin + '/counter')
  expect(second.headers.get('x-fixture-custom-cache')).toBe('used')
  expect(await second.text()).toBe('2')
})

test('dispatches API methods and returns method-specific status', async () => {
  expect(await (await get('/methods')).text()).toBe('get')
  expect(await (await get('/methods', { method: 'PUT', body: 'payload' })).text()).toBe(
    'put:payload',
  )
  expect((await get('/methods', { method: 'DELETE' })).status).toBe(204)
})

test('does not keep producing a streaming response after client abort', async () => {
  const controller = new AbortController()
  const response = await get('/abort', { signal: controller.signal })
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first\n')
  controller.abort()
  await expect(reader.read()).rejects.toThrow()
})
