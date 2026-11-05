// C2 B2-5: what every workflow under .github/workflows must keep.
//
// 1. Every action is pinned to a full commit SHA, with the release it was read from as a comment
//    (`owner/repo@<40 hex>  # vX.Y.Z`). A tag like @v4 is a moving pointer: whoever controls the
//    action's repo can change what our CI runs without a commit here. The SHA is read from the GitHub
//    API (git/ref/tags/<version>, object type commit), never typed.
//
// Line-based on purpose: the workflows are small and hand-written, and a YAML parser would add a
// dependency only for this. A `uses:` written in a form this reader does not know fails case 1.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const WF_DIR = join(ROOT, '.github', 'workflows')
const WORKFLOWS = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort()
const text = (f: string) => readFileSync(join(WF_DIR, f), 'utf-8')

// Every line that names an action, in any spelling YAML allows for the key.
const usesLines = (f: string) =>
  text(f).split('\n').map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => /^\s*(-\s+)?['"]?uses['"]?\s*:/.test(line))

const PINNED = /^\s*(-\s+)?uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/

describe('CI workflows: pinned actions (C2 B2-5)', () => {
  it('finds the workflows (a move of the directory must not empty these checks)', () => {
    expect(WORKFLOWS).toEqual(expect.arrayContaining(['secret-gate.yml', 'test.yml']))
    expect(WORKFLOWS.flatMap(usesLines).length).toBeGreaterThanOrEqual(4)
  })

  it('every action is pinned to a full commit SHA with its release as a comment', () => {
    const loose = WORKFLOWS.flatMap((f) => usesLines(f).filter(({ line }) => !PINNED.test(line)).map(({ line, n }) => `${f}:${n}: ${line.trim()}`))
    expect(loose).toEqual([])
  })

  it('one action is pinned to one SHA everywhere (no two releases of the same action side by side)', () => {
    const seen = new Map<string, Set<string>>()
    for (const f of WORKFLOWS) {
      for (const { line } of usesLines(f)) {
        const m = line.match(/uses:\s+([^@\s]+)@([0-9a-f]{40})/)
        if (!m) continue
        seen.set(m[1], (seen.get(m[1]) ?? new Set()).add(m[2]))
      }
    }
    const split = [...seen].filter(([, shas]) => shas.size > 1).map(([action]) => action)
    expect(split).toEqual([])
  })
})
