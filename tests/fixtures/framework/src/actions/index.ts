import { defineAction } from 'astro:actions'

export const server = {
  echo: defineAction({
    handler: async (input) => ({ received: input }),
  }),
  formEcho: defineAction({
    accept: 'form',
    handler: async (input) => ({ received: input.get('message') }),
  }),
}
