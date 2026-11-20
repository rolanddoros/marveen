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
const VT = join(dir, '_vtools.py')
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
    expect(await reapOrphanWhisper(PIDFILE, defaultWhisperReapDeps, 2_000, { vtoolsPath: VT, pollMs: 20 })).toBe('killed')
    await exited(o.proc)
    expect(o.proc.signalCode).not.toBe('SIGKILL')
    expect(readFileSync(o.mark, 'utf-8')).toBe('ran') // SIGINT, not SIGKILL: its cleanup ran
    expect(existsSync(PIDFILE)).toBe(false)
  })

  it('an orphan that ignores SIGINT is SIGKILLed after the grace', async () => {
    const o = await orphan({ ignoreSigint: true })
    writeWhisperPidfile(PIDFILE, o.pid, o.recorded)
    const t0 = Date.now()
    expect(await reapOrphanWhisper(PIDFILE, defaultWhisperReapDeps, 300, { vtoolsPath: VT, pollMs: 20 })).toBe('killed')
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
    expect(await reapOrphanWhisper(PIDFILE, deps, 200, { vtoolsPath: VT, pollMs: 20 })).toBe('stale')
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
    expect(await reapOrphanWhisper(PIDFILE, { ...defaultWhisperReapDeps, signal: (_p, s) => { sent.push(s) } }, 200, { vtoolsPath: VT })).toBe('stale')
    expect(sent).toEqual([])
    expect(existsSync(PIDFILE)).toBe(false)
  })

  it('no pidfile: nothing to do; a garbled one, or one naming this process, is removed without a signal', async () => {
    const sent: string[] = []
    const deps: WhisperReapDeps = { readArgv: () => ['x', 'y'], signal: (_p, s) => { sent.push(s) }, sleep: async () => {} }
    expect(await reapOrphanWhisper(PIDFILE, deps, 100, { vtoolsPath: VT })).toBe('none')
    for (const body of ['not json', '{"pid":1,"argv":["a","b"]}', '{"pid":12345,"argv":["only-one"]}', JSON.stringify({ pid: process.pid, argv: ['x', 'y'] })]) {
      writeFileSync(PIDFILE, body)
      expect(await reapOrphanWhisper(PIDFILE, deps, 100, { vtoolsPath: VT })).toBe('stale')
      expect(existsSync(PIDFILE)).toBe(false)
    }
    expect(sent).toEqual([])
  })

  it('a process that survives SIGKILL is reported and its pidfile kept', async () => {
    writeWhisperPidfile(PIDFILE, 424242, ['py', VT, 'transcribe', 'F', 'S'])
    const sent: string[] = []
    const deps: WhisperReapDeps = { readArgv: () => ['python3', VT, 'transcribe', 'F', 'S'], signal: (_p, s) => { sent.push(s) }, sleep: async () => {} }
    expect(await reapOrphanWhisper(PIDFILE, deps, 50, { vtoolsPath: VT, pollMs: 10, killWaitMs: 20 })).toBe('survived')
    expect(sent).toEqual(['SIGINT', 'SIGKILL'])
    expect(existsSync(PIDFILE)).toBe(true)
  })
})

// Ron 18679: the record checks on the kill path (pid 1 = init, non-integer pids, odd argv) were untested. The fake
// deps below call EVERY pid "ours" (readArgv returns the record's own argv), so only the record checks stand between
// a bad record and a signal.
describe('a bad or foreign-shaped record is never acted on', () => {
  const good = (): unknown[] => ['/opt/venv/bin/python', VT, 'transcribe', 'AwACAgIAAxkBAAIBc2', '/s']
  const BAD: Array<[string, unknown]> = [
    ['pid 1 (init)', { pid: 1, argv: good() }],
    ['pid 0', { pid: 0, argv: good() }],
    ['negative pid', { pid: -5, argv: good() }],
    ['fractional pid', { pid: 1234.5, argv: good() }],
    ['string pid', { pid: '1234', argv: good() }],
    ['argv not an array', { pid: 1234, argv: 'python transcribe' }],
    ['argv with one element', { pid: 1234, argv: ['/opt/venv/bin/python'] }],
    ['argv with a non-string element', { pid: 1234, argv: ['/opt/venv/bin/python', VT, 'transcribe', 123, '/s'] }],
    ['foreign 2-element shape (Ron: python3 605)', { pid: 1234, argv: ['/usr/bin/python3', '605'] }],
    ['5 elements, another _vtools.py', { pid: 1234, argv: ['/opt/venv/bin/python', '/elsewhere/_vtools.py', 'transcribe', 'F', '/s'] }],
    ['5 elements, not transcribe', { pid: 1234, argv: ['/opt/venv/bin/python', VT, 'speak', 'F', '/s'] }],
  ]
  it.each(BAD)('%s -> stale, no signal, file removed', async (_name, body) => {
    writeFileSync(PIDFILE, JSON.stringify(body))
    const live = Array.isArray((body as { argv?: unknown }).argv) ? (body as { argv: string[] }).argv : good() as string[]
    const sent: string[] = []
    const deps: WhisperReapDeps = { readArgv: () => live, signal: (_p, s) => { sent.push(s) }, sleep: async () => {} }
    expect(await reapOrphanWhisper(PIDFILE, deps, 20, { vtoolsPath: VT, pollMs: 5, killWaitMs: 10 })).toBe('stale')
    expect(sent).toEqual([])
    expect(existsSync(PIDFILE)).toBe(false)
  })

  it('POSITIVE CONTROL: the same fake deps with a good record do signal', async () => {
    writeFileSync(PIDFILE, JSON.stringify({ pid: 1234, argv: good() }))
    const sent: string[] = []
    const deps: WhisperReapDeps = { readArgv: () => good() as string[], signal: (_p, s) => { sent.push(s) }, sleep: async () => {} }
    expect(await reapOrphanWhisper(PIDFILE, deps, 20, { vtoolsPath: VT, pollMs: 5, killWaitMs: 10 })).toBe('survived')
    expect(sent).toEqual(['SIGINT', 'SIGKILL'])
  })

  it('readWhisperPidfile itself rejects the bad pid / argv records (and accepts a good one)', () => {
    for (const [, body] of BAD.slice(0, 8)) {
      writeFileSync(PIDFILE, JSON.stringify(body))
      expect(readWhisperPidfile(PIDFILE)).toBe('invalid')
    }
    writeFileSync(PIDFILE, JSON.stringify({ pid: 2, argv: ['a', 'b'] }))
    expect(readWhisperPidfile(PIDFILE)).toEqual({ pid: 2, argv: ['a', 'b'] })
  })

  it('a real foreign process named by a 2-element record is not signalled (Ron\'s measured case)', async () => {
    const p = spawn('sleep', ['605'], { stdio: 'ignore' })
    children.push(p)
    for (let i = 0; i < 100 && defaultWhisperReapDeps.readArgv(p.pid!)?.[0] !== 'sleep'; i++) await new Promise((r) => setTimeout(r, 10))
    writeWhisperPidfile(PIDFILE, p.pid!, ['/usr/bin/python3', '605'])
    expect(sameArgv(defaultWhisperReapDeps.readArgv(p.pid!)!, ['/usr/bin/python3', '605'])).toBe(true) // the tail alone WOULD match
    expect(await reapOrphanWhisper(PIDFILE, defaultWhisperReapDeps, 200, { vtoolsPath: VT, pollMs: 20 })).toBe('stale')
    expect(alive(p.pid!)).toBe(true)
    p.kill('SIGKILL'); await exited(p)
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
