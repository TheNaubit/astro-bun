import { expect, test } from 'bun:test'
import adapter from '../src/index.js'
test('adapter rejects invalid modes and request body limits', () => {
  expect(() => adapter({ mode: 'invalid' as 'handler' })).toThrow()
  for (const maxRequestBodySize of [0, -1, NaN, Infinity, 1.5])
    expect(() => adapter({ maxRequestBodySize })).toThrow()
})
