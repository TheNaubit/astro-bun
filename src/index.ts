import { realpath } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AstroConfig, AstroIntegration } from 'astro'
import type { BunCacheOptions as CacheOptions } from './cache.js'
import { type ServerOptions, validateServerOptions } from './runtime-options.js'
import { compressAsset } from './compression.js'
import type { AssetManifest } from './static.js'

export type AdapterCacheOptions = Omit<CacheOptions, 'persistence' | 'imageEndpointRoute'> & {
  persistence?: Omit<NonNullable<CacheOptions['persistence']>, 'namespace'> & {
    /** Defaults to a unique build identity embedded in the generated app. */
    namespace?: string
  }
}

export interface Options {
  /** Default standalone server; handler mode exports handler without listening. */
  mode?: 'standalone' | 'handler'
  /** Bounded ISR with optional SQLite persistence. Pages require a shared-cache policy. */
  cache?: false | AdapterCacheOptions
  /** Precompress static text assets using native Brotli and gzip. Defaults to true. */
  compress?: boolean
  /** Cache-Control for unhashed public files; route headers take precedence. */
  staticCacheControl?: string
  /** Number of supervised Bun processes. More than one requires Linux. */
  workers?: number
  shutdownTimeoutMs?: number
  server?: ServerOptions
  maxRequestBodySize?: number
  /** Optional native WebSocket endpoint module, bundled with the server. */
  websocket?: {
    entrypoint: string | URL
    /** Exact path relative to Astro's base. @default /ws */
    path?: string
    /** Browser origins allowed to upgrade. Defaults to same origin. */
    allowedOrigins?: string[]
  }
}

export default function bunAdapter(options: Options = {}): AstroIntegration {
  if (options.mode && !['standalone', 'handler'].includes(options.mode))
    throw new Error('Invalid adapter mode')
  validateServerOptions(options.server)
  if (options.websocket) {
    const path = options.websocket.path ?? '/ws'
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      /[?#\\]/.test(path) ||
      new URL(path, 'http://localhost').pathname !== path
    )
      throw new Error('websocket.path must be an exact absolute pathname')
    const entrypoint = options.websocket.entrypoint
    if (!(entrypoint instanceof URL) && (typeof entrypoint !== 'string' || !entrypoint.trim()))
      throw new Error('websocket.entrypoint must identify a local module')
    if (options.websocket.allowedOrigins !== undefined) {
      if (!Array.isArray(options.websocket.allowedOrigins))
        throw new Error('websocket.allowedOrigins must be an array')
      for (const origin of options.websocket.allowedOrigins) {
        const parsed = new URL(origin)
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin)
          throw new Error('websocket.allowedOrigins must contain exact HTTP or HTTPS origins')
      }
    }
  }
  const buildIdentity = crypto.randomUUID()
  const cacheOptions = options.cache === false ? undefined : options.cache
  const { persistence, ...memoryOptions } = cacheOptions ?? {}
  const cacheProviderOptions: CacheOptions = {
    ...memoryOptions,
    ...(persistence
      ? { persistence: { ...persistence, namespace: persistence.namespace ?? buildIdentity } }
      : {}),
  }
  const workers = options.workers ?? 1
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 256)
    throw new Error('workers must be an integer from 1 to 256')
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1)
    throw new Error('shutdownTimeoutMs must be a positive integer')
  if (workers > 1 && options.server?.port === 0)
    throw new Error('Multiple workers require a fixed TCP port')
  if (workers > 1 && options.server?.unix)
    throw new Error('Multiple workers require TCP, not a shared Unix socket')
  const bodyLimit = options.maxRequestBodySize ?? 10 * 1024 * 1024
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1)
    throw new Error('maxRequestBodySize must be a positive integer')
  const staticCacheControl = options.staticCacheControl ?? 'public, max-age=0, must-revalidate'
  new Headers({ 'cache-control': staticCacheControl })
  let websocketEntrypoint: string | undefined
  let config: AstroConfig
  let staticHeaders = new Map<string, Headers>()
  return {
    name: '@nauverse/astro-bun',
    hooks: {
      'astro:config:setup': ({ updateConfig, config: current, command }) => {
        config = current
        if (options.websocket) {
          const entrypoint = new URL(options.websocket.entrypoint, current.root)
          if (entrypoint.protocol !== 'file:')
            throw new Error('websocket.entrypoint must identify a local module')
          websocketEntrypoint = fileURLToPath(entrypoint)
        }
        updateConfig({
          build: { redirects: false },
          ...(options.cache !== false && !current.cache?.provider
            ? {
                cache: {
                  provider: {
                    name: 'bun',
                    entrypoint: new URL('./cache.js', import.meta.url),
                    config: {
                      ...cacheProviderOptions,
                      imageEndpointRoute: `${current.base.replace(/\/$/, '')}/${(current.image.endpoint.route ?? '_image').replace(/^\//, '')}`,
                    },
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
                  if (id === 'virtual:astro-bun-config' || id === 'virtual:astro-bun-websocket')
                    return '\0' + id
                },
                load(id) {
                  if (id === '\0virtual:astro-bun-websocket')
                    return websocketEntrypoint
                      ? `export { default } from ${JSON.stringify(websocketEntrypoint)}`
                      : 'export default undefined'
                  if (id !== '\0virtual:astro-bun-config') return
                  return `export default ${JSON.stringify({ websocket: options.websocket ? { path: config.base.replace(/\/$/, '') + (options.websocket.path ?? '/ws'), allowedOrigins: options.websocket.allowedOrigins } : undefined, mode: options.mode ?? 'standalone', workers, shutdownTimeoutMs, maxRequestBodySize: bodyLimit, server: options.server?.unix ? options.server : { hostname: typeof config.server.host === 'string' ? config.server.host : config.server.host ? '0.0.0.0' : 'localhost', port: config.server.port, ...options.server }, assetManifest: relative(dirname(config.build.serverEntry), 'bun-assets.json').split(sep).join('/') || 'bun-assets.json' })}`
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
            i18nDomains: 'stable',
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
            'cache-control': staticCacheControl,
            'x-astro-cache': 'STATIC',
          }
          if (file.startsWith(config.build.assets + '/'))
            headers['cache-control'] = 'public, max-age=31536000, immutable'
          const encodings =
            options.compress !== false && /\.(?:html|css|js|mjs|svg|json|xml|txt|map)$/i.test(file)
              ? await compressAsset(absolute, config.build.server)
              : undefined
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
            merged.set('x-astro-cache', 'STATIC')
            if (merged.has('set-cookie'))
              throw new Error('Prerendered pages must not set cookies; use SSR instead')
            assets[name] = {
              file,
              encodings,
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
