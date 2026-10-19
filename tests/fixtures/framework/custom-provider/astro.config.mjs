import { defineConfig } from 'astro/config'
import bun from '../../../../dist/index.js'

export default defineConfig({
  output: 'server',
  adapter: bun(),
  cache: {
    provider: {
      name: 'fixture-custom-provider',
      entrypoint: new URL('./custom-cache.mjs', import.meta.url),
    },
  },
  routeRules: { '/counter': { maxAge: 60 } },
})
