// C2 (Kevin 12211, Johnny 12210): the apt step of CI has a hard time limit.
//
// In fork runs 42150172494 and 42150141070 "Install ffmpeg for the resize hook's tests" took 34 min instead of 18 s:
// the mirror is http and the download was slow but flowing (94.1 MB in 33 min 50 s, 99 packages). Johnny's rule,
// in its simplest form:
//   - the step gets timeout-minutes: 8, so a slow mirror is a visible, re-runnable failure, not a half-hour wait;
//   - every apt-get call gets -o Acquire::Retries=3 -o Acquire::http::Timeout=30 (a dropped or stalled connection);
//   - the install takes only ffmpeg, with --no-install-recommends;
//   - NO cache and NO third-party action (no new dependency, no outside code in CI). That last one is a decision,
//     not an accident: a later "speed it up with a cache action" is a change to that decision, not a fix.
//
// Line-based, like ci-workflow-pins.test.ts: the workflows are small and hand-written, and a YAML parser would add a
// dependency only for this. A form this reader does not know (an apt call it cannot place in a step) fails.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const WF_DIR = join(ROOT, '.github', 'workflows')
const WORKFLOWS = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort()
const STEP_NAME = "Install ffmpeg for the resize hook's tests"
const MAX_MINUTES = 8
const APT_FLAGS = ['-o Acquire::Retries=3', '-o Acquire::http::Timeout=30']
const APT_CALL = /\bapt(-get)?\s/

interface Step { file: string; line: number; name: string | null; timeout: number | null; run: string; text: string }

const indentOf = (l: string) => l.length - l.trimStart().length
const isBlank = (l: string) => l.trim() === '' || l.trim().startsWith('#')

// Every step under every `steps:` key: the lines from its `- ` to the next sibling or the end of the list.
function stepsOf(file: string, src: string): Step[] {
  const lines = src.split('\n')
  const steps: Step[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*steps:\s*$/.test(lines[i])) continue
    const listIndent = indentOf(lines[i])
    let cur: { start: number; body: string[] } | null = null
    let dash = -1
    const flush = () => { if (cur) steps.push(parseStep(file, cur.start, cur.body)) }
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (isBlank(l)) continue
      const ind = indentOf(l)
      if (ind <= listIndent) break
      if (l.trimStart().startsWith('- ') && (dash === -1 || ind === dash)) {
        dash = ind
        flush()
        cur = { start: j + 1, body: [' '.repeat(ind) + '  ' + l.trimStart().slice(2)] }
      } else if (cur) cur.body.push(l)
    }
    flush()
  }
  return steps
}

function parseStep(file: string, line: number, body: string[]): Step {
  const keyIndent = indentOf(body[0])
  const key = (k: string) => body.find((l) => indentOf(l) === keyIndent && l.trimStart().startsWith(`${k}:`))
  const value = (l: string | undefined) => (l === undefined ? null : l.slice(l.indexOf(':') + 1).trim())
  const name = value(key('name'))
  const t = value(key('timeout-minutes'))
  let run = ''
  const runAt = body.findIndex((l) => indentOf(l) === keyIndent && l.trimStart().startsWith('run:'))
  if (runAt !== -1) {
    const inline = value(body[runAt])!
    if (/^[|>][-+]?$/.test(inline)) {
      run = body.slice(runAt + 1).filter((l) => indentOf(l) > keyIndent).map((l) => l.trim()).join('\n')
    } else run = inline
  }
  return {
    file, line,
    name: name === null ? null : name.replace(/^(['"])(.*)\1$/, '$2'),
    timeout: t === null ? null : Number(t),
    run,
    text: body.join('\n'),
  }
}

// One command per line, split at && ; || (enough for these hand-written steps).
const commands = (run: string) => run.split(/\n|&&|\|\||;/).map((c) => c.trim()).filter((c) => c !== '')

const ALL = WORKFLOWS.flatMap((f) => stepsOf(f, readFileSync(join(WF_DIR, f), 'utf-8')))

describe('CI apt step: a hard time limit, retries, only ffmpeg, no cache (Johnny 12210)', () => {
  it('reads the steps of the workflows (the reader must not find nothing)', () => {
    expect(WORKFLOWS).toContain('test.yml')
    expect(ALL.filter((s) => s.file === 'test.yml').length).toBeGreaterThan(5)
    expect(ALL.filter((s) => s.name === STEP_NAME)).toHaveLength(1)
  })

  it('no apt call outside a step the reader can see (a run line it did not place would escape the checks below)', () => {
    for (const f of WORKFLOWS) {
      const lines = readFileSync(join(WF_DIR, f), 'utf-8').split('\n')
      const aptLines = lines.filter((l) => !l.trim().startsWith('#') && APT_CALL.test(l)).length
      const seen = ALL.filter((s) => s.file === f).reduce((n, s) => n + s.text.split('\n').filter((l) => !l.trim().startsWith('#') && APT_CALL.test(l)).length, 0)
      expect(seen, f).toBe(aptLines)
    }
  })

  it(`every step that calls apt has timeout-minutes, at most ${MAX_MINUTES}`, () => {
    const loose = ALL.filter((s) => commands(s.run).some((c) => APT_CALL.test(c)))
      .filter((s) => s.timeout === null || !Number.isInteger(s.timeout) || s.timeout < 1 || s.timeout > MAX_MINUTES)
      .map((s) => `${s.file}:${s.line} ${s.name ?? '(unnamed)'} timeout-minutes=${s.timeout}`)
    expect(loose).toEqual([])
  })

  it(`the ffmpeg step: timeout-minutes is exactly ${MAX_MINUTES}`, () => {
    expect(ALL.find((s) => s.name === STEP_NAME)!.timeout).toBe(MAX_MINUTES)
  })

  it('every apt call is apt-get with both network flags', () => {
    const bad: string[] = []
    for (const s of ALL) {
      for (const c of commands(s.run).filter((x) => APT_CALL.test(x))) {
        if (!/\bapt-get\s/.test(c) || !APT_FLAGS.every((fl) => c.includes(fl))) bad.push(`${s.file}:${s.line}: ${c}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('the ffmpeg step: one update, then one install of ffmpeg alone, -y --no-install-recommends', () => {
    const cmds = commands(ALL.find((s) => s.name === STEP_NAME)!.run)
    const words = (c: string) => c.replace(/-o\s+\S+/g, '').split(/\s+/).filter((w) => w !== '' && w !== 'sudo' && w !== 'apt-get')
    expect(cmds.map(words)).toEqual([
      ['update'],
      ['install', '-y', '--no-install-recommends', 'ffmpeg'],
    ])
  })

  it('no cache action, no apt action, no ffmpeg setup action in any workflow (no new dependency, Johnny 12210)', () => {
    const uses = WORKFLOWS.flatMap((f) => readFileSync(join(WF_DIR, f), 'utf-8').split('\n')
      .filter((l) => /^\s*(-\s+)?['"]?uses['"]?\s*:/.test(l)).map((l) => `${f}: ${l.trim()}`))
    expect(uses.length).toBeGreaterThan(0)
    expect(uses.filter((u) => /cache|apt|ffmpeg/i.test(u.split('uses')[1]))).toEqual([])
  })

  // The control: the step as it was before this change (e5113e8d) must fail the rules above, so they measure it.
  it('control: the old one-line step breaks the time limit, the flag and the install rules', () => {
    const old = [
      'jobs:', '  test:', '    steps:',
      "      - name: Install ffmpeg for the resize hook's tests",
      '        run: sudo apt-get update && sudo apt-get install -y ffmpeg',
      '',
    ].join('\n')
    const [s] = stepsOf('old.yml', old)
    expect(s.name).toBe(STEP_NAME)
    expect(s.timeout).toBeNull()
    const cmds = commands(s.run)
    expect(cmds).toEqual(['sudo apt-get update', 'sudo apt-get install -y ffmpeg'])
    expect(cmds.some((c) => !APT_FLAGS.every((fl) => c.includes(fl)))).toBe(true)
    expect(cmds[1]).not.toContain('--no-install-recommends')
  })
})
