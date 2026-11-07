/**
 * C3-1a: the typed hook manifest reproduces the main agent's wiring exactly.
 *
 * The reference is the tracked .claude/settings.json of THIS checkout (a
 * worktree or a CI checkout), read only. The root is derived from this file's
 * own location, never from config or env, and a guard below fails loudly if it
 * ever resolves to the live install, so a mis-set run cannot quietly compare
 * against (or be mistaken for a check of) the running system's file.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HOOK_MANIFEST,
  renderHooks,
  validateManifest,
  type HookManifest,
  type HookManifestEntry,
} from '../web/hooks/manifest.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LIVE_INSTALL_ROOT = '/root/marveen'
const SETTINGS_PATH = join(REPO_ROOT, '.claude', 'settings.json')

function trackedHooks(): Record<string, unknown> {
  return (JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as { hooks: Record<string, unknown> }).hooks
}

function withEntries(entries: HookManifestEntry[], layout = HOOK_MANIFEST.layout): HookManifest {
  return { entries, layout }
}

describe('hook manifest, main scope', () => {
  it('reads the settings of its own checkout, never the live install', () => {
    expect(REPO_ROOT).not.toBe(LIVE_INSTALL_ROOT)
    expect(realpathSync(REPO_ROOT)).not.toBe(LIVE_INSTALL_ROOT)
    expect(realpathSync(SETTINGS_PATH).startsWith(`${LIVE_INSTALL_ROOT}/`)).toBe(false)
  })

  it('renders exactly the hooks object of the tracked .claude/settings.json', () => {
    expect(renderHooks(HOOK_MANIFEST, 'main')).toEqual(trackedHooks())
  })

  it('renders the same text, key order included (what a checked artifact in C3-4 compares)', () => {
    expect(JSON.stringify(renderHooks(HOOK_MANIFEST, 'main'), null, 2)).toBe(JSON.stringify(trackedHooks(), null, 2))
  })

  it('covers 56 settings entries with 41 manifest entries', () => {
    const rendered = renderHooks(HOOK_MANIFEST, 'main')
    const count = Object.values(rendered).flatMap((groups) => groups ?? []).flatMap((g) => g.hooks).length
    expect(count).toBe(56)
    expect(HOOK_MANIFEST.entries.filter((e) => e.scope === 'main' || e.scope === 'both')).toHaveLength(41)
  })

  it('the sub-agent render is not part of C3-1a', () => {
    expect(() => renderHooks(HOOK_MANIFEST, 'sub')).toThrow(/C3-1b/)
  })
})

describe('hook manifest validation', () => {
  const entries = [...HOOK_MANIFEST.entries]

  it('accepts the shipped manifest', () => {
    expect(() => validateManifest(HOOK_MANIFEST, 'main')).not.toThrow()
  })

  it('rejects a duplicate id', () => {
    expect(() => validateManifest(withEntries([...entries, entries[0]]), 'main')).toThrow(/duplicate id/)
  })

  it('rejects an entry the layout does not place', () => {
    const extra: HookManifestEntry = { ...entries[0], id: 'unplaced-probe' }
    expect(() => validateManifest(withEntries([...entries, extra]), 'main')).toThrow(/no place in the main layout/)
  })

  it('rejects a layout slot naming an unknown id', () => {
    const layout = { main: { ...HOOK_MANIFEST.layout.main, StopFailure: ['ledger-turn-failure', 'no-such-hook'] } }
    expect(() => validateManifest(withEntries(entries, layout), 'main')).toThrow(/unknown id no-such-hook/)
  })

  it('rejects an entry placed under an event it is not registered for', () => {
    const layout = { main: { ...HOOK_MANIFEST.layout.main, SessionEnd: ['clear-capture', 'ledger-turn-failure'] } }
    expect(() => validateManifest(withEntries(entries, layout), 'main')).toThrow(/not registered under SessionEnd/)
  })

  it('rejects an argument that would need shell quoting', () => {
    const bad = entries.map((e) => (e.id === 'marveen-commands-stop' ? { ...e, args: ['--stop; rm'] } : e))
    expect(() => validateManifest(withEntries(bad), 'main')).toThrow(/argument needs quoting/)
  })

  it('rejects a sub-only wrapper in the main render', () => {
    const bad = entries.map((e) => (e.id === 'clear-capture' ? { ...e, wrapper: 'bare' as const } : e))
    expect(() => renderHooks(withEntries(bad), 'main')).toThrow(/not a main-agent spelling/)
  })
})
