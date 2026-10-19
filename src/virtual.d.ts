declare module 'virtual:astro-bun-config' {
  const config: { mode: 'standalone' | 'handler'; maxRequestBodySize: number }
  export default config
}
