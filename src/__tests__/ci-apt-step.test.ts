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
//     And it was changed, by decision, for THIS case only (C2, Johnny 12569 option 1, Kevin 12570): the .deb files
//     come through actions/cache/restore + actions/cache/save, under six conditions, pinned in the "the .deb cache"
//     cases below and in ci-workflow-pins.test.ts. No other cache, apt or ffmpeg action is allowed.
// The time limit must be on the STEP: a job-level timeout-minutes does not count, on purpose (Ron 12365, F8). A job
// limit would stop the whole run late instead of naming the step that hung.
//
// Line-based, like ci-workflow-pins.test.ts: the workflows are small and hand-written, and a YAML parser would add a
// dependency only for this. So the reader is strict about the forms it accepts (Ron 12365, 12421):
//   - a step must be a block mapping (`- name: ...`); a flow-style step (`- {name: ..., run: ...}`) is an error;
//   - run must be a plain one-line scalar or a literal block (|, |-, |+), the form test.yml uses. A quoted scalar is an
//     error (its escapes, like a literal \n, would hide a second command), and so is a folded block (>, >-, >+): how
//     YAML folds it (more-indented lines and blank lines keep their line break) is not modelled, so it is not accepted;
//   - a literal block ends at the first non-blank line at or left of the step's keys; a blank line inside it stays a
//     line break;
//   - a backslash at a line end joins the IMMEDIATELY next line, and only if that line is not blank, as the shell does:
//     `apt-get \` + `install ...` is one call, `update \` + a blank line + `apt-get install ...` is two;
//   - every non-comment line of a workflow that names apt must sit in a run block this reader parsed (the count of such
//     lines in the raw text and in the parsed runs must match).
// What it does NOT model, so a form built on these can still slip past; they are documented limits, not open rounds
// (Kevin 12430):
//   - YAML: anchors, aliases and merge keys (&, *, <<), several documents in one file (---), tags (!!str), quoted or
//     complex keys ("run":, ? run), tabs, and a block line indented between the key and the block's content;
//   - shell: quoting (a backslash or # inside quotes), an escaped backslash at a line end (\\), a comment after a
//     command on the same line, a heredoc body, and any indirect call (a variable, an alias, a function, eval,
//     sh -c, a script file); commands are split only at a line break, &&, || and ;.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const WF_DIR = join(ROOT, '.github', 'workflows')
const WORKFLOWS = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort()
const STEP_NAME = "Install ffmpeg for the resize hook's tests"
const KEY_STEP = 'Resolve the ffmpeg .deb set and its cache key'
const RESTORE_STEP = 'Restore the ffmpeg .deb cache'
const SAVE_STEP = 'Save the ffmpeg .deb cache (a push to main only)'
const DEB_DIR = '"$HOME/ffmpeg-debs"'
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
      // blank and comment lines never end a step, but they stay in its body: a blank line inside a run block is a
      // line break the shell sees (Ron 12421, F28)
      if (isBlank(l)) { if (cur) cur.body.push(l); continue }
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
    // the block: every line after run: up to the first non-blank line at or left of the keys
    const block: string[] = []
    for (const l of body.slice(runAt + 1)) {
      if (l.trim() !== '' && indentOf(l) <= keyIndent) break
      block.push(l)
    }
    if (/^\|[-+]?$/.test(inline)) {
      runLines = block
      run = joinContinuations(block.map((l) => l.trimStart()))
    } else if (/^>[-+]?$/.test(inline)) {
      errors.push(`${file}:${line}: a folded run block (${inline}) this reader does not parse; only | is supported`)
      runLines = block
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
    run,
    runLines,
  }
}

// A backslash at a line end joins the immediately next line, as the shell does; when that line is blank, the join adds
// nothing and the command ends there, so the line after the blank is a command of its own.
function joinContinuations(lines: string[]): string {
  const out: string[] = []
  let joining = false
  for (const l of lines) {
    if (joining) out[out.length - 1] += ' ' + l.replace(/\\$/, '')
    else out.push(l.replace(/\\$/, ''))
    joining = l.endsWith('\\')
  }
  return out.join('\n')
}

// One command per line, split at && ; || (enough for these hand-written steps); a comment line is not a command.
const commands = (run: string) => run.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
  .split(/\n|&&|\|\||;/).map((c) => c.trim()).filter((c) => c !== '')
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

  const words = (c: string) => c.replace(/-o\s+\S+/g, '').split(/\s+/).filter((w) => w !== '' && w !== 'sudo' && w !== 'apt-get')
  const aptCmds = (name: string) => commands(ALL.find((s) => s.name === name)!.run).filter((c) => APT_CALL.test(c))

  it('the key step: one update, then the --print-uris of ffmpeg alone, -y --no-install-recommends', () => {
    expect(aptCmds(KEY_STEP).map(words)).toEqual([
      ['update'],
      ['install', '--print-uris', '-qq', '-y', '--no-install-recommends', 'ffmpeg', '>', '"$RUNNER_TEMP/ffmpeg-uris.txt"'],
    ])
  })

  it('the ffmpeg step: prune the cached .deb files FIRST, then one install of ffmpeg alone (Johnny 12569 (5))', () => {
    const cmds = commands(ALL.find((s) => s.name === STEP_NAME)!.run)
    expect(cmds[0]).toBe(`python3 scripts/deb-cache-verify.py prune ${DEB_DIR}`)
    expect(cmds.slice(1).map(words)).toEqual([['install', '-y', '--no-install-recommends', 'ffmpeg']])
  })

  it('the print-uris and the install read and write the one cached dir', () => {
    for (const c of [...aptCmds(KEY_STEP).slice(1), ...aptCmds(STEP_NAME)]) expect(c).toContain(`-o Dir::Cache::Archives=${DEB_DIR} `)
    // the install keeps its downloads, whatever an image's apt.conf says: a deleted .deb is a cache that never fills
    expect(aptCmds(STEP_NAME)[0]).toContain('-o APT::Keep-Downloaded-Packages=true ')
  })

  it('no cache action but the two .deb cache steps, no apt action, no ffmpeg setup action (Johnny 12210, 12569 (1))', () => {
    const uses = WORKFLOWS.flatMap((f) => TEXT[f].split('\n')
      .filter((l) => /^\s*(-\s+)?['"]?uses['"]?\s*:/.test(l)).map((l) => `${f}: ${l.trim().replace(/^-\s+/, '')}`))
    expect(uses.length).toBeGreaterThan(0)
    expect(uses.filter((u) => /cache|apt|ffmpeg/i.test(u.split('uses')[1]))).toEqual([
      'test.yml: uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9  # v6.1.0',
      'test.yml: uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9  # v6.1.0',
    ])
  })

  // The raw lines of one step of test.yml, from its `- name:` to the next step: the cache steps have no run block, so
  // the reader above does not see their `with:`.
  const stepLines = (name: string): string[] => {
    const lines = TEXT['test.yml'].split('\n')
    const at = lines.findIndex((l) => l.trim() === `- name: ${name}`)
    expect(at, name).toBeGreaterThan(-1)
    const ind = indentOf(lines[at])
    const end = lines.findIndex((l, i) => i > at && l.trim() !== '' && indentOf(l) <= ind)
    return lines.slice(at, end === -1 ? undefined : end).map((l) => l.trim())
  }

  it('the .deb cache: only ~/ffmpeg-debs/*.deb, under the key step\'s key, restored before and saved after the install (3)', () => {
    for (const name of [RESTORE_STEP, SAVE_STEP]) {
      const body = stepLines(name)
      expect(body.filter((l) => /^path:/.test(l)), name).toEqual(['path: ~/ffmpeg-debs/*.deb'])
      expect(body.filter((l) => /^key:/.test(l)), name).toEqual(['key: ${{ steps.ffmpeg-key.outputs.key }}'])
      // one path line, no path list: a `path: |` block could add more than the .deb files
      expect(body.some((l) => /^path:\s*[|>]/.test(l)), name).toBe(false)
      expect(body.some((l) => /^restore-keys:/.test(l)), name).toBe(false)
    }
    const order = [KEY_STEP, RESTORE_STEP, STEP_NAME, SAVE_STEP].map((n) => TEXT['test.yml'].indexOf(`- name: ${n}\n`))
    expect(order.every((at, i) => at > -1 && (i === 0 || at > order[i - 1])), String(order)).toBe(true)
    expect(stepLines(KEY_STEP)).toContain('id: ffmpeg-key')
    expect(stepLines(RESTORE_STEP)).toContain('id: ffmpeg-debs')
    // the save reads the prune's unverified output by this id (ci-workflow-pins.test.ts pins the condition)
    expect(stepLines(STEP_NAME)).toContain('id: ffmpeg-install')
  })

  it('the .deb cache key holds the runner image, the ffmpeg version and the .deb set hash, and fails empty (4)', () => {
    const run = ALL.find((s) => s.name === KEY_STEP)!.run
    // the image variables must be set, or the step fails before any key is written
    expect(run.split('\n')[0]).toBe(': "${ImageOS:?}" "${ImageVersion:?}"')
    expect(run).toContain('set_key="$(python3 scripts/deb-cache-verify.py key "$RUNNER_TEMP/ffmpeg-uris.txt" ffmpeg)"')
    expect(run).toContain('echo "key=ffmpeg-debs-$ImageOS-$ImageVersion-$set_key" >> "$GITHUB_OUTPUT"')
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

  // the join is real, not only a stricter match: a call split over lines with its flags on both is ONE good call
  it('control: a backslash-continued call, flags split over the lines, gives no violation', () => {
    const F = APT_FLAGS
    expect(violations('cont.yml', wf('      - name: x', '        timeout-minutes: 8', '        run: |',
      `          sudo apt-get ${F[0]} \\`, `            ${F[1]} install -y --no-install-recommends ffmpeg`))).toEqual([])
  })

  // a blank line inside a literal block is kept and does not end the block (Ron 12421); a comment line is no command
  it('control: two good calls with a blank line and a comment line naming apt between them give no violation', () => {
    expect(violations('blank.yml', wf(...GOOD.slice(0, 4), '', '          # apt-get takes the flags above', GOOD[4])))
      .toEqual([])
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
    // Ron 12421: forms that hid a flagless second call behind the two controls above (Kevin 12430)
    { name: 'F12: a folded block whose second call is MORE indented (YAML keeps that line break)',
      src: wf('      - name: x', '        timeout-minutes: 8', '        run: >',
        '          sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update',
        '            sudo apt-get install -y ffmpeg') },
    { name: 'F27: a blank line inside a folded block (YAML keeps it as a line break)',
      src: wf('      - name: x', '        timeout-minutes: 8', '        run: >',
        '          sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update', '',
        '          sudo apt-get install -y ffmpeg') },
    { name: 'a folded block (run: >-), even one that splits a single good call over two lines',
      src: wf('      - name: x', '        timeout-minutes: 8', '        run: >-',
        '          sudo apt-get -o Acquire::Retries=3', '          -o Acquire::http::Timeout=30 install -y --no-install-recommends ffmpeg') },
    { name: 'F28: a backslash, then a blank line, then a call (the backslash joins nothing, the call stands alone)',
      src: wf('      - name: x', '        timeout-minutes: 8', '        run: |',
        '          sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \\', '',
        '          sudo apt-get install -y ffmpeg') },
    { name: 'a backslash on the last run line, with the flags in a later key of the step (the run block ends at it)',
      src: wf('      - name: x', '        timeout-minutes: 8', '        run: |', '          sudo apt-get install -y ffmpeg \\',
        '        env:', '          FLAGS: -o Acquire::Retries=3 -o Acquire::http::Timeout=30') },
    { name: 'an apt call outside any run block (a script input of an action)',
      src: wf('      - name: x', `        uses: actions/github-script@${'0'.repeat(40)}`, '        with:',
        '          script: |', "            exec('sudo apt-get install -y ffmpeg')") },
  ])('a form the rules must catch: $name', ({ src }) => {
    expect(violations('fixture.yml', src)).not.toEqual([])
  })
})
