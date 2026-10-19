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

Configure the adapter with Astro's standard server output:

```ts
import { defineConfig } from 'astro/config'
import bun from '@nauverse/astro-bun'

export default defineConfig({
  output: 'server',
  adapter: bun(),
})
```

`bun()` starts in standalone mode. It emits a Bun server entrypoint that listens only when executed directly. `bun({ mode: "handler" })` emits the same entrypoint without listening on import, for hosts that call its exported `handler` or `start` functions themselves.

The optional `maxRequestBodySize` limits request bodies accepted by Bun. It defaults to 10 MiB and must be a positive integer.

## Rendering

### Static pages

Use Astro's normal prerender flag for a static page:

```astro
---
export const prerender = true;
---

<h1>Static page</h1>
```

The adapter writes a build-time allowlist for generated public files and route aliases. The runtime serves only entries in that manifest through `Bun.file`, preserving Astro route headers and using ETags for conditional requests.

### SSR

With `output: "server"`, routes render on demand unless they opt into prerendering. The server uses `Bun.serve` and Astro's server entrypoint. It passes Bun's direct peer address to Astro when Bun provides one; it does not infer a client address from proxy headers.

## ISR

ISR is opt-in. Set cache policy in a route or page with Astro's cache API:

```astro
---
Astro.cache.set({ maxAge: 60, swr: 300, tags: ["posts"] });
---

<h1>Posts</h1>
```

You can configure the equivalent policy with Astro route rules:

```ts
export default defineConfig({
  output: 'server',
  adapter: bun(),
  routeRules: { '/blog/[...slug]': { maxAge: 60, swr: 300, tags: ['posts'] } },
})
```

Regeneration is request-driven: the first request renders, fresh entries are reused,
and requests within the stale window receive the previous result while one regeneration
runs in the background. After that window, a request waits for a fresh render.
Use `context.cache.invalidate({ tags: ['posts'] })` or an exact path including its query
string from an authenticated endpoint to invalidate local entries.

You can tune the provider with `bun({ cache: { maxEntries: 1000, maxBytes: 67108864,
maxBodyBytes: 1048576, maxInflight: 100, maxCacheBodyTimeMs: 1000 } })`. These are the
defaults: 1,000 entries, 64 MiB of cached body bytes, 1 MiB per body, 100 in-flight cache
operations, and one second to read a cacheable body. SSR routes without cache policy
continue streaming normally. Event streams and responses with any `Vary` header bypass
storage. Cached pages must be public and independent of request headers or client IP.

The adapter installs its cache provider only when the project has not configured one. Pass `cache: false` to `bun()` to disable that automatic provider; an existing custom Astro cache provider is always respected.

The included provider is bounded, process-local, and nonpersistent. Restarting the server clears it. It does not synchronize or invalidate entries across replicas. It bypasses cache storage for credentialed requests and responses that are private, uncacheable, vary unsafely, or set cookies. Protect any invalidation endpoint with your application's authentication and authorization; the adapter does not add an authentication endpoint.

## Deployment

Build an application with Astro, then run the emitted Bun entrypoint:

```bash
bun --bun astro build
bun dist/server/entry.mjs
```

`HOST` and `PORT` configure the standalone server. `PORT` defaults to `4321`; `HOST` defaults to `0.0.0.0`.

Install the application's dependencies in the deployment environment and copy the complete generated `dist/` tree, including both client and server output. The adapter resolves static artifacts relative to the emitted server entrypoint, so the completed build can be moved without retaining build-machine paths. It does not bundle a separate runtime or use a runtime loader hack.

For local production preview, use Astro's standard command through Bun:

```bash
bun --bun astro preview
```

When embedding `handler` in another server, configure that server's request limits and
error boundary. Neither handler mode nor standalone mode trusts forwarded IP headers.

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
