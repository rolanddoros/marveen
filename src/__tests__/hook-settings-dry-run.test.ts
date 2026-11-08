/**
 * C3-3a: the hook-settings dry-run (src/web/hooks/cli.ts) is read-only, provably, and reports what the
 * generator would write. Kevin 13793: measure that nothing opens the database or the network at import,
 * and include the import itself in the proof. The pattern is C1 PR 8a's (claude-md-dry-run-readonly.test.ts):
 *
 * 1. Import graph: cli.ts reaches only the listed modules and node builtins (no config.js, logger.js,
 *    db.ts, better-sqlite3, settings store), and imports only reading fs functions.
 * 2. Static ban: no writing fs call, child process, worker, socket, DNS, HTTP or fetch in any of them.
 * 3. Runtime: compiled with tsc, the CLI runs under `node --permission` with READ access to the build and
 *    the install only, behind a preloaded guard that reports every writing fs call and every network
 *    entry point (the permission model does not cover the network). The guard is loaded BEFORE the CLI's
 *    first import, so the import is inside the proof; a run that stops at argument parsing (exit 2) shows
 *    the import alone. stderr must stay empty, and the install tree's manifest unchanged.
 * 4. Positive controls through the SAME spawn helper.
 *
 * The temp install (test data) sits inside this checkout, not under TMPDIR: the registration guard refuses
 * every command naming a tmp path, so under /tmp or /var/tmp every hook would read as "not rendered".
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HOOK_MANIFEST, nodeGateCommand, pythonGateCommand, renderHooks } from '../web/hooks/manifest.js'
import { dryRun, formatDryRun, isRewrap, pairRewraps, runHookSettingsCli, type PlacedHook } from '../web/hooks/dry-run.js'
import { classifySpelling } from '../web/hooks/spellings.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI_SRC = join(REPO, 'src', 'web', 'hooks', 'cli.ts')
const FIXTURE = join(REPO, 'src', 'web', 'hooks', '__fixtures__', 'live-sub-hooks.12.json')

// ---- 1 + 2: static ---------------------------------------------------------

const ALLOWED_MODULES = [
  'src/env-parse.ts',
  'src/web/claude-md/agent-name.ts',
  'src/web/claude-md/line-diff.ts',
  'src/web/extra-hook-entries.ts',
  'src/web/hooks/cli.ts',
  'src/web/hooks/dry-run.ts',
  'src/web/hooks/manifest.ts',
  'src/web/hooks/spellings.ts',
  'src/web/hooks/sub-generator.ts',
  'src/web/hooks/sub-inputs.ts',
  'src/web/tmp-root-prefixes.ts',
]
const ALLOWED_BUILTINS = ['node:crypto', 'node:fs', 'node:path']
const ALLOWED_FS = ['existsSync', 'lstatSync', 'readFileSync', 'readdirSync', 'realpathSync', 'statSync']

function importGraph(entry: string): { modules: string[]; builtins: string[]; fsNames: string[]; dynamic: string[] } {
  const seen = new Set<string>()
  const builtins = new Set<string>()
  const fsNames = new Set<string>()
  const dynamic: string[] = []
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const src = readFileSync(file, 'utf-8')
    if (/\bimport\s*\(|\brequire\s*\(/.test(src)) dynamic.push(relative(REPO, file))
    for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*'([^']+)'/gm)) {
      const [, , typeOnly, what, spec] = m
      if (typeOnly) continue
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')))
      else {
        builtins.add(spec)
        if (spec === 'node:fs') for (const n of what.replace(/[{}]/g, '').split(',')) if (n.trim()) fsNames.add(n.trim())
      }
    }
    for (const m of src.matchAll(/^\s*import\s+'([^']+)'/gm)) dynamic.push(`${relative(REPO, file)}: side-effect import ${m[1]}`)
  }
  visit(entry)
  return { modules: [...seen].map((f) => relative(REPO, f)).sort(), builtins: [...builtins].sort(), fsNames: [...fsNames].sort(), dynamic }
}

const CALLS = 'writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|rm|rmSync|rmdir|'
  + 'rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|symlink|symlinkSync|link|linkSync|'
  + 'chmod|chmodSync|chown|chownSync|utimes|utimesSync|truncate|truncateSync|open|openSync|createWriteStream|'
  + 'atomicWriteFileSync|fetch|WebSocket|spawn|spawnSync|execSync|execFile|execFileSync|fork|Worker|Database'
const BANNED = new RegExp(String.raw`(?<![\w$.])(?:${CALLS}|exec)\s*\(|\.(?:${CALLS})\s*\(|`
  + String.raw`node:(?:child_process|worker_threads|net|http|https|http2|dgram|dns|tls|fs\/promises)|`
  + String.raw`\bfrom\s+'(?:fs|child_process|net|http|https|dns|tls|dgram|worker_threads|better-sqlite3)'`, 'g')

// Comments out, strings and regex literals intact (Ron N5: a line-based `//` strip also cut from a `//` inside a
// string to the end of the line). The TypeScript transpiler parses the module, so a `//` in a string or a regex is
// not a comment; verbatimModuleSyntax keeps every value import, also an unused one.
function codeWithoutComments(src: string, fileName: string): string {
  return ts.transpileModule(src, {
    fileName,
    compilerOptions: { removeComments: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
  }).outputText
}

describe('read-only: import graph and static ban', () => {
  const g = importGraph(CLI_SRC)

  it('cli.ts reaches only the listed modules (no config, logger, database or settings store) and builtins', () => {
    expect(g.modules).toEqual(ALLOWED_MODULES)
    expect(g.builtins).toEqual(ALLOWED_BUILTINS)
    expect(g.dynamic).toEqual([])
    expect(g.fsNames).toEqual(ALLOWED_FS)
  })

  it.each(ALLOWED_MODULES)('%s has no writing, spawning, database or network call', (rel) => {
    const code = codeWithoutComments(readFileSync(join(REPO, rel), 'utf-8'), rel)
    expect([...code.matchAll(BANNED)].map((m) => m[0])).toEqual([])
  })

  it('the comment strip keeps a call after a // inside a string or a regex, and drops real comments', () => {
    const code = codeWithoutComments("const u = 'http://x'; writeFileSync(u, '')\nconst r = /a\\/\\/b/; rmSync(r)\n// spawn('x')\n/* fork() */\n", 'probe.ts')
    expect([...code.matchAll(BANNED)].map((m) => m[0].replace(/\s+/g, ''))).toEqual(['writeFileSync(', 'rmSync('])
  })
})

// ---- the temp install -------------------------------------------------------

type Fixture = { hooks: unknown[]; agents: Record<string, { events: Record<string, Array<{ matcher?: string; hooks: number[] }>> }> }

function writeInstall(root: string, nodeBin: string): void {
  const fx = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as Fixture
  for (const [name, a] of Object.entries(fx.agents)) {
    const hooks = Object.fromEntries(Object.entries(a.events).map(([ev, gs]) => [ev, gs.map((g) => ({ ...g, hooks: g.hooks.map((i) => fx.hooks[i]) }))]))
    const dir = join(root, 'agents', name)
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const text = JSON.stringify({ permissions: { allow: [] }, hooks }, null, 2).replaceAll('${ROOT}', root).replaceAll('${NODE_BIN}', nodeBin)
    writeFileSync(join(dir, '.claude', 'settings.json'), text)
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify(name === 'sub-05' ? { team: { role: 'leader' } } : { securityProfile: 'default' }))
  }
  for (const s of new Set(HOOK_MANIFEST.entries.filter((e) => e.wrapper !== 'agentPrompt').map((e) => e.script))) {
    mkdirSync(dirname(join(root, s)), { recursive: true })
    copyFileSync(join(REPO, s), join(root, s))
  }
  cpSync(join(REPO, 'templates', 'profiles'), join(root, 'templates', 'profiles'), { recursive: true })
  mkdirSync(join(root, 'agents', 'sub-13'))
  writeFileSync(join(root, '.env'), 'MAIN_AGENT_ID=chief\n')
}

function manifestOf(dir: string): Record<string, string> {
  const m: Record<string, string> = {}
  const walk = (p: string) => {
    const st = lstatSync(p)
    const key = relative(dir, p) || '.'
    if (st.isDirectory()) {
      m[key] = `dir ${st.mode} ${st.mtimeMs}`
      for (const e of readdirSync(p).sort()) walk(join(p, e))
    } else {
      m[key] = `file ${st.size} ${st.mode} ${st.mtimeMs} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`
    }
  }
  walk(dir)
  return m
}

let base: string
let out: string
let install: string
let childTmp: string
let childHome: string
const NODE = process.execPath

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'hook-settings-readonly-'))
  out = join(base, 'dist')
  const tsc = spawnSync(process.execPath, [
    join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '--outDir', out, '--rootDir', join(REPO, 'src'),
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--strict', '--skipLibCheck', '--types', 'node', CLI_SRC,
  ], { encoding: 'utf-8', cwd: REPO })
  if (tsc.status !== 0) throw new Error(`tsc failed: ${tsc.stdout}${tsc.stderr}`)
  writeFileSync(join(out, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(out, 'guard.mjs'), GUARD)
  for (const [name, code] of Object.entries(CONTROLS)) writeFileSync(join(out, name), code)
  install = mkdtempSync(join(REPO, '.hook-settings-test-'))
  writeInstall(install, NODE)
  childTmp = join(base, 'child-tmp')
  childHome = join(base, 'child-home')
  mkdirSync(childTmp)
  mkdirSync(childHome)
}, 120_000)

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
  if (install?.startsWith(join(REPO, '.hook-settings-test-'))) rmSync(install, { recursive: true, force: true })
})

// ---- 3 + 4: runtime ----------------------------------------------------------

const GUARD = `import { syncBuiltinESMExports } from 'node:module'
import fs from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import dgram from 'node:dgram'
const hit = (name) => function () {
  process.stderr.write('NETWORK-ATTEMPT ' + name + '\\n')
  throw new Error('network call blocked by the test guard: ' + name)
}
net.connect = hit('net.connect'); net.createConnection = hit('net.createConnection'); net.Socket.prototype.connect = hit('net.Socket.connect')
tls.connect = hit('tls.connect')
for (const k of Object.keys(dns)) if (typeof dns[k] === 'function' && /^(lookup|resolve|reverse)/.test(k)) dns[k] = hit('dns.' + k)
http.request = hit('http.request'); http.get = hit('http.get'); https.request = hit('https.request'); https.get = hit('https.get')
http2.connect = hit('http2.connect'); dgram.createSocket = hit('dgram.createSocket')
globalThis.fetch = hit('fetch')
const report = (name) => process.stderr.write('FS-WRITE-ATTEMPT ' + name + '\\n')
const WRITERS = ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'cp',
  'symlink', 'link', 'chmod', 'lchmod', 'chown', 'lchown', 'utimes', 'lutimes', 'truncate']
const wrap = (obj, name, label) => {
  const orig = obj[name]
  if (typeof orig !== 'function') return
  obj[name] = function (...a) { report(label); return orig.apply(this, a) }
}
for (const w of WRITERS) { wrap(fs, w, w); wrap(fs, w + 'Sync', w + 'Sync'); wrap(fs.promises, w, 'promises.' + w) }
wrap(fs, 'createWriteStream', 'createWriteStream')
const writingFlag = (f) => f !== undefined && f !== null && f !== 'r' && f !== 'rs' && f !== 'sr' && f !== fs.constants.O_RDONLY
for (const [obj, name, label] of [[fs, 'open', 'open'], [fs, 'openSync', 'openSync'], [fs.promises, 'open', 'promises.open']]) {
  const orig = obj[name]
  obj[name] = function (...a) { if (writingFlag(a[1]) && typeof a[1] !== 'function') report(label + ' ' + a[1]); return orig.apply(this, a) }
}
syncBuiltinESMExports()
`

const CONTROLS: Record<string, string> = {
  'control-write-swallowed.mjs': "import { writeFileSync } from 'node:fs'\ntry { writeFileSync(process.argv[2] + '/written-by-control', 'x') } catch { /* swallowed */ }\n",
  'control-child.mjs': "import { execFileSync } from 'node:child_process'\nexecFileSync('/bin/true')\n",
  'control-fetch.mjs': "await fetch('http://127.0.0.1:9/')\n",
}

function sandboxed(script: string, args: string[]) {
  const r = spawnSync(process.execPath, [
    '--permission', `--allow-fs-read=${out}`, `--allow-fs-read=${install}`,
    '--import', join(out, 'guard.mjs'), join(out, script), ...args,
  ], { encoding: 'utf-8', cwd: childHome, env: { PATH: '/usr/bin:/bin', HOME: childHome, TMPDIR: childTmp, LANG: 'C.UTF-8' } })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

const CLI = join('web', 'hooks', 'cli.js')

describe('read-only: runtime under node --permission (read access only), guard preloaded before the import', () => {
  it.each([
    ['control-write-swallowed.mjs', 'FS-WRITE-ATTEMPT writeFileSync', 0],
    ['control-child.mjs', 'ERR_ACCESS_DENIED', 1],
    ['control-fetch.mjs', 'NETWORK-ATTEMPT fetch', 1],
  ])('positive control: %s is caught', (script, line, code) => {
    const before = manifestOf(install)
    const r = sandboxed(script, [install])
    expect(r.stderr).toContain(line)
    expect(r.code).toBe(code)
    expect(manifestOf(install)).toEqual(before)
  })

  it('the import alone (a run that stops at the arguments): no write, no network, exit 2', () => {
    const r = sandboxed(CLI, ['--bogus'])
    expect(r.code).toBe(2)
    expect(r.stderr).toBe('unknown argument: "--bogus"\nusage: hook-settings --dry-run --root <install> [--agent <name>]... [--node-bin <path>] [--json] [--diff] [--redact-names]\n')
  })

  it.each([[[]], [['--json']], [['--diff']], [['--redact-names', '--agent', 'sub-02']]])('the CLI %j on the 12 live blocks: EMPTY, nothing written, no network', (extra) => {
    const before = manifestOf(install)
    const r = sandboxed(CLI, ['--dry-run', '--root', install, '--node-bin', NODE, ...extra])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(manifestOf(install)).toEqual(before)
    expect(readdirSync(childTmp)).toEqual([])
    expect(readdirSync(childHome)).toEqual([])
  })
})

describe('the report', () => {
  it('12/12 EMPTY, the playwright hook kept on 5, one agent without settings, normalised order named', () => {
    const r = dryRun({ root: install, nodeBin: NODE })
    const text = formatDryRun(r)
    expect(r.exit).toBe(0)
    expect(text).toContain('\nsummary: 13 agent(s), 12/12 multiset EMPTY, 0 rewrap only, 1 without settings, 0 error; exit 0\n')
    expect(text.match(/kept as is: PostToolUse \[mcp__playwright__browser_\.\*\] browser-content-notice\.py timeout=(-|10)/g)).toHaveLength(5)
    expect(text).toContain('sub-01: profile default, hooks 39 -> 39, multiset EMPTY, normalised: UserPromptSubmit [9,1,1] -> [11]; PreToolUse order')
    expect(text).toContain('sub-05: profile applier')
    expect(text).toContain('sub-13: no-settings')
  })

  it('a doubled hook is a drift too: the multiset counts copies (exit 1, the extra copy named as dropped)', () => {
    const path = join(install, 'agents', 'sub-03', '.claude', 'settings.json')
    const original = readFileSync(path, 'utf-8')
    const s = JSON.parse(original)
    const group = s.hooks.PreToolUse.find((g: { hooks: Array<{ command?: string }> }) => JSON.stringify(g).includes('db-write-gate.mjs'))
    s.hooks.PreToolUse.push(JSON.parse(JSON.stringify(group)))
    writeFileSync(path, JSON.stringify(s))
    try {
      const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'] })
      expect(r.exit).toBe(1)
      expect(r.agents[0].dropped).toEqual(['PreToolUse [Bash|Write|Edit|MultiEdit|NotebookEdit] db-write-gate.mjs timeout=10'])
      expect(r.agents[0].added).toEqual([])
    } finally {
      writeFileSync(path, original)
    }
  })

  it('a missing hook is a drift: exit 1, named with event, matcher and script', () => {
    const path = join(install, 'agents', 'sub-03', '.claude', 'settings.json')
    const original = readFileSync(path, 'utf-8')
    const s = JSON.parse(original)
    s.hooks.PreToolUse = s.hooks.PreToolUse.filter((g: { hooks: Array<{ command?: string }> }) => !JSON.stringify(g).includes('db-write-gate.mjs'))
    writeFileSync(path, JSON.stringify(s))
    try {
      const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'] })
      expect(r.exit).toBe(1)
      expect(r.agents[0].added).toEqual(['PreToolUse [Bash|Write|Edit|MultiEdit|NotebookEdit] db-write-gate.mjs timeout=10'])
      expect(r.agents[0].dropped).toEqual([])
    } finally {
      writeFileSync(path, original)
    }
  })

  it('--redact-names, --json and --diff; usage errors exit 2', () => {
    const lines: string[] = []
    const errs: string[] = []
    expect(runHookSettingsCli(['--dry-run', '--root', install, '--node-bin', NODE, '--json', '--redact-names', '--diff', '--agent', 'sub-02'], (s) => lines.push(s), (s) => errs.push(s))).toBe(0)
    const data = JSON.parse(lines.join(''))
    expect(data).toMatchObject({ root: '${ROOT}', nodeBin: '${NODE_BIN}', mainAgentId: '${MAIN}', exit: 0 })
    expect(data.agents[0].diff).toContain('@@ ')
    expect(data.agents[0].diff).not.toContain(install)
    for (const argv of [['--root', install], ['--dry-run'], ['--dry-run', '--root', 'rel'], ['--dry-run', '--root', install, '--agent', 'nobody']]) {
      expect(runHookSettingsCli(argv, () => {}, (s) => errs.push(s))).toBe(2)
    }
    expect(errs.join('')).toContain('--dry-run is mandatory')
  })

  // Rewrites one agent's settings for the duration of fn, then puts the file back byte for byte.
  function withSettings(agent: string, edit: (s: Record<string, any>) => unknown, fn: () => void): void {
    const path = join(install, 'agents', agent, '.claude', 'settings.json')
    const original = readFileSync(path, 'utf-8')
    const s = JSON.parse(original)
    const text = edit(s)
    writeFileSync(path, typeof text === 'string' ? text : JSON.stringify(s, null, 2))
    try { fn() } finally { writeFileSync(path, original) }
  }
  const groupOf = (s: Record<string, any>, script: string) => s.hooks.PreToolUse.find((g: unknown) => JSON.stringify(g).includes(script))
  const hookOf = (s: Record<string, any>, event: string, script: string): Record<string, unknown> =>
    s.hooks[event].flatMap((g: { hooks: unknown[] }) => g.hooks).find((h: { command?: string }) => String(h.command).includes(`/${script}`))

  it('a changed matcher is a drift, never EMPTY (Ron N3)', () => {
    withSettings('sub-03', (s) => { groupOf(s, 'egress-gate.mjs').matcher = 'WebFetch|Read' }, () => {
      const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'] })
      expect(r.exit).toBe(1)
      expect(r.agents[0].dropped).toEqual(['PreToolUse [WebFetch|Read] egress-gate.mjs timeout=10'])
      expect(r.agents[0].added).toEqual(['PreToolUse [WebFetch] egress-gate.mjs timeout=10'])
    })
  })

  it('a changed timeout is never EMPTY: alone a listed rewrap (C3-5a), a gate\'s timeout without its deadline or any other field a drift (Ron N3)', () => {
    withSettings('sub-03', (s) => { hookOf(s, 'UserPromptSubmit', 'staleness-guard.py').timeout = 99999 }, () => {
      const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'] })
      expect(r.exit).toBe(0)
      expect([r.agents[0].dropped, r.agents[0].added]).toEqual([[], []])
      expect(r.agents[0].rewrapped).toEqual(['UserPromptSubmit [-] staleness-guard.py wrapper failOpenExecUnquoted -> failOpenExecUnquoted, deadline - -> -, timeout 99999 -> 10'])
      expect(r.summary).toMatchObject({ empty: 0, rewrapOnly: 1, drift: 0 })
    })
    // A gate's command carries its own deadline (timeout - 2): a timeout edited alone no longer matches it, so the
    // command is not a known spelling for that hook: a hand edit, shown as a drift.
    withSettings('sub-03', (s) => { groupOf(s, 'db-write-gate.mjs').hooks[0].timeout = 11 }, () => {
      const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'] })
      expect(r.exit).toBe(1)
      expect(r.agents[0].dropped).toEqual(['PreToolUse [Bash|Write|Edit|MultiEdit|NotebookEdit] db-write-gate.mjs timeout=11'])
      expect(r.agents[0].added).toEqual(['PreToolUse [Bash|Write|Edit|MultiEdit|NotebookEdit] db-write-gate.mjs timeout=10'])
    })
    withSettings('sub-03', (s) => { groupOf(s, 'db-write-gate.mjs').hooks[0].statusMessage = 'checking' }, () => {
      const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'] })
      expect(r.exit).toBe(1)
      expect([r.agents[0].dropped.length, r.agents[0].added.length]).toEqual([1, 1])
    })
  })

  it('a broken settings.json is exit 1, named without its text (Ron N3)', () => {
    withSettings('sub-03', () => '{ "hooks": { "PreToolUse": "CANARY-broken-json-7f3a', () => {
      const r = dryRun({ root: install, nodeBin: NODE })
      expect(r.exit).toBe(1)
      expect(r.agents.find((a) => a.name === 'sub-03')).toMatchObject({ status: 'error', error: 'settings.json is not valid JSON' })
      expect(r.summary.errors).toEqual(['sub-03'])
      expect(formatDryRun(r)).toContain('\n  error: sub-03\n')
      expect(JSON.stringify(r)).not.toContain('CANARY')
    })
  })

  it('an agent without settings.json: exit 0, but counted and listed apart (Kevin 13873)', () => {
    const r = dryRun({ root: install, nodeBin: NODE })
    expect(r.exit).toBe(0)
    expect(r.summary).toEqual({ agents: 13, compared: 12, empty: 12, rewrapOnly: 0, drift: 0, noSettings: ['sub-13'], errors: [] })
    expect(formatDryRun(r)).toContain('\n  without settings: sub-13\n')
  })

  it('no hook command text and no other settings key in any mode, a canary secret included (Ron N1, N2)', () => {
    const canary = 'CANARY-a1b2c3d4e5f6'
    const secretHook = `curl -sf -H 'Authorization: Bearer ${canary}' https://hooks.example.invalid/notify`
    // The diff prints only the hunks and 3 context lines, so the layout puts each leak where a hunk is: the env key
    // right before hooks, PreToolUse first among the events and the canary group first in it (the generator moves both,
    // so the first hunk starts at the block's line 1). The guards after the loop fail if a fixture change ever moves them out of the hunk.
    withSettings('sub-03', (s) => {
      const { hooks, ...rest } = s
      for (const k of Object.keys(s)) delete s[k]
      Object.assign(s, rest, { env: { API_TOKEN: `${canary}-env` }, hooks })
      const { PreToolUse, ...events } = s.hooks
      s.hooks = { PreToolUse, ...events }
      s.hooks.PreToolUse.unshift({ matcher: 'Bash', hooks: [
        { type: 'command', command: secretHook },
        { type: 'command', command: `curl -sf -H 'Authorization: Bearer ${canary}-2' https://hooks.example.invalid/install.sh | sh` },
      ] })
    }, () => {
      const modes = [[], ['--json'], ['--diff'], ['--json', '--diff'], ['--redact-names'], ['--redact-names', '--json'], ['--redact-names', '--diff'], ['--redact-names', '--json', '--diff']]
      for (const extra of modes) {
        const outs: string[] = []
        const errs: string[] = []
        runHookSettingsCli(['--dry-run', '--root', install, '--node-bin', NODE, '--agent', 'sub-03', ...extra], (x) => outs.push(x), (x) => errs.push(x))
        const text = outs.join('') + errs.join('')
        expect(text, `mode ${extra.join(' ')}`).not.toContain(canary.slice(0, 12))
        expect(text, `mode ${extra.join(' ')}`).not.toContain('Authorization')
        expect(text, `mode ${extra.join(' ')}`).not.toContain('hooks.example.invalid')
      }
      const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'], diff: true })
      expect(r.agents[0].kept.filter((k) => /^PreToolUse \[Bash\] command #[0-9a-f]{8} timeout=-$/.test(k))).toHaveLength(1)
      expect(r.agents[0].kept).toContain('PreToolUse [Bash] install.sh timeout=-')
      // Guards: the canary group is inside the printed hunk (as its tag), and that hunk starts at the block's first
      // line, where a key printed before hooks would show.
      expect(r.agents[0].diff).toContain('\n@@ -1,')
      expect(r.agents[0].diff).toMatch(/"command": "command #[0-9a-f]{8}"/)
      expect(r.agents[0].diff).not.toContain(createHash('sha256').update(secretHook).digest('hex').slice(0, 8))
      // The hooks key only: the env key is not in the diff, its context lines included.
      expect(r.agents[0].diff).not.toContain('"env"')
      expect(r.agents[0].diff).not.toContain('"permissions"')
    })
  })

  // The diff prints only hunks with 3 context lines, so a leak test puts its canaries where the first hunk is: extra
  // event keys first, then PreToolUse with the canary groups first in it (the generator moves both). Each test then
  // checks, as a guard, that its canaries are in the printed hunk as tags.
  function atTop(s: Record<string, any>, groups: unknown[], events: Record<string, unknown> = {}): void {
    const { PreToolUse, ...rest } = s.hooks
    s.hooks = { ...events, PreToolUse: [...groups, ...PreToolUse], ...rest }
  }
  function everyMode(agent: string): Array<[string, string]> {
    const modes = [[], ['--json'], ['--diff'], ['--json', '--diff'], ['--redact-names'], ['--redact-names', '--json'], ['--redact-names', '--diff'], ['--redact-names', '--json', '--diff']]
    return modes.map((extra) => {
      const out: string[] = []
      runHookSettingsCli(['--dry-run', '--root', install, '--node-bin', NODE, '--agent', agent, ...extra], (x) => out.push(x), (x) => out.push(x))
      return [`mode ${extra.join(' ')}`, out.join('')]
    })
  }

  it('hook fields off the short list are tags in every mode: url, headers, prompt, statusMessage, odd values (Ron N6)', () => {
    const c = 'CANARY-n6f1e2d3'
    withSettings('sub-03', (s) => atTop(s, [
      { matcher: 'Bash', note: `${c}-group-key`, hooks: [
        { type: 'http', url: `https://${c}-url.example.invalid/hook`, headers: { Authorization: `Bearer ${c}-hdr` }, timeout: 5, async: true },
        { type: 'agent', prompt: `${c}-prompt` },
        { type: 'command', command: '/opt/x/scripts/plain.py', statusMessage: `${c}-status`, timeout: `${c}-timeout` },
        { type: `${c}-type`, command: '/opt/x/scripts/odd.py' },
        `${c}-hook-string`,
      ] },
      `${c}-group-string`,
    ]), () => {
      for (const [mode, text] of everyMode('sub-03')) expect(text, mode).not.toContain(c.slice(0, 10))
      const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'], diff: true }).agents[0]
      for (const f of ['url', 'headers', 'prompt', 'statusMessage', 'timeout', 'type']) expect(r.diff, f).toMatch(new RegExp(`"${f}": "#[0-9a-f]{8}"`))
      expect(r.diff).toMatch(/"field #[0-9a-f]{8}": "#[0-9a-f]{8}"/)
      expect(r.diff).toMatch(/^[-+ ] {8}"#[0-9a-f]{8}",?$/m)
      expect(r.diff).toMatch(/^[-+ ] {4}"#[0-9a-f]{8}",?$/m)
      for (const plain of ['"type": "http"', '"timeout": 5', '"async": true', '"type": "agent"']) expect(r.diff).toContain(plain)
      expect(r.kept).toContainEqual(expect.stringMatching(/^PreToolUse \[Bash\] plain\.py timeout=#[0-9a-f]{8}$/))
      expect(r.kept).toContainEqual(expect.stringMatching(/^PreToolUse \[Bash\] odd\.py timeout=-$/))
      expect(r.kept).toContain('PreToolUse [Bash] agent timeout=-')
    })
  })

  it('a non-list event is named only when it is a known event, never by its key from the file (Ron N7)', () => {
    const c = 'CANARY-n7a9b8c7'
    withSettings('sub-03', (s) => { s.hooks[`${c}-event`] = 'x' }, () => {
      const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'] })
      expect(r.exit).toBe(1)
      expect(r.agents[0].error).toMatch(/^hooks\.event #[0-9a-f]{8} is not a list; the generator leaves this file alone$/)
      for (const [mode, text] of everyMode('sub-03')) expect(text, mode).not.toContain(c.slice(0, 10))
    })
    withSettings('sub-03', (s) => { s.hooks.Stop = 'x' }, () => {
      expect(dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'] }).agents[0].error).toBe('hooks.Stop is not a list; the generator leaves this file alone')
    })
  })

  it('an unknown event key with hooks is a tag in the labels and in --diff (Ron N7)', () => {
    const c = 'CANARY-n7e6f5a4'
    withSettings('sub-03', (s) => atTop(s, [], { [`${c}-event`]: [{ hooks: [{ type: 'command', command: '/opt/x/scripts/own.py' }] }] }), () => {
      for (const [mode, text] of everyMode('sub-03')) expect(text, mode).not.toContain(c.slice(0, 10))
      const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'], diff: true }).agents[0]
      expect(r.kept).toContainEqual(expect.stringMatching(/^event #[0-9a-f]{8} \[-\] own\.py timeout=-$/))
      expect(r.diff).toMatch(/^[-+ ] {2}"event #[0-9a-f]{8}": \[$/m)
    })
  })

  it('tags come from a per-run key that is never printed: the same within a run, new each run, not the plain sha256 (Ron 13906)', () => {
    const cmd = "curl -sf -H 'Authorization: Bearer 123456' https://hooks.example.invalid/notify"
    withSettings('sub-03', (s) => atTop(s, [{ matcher: 'Bash', hooks: [{ type: 'command', command: cmd }] }]), () => {
      const run = () => dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'], diff: true })
      const tagOf = (r: ReturnType<typeof dryRun>) => /^PreToolUse \[Bash\] command #([0-9a-f]{8}) /.exec(r.agents[0].kept.find((k) => k.startsWith('PreToolUse [Bash] command #'))!)![1]
      const [r1, r2] = [run(), run()]
      // The label's tag (the generated side) is the diff's tag (the current side): the same value, the same tag.
      expect(r1.agents[0].diff).toContain(`"command": "command #${tagOf(r1)}"`)
      expect(tagOf(r2)).not.toBe(tagOf(r1))
      const plain = createHash('sha256').update(cmd).digest('hex').slice(0, 8)
      for (const r of [r1, r2]) expect(JSON.stringify(r)).not.toContain(plain)
    })
  })

  it('--redact-names hides names that are not sub-NN too (Ron N3)', () => {
    const other = mkdtempSync(join(REPO, '.hook-settings-test-'))
    try {
      writeInstall(other, NODE)
      renameSync(join(other, 'agents', 'sub-02'), join(other, 'agents', 'alpha-real'))
      renameSync(join(other, 'agents', 'sub-07'), join(other, 'agents', 'omega-real'))
      const plain = JSON.stringify(dryRun({ root: other, nodeBin: NODE, diff: true }))
      expect(plain).toContain('alpha-real')
      const outs: string[] = []
      expect(runHookSettingsCli(['--dry-run', '--root', other, '--node-bin', NODE, '--redact-names', '--diff'], (x) => outs.push(x), () => {})).toBe(0)
      const red = dryRun({ root: other, nodeBin: NODE, diff: true, redactNames: true })
      for (const text of [outs.join(''), JSON.stringify(red)]) {
        expect(text).not.toContain('alpha-real')
        expect(text).not.toContain('omega-real')
        expect(text).not.toContain(other)
      }
      expect(red.agents.map((a) => a.name)).toEqual(Array.from({ length: 13 }, (_, i) => `sub-${String(i + 1).padStart(2, '0')}`))
    } finally {
      if (other.startsWith(join(REPO, '.hook-settings-test-'))) rmSync(other, { recursive: true, force: true })
    }
  }, 60_000)

  it('key names off Claude Code\'s hook schema are `field #tag` in every mode; known names print (Ron N8)', () => {
    const c = 'CANARY-n8d4c3b2'
    withSettings('sub-03', (s) => atTop(s, [
      { matcher: 'Bash', [`${c}-group-name`]: 1, hooks: [
        { type: 'command', command: '/opt/x/scripts/named.py', [`${c}-hook-name`]: true, statusMessage: 'x', once: true },
        { type: 'command', command: '/opt/x/scripts/proto.py', constructor: `${c}-ctor`, toString: `${c}-tostr`, valueOf: `${c}-valueof` },
      ] },
    ]), () => {
      for (const [mode, text] of everyMode('sub-03')) expect(text, mode).not.toContain(c.slice(0, 10))
      const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'], diff: true }).agents[0]
      expect(r.diff).toMatch(/^[-+ ] {6}"field #[0-9a-f]{8}": "#[0-9a-f]{8}",?$/m)
      expect(r.diff!.match(/^[-+ ] {10}"field #[0-9a-f]{8}": "#[0-9a-f]{8}",?$/gm)!.length).toBeGreaterThanOrEqual(4)
      for (const known of ['"matcher": "Bash"', '"statusMessage": "#', '"once": "#', '"hooks": [']) expect(r.diff).toContain(known)
      for (const name of ['constructor', 'toString', 'valueOf']) expect(r.diff).not.toContain(`"${name}"`)
    })
  })

  it('the extra-hooks file\'s errors are fixed texts in every mode: no parser fragment, key name or script path (Ron N9)', () => {
    const c = 'CANARY-n9e8d7c6'
    const file = join(install, 'store', 'extra-hooks.json')
    const dir = 'local-hooks'
    mkdirSync(dirname(file), { recursive: true })
    const cases: Array<[string, string[]]> = [
      [`${c} not json`, ['not valid JSON; every extra ignored']],
      [JSON.stringify({ entries: [
        { event: 'PreToolUse', script: `${dir}/${c}.py`, failClosed: false },
        { event: 'PreToolUse', script: `${dir}/x.py`, failClosed: false, [`${c}-key`]: 1 },
        `${c}-entry`,
        { event: `${c}-event`, script: `${dir}/x.py`, failClosed: false },
      ] }), ['entries[0]: invalid script; this entry is left out', 'entries[1]: unknown key(s); this entry is left out',
        'entries[2]: not an object; this entry is left out', 'entries[3]: invalid event; this entry is left out']],
      [JSON.stringify({ [`${c}-top`]: [] }), ['not an object with an "entries" array; every extra ignored']],
    ]
    try {
      for (const [text, errors] of cases) {
        writeFileSync(file, text)
        expect(dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'] }).extrasErrors).toEqual(errors)
        for (const [mode, out] of everyMode('sub-03')) {
          expect(out, mode).not.toContain(c.slice(0, 10))
          expect(out.replaceAll('\\"', '"'), mode).toContain(errors[0])
        }
      }
    } finally {
      rmSync(file, { force: true })
    }
  })

  it('an mcp_tool hook prints its type; its server, tool and input are tags (Ron N10)', () => {
    const c = 'CANARY-n10a1b2c'
    withSettings('sub-03', (s) => atTop(s, [{ matcher: 'Bash', hooks: [{ type: 'mcp_tool', server: `${c}-srv`, tool: `${c}-tool`, input: { q: `${c}-in` } }] }]), () => {
      for (const [mode, text] of everyMode('sub-03')) expect(text, mode).not.toContain(c.slice(0, 10))
      const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'], diff: true }).agents[0]
      expect(r.kept).toContain('PreToolUse [Bash] mcp_tool timeout=-')
      expect(r.diff).toContain('"type": "mcp_tool"')
      for (const f of ['server', 'tool', 'input']) expect(r.diff, f).toMatch(new RegExp(`"${f}": "#[0-9a-f]{8}"`))
    })
  })

  it('an unexpected throw prints only the error name: a __proto__ event key is exactly `unexpected error (TypeError)` (Ron N11)', () => {
    const own = '[{"hooks":[{"type":"command","command":"/opt/x/scripts/own.py"}]}]'
    withSettings('sub-03', (s) => JSON.stringify(s).replace('"hooks":{', `"hooks":{"__proto__":${own},`), () => {
      const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'] })
      expect(r.exit).toBe(1)
      expect(r.agents[0]).toMatchObject({ status: 'error', error: 'unexpected error (TypeError)' })
    })
  })

  it('a string async, an object matcher in a printed hunk: tags; two non-script commands: two tags in one run (Ron N11)', () => {
    const c = 'CANARY-n11f9e8d'
    withSettings('sub-03', (s) => atTop(s, [
      { matcher: { re: `${c}-matcher` }, hooks: [{ type: 'command', command: '/opt/x/scripts/m.py', async: `${c}-async` }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo one' }, { type: 'command', command: 'echo two' }] },
    ]), () => {
      for (const [mode, text] of everyMode('sub-03')) expect(text, mode).not.toContain(c.slice(0, 10))
      const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'], diff: true }).agents[0]
      expect(r.diff).toMatch(/^[-+ ] {6}"matcher": "#[0-9a-f]{8}",$/m)
      expect(r.diff).toMatch(/"async": "#[0-9a-f]{8}"/)
      const tags = r.kept.map((k) => /^PreToolUse \[Bash\] command (#[0-9a-f]{8}) timeout=-$/.exec(k)?.[1]).filter(Boolean)
      expect(tags).toHaveLength(2)
      expect(tags[0]).not.toBe(tags[1])
    })
  })

  // C3-5a: the rewrap pairing on the real install (the 12 live blocks, failOpenExecUnquoted / bare / gates).
  const hookPath = (script: string) => join(install, 'scripts', 'hooks', script)
  const quotedOpen = (script: string) => `bash -c '[ -f "${hookPath(script)}" ] && exec python3 "${hookPath(script)}"; exit 0'`

  it('a wrapper-only change between two known spellings is a rewrap: kinds listed, counted apart, exit 0 (C3-5a)', () => {
    withSettings('sub-03', (s) => { hookOf(s, 'UserPromptSubmit', 'staleness-guard.py').command = quotedOpen('staleness-guard.py') }, () => {
      const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'] })
      expect(r.exit).toBe(0)
      expect([r.agents[0].dropped, r.agents[0].added]).toEqual([[], []])
      const line = 'UserPromptSubmit [-] staleness-guard.py wrapper failOpenExec -> failOpenExecUnquoted, deadline - -> -, timeout 10 -> 10'
      expect(r.agents[0].rewrapped).toEqual([line])
      expect(r.summary).toMatchObject({ agents: 1, compared: 1, empty: 0, rewrapOnly: 1, drift: 0 })
      const text = formatDryRun(r)
      expect(text).toContain('sub-03: profile default, hooks 39 -> 39, multiset rewrap only ~1, ')
      expect(text).toContain(`\n  ~ ${line}\n`)
      expect(text).toContain('\nsummary: 1 agent(s), 0/1 multiset EMPTY, 1 rewrap only, 0 without settings, 0 error; exit 0\n')
    })
  })

  it('the two C3-5 shapes, as a rollback would see them: wrapper + timeout, and a gate\'s timeout with its deadline', () => {
    withSettings('sub-03', (s) => {
      Object.assign(hookOf(s, 'UserPromptSubmit', 'voice-reply-directive.py'), { command: quotedOpen('voice-reply-directive.py'), timeout: 180 })
      Object.assign(hookOf(s, 'PreToolUse', 'outgoing-copy-gate.py'), { command: pythonGateCommand(hookPath('outgoing-copy-gate.py'), [], 15), timeout: 15 })
    }, () => {
      const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'] })
      expect(r.agents[0].rewrapped.sort()).toEqual([
        'PreToolUse [mcp__plugin_telegram_telegram__reply|mcp__plugin_telegram_telegram__edit_message] outgoing-copy-gate.py wrapper failClosedPythonProbe -> failClosedPythonProbe, deadline 13 -> 8, timeout 15 -> 10',
        'UserPromptSubmit [-] voice-reply-directive.py wrapper failOpenExec -> failOpenExecUnquoted, deadline - -> -, timeout 180 -> 60',
      ])
      const lines: string[] = []
      expect(runHookSettingsCli(['--dry-run', '--root', install, '--node-bin', NODE, '--json', '--agent', 'sub-03'], (x) => lines.push(x), () => {})).toBe(0)
      expect(JSON.parse(lines.join('')).summary).toMatchObject({ rewrapOnly: 1, drift: 0 })
    })
  })

  it('a hand-edited managed hook is a drift, not a rewrap (exit 1): unknown text, a bare spelling where a failure blocks, another argument, root or field (Ron 14094)', () => {
    const p = hookPath('staleness-guard.py')
    const edits: Array<[string, (s: Record<string, any>) => void]> = [
      ['env prefix', (s) => { hookOf(s, 'UserPromptSubmit', 'staleness-guard.py').command = `CANARY_7f3a=1 python3 ${p}` }],
      ['bare on UserPromptSubmit', (s) => { hookOf(s, 'UserPromptSubmit', 'staleness-guard.py').command = `python3 "${p}"` }],
      ['redirect', (s) => { hookOf(s, 'UserPromptSubmit', 'staleness-guard.py').command = `bash -c '[ -f ${p} ] && exec python3 ${p} 2>/dev/null; exit 0'` }],
      ['argument', (s) => { const h = hookOf(s, 'Stop', 'marveen-commands.py'); h.command = String(h.command).replaceAll(' --stop', ' --halt') }],
      ['root', (s) => { const h = hookOf(s, 'UserPromptSubmit', 'staleness-guard.py'); h.command = String(h.command).replaceAll(install, '/old/install') }],
      ['field', (s) => { hookOf(s, 'UserPromptSubmit', 'staleness-guard.py').async = true }],
      // C3-5a-3 (Ron 14109): an open wrapper on a closed gate, same interpreter, path and arguments: a fail-mode flip.
      ['open wrapper on a closed gate', (s) => { hookOf(s, 'PreToolUse', 'outgoing-copy-gate.py').command = quotedOpen('outgoing-copy-gate.py') }],
    ]
    for (const [what, edit] of edits) {
      withSettings('sub-03', edit, () => {
        const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'], diff: true })
        expect([what, r.exit, r.agents[0].dropped.length, r.agents[0].added.length, r.agents[0].rewrapped]).toEqual([what, 1, 1, 1, []])
        for (const out of [formatDryRun(r), JSON.stringify(r)]) expect(out, what).not.toContain('CANARY_7f3a')
      })
    }
  })
})

describe('isRewrap: each pairing rule (C3-5a)', () => {
  const P = (script: string, root = '/r') => `${root}/scripts/hooks/${script}`
  const unquoted = (script: string, args = '', root = '/r') => `bash -c '[ -f ${P(script, root)} ] && exec python3 ${P(script, root)}${args}; exit 0'`
  const quoted = (script: string, args = '') => `bash -c '[ -f "${P(script)}" ] && exec python3 "${P(script)}"${args}; exit 0'`
  const at = (event: string, command: string, extra: Record<string, unknown> = {}, matcher?: string): PlacedHook =>
    ({ event, ...(matcher === undefined ? {} : { matcher }), hook: { type: 'command', command, timeout: 10, ...extra } })

  it('a rewrap: another known spelling, another timeout, or both', () => {
    expect(isRewrap(at('UserPromptSubmit', unquoted('staleness-guard.py')), at('UserPromptSubmit', quoted('staleness-guard.py')))).toBe(true)
    expect(isRewrap(at('SessionEnd', `python3 ${P('clear-capture.py')}`, { timeout: 15 }), at('SessionEnd', quoted('clear-capture.py'), { timeout: 15 }))).toBe(true)
    const gate = (t: number) => at('PreToolUse', pythonGateCommand(P('outgoing-copy-gate.py'), [], t), { timeout: t }, 'mcp__plugin_telegram_telegram__reply|mcp__plugin_telegram_telegram__edit_message')
    expect(isRewrap(gate(10), gate(15))).toBe(true)
  })

  it('a gate\'s timeout and its in-command deadline move together: a rewrap on either side; one moved alone is a drift on either side (Kevin 14099)', () => {
    const M = 'mcp__plugin_telegram_telegram__reply|mcp__plugin_telegram_telegram__edit_message'
    // g(d, t): the gate command rendered for timeout d (deadline d - 2), placed on a hook whose timeout is t.
    const py = (d: number, t: number) => at('PreToolUse', pythonGateCommand(P('outgoing-copy-gate.py'), [], d), { timeout: t }, M)
    const node = (d: number, t: number) => at('PreToolUse', nodeGateCommand('/usr/bin/node', P('egress-gate.mjs'), [], d), { timeout: t }, 'WebFetch')
    for (const g of [py, node]) {
      expect(isRewrap(g(10, 10), g(15, 15))).toBe(true)
      expect(isRewrap(g(15, 15), g(10, 10))).toBe(true)
      expect(isRewrap(g(10, 10), g(10, 15))).toBe(false)
      expect(isRewrap(g(10, 15), g(10, 10))).toBe(false)
      expect(isRewrap(g(10, 10), g(15, 10))).toBe(false)
      expect(isRewrap(g(15, 10), g(10, 10))).toBe(false)
    }
  })

  it('the same event: one entry under two events is not a rewrap across them', () => {
    const tool = (event: string) => at(event, unquoted('tool-log-capture.py'), {}, '*')
    expect(isRewrap(tool('PostToolUse'), tool('PostToolUse'))).toBe(true)
    expect(isRewrap(tool('PostToolUse'), tool('PostToolUseFailure'))).toBe(false)
  })

  it('the same matcher, an absent one included', () => {
    expect(isRewrap(at('PostToolUse', unquoted('tool-log-capture.py'), {}, '*'), at('PostToolUse', quoted('tool-log-capture.py')))).toBe(false)
  })

  it('both command hooks', () => {
    const typed = (type: string): PlacedHook => ({ event: 'UserPromptSubmit', hook: { type, command: unquoted('staleness-guard.py') } })
    expect(isRewrap(typed('command'), typed('command'))).toBe(true)
    expect(isRewrap(typed('http'), typed('http'))).toBe(false)
  })

  it('every field but command and timeout equal, nested values included', () => {
    const h = (extra: Record<string, unknown>) => at('UserPromptSubmit', unquoted('staleness-guard.py'), extra)
    expect(isRewrap(h({}), h({ async: true }))).toBe(false)
    expect(isRewrap(h({ input: { a: 1 } }), h({ input: { a: 2 } }))).toBe(false)
    expect(isRewrap(h({ input: { a: 1, b: 2 } }), h({ input: { b: 2, a: 1 } }))).toBe(true)
  })

  it('a manifest entry owns it: an operator\'s own script is never a rewrap', () => {
    expect(isRewrap(at('UserPromptSubmit', unquoted('operator-own.py')), at('UserPromptSubmit', quoted('operator-own.py')))).toBe(false)
  })

  it('both sides known spellings, with the same interpreter, script path and arguments', () => {
    expect(isRewrap(at('UserPromptSubmit', unquoted('staleness-guard.py', '', '/old')), at('UserPromptSubmit', quoted('staleness-guard.py')))).toBe(false)
    expect(isRewrap(at('Stop', unquoted('marveen-commands.py', ' --stop')), at('Stop', quoted('marveen-commands.py', ' --stop')))).toBe(true)
    expect(isRewrap(at('Stop', unquoted('marveen-commands.py', ' --stop')), at('Stop', quoted('marveen-commands.py', ' --halt')))).toBe(false)
    expect(isRewrap(at('UserPromptSubmit', `echo ${P('staleness-guard.py')}`), at('UserPromptSubmit', quoted('staleness-guard.py')))).toBe(false)
    expect(isRewrap(at('UserPromptSubmit', quoted('staleness-guard.py')), at('UserPromptSubmit', `${quoted('staleness-guard.py')} `))).toBe(false)
    // Another node binary is another interpreter: a drift, as before C3-5a (the dry-run's --node-bin note).
    const node = (bin: string) => at('PreToolUse', nodeGateCommand(bin, P('egress-gate.mjs'), [], 10), {}, 'WebFetch')
    expect(isRewrap(node('/usr/bin/node'), node('/usr/bin/node'))).toBe(true)
    expect(isRewrap(node('/usr/bin/node'), node('/opt/node/bin/node'))).toBe(false)
  })

  it('pairRewraps is one to one, in both directions', () => {
    const old = at('UserPromptSubmit', unquoted('staleness-guard.py'))
    const fresh = at('UserPromptSubmit', quoted('staleness-guard.py'))
    expect(pairRewraps([old, { ...old }], [fresh])).toMatchObject({ pairs: [[old, fresh]], dropped: [old], added: [] })
    expect(pairRewraps([old], [fresh, { ...fresh }])).toMatchObject({ pairs: [[old, fresh]], dropped: [], added: [fresh] })
  })

  // Ron 14094, probe1.ts: 19 behaviour-changing edits of a rendered sub command. Each must be a drift on either side:
  // as the generator's output (after) and as an operator's hand edit of the file (before).
  it('none of Ron\'s 19 behaviour changes passes as a rewrap, on either side, on any sub hook the manifest renders', () => {
    const ROOT = '/r'
    const NODE_BIN = '/usr/bin/node'
    const all = renderHooks(HOOK_MANIFEST, 'sub', {
      root: ROOT, nodeBin: NODE_BIN, profile: { destructiveGate: true, credentialGate: true, secondReviewer: true },
      agent: { heartbeat: true, threadReply: true, senderRolePolicy: 'strict', browser: true }, prompts: { precompact: 'x' },
    })
    const placed = Object.entries(all).flatMap(([event, groups]) => groups!.flatMap((g) => g.hooks.filter((h) => h.type === 'command')
      .map((h): PlacedHook => ({ event, ...(g.matcher === undefined ? {} : { matcher: g.matcher }), hook: h as Record<string, unknown> }))))
    expect(placed.length).toBeGreaterThan(40)
    const gateInv = /(python3 "[^"]+"|"\/usr\/bin\/node" "[^"]+")((?: [A-Za-z0-9_=.:-]+)*)(?=;)/g
    const mutations: Array<[string, (c: string, p: string) => string | null]> = [
      ['interpreter python3 -> bash (exec)', (c) => (c.includes('exec python3 ') ? c.replaceAll('exec python3 ', 'exec bash ') : null)],
      ['interpreter python3 -> bash (gate)', (c) => (/ python3 "/.test(c) ? c.replaceAll(' python3 "', ' bash "') : null)],
      ['env prefix before the interpreter', (c) => (c.includes('exec python3 ') ? c.replace('exec python3 ', 'exec env PYTHONPATH=/tmp/x python3 ') : null)],
      ['flag before the path', (c) => (c.includes('exec python3 ') ? c.replace('exec python3 ', 'exec python3 -S ') : null)],
      ['stderr redirect before the path', (c) => (c.includes('exec python3 ') ? c.replace('exec python3 ', 'exec python3 2>/dev/null ') : null)],
      ['exec dropped', (c) => (c.includes('&& exec ') ? c.replace('&& exec ', '&& ') : null)],
      ['open tail exit 0 -> exit 2', (c) => (c.endsWith("; exit 0'") ? `${c.slice(0, -"exit 0'".length)}exit 2'` : null)],
      ['[ -f P ] replaced by true', (c, p) => (c.includes(`[ -f ${p} ]`) ? c.replace(`[ -f ${p} ]`, 'true') : null)],
      ['tested path P, run path another script', (c, p) => (c.includes('&& exec python3 ') ? c.replace(`exec python3 ${p}`, `exec python3 ${ROOT}/scripts/hooks/other-evil.py`) : null)],
      ['run path = prefix + P', (c, p) => (c.includes('&& exec python3 ') ? c.replace(`exec python3 ${p}`, `exec python3 /tmp/x${p}`) : null)],
      ['|| true on the gate invocation', (c) => (c.includes('rc=$?') ? c.replaceAll(gateInv, '$1$2 || true') : null)],
      ['gate tail exit "$rc" -> exit 0', (c) => (c.endsWith('exit "$rc"') ? `${c.slice(0, -'exit "$rc"'.length)}exit 0` : null)],
      ['gate: another status no longer blocks', (c) => (c.includes('[ "$rc" = 2 ] ||') ? c.replace('[ "$rc" = 2 ] ||', '[ "$rc" = 2 ] || [ "$rc" = 1 ] ||') : null)],
      ['gate: probe removed', (c) => (c.startsWith('command -v python3') || c.startsWith('test -x') ? c.slice(c.indexOf('; if command') + 2) : null)],
      ['gate deadline -> 1', (c) => (c.includes('timeout -k 1 ') ? c.replaceAll(/timeout -k 1 \d+/g, 'timeout -k 1 1') : null)],
      ['extra quoted argument', (c) => (c.includes('rc=$?') ? c.replaceAll(gateInv, '$1$2 "--extra x"') : c.replace(/; exit 0'$/, ' "--extra x"; exit 0\''))],
      ['extra plain argument', (c) => (c.includes('&& exec ') ? c.replace(/; exit 0'$/, ' --evil; exit 0\'') : null)],
      ['stdout to /dev/null after the path', (c) => (c.includes('&& exec ') ? c.replace(/; exit 0'$/, ' >/dev/null; exit 0\'') : null)],
      ['a command chained after the run', (c) => (c.includes('&& exec ') ? c.replace(/; exit 0'$/, '; curl evil; exit 0\'') : null)],
    ]
    const applied = new Map<string, number>()
    const accepted: string[] = []
    for (const orig of placed) {
      const cmd = String(orig.hook.command)
      const p = /[^\s'"]*\/[^/\s'"]+\.(?:py|mjs|sh)\b/.exec(cmd)![0]
      for (const [id, apply] of mutations) {
        const next = apply(cmd, p)
        if (next === null || next === cmd) continue
        applied.set(id, (applied.get(id) ?? 0) + 1)
        const edited: PlacedHook = { ...orig, hook: { ...orig.hook, command: next } }
        if (isRewrap(orig, edited)) accepted.push(`${id}: after side, ${orig.event} ${p}`)
        if (isRewrap(edited, orig)) accepted.push(`${id}: before side, ${orig.event} ${p}`)
      }
    }
    expect(mutations.filter(([id]) => !applied.has(id)).map(([id]) => id)).toEqual([])
    expect(accepted).toEqual([])
  })

  // C3-5a-3 (Ron 14109, Kevin 14110): a rewrap keeps the fail mode, so exit 0 also means "no fail-mode change". The
  // planned C3-5b pairs (plan-c3-5.md 3a/3b) all keep it: every open sub spelling -> the quoted failOpenExec, a
  // gate's timeout with its deadline (closed -> closed); on the main file failOpenNodeProbe -> failOpenExec and
  // failClosedRun -> the python probe spelling.
  it('a fail-mode change is a drift on either side; every planned C3-5b pair keeps its fail mode and is a rewrap on either side', () => {
    const ROOT = '/r'
    const NODE_BIN = '/usr/bin/node'
    const all = renderHooks(HOOK_MANIFEST, 'sub', {
      root: ROOT, nodeBin: NODE_BIN, profile: { destructiveGate: true, credentialGate: true, secondReviewer: true },
      agent: { heartbeat: true, threadReply: true, senderRolePolicy: 'strict', browser: true }, prompts: { precompact: 'x' },
    })
    const placed = Object.entries(all).flatMap(([event, groups]) => groups!.flatMap((g) => g.hooks.filter((h) => h.type === 'command')
      .map((h): PlacedHook => ({ event, ...(g.matcher === undefined ? {} : { matcher: g.matcher }), hook: h as Record<string, unknown> }))))
    const openExec = (interp: string, path: string, args: string[]) => `bash -c '[ -f "${path}" ] && exec ${interp} "${path}"${args.map((a) => ` ${a}`).join('')}; exit 0'`
    const counts = { open: 0, closed: 0 }
    const wrong: string[] = []
    for (const orig of placed) {
      const s = classifySpelling(String(orig.hook.command), orig.hook.timeout, orig.event, 'sub')!
      const name = `${orig.event} ${s.path.slice(s.path.lastIndexOf('/') + 1)} ${s.kind}`
      if (s.failMode === 'open') {
        counts.open++
        // The planned C3-5b spelling of an open sub hook.
        const planned: PlacedHook = { ...orig, hook: { ...orig.hook, command: openExec(s.interpreter, s.path, s.args) } }
        if (!isRewrap(orig, planned) || !isRewrap(planned, orig)) wrong.push(`planned pair not a rewrap: ${name}`)
      } else {
        counts.closed++
        // The same interpreter, path and arguments under the open wrapper: a flip, in both directions.
        const flipped: PlacedHook = { ...orig, hook: { ...orig.hook, command: openExec(s.interpreter, s.path, s.args) } }
        if (isRewrap(orig, flipped) || isRewrap(flipped, orig)) wrong.push(`fail-mode flip is a rewrap: ${name}`)
        // The planned gate shape: another timeout with its own deadline, closed on both sides.
        const t = Number(orig.hook.timeout) + 5
        const command = s.interpreter === 'python3' ? pythonGateCommand(s.path, s.args, t) : nodeGateCommand(s.interpreter, s.path, s.args, t)
        const longer: PlacedHook = { ...orig, hook: { ...orig.hook, command, timeout: t } }
        if (!isRewrap(orig, longer) || !isRewrap(longer, orig)) wrong.push(`gate timeout + deadline not a rewrap: ${name}`)
      }
    }
    expect(wrong).toEqual([])
    expect(counts.open).toBeGreaterThan(30)
    expect(counts.closed).toBeGreaterThan(5)
    // Main (the dry-run compares sub files only; the planned main pairs are checked on their spellings).
    const main = renderHooks(HOOK_MANIFEST, 'main')
    const mainPairs: string[] = []
    for (const [event, groups] of Object.entries(main)) {
      for (const h of groups!.flatMap((g) => g.hooks)) {
        if (h.type !== 'command') continue
        const s = classifySpelling(h.command, h.timeout, event, 'main')!
        const planned = s.kind === 'failOpenNodeProbe' ? openExec(s.interpreter, s.path, s.args)
          : s.kind === 'failClosedRun' && s.interpreter === 'python3' ? pythonGateCommand(s.path, s.args, h.timeout!) : null
        if (planned === null) continue
        const p = classifySpelling(planned, h.timeout, event, 'main')!
        mainPairs.push(`${s.kind} ${s.failMode} -> ${p.kind} ${p.failMode}`)
      }
    }
    expect([...new Set(mainPairs)].sort()).toEqual(['failClosedRun closed -> failClosedPythonProbe closed', 'failOpenNodeProbe open -> failOpenExec open'])
  })
})
