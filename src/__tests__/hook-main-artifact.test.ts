/**
 * C3-4: the main agent's hook wiring is a checked artifact.
 *
 * One source (src/web/hooks/manifest.ts), two generated files: the hooks block
 * of .claude/settings.json and the sidecar .claude/hooks.metadata.json
 * (HOOKDRIFT926). The committed files must equal the generator output byte for
 * byte, so a hand edit of either file, or a manifest edit without
 * `npm run hooks:generate`, fails CI here. The Python tool that measures the
 * sidecar in CI (scripts/hook-metadata.py) is run on scratch copies to show it
 * agrees with the generator (its --update is a no-op on the generated files).
 *
 * Reads THIS checkout only (root from this file's own path, never the live
 * install); every write goes to a scratch directory under os.tmpdir().
 */
import { afterAll, describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOOK_MANIFEST, renderHooks, type HookManifest, type HookManifestEntry } from '../web/hooks/manifest.js'
import {
  SIDECAR_COMMENT,
  mainGroups,
  readHookSwitchLocks,
  renderMainSettingsText,
  renderMainSidecar,
  renderMainSidecarText,
} from '../web/hooks/main-artifact.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LIVE_INSTALL_ROOT = '/root/marveen'
const SETTINGS_PATH = join(REPO_ROOT, '.claude', 'settings.json')
const SIDECAR_PATH = join(REPO_ROOT, '.claude', 'hooks.metadata.json')
const GENERATOR = join(REPO_ROOT, 'scripts', 'generate-main-hooks.ts')
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx')

const committedSettings = (): string => readFileSync(SETTINGS_PATH, 'utf-8')
const committedSidecar = (): string => readFileSync(SIDECAR_PATH, 'utf-8')
const LOCKS = readHookSwitchLocks(REPO_ROOT)

const entries = HOOK_MANIFEST.entries
const patch = (id: string, change: Partial<HookManifestEntry>): HookManifest => ({
  entries: entries.map((e) => (e.id === id ? { ...e, ...change } : e)),
  layout: HOOK_MANIFEST.layout,
})

const scratchDirs: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hook-main-artifact-'))
  scratchDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

/** A scratch checkout root holding the given .claude files. */
function scratchRoot(files: { settings?: string; sidecar?: string }): string {
  const root = scratch()
  mkdirSync(join(root, '.claude'))
  if (files.settings !== undefined) writeFileSync(join(root, '.claude', 'settings.json'), files.settings)
  if (files.sidecar !== undefined) writeFileSync(join(root, '.claude', 'hooks.metadata.json'), files.sidecar)
  return root
}

function generator(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(TSX, [GENERATOR, ...args], { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 60_000 })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('main hook artifact: the committed files are the generator output', () => {
  it('reads its own checkout, never the live install', () => {
    expect(REPO_ROOT).not.toBe(LIVE_INSTALL_ROOT)
    expect(realpathSync(REPO_ROOT)).not.toBe(LIVE_INSTALL_ROOT)
    for (const [path, live] of [[SETTINGS_PATH, '.claude/settings.json'], [SIDECAR_PATH, '.claude/hooks.metadata.json']]) {
      const livePath = `${LIVE_INSTALL_ROOT}/${live}`
      expect(realpathSync(path)).not.toBe(existsSync(livePath) ? realpathSync(livePath) : livePath)
    }
  })

  it('.claude/settings.json equals the render, byte for byte', () => {
    expect(renderMainSettingsText(HOOK_MANIFEST, committedSettings())).toBe(committedSettings())
  })

  it('.claude/hooks.metadata.json equals the render, byte for byte', () => {
    expect(renderMainSidecarText(HOOK_MANIFEST, LOCKS)).toBe(committedSidecar())
  })

  it('hook-metadata.py agrees: the generated files validate, and its --update changes nothing', () => {
    const root = scratchRoot({ settings: committedSettings(), sidecar: committedSidecar() })
    const settings = join(root, '.claude', 'settings.json')
    const r = spawnSync('python3', ['-B', join(REPO_ROOT, 'scripts', 'hook-metadata.py'), '--settings', settings, '--project-dir', REPO_ROOT, '--update'],
      { encoding: 'utf-8', timeout: 60_000 })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('no change:')
    expect(r.stdout).toContain('hook-metadata: OK, 56 hook group(s)')
    expect(readFileSync(join(root, '.claude', 'hooks.metadata.json'), 'utf-8')).toBe(committedSidecar())
  })

  it('every generated field has its source: 56 groups, ids unique, gate = the hook_switches lock list', () => {
    const sidecar = renderMainSidecar(HOOK_MANIFEST, LOCKS)
    const all = Object.values(sidecar.hooks).flat()
    expect(all).toHaveLength(mainGroups(HOOK_MANIFEST).length)
    expect(all).toHaveLength(56)
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length)
    for (const e of all) expect(e.gate).toBe(LOCKS.has(e.hook))
    expect(sidecar._comment).toBe(SIDECAR_COMMENT)
    expect(Object.keys(sidecar)).toEqual(['version', '_comment', '_generated', 'hooks'])
  })
})

describe('main hook artifact: what turns the check red', () => {
  it('a hand edit of one line in .claude/settings.json', () => {
    const drifted = committedSettings().replace('"timeout": 3', '"timeout": 4')
    expect(drifted).not.toBe(committedSettings())
    expect(renderMainSettingsText(HOOK_MANIFEST, drifted)).not.toBe(drifted)
  })

  it('a hand edit of one purpose in the sidecar', () => {
    const drifted = committedSidecar().replace('Flags, never blocks,', 'Blocks')
    expect(drifted).not.toBe(committedSidecar())
    expect(renderMainSidecarText(HOOK_MANIFEST, LOCKS)).not.toBe(drifted)
  })

  it('a manifest edit without regenerating (a timeout, a purpose)', () => {
    expect(renderMainSettingsText(patch('memory-lookup-nudge', { timeout: 4 }), committedSettings())).not.toBe(committedSettings())
    const text = renderMainSidecarText(patch('clear-capture', { sidecar: { purpose: 'Saves the thread.' } }), LOCKS)
    expect(text).not.toBe(committedSidecar())
    expect(text).toContain('"purpose": "Saves the thread."')
  })

  it('a lock removed from hook_switches', () => {
    const fewer = new Set(LOCKS)
    fewer.delete('egress-gate')
    const egress = Object.values(renderMainSidecar(HOOK_MANIFEST, fewer).hooks).flat().find((e) => e.hook === 'egress-gate')!
    expect(egress.gate).toBe(false)
    expect(renderMainSidecarText(HOOK_MANIFEST, fewer)).not.toBe(committedSidecar())
  })

  it('refuses a duplicate sidecar id (hook-metadata.py: BAD_METADATA)', () => {
    const twin = patch('telegram_progress_clear', { script: 'scripts/hooks/slack_progress_clear.py' })
    expect(() => renderHooks(twin, 'main')).not.toThrow()
    expect(() => renderMainSidecar(twin, LOCKS)).toThrow(/duplicate sidecar id stop\/slack_progress_clear/)
  })

  it('refuses a rendered matcher or command that is not printable ASCII (fingerprint parity with Python)', () => {
    expect(() => renderMainSidecar(patch('shell-rescan-guard', { matcher: 'Básh' }), LOCKS)).toThrow(/shell-rescan-guard: a rendered command or matcher is not printable ASCII/)
    expect(() => renderMainSidecar(patch('token-argv-guard', { matcher: 'Bash\t' }), LOCKS)).toThrow(/not printable ASCII/)
  })

  it('refuses incomplete sidecar text, while the main render does not depend on it', () => {
    const missing = patch('clear-capture', { sidecar: undefined })
    expect(() => renderHooks(missing, 'main')).not.toThrow()
    expect(() => renderMainSidecar(missing, LOCKS)).toThrow(/clear-capture: needs sidecar text/)
  })
})

describe('npm run hooks:generate (scripts/generate-main-hooks.ts)', () => {
  it('--check passes on this checkout', () => {
    const r = generator('--check')
    expect(r.stderr).toBe('')
    expect(r.stdout).toContain('both files match the manifest')
    expect(r.status).toBe(0)
  })

  it('regenerates a stale checkout: --check fails, a run writes both files, then --check passes and a rerun changes nothing', () => {
    const settings = JSON.parse(committedSettings()) as Record<string, unknown>
    const root = scratchRoot({ settings: `${JSON.stringify({ ...settings, hooks: {} }, null, 2)}\n` })
    const before = generator('--root', root, '--check')
    expect(before.status).toBe(1)
    expect(before.stderr).toContain(`${join(root, '.claude', 'settings.json')} differs from the manifest`)
    expect(before.stderr).toContain(`${join(root, '.claude', 'hooks.metadata.json')} is missing`)
    expect(existsSync(join(root, '.claude', 'hooks.metadata.json'))).toBe(false)

    const write = generator('--root', root)
    expect(write.status).toBe(0)
    expect(readFileSync(join(root, '.claude', 'settings.json'), 'utf-8')).toBe(committedSettings())
    expect(readFileSync(join(root, '.claude', 'hooks.metadata.json'), 'utf-8')).toBe(committedSidecar())

    expect(generator('--root', root, '--check').status).toBe(0)
    const again = generator('--root', root)
    expect(again.status).toBe(0)
    expect(again.stdout).toContain('no change')
  })

  it('refuses the live install before reading anything, also in --check mode', () => {
    const r = generator('--root', LIVE_INSTALL_ROOT, '--check')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('refusing /root/marveen: it is the live install')
  })

  // Only where the live install exists (not on CI). --check: nothing would be written even if the guard failed.
  it.runIf(existsSync(join(LIVE_INSTALL_ROOT, '.claude')))('refuses a checkout whose .claude, or which itself, links to the live install', () => {
    const linkedClaude = scratch()
    symlinkSync(join(LIVE_INSTALL_ROOT, '.claude'), join(linkedClaude, '.claude'))
    const linkedRoot = join(scratch(), 'root')
    symlinkSync(LIVE_INSTALL_ROOT, linkedRoot)
    for (const root of [linkedClaude, linkedRoot]) {
      const r = generator('--root', root, '--check')
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('it is the live install')
    }
  })

  it('refuses a missing settings file and an unknown argument', () => {
    const empty = scratchRoot({})
    const r = generator('--root', empty)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('does not exist')
    expect(existsSync(join(empty, '.claude', 'hooks.metadata.json'))).toBe(false)
    expect(generator('--frobnicate').status).toBe(2)
  })
})
