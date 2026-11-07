// C1 PR 8a: the dry-run CLI is read-only, provably (Kevin 12982, 12995). The
// main agent runs it against the LIVE install tree, so "it does not write" has
// to be shown, not assumed:
//
// 1. Import graph: cli.ts reaches only the allowed modules and node builtins
//    (no config.js, logger.js, atomic-write.js: they compute paths from the
//    code's location and write logs).
// 2. Static ban: no writing fs call, child process, worker, socket, DNS, HTTP
//    or fetch in any module of that graph.
// 3. Runtime, enforced by Node: the CLI, compiled with tsc into a scratch dir,
//    runs under `node --permission` with READ access only (no fs write, no
//    child process, no worker). Any write throws ERR_ACCESS_DENIED. Around it:
//    the install tree's manifest (sha256, size, mode, mtime of every entry) is
//    identical before and after, and the child's own TMPDIR and HOME stay empty.
// 4. Attempts, not only results: the permission model stops a write, but a
//    write attempt whose error the code swallows would leave nothing behind
//    here and still write on a run without --permission. So a preloaded guard
//    reports every writing fs call (and open with a writing flag) on stderr
//    before passing it on, and replaces every socket, DNS, HTTP and fetch entry
//    point (the permission model does not cover the network) with a thrower
//    that reports itself. The CLI's stderr must stay empty.
// 5. Positive controls through the SAME spawn helper: a script that writes
//    (also with the error swallowed), spawns, or calls the network is stopped
//    and reported. Without them, a helper that lost --permission or the guard
//    would make every check above pass vacuously.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeDryRunTree } from './fixtures/claude-md/dry-run-tree.js'
import { buildLiveContext, defaultManagedSettingsPath } from '../web/claude-md/live-context.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI_SRC = join(REPO, 'src', 'web', 'claude-md', 'cli.ts')

// ---- 1 + 2: static ---------------------------------------------------------

const ALLOWED_MODULES = [
  'src/env-parse.ts',
  'src/web/claude-md/agent-name.ts',
  'src/web/claude-md/cli.ts',
  'src/web/claude-md/compose.ts',
  'src/web/claude-md/context.ts',
  'src/web/claude-md/dry-run-cli.ts',
  'src/web/claude-md/dry-run.ts',
  'src/web/claude-md/hooks-from-settings.ts',
  'src/web/claude-md/legacy-markers.ts',
  'src/web/claude-md/line-diff.ts',
  'src/web/claude-md/live-context.ts',
  'src/web/claude-md/owner-zone.ts',
  'src/web/claude-md/registry.ts',
  'src/web/claude-md/render.ts',
  'src/web/claude-md/sections.ts',
]
// node:crypto: the sha256 of a removed generated block in the full diff (dry-run.ts)
const ALLOWED_BUILTINS = ['node:crypto', 'node:fs', 'node:os', 'node:path', 'node:url']
// sort() order; accessSync and existsSync are live-context.ts's hook-script and roster checks
const ALLOWED_FS = ['accessSync', 'constants', 'existsSync', 'lstatSync', 'readFileSync', 'readdirSync', 'realpathSync', 'statSync']
// the hash only (Ron 13154)
const ALLOWED_CRYPTO = ['createHash']

interface Graph { modules: string[]; builtins: string[]; fsNames: string[]; cryptoNames: string[]; dynamic: string[] }

function importGraph(entry: string): Graph {
  const seen = new Set<string>()
  const builtins = new Set<string>()
  const fsNames = new Set<string>()
  const cryptoNames = new Set<string>()
  const dynamic: string[] = []
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const src = readFileSync(file, 'utf-8')
    if (/\bimport\s*\(|\brequire\s*\(/.test(src)) dynamic.push(relative(REPO, file))
    for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*'([^']+)'/gm)) {
      const [, , typeOnly, what, spec] = m
      if (typeOnly) continue // erased at compile time
      if (spec.startsWith('.')) {
        visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')))
      } else {
        builtins.add(spec)
        const names = spec === 'node:fs' ? fsNames : spec === 'node:crypto' ? cryptoNames : null
        if (names) for (const n of what.replace(/[{}]/g, '').split(',')) if (n.trim()) names.add(n.trim())
      }
    }
    for (const m of src.matchAll(/^\s*import\s+'([^']+)'/gm)) dynamic.push(`${relative(REPO, file)}: side-effect import ${m[1]}`)
  }
  visit(entry)
  return { modules: [...seen].map((f) => relative(REPO, f)).sort(), builtins: [...builtins].sort(), fsNames: [...fsNames].sort(), cryptoNames: [...cryptoNames].sort(), dynamic }
}

// Free calls (not a method: `re.exec(x)` is a RegExp), member calls of the
// writing and spawning names, and the modules themselves.
const CALLS = 'writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|rm|rmSync|rmdir|'
  + 'rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|symlink|symlinkSync|link|linkSync|'
  + 'chmod|chmodSync|chown|chownSync|utimes|utimesSync|truncate|truncateSync|open|openSync|createWriteStream|'
  + 'atomicWriteFileSync|fetch|WebSocket|spawn|spawnSync|execSync|execFile|execFileSync|fork|Worker'
const BANNED = new RegExp(String.raw`(?<![\w$.])(?:${CALLS}|exec)\s*\(|\.(?:${CALLS})\s*\(|`
  + String.raw`node:(?:child_process|worker_threads|net|http|https|http2|dgram|dns|tls|fs\/promises)|`
  + String.raw`\bfrom\s+'(?:fs|child_process|net|http|https|dns|tls|dgram|worker_threads)'`, 'g')

describe('read-only: import graph and static ban', () => {
  const g = importGraph(CLI_SRC)

  it('cli.ts reaches only the allowed modules and builtins', () => {
    expect(g.modules).toEqual(ALLOWED_MODULES)
    expect(g.builtins).toEqual(ALLOWED_BUILTINS)
    expect(g.dynamic).toEqual([])
  })

  it('only reading fs functions are imported', () => {
    expect(g.fsNames).toEqual(ALLOWED_FS)
  })

  it('only createHash is imported from node:crypto', () => {
    expect(g.cryptoNames).toEqual(ALLOWED_CRYPTO)
  })

  it.each(ALLOWED_MODULES)('%s has no writing, spawning or network call', (rel) => {
    const code = readFileSync(join(REPO, rel), 'utf-8')
      .replace(/\/\/.*$/gm, '') // comments may name the banned calls
    expect([...code.matchAll(BANNED)].map((m) => m[0])).toEqual([])
  })
})

// ---- 3-5: runtime ----------------------------------------------------------

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
net.connect = hit('net.connect')
net.createConnection = hit('net.createConnection')
net.Socket.prototype.connect = hit('net.Socket.connect')
tls.connect = hit('tls.connect')
for (const k of Object.keys(dns)) if (typeof dns[k] === 'function' && /^(lookup|resolve|reverse)/.test(k)) dns[k] = hit('dns.' + k)
for (const k of Object.keys(dns.promises)) if (typeof dns.promises[k] === 'function' && /^(lookup|resolve|reverse)/.test(k)) dns.promises[k] = hit('dns.promises.' + k)
http.request = hit('http.request'); http.get = hit('http.get')
https.request = hit('https.request'); https.get = hit('https.get')
http2.connect = hit('http2.connect')
dgram.createSocket = hit('dgram.createSocket')
globalThis.fetch = hit('fetch')
if (globalThis.WebSocket) globalThis.WebSocket = hit('WebSocket')
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
  'control-write.mjs': "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.argv[2] + '/written-by-control', 'x')\n",
  'control-write-swallowed.mjs': "import { writeFileSync } from 'node:fs'\ntry { writeFileSync(process.argv[2] + '/written-by-control', 'x') } catch { /* swallowed */ }\n",
  'control-open-append.mjs': "import { openSync } from 'node:fs'\ntry { openSync(process.argv[2] + '/CLAUDE.md', 'a') } catch { /* swallowed */ }\n",
  'control-tmp.mjs': "import { writeFileSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nwriteFileSync(tmpdir() + '/written-by-control', 'x')\n",
  'control-child.mjs': "import { execFileSync } from 'node:child_process'\nexecFileSync('/bin/true')\n",
  'control-fetch.mjs': "await fetch('http://127.0.0.1:9/')\n",
  'control-dns.mjs': "import { lookup } from 'node:dns/promises'\nawait lookup('localhost')\n",
  'control-socket.mjs': "import net from 'node:net'\nnet.createConnection({ host: '127.0.0.1', port: 9 })\n",
}

let base: string
let out: string
let templates: string
let link: string
const STAMP = '0123456789abcdef0123456789abcdef01234567'
let root: string
let home: string
let childTmp: string
let childHome: string

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'claude-md-readonly-'))
  // The checkout layout: <base>/dist/web/claude-md/render.js finds its region
  // templates at <base>/templates/claude-md, three levels up (render.ts).
  out = join(base, 'dist')
  templates = join(base, 'templates')
  cpSync(join(REPO, 'templates', 'claude-md'), join(templates, 'claude-md'), { recursive: true })
  // tsc only (no bundler, no new or transitive dependency in the test path; Kevin 12995).
  const tsc = spawnSync(process.execPath, [
    join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '--outDir', out, '--rootDir', join(REPO, 'src'),
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--strict', '--skipLibCheck',
    '--types', 'node', CLI_SRC,
  ], { encoding: 'utf-8', cwd: REPO })
  if (tsc.status !== 0) throw new Error(`tsc failed: ${tsc.stdout}${tsc.stderr}`)
  writeFileSync(join(out, 'package.json'), '{"type":"module"}\n')
  // dist/.built-commit as the build writes it: the report header names it (Ron S3).
  writeFileSync(join(out, '.built-commit'), `${STAMP}\n`)
  // The same build behind a symlink (Ron B1: a main-module guard was false there).
  link = join(base, 'link')
  symlinkSync(out, link)
  writeFileSync(join(out, 'guard.mjs'), GUARD)
  for (const [name, code] of Object.entries(CONTROLS)) writeFileSync(join(out, name), code)
  root = join(base, 'install')
  mkdirSync(root)
  writeDryRunTree(root)
  // The main agent's user-scope settings layer: a home inside the readable
  // tree (outside it the read itself would be denied, and the run would fail).
  home = join(root, 'home')
  childTmp = join(base, 'child-tmp')
  childHome = join(base, 'child-home')
  mkdirSync(childTmp)
  mkdirSync(childHome)
}, 120_000)

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

// The one spawn helper for the CLI and the controls alike.
// `script` is relative to the build, or an absolute path (the symlinked start).
function sandboxed(script: string, args: string[], extraRead: string[] = []) {
  const r = spawnSync(process.execPath, [
    // the managed settings file: Claude Code's highest settings layer, read for the hooks (C1 PR 10b, Ron S1)
    '--permission', `--allow-fs-read=${out}`, `--allow-fs-read=${templates}`, `--allow-fs-read=${root}`, `--allow-fs-read=${defaultManagedSettingsPath()}`,
    ...extraRead.map((p) => `--allow-fs-read=${p}`),
    '--import', join(out, 'guard.mjs'), script.startsWith('/') ? script : join(out, script), ...args,
  ], {
    encoding: 'utf-8',
    cwd: childHome,
    env: { PATH: '/usr/bin:/bin', HOME: childHome, TMPDIR: childTmp, LANG: 'C.UTF-8' },
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function manifest(dir: string): Record<string, string> {
  const m: Record<string, string> = {}
  const walk = (p: string) => {
    const st = lstatSync(p)
    const key = relative(dir, p) || '.'
    if (st.isSymbolicLink()) {
      m[key] = `link ${readlinkSync(p)} ${st.mode} ${st.mtimeMs}`
    } else if (st.isDirectory()) {
      m[key] = `dir ${st.mode} ${st.mtimeMs}`
      for (const e of readdirSync(p).sort()) walk(join(p, e))
    } else {
      m[key] = `file ${st.size} ${st.mode} ${st.mtimeMs} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`
    }
  }
  walk(dir)
  return m
}

const CLI = join('web', 'claude-md', 'cli.js')

describe('read-only: runtime under node --permission (read access only)', () => {
  it('positive control: a write into the install tree is denied and nothing is written', () => {
    const r = sandboxed('control-write.mjs', [root])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('FS-WRITE-ATTEMPT writeFileSync')
    expect(r.stderr).toContain('ERR_ACCESS_DENIED')
    expect(existsSync(join(root, 'written-by-control'))).toBe(false)
  })

  it.each([
    ['control-write-swallowed.mjs', 'FS-WRITE-ATTEMPT writeFileSync'],
    ['control-open-append.mjs', 'FS-WRITE-ATTEMPT openSync a'],
  ])('positive control: %s, its error swallowed, is still reported as an attempt', (script, line) => {
    const before = manifest(root)
    const r = sandboxed(script, [root])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain(line)
    expect(manifest(root)).toEqual(before)
  })

  it('positive control: a write into TMPDIR is denied', () => {
    const r = sandboxed('control-tmp.mjs', [])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('ERR_ACCESS_DENIED')
    expect(readdirSync(childTmp)).toEqual([])
  })

  it('positive control: a child process is denied', () => {
    const r = sandboxed('control-child.mjs', [])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('ERR_ACCESS_DENIED')
  })

  it.each([
    ['control-fetch.mjs', 'NETWORK-ATTEMPT fetch'],
    ['control-dns.mjs', 'NETWORK-ATTEMPT dns.promises.lookup'],
    ['control-socket.mjs', 'NETWORK-ATTEMPT net.createConnection'],
  ])('positive control: %s is caught by the network guard', (script, line) => {
    const r = sandboxed(script, [])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain(line)
  })

  it.each([
    [['--all'], 1],
    [['--all', '--json'], 1],
    [['--all', '--excerpts'], 1],
    [['--agent', 'alpha'], 0],
  ])('the CLI %j runs to the end, writes nothing, calls no network', (extra, code) => {
    const before = manifest(root)
    const r = sandboxed(CLI, ['--dry-run', '--root', root, '--home', home, ...(extra as string[])])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(code)
    expect(r.stdout).toMatch(/\nsummary: \d+ agent\(s\)|"exit": \d/)
    expect(manifest(root)).toEqual(before)
    expect(readdirSync(childTmp)).toEqual([])
    expect(readdirSync(childHome)).toEqual([])
    expect(existsSync(join(root, 'store', 'claude-md-backup'))).toBe(false)
  })

  it('the sandboxed --json output is the full report (same agents as in-process)', () => {
    const r = sandboxed(CLI, ['--dry-run', '--root', root, '--home', home, '--all', '--json', '--full-diff'])
    const data = JSON.parse(r.stdout)
    expect(data.agents.map((a: { name: string; status: string }) => `${a.name}:${a.status}`))
      .toEqual(['chief:ok', 'alpha:ok', 'beta:refused', 'delta:refused', 'gamma:missing'])
    // PR 8b: the region and the diff were built inside the sandbox too
    for (const a of data.agents.slice(0, 2)) {
      expect(a.after.regionLength).toBeGreaterThan(1000)
      expect(a.diff).toContain('+<!-- END MARVEEN GENERATED v2 -->')
      expect(a.context.assumptions).toContain('profile.helperAllowed')
    }
  })

  // Ron 13122 J1, Kevin's own measurement: a hook script outside the --permission grant read as not wired, and the
  // region came out longer with nothing said. Now the sandboxed report names it; in-process the same hook is wired.
  it('J1: a hook script outside the grant is named "not readable" in the sandbox; in-process it is wired', () => {
    const script = join(base, 'outside-grant', 'scripts', 'hooks', 'shell-rescan-guard.py')
    mkdirSync(dirname(script), { recursive: true })
    writeFileSync(script, '# hook\n')
    const settings = join(root, 'agents', 'alpha', '.claude', 'settings.json')
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `python3 ${script}` }] }] } }))
    try {
      const r = sandboxed(CLI, ['--dry-run', '--root', root, '--home', home, '--agent', 'alpha', '--json'])
      expect(r.stderr).toBe('')
      const alpha = JSON.parse(r.stdout).agents[0]
      expect(alpha.context.hooksNotWired).toEqual([{ id: 'shellRescan', path: script, reason: 'not readable' }])
      expect(buildLiveContext(root, 'alpha', { homeDir: home }).hooksNotWired).toEqual([])
    } finally {
      rmSync(join(root, 'agents', 'alpha', '.claude'), { recursive: true, force: true })
    }
  })

  it('the header names the code version from dist/.built-commit (Ron S3)', () => {
    const r = sandboxed(CLI, ['--dry-run', '--root', root, '--home', home, '--agent', 'alpha'])
    expect(r.stdout.split('\n')[0]).toBe(`claude-md dry-run (read-only), root ${root}, main agent chief, code ${STAMP}`)
  })
})

// Ron B1 (13027): Node resolves the main module through a symlink to its real
// path while argv[1] stays as given, so a "main module" guard was false and the
// CLI printed nothing and exited 0. The entry module now has no guard.
describe('read-only: started through a symlinked path', () => {
  const viaLink = join('LINK', 'web', 'claude-md', 'cli.js')
  const linked = () => viaLink.replace('LINK', link)

  it('a bad argument exits 2 with the usage text (also without --permission)', () => {
    const r = sandboxed(linked(), ['--dry-run', '--bogus'], [link])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown argument: "--bogus"')
    const plain = spawnSync(process.execPath, [linked(), '--bogus'], { encoding: 'utf-8', env: { PATH: '/usr/bin:/bin' } })
    expect(plain.status).toBe(2)
    expect(plain.stderr).toContain('usage: cli.js --dry-run')
  })

  it('a real run prints the full report, under --permission with the link and the real path granted', () => {
    const before = manifest(root)
    const r = sandboxed(linked(), ['--dry-run', '--root', root, '--home', home, '--all', '--full-diff'], [link])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('\nsummary: 5 agent(s): 2 ok, 2 refused, 0 unreadable, 0 error, 1 missing; exit 1\n')
    // PR 8b: the region templates resolve from the real path (render.ts), inside the grant
    expect(r.stdout).toContain('\n+<!-- END MARVEEN GENERATED v2 -->\n')
    expect(manifest(root)).toEqual(before)
  })

  // Exit 1 like a refused file, but with an empty stdout: the cli.ts header
  // tells the caller to read an empty stdout as a failed run (Ron 13073).
  it('under --permission without a grant for the link path, Node refuses loudly (no silent empty run)', () => {
    const r = sandboxed(linked(), ['--dry-run', '--root', root, '--home', home, '--all'])
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('ERR_ACCESS_DENIED')
  })
})
