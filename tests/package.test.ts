import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
let workspace: string
let server: Bun.Server<undefined>

async function command(args: string[], cwd = root): Promise<string> {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (status !== 0) throw new Error(stdout + stderr)
  return stdout
}

beforeAll(async () => {
  await command(['bun', 'run', 'build'])
  workspace = await mkdtemp(join(tmpdir(), 'astro-bun-package-'))
  const packed = join(workspace, 'packed')
  const consumer = join(workspace, 'consumer')
  await mkdir(packed)
  await mkdir(join(consumer, 'node_modules/@nauverse'), { recursive: true })
  const result = JSON.parse(
    await command(['npm', 'pack', '--ignore-scripts', '--pack-destination', packed, '--json']),
  ) as Array<{ filename: string }>
  const archive = join(packed, result[0]!.filename)
  const listing = await command(['tar', '-tzf', archive])
  expect(listing).toContain('package/LICENSE')
  expect(listing).toContain('package/README.md')
  expect(listing).toContain('package/dist/index.js')
  expect(listing).toContain('package/dist/cache.js')
  expect(listing).toContain('package/dist/websocket.d.ts')
  expect(listing).not.toContain('package/src/')
  expect(listing).not.toContain('package/tests/')
  await command(['tar', '-xzf', archive], consumer)
  await rename(join(consumer, 'package'), join(consumer, 'node_modules/@nauverse/astro-bun'))
  // Keep the consumer isolated: only its Astro dependency points at the local
  // development dependency tree, while the packed adapter is extracted above.
  await symlink(join(root, 'node_modules/astro'), join(consumer, 'node_modules/astro'), 'dir')
  await command(
    [
      'bun',
      '-e',
      "import { handleWebSocketUpgrade } from '@nauverse/astro-bun/websocket'; if (typeof handleWebSocketUpgrade !== 'function') throw new Error('Missing WebSocket export')",
    ],
    consumer,
  )
  await Bun.write(
    join(consumer, 'astro.config.mjs'),
    `import { defineConfig } from 'astro/config'\nimport bun from '@nauverse/astro-bun'\nexport default defineConfig({ output: 'server', adapter: bun(), routeRules: { '/counter': { maxAge: 60 } } })\n`,
  )
  await mkdir(join(consumer, 'src/pages'), { recursive: true })
  await Bun.write(
    join(consumer, 'src/pages/counter.ts'),
    `import { expirePath } from '@nauverse/astro-bun/cache'\nlet renders = 0\nexport const GET = () => new Response(\`render-\${++renders}\`)\nexport const POST = async () => { await expirePath('/counter'); return new Response('expired') }\n`,
  )
  await command(['bun', '--bun', 'astro', 'build', '--root', consumer])
  const entry = await import(join(consumer, 'dist/server/entry.mjs'))
  server = entry.start({ hostname: '127.0.0.1', port: 0 })
}, 90_000)

afterAll(async () => {
  await server?.stop(true)
  if (workspace) await rm(workspace, { recursive: true, force: true })
})

test('a packed consumer resolves the adapter and invalidates its live ISR cache', async () => {
  const first = await fetch(server.url + 'counter')
  expect(first.headers.get('x-astro-cache')).toBe('MISS')
  expect(await first.text()).toBe('render-1')
  const hit = await fetch(server.url + 'counter')
  expect(hit.headers.get('x-astro-cache')).toBe('HIT')
  expect(await hit.text()).toBe('render-1')
  expect(await (await fetch(server.url + 'counter', { method: 'POST' })).text()).toBe('expired')
  const expired = await fetch(server.url + 'counter')
  expect(expired.headers.get('x-astro-cache')).toBe('MISS')
  expect(await expired.text()).toBe('render-2')
})
