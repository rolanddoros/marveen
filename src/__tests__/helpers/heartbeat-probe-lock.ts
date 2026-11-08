/**
 * Two suites probe the heartbeat agent's own directory in the checkout under test (its name is fixed in the code,
 * config.ts and hooks/sub-inputs.ts, so a probe cannot use another): hook-manifest-sub and hook-sub-switch. vitest
 * runs files in parallel workers, and each suite refuses (or removes) a heartbeat directory it did not create. This
 * lock, an atomic mkdir next to agents/, makes them take turns; `fn` must remove its probe before it returns.
 * Both suites refuse a live install before they get here.
 *
 * A run killed with SIGKILL leaves the lock behind (git-ignored). The holder writes its pid into it; a lock whose pid
 * is no longer alive, or that has no pid file well after its mkdir, is stale and removed (Ron, C3-3b-1 review).
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A lock dir without a pid file older than this is stale: the holder writes the pid right after its mkdir. */
export const PIDLESS_STALE_MS = 10_000

function holderPid(lock: string): number | null {
  try {
    const pid = Number(readFileSync(join(lock, 'pid'), 'utf-8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/** True when the lock is stale. Re-read just before removal, so a fresh holder's lock is not taken. */
function isStale(lock: string): boolean {
  const pid = holderPid(lock)
  if (pid !== null) return !alive(pid)
  try {
    return Date.now() - statSync(lock).mtimeMs > PIDLESS_STALE_MS
  } catch {
    return false
  }
}

export function withHeartbeatProbeLock<T>(agentsBaseDir: string, fn: () => T, timeoutMs = 120_000): T {
  const lock = `${agentsBaseDir}.heartbeat-probe.lock`
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'pid'), String(process.pid))
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
      if (isStale(lock)) {
        rmSync(lock, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error(`heartbeat probe lock still held after ${timeoutMs} ms by a live process: ${lock}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}
