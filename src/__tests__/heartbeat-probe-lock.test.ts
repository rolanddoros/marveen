/**
 * The test-only lock two suites share for the heartbeat probe directory (helpers/heartbeat-probe-lock.ts). A run
 * killed with SIGKILL leaves the lock behind; the next runs must not wait out the timeout and fail (Ron, C3-3b-1
 * review). Every lock here lives under a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PROJECT_ROOT } from '../config.js'
import { PIDLESS_STALE_MS, withHeartbeatProbeLock } from './helpers/heartbeat-probe-lock.js'

let base: string
let lock: string
beforeEach(() => {
  base = join(mkdtempSync(join(tmpdir(), 'hb-lock-')), 'agents')
  lock = `${base}.heartbeat-probe.lock`
})
afterEach(() => rmSync(join(base, '..'), { recursive: true, force: true }))

/** A pid that has exited (the child ran and was reaped). */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''])
  expect(r.pid).toBeGreaterThan(0)
  return r.pid!
}

describe('heartbeat probe lock', () => {
  it('runs fn under the lock, records the holder pid, and removes the lock after, also on a throw', () => {
    expect(withHeartbeatProbeLock(base, () => {
      expect(readFileSync(join(lock, 'pid'), 'utf-8')).toBe(String(process.pid))
      return 7
    })).toBe(7)
    expect(existsSync(lock)).toBe(false)
    expect(() => withHeartbeatProbeLock(base, () => { throw new Error('inside') })).toThrow('inside')
    expect(existsSync(lock)).toBe(false)
  })

  it('a lock left by a dead process is taken over at once', () => {
    mkdirSync(lock)
    writeFileSync(join(lock, 'pid'), String(deadPid()))
    const t0 = Date.now()
    expect(withHeartbeatProbeLock(base, () => 'ran', 5_000)).toBe('ran')
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(existsSync(lock)).toBe(false)
  })

  it('a lock without a pid file is stale only when it is old', () => {
    mkdirSync(lock)
    expect(() => withHeartbeatProbeLock(base, () => 'ran', 200)).toThrow(/still held after 200 ms by a live process/)
    const old = (Date.now() - PIDLESS_STALE_MS - 5_000) / 1000
    utimesSync(lock, old, old)
    expect(withHeartbeatProbeLock(base, () => 'ran', 5_000)).toBe('ran')
  })

  it('a lock held by a live process is waited for, then times out naming the path', () => {
    mkdirSync(lock)
    writeFileSync(join(lock, 'pid'), String(process.pid))
    expect(() => withHeartbeatProbeLock(base, () => 'ran', 300)).toThrow(`heartbeat probe lock still held after 300 ms by a live process: ${lock}`)
    expect(readFileSync(join(lock, 'pid'), 'utf-8')).toBe(String(process.pid))
  })

  it('the checkout ignores the lock a killed run leaves', () => {
    expect(readFileSync(join(PROJECT_ROOT, '.gitignore'), 'utf-8')).toMatch(/^agents\.heartbeat-probe\.lock\/$/m)
  })
})
