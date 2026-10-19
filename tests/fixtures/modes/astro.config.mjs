import { defineConfig } from 'astro/config';

const adapterURL = process.env.ASTRO_BUN_ADAPTER_URL;
if (!adapterURL) throw new Error('ASTRO_BUN_ADAPTER_URL is required by this fixture');

const { default: bun } = await import(adapterURL);
const options = JSON.parse(process.env.ASTRO_BUN_MODES_CONFIG ?? '{}');

export default defineConfig({
  adapter: bun(options.adapter),
  ...options.astro,
});
