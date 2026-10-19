let counter = 0

export const GET = () => new Response(String(++counter))
