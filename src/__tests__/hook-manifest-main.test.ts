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
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HOOK_MANIFEST,
  renderHooks,
  specFor,
  validateManifest,
  type FailMode,
  type HookEvent,
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
    // Exact, not a prefix: a sealed copy under /root/marveen/store/... is a
    // checkout of its own; a symlink onto the live settings file is not. The
    // live side is resolved too where it exists (CI has no /root/marveen), in
    // case the live file itself ever becomes a symlink (Ron 13746).
    const live = `${LIVE_INSTALL_ROOT}/.claude/settings.json`
    expect(realpathSync(SETTINGS_PATH)).not.toBe(existsSync(live) ? realpathSync(live) : live)
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
})

// The fail mode a command's own text gives it, read from the tracked file and
// independent of the manifest's wrapper field (Ron N1: failMode is data that
// nothing else reads, so it is pinned here against what the wrapper does).
const FAIL_CLOSED_TAIL = /rc=\$\?; \[ "\$rc" = 0 \] \|\| \[ "\$rc" = 2 \] \|\| \{ echo "[^"]*" >&2; exit 2; \}; exit "\$rc"$/
const CLOSED_WHILE_FROZEN = /\[ -e "[^"]*\/store\/fleet-freeze\.json" \] && \{ echo "[^"]*" >&2; exit 2; \}; exit 0'$/

function failModeFromText(hook: { type: string; command?: string }): FailMode {
  if (hook.type !== 'command') return 'advisory'
  const cmd = hook.command ?? ''
  // Not wrapped in bash -c, every status other than 0 and 2 becomes exit 2.
  if (!cmd.startsWith("bash -c '") && FAIL_CLOSED_TAIL.test(cmd)) return 'closed'
  if (cmd.startsWith("bash -c '[ -f ") && cmd.endsWith("; exit 0'")) {
    // A missing script falls through to exit 0, unless the frozen marker turns it into exit 2.
    return CLOSED_WHILE_FROZEN.test(cmd) ? 'closed' : 'open'
  }
  throw new Error(`unclassified wrapper: ${cmd.slice(0, 120)}`)
}

describe('hook manifest failMode, main scope', () => {
  it('each entry records the fail mode its wrapper text has in the tracked file', () => {
    const file = trackedHooks() as Record<string, Array<{ hooks: Array<{ type: string; command?: string }> }>>
    const byId = new Map(HOOK_MANIFEST.entries.map((e) => [e.id, e] as const))
    const mismatches: string[] = []
    let checked = 0
    for (const [event, slots] of Object.entries(HOOK_MANIFEST.layout.main ?? {}) as Array<[HookEvent, ReadonlyArray<string | readonly string[]>]>) {
      let groupIndex = 0
      for (const slot of slots) {
        const ids = typeof slot === 'string' ? [slot] : [...slot]
        const first = specFor(byId.get(ids[0])!, 'main')
        const groupCount = Array.isArray(first.matcher) ? first.matcher.length : 1
        for (let g = 0; g < groupCount; g++, groupIndex++) {
          ids.forEach((id, h) => {
            const actual = failModeFromText(file[event][groupIndex].hooks[h])
            const recorded = specFor(byId.get(id)!, 'main').failMode
            checked++
            if (actual !== recorded) mismatches.push(`${event}[${groupIndex}] ${id}: wrapper says ${actual}, manifest says ${recorded}`)
          })
        }
      }
    }
    expect(checked).toBe(56)
    expect(mismatches).toEqual([])
  })

  it('counts 5 closed, 36 open, 0 advisory', () => {
    const counts = { closed: 0, open: 0, advisory: 0 }
    for (const e of HOOK_MANIFEST.entries.filter((x) => x.scope !== 'sub')) counts[specFor(e, 'main').failMode]++
    expect(counts).toEqual({ closed: 5, open: 36, advisory: 0 })
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
