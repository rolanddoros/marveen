// The sub-agent settings generator (C3-3a): a sub-agent's whole `hooks` block,
// rendered from the hook manifest, with what the manifest does not own kept.
//
// Pure: no file is read or written; the caller passes the agent's current
// hooks block and its inputs. C3-3a has no settings caller: the read-only
// dry-run (hooks/cli.ts) and the tests use it. C3-3b switches the spawn
// (writeAgentSettingsFromProfile) and the boot backfill over to it.
//
// What it keeps from the current file, and why (each rule is today's
// behaviour of the injectors and ensure* migrations it replaces):
//   - a hook the manifest does not own (another script, or an owned script
//     under a matcher outside the entry's ownMatchers): an operator's own
//     wiring, kept as it is, after the rendered groups of its event;
//   - a conditional entry's existing copy while its switch is off, unless the
//     entry says offRemoves (switching a gate off is not a teardown; the second
//     reviewer and the sender-role gate are removed, as today);
//   - an entry whose rendered command fails the registration guard (a script
//     under a tmp root or missing): not rendered, and its existing copy stays;
//   - the PreCompact prompt the file already carries (an edited prompt stays);
//   - the envelope rule (injectWebSearchEnvelope): where a kept group already
//     runs browser-content-notice.py for WebSearch and WebFetch, the managed
//     entry is not rendered; where it covers one of them, the managed entry
//     names only the other;
//   - install-local extras (store/extra-hooks.json) last, by applyExtraHookEntries.
// Order and grouping are the manifest's layout: hooks matching one event run
// in parallel and their order has no meaning (Claude Code hooks docs, quoted in
// the C3-3a PR), so the first render normalises them once (Johnny 13728).

import { applyExtraHookEntries, isExtraHookGroup, type ExtraHookEntry } from '../extra-hook-entries.js'
import {
  HOOK_MANIFEST, activeFor, matchersOf, renderHooks, renderSubHook, specFor,
  type HookEvent, type HookManifest, type HookManifestEntry, type RenderContext,
} from './manifest.js'

export interface SubHookInputs extends RenderContext {
  /** The registration guard (agent-scaffold.ts isUnsafeHookCommand): true = do not register this command. */
  isUnsafe?: (command: string) => boolean
  /** Validated install-local extras (loadExtraHookEntries). */
  extras?: readonly ExtraHookEntry[]
}

type Hook = Record<string, unknown>
type Group = { matcher?: unknown; hooks?: unknown; [k: string]: unknown }

export interface KeptHook {
  event: string
  matcher?: string
  hook: Hook
  /** A hook that is not the manifest's, found in a group next to a manifest hook (Ron N2, Johnny 13927: kept, and reported). */
  inManagedGroup?: true
}

export interface SubHookPlan {
  hooks: Record<string, Group[]>
  /** Hooks kept as they are (not the manifest's, or a switched-off gate's copy), extras not included. */
  kept: KeptHook[]
  /** Active entries not rendered because the registration guard refused their command. */
  unsafe: string[]
}

const ENVELOPE_ID = 'browser-content-notice'
/** The two tools the managed envelope covers (agent-scaffold.ts re-exports it for its callers). */
export const ENVELOPE_TOOLS = ['WebSearch', 'WebFetch'] as const

/** The script file a hook command runs (e.g. "staleness-guard.py"); the first path with a script extension. */
export function scriptBasename(command: string): string | null {
  const m = command.match(/\/([^/\s'"]+\.(?:py|mjs|js|sh))\b/)
  return m ? m[1] : null
}

/**
 * Which envelope tools a PostToolUse matcher reaches, the way the shipped CLI matches: a missing, '' or '*'
 * matcher matches every tool; a plain name list (letters, digits, _ | , space -) the exact names split on | or ,;
 * anything else is an UNANCHORED regex, and an invalid one matches nothing. A non-string matcher fails the CLI's
 * settings schema, so that group never runs: it covers nothing.
 */
export function envelopeToolsCovered(matcher: unknown): Set<string> {
  if (matcher === undefined || matcher === '' || matcher === '*') return new Set(ENVELOPE_TOOLS)
  if (typeof matcher !== 'string') return new Set()
  if (/^[a-zA-Z0-9_|, -]+$/.test(matcher)) {
    const names = matcher.split(/[|,]/).map((n) => n.trim()).filter(Boolean)
    return new Set(ENVELOPE_TOOLS.filter((t) => names.includes(t)))
  }
  const covered = new Set<string>()
  for (const tool of ENVELOPE_TOOLS) {
    try { if (new RegExp(matcher).test(tool)) covered.add(tool) } catch { /* invalid regex covers nothing */ }
  }
  return covered
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The sub entry an existing hook belongs to, or null: by event, script file and (where set) ownMatchers. */
export function ownerOf(m: HookManifest, event: string, matcher: unknown, hook: Hook): HookManifestEntry | null {
  for (const e of m.entries) {
    if (e.scope === 'main') continue
    const spec = specFor(e, 'sub')
    if (!spec.events.includes(event as HookEvent)) continue
    if (spec.wrapper === 'agentPrompt') {
      if (hook.type === 'agent' && matchersOf(spec).includes(matcher as string | undefined)) return e
      continue
    }
    if (typeof hook.command !== 'string' || scriptBasename(hook.command) !== e.script.slice(e.script.lastIndexOf('/') + 1)) continue
    if (e.ownMatchers && !(typeof matcher === 'string' && e.ownMatchers.includes(matcher))) continue
    return e
  }
  return null
}

/** An event of the current block that is not a list: the caller leaves the file alone. `event` is the file's key, as is. */
export class HookShapeError extends Error {
  constructor(readonly event: string) {
    super(`hooks.${event} is not a list; the generator leaves this file alone`)
    this.name = 'HookShapeError'
  }
}

/**
 * What of a generator or writer error may be logged or printed (Ron N7, 13916): a manifest error's own text
 * (shipped text and the install's root and node paths, which `show` may replace), else the error class only. Never
 * any other message: a HookShapeError's carries an event key from the settings file, a TypeError's can carry one.
 */
export function hookErrorSummary(err: unknown, show: (s: string) => string = (s) => s): string {
  if (err instanceof Error && err.message.startsWith('hook manifest: ')) return show(err.message)
  if (err instanceof HookShapeError) return 'HookShapeError'
  return `unexpected error (${err instanceof Error ? err.name : typeof err})`
}

/**
 * The hooks block the generator writes for one sub-agent, from its current
 * block (`existing`, anything: a missing or malformed block is none) and its
 * inputs. Throws where the render throws (a bad root or node binary): the
 * caller then leaves the file as it is.
 */
export function generateSubHooks(existing: unknown, inputs: SubHookInputs, m: HookManifest = HOOK_MANIFEST): SubHookPlan {
  const current = isObject(existing) ? existing : {}
  const ctx: RenderContext = { ...inputs }
  // The registration guard, per active entry, on the command it would write.
  const unsafe = m.entries.filter((e) => e.scope !== 'main' && activeFor(e, ctx) && specFor(e, 'sub').wrapper !== 'agentPrompt'
    && inputs.isUnsafe?.(String((renderSubHook(e, ctx) as { command: string }).command)) === true).map((e) => e.id)
  const keepWhenOwned = (e: HookManifestEntry) => unsafe.includes(e.id) || (!activeFor(e, ctx) && !e.offRemoves)

  const keptGroups: Record<string, Group[]> = {}
  const kept: KeptHook[] = []
  let prompt: string | undefined
  let promptSeen = false
  for (const [event, groups] of Object.entries(current)) {
    if (!Array.isArray(groups)) throw new HookShapeError(event)
    for (const g of groups as unknown[]) {
      const keep = (group: unknown) => (keptGroups[event] ??= []).push(group as Group)
      if (!isObject(g) || !Array.isArray(g.hooks) || isExtraHookGroup(g)) { keep(g); continue }
      const rest: Hook[] = []
      const owners = (g.hooks as unknown[]).map((h) => (isObject(h) ? ownerOf(m, event, g.matcher, h) : null))
      g.hooks.forEach((h, i) => {
        const hook = isObject(h) ? h : {}
        let owner = owners[i]
        if (owner && specFor(owner, 'sub').wrapper === 'agentPrompt') {
          // The first agent hook is the prompt the render keeps; a further one is the operator's: kept as a
          // foreign hook and listed, never dropped (Ron N3, Johnny 13927).
          if (!promptSeen) {
            promptSeen = true
            if (typeof hook.prompt === 'string') prompt = hook.prompt
            return
          }
          owner = null
        }
        if (owner && !keepWhenOwned(owner)) return
        rest.push(h as Hook)
        const inManagedGroup = owner === null && owners.some((o, j) => o !== null && j !== i)
        kept.push({ event, ...(typeof g.matcher === 'string' ? { matcher: g.matcher } : {}), hook, ...(inManagedGroup ? { inManagedGroup: true as const } : {}) })
      })
      if (rest.length > 0) keep(rest.length === g.hooks.length ? g : { ...g, hooks: rest })
    }
  }

  // The envelope rule, against the kept groups only.
  const covered = new Set<string>()
  for (const g of keptGroups.PostToolUse ?? []) {
    if (!isObject(g) || !Array.isArray(g.hooks)) continue
    if (g.hooks.some((h) => isObject(h) && typeof h.command === 'string' && scriptBasename(h.command) === 'browser-content-notice.py')) {
      for (const t of envelopeToolsCovered(g.matcher)) covered.add(t)
    }
  }
  const missing = ENVELOPE_TOOLS.filter((t) => !covered.has(t))
  let manifest = m
  if (missing.length > 0 && missing.length < ENVELOPE_TOOLS.length) {
    manifest = { ...m, entries: m.entries.map((e) => (e.id !== ENVELOPE_ID ? e
      : { ...e, override: { ...e.override, sub: { ...e.override?.sub, matcher: missing.join('|') } } })) }
  }
  const skip = new Set([...unsafe, ...(missing.length === 0 ? [ENVELOPE_ID] : [])])

  const rendered = renderHooks(manifest, 'sub', {
    ...ctx, skip, prompts: { ...ctx.prompts, ...(prompt === undefined ? {} : { precompact: prompt }) },
  }) as Record<string, Group[]>
  const hooks: Record<string, Group[]> = { ...rendered }
  for (const [event, groups] of Object.entries(keptGroups)) hooks[event] = [...(hooks[event] ?? []), ...groups]
  const settings: Record<string, unknown> = { hooks }
  applyExtraHookEntries(settings, inputs.extras ?? [])
  return { hooks: (settings.hooks ?? {}) as Record<string, Group[]>, kept, unsafe }
}
