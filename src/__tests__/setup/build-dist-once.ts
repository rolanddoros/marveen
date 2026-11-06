// ONE dist/ build before any test runs (C2 B2-5b, Ron 11985, Kevin 11997 A). A vitest globalSetup: it runs once, in
// the main process, before the workers start.
//
// Why: two scripts/__tests__ suites build dist/ themselves when it is missing (channels-custom-provider and
// channels-auth-probe, `npm run build`), and CI never builds before `npm test`. Since the suites run in four shards
// (B2-5), the two can start their builds at the same time in the same tree, and a third suite can read a half-written
// dist/. Two more suites silently measure less without dist/: channels-mcp-unlock skips its probe cases ("SKIP",
// green), yt-ingest.test.py skips its prompt-safety cases (unittest.skipUnless). Whether they ran depended on the
// order of the suites. Building once here, before anything starts, removes the race and the order dependence. The two
// suites keep their own build as the fallback for a suite run alone.
//
// TRUST: a marker file alone proves nothing (Stuart 12092 via Kevin 12095). tsc emits even when it reports a type
// error, so a FAILED build leaves the markers behind, and a "build only when missing" rule would then skip the build
// and let the dist suites go green on code that does not compile. So the markers count only next to this setup's own
// stamp, dist/.test-build-ok, which holds the fingerprint of the source tree and is written only after a build that
// exited 0 with every marker present. The stamp is removed before every build; a stamp that is missing, or that names
// another source tree, means a rebuild.
//
// A FAILED build does not stop the run (Kevin 12097, the narrower option): reviewers and targeted runs mutate src all
// the time, and a work-in-progress type error must not turn every unrelated file red. Instead the setup deletes the
// stamp AND the markers, so nothing from the failed build is trusted: the dist suites then try their own fallback
// build, fail on the same type error and go RED (never a silent skip), and the next run builds again. It warns loudly,
// with the tail of the compiler output. The type error is also caught by `npm run typecheck` (CI test.yml).

// FIRST the live-install gate, by importing it (its checks run at import and throw): a globalSetup runs BEFORE the
// workers' setupFiles, so without this a run inside a live install would rebuild the dist/ the running fleet uses
// before the gate in setupFiles could refuse.
import './assert-not-live-install.js'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// The dist files the four dist suites check before their fallback build (kept in step with them by
// script-tests-runner.test.ts): channels-custom-provider, channels-auth-probe, channels-mcp-unlock, yt-ingest.
export const DIST_MARKERS = [
  join('dist', 'web', 'agent-process.js'),
  join('dist', 'web', 'reauth-detect.js'),
  join('dist', 'pane-state.js'),
  join('dist', 'prompt-safety.js'),
]

export const BUILD_TIMEOUT_MS = 600_000
export const STAMP = join('dist', '.test-build-ok')

export function missingDistMarkers(root: string = ROOT): string[] {
  return DIST_MARKERS.filter((m) => !existsSync(join(root, m)))
}

// What `npm run build` compiles the dist suites' code from: every file under src/ (tsconfig include src/**/*,
// resolveJsonModule) EXCEPT src/__tests__, and the two files that steer it. Path and content, in a fixed order, so
// the same tree gives the same answer everywhere. src/__tests__ is left out on purpose: the dist suites never load
// dist/__tests__, and tests and mutants are edited all the time; with them in, every test edit would cost a full build.
export const FINGERPRINT_SKIP = join('src', '__tests__')

export function sourceFingerprint(root: string): string {
  const h = createHash('sha256')
  const add = (abs: string) => {
    h.update(relative(root, abs)).update('\0').update(readFileSync(abs)).update('\0')
  }
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) { if (relative(root, abs) !== FINGERPRINT_SKIP) walk(abs) }
      else if (e.isFile()) add(abs)
    }
  }
  if (existsSync(join(root, 'src'))) walk(join(root, 'src'))
  for (const f of ['tsconfig.json', 'package.json']) if (existsSync(join(root, f))) add(join(root, f))
  return h.digest('hex')
}

function stampMatches(root: string, fingerprint: string): boolean {
  try {
    return readFileSync(join(root, STAMP), 'utf-8').trim() === fingerprint
  } catch {
    return false
  }
}

export interface BuildResult {
  status: number | null
  stdout?: string
  stderr?: string
  error?: Error
}

export function npmRunBuild(root: string): BuildResult {
  return spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf-8', timeout: BUILD_TIMEOUT_MS })
}

// 'present': every marker is there AND the stamp names this source tree; nothing is built. Otherwise one build:
// 'built' (stamp written) or 'failed' (stamp and markers deleted, warned). root, build and warn are parameters so
// script-tests-runner.test.ts can measure the rule on a throwaway tree with the real compiler.
export function ensureDist(
  root: string,
  build: (root: string) => BuildResult,
  warn: (text: string) => void = (t) => console.warn(t),
): 'present' | 'built' | 'failed' {
  const fingerprint = sourceFingerprint(root)
  const missing = missingDistMarkers(root)
  if (missing.length === 0 && stampMatches(root, fingerprint)) return 'present'
  rmSync(join(root, STAMP), { force: true })
  const res = build(root)
  const still = missingDistMarkers(root)
  if (res.status !== 0 || still.length > 0) {
    for (const m of DIST_MARKERS) rmSync(join(root, m), { force: true })
    const tail = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim().split('\n').slice(-30).join('\n')
    warn(
      `\n!!! build-dist-once: THE dist/ BUILD FAILED (${missing.length ? `missing: ${missing.join(', ')}` : 'stamp missing or stale'}; ` +
        `exit ${res.status}${res.error ? `, ${res.error.message}` : ''}; still missing: ${still.join(', ') || 'none'}).\n` +
        `!!! Its markers and stamp are deleted: the dist suites will build again and go RED until the source compiles.\n${tail}\n`,
    )
    return 'failed'
  }
  writeFileSync(join(root, STAMP), `${fingerprint}\n`)
  return 'built'
}

export default function setup(): void {
  ensureDist(ROOT, npmRunBuild)
}
