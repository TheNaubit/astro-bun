import { getSecret } from 'astro:env/server'

export async function GET() {
  return new Response(await getSecret('FRAMEWORK_RUNTIME_SECRET'))
}
