let renders = 0

export async function GET() {
  return new Response(`route-rule-${++renders}`)
}
