export default () => ({
  name: 'fixture-custom-provider',
  async onRequest(_context, next) {
    const response = await next()
    response.headers.set('x-fixture-custom-cache', 'used')
    return response
  },
})
