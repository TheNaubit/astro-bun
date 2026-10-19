import { defineMiddleware } from 'astro:middleware'

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.frameworkMiddleware = 'ran'
  const response = await next()
  response.headers.set('x-framework-middleware', context.isPrerendered ? 'build' : 'runtime')
  return response
})
