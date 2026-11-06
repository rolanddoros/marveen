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
// The time limit must be on the STEP: a job-level timeout-minutes does not count, on purpose (Ron 12365, F8). A job
// limit would stop the whole run late instead of naming the step that hung.
//
// Line-based, like ci-workflow-pins.test.ts: the workflows are small and hand-written, and a YAML parser would add a
// dependency only for this. So the reader is strict about the forms it accepts, and everything else FAILS (Ron 12365):
//   - a step must be a block mapping (`- name: ...`); a flow-style step (`- {name: ..., run: ...}`) is an error;
//   - run must be a plain one-line scalar, or a literal (|) or folded (>) block; a quoted scalar is an error (its
//     escapes, like a literal \n, would hide a second command from this reader);
//   - a folded block is read as YAML folds it (lines joined by spaces), and a backslash at a line end joins the next
//     line, as the shell does, so `apt-get \` + `install ...` is one call;
//   - every non-comment line of a workflow that names apt must sit in a run block this reader parsed (the count of such
//     lines in the raw text and in the parsed runs must match).
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const WF_DIR = join(ROOT, '.github', 'workflows')
const WORKFLOWS = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort()
const STEP_NAME = "Install ffmpeg for the resize hook's tests"
const MAX_MINUTES = 8
const APT_FLAGS = ['-o Acquire::Retries=3', '-o Acquire::http::Timeout=30']
const APT_CALL = /\bapt(-get)?\b/

interface Step { file: string; line: number; name: string | null; timeout: number | null; run: string; runLines: string[] }
interface Parsed { steps: Step[]; errors: string[] }

const indentOf = (l: string) => l.length - l.trimStart().length
const isBlank = (l: string) => l.trim() === '' || l.trim().startsWith('#')
const unquote = (v: string) => v.replace(/^(['"])(.*)\1$/, '$2')

// Every step under every `steps:` key: the lines from its `- ` to the next sibling or the end of the list.
function parseWorkflow(file: string, src: string): Parsed {
  const lines = src.split('\n')
  const steps: Step[] = []
  const errors: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*steps:\s*$/.test(lines[i])) {
      if (/^\s*steps:\s*\S/.test(lines[i]) && !lines[i].trim().startsWith('#')) errors.push(`${file}:${i + 1}: steps in flow style`)
      continue
    }
    const listIndent = indentOf(lines[i])
    let cur: { start: number; body: string[] } | null = null
    let dash = -1
    const flush = () => { if (cur) steps.push(parseStep(file, cur.start, cur.body, errors)) }
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (isBlank(l)) continue
      const ind = indentOf(l)
      if (ind <= listIndent) break
      if (l.trimStart().startsWith('- ') && (dash === -1 || ind === dash)) {
        dash = ind
        flush()
        const item = l.trimStart().slice(2)
        if (item.trimStart().startsWith('{')) errors.push(`${file}:${j + 1}: a flow-style step this reader does not parse`)
        cur = { start: j + 1, body: [' '.repeat(ind) + '  ' + item] }
      } else if (cur) cur.body.push(l)
    }
    flush()
  }
  return { steps, errors }
}

function parseStep(file: string, line: number, body: string[], errors: string[]): Step {
  const keyIndent = indentOf(body[0])
  const key = (k: string) => body.find((l) => indentOf(l) === keyIndent && l.trimStart().startsWith(`${k}:`))
  const value = (l: string | undefined) => (l === undefined ? null : l.slice(l.indexOf(':') + 1).trim())
  const name = value(key('name'))
  const t = value(key('timeout-minutes'))
  let run = ''
  let runLines: string[] = []
  const runAt = body.findIndex((l) => indentOf(l) === keyIndent && l.trimStart().startsWith('run:'))
  if (runAt !== -1) {
    const inline = value(body[runAt])!
    if (/^[|>][-+]?$/.test(inline)) {
      runLines = body.slice(runAt + 1).filter((l) => indentOf(l) > keyIndent)
      const text = runLines.map((l) => l.trim())
      // folded (>): YAML joins the lines with spaces; literal (|): they stay lines
      run = inline.startsWith('>') ? text.join(' ') : text.join('\n')
    } else if (/^['"]/.test(inline)) {
      errors.push(`${file}:${line}: a quoted run scalar this reader does not parse`)
      runLines = [body[runAt]]
    } else if (/^[|>]/.test(inline)) {
      errors.push(`${file}:${line}: a block scalar header this reader does not parse: ${inline}`)
      runLines = [body[runAt]]
    } else {
      run = inline
      runLines = [body[runAt]]
    }
  }
  return {
    file, line,
    name: name === null ? null : unquote(name),
    timeout: t === null ? null : Number(t),
    // a backslash at a line end joins the next line, as the shell does
    run: run.replace(/\\\n\s*/g, ' '),
    runLines,
  }
}

// One command per line, split at && ; || (enough for these hand-written steps).
const commands = (run: string) => run.split(/\n|&&|\|\||;/).map((c) => c.trim()).filter((c) => c !== '')
const aptLine = (l: string) => !l.trim().startsWith('#') && APT_CALL.test(l)

// Every rule of this file against one workflow text: the list of what is wrong (empty = fine).
function violations(file: string, src: string): string[] {
  const { steps, errors } = parseWorkflow(file, src)
  const out = [...errors]
  const raw = src.split('\n').filter(aptLine).length
  const seen = steps.reduce((n, s) => n + s.runLines.filter(aptLine).length, 0)
  if (raw !== seen) out.push(`${file}: ${raw} line(s) name apt, but only ${seen} sit in a run block this reader parsed`)
  for (const s of steps) {
    const apt = commands(s.run).filter((c) => APT_CALL.test(c))
    if (apt.length === 0) continue
    if (s.timeout === null || !Number.isInteger(s.timeout) || s.timeout < 1 || s.timeout > MAX_MINUTES) {
      out.push(`${s.file}:${s.line} ${s.name ?? '(unnamed)'}: timeout-minutes=${s.timeout} (needs 1..${MAX_MINUTES} on the step)`)
    }
    for (const c of apt) {
      if (!/\bapt-get\s/.test(c) || !APT_FLAGS.every((fl) => c.includes(fl))) out.push(`${s.file}:${s.line}: ${c}`)
    }
  }
  return out
}

const TEXT = Object.fromEntries(WORKFLOWS.map((f) => [f, readFileSync(join(WF_DIR, f), 'utf-8')]))
const ALL = WORKFLOWS.flatMap((f) => parseWorkflow(f, TEXT[f]).steps)

describe('CI apt step: a hard time limit, retries, only ffmpeg, no cache (Johnny 12210)', () => {
  it('reads the steps of the workflows (the reader must not find nothing)', () => {
    expect(WORKFLOWS).toContain('test.yml')
    expect(ALL.filter((s) => s.file === 'test.yml').length).toBeGreaterThan(5)
    expect(ALL.filter((s) => s.name === STEP_NAME)).toHaveLength(1)
  })

  it('every workflow is in a form this reader parses, and every apt call in it keeps the rules', () => {
    expect(WORKFLOWS.flatMap((f) => violations(f, TEXT[f]))).toEqual([])
  })

  it(`the ffmpeg step: timeout-minutes is exactly ${MAX_MINUTES}`, () => {
    expect(ALL.find((s) => s.name === STEP_NAME)!.timeout).toBe(MAX_MINUTES)
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
    const uses = WORKFLOWS.flatMap((f) => TEXT[f].split('\n')
      .filter((l) => /^\s*(-\s+)?['"]?uses['"]?\s*:/.test(l)).map((l) => `${f}: ${l.trim()}`))
    expect(uses.length).toBeGreaterThan(0)
    expect(uses.filter((u) => /cache|apt|ffmpeg/i.test(u.split('uses')[1]))).toEqual([])
  })

  // Fixtures: each must give at least one violation. F1-F8 are Ron's forms (12365) that the first version let through.
  const wf = (...step: string[]) => ['jobs:', '  test:', '    runs-on: ubuntu-latest', '    steps:', ...step, ''].join('\n')
  const GOOD = [
    "      - name: Install ffmpeg for the resize hook's tests",
    '        timeout-minutes: 8',
    '        run: |',
    '          sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update',
    '          sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y --no-install-recommends ffmpeg',
  ]
  it('control: the step as it is now gives no violation', () => {
    expect(violations('good.yml', wf(...GOOD))).toEqual([])
  })

  // the joins are real, not only a stricter match: a call split over lines with its flags on both is ONE good call
  it('control: a backslash-continued call and a folded call, flags split over the lines, give no violation', () => {
    const F = APT_FLAGS
    expect(violations('cont.yml', wf('      - name: x', '        timeout-minutes: 8', '        run: |',
      `          sudo apt-get ${F[0]} \\`, `            ${F[1]} install -y --no-install-recommends ffmpeg`))).toEqual([])
    expect(violations('fold.yml', wf('      - name: x', '        timeout-minutes: 8', '        run: >',
      `          sudo apt-get ${F[0]}`, `          ${F[1]} install -y --no-install-recommends ffmpeg`))).toEqual([])
  })

  it.for<{ name: string; src: string }>([
    { name: 'the old one-line step (before this change)',
      src: wf("      - name: Install ffmpeg for the resize hook's tests", '        run: sudo apt-get update && sudo apt-get install -y ffmpeg') },
    { name: 'F1: a backslash continuation (apt-get\\ + the next line), no flags, no timeout',
      src: wf('      - name: x', '        run: |', '          sudo apt-get\\', '            install -y ffmpeg') },
    { name: 'F4: a folded block (run: >) that puts apt-get and install on two lines',
      src: wf('      - name: x', '        run: >', '          sudo apt-get', '          install -y ffmpeg') },
    { name: 'F5: a flow-style step',
      src: wf('      - {name: x, run: sudo apt-get install -y ffmpeg}') },
    { name: 'F6: a quoted run scalar with a literal \\n hiding a second call',
      src: wf('      - name: x', '        timeout-minutes: 8',
        '        run: "sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update\\nsudo apt-get install -y ffmpeg"') },
    { name: 'F8: a job-level timeout-minutes instead of the step\'s',
      src: ['jobs:', '  test:', '    runs-on: ubuntu-latest', '    timeout-minutes: 8', '    steps:',
        '      - name: x', '        run: sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y ffmpeg', ''].join('\n') },
    { name: 'an apt call without the trailing space the first version needed (apt-get at the line end)',
      src: wf('      - name: x', '        timeout-minutes: 8', '        run: |', '          sudo apt-get') },
    { name: 'a flow-style step even without apt (a form this reader does not parse)',
      src: wf('      - {uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262}') },
    { name: 'an apt call outside any run block (a script input of an action)',
      src: wf('      - name: x', `        uses: actions/github-script@${'0'.repeat(40)}`, '        with:',
        '          script: |', "            exec('sudo apt-get install -y ffmpeg')") },
  ])('a form the rules must catch: $name', ({ src }) => {
    expect(violations('fixture.yml', src)).not.toEqual([])
  })
})
