// Ron 18424 item 2 (card 58b9aa06 follow-up): a dashboard restart under KillMode=process leaves the running whisper
// alive (~4 GB RSS, no timer, its output pipe gone). Pinned here with REAL processes standing in for the orphan:
// - a pidfile naming a live process with the recorded argv: SIGINT first (its finally runs), the pidfile goes;
// - one that ignores SIGINT: SIGKILL after the grace;
// - a recycled pid (live process, other argv), a dead pid, a garbled or missing pidfile: nothing is signalled,
//   the stale file goes;
// - the pidfile helpers: atomic 0600 write, clear only while the record is ours.
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

import {
  reapOrphanWhisper, defaultWhisperReapDeps, writeWhisperPidfile, clearWhisperPidfile, readWhisperPidfile, sameArgv,
  type WhisperReapDeps,
} from '../web/whisper-orphan.js'

const dir = mkdtempSync(join(tmpdir(), 'whisper-orphan-'))
const PIDFILE = join(dir, 'whisper.pid')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const children: ChildProcess[] = []
afterAll(() => { for (const c of children) { try { c.kill('SIGKILL') } catch { /* gone */ } } })

/** A python stand-in for whisper with a recognisable argv tail; writes a mark in its finally (SIGINT runs it). */
async function orphan(opts: { ignoreSigint?: boolean; fileId?: string } = {}) {
  const mark = join(dir, `finally-${children.length}`)
  const script = join(dir, '_vtools.py')
  writeFileSync(script, '# stand-in\n')
  const code = [
    'import signal, sys, time',
    ...(opts.ignoreSigint ? ['signal.signal(signal.SIGINT, signal.SIG_IGN)'] : []),
    'print("up", flush=True)',
    'try:', '    time.sleep(60)', 'finally:', `    open(${JSON.stringify(mark)}, "w").write("ran")`, '',
  ].join('\n')
  const tail = [script, 'transcribe', opts.fileId ?? 'AwACAgIAAxkBAAIBc2', join(dir, 'state')]
  // python3 -c CODE <tail...>: the live argv is [python3, -c, CODE, ...tail], like a wrapper in front of _vtools.py
  const p = spawn('python3', ['-c', code, ...tail], { stdio: ['ignore', 'pipe', 'ignore'] })
  children.push(p)
  await new Promise<void>((r) => p.stdout!.once('data', () => r()))
  return { pid: p.pid!, recorded: ['/opt/venv/bin/python', ...tail], mark, proc: p }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const exited = (p: ChildProcess) => new Promise<void>((r) => { if (p.exitCode !== null || p.signalCode !== null) r(); else p.once('exit', () => r()) })

beforeEach(() => rmSync(PIDFILE, { force: true }))

describe('reapOrphanWhisper with real processes', () => {
  it('a live orphan with the recorded argv gets SIGINT, its finally runs, and the pidfile is removed', async () => {
    const o = await orphan()
    writeWhisperPidfile(PIDFILE, o.pid, o.recorded)
    expect(await reapOrphanWhisper(PIDFILE, defaultWhisperReapDeps, 2_000, { pollMs: 20 })).toBe('killed')
    await exited(o.proc)
    expect(o.proc.signalCode).not.toBe('SIGKILL')
    expect(readFileSync(o.mark, 'utf-8')).toBe('ran') // SIGINT, not SIGKILL: its cleanup ran
    expect(existsSync(PIDFILE)).toBe(false)
  })

  it('an orphan that ignores SIGINT is SIGKILLed after the grace', async () => {
    const o = await orphan({ ignoreSigint: true })
    writeWhisperPidfile(PIDFILE, o.pid, o.recorded)
    const t0 = Date.now()
    expect(await reapOrphanWhisper(PIDFILE, defaultWhisperReapDeps, 300, { pollMs: 20 })).toBe('killed')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280)
    await exited(o.proc)
    expect(o.proc.signalCode).toBe('SIGKILL')
    expect(existsSync(o.mark)).toBe(false)
    expect(existsSync(PIDFILE)).toBe(false)
  })

  it('a recycled pid (live process, different argv) is never signalled; only the stale pidfile goes', async () => {
    const o = await orphan({ fileId: 'OtherFileId0123456' })
    writeWhisperPidfile(PIDFILE, o.pid, ['/opt/venv/bin/python', join(dir, '_vtools.py'), 'transcribe', 'AwACAgIAAxkBAAIBc2', join(dir, 'state')])
    const sent: string[] = []
    const deps: WhisperReapDeps = { ...defaultWhisperReapDeps, signal: (pid, sig) => { sent.push(sig); defaultWhisperReapDeps.signal(pid, sig) } }
    expect(await reapOrphanWhisper(PIDFILE, deps, 200, { pollMs: 20 })).toBe('stale')
    expect(sent).toEqual([])
    expect(alive(o.pid)).toBe(true)
    expect(existsSync(PIDFILE)).toBe(false)
    o.proc.kill('SIGKILL'); await exited(o.proc)
  })

  it('a dead pid is stale: nothing signalled, pidfile removed', async () => {
    const o = await orphan()
    o.proc.kill('SIGKILL'); await exited(o.proc)
    writeWhisperPidfile(PIDFILE, o.pid, o.recorded)
    const sent: string[] = []
    expect(await reapOrphanWhisper(PIDFILE, { ...defaultWhisperReapDeps, signal: (_p, s) => { sent.push(s) } }, 200)).toBe('stale')
    expect(sent).toEqual([])
    expect(existsSync(PIDFILE)).toBe(false)
  })

  it('no pidfile: nothing to do; a garbled one, or one naming this process, is removed without a signal', async () => {
    const sent: string[] = []
    const deps: WhisperReapDeps = { readArgv: () => ['x', 'y'], signal: (_p, s) => { sent.push(s) }, sleep: async () => {} }
    expect(await reapOrphanWhisper(PIDFILE, deps, 100)).toBe('none')
    for (const body of ['not json', '{"pid":1,"argv":["a","b"]}', '{"pid":12345,"argv":["only-one"]}', JSON.stringify({ pid: process.pid, argv: ['x', 'y'] })]) {
      writeFileSync(PIDFILE, body)
      expect(await reapOrphanWhisper(PIDFILE, deps, 100)).toBe('stale')
      expect(existsSync(PIDFILE)).toBe(false)
    }
    expect(sent).toEqual([])
  })

  it('a process that survives SIGKILL is reported and its pidfile kept', async () => {
    writeWhisperPidfile(PIDFILE, 424242, ['py', 'v', 'transcribe'])
    const sent: string[] = []
    const deps: WhisperReapDeps = { readArgv: () => ['python3', 'v', 'transcribe'], signal: (_p, s) => { sent.push(s) }, sleep: async () => {} }
    expect(await reapOrphanWhisper(PIDFILE, deps, 50, { pollMs: 10, killWaitMs: 20 })).toBe('survived')
    expect(sent).toEqual(['SIGINT', 'SIGKILL'])
    expect(existsSync(PIDFILE)).toBe(true)
  })
})

describe('pidfile helpers', () => {
  it('write is atomic (no temp left) and 0600; read returns the record', () => {
    writeWhisperPidfile(PIDFILE, 4321, ['py', 'v.py', 'transcribe', 'id', 'dir'])
    expect(readWhisperPidfile(PIDFILE)).toEqual({ pid: 4321, argv: ['py', 'v.py', 'transcribe', 'id', 'dir'] })
    expect(statSync(PIDFILE).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('clear removes only its own record', () => {
    writeWhisperPidfile(PIDFILE, 4321, ['py', 'v.py'])
    clearWhisperPidfile(PIDFILE, 9999)
    expect(existsSync(PIDFILE)).toBe(true)
    clearWhisperPidfile(PIDFILE, 4321)
    expect(existsSync(PIDFILE)).toBe(false)
    expect(() => clearWhisperPidfile(PIDFILE, 4321)).not.toThrow()
  })

  it('sameArgv compares the tail after the interpreter, and the joined ps form by its ending', () => {
    const rec = ['/v/bin/python', '/v/_vtools.py', 'transcribe', 'FID', '/s']
    expect(sameArgv(['/v/bin/python', '/v/_vtools.py', 'transcribe', 'FID', '/s'], rec)).toBe(true)
    expect(sameArgv(['/usr/bin/python3', '/v/bin/python', '/v/_vtools.py', 'transcribe', 'FID', '/s'], rec)).toBe(true)
    expect(sameArgv(['/v/_vtools.py', 'transcribe', 'FID', '/s'], rec)).toBe(false) // no interpreter in front
    expect(sameArgv(['/v/bin/python', '/v/_vtools.py', 'transcribe', 'OTHER', '/s'], rec)).toBe(false)
    expect(sameArgv(['/v/bin/python /v/_vtools.py transcribe FID /s'], rec)).toBe(true)
    expect(sameArgv(['/v/bin/python /v/_vtools.py transcribe FID /s2'], rec)).toBe(false)
    expect(sameArgv([], rec)).toBe(false)
  })
})
