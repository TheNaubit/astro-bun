import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = join(root, 'tests/fixtures/modes')
const adapterURL = pathToFileURL(join(root, 'dist/index.js')).href
let workspaces: string[] = []

async function command(args: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(args, {
    cwd,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${stdout}${stderr}`)
}

async function build(
  config: object,
  withoutDynamic: boolean | 'only-dynamic' = false,
  prepare?: (workspace: string) => Promise<void>,
) {
  const workspace = await mkdtemp(join(tmpdir(), 'astro-bun-modes-'))
  workspaces.push(workspace)
  await cp(fixture, workspace, { recursive: true })
  if (withoutDynamic === true) await rm(join(workspace, 'src/pages/dynamic.astro'))
  if (withoutDynamic === 'only-dynamic') {
    await rm(join(workspace, 'src/pages/index.astro'))
    await rm(join(workspace, 'src/pages/about'), { recursive: true })
  }
  await symlink(join(root, 'node_modules'), join(workspace, 'node_modules'), 'dir')
  await prepare?.(workspace)
  await command(['bun', '--bun', 'astro', 'build'], workspace, {
    ASTRO_BUN_ADAPTER_URL: adapterURL,
    ASTRO_BUN_MODES_CONFIG: JSON.stringify(config),
  })
  return workspace
}

async function start(workspace: string, serverDir = 'dist/server') {
  const entry = await import(pathToFileURL(join(workspace, serverDir, 'entry.mjs')).href)
  return entry.start({ hostname: '127.0.0.1', port: 0 }) as Bun.Server<undefined>
}

beforeAll(async () => {
  await command(['bun', 'run', 'build'], root, {})
}, 60_000)

afterAll(async () => {
  await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })))
})

test('serves a fully prerendered static build', async () => {
  const workspace = await build({ astro: { output: 'static' } }, true)
  const server = await start(workspace)
  try {
    expect(await Bun.file(join(workspace, 'dist/client/about/index.html')).text()).toContain(
      'mode about',
    )
    expect(await (await fetch(server.url + 'about')).text()).toContain('mode about')
    expect(await (await fetch(server.url + 'about/', { method: 'HEAD' })).text()).toBe('')
  } finally {
    await server.stop(true)
  }
}, 60_000)

test('standalone entry starts when executed as the main module', async () => {
  const workspace = await build({ astro: { output: 'static' } }, true)
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const port = probe.port
  await probe.stop(true)
  const child = Bun.spawn(['bun', 'dist/server/entry.mjs'], {
    cwd: workspace,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  try {
    let response: Response | undefined
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/`)
        break
      } catch {
        await Bun.sleep(25)
      }
    }
    if (!response) throw new Error('Standalone server did not start within two seconds')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('mode home')
  } finally {
    child.kill('SIGTERM')
    const code = await Promise.race([child.exited, Bun.sleep(5_000).then(() => undefined)])
    if (code === undefined) {
      child.kill('SIGKILL')
      await child.exited
      expect(code).toBeDefined()
    }
    expect(code).toBe(0)
  }
}, 60_000)

test('serves a static-output project with an explicitly SSR route', async () => {
  const workspace = await build({ astro: { output: 'static' } })
  const server = await start(workspace)
  try {
    const first = await (await fetch(server.url + 'dynamic')).text()
    const second = await (await fetch(server.url + 'dynamic')).text()
    expect(first).toContain('dynamic')
    expect(second).not.toBe(first)
  } finally {
    await server.stop(true)
  }
}, 60_000)

test('honors a non-root base and both trailing-slash policies', async () => {
  for (const trailingSlash of ['always', 'never'] as const) {
    const workspace = await build({ astro: { output: 'server', base: '/docs', trailingSlash } })
    const server = await start(workspace)
    try {
      const canonical = trailingSlash === 'always' ? '/docs/about/' : '/docs/about'
      const alternate = trailingSlash === 'always' ? '/docs/about' : '/docs/about/'
      expect(await (await fetch(server.url + canonical)).text()).toContain('mode about')
      const redirect = await fetch(server.url + alternate + '?from=test', { redirect: 'manual' })
      expect(redirect.status).toBe(308)
      expect(redirect.headers.get('location')).toBe(canonical + '?from=test')
    } finally {
      await server.stop(true)
    }
  }
}, 120_000)

test('serves build.format file output from custom client and server directories', async () => {
  const workspace = await build({
    astro: {
      output: 'server',
      build: { format: 'file', client: './web-assets/', server: './runtime/' },
    },
  })
  const server = await start(workspace, 'dist/runtime')
  try {
    expect(await (await fetch(server.url + 'about')).text()).toContain('mode about')
    expect(await (await fetch(server.url + 'about/')).text()).toContain('mode about')
  } finally {
    await server.stop(true)
  }
}, 60_000)

test('preview rejects unapproved hosts', async () => {
  const workspace = await build({ astro: { output: 'server' } })
  const previewModule = await import(pathToFileURL(join(root, 'dist/preview.js')).href)
  const preview = await previewModule.default({
    host: '127.0.0.1',
    port: 0,
    allowedHosts: [],
    serverEntrypoint: pathToFileURL(join(workspace, 'dist/server/entry.mjs')),
  })
  try {
    const response = await fetch(`http://${preview.host}:${preview.port}/`, {
      headers: { host: 'unapproved.example' },
    })
    expect(response.status).toBe(403)
  } finally {
    await preview.stop()
  }
}, 60_000)

test('handler-mode entry imports without binding a standalone listener', async () => {
  const workspace = await build({ astro: { output: 'server' }, adapter: { mode: 'handler' } })
  const entry = await import(pathToFileURL(join(workspace, 'dist/server/entry.mjs')).href)
  expect(typeof entry.handler).toBe('function')
  const response = await entry.handler(new Request('http://localhost/'))
  expect(await response.text()).toContain('mode home')
}, 60_000)

test('builds an SSR-only site with no prerendered pages', async () => {
  const workspace = await build({ astro: { output: 'server' } }, 'only-dynamic')
  const server = await start(workspace)
  try {
    expect(await (await fetch(server.url + 'dynamic')).text()).toContain('dynamic')
  } finally {
    await server.stop(true)
  }
}, 60_000)

test('rejects overlapping public and server output directories', async () => {
  await expect(
    build({
      astro: { output: 'server', build: { client: './public/', server: './public/server/' } },
    }),
  ).rejects.toThrow('must not overlap')
}, 60_000)

test('build emits native compressed assets and preserves static policy overrides', async () => {
  const workspace = await build(
    { astro: { output: 'static' }, adapter: { staticCacheControl: 'public, max-age=120' } },
    true,
  )
  const server = await start(workspace)
  try {
    const encoded = await fetch(server.url + 'about', { headers: { 'accept-encoding': 'br' } })
    expect(encoded.headers.get('content-encoding')).toBe('br')
    expect(encoded.headers.get('cache-control')).toBe('public, max-age=120')
    expect(encoded.headers.get('x-astro-cache')).toBe('STATIC')
    expect(await encoded.text()).toContain('mode about')
    const plain = await fetch(server.url + 'about', { headers: { 'accept-encoding': 'identity' } })
    expect(plain.headers.has('content-encoding')).toBe(false)
    expect(plain.headers.get('etag')).not.toBe(encoded.headers.get('etag'))
  } finally {
    await server.stop(true)
  }
}, 60_000)

test('build compression can be disabled', async () => {
  const workspace = await build({ astro: { output: 'static' }, adapter: { compress: false } }, true)
  const server = await start(workspace)
  try {
    const response = await fetch(server.url + 'about', { headers: { 'accept-encoding': 'br' } })
    expect(response.headers.has('content-encoding')).toBe(false)
    expect(await response.text()).toContain('mode about')
  } finally {
    await server.stop(true)
  }
}, 60_000)

test.skipIf(process.platform !== 'linux')(
  'supervises multiple Bun workers, replaces an exited worker and shuts down',
  async () => {
    const workspace = await build({ astro: { output: 'server' }, adapter: { workers: 2 } })
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
    const port = probe.port
    await probe.stop(true)
    const child = Bun.spawn(['bun', 'dist/server/entry.mjs'], {
      cwd: workspace,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const seen = new Set<number>()
    async function sample() {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/dynamic`, {
          headers: { connection: 'close' },
        })
        const match = (await response.text()).match(/pid:(\d+)/)
        if (match) seen.add(Number(match[1]))
      } catch {}
    }
    try {
      for (let n = 0; n < 100 && seen.size < 2; n++) {
        await Promise.all(Array.from({ length: 8 }, sample))
        await Bun.sleep(25)
      }
      expect(seen.size).toBe(2)
      const victim = [...seen][0]
      process.kill(victim, 'SIGKILL')
      for (let n = 0; n < 100 && seen.size < 3; n++) {
        await Promise.all(Array.from({ length: 8 }, sample))
        await Bun.sleep(25)
      }
      expect(seen.size).toBeGreaterThanOrEqual(3)
    } finally {
      child.kill('SIGTERM')
      const code = await Promise.race([child.exited, Bun.sleep(12_000).then(() => undefined)])
      if (code === undefined) {
        child.kill('SIGKILL')
        await child.exited
      }
      expect(code).toBe(0)
    }
  },
  60_000,
)

test('supports a nested custom server entrypoint after build', async () => {
  const workspace = await build({
    astro: { output: 'server', build: { serverEntry: 'runtime/start.mjs' } },
  })
  const entry = await import(pathToFileURL(join(workspace, 'dist/server/runtime/start.mjs')).href)
  const server = entry.start({ hostname: '127.0.0.1', port: 0 })
  try {
    expect(await (await fetch(server.url + 'about')).text()).toContain('mode about')
  } finally {
    await server.stop(true)
  }
}, 60_000)

test('native body-size limit rejects an oversized request', async () => {
  const workspace = await build({ astro: { output: 'server' }, adapter: { maxRequestBodySize: 8 } })
  const server = await start(workspace)
  try {
    const response = await fetch(server.url + 'dynamic', {
      method: 'POST',
      body: 'too-large-for-eight-bytes',
    })
    expect(response.status).toBe(413)
  } finally {
    await server.stop(true)
  }
}, 60_000)

test('rejects cookies captured in prerendered output', async () => {
  await expect(
    build({}, false, async (workspace) => {
      await Bun.write(
        join(workspace, 'src/pages/cookie.astro'),
        `---
export const prerender = true
Astro.response.headers.set('set-cookie', 'private-session=fixture')
---
<p>private cookie</p>`,
      )
    }),
  ).rejects.toThrow('Prerendered pages must not set cookies')
}, 60_000)

test('persistent cache survives a built server restart and isolates another build', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-bun-build-cache-'))
  workspaces.push(directory)
  const config = { adapter: { cache: { persistence: { directory } } } }
  const prepare = async (workspace: string) => {
    await Bun.write(
      join(workspace, 'src/pages/persistent.astro'),
      `---
export const prerender = false
Astro.cache.set({ maxAge: 60 })
const id = crypto.randomUUID()
---
<p>{id}</p>`,
    )
  }
  const workspace = await build(config, false, prepare)
  const firstServer = await start(workspace)
  const port = firstServer.port
  let first: string
  try {
    first = await (await fetch(firstServer.url + 'persistent')).text()
  } finally {
    await firstServer.stop(true)
  }
  // A separate process cannot reuse the first server's in-memory provider.
  const script = `const {start}=await import('./dist/server/entry.mjs'); const server=start({hostname:'127.0.0.1',port:${port}}); const response=await fetch(server.url+'persistent'); console.log(JSON.stringify({status:response.headers.get('x-astro-cache'),body:await response.text()})); await server.stop(true);`
  const child = Bun.spawn(['bun', '-e', script], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' })
  const output = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  const restarted = JSON.parse(output)
  expect(restarted.status).toBe('HIT')
  expect(restarted.body).toBe(first!)
  const secondWorkspace = await build(config, false, prepare)
  const secondServer = await start(secondWorkspace)
  try {
    const response = await fetch(secondServer.url + 'persistent')
    expect(response.headers.get('x-astro-cache')).toBe('MISS')
    expect(await response.text()).not.toBe(first!)
  } finally {
    await secondServer.stop(true)
  }
}, 60_000)

test('standalone shutdown drains an active stale revalidation through waitUntil', async () => {
  const workspace = await build({}, false, async (directory) => {
    await Bun.write(
      join(directory, 'src/pages/drain.astro'),
      `---
export const prerender = false
Astro.cache.set({ maxAge: 1, swr: 30 })
await Bun.sleep(500)
await Bun.write(Bun.env.DRAIN_MARKER, 'completed')
---
<p>drain completed</p>`,
    )
  })
  const marker = join(workspace, 'drained.txt')
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const port = probe.port
  await probe.stop(true)
  const child = Bun.spawn(['bun', 'dist/server/entry.mjs'], {
    cwd: workspace,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DRAIN_MARKER: marker },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  try {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await fetch(`http://127.0.0.1:${port}/`)
        ready = true
        break
      } catch {
        await Bun.sleep(25)
      }
    }
    expect(ready).toBe(true)
    const initial = await fetch(`http://127.0.0.1:${port}/drain`)
    expect(initial.headers.get('x-astro-cache')).toBe('MISS')
    await initial.text()
    await rm(marker)
    await Bun.sleep(1_100)
    const stale = await fetch(`http://127.0.0.1:${port}/drain`)
    expect(stale.headers.get('x-astro-cache')).toBe('STALE')
    await stale.text()
    child.kill('SIGTERM')
    const code = await Promise.race([child.exited, Bun.sleep(5_000).then(() => undefined)])
    expect(code).toBe(0)
    expect(await Bun.file(marker).text()).toBe('completed')
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
  }
}, 60_000)
