import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  handleWebSocketUpgrade,
  type WebSocketEndpoint,
  type WebSocketUpgrade,
} from '../src/websocket.js'

interface ConnectionData {
  subject: string
}

let server: Bun.Server<ConnectionData>
let origin: string
let authorizationCalls = 0

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket did not open')), 1_000)
    socket.addEventListener('open', () => {
      clearTimeout(timeout)
      resolve()
    })
    socket.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error('WebSocket failed to open'))
    })
  })
}

function receive(socket: WebSocket): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket did not respond')), 1_000)
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timeout)
        resolve(event.data as string | ArrayBuffer)
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timeout)
        reject(new Error('WebSocket failed while waiting for a message'))
      },
      { once: true },
    )
  })
}

function waitForRejection(url: string, headers: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers })
    const timeout = setTimeout(() => reject(new Error('WebSocket rejection timed out')), 1_000)
    socket.addEventListener('open', () => {
      clearTimeout(timeout)
      socket.close()
      reject(new Error('WebSocket unexpectedly opened'))
    })
    socket.addEventListener('close', () => {
      clearTimeout(timeout)
      resolve()
    })
    socket.addEventListener('error', () => {
      // Bun emits error before close for rejected handshakes.
    })
  })
}

beforeAll(() => {
  const endpoint: WebSocketEndpoint<ConnectionData> = {
    async upgrade(request) {
      authorizationCalls++
      await Promise.resolve()
      if (new URL(request.url).searchParams.get('token') !== 'allowed')
        return undefined as unknown as WebSocketUpgrade<ConnectionData>
      const protocols = request.headers
        .get('sec-websocket-protocol')
        ?.split(',')
        .map((protocol) => protocol.trim())
      return {
        data: { subject: 'test-user' },
        headers: protocols?.includes('echo.v1')
          ? { 'sec-websocket-protocol': 'echo.v1', 'x-websocket-endpoint': 'echo' }
          : undefined,
      }
    },
    websocket: {
      open(socket) {
        socket.subscribe('room')
      },
      message(socket, message) {
        socket.send(message)
        if (message === 'room-message') socket.publish('room', message)
      },
    },
  }
  server = Bun.serve<ConnectionData>({
    port: 0,
    websocket: endpoint.websocket,
    async fetch(request, activeServer) {
      const handled = await handleWebSocketUpgrade(request, activeServer, endpoint, {
        path: '/socket',
      })
      if (handled !== false) return handled
      return new Response('Not Found', { status: 404 })
    },
  })
  origin = server.url.origin
})

afterAll(async () => {
  await server.stop(true)
})

describe('native WebSocket endpoint', () => {
  test('echoes text and binary frames after an authorized native upgrade', async () => {
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/socket?token=allowed`)
    socket.binaryType = 'arraybuffer'
    await waitForOpen(socket)
    socket.send('hello')
    expect(await receive(socket)).toBe('hello')
    const binary = Uint8Array.from([1, 2, 3])
    socket.send(binary)
    expect(new Uint8Array((await receive(socket)) as ArrayBuffer)).toEqual(binary)
    socket.close()
  })

  test('passes a selected subprotocol through Bun’s native handshake', async () => {
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/socket?token=allowed`, [
      'echo.v1',
    ])
    await waitForOpen(socket)
    expect(socket.protocol).toBe('echo.v1')
    socket.close()
  })

  test('broadcasts through native Bun pub/sub between authorized clients', async () => {
    const first = new WebSocket(`${origin.replace('http', 'ws')}/socket?token=allowed`)
    const second = new WebSocket(`${origin.replace('http', 'ws')}/socket?token=allowed`)
    await Promise.all([waitForOpen(first), waitForOpen(second)])
    const broadcast = receive(second)
    first.send('room-message')
    expect(await broadcast).toBe('room-message')
    first.close()
    second.close()
  })

  test('rejects cross-origin browsers before calling the authorization hook', async () => {
    const before = authorizationCalls
    await waitForRejection(`${origin.replace('http', 'ws')}/socket?token=allowed`, {
      origin: 'https://attacker.example.test',
    })
    expect(authorizationCalls).toBe(before)
  })

  test('rejects a malformed browser Origin before calling the authorization hook', async () => {
    const before = authorizationCalls
    await waitForRejection(`${origin.replace('http', 'ws')}/socket?token=allowed`, {
      origin: 'https://attacker.example.test/not-an-origin',
    })
    expect(authorizationCalls).toBe(before)
  })

  test('rejects an authorization hook that supplies no connection data', async () => {
    await waitForRejection(`${origin.replace('http', 'ws')}/socket`)
  })

  test('uses explicit allowed origins instead of the same-origin default', async () => {
    const endpoint: WebSocketEndpoint<ConnectionData> = {
      upgrade() {
        return { data: { subject: 'allowlist-user' } }
      },
      websocket: { message() {} },
    }
    const allowedServer = Bun.serve<ConnectionData>({
      port: 0,
      websocket: endpoint.websocket,
      async fetch(request, activeServer) {
        const handled = await handleWebSocketUpgrade(request, activeServer, endpoint, {
          path: '/socket',
          allowedOrigins: ['https://allowed.example.test'],
        })
        return handled === false ? new Response('Not Found', { status: 404 }) : handled
      },
    })
    const allowedOrigin = allowedServer.url.origin
    try {
      await waitForRejection(`${allowedOrigin.replace('http', 'ws')}/socket`, {
        origin: allowedOrigin,
      })
      const socket = new WebSocket(`${allowedOrigin.replace('http', 'ws')}/socket`, {
        headers: { origin: 'https://allowed.example.test' },
      })
      await waitForOpen(socket)
      socket.close()
    } finally {
      await allowedServer.stop(true)
    }
  })

  test('reserves its exact path and reports HTTP upgrade failures clearly', async () => {
    expect((await fetch(`${origin}/socket`)).status).toBe(426)
    expect((await fetch(`${origin}/socket`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${origin}/other`)).status).toBe(404)
  })
})
