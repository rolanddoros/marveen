// The main agent's hook wiring as a checked artifact (C3-4).
//
// One source, two generated files: from the hook manifest (manifest.ts) this
// module renders
//   - the `hooks` block of the tracked .claude/settings.json (the rest of the
//     file, permissions and plugins, is carried over unchanged), and
//   - the sidecar .claude/hooks.metadata.json (HOOKDRIFT926), which
//     scripts/hook-metadata.py measures in CI.
// scripts/generate-main-hooks.ts writes both into a checkout (npm run
// hooks:generate); src/__tests__/hook-main-artifact.test.ts fails CI when the
// committed files differ from what this module renders, so a hand edit of
// either file, or a manifest edit without regenerating, turns CI red.
//
// Pure except readHookSwitchLocks (one python3 call, read only). Nothing here
// writes a file; nothing at runtime reads the main settings from here (the
// main agent reads the tracked file as before).
//
// Every sidecar field, and where it comes from:
//   version, _comment  constants, byte-equal to what hook-metadata.py --update
//                      writes, so --update on a generated sidecar is a no-op
//   _generated         a constant note (an unknown top-level key: hook-metadata.py
//                      carries it over verbatim and does not measure it)
//   index              the group's place under its event
//   id, purpose        manifest sidecar text (sidecarGroupText)
//   hook               the script stem, hook_switches.normalize's rule
//   gate               the stem is in hook_switches.DEFAULT_NON_DISABLEABLE, the
//                      rule hook-metadata.py check_gates enforces
//   fingerprint        sha256 of the rendered group, hook-metadata.py's rule
// No `non_disableable` key: that list is an install's own addition, not the repo's.

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  renderHooks,
  sidecarGroupText,
  specFor,
  validateSidecarText,
  type HookEvent,
  type HookManifest,
  type HookManifestEntry,
  type RenderedGroup,
  type RenderedHooks,
} from './manifest.js'

export const SIDECAR_VERSION = 1

/** hook-metadata.py build_metadata()'s _comment, byte for byte. */
export const SIDECAR_COMMENT = 'Sidecar for the hooks block of settings.json (HOOKDRIFT926). One entry per matcher group, '
  + 'same event and index. After editing hooks run: python3 scripts/hook-metadata.py --update, review the printed diff, '
  + 'fix any TODO purpose, commit both files. Optional top-level \'non_disableable\': extra hook names (this install\'s '
  + 'own gates / audit ledgers) that MARVEEN_DISABLED_HOOKS may never switch off; it can only add to the built-in list '
  + 'in scripts/hooks/hook_switches.py.'

export const SIDECAR_GENERATED_NOTE = 'GENERATED for the main agent from src/web/hooks/manifest.ts, together with the hooks '
  + 'block of .claude/settings.json. Do not edit either by hand: change the manifest, run npm run hooks:generate, '
  + 'commit both files (CI compares them with the generator output).'

export interface SidecarEntry {
  index: number
  id: string
  hook: string
  gate: boolean
  purpose: string
  fingerprint: string
}

export interface MainSidecar {
  version: number
  _comment: string
  _generated: string
  hooks: Partial<Record<HookEvent, SidecarEntry[]>>
}

/** One rendered main matcher group, with the entry and matcher index it comes from. */
export interface MainGroup {
  event: HookEvent
  entry: HookManifestEntry
  matcherIndex: number
  group: RenderedGroup
}

/** Printable ASCII only: JSON.stringify and Python's json.dumps(ensure_ascii=False) agree on it byte for byte. */
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]*$/

/**
 * Every main matcher group in written order. renderHooks walks the main layout
 * the same way (one slot per entry, one group per matcher), so the i-th group
 * of an event belongs to the i-th (slot, matcher) of that event.
 */
export function mainGroups(m: HookManifest, rendered: RenderedHooks = renderHooks(m, 'main')): MainGroup[] {
  const byId = new Map(m.entries.map((e) => [e.id, e] as const))
  const out: MainGroup[] = []
  for (const [event, slots] of Object.entries(m.layout.main ?? {}) as Array<[HookEvent, ReadonlyArray<string | readonly string[]>]>) {
    const groups = rendered[event] ?? []
    let i = 0
    for (const slot of slots) {
      if (typeof slot !== 'string') throw new Error(`main artifact: ${event}: a shared group has no place in the main sidecar`)
      const entry = byId.get(slot)!
      const matcher = specFor(entry, 'main').matcher
      const count = Array.isArray(matcher) ? matcher.length : 1
      for (let matcherIndex = 0; matcherIndex < count; matcherIndex++) out.push({ event, entry, matcherIndex, group: groups[i++] })
    }
    if (i !== groups.length) throw new Error(`main artifact: ${event}: ${i} groups walked, ${groups.length} rendered`)
  }
  return out
}

/** hook-metadata.py fingerprint(): sha256 over compact JSON [event, matcher or "", [command / prompt of each handler]]. */
export function sidecarFingerprint(event: string, group: RenderedGroup): string {
  const body = [event, group.matcher ?? '', group.hooks.map((h) => (h.type === 'command' ? h.command : h.prompt))]
  return createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex')
}

/** hook_switches.normalize() for a manifest script: file name, no extension, lower-case. */
function hookStem(script: string): string {
  return script.slice(script.lastIndexOf('/') + 1).replace(/\.(py|mjs|sh)$/, '').toLowerCase()
}

/**
 * The sidecar of the main settings. `locked` is the lock list the gate flag
 * follows (readHookSwitchLocks). Throws when the manifest's sidecar text is
 * incomplete, when two groups would get the same id (hook-metadata.py:
 * BAD_METADATA), or when a rendered command or matcher is not printable ASCII
 * (the fingerprint would no longer be guaranteed equal to the Python one).
 */
export function renderMainSidecar(m: HookManifest, locked: ReadonlySet<string>): MainSidecar {
  validateSidecarText(m)
  const hooks: Partial<Record<HookEvent, SidecarEntry[]>> = {}
  const ids = new Map<string, string>()
  for (const g of mainGroups(m)) {
    const where = `${g.event} ${g.entry.id}`
    for (const text of [g.group.matcher ?? '', ...g.group.hooks.map((h) => (h.type === 'command' ? h.command : h.prompt))]) {
      if (!PRINTABLE_ASCII_RE.test(text)) throw new Error(`main artifact: ${where}: a rendered command or matcher is not printable ASCII`)
    }
    const { id, purpose } = sidecarGroupText(g.entry, g.event, g.matcherIndex)
    const other = ids.get(id)
    if (other !== undefined) throw new Error(`main artifact: duplicate sidecar id ${id} (${other} and ${where})`)
    ids.set(id, where)
    const list = (hooks[g.event] ??= [])
    const hook = hookStem(g.entry.script)
    list.push({ index: list.length, id, hook, gate: locked.has(hook), purpose, fingerprint: sidecarFingerprint(g.event, g.group) })
  }
  return { version: SIDECAR_VERSION, _comment: SIDECAR_COMMENT, _generated: SIDECAR_GENERATED_NOTE, hooks }
}

/** The sidecar file text: hook-metadata.py's dump() layout (2-space indent, trailing newline). */
export function renderMainSidecarText(m: HookManifest, locked: ReadonlySet<string>): string {
  return `${JSON.stringify(renderMainSidecar(m, locked), null, 2)}\n`
}

/**
 * The main settings file text: `settingsText` with its `hooks` value replaced
 * by renderHooks(m, 'main'), every other key and the key order kept (a missing
 * `hooks` key is appended), 2-space indent, trailing newline.
 */
export function renderMainSettingsText(m: HookManifest, settingsText: string): string {
  const settings = JSON.parse(settingsText) as unknown
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error('main artifact: the settings file is not a JSON object')
  }
  const out = { ...(settings as Record<string, unknown>), hooks: renderHooks(m, 'main') }
  return `${JSON.stringify(out, null, 2)}\n`
}

/**
 * hook_switches.DEFAULT_NON_DISABLEABLE of the checkout at `repoRoot`, asked
 * from Python itself (the module imported, not its text parsed). Read only,
 * no bytecode written.
 */
export function readHookSwitchLocks(repoRoot: string): Set<string> {
  const code = 'import json, sys\nsys.path.insert(0, sys.argv[1])\nimport hook_switches\n'
    + 'print(json.dumps(sorted(hook_switches.DEFAULT_NON_DISABLEABLE)))'
  // -I: no user site, no PYTHON* env; -B: no __pycache__ written into the checkout.
  const r = spawnSync('python3', ['-I', '-B', '-c', code, join(repoRoot, 'scripts', 'hooks')], { encoding: 'utf-8', timeout: 30_000 })
  if (r.status !== 0) throw new Error(`main artifact: cannot read the hook lock list (python3 exit ${r.status}): ${r.error?.message ?? r.stderr}`)
  const names = JSON.parse(r.stdout) as unknown
  if (!Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === 'string' && n !== '')) {
    throw new Error('main artifact: the hook lock list is not a non-empty list of names')
  }
  return new Set(names as string[])
}
