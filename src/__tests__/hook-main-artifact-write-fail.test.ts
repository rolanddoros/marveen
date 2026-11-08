/**
 * Ron 13824: `npm run hooks:generate` leaves no temp file behind when a rename fails, and a failure on the second
 * file leaves the first one written (each file is replaced atomically on its own, not the two together).
 *
 * renameSync is mocked to fail for the sidecar only: a real rename failure cannot be set up from outside, because
 * the generator reads every target before it writes, and a target that cannot be renamed over (a directory) already
 * fails that read. Every write goes to a scratch directory under os.tmpdir().
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (String(to).endsWith('hooks.metadata.json')) throw Object.assign(new Error('EIO: simulated rename failure'), { code: 'EIO' })
      return fs.renameSync(from, to)
    },
  }
})

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
// A runtime path, as bridge-device-key.test.ts does: scripts/ is outside tsc's rootDir.
type GenerateCli = { runGenerateMainHooks: (argv: readonly string[], out: (l: string) => void, err: (l: string) => void) => number }
const { runGenerateMainHooks } = (await import(join(REPO_ROOT, 'scripts', 'generate-main-hooks.ts'))) as GenerateCli
const scratchDirs: string[] = []
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

describe('npm run hooks:generate: a failed rename', () => {
  it('exits 2 with the error, removes its temp file, and keeps the settings file it already replaced', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-main-artifact-fail-'))
    scratchDirs.push(root)
    mkdirSync(join(root, '.claude'))
    const committed = readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf-8')
    writeFileSync(join(root, '.claude', 'settings.json'), `${JSON.stringify({ ...JSON.parse(committed), hooks: {} }, null, 2)}\n`)

    const out: string[] = []
    const err: string[] = []
    expect(runGenerateMainHooks(['--root', root], (l) => out.push(l), (l) => err.push(l))).toBe(2)
    expect(err.join('\n')).toContain('EIO: simulated rename failure')
    expect(readdirSync(join(root, '.claude'))).toEqual(['settings.json'])
    expect(readFileSync(join(root, '.claude', 'settings.json'), 'utf-8')).toBe(committed)
  })
})
