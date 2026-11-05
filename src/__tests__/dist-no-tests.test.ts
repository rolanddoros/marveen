// B2-2b: `npm run build` leaves the tests out of dist/, and removes a stale
// dist/__tests__ that an earlier build left behind (tsc never wipes its outDir).
// Before this, the build compiled every src/__tests__ file into dist/__tests__
// (967 files on the live install, measured 2026-11-05).
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, cpSync, symlinkSync, lstatSync, readdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const CLEAN = join(ROOT, 'scripts', 'clean-dist-tests.cjs')

describe('the build config leaves the tests out of dist (B2-2b)', () => {
  it('STATIC: tsconfig.build.json extends tsconfig.json and excludes src/__tests__; tsconfig.json still covers the tests', () => {
    const build = JSON.parse(readFileSync(join(ROOT, 'tsconfig.build.json'), 'utf8')) as { extends: string; exclude: string[]; include?: string[] }
    expect(build.extends).toBe('./tsconfig.json')
    expect(build.include).toBeUndefined()
    expect(build.exclude).toEqual(expect.arrayContaining(['node_modules', 'dist', 'src/__tests__']))
    // typecheck (`tsc --noEmit`, CI) runs on tsconfig.json: the tests stay type-checked
    const base = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')) as { include: string[]; exclude: string[] }
    expect(base.include).toEqual(['src/**/*'])
    expect(base.exclude).not.toContain('src/__tests__')
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit')
  })

  it('the build program holds no test file, and still holds the app entry point', () => {
    const out = execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(ROOT, 'tsconfig.build.json'), '--listFilesOnly'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const own = out.split('\n').map(l => l.trim()).filter(Boolean)
      .map(f => relative(ROOT, f)).filter(f => !f.startsWith('..') && !isAbsolute(f) && !f.startsWith('node_modules'))
    expect(own).toContain(join('src', 'index.ts'))
    expect(own.filter(f => f.startsWith(join('src', '__tests__')))).toEqual([])
  }, 120_000)
})

// The cleanup resolves the repo root from its OWN location (<root>/scripts/..),
// so each case gets a throwaway root with the script copied under scripts/.
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dist-no-tests-'))
  mkdirSync(join(root, 'scripts'))
  cpSync(CLEAN, join(root, 'scripts', 'clean-dist-tests.cjs'))
  mkdirSync(join(root, 'src', '__tests__'), { recursive: true })
  writeFileSync(join(root, 'src', '__tests__', 'a.test.ts'), 'src test\n')
  return root
}

function withBuiltDist(root: string): void {
  mkdirSync(join(root, 'dist', 'web'), { recursive: true })
  writeFileSync(join(root, 'dist', 'index.js'), 'app\n')
  writeFileSync(join(root, 'dist', 'web', 'x.js'), 'app\n')
  writeFileSync(join(root, 'dist', '.built-commit'), 'abc\n')
}

function staleTests(dir: string): void {
  mkdirSync(join(dir, 'setup'), { recursive: true })
  writeFileSync(join(dir, 'a.test.js'), 'stale\n')
  writeFileSync(join(dir, 'setup', 'root.js'), 'stale\n')
}

function clean(root: string, cwd = root, env: NodeJS.ProcessEnv = {}): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'clean-dist-tests.cjs')], { cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' })
  return { status: r.status, stderr: r.stderr }
}

describe('scripts/clean-dist-tests.cjs: a stale dist/__tests__ goes, nothing else (B2-2b, Kevin 11980)', () => {
  it('a stale real dist/__tests__ is removed; the rest of dist and the source tests stay', () => {
    const root = makeRoot()
    withBuiltDist(root)
    staleTests(join(root, 'dist', '__tests__'))
    const r = clean(root)
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    expect(existsSync(join(root, 'dist', '__tests__'))).toBe(false)
    expect(readdirSync(join(root, 'dist')).sort()).toEqual(['.built-commit', 'index.js', 'web'])
    expect(readFileSync(join(root, 'dist', 'web', 'x.js'), 'utf8')).toBe('app\n')
    expect(readFileSync(join(root, 'src', '__tests__', 'a.test.ts'), 'utf8')).toBe('src test\n')
  })

  it('a symlinked dist/__tests__ pointing elsewhere is not followed: its target and the link stay', () => {
    const root = makeRoot()
    withBuiltDist(root)
    const elsewhere = mkdtempSync(join(tmpdir(), 'dist-no-tests-elsewhere-'))
    staleTests(elsewhere)
    symlinkSync(elsewhere, join(root, 'dist', '__tests__'))
    const r = clean(root)
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/left alone, not a real directory: .*dist\/__tests__/)
    expect(lstatSync(join(root, 'dist', '__tests__')).isSymbolicLink()).toBe(true)
    expect(readdirSync(elsewhere).sort()).toEqual(['a.test.js', 'setup'])
    expect(readFileSync(join(elsewhere, 'setup', 'root.js'), 'utf8')).toBe('stale\n')
  })

  it('a symlinked dist is not followed: the __tests__ in its target stays', () => {
    const root = makeRoot()
    const elsewhere = mkdtempSync(join(tmpdir(), 'dist-no-tests-distlink-'))
    staleTests(join(elsewhere, '__tests__'))
    symlinkSync(elsewhere, join(root, 'dist'))
    const r = clean(root)
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/left alone, not a real directory: .*\/dist\n/)
    expect(readdirSync(join(elsewhere, '__tests__')).sort()).toEqual(['a.test.js', 'setup'])
  })

  it('the root comes from the script location, never from cwd or env: a decoy dist/__tests__ there stays', () => {
    const root = makeRoot()
    withBuiltDist(root)
    staleTests(join(root, 'dist', '__tests__'))
    const decoy = mkdtempSync(join(tmpdir(), 'dist-no-tests-decoy-'))
    staleTests(join(decoy, 'dist', '__tests__'))
    const r = clean(root, decoy, { PWD: decoy, INIT_CWD: decoy, npm_config_local_prefix: decoy })
    expect(r.status).toBe(0)
    expect(existsSync(join(root, 'dist', '__tests__'))).toBe(false)
    expect(readdirSync(join(decoy, 'dist', '__tests__')).sort()).toEqual(['a.test.js', 'setup'])
  })

  it('no dist, or no dist/__tests__, or a plain file there: exit 0, nothing created or removed', () => {
    const bare = makeRoot()
    expect(clean(bare).status).toBe(0)
    expect(existsSync(join(bare, 'dist'))).toBe(false)

    const fresh = makeRoot()
    withBuiltDist(fresh)
    expect(clean(fresh)).toEqual({ status: 0, stderr: '' })
    expect(readdirSync(join(fresh, 'dist')).sort()).toEqual(['.built-commit', 'index.js', 'web'])

    const file = makeRoot()
    withBuiltDist(file)
    writeFileSync(join(file, 'dist', '__tests__'), 'not a dir\n')
    const r = clean(file)
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/left alone, not a real directory/)
    expect(readFileSync(join(file, 'dist', '__tests__'), 'utf8')).toBe('not a dir\n')
  })
})
