import { expect, test } from 'bun:test'
import { type AssetManifest, createStaticHandler } from '../src/static.js'

const manifest: AssetManifest = {
  client: './',
  base: '/',
  trailingSlash: 'always',
  assets: {
    '/about': { file: 'about/index.html', headers: { etag: '"abc"' } },
    '/about/': { file: 'about/index.html', headers: { etag: '"abc"' } },
  },
}
test('static allowlist does not resolve arbitrary disk paths or inherited object keys', () => {
  const serve = createStaticHandler(manifest, new URL('file:///tmp/build/bun-assets.json'))
  for (const path of ['/constructor', '/toString', '/__proto__', '/%2e%2e/secret', '/%ZZ', '/%00'])
    expect(serve(new Request('http://localhost' + path))).toBeUndefined()
})
test('static route slash redirect is relative and keeps query', () => {
  const serve = createStaticHandler(manifest, new URL('file:///tmp/build/bun-assets.json'))
  expect(serve(new Request('http://localhost/about?q=1'))?.headers.get('location')).toBe(
    '/about/?q=1',
  )
})
test('static routes do not intercept mutations and respect weak validators', () => {
  const serve = createStaticHandler(manifest, new URL('file:///tmp/build/bun-assets.json'))
  expect(serve(new Request('http://localhost/about/', { method: 'POST' }))).toBeUndefined()
  expect(
    serve(new Request('http://localhost/about/', { headers: { 'if-match': '"abc"' } }))?.status,
  ).toBe(200)
  expect(
    serve(
      new Request('http://localhost/about/', {
        headers: { 'if-none-match': '"old", W/"abc"' },
      }),
    )?.status,
  ).toBe(304)
})

test('static responses honor ETag preconditions without caching failed mutations', () => {
  const handler = createStaticHandler(
    {
      ...manifest,
      trailingSlash: 'ignore',
      assets: {
        '/about': {
          file: 'about/index.html',
          headers: {
            etag: 'W/"abc"',
            'cache-control': 'public, max-age=31536000, immutable',
            'content-length': '123',
          },
        },
      },
    },
    new URL('file:///tmp/build/bun-assets.json'),
  )
  expect(
    handler(new Request('http://localhost/about', { headers: { 'if-match': '"abc"' } }))?.status,
  ).toBe(412)
  const failed = handler(
    new Request('http://localhost/about', { headers: { 'if-match': '"other"' } }),
  )!
  expect(failed.headers.get('cache-control')).toBeNull()
  expect(failed.headers.get('content-length')).toBeNull()
  expect(failed.headers.get('etag')).toBe('W/"abc"')
  expect(
    handler(new Request('http://localhost/about', { headers: { 'if-none-match': '"abc"' } }))
      ?.status,
  ).toBe(304)
})

test('static responses honor date validators with RFC precondition precedence', () => {
  const handler = createStaticHandler(
    {
      ...manifest,
      trailingSlash: 'ignore',
      assets: {
        '/about': {
          file: 'about/index.html',
          headers: { etag: '"abc"', 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' },
        },
      },
    },
    new URL('file:///tmp/build/bun-assets.json'),
  )
  expect(
    handler(
      new Request('http://localhost/about', {
        headers: { 'if-unmodified-since': 'Wed, 21 Oct 2015 07:27:59 GMT' },
      }),
    )?.status,
  ).toBe(412)
  expect(
    handler(
      new Request('http://localhost/about', {
        headers: {
          'if-match': '*',
          'if-unmodified-since': 'Wed, 21 Oct 2015 07:27:59 GMT',
        },
      }),
    )?.status,
  ).toBe(200)
  expect(
    handler(
      new Request('http://localhost/about', {
        headers: { 'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT' },
      }),
    )?.status,
  ).toBe(304)
  expect(
    handler(
      new Request('http://localhost/about', {
        headers: {
          'if-none-match': '"other"',
          'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT',
        },
      }),
    )?.status,
  ).toBe(200)
})

test('static handler blocks dot paths except .well-known after the configured base', () => {
  const handler = createStaticHandler(
    {
      ...manifest,
      base: '/docs/',
      assets: {
        '/docs/.hidden': { file: '.hidden', headers: {} },
        '/docs/%2ehidden': { file: '%2ehidden', headers: {} },
        '/docs/.well-known/security.txt': { file: '.well-known/security.txt', headers: {} },
        '/docs/.well-known/%2e%2e/.hidden': { file: '.well-known/%2e%2e/.hidden', headers: {} },
      },
    },
    new URL('file:///tmp/build/bun-assets.json'),
  )
  expect(handler(new Request('http://localhost/docs/.hidden'))).toBeUndefined()
  expect(handler(new Request('http://localhost/docs/%2ehidden'))).toBeUndefined()
  expect(handler(new Request('http://localhost/docs/.well-known/%2e%2e/.hidden'))).toBeUndefined()
  expect(handler(new Request('http://localhost/docs/.well-known/security.txt'))).toBeDefined()
})

test('static handler keeps the base root alias available for canonicalization', () => {
  const handler = createStaticHandler(
    {
      ...manifest,
      base: '/docs/',
      assets: {
        '/docs': { file: 'index.html', headers: { etag: '"root"' } },
        '/docs/': { file: 'index.html', headers: { etag: '"root"' } },
      },
    },
    new URL('file:///tmp/build/bun-assets.json'),
  )
  expect(handler(new Request('http://localhost/docs'))?.status).toBe(308)
  expect(handler(new Request('http://localhost/docs'))?.headers.get('location')).toBe('/docs/')
  expect(handler(new Request('http://localhost/docs/'))?.status).toBe(200)
})
