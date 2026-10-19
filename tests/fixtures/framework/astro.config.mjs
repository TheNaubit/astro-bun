import { defineConfig } from 'astro/config'
import bun from '../../../dist/index.js'

export default defineConfig({
  output: 'server',
  site: 'https://en.example.test',
  adapter: bun({
    cache: { maxEntries: 3, maxBytes: 1_024, maxBodyBytes: 512, maxInflight: 2 },
  }),
  session: {
    driver: { entrypoint: new URL('./session-driver.mjs', import.meta.url) },
    cookie: { name: 'framework-session', secure: false },
  },
  env: {
    schema: {
      FRAMEWORK_RUNTIME_SECRET: { context: 'server', access: 'secret', type: 'string' },
    },
  },
  i18n: {
    locales: ['en', 'fr'],
    defaultLocale: 'en',
    domains: { en: 'https://en.example.test', fr: 'https://fr.example.test' },
    routing: { prefixDefaultLocale: false },
  },
  routeRules: {
    '/route-rule': { maxAge: 60, tags: ['route-rule'] },
    '/load-cache': { maxAge: 60, tags: ['load-cache'] },
  },
})
