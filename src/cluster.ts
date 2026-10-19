/** Run Bun workers with native reusePort; no Node cluster or runtime code rewriting. */
export async function supervise(options: {
  entrypoint: string
  workers: number
  shutdownTimeoutMs: number
}): Promise<void> {
  if (process.platform !== 'linux')
    throw new Error('Multiple Bun workers require Linux reusePort support')
  const children = new Set<Bun.Subprocess>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let stopping = false
  let failure = false
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const restartTimes: number[] = []
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    for (const timer of timers) clearTimeout(timer)
    for (const child of children) child.kill('SIGTERM')
    const timeout = setTimeout(() => {
      for (const child of children) child.kill('SIGKILL')
    }, options.shutdownTimeoutMs)
    await Promise.allSettled([...children].map((child) => child.exited))
    clearTimeout(timeout)
    resolveDone()
  }
  function spawnWorker(index: number) {
    if (stopping) return
    const child = Bun.spawn([process.execPath, options.entrypoint], {
      env: { ...process.env, ASTRO_BUN_WORKER: String(index + 1) },
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    children.add(child)
    void child.exited.then(() => {
      children.delete(child)
      if (stopping) return
      const now = Date.now()
      while (restartTimes.length && restartTimes[0] < now - 60_000) restartTimes.shift()
      restartTimes.push(now)
      if (restartTimes.length > options.workers * 3) {
        failure = true
        void shutdown()
        return
      }
      const timer = setTimeout(() => {
        timers.delete(timer)
        spawnWorker(index)
      }, 250)
      timers.add(timer)
    })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  try {
    for (let index = 0; index < options.workers; index++) spawnWorker(index)
    await done
  } finally {
    await shutdown()
    process.removeListener('SIGTERM', shutdown)
    process.removeListener('SIGINT', shutdown)
  }
  if (failure) throw new Error('Bun workers repeatedly exited; supervisor stopped')
}
