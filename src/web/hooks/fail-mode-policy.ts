// Hook fail-mode policy (C3-2): which fail mode a hook SHOULD have, by its role.
//
// The manifest (manifest.ts) records what every wrapper does today; this module
// says what it should do, keyed by the entry's `kind`, and names the entries
// that differ today with the reason. Nothing here changes a wrapper or writes a
// settings file: src/__tests__/hook-fail-mode-policy.test.ts runs the check, and
// the reasons for every rule are in docs/hook-fail-modes.md.

import { specFor, type FailMode, type HookKind, type HookManifest, type HookManifestEntry, type HookScope, type WrapperKind } from './manifest.js'

/** The fail mode each kind should have. The reasons are in docs/hook-fail-modes.md. */
export const FAIL_MODE_POLICY: Readonly<Record<HookKind, FailMode>> = {
  'security-gate': 'closed',
  // Closed while frozen (pending owner decision 3, C3 plan): a broken gate
  // blocks only while store/fleet-freeze.json exists, see CLOSED_WHILE_FROZEN.
  'kill-switch': 'closed',
  guard: 'open',
  enforcer: 'open',
  directive: 'open',
  capture: 'open',
  handler: 'open',
  prompt: 'advisory',
}

/**
 * The wrappers that spell "closed while frozen". A kill-switch's `closed` must
 * be one of these and a security-gate's `closed` must not: for a gate, closed
 * means any broken run blocks, always.
 */
export const CLOSED_WHILE_FROZEN: readonly WrapperKind[] = ['failOpenExecClosedWhenFrozen']

/**
 * The fail mode each wrapper spells (C3-5): one spelling per mode, so a wrapper
 * and the failMode recorded next to it can never disagree. `closed` has two:
 * failClosed, and the kill switch's closed-while-frozen spelling (see above).
 */
export const WRAPPER_FAIL_MODE: Readonly<Record<WrapperKind, FailMode>> = {
  failOpenExec: 'open',
  failClosed: 'closed',
  failOpenExecClosedWhenFrozen: 'closed',
  agentPrompt: 'advisory',
}

/** The only event on which a hook may fail closed (see docs/hook-fail-modes.md). */
export const CLOSED_EVENT = 'PreToolUse'

export interface FailModeException {
  id: string
  scope: HookScope
  /** The fail mode the manifest records today, against the policy of the entry's kind. */
  failMode: FailMode
  reason: string
}

/**
 * Entries whose recorded fail mode differs from the policy today. Recorded, not
 * fixed: removing a row means changing the entry's wrapper and fail mode, or the policy, in the
 * same change. A row that no longer differs fails the check, so the list cannot
 * outlive the mismatch it names.
 */
export const FAIL_MODE_EXCEPTIONS: readonly FailModeException[] = [
  {
    id: 'fleet-freeze-gate',
    scope: 'sub',
    failMode: 'open',
    reason: 'The sub-agents get the plain fail-open wrapper (failOpenExec), so a missing script lets calls through '
      + 'even while frozen. Whether the kill switch should fail closed on the sub-agents is owner decision 3 (C3 plan), '
      + 'pending, separate from the wrapper normalisation (C3-5).',
  },
  {
    id: 'child-claude-channel-guard',
    scope: 'sub',
    failMode: 'closed',
    reason: 'Decided per scope: fail-open on the main agent, while the scaffold\'s sub-agent copy stays fail-closed '
      + '(Kevin 13549 B1, agent-scaffold.ts at CHILD_CLAUDE_GUARD_SCRIPT). The script itself calls it a guard against '
      + 'an accident, not a security boundary (child-claude-channel-guard.mjs, header).',
  },
]

/** The scopes an entry is part of. */
export function scopesOf(entry: HookManifestEntry): HookScope[] {
  return entry.scope === 'both' ? ['main', 'sub'] : [entry.scope]
}

/**
 * Every place where the manifest departs from the policy without a matching
 * exception, plus every exception that is stale, wrong or names nothing. Empty
 * means the manifest follows the policy. Pure: reads only its arguments.
 */
export function failModePolicyFindings(
  m: HookManifest,
  exceptions: readonly FailModeException[] = FAIL_MODE_EXCEPTIONS,
  policy: Readonly<Record<HookKind, FailMode>> = FAIL_MODE_POLICY,
): string[] {
  const findings: string[] = []
  const used = new Set<string>()
  const byKey = new Map<string, FailModeException>()
  for (const x of exceptions) {
    const key = `${x.id} (${x.scope})`
    if (byKey.has(key)) findings.push(`${key}: listed twice as an exception`)
    byKey.set(key, x)
    if (!x.reason.trim()) findings.push(`${key}: exception without a reason`)
  }
  for (const e of m.entries) {
    if (!(e.kind in policy)) {
      findings.push(`${e.id}: unknown kind ${String(e.kind)}`)
      continue
    }
    for (const scope of scopesOf(e)) {
      const key = `${e.id} (${scope})`
      const spec = specFor(e, scope)
      const want = policy[e.kind]
      const x = byKey.get(key)
      if (x) used.add(key)
      if (WRAPPER_FAIL_MODE[spec.wrapper] !== spec.failMode) findings.push(`${key}: wrapper ${spec.wrapper} does not spell fail mode ${spec.failMode}`)
      if (spec.failMode !== want) {
        if (!x) findings.push(`${key}: kind ${e.kind} should fail ${want}, the manifest records ${spec.failMode}, and no exception names it`)
        else if (x.failMode !== spec.failMode) findings.push(`${key}: the exception records ${x.failMode}, the manifest records ${spec.failMode}`)
      } else if (x) {
        findings.push(`${key}: stale exception, the manifest now records ${spec.failMode} as the policy of ${e.kind} says; remove the row`)
      }
      if (spec.failMode === 'closed') {
        const off = spec.events.filter((ev) => ev !== CLOSED_EVENT)
        if (off.length > 0) findings.push(`${key}: fails closed on ${off.join(', ')}; only ${CLOSED_EVENT} may fail closed`)
        const frozenOnly = CLOSED_WHILE_FROZEN.includes(spec.wrapper)
        if (e.kind === 'kill-switch' && !frozenOnly) findings.push(`${key}: a kill-switch fails closed while frozen, but wrapper ${spec.wrapper} is not a closed-while-frozen spelling`)
        if (e.kind !== 'kill-switch' && frozenOnly) findings.push(`${key}: wrapper ${spec.wrapper} is closed only while frozen, which only a kill-switch may be`)
      }
    }
  }
  for (const key of byKey.keys()) {
    if (!used.has(key)) findings.push(`${key}: exception names no entry of that scope`)
  }
  return findings
}

/**
 * Ron N5: `closed` implies locked. The main-scope entries that fail closed but
 * whose script is not flagged `gate: true` in the sidecar (.claude/hooks.metadata.json,
 * read by the caller). Keyed by the script's file stem, the sidecar's `hook` field.
 */
export function closedButNotLocked(m: HookManifest, lockedHooks: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const e of m.entries) {
    if (!scopesOf(e).includes('main')) continue
    if (specFor(e, 'main').failMode !== 'closed') continue
    const stem = e.script.slice(e.script.lastIndexOf('/') + 1).replace(/\.[a-z]+$/, '')
    if (!lockedHooks.has(stem)) out.push(`${e.id}: fails closed on the main agent, but the sidecar does not mark ${stem} gate: true`)
  }
  return out
}
