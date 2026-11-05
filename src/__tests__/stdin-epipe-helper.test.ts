// helpers/stdin-epipe.ts: a child that exits without reading its stdin must not
// turn the run red through an unhandled EPIPE (fork PR #13, CI run 42094896572).
// The reproduction is deterministic: the input is far larger than a pipe buffer
// (64 KiB on Linux, 16-64 KiB on macOS), so the write is still pending when the
// child is gone, and the rest of it fails with EPIPE every time.
import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { endStdin } from './helpers/stdin-epipe.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const BIG = 'x'.repeat(4 * 1024 * 1024)

function exitsAtOnce(): ChildProcess {
  return spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: ['pipe', 'ignore', 'ignore'] })
}

const closed = (child: ChildProcess): Promise<number | null> => new Promise(res => child.on('close', code => res(code)))

describe('endStdin: EPIPE from a child that never reads its stdin', () => {
  it('positive control: a bare end() on such a child does get EPIPE (the hazard is real here)', async () => {
    const child = exitsAtOnce()
    const errors: string[] = []
    child.stdin!.on('error', (e: NodeJS.ErrnoException) => { errors.push(String(e.code)) })
    child.stdin!.end(BIG)
    expect(await closed(child)).toBe(3)
    // the stream reports its error before or right after close
    await new Promise(r => setTimeout(r, 50))
    expect(errors).toEqual(['EPIPE'])
  })

  it('with endStdin the same child ends cleanly: its exit code is the result, no unhandled error', async () => {
    const child = exitsAtOnce()
    endStdin(child, BIG)
    expect(await closed(child)).toBe(3)
    // give a late stream error the chance to surface as unhandled (vitest would fail the run)
    await new Promise(r => setTimeout(r, 50))
  })

  // Ron 12054: the narrowing is by error CODE, and only EPIPE. Each other code
  // must come back out, and the message text must not decide either way.
  it.each(['EIO', 'ECONNRESET', 'EBADF'])('any other stdin error is not swallowed: %s', (code) => {
    const stdin = new PassThrough()
    endStdin({ stdin }, '')
    const err = Object.assign(new Error(`boom ${code}`), { code })
    expect(() => stdin.emit('error', err)).toThrow(`boom ${code}`)
  })

  it('the code decides, not the message: an EPIPE text with another code is rethrown, an EPIPE code with other text is not', () => {
    const a = new PassThrough()
    endStdin({ stdin: a }, '')
    expect(() => a.emit('error', Object.assign(new Error('write EPIPE (wrapped)'), { code: 'EIO' }))).toThrow('wrapped')
    const b = new PassThrough()
    endStdin({ stdin: b }, '')
    expect(() => b.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).not.toThrow()
  })

  it('the real site: token-off-argv-scripts bash() ends stdin through endStdin, not a bare end() (Ron K1)', () => {
    // The EPIPE there is a timing race (2 in 200 tries, Ron), so a revert to a
    // bare end() would pass that file; this pins the call itself.
    const src = readFileSync(join(__dirname, 'token-off-argv-scripts.test.ts'), 'utf-8')
    expect(src.indexOf('function bash(')).toBeGreaterThanOrEqual(0)
    const body = src.slice(src.indexOf('function bash('), src.indexOf('\n}\n', src.indexOf('function bash(')))
    expect(body).toContain('endStdin(child, input)')
    expect(body).not.toMatch(/stdin\??!?\.end\(/)
  })

  it('no stdin (stdio ignore): nothing to do, nothing thrown', () => {
    expect(() => endStdin({ stdin: null }, 'x')).not.toThrow()
  })
})
