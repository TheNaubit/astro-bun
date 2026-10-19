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
    serve(
      new Request('http://localhost/about/', {
        headers: { 'if-none-match': '"old", W/"abc"' },
      }),
    )?.status,
  ).toBe(304)
})
