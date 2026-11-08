/**
 * Two suites probe the heartbeat agent's own directory in the checkout under test (its name is fixed in the code,
 * config.ts and hooks/sub-inputs.ts, so a probe cannot use another): hook-manifest-sub and hook-sub-switch. vitest
 * runs files in parallel workers, and each suite refuses (or removes) a heartbeat directory it did not create. This
 * lock, an atomic mkdir next to agents/, makes them take turns; `fn` must remove its probe before it returns.
 * Both suites refuse a live install before they get here.
 */
import { mkdirSync, rmdirSync } from 'node:fs'

export function withHeartbeatProbeLock<T>(agentsBaseDir: string, fn: () => T, timeoutMs = 120_000): T {
  const lock = `${agentsBaseDir}.heartbeat-probe.lock`
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
      if (Date.now() > deadline) throw new Error(`heartbeat probe lock still held after ${timeoutMs} ms (a killed run leaves it): ${lock}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  try {
    return fn()
  } finally {
    rmdirSync(lock)
  }
}
