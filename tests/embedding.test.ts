import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
let workspace: string
let entry: any
let bufferedEntry: any

async function run(args: string[], cwd: string) {
  const child = Bun.spawn(args, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code) throw new Error(out + err)
}

beforeAll(async () => {
  await run(['bun', 'run', 'build'], root)
  workspace = await mkdtemp(join(tmpdir(), 'astro-bun-embedding-'))
  await symlink(join(root, 'node_modules'), join(workspace, 'node_modules'), 'dir')
  await mkdir(join(workspace, 'src/pages'), { recursive: true })
  await Bun.write(
    join(workspace, 'astro.config.mjs'),
    `import {defineConfig} from 'astro/config'; import bun from ${JSON.stringify(pathToFileURL(join(root, 'dist/index.js')).href)}; export default defineConfig({output:'server', adapter:bun({mode:'handler'}), routeRules:{'/identity':{maxAge:60}}})`,
  )
  await Bun.write(
    join(workspace, 'src/pages/identity.ts'),
    `export const GET=({locals})=>new Response(locals.name ?? 'anonymous');`,
  )
  await Bun.write(
    join(workspace, 'src/pages/known404.ts'),
    `export const GET=()=>new Response('intentional missing',{status:404});`,
  )
  await Bun.write(
    join(workspace, 'src/pages/static.astro'),
    `---\nexport const prerender=true;\n---\n<p>static embedding page</p>`,
  )
  await mkdir(join(workspace, 'src/components'), { recursive: true })
  await Bun.write(
    join(workspace, 'src/components/Slow.astro'),
    `---\nawait new Promise(resolve=>setTimeout(resolve,150));\n---\n<span>late content</span>`,
  )
  await Bun.write(
    join(workspace, 'src/pages/buffered.astro'),
    `---\nimport Slow from '../components/Slow.astro';\n---\n<html><body><p>early content</p><Slow /></body></html>`,
  )
  await Bun.write(
    join(workspace, 'src/pages/events.ts'),
    `export const GET=()=>new Response(new ReadableStream({async start(c){c.enqueue(new TextEncoder().encode('data: first\\n\\n'));await new Promise(r=>setTimeout(r,150));c.enqueue(new TextEncoder().encode('data: last\\n\\n'));c.close()}}),{headers:{'content-type':'text/event-stream'}})`,
  )
  await mkdir(join(workspace, 'public/nested/.hidden'), { recursive: true })
  await mkdir(join(workspace, 'public/.well-known'), { recursive: true })
  await Bun.write(join(workspace, 'public/nested/.hidden/token.txt'), 'not public')
  await Bun.write(join(workspace, 'public/.well-known/security.txt'), 'public contact')
  await run(['bun', '--bun', 'astro', 'build'], workspace)
  entry = await import(pathToFileURL(join(workspace, 'dist/server/entry.mjs')).href)
  const configPath = join(workspace, 'astro.config.mjs')
  await Bun.write(
    configPath,
    (await Bun.file(configPath).text())
      .replace("mode:'handler'", "mode:'handler',experimentalDisableStreaming:true")
      .replace("output:'server'", "output:'server',outDir:'./buffered-dist'"),
  )
  await run(['bun', '--bun', 'astro', 'build'], workspace)
  bufferedEntry = await import(
    pathToFileURL(join(workspace, 'buffered-dist/server/entry.mjs')).href
  )
}, 60_000)

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true })
})

test('embedded locals are isolated per request and bypass the adapter ISR cache', async () => {
  const handler = entry.createHandler({
    locals: async (request: Request) => ({ name: new URL(request.url).hash.slice(1) }),
  })
  const anonymous = await entry.handler(new Request('http://localhost/identity'))
  expect(await anonymous.text()).toBe('anonymous')
  expect(anonymous.headers.get('x-astro-cache')).toBe('MISS')
  for (const name of ['alice', 'bob']) {
    const response = await handler(new Request(`http://localhost/identity#${name}`))
    expect(await response.text()).toBe(name)
    expect(response.headers.get('x-astro-cache')).toBe('BYPASS')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('cdn-cache-control')).toBe('no-store')
  }
  const cached = await entry.handler(new Request('http://localhost/identity'))
  expect(await cached.text()).toBe('anonymous')
  expect(cached.headers.get('x-astro-cache')).toBe('HIT')
})

test('embedded fallback runs only for unmatched routes, not Astro 404 responses or static pages', async () => {
  let calls = 0
  const handler = entry.createHandler({
    fallback: () => {
      calls++
      return new Response('external route', { status: 418 })
    },
  })
  expect((await handler(new Request('http://localhost/unknown'))).status).toBe(418)
  const known = await handler(new Request('http://localhost/known404'))
  expect(known.status).toBe(404)
  expect(await known.text()).toBe('intentional missing')
  expect(await (await handler(new Request('http://localhost/static'))).text()).toContain(
    'static embedding page',
  )
  expect(calls).toBe(1)
})

test('embedded locals must resolve to an object', async () => {
  const handler = entry.createHandler({ locals: () => 'invalid' })
  await expect(handler(new Request('http://localhost/identity'))).rejects.toThrow('locals')
})

test('HTML buffering is opt-in and leaves SSE streaming intact', async () => {
  const streamed = await entry.handler(new Request('http://localhost/buffered'))
  const reader = streamed.body.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  expect(first).not.toContain('late content')
  while (!(await reader.read()).done) {}
  const buffered = await bufferedEntry.handler(new Request('http://localhost/buffered'))
  const bufferedReader = buffered.body.getReader()
  expect(new TextDecoder().decode((await bufferedReader.read()).value)).toContain('late content')
  expect((await bufferedReader.read()).done).toBe(true)
  const events = await bufferedEntry.handler(new Request('http://localhost/events'))
  const eventReader = events.body.getReader()
  expect(new TextDecoder().decode((await eventReader.read()).value)).toBe('data: first\n\n')
  expect(new TextDecoder().decode((await eventReader.read()).value)).toBe('data: last\n\n')
  expect((await eventReader.read()).done).toBe(true)
})

test('built manifest excludes hidden files and serves well-known files with date validators', async () => {
  const manifest = await Bun.file(join(workspace, 'dist/server/bun-assets.json')).json()
  expect(Object.keys(manifest.assets).some((path) => path.includes('.hidden'))).toBe(false)
  const hidden = await entry.handler(new Request('http://localhost/nested/.hidden/token.txt'))
  expect(hidden.status).toBe(404)
  const publicFile = await entry.handler(new Request('http://localhost/.well-known/security.txt'))
  expect(await publicFile.text()).toBe('public contact')
  const modified = publicFile.headers.get('last-modified')
  expect(modified).toBeTruthy()
  const unchanged = await entry.handler(
    new Request('http://localhost/.well-known/security.txt', {
      headers: { 'if-modified-since': modified },
    }),
  )
  expect(unchanged.status).toBe(304)
})
