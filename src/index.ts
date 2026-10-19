import { realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AstroConfig, AstroIntegration } from 'astro'
import type { BunCacheOptions as CacheOptions } from './cache.js'
import type { AssetManifest } from './static.js'

export interface Options {
  /** Default standalone server; handler mode exports handler without listening. */
  mode?: 'standalone' | 'handler'
  /** Bounded, process-local ISR. Pages must opt in with Astro.cache.set or routeRules. */
  cache?: false | CacheOptions
  maxRequestBodySize?: number
}

export default function bunAdapter(options: Options = {}): AstroIntegration {
  if (options.mode && !['standalone', 'handler'].includes(options.mode))
    throw new Error('Invalid adapter mode')
  const bodyLimit = options.maxRequestBodySize ?? 10 * 1024 * 1024
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1)
    throw new Error('maxRequestBodySize must be a positive integer')
  let config: AstroConfig
  let staticHeaders = new Map<string, Headers>()
  return {
    name: '@nauverse/astro-bun',
    hooks: {
      'astro:config:setup': ({ updateConfig, config: current, command }) => {
        updateConfig({
          build: { redirects: false },
          ...(options.cache !== false && !current.cache?.provider
            ? {
                cache: {
                  provider: {
                    name: 'bun',
                    entrypoint: new URL('./cache.js', import.meta.url),
                    config: options.cache ?? {},
                  },
                },
              }
            : {}),
          image: {
            endpoint: {
              route: current.image.endpoint.route ?? '_image',
              entrypoint:
                current.image.endpoint.entrypoint ??
                (command === 'dev' ? 'astro/assets/endpoint/dev' : 'astro/assets/endpoint/node'),
            },
          },
          vite: {
            plugins: [
              {
                name: 'astro-bun-config',
                configEnvironment(name) {
                  return {
                    define: { __ASTRO_BUN_PRERENDER__: JSON.stringify(name === 'prerender') },
                  }
                },
                resolveId(id) {
                  if (id === 'virtual:astro-bun-config') return '\0' + id
                },
                load(id) {
                  if (id !== '\0virtual:astro-bun-config') return
                  return `export default ${JSON.stringify({ mode: options.mode ?? 'standalone', maxRequestBodySize: bodyLimit })}`
                },
              },
            ],
          },
        })
      },
      'astro:config:done': ({ config: finalConfig, setAdapter }) => {
        config = finalConfig
        const clientPath = fileURLToPath(config.build.client)
        const serverPath = fileURLToPath(config.build.server)
        const clientRoot = resolve(clientPath)
        const serverRoot = resolve(serverPath)
        if (
          clientRoot === serverRoot ||
          clientRoot.startsWith(serverRoot + sep) ||
          serverRoot.startsWith(clientRoot + sep)
        ) {
          throw new Error('Bun adapter client and server output directories must not overlap')
        }
        setAdapter({
          name: '@nauverse/astro-bun',
          entrypointResolution: 'auto',
          serverEntrypoint: new URL('./server.js', import.meta.url),
          previewEntrypoint: new URL('./preview.js', import.meta.url),
          adapterFeatures: {
            buildOutput: 'server',
            middlewareMode: 'classic',
            staticHeaders: true,
            preserveBuildClientDir: true,
            preserveBuildServerDir: true,
          },
          supportedAstroFeatures: {
            staticOutput: 'stable',
            serverOutput: 'stable',
            hybridOutput: 'stable',
            sharpImageService: 'stable',
            envGetSecret: 'stable',
          },
        })
      },
      'astro:build:generated': ({ routeToHeaders }) => {
        staticHeaders = new Map([...routeToHeaders].map(([path, value]) => [path, value.headers]))
      },
      'astro:build:done': async () => {
        const root = await realpath(fileURLToPath(config.build.client))
        const assets: AssetManifest['assets'] = Object.create(null)
        const base = config.base.replace(/\/$/, '')
        for await (const file of new Bun.Glob('**/*').scan({
          cwd: root,
          dot: true,
          onlyFiles: true,
          followSymlinks: false,
        })) {
          const absolute = await realpath(resolve(root, file))
          if (!absolute.startsWith(root + sep))
            throw new Error('Static asset escapes client directory')
          const pathname = base + '/' + file.split('/').map(encodeURIComponent).join('/')
          const blob = Bun.file(absolute)
          const hasher = new Bun.CryptoHasher('sha256')
          for await (const chunk of blob.stream()) hasher.update(chunk)
          const etag = `"${hasher.digest('hex')}"`
          const headers: Record<string, string> = {
            etag: etag,
            'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : blob.type,
            'cache-control': 'public, max-age=0, must-revalidate',
          }
          if (file.startsWith(config.build.assets + '/'))
            headers['cache-control'] = 'public, max-age=31536000, immutable'
          const names = [pathname]
          if (file.endsWith('/index.html') || file === 'index.html') {
            const route = pathname.slice(0, -'index.html'.length)
            names.push(route)
            if (route !== '/') names.push(route.slice(0, -1))
          } else if (config.build.format === 'file' && file.endsWith('.html')) {
            names.push(pathname.slice(0, -5), pathname.slice(0, -5) + '/')
          }
          const routeHeaders = names
            .map(
              (name) =>
                staticHeaders.get(name) ??
                staticHeaders.get(`${name}/`) ??
                staticHeaders.get(name.replace(/\/$/, '')),
            )
            .find(Boolean)
          for (const name of names) {
            const merged = new Headers(headers)
            routeHeaders?.forEach((value, key) => {
              merged.set(key, value)
            })
            if (merged.has('set-cookie'))
              throw new Error('Prerendered pages must not set cookies; use SSR instead')
            assets[name] = {
              file,
              headers: Object.fromEntries(merged),
            }
          }
        }
        const manifest: AssetManifest = {
          client: relative(fileURLToPath(config.build.server), root).split(sep).join('/') + '/',
          base: config.base,
          trailingSlash: config.trailingSlash,
          assets,
        }
        await Bun.write(new URL('bun-assets.json', config.build.server), JSON.stringify(manifest))
      },
    },
  }
}
