// The whisper pidfile and the startup reap of an orphaned whisper (card 58b9aa06 follow-up, Ron 18424 item 2).
//
// The dashboard unit runs with KillMode=process (install-linux.sh: the sub-agent tmux sessions live in its cgroup
// and must survive a dashboard restart). The same mode leaves a running whisper child (large-v3: ~4 GB RSS) alive
// when the dashboard stops. Its stdout pipe went with the old process, so its transcript can never be read, and
// nothing times it out any more; meanwhile the new dashboard starts STT again for the still-pending row (the jobs
// are in memory). Without this module the host briefly runs two whispers, and a stuck orphan is never killed.
//
// The fix, without touching the unit: every whisper run is recorded in a pidfile in the install's store directory
// (pid + the exact argv it was spawned with), cleared when it exits. On startup the dashboard reads the pidfile and,
// if the recorded process is still the SAME whisper, stops it (SIGINT first, so _vtools.py's finally deletes its
// temp .ogg, then SIGKILL after the grace) before any new whisper may start (voice.ts holds the whisper slot for
// the reap). Adopting it instead is not possible: its output pipe is gone.
//
// Identity is the recorded argv after the interpreter (_vtools.py's absolute path, 'transcribe', the file_id, the
// state dir), compared with the end of the live process's argv (sameArgv): a recycled pid belonging to anything
// else is never signalled, only the stale pidfile goes.

import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { logger } from '../logger.js'

export interface WhisperPidRecord { pid: number; argv: string[] }

/** Record a running whisper. Written to a temp name and renamed, mode 0600: a reader never sees half a record. */
export function writeWhisperPidfile(path: string, pid: number, argv: string[]): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ pid, argv } satisfies WhisperPidRecord), { mode: 0o600 })
  renameSync(tmp, path)
}

/** Remove the pidfile, but only while it still records this pid. */
export function clearWhisperPidfile(path: string, pid: number): void {
  const rec = readWhisperPidfile(path)
  if (rec === 'missing' || (rec !== 'invalid' && rec.pid !== pid)) return
  try { unlinkSync(path) } catch (err) { if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err }
}

export function readWhisperPidfile(path: string): WhisperPidRecord | 'missing' | 'invalid' {
  let raw: string
  try { raw = readFileSync(path, 'utf-8') } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'missing'
    return 'invalid'
  }
  try {
    const v = JSON.parse(raw) as Partial<WhisperPidRecord>
    if (!Number.isInteger(v.pid) || (v.pid as number) <= 1) return 'invalid'
    if (!Array.isArray(v.argv) || v.argv.length < 2 || !v.argv.every((a) => typeof a === 'string')) return 'invalid'
    return { pid: v.pid as number, argv: v.argv }
  } catch {
    return 'invalid'
  }
}

export interface WhisperReapDeps {
  /** The live process's argv, or null when it is gone (a zombie has an empty argv: gone too). */
  readArgv(pid: number): string[] | null
  /** Send a signal; a process that is already gone is not an error. */
  signal(pid: number, sig: NodeJS.Signals): void
  sleep(ms: number): Promise<void>
}

export type WhisperReapResult = 'none' | 'stale' | 'killed' | 'survived'

/** Same whisper run: the live argv ENDS with everything the record holds after the interpreter (_vtools.py's
 *  absolute path, 'transcribe', the file_id, the state dir). The interpreter itself is not compared: a shebang or
 *  wrapper in front of the real python rewrites argv[0] (and may add one). `ps -o args=` (no /proc) gives one
 *  space-joined string, compared by its ending. */
export function sameArgv(live: string[], recorded: string[]): boolean {
  const tail = recorded.slice(1)
  if (tail.length === 0 || live.length === 0) return false
  if (live.length > tail.length && tail.every((a, i) => live[live.length - tail.length + i] === a)) return true
  return live.length === 1 && live[0]!.endsWith(` ${tail.join(' ')}`)
}

/** The record has the shape transcribeWithin writes: [interpreter, <vtoolsPath>, 'transcribe', file_id, state dir],
 *  with vtoolsPath the dashboard's own absolute _vtools.py. Anything else (a hand-made or foreign record such as
 *  ["/usr/bin/python3", "605"], whose short tail could match an unrelated process) is never acted on (Ron 18679). */
export function isWhisperRecordShape(rec: WhisperPidRecord, vtoolsPath: string): boolean {
  return isAbsolute(vtoolsPath) && rec.argv.length === 5 && rec.argv[1] === vtoolsPath && rec.argv[2] === 'transcribe'
}

/** Stop the whisper a previous dashboard left running, if the pidfile still names a live process with the
 *  recorded argv. Never throws for a missing, garbled, foreign-shaped or stale pidfile; those are removed. */
export async function reapOrphanWhisper(
  path: string,
  deps: WhisperReapDeps,
  graceMs: number,
  opts: { vtoolsPath: string; pollMs?: number; killWaitMs?: number },
): Promise<WhisperReapResult> {
  const pollMs = opts.pollMs ?? 100
  const killWaitMs = opts.killWaitMs ?? 2_000
  const rec = readWhisperPidfile(path)
  if (rec === 'missing') return 'none'
  const drop = () => { try { unlinkSync(path) } catch { /* already gone */ } }
  if (rec === 'invalid' || rec.pid === process.pid || !isWhisperRecordShape(rec, opts.vtoolsPath)) {
    logger.warn({ path }, 'whisper pidfile unreadable, not in the whisper record shape, or names this process; removed without signalling anything')
    drop()
    return 'stale'
  }
  const isOurs = () => { const a = deps.readArgv(rec.pid); return a !== null && sameArgv(a, rec.argv) }
  if (!isOurs()) {
    logger.info({ pid: rec.pid }, 'whisper pidfile is stale (process gone or the pid now runs something else); removed')
    drop()
    return 'stale'
  }
  const waitGone = async (ms: number) => {
    for (let waited = 0; waited < ms; waited += pollMs) {
      await deps.sleep(pollMs)
      if (!isOurs()) return true
    }
    return !isOurs()
  }
  logger.warn({ pid: rec.pid, graceMs }, 'orphaned whisper from a previous dashboard is still running; stopping it (SIGINT, then SIGKILL after the grace)')
  deps.signal(rec.pid, 'SIGINT')
  if (!(await waitGone(graceMs))) {
    deps.signal(rec.pid, 'SIGKILL')
    if (!(await waitGone(killWaitMs))) {
      logger.error({ pid: rec.pid }, 'orphaned whisper survived SIGKILL; the pidfile is kept for the next start')
      return 'survived'
    }
  }
  drop()
  return 'killed'
}

const HAS_PROC = existsSync('/proc/self/cmdline')

export const defaultWhisperReapDeps: WhisperReapDeps = {
  readArgv(pid) {
    try {
      if (HAS_PROC) {
        const parts = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0')
        if (parts.at(-1) === '') parts.pop()
        return parts.length > 0 ? parts : null
      }
      const out = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'args='], { timeout: 2000, encoding: 'utf-8' }).trim()
      return out ? [out] : null
    } catch {
      return null
    }
  },
  signal(pid, sig) {
    try { process.kill(pid, sig) } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') logger.warn({ pid, sig, code: (err as NodeJS.ErrnoException)?.code }, 'whisper reap: signal failed')
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}
