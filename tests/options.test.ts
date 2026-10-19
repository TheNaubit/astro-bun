import { expect, test } from 'bun:test'
import adapter from '../src/index.js'
test('adapter rejects invalid modes and request body limits', () => {
  expect(() => adapter({ mode: 'invalid' as 'handler' })).toThrow()
  for (const maxRequestBodySize of [0, -1, NaN, Infinity, 1.5])
    expect(() => adapter({ maxRequestBodySize })).toThrow()
})

test('static cache policy rejects header injection', () => {
  expect(() => adapter({ staticCacheControl: 'public\r\nset-cookie: injected=1' })).toThrow()
})

test('WebSocket configuration requires exact paths, local modules, and explicit origins', () => {
  for (const path of [
    'relative',
    '//other.test/ws',
    '/ws?token=1',
    '/ws#hash',
    '/a/../ws',
    '/ws\\other',
  ]) {
    expect(() => adapter({ websocket: { entrypoint: './socket.ts', path } })).toThrow()
  }
  for (const origin of [
    '*',
    'null',
    'https://example.test/path',
    'https://user@example.test',
    'ftp://example.test',
  ]) {
    expect(() =>
      adapter({ websocket: { entrypoint: './socket.ts', allowedOrigins: [origin] } }),
    ).toThrow()
  }
  expect(() => adapter({ websocket: { entrypoint: '' } })).toThrow()
})
