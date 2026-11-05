// helpers/stdin-epipe.ts: a child that exits without reading its stdin must not
// turn the run red through an unhandled EPIPE (fork PR #13, CI run 42094896572).
// The reproduction is deterministic: the input is far larger than a pipe buffer
// (64 KiB on Linux, 16-64 KiB on macOS), so the write is still pending when the
// child is gone, and the rest of it fails with EPIPE every time.
import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { endStdin } from './helpers/stdin-epipe.js'

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

  it('any other stdin error is not swallowed', () => {
    const stdin = new PassThrough()
    endStdin({ stdin }, '')
    const eio = Object.assign(new Error('boom'), { code: 'EIO' })
    expect(() => stdin.emit('error', eio)).toThrow('boom')
  })

  it('no stdin (stdio ignore): nothing to do, nothing thrown', () => {
    expect(() => endStdin({ stdin: null }, 'x')).not.toThrow()
  })
})
