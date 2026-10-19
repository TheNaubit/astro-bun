export const GET = ({ request }) => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('first\n'))
      const timer = setTimeout(() => {
        if (!request.signal.aborted) controller.enqueue(new TextEncoder().encode('late\n'))
        controller.close()
      }, 250)
      request.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        controller.close()
      })
    },
  })
  return new Response(body)
}
