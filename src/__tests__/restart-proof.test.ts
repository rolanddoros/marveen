// scripts/deploy/restart-proof.mjs: steps 12-13 of the fork deploy helper (plan v3 [V3-4], addendum A1-2,
// Ron 17165 C1). Pinned: properties are read BY NAME from Key=Value lines (the stub answers in systemd's real,
// alphabetical order, whatever the -p order), a missing key or InvocationID fails, the CET text is never parsed,
// the new-process rule, the start line in the real pino-pretty shape with colours, OFF0 and rotation, and the API
// call only AFTER the start line.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs script, no types
import { parseShow, detectScope, snapshot, newProcessFailures, parseStartLine, findStartLine, readLogSince, logSize, waitForStart, PROOF_KEYS } from '../../scripts/deploy/restart-proof.mjs'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// `systemctl --user show -p InvocationID,MainPID,ActiveEnterTimestampMonotonic,ActiveEnterTimestamp
// johnny-dashboard.service` on this host, 2026-11-17 (the keys come back alphabetical, not in -p order).
const REAL_BLOCK = [
  'ActiveEnterTimestamp=Tue 2026-11-17 13:35:16 CET',
  'ActiveEnterTimestampMonotonic=15349552899',
  'InvocationID=f8c94861b9e54f53895097594a7d2171',
  'MainPID=1720826',
].join('\n') + '\n'
// The live store/dashboard.log start line (web.ts), colours included.
const REAL_START = '[2026-11-17 13:35:20.338 +0100] \x1b[32mINFO\x1b[39m (1720826): \x1b[36mWeb dashboard: http://localhost:3420\x1b[39m'
const REAL_START_MS = Date.UTC(2026, 10, 17, 12, 35, 20, 338)

type Snap = { inv: string; pid: number; mono: bigint }

/** A systemctl stub: records the argv and answers `show` in systemd's alphabetical order, never in -p order. */
function stub(props: Record<string, string> | (() => Record<string, string>), opts: { system?: boolean; user?: boolean } = {}) {
  const calls: string[][] = []
  const run = (args: string[]) => {
    calls.push(args)
    if (args.includes('cat')) return { status: (args[0] === '--user' ? opts.user : opts.system) ? 0 : 1, stdout: '' }
    const p = typeof props === 'function' ? props() : props
    const stdout = Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('\n') + '\n'
    return { status: 0, stdout }
  }
  return { run, calls }
}

const OLD = { InvocationID: 'f8c94861b9e54f53895097594a7d2171', MainPID: '1720826', ActiveEnterTimestampMonotonic: '15349552899', ActiveEnterTimestamp: 'Tue 2026-11-17 13:35:16 CET' }
const NEW = { InvocationID: '0123456789abcdef0123456789abcdef', MainPID: '1800001', ActiveEnterTimestampMonotonic: '15400000000', ActiveEnterTimestamp: 'Tue 2026-11-17 16:20:00 CET' }

describe('C1: properties by name', () => {
  it('reads the real block by key; the order is systemd\'s, the CET line is carried but not parsed', () => {
    const m = parseShow(REAL_BLOCK)
    expect(m.get('InvocationID')).toBe('f8c94861b9e54f53895097594a7d2171')
    expect(m.get('MainPID')).toBe('1720826')
    expect(m.get('ActiveEnterTimestampMonotonic')).toBe('15349552899')
    expect(Number.isNaN(Date.parse(m.get('ActiveEnterTimestamp')))).toBe(true)
    // A positional read of --value output in -p order would put the monotonic number into InvocationID:
    expect(REAL_BLOCK.split('\n')[1]).toMatch(/^ActiveEnterTimestampMonotonic=/)
  })

  it('a missing key fails; a value containing "=" is kept whole', () => {
    expect(() => parseShow('MainPID=1\nActiveEnterTimestampMonotonic=2\n')).toThrow(/missing InvocationID/)
    expect(parseShow('A=b=c', ['A']).get('A')).toBe('b=c')
  })

  it('snapshot asks WITHOUT --value, with --user only for the user scope, and parses by name', () => {
    const s = stub(OLD)
    expect(snapshot(s.run, 'user', 'x-dashboard')).toEqual({ inv: OLD.InvocationID, pid: 1720826, mono: 15349552899n })
    expect(s.calls[0]).toEqual(['--user', 'show', '-p', PROOF_KEYS.join(','), 'x-dashboard'])
    expect(s.calls[0]).not.toContain('--value')
    snapshot(s.run, 'system', 'x-dashboard')
    expect(s.calls[1][0]).toBe('show')
  })

  it('InvocationID missing or empty (old systemd): an error, which the helper raises before the merge', () => {
    const { InvocationID: _i, ...noInv } = OLD
    expect(() => snapshot(stub(noInv).run, 'user', 'u')).toThrow(/missing InvocationID/)
    expect(() => snapshot(stub({ ...OLD, InvocationID: '' }).run, 'user', 'u')).toThrow(/InvocationID "" is not usable/)
    expect(() => snapshot(stub({ ...OLD, MainPID: '' }).run, 'user', 'u')).toThrow(/not a number/)
  })

  it('a failing systemctl show is an error', () => {
    expect(() => snapshot(() => ({ status: 1, stdout: '' }), 'user', 'u')).toThrow(/exit 1/)
  })
})

describe('scope, in scripts/stop.sh order', () => {
  it('system first, then user, else null', () => {
    const both = stub(OLD, { system: true, user: true })
    expect(detectScope(both.run, 'u.service')).toBe('system')
    expect(both.calls).toEqual([['cat', 'u.service']])
    const user = stub(OLD, { user: true })
    expect(detectScope(user.run, 'u.service')).toBe('user')
    expect(user.calls).toEqual([['cat', 'u.service'], ['--user', 'cat', 'u.service']])
    expect(detectScope(stub(OLD).run, 'u.service')).toBeNull()
  })
})

describe('A1-2 (a): a new process', () => {
  const before: Snap = { inv: OLD.InvocationID, pid: 1720826, mono: 15349552899n }
  it('all new: no failure', () => {
    expect(newProcessFailures(before, { inv: NEW.InvocationID, pid: 1800001, mono: 15400000000n })).toEqual([])
  })
  it('the restart did not happen (same InvocationID, same pid, same mono): STOP with all three', () => {
    expect(newProcessFailures(before, before)).toEqual([
      `InvocationID unchanged (${OLD.InvocationID})`,
      'MainPID unchanged (1720826)',
      'ActiveEnterTimestampMonotonic did not grow (15349552899 -> 15349552899)',
    ])
  })
  it('new InvocationID but MainPID == PID0: STOP', () => {
    expect(newProcessFailures(before, { inv: NEW.InvocationID, pid: 1720826, mono: 15400000000n })).toEqual(['MainPID unchanged (1720826)'])
  })
  it('MainPID 0 (not running): STOP', () => {
    expect(newProcessFailures(before, { inv: NEW.InvocationID, pid: 0, mono: 15400000000n })).toEqual(['MainPID is 0'])
  })
  it('the monotonic start did not grow: STOP', () => {
    expect(newProcessFailures(before, { inv: NEW.InvocationID, pid: 1800001, mono: 15349552899n })).toEqual(['ActiveEnterTimestampMonotonic did not grow (15349552899 -> 15349552899)'])
  })
})

describe('A1-2 (b): the start line', () => {
  it('parses the real coloured line: UTC ms from the offset, pid, port', () => {
    expect(parseStartLine(REAL_START)).toEqual({ ts: REAL_START_MS, pid: 1720826, port: 3420 })
    expect(parseStartLine(REAL_START.replace(/\x1b\[[0-9;]*m/g, '') + '\r')).toEqual({ ts: REAL_START_MS, pid: 1720826, port: 3420 })
  })
  it('other lines are not start lines', () => {
    for (const l of ['', 'Web dashboard: http://localhost:3420', REAL_START.replace('INFO', 'WARN'), REAL_START + ' extra', REAL_START.replace('(1720826)', '(x)')]) {
      expect(parseStartLine(l), JSON.stringify(l)).toBeNull()
    }
  })
  it('only the new pid, and not before the second of T0 (the same second counts)', () => {
    const text = [REAL_START, REAL_START.replace('(1720826)', '(1800001)')].join('\n')
    expect(findStartLine(text, { pid: 1800001, t0: REAL_START_MS + 400 })).toEqual({ ts: REAL_START_MS, pid: 1800001, port: 3420 })
    expect(findStartLine(text, { pid: 1800001, t0: REAL_START_MS + 1000 })).toBeNull()
    expect(findStartLine(REAL_START, { pid: 1800001, t0: REAL_START_MS - 5000 })).toBeNull()
  })
})

describe('the log after OFF0', () => {
  let dir: string
  let log: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'restart-proof-'))
    log = join(dir, 'dashboard.log')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads only the bytes after OFF0; a shorter (rotated) log from the start; no file is empty', () => {
    writeFileSync(log, 'old line\n')
    const off0 = logSize(log)
    appendFileSync(log, 'new line\n')
    expect(readLogSince(log, off0)).toBe('new line\n')
    writeFileSync(log, 'rotated\n')
    expect(readLogSince(log, off0)).toBe('rotated\n')
    expect(readLogSince(join(dir, 'missing'), 0)).toBe('')
    expect(logSize(join(dir, 'missing'))).toBe(0)
  })

  function clock() {
    let t = REAL_START_MS - 2000
    return { now: () => t, sleep: async (ms: number) => { t += ms } }
  }

  it('waits for the new process and its start line, and calls the API only after the line is there', async () => {
    writeFileSync(log, REAL_START + '\n')
    const off0 = logSize(log)
    let reads = 0
    const s = stub(() => (++reads < 3 ? OLD : NEW))
    const before = snapshot(s.run, 'user', 'u')
    const order: string[] = []
    const c = clock()
    const apiGet = async () => {
      order.push('api')
      return { status: 200 }
    }
    const runWithLog = (args: string[]) => {
      // The start line appears in the log only on the 4th systemctl call.
      if (s.calls.length === 3) {
        order.push('log')
        appendFileSync(log, REAL_START.replace('(1720826)', '(1800001)') + '\n')
      }
      return s.run(args)
    }
    const r = await waitForStart({ run: runWithLog, scope: 'user', unit: 'u', before, logFile: log, off0, t0: REAL_START_MS - 2000, apiGet, ...c })
    expect(r.ok).toBe(true)
    expect(r.line.pid).toBe(1800001)
    expect(order).toEqual(['log', 'api'])
  })

  it('an old start line before OFF0 with the old pid never counts: timeout with the (a) reason', async () => {
    writeFileSync(log, REAL_START + '\n')
    const off0 = 0
    const s = stub(OLD)
    const before = snapshot(s.run, 'user', 'u')
    let api = 0
    const r = await waitForStart({ run: s.run, scope: 'user', unit: 'u', before, logFile: log, off0, t0: REAL_START_MS - 2000, apiGet: async () => { api++; return { status: 200 } }, timeoutMs: 10_000, ...clock() })
    expect(r).toMatchObject({ ok: false })
    expect(r.failed).toMatch(/^\(a\) InvocationID unchanged/)
    expect(api).toBe(0)
  })

  it('new process but no start line: (b), API never called; start line but API 503: (c)', async () => {
    writeFileSync(log, '')
    const before: Snap = { inv: OLD.InvocationID, pid: 1720826, mono: 15349552899n }
    let api = 0
    const noLine = await waitForStart({ run: stub(NEW).run, scope: 'user', unit: 'u', before, logFile: log, off0: 0, t0: REAL_START_MS - 2000, apiGet: async () => { api++; return { status: 200 } }, timeoutMs: 6000, ...clock() })
    expect(noLine.failed).toBe('(b) no start line for pid 1800001 after byte 0')
    expect(api).toBe(0)
    appendFileSync(log, REAL_START.replace('(1720826)', '(1800001)') + '\n')
    const down = await waitForStart({ run: stub(NEW).run, scope: 'user', unit: 'u', before, logFile: log, off0: 0, t0: REAL_START_MS - 2000, apiGet: async () => ({ status: 503 }), timeoutMs: 6000, ...clock() })
    expect(down.failed).toBe('(c) API answered 503')
  })

  it('a systemctl error while waiting is reported, not thrown', async () => {
    const before: Snap = { inv: OLD.InvocationID, pid: 1720826, mono: 15349552899n }
    const r = await waitForStart({ run: () => ({ status: 1, stdout: '' }), scope: 'user', unit: 'u', before, logFile: log, off0: 0, t0: 0, apiGet: async () => ({ status: 200 }), timeoutMs: 1000, ...clock() })
    expect(r).toMatchObject({ ok: false, failed: 'systemctl show u: exit 1' })
  })
})
