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

async function build(config: object, withoutDynamic: boolean | 'only-dynamic' = false) {
  const workspace = await mkdtemp(join(tmpdir(), 'astro-bun-modes-'))
  workspaces.push(workspace)
  await cp(fixture, workspace, { recursive: true })
  if (withoutDynamic === true) await rm(join(workspace, 'src/pages/dynamic.astro'))
  if (withoutDynamic === 'only-dynamic') {
    await rm(join(workspace, 'src/pages/index.astro'))
    await rm(join(workspace, 'src/pages/about'), { recursive: true })
  }
  await symlink(join(root, 'node_modules'), join(workspace, 'node_modules'), 'dir')
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
