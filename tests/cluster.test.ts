import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { supervise } from '../src/cluster.js'

let directory: string | undefined

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test.skipIf(process.platform === 'linux')(
  'rejects multi-worker supervision on platforms without Bun reusePort support',
  async () => {
    await expect(
      supervise({ entrypoint: 'unused.mjs', workers: 1, shutdownTimeoutMs: 100 }),
    ).rejects.toThrow('Linux reusePort')
  },
)

test.skipIf(process.platform !== 'linux')(
  'stops after a bounded rate of worker crashes',
  async () => {
    directory = await mkdtemp(join(tmpdir(), 'astro-bun-cluster-'))
    const crash = join(directory, 'crash.mjs')
    await Bun.write(crash, 'process.exit(1)')
    const started = performance.now()
    await expect(
      supervise({ entrypoint: crash, workers: 1, shutdownTimeoutMs: 100 }),
    ).rejects.toThrow('repeatedly exited')
    // Four exits are required for one worker and each restart is delayed by 250ms.
    expect(performance.now() - started).toBeGreaterThanOrEqual(700)
    expect(performance.now() - started).toBeLessThan(5_000)
  },
  10_000,
)
