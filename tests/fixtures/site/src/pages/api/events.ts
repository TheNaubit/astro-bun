import type { APIRoute } from 'astro'

let cancellations = 0

export const GET: APIRoute = ({ url }) => {
  if (url.searchParams.has('stats')) return Response.json({ cancellations })
  let timer: ReturnType<typeof setTimeout>
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: first\n\n'))
      timer = setTimeout(() => {
        controller.enqueue(new TextEncoder().encode('data: second\n\n'))
        controller.close()
      }, 6_000)
    },
    cancel() {
      clearTimeout(timer)
      cancellations++
    },
  })
  return new Response(body, {
    headers: {
      'content-type': url.searchParams.has('plain') ? 'text/plain' : 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
