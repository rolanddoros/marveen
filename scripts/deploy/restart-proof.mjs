// Step 12-13 of the fork deploy helper: which systemd scope runs the dashboard, and proof that the restart started
// a NEW process that serves (fork deploy-gate plan v3 [V3-4] + addendum A1-2, Ron 17165 C1).
//
// C1: `systemctl show -p A,B,C --value` prints the values in systemd's own order (alphabetical, measured on this
// host: ActiveEnterTimestampMonotonic, InvocationID, MainPID), not in the order of -p. So the properties are read
// WITHOUT --value, as Key=Value lines into a map, and a missing key fails the step. The CET text of
// ActiveEnterTimestamp is never parsed (Date.parse gives NaN on it): the monotonic counter is compared instead.
//
// Nothing here runs a process itself: `run(args) -> { status, stdout }` is systemctl with its arguments, so the
// tests drive a stub that answers in systemd's real order.
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'

export const PROOF_KEYS = Object.freeze(['InvocationID', 'MainPID', 'ActiveEnterTimestampMonotonic'])
export const START_TIMEOUT_MS = 90_000

/** Key=Value lines into a Map; the value is everything after the FIRST '='. Every wanted key must be there. */
export function parseShow(text, keys = PROOF_KEYS) {
  const map = new Map()
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) map.set(line.slice(0, i), line.slice(i + 1))
  }
  const missing = keys.filter((k) => !map.has(k))
  if (missing.length) throw new Error(`systemctl show: missing ${missing.join(', ')}`)
  return map
}

export function scopeArgs(scope) {
  return scope === 'user' ? ['--user'] : []
}

/**
 * The scope in scripts/stop.sh's order: the system unit first (`systemctl cat` sees it from any uid), then the user
 * unit. null: neither, the helper stops before it changes anything.
 */
export function detectScope(run, unit) {
  if (run(['cat', unit]).status === 0) return 'system'
  if (run(['--user', 'cat', unit]).status === 0) return 'user'
  return null
}

/** InvocationID, MainPID and the monotonic start of the unit, by name. A missing or empty InvocationID throws. */
export function snapshot(run, scope, unit) {
  const r = run([...scopeArgs(scope), 'show', '-p', PROOF_KEYS.join(','), unit])
  if (r.status !== 0) throw new Error(`systemctl show ${unit}: exit ${r.status}`)
  const m = parseShow(r.stdout)
  const inv = m.get('InvocationID')
  if (!/^[0-9a-f]{32}$/.test(inv)) throw new Error(`systemctl show ${unit}: InvocationID ${JSON.stringify(inv)} is not usable (old systemd?)`)
  const pid = m.get('MainPID')
  const mono = m.get('ActiveEnterTimestampMonotonic')
  if (!/^[0-9]+$/.test(pid) || !/^[0-9]+$/.test(mono)) throw new Error(`systemctl show ${unit}: MainPID ${JSON.stringify(pid)} / ActiveEnterTimestampMonotonic ${JSON.stringify(mono)} not a number`)
  return { inv, pid: Number(pid), mono: BigInt(mono) }
}

/** Every reason the unit is NOT a new process since `before`; empty when it is (A1-2 (a)). */
export function newProcessFailures(before, after) {
  const out = []
  if (after.inv === before.inv) out.push(`InvocationID unchanged (${after.inv})`)
  if (after.pid === 0) out.push('MainPID is 0')
  else if (after.pid === before.pid) out.push(`MainPID unchanged (${after.pid})`)
  if (!(after.mono > before.mono)) out.push(`ActiveEnterTimestampMonotonic did not grow (${before.mono} -> ${after.mono})`)
  return out
}

const ANSI = /\x1b\[[0-9;]*m/g
const START_RE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) ([+-])(\d{2})(\d{2})\] INFO \((\d+)\): Web dashboard: http:\/\/localhost:(\d+)$/

/** One pino-pretty start line (web.ts), colours stripped: its UTC ms and pid, or null. */
export function parseStartLine(line) {
  const m = START_RE.exec(String(line).replace(ANSI, '').replace(/\r$/, ''))
  if (!m) return null
  const [, Y, Mo, D, h, mi, s, ms, sign, oh, om, pid, port] = m
  const local = Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +s, +ms)
  const offset = (sign === '-' ? -1 : 1) * (+oh * 60 + +om) * 60_000
  return { ts: local - offset, pid: Number(pid), port: Number(port) }
}

/**
 * The start line of THIS restart in `text` (the log after OFF0): the new pid and a time no earlier than the second
 * of T0 (the log is ms-exact, T0 is taken before the restart). An older line fails twice: before OFF0, other pid.
 */
export function findStartLine(text, { pid, t0 }) {
  const floor = Math.floor(t0 / 1000) * 1000
  for (const line of String(text).split('\n')) {
    const p = parseStartLine(line)
    if (p && p.pid === pid && p.ts >= floor) return p
  }
  return null
}

/** The log from byte OFF0 on; a log shorter than OFF0 was rotated, so it is read from the start. */
export function readLogSince(file, off0) {
  let size
  try {
    size = statSync(file).size
  } catch {
    return ''
  }
  if (size < off0) return readFileSync(file, 'utf8')
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(size - off0)
    readSync(fd, buf, 0, buf.length, off0)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function logSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/**
 * Wait (at most `timeoutMs`) until (a) the unit is a new process, (b) its start line is in the log after OFF0, and
 * only THEN (c) the API answers 200. Returns { ok: true, after, line } or { ok: false, failed, after }.
 */
export async function waitForStart({ run, scope, unit, before, logFile, off0, t0, apiGet, timeoutMs = START_TIMEOUT_MS, intervalMs = 2000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const deadline = now() + timeoutMs
  let failed = 'never checked'
  let after = null
  for (;;) {
    try {
      after = snapshot(run, scope, unit)
      const f = newProcessFailures(before, after)
      if (f.length) {
        failed = `(a) ${f.join('; ')}`
      } else {
        const line = findStartLine(readLogSince(logFile, off0), { pid: after.pid, t0 })
        if (!line) {
          failed = `(b) no start line for pid ${after.pid} after byte ${off0}`
        } else {
          const r = await apiGet()
          if (r.status === 200) return { ok: true, after, line }
          failed = `(c) API answered ${r.status}`
        }
      }
    } catch (e) {
      failed = String(e?.message ?? e)
    }
    if (now() >= deadline) return { ok: false, failed, after }
    await sleep(intervalMs)
  }
}
