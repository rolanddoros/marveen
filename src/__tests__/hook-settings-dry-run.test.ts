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
import { HOOK_MANIFEST } from '../web/hooks/manifest.js'
import { dryRun, formatDryRun, runHookSettingsCli } from '../web/hooks/dry-run.js'

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
    expect(text).toContain('\nsummary: 13 agent(s), 12/12 multiset EMPTY, 1 without settings, 0 error; exit 0\n')
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

  it('a changed matcher is a drift, never EMPTY (Ron N3)', () => {
    withSettings('sub-03', (s) => { groupOf(s, 'egress-gate.mjs').matcher = 'WebFetch|Read' }, () => {
      const r = dryRun({ root: install, nodeBin: NODE, agents: ['sub-03'] })
      expect(r.exit).toBe(1)
      expect(r.agents[0].dropped).toEqual(['PreToolUse [WebFetch|Read] egress-gate.mjs timeout=10'])
      expect(r.agents[0].added).toEqual(['PreToolUse [WebFetch] egress-gate.mjs timeout=10'])
    })
  })

  it('a changed timeout or any other hook field is a drift: the key is the whole hook object (Ron N3)', () => {
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
    expect(r.summary).toEqual({ agents: 13, compared: 12, empty: 12, drift: 0, noSettings: ['sub-13'], errors: [] })
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
      expect(r.agents[0].diff).toContain(`"command": "command #${createHash('sha256').update(secretHook).digest('hex').slice(0, 8)}"`)
      // The hooks key only: the env key is not in the diff, its context lines included.
      expect(r.agents[0].diff).not.toContain('"env"')
      expect(r.agents[0].diff).not.toContain('"permissions"')
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
})
