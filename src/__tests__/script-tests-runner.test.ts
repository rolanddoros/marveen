// Every scripts/__tests__ suite runs in CI, discovered, not enumerated.
//
// Measured 2026-09-05: scripts/__tests__ held 29 executable suites and only 4
// were reachable from the vitest run -- the other 25 had never been executed by
// anything but a human typing their path. Among the dead ones were the gate's
// own fail-closed exit-code contract (outgoing-copy-gate-failclosed), the shell
// portability suite written the night before, and the hook double-run audit.
// Two of the 25 were in fact FAILING: seed-skills asserted a template sentence
// that 827491c rewrote away, and stop-start-system-unit asserted the systemd
// branch on a machine that has no systemd. Nobody could know, because nothing
// ran them.
//
// Enumerating them here would rot the same way, so the list is discovered from
// disk: a new scripts/__tests__/*.test.sh is in CI the moment it is written.
// The suites with their own dedicated wrapper run twice; that is the cheap
// direction of the trade, because deleting a wrapper must not silently retire a
// suite.
//
// Except where the second run is not cheap: the email approval gate suite
// (EMAILKAPU901 PR2: the three level branches, one-shot + window approvals,
// the four-field anchor, every fail-closed branch) spawns the real hook once
// per case, and the spawn is the production entry point, so it stays. Its
// dedicated wrapper ran the identical command a second time, under a tighter
// budget, and in a full run the two copies ran concurrently in two workers,
// each loading the host for the other. That wrapper is gone; this runner is the
// suite's one CI entry, with the 300 s budget below.
//
// C2 B2-5 (Kevin 11596): the suites no longer run in this file. One file ran all of them serially on one
// worker (upstream CI run 42078141739: 192 cases, 509 s of a 788 s npm test). They run in the four
// script-tests-runner.shard-<k>.test.ts files now, with the discovery, the shard rule and the run body in
// setup/script-suites.ts. This file proves the split loses nothing: the shards together are exactly the
// suites on disk, each one in exactly one shard, and every shard file runs its own share.
import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ROOT, SCRIPT_TESTS_DIR, SHARD_COUNT, SUITE_TIMEOUT_MS, discoverScriptSuites, nameHash, runScriptSuite, shardOf, suitesForShard,
} from './setup/script-suites.js'
import { DIST_MARKERS, FINGERPRINT_FILES, STAMP, ensureDist, missingDistMarkers } from './setup/build-dist-once.js'
import { spawnSync } from 'node:child_process'

const SUITES = discoverScriptSuites()
const SRC_TESTS = join(ROOT, 'src', '__tests__')
const SHARD_FILE = /^script-tests-runner\.shard-(\d+)\.test\.ts$/
// The setup's stamp file name, assembled so that this file is not one of its readers in the stamp pin below.
const STAMP_NAME = ['.test', 'build-ok'].join('-')

// The one shape of a shard file. A change to the shard files is a change here first.
const shardSource = (k: number): string => `// Shard ${k} of the scripts/__tests__ suites (C2 B2-5). The discovery, the shard rule and the run body
// live in setup/script-suites.ts; script-tests-runner.test.ts proves the shards cover every suite once.
// it.for, not it.each: the case function needs the test context for ctx.skip().
import { describe, it } from 'vitest'
import { SUITE_TIMEOUT_MS, runScriptSuite, suitesForShard } from './setup/script-suites.js'

describe('scripts/__tests__ suites, shard ${k}', () => {
  it.for(suitesForShard(${k}))('%s', { timeout: SUITE_TIMEOUT_MS + 10_000 }, (name, ctx) => runScriptSuite(name, ctx))
})
`

describe('scripts/__tests__ suites', () => {
  it('finds the suites on disk (a rename must not silently empty this run)', () => {
    expect(SUITES.length).toBeGreaterThan(20)
  })

  // Read the directory here too, with this file's own pattern: the shard check below is built on
  // discoverScriptSuites(), so a narrowed discovery would shrink both sides of it at once.
  it('the discovery finds every *.test.sh, *.test.py and *-test.py in the directory, both kinds', () => {
    const onDisk = readdirSync(SCRIPT_TESTS_DIR).filter((f) => f.endsWith('.test.sh') || f.endsWith('.test.py') || f.endsWith('-test.py'))
    expect(SUITES).toEqual(onDisk.sort())
    expect(SUITES.filter((f) => f.endsWith('.sh')).length).toBeGreaterThan(20)
    expect(SUITES.filter((f) => f.endsWith('.py')).length).toBeGreaterThan(20)
  })

  it('the shards together are exactly the suites on disk, each suite in one shard, no shard empty', () => {
    const shards = Array.from({ length: SHARD_COUNT }, (_, i) => suitesForShard(i + 1))
    const all = shards.flat()
    expect([...all].sort()).toEqual(SUITES)
    expect(new Set(all).size).toBe(all.length)
    for (const [i, share] of shards.entries()) expect(share.length, `shard ${i + 1}`).toBeGreaterThan(0)
  })

  it('the shard rule is a stable hash of the name, in 1..SHARD_COUNT', () => {
    for (const name of SUITES) {
      const k = shardOf(name)
      expect(k).toBeGreaterThanOrEqual(1)
      expect(k).toBeLessThanOrEqual(SHARD_COUNT)
      expect(shardOf(name)).toBe(k)
    }
    // a changed hash would reshuffle every shard silently: pinned on the FNV-1a 32-bit test vectors
    expect(['', 'a', 'foobar'].map(nameHash)).toEqual([0x811c9dc5, 0xe40c292c, 0xbf9cf968])
    expect(['email-approval-gate.test.py', 'wait-for.test.sh', 'approval-wait.test.py'].map(shardOf)).toEqual([1, 2, 4])
  })

  it('one shard file per shard, and each runs its own share through the shared run body', () => {
    const files = readdirSync(SRC_TESTS).filter((f) => SHARD_FILE.test(f)).sort()
    expect(files.map((f) => Number(f.match(SHARD_FILE)![1])).sort((a, b) => a - b))
      .toEqual(Array.from({ length: SHARD_COUNT }, (_, i) => i + 1))
    // EXACT match with the template (C2 B2-5b, Ron 11985 a): a toContain check let a shard file that was switched
    // off as a whole (describe.skip, it.skip, a .todo) stay green, and CI would only show its cases as "skipped".
    for (const f of files) {
      const k = Number(f.match(SHARD_FILE)![1])
      expect(readFileSync(join(SRC_TESTS, f), 'utf-8'), f).toBe(shardSource(k))
    }
  })

  // The email gate suite must stay reachable from the shards (it has no other CI entry now) and must not
  // be re-run by a second wrapper.
  it('runs the email approval gate suite in one shard, and no other test file re-runs it', () => {
    expect(SUITES).toContain('email-approval-gate.test.py')
    const rerunners = readdirSync(SRC_TESTS)
      .filter((f) => f.endsWith('.ts') && f !== 'script-tests-runner.test.ts')
      .filter((f) => readFileSync(join(SRC_TESTS, f), 'utf-8').includes("'email-approval-gate.test.py'"))
    expect(rerunners).toEqual([])
  })
})

// The run body itself (C2 B2-5b, Ron 11985 b, c): measured, not read. Without the final status assertion a failing
// suite stayed green (only console.error spoke), and a changed SUITE_TIMEOUT_MS was invisible to every meta-test.
describe('runScriptSuite: a suite case is red unless the suite exits 0 (or skips with a reason)', () => {
  const withSuites = (suites: Record<string, string>, body: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'runsuite-'))
    try {
      for (const [name, text] of Object.entries(suites)) writeFileSync(join(dir, name), text)
      body(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('exit 0 passes, exit 1 throws, for a shell and a python suite', () => {
    withSuites({
      'ok.test.sh': 'exit 0\n', 'bad.test.sh': 'exit 1\n',
      'ok.test.py': 'import sys\nsys.exit(0)\n', 'bad.test.py': 'import sys\nsys.exit(1)\n',
    }, (dir) => {
      const ctx = { skip: vi.fn() }
      vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => runScriptSuite('ok.test.sh', ctx, dir, SUITE_TIMEOUT_MS, dir)).not.toThrow()
        expect(() => runScriptSuite('ok.test.py', ctx, dir, SUITE_TIMEOUT_MS, dir)).not.toThrow()
        expect(() => runScriptSuite('bad.test.sh', ctx, dir, SUITE_TIMEOUT_MS, dir)).toThrow()
        expect(() => runScriptSuite('bad.test.py', ctx, dir, SUITE_TIMEOUT_MS, dir)).toThrow()
        expect(ctx.skip).not.toHaveBeenCalled()
      } finally {
        vi.restoreAllMocks()
      }
    })
  })

  it('77 with the reason is a counted skip, 77 without it throws', () => {
    withSuites({
      'skip.test.sh': 'echo "SKIP (control unmet): nothing to measure here" >&2\nexit 77\n',
      'bare77.test.sh': 'exit 77\n',
    }, (dir) => {
      const ctx = { skip: vi.fn() }
      runScriptSuite('skip.test.sh', ctx, dir, SUITE_TIMEOUT_MS, dir)
      expect(ctx.skip).toHaveBeenCalledTimes(1)
      expect(() => runScriptSuite('bare77.test.sh', { skip: vi.fn() }, dir, SUITE_TIMEOUT_MS, dir)).toThrow()
    })
  })

  it('a suite that outlives the timeout is red (the timeout reaches the spawn)', () => {
    // exec: the shell becomes the sleep, so the timeout's SIGTERM ends it and no orphan is left behind
    withSuites({ 'slow.test.sh': 'exec sleep 5\n' }, (dir) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const t0 = Date.now()
        // the digest names the budget the suite ran with, not the shards' 300 s
        expect(() => runScriptSuite('slow.test.sh', { skip: vi.fn() }, dir, 500, dir)).toThrow(/slow\.test\.sh timed out after 0\.5 s/)
        // a timeout is red: its TMPDIR is kept as evidence, not removed with the green ones (Ron 12597, R1)
        expect(readdirSync(dir).filter((e) => e.startsWith('script-suite-slow.test.sh-'))).toHaveLength(1)
        expect(Date.now() - t0).toBeLessThan(4000)
      } finally {
        vi.restoreAllMocks()
      }
    })
  })

  it('the per-suite budget is 300 s, and it is the default the shards run with', () => {
    expect(SUITE_TIMEOUT_MS).toBe(300_000)
    // the default itself is a source pin: the shards pass no options, so only the source shows which budget they get
    const src = readFileSync(join(__dirname, 'setup', 'script-suites.ts'), 'utf-8')
    // (the signature gained tmpBase, C2 per-suite TMPDIR; its default is pinned by behaviour in the TMPDIR block below)
    expect(src).toContain('  timeoutMs: number = SUITE_TIMEOUT_MS,\n  tmpBase: string = tmpdir(),\n): void {')
    expect(src).toContain('timeout: timeoutMs,')
  })
})

// One dist/ build before the shards (C2 B2-5b, Ron 11985, Kevin 11997 A): setup/build-dist-once.ts.
describe('the one dist/ build before the suites', () => {
  it('is wired as the globalSetup, and the live-install gate is its first import', () => {
    const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf-8')
    expect(config).toContain("globalSetup: ['./src/__tests__/setup/build-dist-once.ts'],")
    const src = readFileSync(join(__dirname, 'setup', 'build-dist-once.ts'), 'utf-8')
    const firstImport = src.split('\n').find((l) => l.startsWith('import '))
    expect(firstImport).toBe("import './assert-not-live-install.js'")
  })

  it('builds only without a trusted dist/, and a failed build leaves nothing to trust (no throw, a loud warning)', () => {
    const root = mkdtempSync(join(tmpdir(), 'distonce-'))
    const writeMarkers = (r: string) => {
      for (const m of DIST_MARKERS) { mkdirSync(dirname(join(r, m)), { recursive: true }); writeFileSync(join(r, m), '') }
    }
    try {
      const warn = vi.fn()
      const build = vi.fn((r: string) => { writeMarkers(r); return { status: 0 } })
      expect(ensureDist(root, build, warn)).toBe('built')
      expect(build).toHaveBeenCalledTimes(1)
      expect(ensureDist(root, build, warn)).toBe('present')
      expect(build).toHaveBeenCalledTimes(1)
      expect(warn).not.toHaveBeenCalled()
      // a marker edited after the build (channels-custom-provider's stale-dist case, killed before its restore): the
      // stamp holds every marker's content hash, so the edited dist is not trusted (Ron 12358)
      writeFileSync(join(root, DIST_MARKERS[0]), 'export {} // edited')
      expect(ensureDist(root, build, warn)).toBe('built')
      expect(build).toHaveBeenCalledTimes(2)
      // a compiler upgrade changes the output without touching src: package-lock.json is in the fingerprint
      writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n')
      expect(ensureDist(root, build, warn)).toBe('built')
      expect(ensureDist(root, build, warn)).toBe('present')
      expect(build).toHaveBeenCalledTimes(3)
      rmSync(join(root, DIST_MARKERS[2]))
      expect(ensureDist(root, () => ({ status: 0 }), warn)).toBe('failed')   // exit 0, but a marker still missing
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('still missing: dist/pane-state.js'))
      // a failed build that emitted every marker anyway (tsc does): markers and stamp are deleted, the tail is shown
      expect(ensureDist(root, (r) => { writeMarkers(r); return { status: 2, stderr: 'TS2322: tsc error' } }, warn)).toBe('failed')
      expect(warn).toHaveBeenLastCalledWith(expect.stringMatching(/BUILD FAILED[\s\S]*exit 2[\s\S]*TS2322: tsc error/))
      expect(missingDistMarkers(root).sort()).toEqual([...DIST_MARKERS].sort())
      expect(existsSync(join(root, STAMP))).toBe(false)
      // the same source tree as the last good build: the next run builds again, it does not find 'present'
      expect(ensureDist(root, () => ({ status: 2 }), warn)).toBe('failed')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Stuart 12092 via Kevin 12095/12097, with the REAL compiler: tsc emits even when it reports a type error. After a
  // failed build the dist suite must be RED (its fallback build fails on the same error), never green, never a silent
  // skip; an unrelated test is not touched (ensureDist does not throw). CROSS-suite (Ron 12358): the first dist
  // suite's failed fallback build emits the markers AGAIN, so a second dist suite that trusted its marker would go
  // green on the same broken source; gated on the setup's stamp, it builds, fails and is red too, in any order.
  it('a failed build (type error, markers emitted anyway): every dist suite is red in this run and the next, a source change rebuilds', () => {
    const root = mkdtempSync(join(tmpdir(), 'distonce-tsc-'))
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
    const build = (r: string) => spawnSync(process.execPath, [tsc, '-p', join(r, 'tsconfig.json')], { encoding: 'utf-8' })
    const put = (rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }
    // two stand-ins for the dist suites, in the shape of their fallback (channels-auth-probe.test.sh): build unless the
    // setup's stamp AND the marker are there, FAIL when that build fails, then use the build
    const suiteDir = join(root, 'suites')
    for (const name of ['dist.test.sh', 'dist2.test.sh']) {
      put(`suites/${name}`, [
        `cd '${root}' || exit 1`,
        `if [ ! -f dist/${STAMP_NAME} ] || [ ! -f dist/pane-state.js ]; then`,
        `  "${process.execPath}" '${tsc}' -p tsconfig.json >&2 || { echo "FAIL: build failed" >&2; exit 1; }`,
        'fi',
        `"${process.execPath}" -e 'process.exit(require("./dist/pane-state.js").n === 3 ? 0 : 1)'`,
        '',
      ].join('\n'))
    }
    put('suites/unrelated.test.sh', 'exit 0\n')
    const unrelatedGreen = () => { runScriptSuite('unrelated.test.sh', { skip: vi.fn() }, suiteDir, SUITE_TIMEOUT_MS, root); return true }
    const distSuiteRed = (name = 'dist.test.sh') => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        return (() => { try { runScriptSuite(name, { skip: vi.fn() }, suiteDir, SUITE_TIMEOUT_MS, root); return false } catch { return true } })()
      } finally {
        vi.restoreAllMocks()
      }
    }
    try {
      put('tsconfig.json', JSON.stringify({
        compilerOptions: { outDir: 'dist', rootDir: 'src', module: 'commonjs', target: 'ES2020', strict: true, types: [] },
        include: ['src/**/*'],
      }))
      // a source for every marker (dist/<x>.js <- src/<x>.ts), so the markers stay the one list to keep in step
      for (const m of DIST_MARKERS) put(m.replace(/^dist/, 'src').replace(/\.js$/, '.ts'), 'export const a = 1\n')
      // the type error is elsewhere in the file: the emitted n is still 3, so a dist/ from this failed build LOOKS good
      // to the stand-in suite; only the deleted markers make it rebuild and fail
      put('src/pane-state.ts', "export const n: number = 3\nexport const bad: number = 'x'\n")
      const warn = vi.fn()
      // run 1: the build fails (tsc did emit the markers), the setup does not throw, the dist suite is red
      expect(ensureDist(root, build, warn)).toBe('failed')
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('TS2322'))
      expect(distSuiteRed()).toBe(true)
      // its failed fallback build put every marker back (the hazard is real) ...
      expect(missingDistMarkers(root)).toEqual([])
      // ... and the next dist suite, on the same broken source, is red as well, not green on those markers
      expect(distSuiteRed('dist2.test.sh')).toBe(true)
      expect(unrelatedGreen()).toBe(true)
      // run 2: still red, never 'present'
      expect(ensureDist(root, build, warn)).toBe('failed')
      expect(distSuiteRed('dist2.test.sh')).toBe(true)
      expect(distSuiteRed()).toBe(true)
      // fixed: built, the dist suite is green; then present; a source change builds again
      put('src/pane-state.ts', 'export const n: number = 3\n')
      expect(ensureDist(root, build, warn)).toBe('built')
      expect(warn).toHaveBeenCalledTimes(2)
      expect(distSuiteRed()).toBe(false)
      expect(distSuiteRed('dist2.test.sh')).toBe(false)
      expect(ensureDist(root, build, warn)).toBe('present')
      put('src/web/agent-process.ts', 'export const a = 2\n')   // a source change elsewhere
      expect(ensureDist(root, build, warn)).toBe('built')
      // a test file is not part of the fingerprint: editing one costs no build
      put('src/__tests__/x.test.ts', 'export const t = 1\n')
      expect(ensureDist(root, build, warn)).toBe('present')
      // a change to a file that steers the build is a source change
      put('tsconfig.build.json', '{ "extends": "./tsconfig.json" }\n')
      expect(ensureDist(root, build, warn)).toBe('built')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Kevin 12101, Ron 12358: all four dist suites have the same fallback (no setup stamp or no marker -> npm run build ->
  // non-zero = FAIL), and the markers are exactly their four files, so after a failed build all four are red.
  const DIST_SUITES: Array<{ suite: string; marker: string; checks: string[] }> = [
    { suite: 'channels-custom-provider.test.sh', marker: 'dist/web/agent-process.js',
      checks: [`if [ ! -f "$INSTALL_DIR/dist/${STAMP_NAME}" ] || [ ! -f "$INSTALL_DIR/dist/web/agent-process.js" ]; then`, 'if ! ( cd "$INSTALL_DIR" && npm run build ) >&2; then', 'echo "FAIL: npm run build failed" >&2\n    exit 1'] },
    { suite: 'channels-auth-probe.test.sh', marker: 'dist/web/reauth-detect.js',
      checks: [`if [ ! -f "$INSTALL_DIR/dist/${STAMP_NAME}" ] || [ ! -f "$INSTALL_DIR/dist/web/reauth-detect.js" ]; then`, 'if ! ( cd "$INSTALL_DIR" && npm run build ) >&2; then', 'echo "FAIL: npm run build failed" >&2\n    exit 1'] },
    { suite: 'channels-mcp-unlock.test.sh', marker: 'dist/pane-state.js',
      checks: ['PANE_STATE_JS="${CHANNELS_PANE_STATE_JS:-$INSTALL_DIR/dist/pane-state.js}"', `{ [ ! -f "$INSTALL_DIR/dist/${STAMP_NAME}" ] || [ ! -f "$PANE_STATE_JS" ]; }`, 'if ! ( cd "$INSTALL_DIR" && npm run build ) >&2; then', 'echo "FAIL: npm run build failed" >&2\n    exit 1'] },
    { suite: 'yt-ingest.test.py', marker: 'dist/prompt-safety.js',
      checks: ["os.path.join(ROOT, 'dist', 'prompt-safety.js')", `SETUP_STAMP = os.path.join(ROOT, 'dist', '${STAMP_NAME}')`, '(not os.path.isfile(SETUP_STAMP) or not os.path.isfile(SAFETY))', "if subprocess.run(['npm', 'run', 'build'], cwd=ROOT, stdout=sys.stderr).returncode != 0:", "print('FAIL: npm run build failed', file=sys.stderr)\n        sys.exit(1)"] },
  ]

  it('the four dist suites build on demand and FAIL on a failed build, and the markers are exactly their files', () => {
    for (const { suite, checks } of DIST_SUITES) {
      const src = readFileSync(join(SCRIPT_TESTS_DIR, suite), 'utf-8')
      for (const c of checks) expect(src, `${suite}: ${c}`).toContain(c)
    }
    expect([...DIST_MARKERS].sort()).toEqual(DIST_SUITES.map((d) => join(...d.marker.split('/'))).sort())
    // no other suite builds dist/ on demand (a fifth one would need a marker here)
    const builders = SUITES.filter((f) => /npm', 'run', 'build'\]|cd "\$INSTALL_DIR" && npm run build/.test(readFileSync(join(SCRIPT_TESTS_DIR, f), 'utf-8')))
    expect([...builders].sort()).toEqual(DIST_SUITES.map((d) => d.suite).sort())
  })

  // B2-2b moved the build onto tsconfig.build.json: a tsconfig the build reads but the fingerprint does not would let
  // a dist/ built under the old settings stay trusted.
  it('every tsconfig the build script names is part of the fingerprint', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { scripts: Record<string, string> }
    const named = [...pkg.scripts.build.matchAll(/\btsc\b(?:\s+-p\s+(\S+))?/g)].map((m) => m[1] ?? 'tsconfig.json')
    expect(named.length).toBeGreaterThan(0)
    for (const f of named) expect(FINGERPRINT_FILES, f).toContain(f)
  })

  // The fallback builds may run in parallel on the failure branch (Kevin 12101): harmless only because none of them can
  // make a dist/ trusted. The stamp is written in ONE place, ensureDist, after the failure branch has returned; the
  // four dist suites only test that it exists (Ron 12358).
  it('only the setup writes the stamp, and only after a successful build; the dist suites only read it', () => {
    const hits = spawnSync('git', ['grep', '--untracked', '-l', '-F', STAMP_NAME], { cwd: ROOT, encoding: 'utf-8' })
    expect(hits.stdout.trim().split('\n').sort())
      .toEqual(['src/__tests__/setup/build-dist-once.ts', ...DIST_SUITES.map((d) => `scripts/__tests__/${d.suite}`)].sort())
    const readOnly = (l: string) => l.trim().startsWith('#') || l.includes(`[ ! -f "$INSTALL_DIR/dist/${STAMP_NAME}" ]`)
      || l === `SETUP_STAMP = os.path.join(ROOT, 'dist', '${STAMP_NAME}')`
    for (const { suite } of DIST_SUITES) {
      const lines = readFileSync(join(SCRIPT_TESTS_DIR, suite), 'utf-8').split('\n')
      expect(lines.filter((l) => l.includes(STAMP_NAME) && !readOnly(l)), suite).toEqual([])
      expect(lines.filter((l) => l.includes('SETUP_STAMP') && !l.startsWith('SETUP_STAMP = ')
        && !l.includes('os.path.isfile(SETUP_STAMP)')), suite).toEqual([])
    }
    const src = readFileSync(join(__dirname, 'setup', 'build-dist-once.ts'), 'utf-8')
    const writes = [...src.matchAll(/writeFileSync\(join\(root, STAMP\)/g)].map((m) => m.index!)
    expect(writes.length).toBe(1)
    expect(writes[0]).toBeGreaterThan(src.indexOf("    return 'failed'\n  }"))
    expect(src.indexOf("    return 'failed'\n  }")).toBeGreaterThan(0)
  })
})

// Every suite runs with its OWN TMPDIR (C2, Kevin 12537/12538). Measured before: 32 suites left 1171 entries in the
// TMPDIR they were given, and a shared /tmp collected them. Green or a counted skip: that directory, and only that
// exact path, is removed. Red: it is kept as evidence, and the failure message names it. A neighbour directory in the
// same base stands for a foreign one (Tom's /tmp/bg-fake-tmux-*): the runner must never touch it.
describe('runScriptSuite: every suite gets its own TMPDIR, removed when green, kept as evidence when red', () => {
  const withBase = (body: (dir: string, base: string, neighbour: string) => void): void => {
    const root = mkdtempSync(join(tmpdir(), 'suite-tmpdir-'))
    try {
      const dir = join(root, 'suites')
      const base = join(root, 'tmp')
      mkdirSync(dir)
      mkdirSync(base)
      const neighbour = mkdtempSync(join(base, 'bg-fake-tmux-'))
      writeFileSync(join(neighbour, 'calls.log'), 'end kill-session\n')
      body(dir, base, neighbour)
      expect(readFileSync(join(neighbour, 'calls.log'), 'utf-8')).toBe('end kill-session\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  // a suite that records the temp variables it got, then leaves a directory and a file behind, the way the 32 did
  const leakSh = (dir: string, name: string, tail: string) => writeFileSync(join(dir, name), [
    `printf '%s\\n' "$TMPDIR" "$TMP" "$TEMP" > '${join(dir, `${name}.seen`)}'`,
    'mktemp -d >/dev/null', 'mktemp >/dev/null', tail, '',
  ].join('\n'))
  const seen = (dir: string, name: string) => readFileSync(join(dir, `${name}.seen`), 'utf-8').trim().split('\n')
  const ownDir = (base: string, name: string, s: string) => {
    expect(dirname(s)).toBe(base)
    expect(s.startsWith(join(base, `script-suite-${name}-`))).toBe(true)
  }

  it('green: the shell suite saw its own TMPDIR (and TMP, TEMP), and only the neighbour is left in the base', () => {
    withBase((dir, base, neighbour) => {
      leakSh(dir, 'leak.test.sh', 'exit 0')
      runScriptSuite('leak.test.sh', { skip: vi.fn() }, dir, SUITE_TIMEOUT_MS, base)
      const [t, tmp, temp] = seen(dir, 'leak.test.sh')
      ownDir(base, 'leak.test.sh', t)
      expect([tmp, temp]).toEqual([t, t])
      expect(existsSync(t)).toBe(false)
      expect(readdirSync(base)).toEqual([neighbour.split('/').pop()])
    })
  })

  it('green: a python suite (tempfile) is redirected and cleaned the same way', () => {
    withBase((dir, base, neighbour) => {
      writeFileSync(join(dir, 'leak.test.py'), [
        'import tempfile',
        `open(${JSON.stringify(join(dir, 'leak.test.py.seen'))}, 'w').write(tempfile.gettempdir() + '\\n')`,
        'tempfile.mkdtemp()', 'tempfile.mkstemp()', '',
      ].join('\n'))
      runScriptSuite('leak.test.py', { skip: vi.fn() }, dir, SUITE_TIMEOUT_MS, base)
      const [t] = seen(dir, 'leak.test.py')
      ownDir(base, 'leak.test.py', t)
      expect(existsSync(t)).toBe(false)
      expect(readdirSync(base)).toEqual([neighbour.split('/').pop()])
    })
  })

  it('the default base is the runner\'s own tmpdir() (what the shards use)', () => {
    withBase((dir, base, neighbour) => {
      leakSh(dir, 'default.test.sh', 'exit 0')
      vi.stubEnv('TMPDIR', base)
      try {
        runScriptSuite('default.test.sh', { skip: vi.fn() }, dir)
      } finally {
        vi.unstubAllEnvs()
      }
      ownDir(base, 'default.test.sh', seen(dir, 'default.test.sh')[0])
      expect(readdirSync(base)).toEqual([neighbour.split('/').pop()])
    })
  })

  it('a counted skip is clean too: its TMPDIR is removed even though ctx.skip() throws', () => {
    withBase((dir, base, neighbour) => {
      leakSh(dir, 'skip.test.sh', 'echo "SKIP (control unmet): nothing to measure here" >&2\nexit 77')
      // a real test context's skip() throws to end the case; the stand-in does the same
      const ctx = { skip: vi.fn(() => { throw new Error('skipped') }) }
      expect(() => runScriptSuite('skip.test.sh', ctx, dir, SUITE_TIMEOUT_MS, base)).toThrow('skipped')
      expect(ctx.skip).toHaveBeenCalledTimes(1)
      expect(existsSync(seen(dir, 'skip.test.sh')[0])).toBe(false)
      expect(readdirSync(base)).toEqual([neighbour.split('/').pop()])
    })
  })

  it('red (exit 1, a bare 77): the TMPDIR is KEPT with what the suite left, and the failure message names it', () => {
    withBase((dir, base) => {
      leakSh(dir, 'red.test.sh', 'exit 1')
      leakSh(dir, 'bare77.test.sh', 'exit 77')
      vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        for (const name of ['red.test.sh', 'bare77.test.sh']) {
          let message = ''
          try { runScriptSuite(name, { skip: vi.fn() }, dir, SUITE_TIMEOUT_MS, base) } catch (e) { message = (e as Error).message }
          const [t] = seen(dir, name)
          ownDir(base, name, t)
          expect(message).toContain(`TMPDIR kept as evidence: ${t}`)
          expect(readdirSync(t)).toHaveLength(2)
        }
        // a green suite after them removes ITS OWN dir only, never the kept red ones in the same base (Ron 12597, R3)
        leakSh(dir, 'green-after.test.sh', 'exit 0')
        runScriptSuite('green-after.test.sh', { skip: vi.fn() }, dir, SUITE_TIMEOUT_MS, base)
        expect(readdirSync(base).filter((e) => e.startsWith('script-suite-')).length).toBe(2)
      } finally {
        vi.restoreAllMocks()
      }
    })
  })
})
