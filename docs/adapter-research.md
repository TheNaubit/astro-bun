# Astro Bun adapter research

Date: 2026-10-19

This note records a read-only review of the five repositories named for this
project. It is a design reference, not source material: this adapter is an
independent implementation and must not copy their code.

## Compatibility target

The current Astro package release is 7.4.0. The adapter targets Astro 7 only,
with Bun 1.4.3 as its runtime baseline. Astro's build tooling still requires
its supported Node version; Bun is the production server runtime.

## Repositories inspected

| Repository                                                                                                    | Commit inspected                           | License                                          | Astro peer range or stated support | Findings                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [NuroDev/astro-bun](https://github.com/NuroDev/astro-bun)                                                     | `cc739a819b0faa473c09966d9ee41fb12a45aefc` | MIT                                              | `^5.1.1`                           | Bun.serve and static output support, but obsolete for Astro 7. It uses runtime filesystem resolution and exposes error stacks in its Bun error handler. |
| [wyattjoh/astro-bun-adapter](https://github.com/wyattjoh/astro-bun-adapter)                                   | `d18236c642f51b5531d058de180be57b02dc30c6` | MIT                                              | package manifest `^7.1.3`          | Most complete static manifest and persistent ISR implementation. Its runtime dependencies increase supply-chain surface.                                |
| [ido-pluto/astro-bun-adapter](https://github.com/ido-pluto/astro-bun-adapter)                                 | `083b787f59aed18505061066021316cfc58af201` | MIT                                              | `^4.0.7`                           | Early minimal Bun.serve adapter; no longer compatible target.                                                                                           |
| [Zastinian/astro-bun](https://github.com/Zastinian/astro-bun)                                                 | `ce1c237fda1da45010ec8a19a823e3f324fa3ea8` | MIT                                              | `^5.0.0`                           | Adds Unix-socket and server settings, but is obsolete for Astro 7.                                                                                      |
| [ScaliirDigital/root packages/astro-bun](https://github.com/ScaliirDigital/root/tree/main/packages/astro-bun) | `0f453e0105625d9455fe41b2976862a61272c9dc` | BSD-3-Clause; derived portions identified as MIT | `^6.3.0`                           | Bun-native rewrite with static compression and a persistent SWR cache. Its package is not Astro-7 compatible.                                           |

The first four repositories are MIT licensed. The Scaliir package is
BSD-3-Clause and its own license identifies MIT-derived portions. This project
must retain a clean-room implementation and attribute neither code nor copied
text unless a future deliberate reuse is reviewed for license compliance.

## Issues reviewed

- [NuroDev #14](https://github.com/NuroDev/astro-bun/issues/14):
  `server.requestIP()` returns no address for Unix sockets. Do not invent a
  client address from forwarding headers. Support proxy headers only under an
  explicit trusted-proxy configuration.
- [NuroDev #2](https://github.com/NuroDev/astro-bun/issues/2): server-render
  failures do not consistently use the built 500 page. Keep error handling
  intentional, do not send runtime exception stacks to clients, and test the
  production 500 path.
- [wyattjoh #17](https://github.com/wyattjoh/astro-bun-adapter/issues/17):
  generated production builds were not relocatable because runtime paths came
  from build-machine absolute manifest paths. Runtime artifacts must resolve
  from the emitted entrypoint location.
- [ScaliirDigital/root #54](https://github.com/ScaliirDigital/root/issues/54):
  `Astro.clientAddress` was absent. Pass `server.requestIP(request)?.address`
  to the Astro request handler when available, including non-cache requests.

## Design conclusions

### Static output

Generate a build-time manifest of allowed public files and route aliases. At
runtime, serve static files only after an exact manifest lookup. This avoids a
pathname-to-filesystem fallback and the traversal, encoded-separator, and
normalization hazards that it creates. Static responses should support GET and
HEAD correctly, ETag/304, appropriate content type, and immutable cache
headers for Astro's hashed assets. Preserve Astro route headers over adapter
defaults. Resolve all artifact directories relative to the emitted server
entrypoint so a copied `dist` directory remains runnable.

### SSR

Use `Bun.serve` with a Fetch handler and invoke Astro's supported server
entrypoint APIs. Configure runtime environment access through Astro's supported
environment setup. Pass the direct peer IP from Bun only when Bun provides it.
Keep error responses generic in production and log details server-side.

### ISR

Use Astro 7's official `CacheProvider` API rather than route-module rewriting
or virtual-module runtime patches. The provider should be process-local and
bounded by bytes, with cache entries keyed by the complete request variant that
can affect rendering. Cache only explicitly cacheable responses and reject
`private`, `no-store`, `Set-Cookie`, and unsupported `Vary` responses. Model
freshness and stale-while-revalidate from HTTP cache directives, coalesce
concurrent renders for the same key, and safely discard failed revalidations.
This first implementation should avoid durable cache persistence until its
atomic-write, corruption, cross-process, and deployment semantics are tested.

### Native Bun features

Prefer `Bun.serve`, `Bun.file`, `Bun.write`, and `Bun.CryptoHasher` where the
runtime needs those capabilities. Avoid bringing runtime packages solely for
MIME lookup, hashing, cache-control parsing, serialization, or logging.
Use platform APIs for request/response headers and standard Web Fetch types.

## Validation priorities

1. Astro 7 builds and runs after its `dist` output is copied to another path.
2. Static pages, nested clean URLs, hashed assets, 404 and 500 paths, HEAD,
   ETag/304, and route-level headers are verified against a running Bun server.
3. SSR receives cookies, query strings, environment values, and direct client
   address when available.
4. ISR verifies miss, hit, expiry, stale response, background revalidation,
   concurrent-request coalescing, and rejection of unsafe cache responses.
