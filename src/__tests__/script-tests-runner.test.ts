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
        expect(() => runScriptSuite('ok.test.sh', ctx, dir)).not.toThrow()
        expect(() => runScriptSuite('ok.test.py', ctx, dir)).not.toThrow()
        expect(() => runScriptSuite('bad.test.sh', ctx, dir)).toThrow()
        expect(() => runScriptSuite('bad.test.py', ctx, dir)).toThrow()
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
      runScriptSuite('skip.test.sh', ctx, dir)
      expect(ctx.skip).toHaveBeenCalledTimes(1)
      expect(() => runScriptSuite('bare77.test.sh', { skip: vi.fn() }, dir)).toThrow()
    })
  })

  it('a suite that outlives the timeout is red (the timeout reaches the spawn)', () => {
    // exec: the shell becomes the sleep, so the timeout's SIGTERM ends it and no orphan is left behind
    withSuites({ 'slow.test.sh': 'exec sleep 5\n' }, (dir) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const t0 = Date.now()
        // the digest names the budget the suite ran with, not the shards' 300 s
        expect(() => runScriptSuite('slow.test.sh', { skip: vi.fn() }, dir, 500)).toThrow(/slow\.test\.sh timed out after 0\.5 s/)
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
    expect(src).toContain('  timeoutMs: number = SUITE_TIMEOUT_MS,\n): void {')
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
  // skip; an unrelated test is not touched (ensureDist does not throw).
  it('a failed build (type error, markers emitted anyway): the dist suite is red in this run and the next, a source change rebuilds', () => {
    const root = mkdtempSync(join(tmpdir(), 'distonce-tsc-'))
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
    const build = (r: string) => spawnSync(process.execPath, [tsc, '-p', join(r, 'tsconfig.json')], { encoding: 'utf-8' })
    const put = (rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }
    // a stand-in for the dist suites, in the shape of their fallback (channels-auth-probe.test.sh): build when the
    // marker is missing, FAIL when that build fails, then use the build
    const suiteDir = join(root, 'suites')
    put('suites/dist.test.sh', [
      `cd '${root}' || exit 1`,
      'if [ ! -f dist/pane-state.js ]; then',
      `  "${process.execPath}" '${tsc}' -p tsconfig.json >&2 || { echo "FAIL: build failed" >&2; exit 1; }`,
      'fi',
      `"${process.execPath}" -e 'process.exit(require("./dist/pane-state.js").n === 3 ? 0 : 1)'`,
      '',
    ].join('\n'))
    put('suites/unrelated.test.sh', 'exit 0\n')
    const unrelatedGreen = () => { runScriptSuite('unrelated.test.sh', { skip: vi.fn() }, suiteDir); return true }
    const distSuiteRed = () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        return (() => { try { runScriptSuite('dist.test.sh', { skip: vi.fn() }, suiteDir); return false } catch { return true } })()
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
      expect(unrelatedGreen()).toBe(true)
      // run 2: still red, never 'present'
      expect(ensureDist(root, build, warn)).toBe('failed')
      expect(distSuiteRed()).toBe(true)
      // fixed: built, the dist suite is green; then present; a source change builds again
      put('src/pane-state.ts', 'export const n: number = 3\n')
      expect(ensureDist(root, build, warn)).toBe('built')
      expect(warn).toHaveBeenCalledTimes(2)
      expect(distSuiteRed()).toBe(false)
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

  // Kevin 12101: all four dist suites have the same fallback (missing marker -> npm run build -> non-zero = FAIL), and
  // the markers are exactly their four files, so after a failed build (markers deleted) all four are red.
  const DIST_SUITES: Array<{ suite: string; marker: string; checks: string[] }> = [
    { suite: 'channels-custom-provider.test.sh', marker: 'dist/web/agent-process.js',
      checks: ['if [ ! -f "$INSTALL_DIR/dist/web/agent-process.js" ]; then', 'if ! ( cd "$INSTALL_DIR" && npm run build ) >&2; then', 'echo "FAIL: npm run build failed" >&2\n    exit 1'] },
    { suite: 'channels-auth-probe.test.sh', marker: 'dist/web/reauth-detect.js',
      checks: ['if [ ! -f "$INSTALL_DIR/dist/web/reauth-detect.js" ]; then', 'if ! ( cd "$INSTALL_DIR" && npm run build ) >&2; then', 'echo "FAIL: npm run build failed" >&2\n    exit 1'] },
    { suite: 'channels-mcp-unlock.test.sh', marker: 'dist/pane-state.js',
      checks: ['PANE_STATE_JS="${CHANNELS_PANE_STATE_JS:-$INSTALL_DIR/dist/pane-state.js}"', '[ ! -f "$PANE_STATE_JS" ]', 'if ! ( cd "$INSTALL_DIR" && npm run build ) >&2; then', 'echo "FAIL: npm run build failed" >&2\n    exit 1'] },
    { suite: 'yt-ingest.test.py', marker: 'dist/prompt-safety.js',
      checks: ["os.path.join(ROOT, 'dist', 'prompt-safety.js')", "if subprocess.run(['npm', 'run', 'build'], cwd=ROOT, stdout=sys.stderr).returncode != 0:", "print('FAIL: npm run build failed', file=sys.stderr)\n        sys.exit(1)"] },
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
  // make a dist/ trusted. The stamp is written in ONE place, ensureDist, after the failure branch has returned.
  it('only the setup writes the stamp, and only after a successful build', () => {
    const hits = spawnSync('git', ['grep', '--untracked', '-l', '-F', ['.test', 'build-ok'].join('-')], { cwd: ROOT, encoding: 'utf-8' })
    expect(hits.stdout.trim().split('\n').sort()).toEqual(['src/__tests__/setup/build-dist-once.ts'])
    const src = readFileSync(join(__dirname, 'setup', 'build-dist-once.ts'), 'utf-8')
    const writes = [...src.matchAll(/writeFileSync\(join\(root, STAMP\)/g)].map((m) => m.index!)
    expect(writes.length).toBe(1)
    expect(writes[0]).toBeGreaterThan(src.indexOf("    return 'failed'\n  }"))
    expect(src.indexOf("    return 'failed'\n  }")).toBeGreaterThan(0)
  })
})
