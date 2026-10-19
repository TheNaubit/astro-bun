import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compressAsset, selectEncoding } from '../src/compression.js'
import { createStaticHandler, type AssetManifest } from '../src/static.js'

let directory: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bun-compression-'))
})
afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

test('compression negotiation respects qualities, exclusions, wildcards and identity', () => {
  const available = ['br', 'gzip'] as const
  expect(selectEncoding(null, available)).toBe('identity')
  expect(selectEncoding('gzip, br', available)).toBe('br')
  expect(selectEncoding('br;q=0,gzip;q=0.8', available)).toBe('gzip')
  expect(selectEncoding('br;q=0.1,gzip;q=0.9', available)).toBe('gzip')
  expect(selectEncoding('br;q=0,gzip;q=0,identity;q=0', available)).toBeUndefined()
  expect(selectEncoding('*;q=0', available)).toBeUndefined()
  expect(selectEncoding('*;q=0.5,br;q=0', available)).toBe('gzip')
  expect(selectEncoding('gzip;q=0.5,identity;q=1', available)).toBe('identity')
  expect(selectEncoding('gzip;q=invalid', available)).toBe('identity')
})

test('native compression creates valid Brotli/gzip variants with representation validators', async () => {
  const text = '<p>native compressed content</p>'.repeat(200)
  const file = join(directory, 'page.html')
  await Bun.write(file, text)
  const variants = await compressAsset(file, pathToFileURL(directory + '/'))
  expect(variants.br).toBeDefined()
  expect(variants.gzip).toBeDefined()
  for (const [encoding, variant] of Object.entries(variants)) {
    const stream = Bun.file(new URL(variant.file, pathToFileURL(directory + '/'))).stream()
    const decoded = await new Response(
      stream.pipeThrough(new DecompressionStream(encoding === 'br' ? 'brotli' : 'gzip')),
    ).text()
    expect(decoded).toBe(text)
    expect(variant.etag).not.toBe('"identity"')
  }
  const manifest: AssetManifest = {
    client: './',
    base: '/',
    trailingSlash: 'ignore',
    assets: {
      '/page': {
        file: 'page.html',
        headers: { 'content-type': 'text/html', etag: '"identity"' },
        encodings: variants,
      },
    },
  }
  const handler = createStaticHandler(manifest, pathToFileURL(join(directory, 'bun-assets.json')))
  const br = handler(
    new Request('http://localhost/page', { headers: { 'accept-encoding': 'br' } }),
  )!
  expect(br.headers.get('content-encoding')).toBe('br')
  expect(br.headers.get('vary')).toContain('Accept-Encoding')
  expect(
    handler(
      new Request('http://localhost/page', {
        headers: { 'accept-encoding': 'br', 'if-none-match': br.headers.get('etag')! },
      }),
    )!.status,
  ).toBe(304)
  expect(
    handler(
      new Request('http://localhost/page', {
        headers: { 'accept-encoding': 'gzip', 'if-none-match': br.headers.get('etag')! },
      }),
    )!.status,
  ).toBe(200)
  const head = handler(
    new Request('http://localhost/page', {
      method: 'HEAD',
      headers: { 'accept-encoding': 'gzip' },
    }),
  )!
  expect(await head.text()).toBe('')
  expect(head.headers.get('content-encoding')).toBe('gzip')
  expect(
    handler(new Request('http://localhost/page', { headers: { 'accept-encoding': '*;q=0' } }))!
      .status,
  ).toBe(406)
})

test('range requests use identity to preserve native byte-range semantics', async () => {
  const variants = await compressAsset(join(directory, 'page.html'), pathToFileURL(directory + '/'))
  const manifest: AssetManifest = {
    client: './',
    base: '/',
    trailingSlash: 'ignore',
    assets: {
      '/page': { file: 'page.html', headers: { etag: '"identity"' }, encodings: variants },
    },
  }
  const handler = createStaticHandler(manifest, pathToFileURL(join(directory, 'bun-assets.json')))
  const response = handler(
    new Request('http://localhost/page', {
      headers: { 'accept-encoding': 'br, gzip', range: 'bytes=0-5' },
    }),
  )!
  expect(response.headers.has('content-encoding')).toBe(false)
  expect(response.headers.get('etag')).toBe('"identity"')
})

test('no-transform prevents serving a compressed representation', async () => {
  const variants = await compressAsset(join(directory, 'page.html'), pathToFileURL(directory + '/'))
  const manifest: AssetManifest = {
    client: './',
    base: '/',
    trailingSlash: 'ignore',
    assets: {
      '/page': {
        file: 'page.html',
        headers: { etag: '"identity"', 'cache-control': 'public, no-transform' },
        encodings: variants,
      },
    },
  }
  const handler = createStaticHandler(manifest, pathToFileURL(join(directory, 'bun-assets.json')))
  const response = handler(
    new Request('http://localhost/page', { headers: { 'accept-encoding': 'br, gzip' } }),
  )!
  expect(response.headers.has('content-encoding')).toBe(false)
  expect(response.headers.get('etag')).toBe('"identity"')
  expect(await response.text()).toContain('native compressed content')
  expect(
    handler(
      new Request('http://localhost/page', { headers: { 'accept-encoding': 'br, identity;q=0' } }),
    )!.status,
  ).toBe(406)
})
