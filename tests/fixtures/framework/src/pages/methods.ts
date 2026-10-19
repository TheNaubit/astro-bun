export const GET = () => new Response('get')
export const PUT = async ({ request }) => new Response(`put:${await request.text()}`)
export const DELETE = () => new Response(null, { status: 204 })
