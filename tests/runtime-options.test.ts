import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTrustedProxyList,
  getClientAddress,
  resolveServerOptions,
  toBunTLS,
  validateServerOptions,
} from '../src/runtime-options.js'

function requestIP(address: string | undefined) {
  return { requestIP: () => (address ? { address, family: 'IPv4' as const, port: 1234 } : null) }
}

test('direct clients cannot spoof X-Forwarded-For', () => {
  const request = new Request('http://example.test', {
    headers: { 'x-forwarded-for': '203.0.113.8' },
  })
  expect(
    getClientAddress(request, requestIP('198.51.100.9'), createTrustedProxyList(['127.0.0.1'])),
  ).toBe('198.51.100.9')
})

test('a trusted proxy supplies the right-most untrusted forwarded client address', () => {
  const request = new Request('http://example.test', {
    headers: { 'x-forwarded-for': '203.0.113.8, 198.51.100.4' },
  })
  expect(
    getClientAddress(request, requestIP('127.0.0.1'), createTrustedProxyList(['127.0.0.0/8'])),
  ).toBe('198.51.100.4')
})

test('trusted proxy hops are skipped when finding the forwarded client', () => {
  const request = new Request('http://example.test', {
    headers: { 'x-forwarded-for': '203.0.113.8, 127.0.0.2' },
  })
  expect(
    getClientAddress(request, requestIP('127.0.0.1'), createTrustedProxyList(['127.0.0.0/8'])),
  ).toBe('203.0.113.8')
})

test('trusted IPv6 proxy hops are skipped when finding the forwarded client', () => {
  const request = new Request('http://example.test', {
    headers: { 'x-forwarded-for': '2001:db8::8, ::1' },
  })
  expect(getClientAddress(request, requestIP('::1'), createTrustedProxyList(['::1']))).toBe(
    '2001:db8::8',
  )
})

test('malformed forwarded values are ignored', () => {
  const request = new Request('http://example.test', {
    headers: { 'x-forwarded-for': '203.0.113.8, not-an-ip' },
  })
  expect(
    getClientAddress(request, requestIP('127.0.0.1'), createTrustedProxyList(['127.0.0.1'])),
  ).toBe('127.0.0.1')
})

test('server options reject unsafe proxy and listen combinations', () => {
  expect(() => validateServerOptions({ trustedProxies: ['0.0.0.0/0'] })).toThrow('catch-all')
  expect(() => validateServerOptions({ trustedProxies: ['reverse-proxy'] })).toThrow('invalid IP')
  expect(() => validateServerOptions({ unix: '/tmp/app.sock', port: 3000 })).toThrow(
    'cannot be combined',
  )
  expect(() => validateServerOptions({ tls: { certPath: '', keyPath: 'key.pem' } })).toThrow(
    'non-empty',
  )
})

test('server defaults, native TLS files, and explicit Unix sockets resolve safely', () => {
  expect(resolveServerOptions(undefined, undefined, {})).toMatchObject({
    hostname: '0.0.0.0',
    port: 4321,
  })
  expect(
    resolveServerOptions({ hostname: 'configured', port: 4321 }, undefined, {
      HOST: 'env',
      PORT: '9876',
    }),
  ).toMatchObject({ hostname: 'env', port: 9876 })
  expect(resolveServerOptions({ port: 4321 }, { port: 7654 }, { PORT: '9876' })).toMatchObject({
    port: 7654,
  })
  expect(
    resolveServerOptions(
      { unix: '/tmp/configured.sock' },
      { hostname: '127.0.0.1', port: 4321 },
      {},
    ),
  ).toMatchObject({ hostname: '127.0.0.1', port: 4321 })
  expect(
    resolveServerOptions({ unix: '/tmp/astro-bun.sock' }, undefined, { PORT: '9999' }),
  ).toEqual({
    unix: '/tmp/astro-bun.sock',
  })
  const tls = toBunTLS({ certPath: 'cert.pem', keyPath: 'key.pem', caPath: 'ca.pem' }, true)
  expect(tls).toMatchObject({ lowMemoryMode: true })
  expect(tls?.cert).toBeInstanceOf(Bun.file('cert.pem').constructor)
})

test('runtime TLS environment values must be complete', () => {
  expect(() => resolveServerOptions(undefined, undefined, { TLS_CERT_PATH: 'cert.pem' })).toThrow(
    'TLS_CERT_PATH and TLS_KEY_PATH',
  )
  expect(
    resolveServerOptions(
      { tls: { certPath: 'configured-cert.pem', keyPath: 'configured-key.pem' } },
      { tls: { certPath: 'override-cert.pem', keyPath: 'override-key.pem' } },
      { TLS_CERT_PATH: 'env-cert.pem', TLS_KEY_PATH: 'env-key.pem' },
    ).tls,
  ).toEqual({ certPath: 'override-cert.pem', keyPath: 'override-key.pem' })
  expect(() => resolveServerOptions(undefined, undefined, { UNIX: '' })).toThrow(
    'UNIX must be a non-empty socket path',
  )
})

test('Bun requestIP enforces proxy trust at the HTTP boundary', async () => {
  const serve = (trustedProxies: string[]) => {
    const trusted = createTrustedProxyList(trustedProxies)
    return Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, server) {
        return new Response(getClientAddress(request, server, trusted))
      },
    })
  }
  const untrusted = serve(['192.0.2.0/24'])
  try {
    const response = await fetch(untrusted.url, { headers: { 'x-forwarded-for': '203.0.113.8' } })
    expect(await response.text()).toBe('127.0.0.1')
  } finally {
    await untrusted.stop(true)
  }
  const trusted = serve(['127.0.0.1'])
  try {
    const response = await fetch(trusted.url, { headers: { 'x-forwarded-for': '203.0.113.8' } })
    expect(await response.text()).toBe('203.0.113.8')
  } finally {
    await trusted.stop(true)
  }
})

test('Bun serves trusted proxy requests over IPv6 when the host supports IPv6', async () => {
  let server: Bun.Server<undefined>
  try {
    const trusted = createTrustedProxyList(['::1'])
    server = Bun.serve({
      hostname: '::1',
      port: 0,
      fetch(request, requestServer) {
        return new Response(getClientAddress(request, requestServer, trusted))
      },
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL') return
    throw error
  }
  try {
    const response = await fetch(server.url, { headers: { 'x-forwarded-for': '2001:db8::8' } })
    expect(await response.text()).toBe('2001:db8::8')
  } finally {
    await server.stop(true)
  }
})

test('Bun serves HTTP over a Unix socket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-bun-unix-'))
  const socket = join(directory, 'server.sock')
  const server = Bun.serve({
    unix: socket,
    fetch() {
      return new Response('unix-ok')
    },
  })
  try {
    const response = await fetch('http://localhost/', { unix: socket })
    expect(await response.text()).toBe('unix-ok')
  } finally {
    await server.stop(true)
    expect(await Bun.file(socket).exists()).toBe(false)
    await rm(directory, { recursive: true, force: true })
  }
})

test('Bun serves TLS from explicitly configured certificate paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-bun-tls-'))
  const certPath = join(directory, 'cert.pem')
  const keyPath = join(directory, 'key.pem')
  const openssl = Bun.spawn(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-subj',
      '/CN=localhost',
      '-days',
      '1',
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  )
  try {
    expect(await openssl.exited).toBe(0)
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls: toBunTLS({ certPath, keyPath }),
      fetch() {
        return new Response('tls-ok')
      },
    })
    try {
      const response = await fetch(server.url, { tls: { rejectUnauthorized: false } })
      expect(await response.text()).toBe('tls-ok')
    } finally {
      await server.stop(true)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('does not mix a partial TLS environment override with a configured key', () => {
  expect(() =>
    resolveServerOptions(
      { tls: { certPath: 'configured.crt', keyPath: 'configured.key' } },
      undefined,
      { TLS_CERT_PATH: 'other.crt' },
    ),
  ).toThrow('configured together')
})
