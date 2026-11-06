// A failed scripts/__tests__ suite names its cause in the FAILURE MESSAGE (Kevin 12087/12094):
// the JSON report of a channels-auth-probe failure that was a real TS7016 said only
// "expected 1 to be +0", and the triage had to dig the tsc error out of a full run's stderr.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIGEST_MAX_BYTES, SUITE_TIMEOUT_MS, failureDigest, runScriptSuite } from './setup/script-suites.js'

const ts = (i: number) => `src/web/f${i}.ts(${i},1): error TS2322: Type 'string' is not assignable to type 'number'.`
const noise = (n: number) => Array.from({ length: n }, (_, i) => `noise ${i + 1}`)

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('failureDigest: what a failed suite puts into its failure message', () => {
  it('the exit code, the first 5 tsc errors of 7 by name, and not the 6th', () => {
    const d = failureDigest('x.test.sh', { status: 1, stdout: '', stderr: [1, 2, 3, 4, 5, 6, 7].map(ts).join('\n') })
    expect(d.split('\n')[0]).toBe('x.test.sh exited 1')
    expect(d).toContain('tsc errors (first 5 of 7):')
    for (const i of [1, 2, 3, 4, 5]) expect(d).toContain(ts(i))
    expect(d).not.toContain(ts(6))
  })

  it('the first 5 FAIL lines from stdout or stderr, indented ones too', () => {
    const fails = Array.from({ length: 6 }, (_, i) => `  FAIL: case ${i + 1}`)
    const d = failureDigest('y.test.sh', { status: 1, stdout: ['  PASS: ok', ...fails.slice(0, 3)].join('\n'), stderr: fails.slice(3).join('\n') })
    expect(d).toContain('FAIL lines (first 5 of 6):')
    for (const i of [1, 2, 3, 4, 5]) expect(d).toContain(`FAIL: case ${i}`)
    expect(d).not.toContain('FAIL: case 6')
    expect(d).not.toContain('PASS: ok')
  })

  it('the last 15 other stderr lines as context; a tsc or FAIL line is never repeated there', () => {
    const d = failureDigest('z.test.sh', { status: 2, stdout: '', stderr: [...noise(40), 'FAIL: the end'].join('\n') })
    expect(d).toContain('stderr, last 15 line(s):')
    expect(d).toContain('  noise 40')
    expect(d).toContain('  noise 26')
    expect(d).not.toContain('noise 25\n')
    expect(d.match(/FAIL: the end/g)).toHaveLength(1)
  })

  it('a timeout and a signal are named as such, not as an exit code', () => {
    const timeout = Object.assign(new Error('spawnSync bash ETIMEDOUT'), { code: 'ETIMEDOUT' })
    expect(failureDigest('t.test.sh', { status: null, signal: 'SIGTERM', error: timeout }).split('\n')[0]).toBe('t.test.sh timed out after 300 s')
    expect(failureDigest('k.test.sh', { status: null, signal: 'SIGKILL' }).split('\n')[0]).toBe('k.test.sh was killed by SIGKILL')
  })

  it('a spawn error is named by its own message, not as an unknown signal', () => {
    const enoent = Object.assign(new Error('spawnSync bash ENOENT'), { code: 'ENOENT' })
    expect(failureDigest('e.test.sh', { status: null, signal: null, error: enoent }).split('\n')[0]).toBe('e.test.sh did not complete: spawnSync bash ENOENT')
    const enobufs = Object.assign(new Error('spawnSync bash ENOBUFS'), { code: 'ENOBUFS' })
    expect(failureDigest('b.test.sh', { status: null, signal: 'SIGTERM', error: enobufs }).split('\n')[0]).toBe('b.test.sh did not complete: spawnSync bash ENOBUFS (SIGTERM)')
  })

  it('never more than 3 KB, and it says it was cut', () => {
    const d = failureDigest('big.test.sh', { status: 1, stdout: '', stderr: Array.from({ length: 15 }, (_, i) => `${i} ` + 'é'.repeat(900)).join('\n') })
    expect(Buffer.byteLength(d)).toBeLessThanOrEqual(DIGEST_MAX_BYTES)
    expect(d).toMatch(/\.\.\. \(cut at 3 KB; the full stdout\/stderr is in the console dump\)$/)
    expect(d).not.toContain('�')
  })

  // A 4-byte character with a 0-3 byte shift in front of it: at least three of the four cuts land inside
  // a character, so the trailing replacement-character trim is exercised, not just a lucky boundary.
  it('a cut inside a 4-byte character leaves no replacement character, at every offset', () => {
    for (const shift of [0, 1, 2, 3]) {
      const d = failureDigest('emoji.test.sh', { status: 1, stdout: '', stderr: 'x'.repeat(shift) + '\u{1F600}'.repeat(1000) })
      expect(Buffer.byteLength(d), `shift ${shift}`).toBeLessThanOrEqual(DIGEST_MAX_BYTES)
      expect(d, `shift ${shift}`).not.toContain('\uFFFD')
      expect(d, `shift ${shift}`).toMatch(/\u{1F600}\n\.\.\. \(cut at 3 KB; the full stdout\/stderr is in the console dump\)$/u)
    }
  })
})

describe('runScriptSuite: the digest reaches the failure message (end to end)', () => {
  it('a suite that fails on a tsc error names that error in the thrown assertion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'digest-suite-'))
    try {
      writeFileSync(join(dir, 'fake-build.test.sh'), [
        'echo "  PASS: setup"',
        `printf '%s\\n' ${[1, 2, 3, 4, 5, 6, 7].map((i) => `"${ts(i)}"`).join(' ')} >&2`,
        'echo "FAIL: npm run build failed" >&2',
        'exit 1',
      ].join('\n') + '\n')
      const dump = vi.spyOn(console, 'error').mockImplementation(() => {})
      let message = ''
      try { runScriptSuite('fake-build.test.sh', { skip: () => {} }, dir, SUITE_TIMEOUT_MS, dir) } catch (e) { message = (e as Error).message }
      expect(message).toContain('fake-build.test.sh exited 1')
      expect(message).toContain(ts(1))
      expect(message).toContain(ts(5))
      expect(message).not.toContain(ts(6))
      expect(message).toContain('FAIL: npm run build failed')
      expect(message).toContain('expected 1 to be +0')
      // the full dump is still written, the digest is in addition to it
      expect(dump.mock.calls.map((c) => String(c[0])).join('\n')).toContain(ts(7))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // status is null here: a check that read it as 0 (res.status ?? 0) would pass a killed suite.
  it('a suite killed by SIGKILL fails, and the message says so', () => {
    const dir = mkdtempSync(join(tmpdir(), 'digest-suite-'))
    try {
      writeFileSync(join(dir, 'killed.test.sh'), 'echo "  PASS: before the kill"\nkill -9 $$\necho "not reached"\n')
      vi.spyOn(console, 'error').mockImplementation(() => {})
      let message = ''
      try { runScriptSuite('killed.test.sh', { skip: () => {} }, dir, SUITE_TIMEOUT_MS, dir) } catch (e) { message = (e as Error).message }
      expect(message).toContain('killed.test.sh was killed by SIGKILL')
      expect(message).toContain('expected null to be +0')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a suite whose interpreter cannot be spawned fails with the spawn error in the head line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'digest-suite-'))
    try {
      writeFileSync(join(dir, 'unspawnable.test.sh'), 'exit 0\n')
      vi.stubEnv('PATH', join(dir, 'no-such-bin'))
      vi.spyOn(console, 'error').mockImplementation(() => {})
      let message = ''
      try { runScriptSuite('unspawnable.test.sh', { skip: () => {} }, dir, SUITE_TIMEOUT_MS, dir) } catch (e) { message = (e as Error).message }
      expect(message).toContain('unspawnable.test.sh did not complete: spawnSync bash ENOENT')
      expect(message).not.toContain('unknown signal')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
