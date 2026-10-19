import { afterAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AstroConfig } from 'astro'
import adapter from '../src/index.js'

const root = new URL('..', import.meta.url)
const temporaryDirectories: string[] = []
const serverProcesses = new Set<Bun.Subprocess>()

afterAll(async () => {
  for (const process of serverProcesses) process.kill('SIGTERM')
  await Promise.all([...serverProcesses].map((process) => process.exited))
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function setupConfig(session: AstroConfig['session']) {
  const cacheDir = new URL('.astro/', root)
  const config = {
    root,
    cacheDir,
    session,
    base: '/',
    image: { endpoint: {} },
    server: { host: false, port: 4321 },
    build: { serverEntry: join(new URL('.', root).pathname, 'dist/server/entry.mjs') },
  } as AstroConfig
  let update: Record<string, unknown> | undefined
  const messages: string[] = []
  return {
    config,
    messages,
    get update() {
      return update
    },
    updateConfig(value: Record<string, unknown>) {
      update = value
    },
  }
}

async function runSetup(session: AstroConfig['session']) {
  const context = setupConfig(session)
  const integration = adapter()
  const hook = integration.hooks['astro:config:setup']!
  await hook({
    config: context.config,
    command: 'build',
    updateConfig: context.updateConfig,
    logger: {
      info(message: string) {
        context.messages.push(message)
      },
    },
  } as never)
  return context
}

test('configures Astro filesystem sessions by default and keeps cookie and ttl options', async () => {
  const context = await runSetup({
    cookie: { name: 'session-id', secure: false },
    ttl: 60,
  })
  const session = context.update?.session as {
    cookie: { name: string; secure: boolean }
    ttl: number
    driver: { config: { base: string } }
  }
  expect(session.cookie).toEqual({ name: 'session-id', secure: false })
  expect(session.ttl).toBe(60)
  expect(session.driver.config.base).toBe(join(new URL('.astro/', root).pathname, 'sessions'))
  expect(context.messages).toEqual(['Enabling sessions with filesystem storage'])
})

test('does not configure a default driver when sessions are disabled or customized', async () => {
  const disabled = await runSetup(false)
  expect(disabled.update?.session).toBe(false)
  expect(disabled.messages).toEqual([])

  const customDriver = { entrypoint: new URL('./custom-session-driver.mjs', root) }
  const custom = await runSetup({ driver: customDriver })
  expect(custom.update?.session).toEqual({ driver: customDriver })
  expect(custom.messages).toEqual([])
})

test('validates and serializes experimentalDisableStreaming', async () => {
  expect(() => adapter({ experimentalDisableStreaming: 'true' as never })).toThrow(
    'experimentalDisableStreaming must be a boolean',
  )

  const context = setupConfig(undefined)
  const integration = adapter({ experimentalDisableStreaming: true })
  await integration.hooks['astro:config:setup']!({
    config: context.config,
    command: 'build',
    updateConfig: context.updateConfig,
    logger: { info() {} },
  } as never)
  const plugin = (context.update!.vite as { plugins: Array<{ load(id: string): string }> })
    .plugins[0]
  expect(plugin.load('\0virtual:astro-bun-config')).toContain('"experimentalDisableStreaming":true')
})

test('persists default filesystem sessions after a fresh server process restart', async () => {
  const directory = await mkdtemp(join(new URL('tests/', root).pathname, '.session-defaults-'))
  temporaryDirectories.push(directory)
  const adapterEntrypoint = pathToFileURL(join(new URL('.', root).pathname, 'dist/index.js')).href
  await mkdir(join(directory, 'src/pages'), { recursive: true })
  await Bun.write(
    join(directory, 'astro.config.mjs'),
    `import { defineConfig } from 'astro/config'\nimport bun from ${JSON.stringify(adapterEntrypoint)}\nexport default defineConfig({ output: 'server', adapter: bun() })\n`,
  )
  await Bun.write(
    join(directory, 'src/pages/session.ts'),
    `export async function GET({ session }) { const value = ((await session.get('count')) ?? 0) + 1; session.set('count', value); return new Response(String(value)) }\n`,
  )
  await Bun.write(
    join(directory, 'server.mjs'),
    `const { start } = await import('./dist/server/entry.mjs'); const server = start({ hostname: '127.0.0.1', port: 0 }); console.log(server.url.origin); process.on('SIGTERM', () => server.stop(true).then(() => process.exit(0)));\n`,
  )

  const build = Bun.spawn(['bun', 'run', 'build'], {
    cwd: new URL('.', root).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if ((await build.exited) !== 0)
    throw new Error(
      `${await new Response(build.stdout).text()}${await new Response(build.stderr).text()}`,
    )
  const astro = Bun.spawn(['bun', '--bun', 'astro', 'build', '--root', directory], {
    cwd: new URL('.', root).pathname,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if ((await astro.exited) !== 0)
    throw new Error(
      `${await new Response(astro.stdout).text()}${await new Response(astro.stderr).text()}`,
    )

  const start = async () => {
    const child = Bun.spawn(['bun', 'server.mjs'], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    serverProcesses.add(child)
    const reader = child.stdout.getReader()
    const { value } = await reader.read()
    reader.releaseLock()
    const line = new TextDecoder().decode(value).trim()
    if (!line) throw new Error(await new Response(child.stderr).text())
    return { child, origin: line }
  }
  const first = await start()
  const initial = await fetch(first.origin + '/session')
  expect(await initial.text()).toBe('1')
  const cookie = initial.headers.getSetCookie()[0]?.split(';', 1)[0]
  expect(cookie).toBeDefined()
  first.child.kill('SIGTERM')
  await first.child.exited
  serverProcesses.delete(first.child)

  const second = await start()
  const restored = await fetch(second.origin + '/session', { headers: { cookie: cookie! } })
  expect(await restored.text()).toBe('2')
  second.child.kill('SIGTERM')
  await second.child.exited
  serverProcesses.delete(second.child)
}, 90_000)
