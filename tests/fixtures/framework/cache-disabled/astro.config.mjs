import { defineConfig } from 'astro/config'
import bun from '../../../../dist/index.js'

export default defineConfig({
  output: 'server',
  adapter: bun({ cache: false }),
  routeRules: { '/counter': { maxAge: 60 } },
})
