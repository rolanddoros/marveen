// C2 B2-5: what every workflow under .github/workflows must keep.
//
// 1. Every action is pinned to a full commit SHA, with the release it was read from as a comment
//    (`owner/repo@<40 hex>  # vX.Y.Z`). A tag like @v4 is a moving pointer: whoever controls the
//    action's repo can change what our CI runs without a commit here. The SHA is read from the GitHub
//    API (git/ref/tags/<version>, object type commit), never typed.
// 2. One Node version source: every setup-node step reads .nvmrc (node-version-file), and no workflow
//    names a version literal (node-version:). Before B2-5 the secret gate pinned '22' on its own while
//    the test job read .nvmrc, so a bump of one silently left the other behind.
// 3. .nvmrc satisfies package.json engines.node, so the version CI runs is one the package accepts.
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

// The release each pinned SHA was read from (C2 B2-5b, Ron 11985): GitHub API git/ref/tags/<version>, object type
// commit, read by the reviewer on 2026-11-05. Without it the '# vX.Y.Z' comment was checked for its FORM only: a
// comment changed to another release stayed green, and at the next bump the comment could lie about the SHA. A bump
// updates this table from the same API read, in the same commit as the workflow line; the test needs no network.
const RELEASES: Record<string, { sha: string; version: string }> = {
  'actions/checkout': { sha: '11d5960a326750d5838078e36cf38b85af677262', version: 'v4.4.0' },
  'actions/setup-node': { sha: '49933ea5288caeca8642d1e84afbd3f7d6820020', version: 'v4.4.0' },
  // C2 (Johnny 12569 (1)): GitHub API repos/actions/cache/releases/latest = v6.1.0 (published 2026-06-26), and
  // git/ref/tags/v6.1.0 = commit 55cc8345..., read by Dennis on 2026-11-06. restore and save are two actions of the
  // one repo, so they share the release.
  'actions/cache/restore': { sha: '55cc8345863c7cc4c66a329aec7e433d2d1c52a9', version: 'v6.1.0' },
  'actions/cache/save': { sha: '55cc8345863c7cc4c66a329aec7e433d2d1c52a9', version: 'v6.1.0' },
}

// The one condition under which the .deb cache is written (C2, Johnny 12569 (2), (6)): a push to main, never a PR
// branch. A pull_request run's github.ref is refs/pull/<n>/merge and its event is pull_request, so both halves are
// needed; the cache-hit half only skips a save of what was just restored. The last half (Kevin 12587): the install
// step's prune said unverified=false. It is `== 'false'`, not `!= 'true'`: a missing output (prune never ran) must
// not count as verified, so a run that could not verify its cache never saves one.
const SAVE_IF = "if: github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.ffmpeg-debs.outputs.cache-hit != 'true' && steps.ffmpeg-install.outputs.unverified == 'false'"

const PINNED = /^\s*(-\s+)?uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/

describe('CI workflows: pinned actions, one Node version source (C2 B2-5)', () => {
  it('finds the workflows (a move of the directory must not empty these checks)', () => {
    expect(WORKFLOWS).toEqual(expect.arrayContaining(['secret-gate.yml', 'test.yml']))
    expect(WORKFLOWS.flatMap(usesLines).length).toBeGreaterThanOrEqual(4)
  })

  it('every action is pinned to a full commit SHA with its release as a comment', () => {
    const loose = WORKFLOWS.flatMap((f) => usesLines(f).filter(({ line }) => !PINNED.test(line)).map(({ line, n }) => `${f}:${n}: ${line.trim()}`))
    expect(loose).toEqual([])
  })

  it('every pinned SHA and its release comment are the recorded pair, and every recorded pair is in use', () => {
    const used = new Set<string>()
    const wrong: string[] = []
    for (const f of WORKFLOWS) {
      for (const { line, n } of usesLines(f)) {
        const m = line.match(/uses:\s+([^@\s]+)@([0-9a-f]{40})\s+#\s+(v\d+\.\d+\.\d+)\s*$/)
        if (!m) continue   // the form is the previous case's job
        const [, action, sha, version] = m
        used.add(action)
        const rec = RELEASES[action]
        if (!rec || rec.sha !== sha || rec.version !== version) wrong.push(`${f}:${n}: ${action}@${sha} # ${version}`)
      }
    }
    expect(wrong).toEqual([])
    expect([...used].sort()).toEqual(Object.keys(RELEASES).sort())
  })

  it('every cache save step runs only on a push to main (Johnny 12569 (2), (6))', () => {
    let saves = 0
    for (const f of WORKFLOWS) {
      const lines = text(f).split('\n')
      lines.forEach((line, i) => {
        if (!/uses:\s+actions\/cache(\/save)?@/.test(line)) return
        // the step around this uses: line, up to its `- ` and down to the next step
        const ind = line.search(/\S/)
        let start = i
        while (start > 0 && !/^\s*-\s/.test(lines[start])) start--
        const stepInd = lines[start].search(/\S/)
        const body = [lines[start].replace(/^(\s*)-\s/, '$1  ')]
        for (let j = start + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > stepInd); j++) body.push(lines[j])
        const ifs = body.map((l) => l.trim()).filter((l) => /^if\s*:/.test(l))
        saves++
        // actions/cache (restore AND save in one) is not allowed at all: its post step saves from any branch
        expect(/actions\/cache@/.test(line), `${f}:${i + 1}: actions/cache saves in its post step; use restore + save`).toBe(false)
        expect(ifs, `${f}:${i + 1}`).toEqual([SAVE_IF])
        expect(ind).toBeGreaterThan(stepInd)
      })
    }
    expect(saves).toBe(1)
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

  it('every setup-node step reads .nvmrc, and no workflow names a Node version literal', () => {
    for (const f of WORKFLOWS) {
      const lines = text(f).split('\n')
      lines.forEach((line, i) => {
        expect(/^\s*node-version\s*:/.test(line), `${f}:${i + 1}: ${line.trim()}`).toBe(false)
      })
      // the `with:` block of each setup-node step: the lines indented deeper than the step itself
      lines.forEach((line, i) => {
        if (!/uses:\s+actions\/setup-node@/.test(line)) return
        const indent = line.search(/\S/)
        const block: string[] = []
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j]
          if (l.trim() && l.search(/\S/) <= indent) break
          block.push(l)
        }
        expect(block.some((l) => /^\s*node-version-file:\s*\.nvmrc\s*$/.test(l)), `${f}:${i + 1}`).toBe(true)
      })
    }
  })

  it('.nvmrc is a bare major (or x.y.z) that satisfies package.json engines.node', () => {
    const nvmrc = readFileSync(join(ROOT, '.nvmrc'), 'utf-8').trim()
    expect(nvmrc).toMatch(/^v?\d+(\.\d+){0,2}$/)
    const major = Number(nvmrc.replace(/^v/, '').split('.')[0])
    const engines = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).engines?.node as string
    const min = engines.match(/^>=\s*(\d+)/)
    expect(min, `engines.node "${engines}" is not a ">=N" range; extend this check before changing it`).not.toBeNull()
    expect(major).toBeGreaterThanOrEqual(Number(min![1]))
  })
})
