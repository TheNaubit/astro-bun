declare module 'virtual:astro-bun-config' {
  const config: {
    websocket?: { path: string; allowedOrigins?: string[] }
    experimentalDisableStreaming: boolean
    mode: 'standalone' | 'handler'
    workers: number
    shutdownTimeoutMs: number
    maxRequestBodySize: number
    assetManifest: string
    server: import('./runtime-options.js').ServerOptions
  }
  export default config
}

declare module 'virtual:astro-bun-websocket' {
  const endpoint: import('./websocket.js').WebSocketEndpoint<object> | undefined
  export default endpoint
}
