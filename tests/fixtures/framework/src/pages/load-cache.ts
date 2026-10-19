let renders = 0

export async function GET() {
  await Bun.sleep(30)
  return new Response(`load-cache-${++renders}`)
}
