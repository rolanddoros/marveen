// C1 PR 8b: the unified diff of the dry-run report (src/web/claude-md/line-diff.ts).
// `git apply` is the independent oracle: every diff it is given must turn the
// old text into the new one exactly.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type DiffLine, splitRaw, unifiedDiff } from '../web/claude-md/line-diff.js'

const L = (text: string, tag = 'x'): DiffLine[] => splitRaw(text).map((raw) => ({ raw, tag }))
const diff = (a: string, b: string, context = 3, maxCells?: number) =>
  unifiedDiff(L(a), L(b), { from: 'f.md', to: 'f.md', context, maxCells })

let base: string
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'claude-md-line-diff-'))
})
afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

let seq = 0
// Apply `patch` to `before` with git apply in a scratch dir that is no repository
// (GIT_CEILING_DIRECTORIES stops the search above it); return the result.
function gitApply(before: string, patch: string, zero = false): string {
  const dir = join(base, `apply-${seq++}`)
  mkdirSync(dir)
  writeFileSync(join(dir, 'f.md'), before)
  writeFileSync(join(dir, 'p.diff'), patch)
  const r = spawnSync('git', ['apply', '--whitespace=nowarn', ...(zero ? ['--unidiff-zero'] : []), 'p.diff'], {
    cwd: dir, encoding: 'utf-8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CEILING_DIRECTORIES: dirname(dir), HOME: dir },
  })
  if (r.status !== 0) throw new Error(`git apply failed: ${r.stderr}\n${patch}`)
  return readFileSync(join(dir, 'f.md'), 'utf-8')
}

describe('format', () => {
  it('equal lists give no diff', () => {
    expect(diff('a\nb\n', 'a\nb\n')).toBe('')
    expect(diff('', '')).toBe('')
  })

  it('a change in the middle, 3 context lines, counts as diff -u writes them', () => {
    const a = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n'
    const b = 'l1\nl2\nl3\nl4\nX\nl6\nl7\nl8\nl9\n'
    expect(diff(a, b)).toBe('--- a/f.md\n+++ b/f.md\n@@ -2,7 +2,7 @@\n l2\n l3\n l4\n-l5\n+X\n l6\n l7\n l8\n')
  })

  it('a count of 1 is omitted; an empty range names the line before it', () => {
    expect(diff('a\n', 'b\n', 0)).toBe('--- a/f.md\n+++ b/f.md\n@@ -1 +1 @@\n-a\n+b\n')
    expect(diff('', 'a\nb\n', 0)).toBe('--- a/f.md\n+++ b/f.md\n@@ -0,0 +1,2 @@\n+a\n+b\n')
    expect(diff('a\nb\n', 'a\n', 0)).toBe('--- a/f.md\n+++ b/f.md\n@@ -2 +1,0 @@\n-b\n')
    expect(diff('a\n', 'a\nb\nc\n', 0)).toBe('--- a/f.md\n+++ b/f.md\n@@ -1,0 +2,2 @@\n+b\n+c\n')
  })

  it('marks a missing final newline on either side', () => {
    expect(diff('a\nb', 'a\nb\n', 0)).toBe('--- a/f.md\n+++ b/f.md\n@@ -2 +2 @@\n-b\n\\ No newline at end of file\n+b\n')
  })

  it('keeps a CR in the line, so CRLF text applies byte for byte', () => {
    const a = 'a\r\nb\r\n'
    const b = 'a\r\nB\r\n'
    const d = diff(a, b)
    expect(d).toContain('-b\r\n+B\r\n')
    expect(gitApply(a, d)).toBe(b)
  })

  it('merges changes up to 2*context equal lines apart, splits beyond', () => {
    const a = 'c\n1\n2\n3\n4\n5\n6\nc\n'
    const near = diff(a, 'C\n1\n2\n3\n4\n5\n6\nC\n', 3)
    expect(near.match(/^@@/gm)).toHaveLength(1)
    const far = diff(a, 'C\n1\n2\n3\n4\n5\n6\nC\n', 2)
    expect(far.match(/^@@/gm)).toHaveLength(2)
  })

  it('lines with different tags never pair, even with the same text', () => {
    const d = unifiedDiff([{ raw: 'same\n', tag: 'owner' }], [{ raw: 'same\n', tag: 'region' }], { from: 'f', to: 'f', context: 0 })
    expect(d).toBe('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-same\n+same\n')
  })

  it('show() decides how a line is printed', () => {
    const d = unifiedDiff(L('a\n'), L('b\n'), { from: 'f', to: 'f', context: 0, show: (side, l, i) => `${side}${i}:${l.raw.trim()}` })
    expect(d).toBe('--- a/f\n+++ b/f\n@@ -1 +1 @@\n--0:a\n++0:b\n')
  })
})

describe('git apply roundtrip', () => {
  let seed = 7
  const rnd = (k: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % k
  }
  const randomText = () => {
    const n = rnd(14)
    let t = ''
    for (let i = 0; i < n; i++) t += ['a', 'b', 'c', '', '```', 'x y'][rnd(6)] + (rnd(9) === 0 ? '\r\n' : '\n')
    return rnd(5) === 0 ? t.replace(/\r?\n$/, '') : t
  }

  it('random pairs: the diff applies and gives the new text (context 3 and 0)', () => {
    let checked = 0
    for (let i = 0; i < 60; i++) {
      const a = randomText()
      const b = randomText()
      for (const ctx of [3, 0]) {
        const d = diff(a, b, ctx)
        if (d === '') {
          expect(a).toBe(b)
          continue
        }
        expect(gitApply(a, d, ctx === 0)).toBe(b)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(80)
  })

  it('over the table limit the middle is one removed and one added block, still exact', () => {
    const a = 'h\n1\n2\n3\nt\n'
    const b = 'h\n3\n2\n1\nt\n'
    const small = diff(a, b, 3, 4)
    expect(small.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'))).toEqual(['-1', '-2', '-3'])
    expect(small.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))).toEqual(['+3', '+2', '+1'])
    expect(gitApply(a, small)).toBe(b)
    const full = diff(a, b, 3)
    expect(full.split('\n').filter((l) => /^[-+][^-+]/.test(l)).length).toBeLessThan(6)
    expect(gitApply(a, full)).toBe(b)
  })
})
