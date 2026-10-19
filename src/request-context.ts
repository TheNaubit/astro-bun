const key = Symbol.for('@nauverse/astro-bun/private-requests/v1')
const host = globalThis as typeof globalThis & { [key]?: WeakSet<Request> }
const requests = (host[key] ??= new WeakSet<Request>())

export function markRequestPrivate(request: Request): void {
  requests.add(request)
}

export function isRequestPrivate(request: Request): boolean {
  return requests.has(request)
}
