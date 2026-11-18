// channels.sh runs the Telegram and Discord plugin patchers with the config dir THIS session launches from
// (kanban 4632b847, Johnny 17396). The main-agent config section ends with
// `unset _cfg_raw _cfg_line _cfg_mode _cfg_dir`, and both patch blocks used to read "$_cfg_dir" after it, so the
// patchers got CLAUDE_CONFIG_DIR= (empty) and wrote ~/.claude's plugin cache instead of the isolated one. The text
// pins in patch-telegram-plugin.test.ts / patch-discord-plugin.test.ts could not see that: the text was there, the
// value was not. Here the REAL launcher text runs in bash, cut from anchored sections (Ron 17655 F1), with a stub
// python3 first on PATH that records what each patcher call receives.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync, chmodSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHANNELS = readFileSync(join(REPO, 'scripts', 'channels.sh'), 'utf8')

const count = (hay: string, needle: string) => hay.split(needle).length - 1

// One anchored section of the launcher: the start anchor occurs exactly once, the end marker is the first one after
// it, and the section must carry `mustContain` (an empty or moved section is red, never a silent no-op).
function section(src: string, start: string, end: string, mustContain: string): string {
  expect(count(src, start), `start anchor occurs exactly once: ${JSON.stringify(start.slice(0, 60))}`).toBe(1)
  const from = src.indexOf(start)
  const to = src.indexOf(end, from + start.length)
  expect(to, `end marker after ${JSON.stringify(start.slice(0, 60))}`).toBeGreaterThan(from)
  const text = src.slice(from, to + end.length)
  expect(text).toContain(mustContain)
  return text
}

type Sections = { quote: string; config: string; rec: string; telegram: string; discord: string }
function sections(src: string): Sections {
  const quoteLines = src.split('\n').filter((line) => line.startsWith('sh_single_quote() {'))
  expect(quoteLines).toHaveLength(1)
  const s = {
    quote: quoteLines[0],
    // The whole main-agent config section, from its `CFG_ENV=""` to the unset of the node binary (F3).
    config: section(src, '\nCFG_ENV=""\n', '\nunset _node_bin\n', 'unset _cfg_raw _cfg_line _cfg_mode _cfg_dir'),
    // Only the end of that section: the _rec_* copy and the unset of the working variables (F1, F2).
    rec: section(src, '\n  if [ -n "$CFG_ENV" ]; then\n    _rec_mode="$_cfg_mode"\n', '\n  unset _cfg_raw _cfg_line _cfg_mode _cfg_dir\n', '_rec_dir="$_cfg_dir"'),
    telegram: section(src, '\nif [ "$CHANNEL_PROVIDER" = "telegram" ]; then\n  if [ -n "$CFG_ENV" ]; then\n', '\nfi\n', 'scripts/patch-telegram-plugin.py'),
    discord: section(src, '\ncase " $CHANNEL_PROVIDER $CHANNEL_PLUGINS_EXTRA " in\n  *" discord "*', '\nesac\n', 'scripts/patch-discord-plugin.py'),
  }
  // Launcher order: config section, then Telegram, then Discord. The auth-file section between them is NOT run.
  expect(src.indexOf(s.config)).toBeLessThan(src.indexOf(s.telegram))
  expect(src.indexOf(s.telegram)).toBeLessThan(src.indexOf(s.discord))
  return s
}

let base: string
let inst: string
let home: string
let stubDir: string
let stubLog: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-patch-cfgdir-')))
  inst = join(base, 'inst')
  home = join(base, 'home')
  stubDir = join(base, 'stub-bin')
  stubLog = join(base, 'python3-calls.tsv')
  for (const d of [join(inst, 'store'), join(inst, 'scripts'), join(inst, 'dist', 'web'), join(home, '.claude'), stubDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(inst, 'dist', 'web', 'agent-process.js'), '')
  writeFileSync(join(inst, 'store', '.claude-oauth-token'), 'fixture-token\n', { mode: 0o600 })
  // python3: one line per call, the CLAUDE_CONFIG_DIR it got (EMPTY and UNSET told apart) and its argv.
  writeFileSync(join(stubDir, 'python3'), '#!/bin/sh\nprintf \'%s\\t%s\\n\' "${CLAUDE_CONFIG_DIR-<unset>}" "$*" >> "$STUB_LOG"\nexit 0\n')
  // node: the config helper's contract line on fd 3 (the launcher reads it there), a plan token for token mode,
  // silence for the custom-provider helper.
  writeFileSync(join(stubDir, 'node'), [
    '#!/bin/sh',
    'case "$1" in',
    '  *main-agent-isolated-config.mjs) printf \'%s\\n\' "$STUB_CFG_LINE" >&3; exit 0 ;;',
    '  *resolve-plan-token-env.mjs) printf \'plan-token\\n\'; exit 0 ;;',
    'esac',
    'exit 0',
  ].join('\n') + '\n')
  writeFileSync(join(stubDir, 'curl'), '#!/bin/sh\nexit 1\n')
  for (const f of ['python3', 'node', 'curl']) chmodSync(join(stubDir, f), 0o755)
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

type Call = { cfg: string; argv: string }
function calls(): Call[] {
  if (!existsSync(stubLog)) return []
  return readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).map((line) => {
    const [cfg, argv] = line.split('\t')
    return { cfg, argv }
  })
}
const patcherArgv = (p: 'telegram' | 'discord') =>
  `${inst}/scripts/patch-${p}-plugin.py --state ${inst}/store/${p}-plugin-patch.json`

function run(body: string[], env: Record<string, string>) {
  const script = [`INSTALL_DIR=${JSON.stringify(inst)}`, 'log() { :; }', ...body].join('\n')
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { PATH: `${stubDir}:/usr/bin:/bin`, HOME: home, STUB_LOG: stubLog, ...env },
  })
  expect(r.status, r.stderr).toBe(0)
  return r
}

// The end of the config section with the _cfg_* values it had, then the two patch blocks (F1, F2).
function runPatchBlocks(s: Sections, opts: { cfgDir: string; cfgEnv: boolean; provider: string; extra: string }, env: Record<string, string> = {}) {
  return run([
    s.quote,
    `CHANNEL_PROVIDER=${opts.provider}`,
    `CHANNEL_PLUGINS_EXTRA=${JSON.stringify(opts.extra)}`,
    '_rec_mode=""; _rec_dir=""',
    `_cfg_raw=x; _cfg_line=x; _cfg_mode=isolated; _cfg_dir=${JSON.stringify(opts.cfgDir)}`,
    opts.cfgEnv ? `CFG_ENV="export CLAUDE_CONFIG_DIR=$(sh_single_quote "$_cfg_dir") && "` : 'CFG_ENV=""',
    s.rec,
    s.telegram,
    s.discord,
  ], env)
}

describe('the plugin patchers write the cache of the dir this session launches from (4632b847)', () => {
  let s: Sections
  beforeEach(() => {
    s = sections(CHANNELS)
  })

  it('isolated config: Telegram AND Discord each get the isolated dir, not empty, not the inherited one', () => {
    const iso = join(base, 'iso cfg')
    mkdirSync(iso)
    runPatchBlocks(s, { cfgDir: iso, cfgEnv: true, provider: 'telegram', extra: 'discord' }, { CLAUDE_CONFIG_DIR: join(base, 'inherited') })
    expect(calls()).toEqual([
      { cfg: iso, argv: patcherArgv('telegram') },
      { cfg: iso, argv: patcherArgv('discord') },
    ])
  })

  it('Discord as the primary provider: one call, the Discord patcher, with the isolated dir', () => {
    const iso = join(base, 'iso')
    mkdirSync(iso)
    runPatchBlocks(s, { cfgDir: iso, cfgEnv: true, provider: 'discord', extra: '' })
    expect(calls()).toEqual([{ cfg: iso, argv: patcherArgv('discord') }])
  })

  it('no CFG_ENV: the patchers run WITHOUT an override, with exactly the inherited CLAUDE_CONFIG_DIR', () => {
    const inherited = join(base, 'inherited cfg')
    runPatchBlocks(s, { cfgDir: '', cfgEnv: false, provider: 'telegram', extra: 'discord' }, { CLAUDE_CONFIG_DIR: inherited })
    expect(calls()).toEqual([
      { cfg: inherited, argv: patcherArgv('telegram') },
      { cfg: inherited, argv: patcherArgv('discord') },
    ])
  })

  it('no CFG_ENV and nothing inherited: CLAUDE_CONFIG_DIR stays UNSET (not set to empty)', () => {
    runPatchBlocks(s, { cfgDir: '', cfgEnv: false, provider: 'telegram', extra: 'discord' })
    expect(calls()).toEqual([
      { cfg: '<unset>', argv: patcherArgv('telegram') },
      { cfg: '<unset>', argv: patcherArgv('discord') },
    ])
  })

  it('positive control: the patch blocks reading the unset "$_cfg_dir" (the 4632b847 defect) hand the patchers an EMPTY value', () => {
    const swap = (t: string) => {
      expect(count(t, 'CLAUDE_CONFIG_DIR="$_rec_dir" python3')).toBe(1)
      return t.replace('CLAUDE_CONFIG_DIR="$_rec_dir" python3', 'CLAUDE_CONFIG_DIR="$_cfg_dir" python3')
    }
    const iso = join(base, 'iso')
    mkdirSync(iso)
    runPatchBlocks({ ...s, telegram: swap(s.telegram), discord: swap(s.discord) }, { cfgDir: iso, cfgEnv: true, provider: 'telegram', extra: 'discord' })
    expect(calls()).toEqual([
      { cfg: '', argv: patcherArgv('telegram') },
      { cfg: '', argv: patcherArgv('discord') },
    ])
  })
})

// F3: the REAL config section (stubbed config helper) decides the mode; the dir the patchers get must equal the
// CLAUDE_CONFIG_DIR that section's CFG_ENV exports in the pane.
describe('the patchers get exactly the dir CFG_ENV exports, in every CFG_ENV mode (Ron 17655 F3)', () => {
  let s: Sections
  beforeEach(() => {
    s = sections(CHANNELS)
  })

  function launch(cfgLine: string) {
    const r = run([
      s.quote,
      'CHANNEL_PROVIDER=telegram',
      'CHANNEL_PLUGINS_EXTRA=discord',
      s.config,
      s.telegram,
      s.discord,
      'printf \'%s\' "$CFG_ENV"',
    ], { STUB_CFG_LINE: cfgLine })
    const cfgEnv = r.stdout
    // What the pane's shell exports: run the CFG_ENV prefix itself and print the result.
    const pane = spawnSync('sh', ['-c', `${cfgEnv}printf '%s' "\${CLAUDE_CONFIG_DIR-<unset>}"`], {
      encoding: 'utf8',
      env: { PATH: `${stubDir}:/usr/bin:/bin`, HOME: home },
    })
    expect(pane.status, pane.stderr).toBe(0)
    return { cfgEnv, exported: pane.stdout }
  }

  for (const mode of ['explicit', 'rotated', 'isolated', 'token'] as const) {
    it(`${mode}: both patchers get the dir the pane exports`, () => {
      const dir = join(base, `cfg ${mode}`)
      mkdirSync(dir)
      const r = launch(mode === 'token' ? `token\t${dir}\tplan-secret-id` : `${mode}\t${dir}`)
      expect(r.cfgEnv).toContain('export CLAUDE_CONFIG_DIR=')
      expect(r.exported).toBe(dir)
      expect(calls()).toEqual([
        { cfg: r.exported, argv: patcherArgv('telegram') },
        { cfg: r.exported, argv: patcherArgv('discord') },
      ])
    })
  }

  it('no contract line: no CFG_ENV, the patchers run without an override', () => {
    const r = launch('')
    expect(r.cfgEnv).toBe('')
    expect(calls()).toEqual([
      { cfg: '<unset>', argv: patcherArgv('telegram') },
      { cfg: '<unset>', argv: patcherArgv('discord') },
    ])
  })
})

// F4: no CLAUDE_CONFIG_DIR="$var" in a launcher script reads a variable that was unset after its last assignment
// in the same scope (the function the use sits in, else the top level outside every function).
type Use = { file: string; line: number; name: string }
function functionRanges(lines: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{(.*)$/.exec(lines[i])
    if (!m) continue
    if (/\}\s*(#.*)?$/.test(m[2])) {
      ranges.push([i, i])
      continue
    }
    const close = new RegExp(`^${m[1]}\\}\\s*(#.*)?$`)
    let j = i + 1
    while (j < lines.length && !close.test(lines[j])) j++
    ranges.push([i, j])
    i = j
  }
  return ranges
}
function scan(file: string, text: string): { uses: Use[]; offending: Use[] } {
  const lines = text.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '$1'))
  const ranges = functionRanges(lines)
  const scopeOf = (i: number) => ranges.find(([a, b]) => i >= a && i <= b) ?? null
  const inScope = (i: number, scope: [number, number] | null) => (scope ? i >= scope[0] && i <= scope[1] : scopeOf(i) === null)
  const uses: Use[] = []
  const offending: Use[] = []
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/CLAUDE_CONFIG_DIR="?\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = m[1]
      const use = { file, line: i + 1, name }
      uses.push(use)
      const scope = scopeOf(i)
      const assign = new RegExp(`(^|[\\s;&|(])${name}=|\\bfor\\s+${name}\\s+in\\b|\\bread\\b[^;&|]*\\s${name}(\\s|;|$)`)
      const unset = new RegExp(`(^|[\\s;&|{(])unset\\s+(?!-f\\b)[^;&|]*\\b${name}(\\s|;|$)`)
      let lastAssign = -1
      let lastUnset = -1
      for (let k = 0; k < i; k++) {
        if (!inScope(k, scope)) continue
        if (assign.test(lines[k])) lastAssign = k
        if (unset.test(lines[k])) lastUnset = k
      }
      if (lastUnset > lastAssign) offending.push(use)
    }
  })
  return { uses, offending }
}
function launcherScripts(): string[] {
  const dirs = [join(REPO, 'scripts'), join(REPO, 'scripts', 'lib')]
  return dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.sh')).map((f) => join(d, f)))
}

describe('no CLAUDE_CONFIG_DIR="$var" reads an unset variable (scripts/*.sh, scripts/lib/*.sh; Ron 17655 F4)', () => {
  it('no offending use, and the scan really saw the function-local and top-level uses', () => {
    const all = launcherScripts().map((f) => scan(f.slice(REPO.length + 1), readFileSync(f, 'utf8')))
    const offending = all.flatMap((r) => r.offending).map((u) => `${u.file}:${u.line} $${u.name}`)
    expect(offending).toEqual([])
    const names = new Set(all.flatMap((r) => r.uses).map((u) => u.name))
    for (const n of ['_rec_dir', 'iso', 'cfg', 'probe_cfg', 'WORK']) expect(names).toContain(n)
  })

  it('positive control: the 4632b847 defect text is reported at exactly its two patcher lines', () => {
    expect(count(CHANNELS, 'CLAUDE_CONFIG_DIR="$_rec_dir" python3')).toBe(2)
    const unfixed = CHANNELS.split('CLAUDE_CONFIG_DIR="$_rec_dir" python3').join('CLAUDE_CONFIG_DIR="$_cfg_dir" python3')
    const expected = unfixed.split('\n').flatMap((line, i) => (line.includes('CLAUDE_CONFIG_DIR="$_cfg_dir" python3') ? [i + 1] : []))
    expect(expected).toHaveLength(2)
    expect(scan('scripts/channels.sh', unfixed).offending.map((u) => u.line)).toEqual(expected)
  })

  it('positive control: a function-local unset is scoped to its function', () => {
    const text = [
      'f() {',
      '  local d="/x"',
      '  unset d',
      '  CLAUDE_CONFIG_DIR="$d" true',
      '}',
      'd=/y',
      'CLAUDE_CONFIG_DIR="$d" true',
    ].join('\n')
    expect(scan('t.sh', text).offending.map((u) => u.line)).toEqual([4])
  })
})
