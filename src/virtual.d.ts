declare module 'virtual:astro-bun-config' {
  const config: {
    mode: 'standalone' | 'handler'
    workers: number
    shutdownTimeoutMs: number
    maxRequestBodySize: number
    assetManifest: string
    server: import('./runtime-options.js').ServerOptions
  }
  export default config
}
