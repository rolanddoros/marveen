// scripts/deploy/deploy-describe.mjs: what a fork deploy changes, from git only (fork deploy-gate plan v3 point 3,
// addendum A1-3, Ron 17165 C4). Pinned: the gate/deploy path patterns (and that each one names a real path, so a
// typo cannot silently cover nothing), the package diff and its order, the package.json `scripts` rule, the full
// render and its hash recomputed from git, the never-cut gate line, and the owner text under the cap.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// @ts-expect-error -- plain .mjs script, no types
import { loadGatePaths, matchesPattern, scriptsChanged, packageChanges, packageRows, collect, fullRender, sha256, contentHash, gateLine, ownerDescription, HEADER, LOG_LINE_PREFIX, LOG_PATH_RE } from '../../scripts/deploy/deploy-describe.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import { DESCRIPTION_CAP } from '../../scripts/hooks/owner-approval.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LOG = 'store/deploy-logs/request-20261117T160000Z.log'
const OPTS = { repo: 'https://github.com/rolanddoros/marveen.git', branch: 'main', logPath: LOG }

type Collected = { from: string; to: string; commits: string[]; packages: { added: unknown[]; changed: unknown[]; removed: unknown[] }; gatePaths: string[]; npmCi: boolean }

function gitIn(cwd: string) {
  return (args: string[]): string => {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' },
    })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
  }
}

function lock(pkgs: Record<string, string>): string {
  const packages: Record<string, unknown> = { '': { name: 'marveen', version: '1.0.0' } }
  for (const [k, v] of Object.entries(pkgs)) packages[k] = { version: v }
  return JSON.stringify({ name: 'marveen', lockfileVersion: 3, packages }, null, 2)
}

describe('gate/deploy path patterns', () => {
  it('dir/** is everything under dir, * stays inside one segment, the rest is exact', () => {
    expect(matchesPattern('scripts/hooks/a.mjs', 'scripts/hooks/**')).toBe(true)
    expect(matchesPattern('scripts/hooks/x/y.py', 'scripts/hooks/**')).toBe(true)
    expect(matchesPattern('scripts/hooks-old/a.mjs', 'scripts/hooks/**')).toBe(false)
    expect(matchesPattern('scripts/hooks', 'scripts/hooks/**')).toBe(false)
    expect(matchesPattern('tsconfig.build.json', 'tsconfig*.json')).toBe(true)
    expect(matchesPattern('a/tsconfig.json', 'tsconfig*.json')).toBe(false)
    expect(matchesPattern('tsconfig.x/y.json', 'tsconfig*.json')).toBe(false)
    expect(matchesPattern('scripts/stop.sh', 'scripts/stop.sh')).toBe(true)
    expect(matchesPattern('scripts/stop.sh.bak', 'scripts/stop.sh')).toBe(false)
    expect(matchesPattern('scripts/stopXsh', 'scripts/stop.sh')).toBe(false)
  })

  it('every pattern in gate-paths.json names at least one tracked path of this repo (a typo would cover nothing)', () => {
    // Tracked plus untracked-but-not-ignored, so the check also holds before this PR's own files are committed.
    const files = gitIn(REPO)(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean)
    const { patterns, packageJsonScripts } = loadGatePaths()
    expect(packageJsonScripts).toBe(true)
    for (const p of patterns) expect({ p, hits: files.some((f) => matchesPattern(f, p)) }).toEqual({ p, hits: true })
  })

  it('carries the addendum A1-3 list and Ron\'s suggested paths; never package-lock.json', () => {
    const { patterns } = loadGatePaths()
    for (const p of ['scripts/hooks/**', 'scripts/deploy/**', 'scripts/channels.sh', 'scripts/channel-watchdog.sh', 'scripts/stuck-modal-guard.sh', 'scripts/write-main-config-root.sh', '.github/**', 'src/web/routes/approvals.ts', 'src/web/routes/auth.ts', 'src/web/hooks/**', 'src/web/agent-scaffold.ts', 'src/web/agent-process.ts', 'src/web/agent-tokens.ts', 'src/web/approval-slack-route.ts', 'scripts/stop.sh', 'scripts/clean-dist-tests.cjs', 'scripts/write-built-commit.cjs', 'tsconfig*.json', 'src/web/routes/gromzo.ts', 'src/web/routes/updates.ts']) {
      expect(patterns).toContain(p)
    }
    expect(patterns.some((p: string) => matchesPattern('package-lock.json', p))).toBe(false)
    expect(patterns.some((p: string) => matchesPattern('package.json', p))).toBe(false)
  })

  it('a malformed list is an error, not an empty list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-paths-'))
    try {
      for (const bad of ['{}', '{"patterns":"x"}', '{"patterns":[""]}', '{"patterns":[1]}']) {
        writeFileSync(join(dir, 'g.json'), bad)
        expect(() => loadGatePaths(join(dir, 'g.json')), bad).toThrow(/patterns/)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('package.json scripts and the lockfile', () => {
  it('scripts: reordered keys are no change, a value or a new key is; a missing file or key counts as {}', () => {
    expect(scriptsChanged('{"scripts":{"a":"1","b":"2"}}', '{"scripts":{"b":"2","a":"1"}}')).toBe(false)
    expect(scriptsChanged('{"scripts":{"a":"1"}}', '{"scripts":{"a":"2"}}')).toBe(true)
    expect(scriptsChanged('{"scripts":{"a":"1"}}', '{"scripts":{"a":"1","b":"x"}}')).toBe(true)
    expect(scriptsChanged('{"version":"1"}', '{"version":"2"}')).toBe(false)
    expect(scriptsChanged(null, '{"scripts":{}}')).toBe(false)
    expect(scriptsChanged(null, '{"scripts":{"a":"1"}}')).toBe(true)
    expect(() => scriptsChanged('{', '{}')).toThrow(/package.json at FROM/)
  })

  it('packages: added, changed, removed by name; the root entry is no package; nested copies stay distinct', () => {
    const from = lock({ 'node_modules/a': '1.0.0', 'node_modules/b': '1.0.0', 'node_modules/x/node_modules/b': '0.9.0', 'node_modules/gone': '2.0.0' })
    const to = lock({ 'node_modules/a': '1.0.0', 'node_modules/b': '1.1.0', 'node_modules/x/node_modules/b': '0.9.0', 'node_modules/@s/new': '3.0.0', 'node_modules/c': '1.0.0' })
    const ch = packageChanges(from, to)
    expect(ch).toEqual({
      added: [{ name: '@s/new', version: '3.0.0' }, { name: 'c', version: '1.0.0' }],
      changed: [{ name: 'b', from: '1.0.0', to: '1.1.0' }],
      removed: [{ name: 'gone', version: '2.0.0' }],
    })
    expect(packageRows(ch)).toEqual(['+ @s/new 3.0.0', '+ c 1.0.0', '~ b 1.0.0 -> 1.1.0', '- gone 2.0.0'])
  })

  it('a missing lockfile on one side: everything added (or removed)', () => {
    expect(packageChanges(null, lock({ 'node_modules/a': '1.0.0' })).added).toEqual([{ name: 'a', version: '1.0.0' }])
    expect(packageChanges(lock({ 'node_modules/a': '1.0.0' }), null).removed).toEqual([{ name: 'a', version: '1.0.0' }])
  })

  // Ron's code review SEC-1: npm ci fetches what `resolved`/`integrity` name, so a move at the same version is a change.
  it('same version, moved resolved or integrity: a "~" row naming the moved fields; an unchanged entry is no row', () => {
    const entry = (resolved: string | undefined, integrity: string | undefined) => ({ version: '1.0.0', resolved, integrity })
    const rawLock = (pkgs: Record<string, unknown>) => JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'marveen' }, ...pkgs } })
    const R = 'https://registry.npmjs.org/p/-/p-1.0.0.tgz'
    const from = rawLock({
      'node_modules/same': entry(R, 'sha512-A'),
      'node_modules/res': entry(R, 'sha512-A'),
      'node_modules/int': entry(R, 'sha512-A'),
      'node_modules/both': entry(R, 'sha512-A'),
      'node_modules/gained': entry(undefined, undefined),
      'node_modules/bumped': entry(R, 'sha512-A'),
    })
    const to = rawLock({
      'node_modules/same': entry(R, 'sha512-A'),
      'node_modules/res': entry('https://evil.example/p-1.0.0.tgz', 'sha512-A'),
      'node_modules/int': entry(R, 'sha512-B'),
      'node_modules/both': entry('https://evil.example/p-1.0.0.tgz', 'sha512-B'),
      'node_modules/gained': entry(R, undefined),
      'node_modules/bumped': { version: '1.0.1', resolved: 'https://evil.example/p-1.0.1.tgz', integrity: 'sha512-C' },
    })
    const ch = packageChanges(from, to)
    expect(ch.added).toEqual([])
    expect(ch.removed).toEqual([])
    expect(ch.changed).toEqual([
      { name: 'both', from: '1.0.0', to: '1.0.0', source: ['resolved', 'integrity'] },
      { name: 'bumped', from: '1.0.0', to: '1.0.1' },
      { name: 'gained', from: '1.0.0', to: '1.0.0', source: ['resolved'] },
      { name: 'int', from: '1.0.0', to: '1.0.0', source: ['integrity'] },
      { name: 'res', from: '1.0.0', to: '1.0.0', source: ['resolved'] },
    ])
    expect(packageRows(ch)).toEqual([
      '~ both 1.0.0 (azonos verzió, más resolved és integrity)',
      '~ bumped 1.0.0 -> 1.0.1',
      '~ gained 1.0.0 (azonos verzió, más resolved)',
      '~ int 1.0.0 (azonos verzió, más integrity)',
      '~ res 1.0.0 (azonos verzió, más resolved)',
    ])
    expect(packageChanges(from, from)).toEqual({ added: [], changed: [], removed: [] })
  })
})

describe('collect + renders on a real repository', () => {
  let dir: string
  let git: (a: string[]) => string
  let from: string
  let mid: string
  let to: string

  function commit(files: Record<string, string>, msg: string): string {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true })
      writeFileSync(join(dir, p), c)
    }
    git(['add', '-A'])
    git(['commit', '-q', '-m', msg])
    return git(['rev-parse', 'HEAD']).trim()
  }

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-describe-')))
    git = gitIn(dir)
    git(['init', '-q', '-b', 'main'])
    from = commit({ 'package.json': '{"version":"1","scripts":{"build":"tsc"}}', 'package-lock.json': lock({ 'node_modules/a': '1.0.0' }), 'src/x.ts': '1' }, 'base')
    mid = commit({ 'package.json': '{"version":"2","scripts":{"build":"tsc"}}', 'src/x.ts': '2' }, 'feat: version only, no scripts change')
    to = commit({ 'scripts/hooks/new-gate.mjs': 'x', 'scripts/deploy/fork-deploy.mjs': 'y', 'tsconfig.build.json': '{}', 'package-lock.json': lock({ 'node_modules/a': '1.1.0' }), 'docs/a.md': 'd' }, 'feat: ' + 'a long subject '.repeat(12))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('a package.json change without `scripts` is not a gate path; the lockfile drives npm ci', () => {
    const c = collect(git, from, mid) as Collected
    expect(c.gatePaths).toEqual([])
    expect(c.npmCi).toBe(false)
    expect(c.commits).toEqual([`${mid.slice(0, 7)} feat: version only, no scripts change`])
  })

  it('gate paths sorted, docs left out, npm ci yes, commits newest first, the full subject kept', () => {
    const c = collect(git, from, to) as Collected
    expect(c.gatePaths).toEqual(['scripts/deploy/fork-deploy.mjs', 'scripts/hooks/new-gate.mjs', 'tsconfig.build.json'])
    expect(c.npmCi).toBe(true)
    expect(c.packages.changed).toEqual([{ name: 'a', from: '1.0.0', to: '1.1.0' }])
    expect(c.commits).toHaveLength(2)
    expect(c.commits[0]).toBe(`${to.slice(0, 7)} feat: ${'a long subject '.repeat(12).trim()}`)
    const full = fullRender(c)
    expect(full).toContain(c.commits[0])
    expect(full.split('\n').slice(0, 5)).toEqual([`${HEADER} lists`, `FROM ${from}`, `TO ${to}`, 'npm ci: igen', 'commits 2'])
  })

  it('a scripts change in package.json is a gate path', () => {
    const t2 = commit({ 'package.json': '{"version":"2","scripts":{"build":"tsc && evil"}}' }, 'chore: build step')
    expect((collect(git, to, t2) as Collected).gatePaths).toEqual(['package.json (scripts)'])
  })

  it('C4: the lists hash is recomputable from git, and one changed commit in the range changes it (and the owner text)', () => {
    const a = collect(git, from, to)
    const b = collect(git, from, to)
    expect(fullRender(a)).toBe(fullRender(b))
    expect(ownerDescription(a, OPTS)).toBe(ownerDescription(b, OPTS))
    expect(ownerDescription(a, OPTS)).toContain(`listák sha256 ${sha256(fullRender(a))}`)
    // The same tip content, one commit message different: a different range.
    git(['checkout', '-q', '-b', 'other', mid])
    const alt = commit({ 'scripts/hooks/new-gate.mjs': 'x', 'scripts/deploy/fork-deploy.mjs': 'y', 'tsconfig.build.json': '{}', 'package-lock.json': lock({ 'node_modules/a': '1.1.0' }), 'docs/a.md': 'd' }, 'feat: another subject')
    git(['checkout', '-q', 'main'])
    const c = collect(git, from, alt)
    expect(sha256(fullRender(c))).not.toBe(sha256(fullRender(a)))
    expect(ownerDescription(c, OPTS)).not.toBe(ownerDescription(a, OPTS))
  })
})

describe('the owner text', () => {
  function worst(nCommits = 200, nPkg = 300, nGate = 25): Collected {
    const pk = Array.from({ length: nPkg }, (_, i) => `@a-very-long-scope-name/package-number-${String(i).padStart(4, '0')}-with-suffix`)
    return {
      from: 'a'.repeat(40),
      to: 'b'.repeat(40),
      commits: Array.from({ length: nCommits }, (_, i) => `${String(i).padStart(7, '0')} ${'feat(scope): a long subject '.repeat(6)}`),
      packages: {
        added: pk.slice(0, 100).map((name) => ({ name, version: '1.0.0' })),
        changed: pk.slice(100, 200).map((name) => ({ name, from: '1.0.0', to: '2.0.0' })),
        removed: pk.slice(200).map((name) => ({ name, version: '1.0.0' })),
      },
      gatePaths: Array.from({ length: nGate }, (_, i) => `scripts/hooks/gate-${String(i).padStart(2, '0')}.mjs`),
      npmCi: true,
    }
  }

  it('worst case: at most 3000 characters; FROM, TO, both hashes, both full counts and the log line are in', () => {
    const c = worst()
    const text = ownerDescription(c, OPTS)
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_CAP)
    for (const l of [HEADER, `FROM ${c.from}`, `TO ${c.to}`, `content_hash ${contentHash({ ...OPTS, from: c.from, to: c.to })}`, `listák sha256 ${sha256(fullRender(c))}`, 'npm ci: igen', 'Commitok: 200, csomagváltozás: 300', `${LOG_LINE_PREFIX}${LOG}`]) {
      expect(text.split('\n')).toContain(l)
    }
  })

  it('A1-3 order: added, changed, removed; a cut keeps a PREFIX of that order, so removed rows go first', () => {
    const small = worst(1, 0, 0)
    small.packages = {
      added: [{ name: 'n1', version: '1' }, { name: 'n2', version: '1' }],
      changed: [{ name: 'c1', from: '1', to: '2' }],
      removed: [{ name: 'r1', version: '1' }],
    }
    const smallRows = ownerDescription(small, OPTS).split('\n\n').find((b: string) => b.startsWith('Csomagok:'))!.split('\n').slice(1)
    expect(smallRows).toEqual(['+ n1 1', '+ n2 1', '~ c1 1 -> 2', '- r1 1'])

    const c = worst(200, 300, 25)
    const rows = ownerDescription(c, OPTS).split('\n\n').find((b: string) => b.startsWith('Csomagok:'))!.split('\n').slice(1)
    const shown = rows.filter((l: string) => !l.startsWith('... és még'))
    expect(shown.length).toBeGreaterThan(0)
    expect(shown).toEqual(packageRows(c.packages).slice(0, shown.length))
    expect(rows[rows.length - 1]).toBe(`... és még ${300 - shown.length} csomag`)
  })

  it('SEC-1: a lock entry moved at the same version is counted in the never-cut head and changes the lists hash', () => {
    const none = worst(1, 0, 0)
    const moved = worst(1, 0, 0)
    moved.packages = { added: [], changed: [{ name: 'p', from: '1.0.0', to: '1.0.0', source: ['integrity'] }], removed: [] }
    const head = (c: Collected) => ownerDescription(c, OPTS).split('\n\n')[0].split('\n')
    expect(head(none)).toContain('Commitok: 1, csomagváltozás: 0')
    expect(head(moved)).toContain('Commitok: 1, csomagváltozás: 1')
    expect(sha256(fullRender(moved))).not.toBe(sha256(fullRender(none)))
    expect(fullRender(moved).split('\n')).toContain('~ p 1.0.0 (azonos verzió, más integrity)')
  })

  it('the gate line with 0, 3 and 25 paths: at most 10 names and "még 15"', () => {
    expect(gateLine([])).toBe('Kapu/deploy utak: 0 fájl')
    expect(gateLine(['a', 'b', 'c'])).toBe('Kapu/deploy utak: 3 fájl: a, b, c')
    const p = worst().gatePaths
    expect(gateLine(p)).toBe(`Kapu/deploy utak: 25 fájl: ${p.slice(0, 10).join(', ')}, ... és még 15`)
    expect(ownerDescription(worst(), OPTS).split('\n')).toContain(gateLine(p))
  })

  it('the request log path must be store/deploy-logs/request-<UTC>.log', () => {
    expect(LOG_PATH_RE.test(LOG)).toBe(true)
    for (const bad of ['/root/marveen/' + LOG, '../' + LOG, 'store/deploy-logs/request-x.log', LOG + '\nFROM x', 'store/deploy-logs/../x/request-20261117T160000Z.log']) {
      expect(() => ownerDescription(worst(1, 1, 0), { ...OPTS, logPath: bad }), bad).toThrow(/request log path/)
    }
  })

  it('content_hash binds repo, branch, FROM and TO', () => {
    const base = { ...OPTS, from: 'a'.repeat(40), to: 'b'.repeat(40) }
    expect(contentHash(base)).toBe(sha256(`${HEADER}\n${OPTS.repo}\nmain\n${'a'.repeat(40)}\n${'b'.repeat(40)}`))
    for (const over of [{ repo: 'x' }, { branch: 'dev' }, { from: 'c'.repeat(40) }, { to: 'c'.repeat(40) }]) {
      expect(contentHash({ ...base, ...over })).not.toBe(contentHash(base))
    }
  })
})
