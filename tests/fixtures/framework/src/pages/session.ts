export async function GET({ session }) {
  const count = ((await session.get('count')) ?? 0) + 1
  session.set('count', count)
  return new Response(String(count))
}
