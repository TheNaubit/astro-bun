<h1 align="center">
  astro-bun
  <br>
</h1>

<h4 align="center">A Bun-native adapter for Astro 7 static pages, SSR, and opt-in ISR.</h4>

<p align="center">
  <a href="https://github.com/TheNaubit/astro-bun/actions/workflows/ci.yml">
    <img src="https://github.com/TheNaubit/astro-bun/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status">
  </a>
  <a href="https://github.com/TheNaubit/astro-bun/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/TheNaubit/astro-bun?style=flat" alt="license">
  </a>
</p>

<p align="center">
  <a href="#requirements">Requirements</a> •
  <a href="#installation">Installation</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#rendering">Rendering</a> •
  <a href="#isr">ISR</a> •
  <a href="#deployment">Deployment</a> •
  <a href="#development">Development</a> •
  <a href="#contribute">Contribute</a>
</p>

## Requirements

- Astro `>=7.4.0 <8`
- Bun `>=1.4.3`

This adapter supports Astro 7 only. Astro's build tooling still needs a runtime supported by Astro; Bun runs the built production server.

## Installation

`@nauverse/astro-bun` is private and unpublished. Link a local checkout while developing against it:

```bash
git clone git@github.com:TheNaubit/astro-bun.git
cd astro-bun
bun install --frozen-lockfile --ignore-scripts
bun run build
bun link
```

In the Astro application:

```bash
bun link @nauverse/astro-bun
```

## Configuration

Start with Astro's default static output and opt individual pages into SSR as needed:

```ts
import { defineConfig } from 'astro/config'
import bun from '@nauverse/astro-bun'

export default defineConfig({
  output: 'static',
  adapter: bun(),
})
```

Pages are generated at build time by default. Add `export const prerender = false`
to pages that need SSR (see [the example below](#static-site-with-selected-ssr-pages)).
If most routes need SSR, choose `output: 'server'` instead and opt static pages
into prerendering with `export const prerender = true`.

`bun()` starts in standalone mode. It emits a Bun server entrypoint that listens
only when executed directly. `bun({ mode: 'handler' })` emits the same
entrypoint without listening on import, for hosts that call its exported
`handler` or `start` functions themselves.

### Adapter options

```ts
adapter: bun({
  // Default: true. Generates Brotli and gzip representations for compressible
  // static text assets. The server negotiates Accept-Encoding at request time.
  compress: true,

  // Default: public, max-age=0, must-revalidate. Route-level Astro headers
  // take precedence. Hashed Astro assets remain immutable for one year.
  staticCacheControl: 'public, max-age=3600, must-revalidate',

  // Default: 10 MiB. Must be a positive safe integer.
  maxRequestBodySize: 10 * 1024 * 1024,

  // Default: one process. Multiple workers require Linux and a fixed TCP port.
  workers: 1,
  shutdownTimeoutMs: 10_000,

  server: {
    // These are the build-configured defaults. At runtime, HOST and PORT take
    // precedence; explicit start() arguments take precedence over both.
    hostname: 'localhost',
    port: 4321,
    idleTimeout: 10,
    reusePort: false,
    lowMemoryMode: false,

    // Use `unix` instead of hostname/port/reusePort for a Unix-domain socket.
    // unix: '/run/astro-bun.sock',

    // TLS files are opened by Bun at runtime. TLS_CERT_PATH and TLS_KEY_PATH
    // override these paths together.
    // tls: { certPath: '/run/secrets/cert.pem', keyPath: '/run/secrets/key.pem' },

    // Only these direct peers may supply X-Forwarded-For. Addresses and
    // non-catch-all IPv4/IPv6 CIDRs are accepted.
    // trustedProxies: ['127.0.0.1', '2001:db8::/32'],
  },
})
```

`unix` cannot be combined with `hostname`, `port`, or `reusePort`. The adapter
does not trust forwarded client addresses unless the direct peer matches
`trustedProxies`; it then walks `X-Forwarded-For` from right to left, skipping
trusted proxy hops. Avoid a catch-all proxy CIDR.

`start(overrides)` accepts the same `server` fields. Explicit `start()` TCP,
Unix, and TLS fields override environment and configured fields. Without an
explicit override, `HOST`/`PORT` override Astro's configured TCP host/port;
`UNIX` overrides the configured socket; and `TLS_CERT_PATH` plus
`TLS_KEY_PATH` override configured TLS as a complete pair. Astro's default
configured host is `localhost`. The TLS environment pair must be complete.

## Rendering

### Static site with selected SSR pages

Use `output: 'static'` (Astro's default) when most pages should be generated at
build time and only selected pages need SSR:

```ts
import { defineConfig } from 'astro/config'
import bun from '@nauverse/astro-bun'

export default defineConfig({
  output: 'static',
  adapter: bun(),
})
```

Opt each page that needs SSR into on-demand rendering:

```astro
---
export const prerender = false;
const renderedAt = new Date().toISOString();
---

<p>Rendered on demand at {renderedAt}</p>
```

Other pages remain prerendered. Build and run the application with:

```bash
bun --bun astro build
bun dist/server/entry.mjs
```

The Bun server serves the generated static files and renders the SSR routes.
A running server is still required for SSR; a static-only host cannot execute
those routes. If every page is prerendered, you can omit the adapter and deploy
Astro's generated static output without a production server.

### Static pages in a server-rendered site

With `output: 'server'`, use Astro's prerender flag for a static page:

```astro
---
export const prerender = true;
---

<h1>Static page</h1>
```

The adapter writes a build-time allowlist for generated public files and route
aliases. The runtime serves only entries in that manifest through `Bun.file`,
preserving Astro route headers, native ranges, and ETags for conditional
requests. It emits Brotli and gzip variants for compressible static text assets
unless `compress: false`; negotiation sets `Vary: Accept-Encoding` and uses a
representation-specific ETag. A range request uses identity when acceptable.

### SSR

With `output: 'server'`, routes render on demand unless they opt into
prerendering. The server uses `Bun.serve` and Astro's server entrypoint. It
passes Bun's direct peer address to Astro by default. A forwarded address is
used only when the direct peer is explicitly trusted as described above.

## ISR

ISR applies to on-demand routes. With static output, opt the page into SSR
and set its cache policy with Astro's cache API:

```astro
---
export const prerender = false;
Astro.cache.set({ maxAge: 60, swr: 300, tags: ["posts"] });
---

<h1>Posts</h1>
```

You can configure the equivalent policy with Astro route rules. With static
output, the matching pages must still export `prerender = false`:

```ts
export default defineConfig({
  output: 'static',
  adapter: bun(),
  routeRules: { '/blog/[...slug]': { maxAge: 60, swr: 300, tags: ['posts'] } },
})
```

Regeneration is request-driven: the first request renders, fresh entries are reused,
and requests within the stale window receive the previous result while one regeneration
runs in the background. After that window, a request waits for a fresh render.
Use `context.cache.invalidate({ tags: ['posts'] })` or an exact path including its query
string from an authenticated endpoint to invalidate local entries.

For a cache invalidation endpoint outside an Astro request context, import the
process-local helpers:

```ts
import { expireAll, expirePath } from '@nauverse/astro-bun/cache'

await expirePath('/blog/example?draft=0')
await expireAll()
```

They invalidate all live providers in the current process. In a multi-process
deployment with persistence, application-level coordination is still required
to notify each machine.

You can tune the in-process tier with:

```ts
adapter: bun({
  cache: {
    maxEntries: 1_000,
    maxBytes: 64 * 1024 * 1024,
    maxBodyBytes: 1024 * 1024,
    maxInflight: 100,
    maxCacheBodyTimeMs: 1_000,
  },
})
```

These are the defaults. The byte limits refer to cached response bodies, not
HTTP headers or process RSS. SSR routes without an explicit shared-cache policy
continue streaming normally. Event streams and responses with any `Vary`
header bypass storage. Cached pages must be public and independent of request
headers or client IP.

Astro's configured image endpoint is the one exception to the shared-cache
directive requirement: its own public `max-age` policy is accepted for that
exact endpoint only. Image cache keys preserve custom query parameters, while
the known Astro transformation parameters are normalized. Lookalike paths and
ordinary browser-cached responses are not promoted into ISR. Server-island
responses always bypass ISR.

The adapter installs its cache provider only when the project has not configured one. Pass `cache: false` to `bun()` to disable that automatic provider; an existing custom Astro cache provider is always respected.

For durable ISR, configure an explicit directory. The adapter embeds a unique
build identity as the default namespace; set `namespace` yourself when your
deployment system has a stable release identifier:

```ts
adapter: bun({
  cache: {
    persistence: {
      directory: '/var/cache/my-app/astro-bun',
      namespace: process.env.DEPLOYMENT_ID,
      maxDiskBytes: 256 * 1024 * 1024,
      maxDiskEntries: 10_000,
      preFillMemory: true,
    },
  },
})
```

The SQLite tier is opt-in. Its logical limits apply to cached response bodies
and entry count across every namespace in that database; SQLite metadata,
WAL, and filesystem allocation mean physical disk use can be larger. Entries
never cross namespaces. The tier uses transactional revision checks to
coordinate processes, and a corrupt or unavailable dedicated database fails
open to SSR while preserving it for diagnosis. It does not make the cache a
replacement for a distributed cache shared across machines.

The provider bypasses storage for credentialed requests and responses that are
private, uncacheable, vary unsafely, or set cookies. Protect any invalidation
endpoint with application authentication and authorization; the adapter does
not add one.

## Deployment

Build an application with Astro, then run the emitted Bun entrypoint:

```bash
bun --bun astro build
bun dist/server/entry.mjs
```

`HOST` and `PORT` configure TCP standalone startup. `PORT` defaults to `4321`;
Astro's default configured host is `localhost`. See the configuration precedence above for
programmatic startup, Unix sockets, and TLS.

On Linux, `workers: N` supervises N Bun processes that share a TCP port through
native `reusePort`. The supervisor restarts unexpectedly exited workers with a
short delay and stops after repeated crashes. This mode rejects port `0` and
Unix sockets. Linux CI exercises multiple workers, replacement after a worker
is killed, the repeated-exit cutoff, and graceful parent shutdown.

Install the application's dependencies in the deployment environment and copy the complete generated `dist/` tree, including both client and server output. The adapter resolves static artifacts relative to the emitted server entrypoint, so the completed build can be moved without retaining build-machine paths. It does not bundle a separate runtime or use a runtime loader hack.

For local production preview, use Astro's standard command through Bun:

```bash
bun --bun astro preview
```

When embedding `handler` in another server, configure that server's request
limits and error boundary. Handler mode does not infer peer or forwarded IP
addresses because the embedding server owns that trust boundary.

Astro session support requires an explicit session driver in the application's Astro configuration. This adapter does not choose a default session driver.

## Integration directory

The package metadata follows [Astro's integration-library guidance](https://docs.astro.build/en/guides/integrations/#integrations-library), including the discovery and adapter-category keywords. The package is still private and unpublished; it is not yet listed. See the [public-release steps](./CONTRIBUTING.md#preparing-a-public-release).

## Development

This repository uses Bun for installation, tests, type checks, and builds.

```bash
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run check
bun test
bun run build
```

The build output is written to `dist/`.

## Contribute

Contributions of any kind are welcome. Please read the [contributing guide](./CONTRIBUTING.md) before opening an issue or pull request.

## License

MIT
