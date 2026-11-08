/**
 * C3-2: the hook manifest follows the fail-mode policy (docs/hook-fail-modes.md).
 *
 * Each manifest entry carries its role (`kind`); FAIL_MODE_POLICY says which
 * fail mode that role should have. The manifest's failMode is pinned to the
 * actual wrapper text by hook-manifest-main/sub tests, so this test compares
 * policy with what the settings really do. Today's departures are a named
 * exception list, recorded and not fixed here.
 *
 * Read-only: the doc and the hook lock list (hook_switches.py) of THIS
 * checkout, located from this file's own path. The sidecar's gate flags come
 * from the GENERATED sidecar (C3-4, Ron N5), not from a hand list; the
 * committed file equals it (hook-main-artifact.test.ts). Nothing is written.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readHookSwitchLocks, renderMainSidecar } from '../web/hooks/main-artifact.js'
import { HOOK_MANIFEST, specFor, type HookKind, type HookManifest, type HookManifestEntry } from '../web/hooks/manifest.js'
import {
  FAIL_MODE_EXCEPTIONS,
  FAIL_MODE_POLICY,
  WRAPPER_FAIL_MODE,
  closedButNotLocked,
  failModePolicyFindings,
  scopesOf,
} from '../web/hooks/fail-mode-policy.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOC_PATH = join(REPO_ROOT, 'docs', 'hook-fail-modes.md')

const entries = HOOK_MANIFEST.entries
const withEntries = (es: readonly HookManifestEntry[]): HookManifest => ({ entries: es, layout: HOOK_MANIFEST.layout })
const replace = (id: string, patch: Partial<HookManifestEntry>): HookManifestEntry[] =>
  entries.map((e) => (e.id === id ? { ...e, ...patch } : e))
const byId = (id: string): HookManifestEntry => {
  const e = entries.find((x) => x.id === id)
  if (!e) throw new Error(`no manifest entry ${id}`)
  return e
}

/** Hook names the generated sidecar flags `gate: true` in every group that runs them. */
function sidecarLockedHooks(): Set<string> {
  const meta = renderMainSidecar(HOOK_MANIFEST, readHookSwitchLocks(REPO_ROOT))
  const flags = new Map<string, boolean>()
  for (const groups of Object.values(meta.hooks)) {
    for (const g of groups) flags.set(g.hook, (flags.get(g.hook) ?? true) && g.gate === true)
  }
  return new Set([...flags].filter(([, locked]) => locked).map(([name]) => name))
}

describe('hook fail-mode policy', () => {
  it('every entry follows the policy of its kind, except the named exceptions', () => {
    expect(failModePolicyFindings(HOOK_MANIFEST)).toEqual([])
  })

  it('the exception list is exactly today\'s measured departures', () => {
    expect(FAIL_MODE_EXCEPTIONS.map((x) => `${x.id} (${x.scope}) ${x.failMode}`)).toEqual([
      'child-claude-channel-guard (sub) closed',
    ])
    // Without the list, the checker reports this one departure and nothing else.
    expect(failModePolicyFindings(HOOK_MANIFEST, [])).toEqual([
      'child-claude-channel-guard (sub): kind guard should fail open, the manifest records closed, and no exception names it',
    ])
  })

  // Owner decision 3 (Roland, 2026-11-08): the kill switch is closed while frozen in both scopes, so its former
  // sub-agent exception is gone, and putting it back is a stale row.
  it('the fleet-freeze-gate is closed while frozen on the sub-agents too; its old exception row is stale', () => {
    const freeze = byId('fleet-freeze-gate')
    expect([specFor(freeze, 'main'), specFor(freeze, 'sub')].map((s) => [s.wrapper, s.failMode])).toEqual([
      ['failOpenExecClosedWhenFrozen', 'closed'], ['failOpenExecClosedWhenFrozen', 'closed'],
    ])
    expect(failModePolicyFindings(HOOK_MANIFEST, [...FAIL_MODE_EXCEPTIONS, { id: 'fleet-freeze-gate', scope: 'sub', failMode: 'open', reason: 'x' }]))
      .toEqual(['fleet-freeze-gate (sub): stale exception, the manifest now records closed as the policy of kill-switch says; remove the row'])
  })

  it('every entry has a kind the policy knows, in each scope it belongs to (main 41, sub 43)', () => {
    const kinds = new Set(Object.keys(FAIL_MODE_POLICY))
    for (const e of entries) expect(kinds.has(e.kind), e.id).toBe(true)
    expect(entries.filter((e) => scopesOf(e).includes('main'))).toHaveLength(41)
    expect(entries.filter((e) => scopesOf(e).includes('sub'))).toHaveLength(43)
  })

  it('the roles named in the audit sit where the plan puts them', () => {
    // The gates the audit (hooks-gates.md 5.5) lists as fail-closed, the kill
    // switch, and the hooks whose name says gate or guard but whose role is not.
    const expected: Record<string, HookKind> = {
      'egress-gate': 'security-gate',
      'email-send-gate': 'security-gate',
      'self-pace-gate': 'security-gate',
      'outgoing-copy-gate': 'security-gate',
      'bash-egress-parser': 'security-gate',
      'fleet-freeze-gate': 'kill-switch',
      'memory-frontmatter-gate': 'guard',
      'memory-frontmatter-bash-gate': 'guard',
      'child-claude-channel-guard': 'guard',
      'shell-rescan-guard': 'guard',
      'token-argv-guard': 'guard',
      'provenance-gate': 'directive',
      'staleness-guard': 'directive',
      'telegram-reply-guard': 'enforcer',
      'precompact': 'prompt',
    }
    for (const [id, kind] of Object.entries(expected)) expect(byId(id).kind, id).toBe(kind)
  })
})

describe('the policy checker catches each kind of departure', () => {
  it('a kind whose policy differs from the recorded fail mode', () => {
    expect(failModePolicyFindings(withEntries(replace('egress-gate', { kind: 'guard' })))).toEqual([
      'egress-gate (main): kind guard should fail open, the manifest records closed, and no exception names it',
      'egress-gate (sub): kind guard should fail open, the manifest records closed, and no exception names it',
    ])
  })

  it('a stale exception, a wrong recorded fail mode, an exception naming nothing, a duplicate, an empty reason', () => {
    const base = [...FAIL_MODE_EXCEPTIONS]
    expect(failModePolicyFindings(HOOK_MANIFEST, [...base, { id: 'egress-gate', scope: 'main', failMode: 'open', reason: 'x' }]))
      .toEqual(['egress-gate (main): stale exception, the manifest now records closed as the policy of security-gate says; remove the row'])
    expect(failModePolicyFindings(HOOK_MANIFEST, [{ ...base[0], failMode: 'advisory' }]))
      .toEqual(['child-claude-channel-guard (sub): the exception records advisory, the manifest records closed'])
    expect(failModePolicyFindings(HOOK_MANIFEST, [...base, { id: 'email-approval-gate', scope: 'sub', failMode: 'open', reason: 'x' }]))
      .toEqual(['email-approval-gate (sub): exception names no entry of that scope'])
    expect(failModePolicyFindings(HOOK_MANIFEST, [...base, base[0]]))
      .toEqual(['child-claude-channel-guard (sub): listed twice as an exception'])
    expect(failModePolicyFindings(HOOK_MANIFEST, [{ ...base[0], reason: ' ' }]))
      .toEqual(['child-claude-channel-guard (sub): exception without a reason'])
  })

  it('a hook that fails closed off PreToolUse', () => {
    const m = withEntries(replace('staleness-guard', { kind: 'security-gate', wrapper: 'failClosed', failMode: 'closed', override: undefined }))
    expect(failModePolicyFindings(m)).toEqual([
      'staleness-guard (main): fails closed on UserPromptSubmit; only PreToolUse may fail closed',
      'staleness-guard (sub): fails closed on UserPromptSubmit; only PreToolUse may fail closed',
    ])
  })

  it('closed while frozen is for the kill switch only, and the kill switch is closed only that way', () => {
    const frozenGate = withEntries(replace('egress-gate', { wrapper: 'failOpenExecClosedWhenFrozen', override: { sub: { wrapper: 'failClosed' } } }))
    expect(failModePolicyFindings(frozenGate)).toEqual([
      'egress-gate (main): wrapper failOpenExecClosedWhenFrozen is closed only while frozen, which only a kill-switch may be',
    ])
    // Both scopes since owner decision 3: an always-closed wrapper on the kill switch is caught in each.
    const alwaysClosed = withEntries(replace('fleet-freeze-gate', { wrapper: 'failClosed' }))
    expect(failModePolicyFindings(alwaysClosed)).toEqual([
      'fleet-freeze-gate (main): a kill-switch fails closed while frozen, but wrapper failClosed is not a closed-while-frozen spelling',
      'fleet-freeze-gate (sub): a kill-switch fails closed while frozen, but wrapper failClosed is not a closed-while-frozen spelling',
    ])
  })

  // C3-5: one wrapper spelling per fail mode, so the wrapper and the failMode recorded next to it cannot disagree.
  it('every wrapper spells its own fail mode: an open entry on failClosed, a closed one on failOpenExec, a prompt on either', () => {
    expect(Object.entries(WRAPPER_FAIL_MODE)).toEqual([
      ['failOpenExec', 'open'], ['failClosed', 'closed'], ['failOpenExecClosedWhenFrozen', 'closed'], ['agentPrompt', 'advisory'],
    ])
    const openOnClosed = withEntries(replace('staleness-guard', { wrapper: 'failClosed' }))
    expect(failModePolicyFindings(openOnClosed)).toEqual([
      'staleness-guard (main): wrapper failClosed does not spell fail mode open',
      'staleness-guard (sub): wrapper failClosed does not spell fail mode open',
    ])
    const closedOnOpen = withEntries(replace('db-write-gate', { wrapper: 'failOpenExec' }))
    expect(failModePolicyFindings(closedOnOpen)).toEqual([
      'db-write-gate (main): wrapper failOpenExec does not spell fail mode closed',
      'db-write-gate (sub): wrapper failOpenExec does not spell fail mode closed',
    ])
    const promptAsCommand = withEntries(replace('precompact', { wrapper: 'failOpenExec' }))
    expect(failModePolicyFindings(promptAsCommand)).toEqual(['precompact (sub): wrapper failOpenExec does not spell fail mode advisory'])
    // A scope override of the wrapper alone is caught in that scope only.
    const subOnly = withEntries(replace('token-argv-guard', { override: { sub: { wrapper: 'failClosed' } } }))
    expect(failModePolicyFindings(subOnly)).toEqual(['token-argv-guard (sub): wrapper failClosed does not spell fail mode open'])
  })
})

describe('gate (sidecar) vs failMode (Ron N5)', () => {
  it('every hook that fails closed on the main agent is locked (gate: true) in the sidecar', () => {
    const locked = sidecarLockedHooks()
    expect(closedButNotLocked(HOOK_MANIFEST, locked)).toEqual([])
    const closedMain = entries.filter((e) => scopesOf(e).includes('main') && specFor(e, 'main').failMode === 'closed').map((e) => e.id)
    expect(closedMain.sort()).toEqual(['db-write-gate', 'egress-gate', 'email-approval-gate', 'fleet-freeze-gate', 'outgoing-copy-gate'])
  })

  it('locked does not imply closed: the generated sidecar locks hooks that fail open', () => {
    // No pinned count or list (Ron N5): the gate flags follow hook_switches, so a
    // new lock needs no edit here. What stays pinned is the definition: a lock
    // (cannot be env-disabled) is not a fail mode.
    const locked = sidecarLockedHooks()
    const openLocked = entries.filter((e) => scopesOf(e).includes('main') && locked.has(e.id) && specFor(e, 'main').failMode === 'open')
    expect(openLocked.length).toBeGreaterThan(0)
    expect(openLocked.map((e) => e.id)).toContain('ledger-capture')
  })

  it('reports a closed hook the sidecar does not lock', () => {
    const locked = sidecarLockedHooks()
    locked.delete('egress-gate')
    expect(closedButNotLocked(HOOK_MANIFEST, locked)).toEqual([
      'egress-gate: fails closed on the main agent, but the sidecar does not mark egress-gate gate: true',
    ])
  })
})

describe('docs/hook-fail-modes.md', () => {
  const doc = readFileSync(DOC_PATH, 'utf-8')

  it('has one rule row per kind, the same kinds as the policy, with the policy\'s fail mode', () => {
    // Two-way: a kind missing from the doc, an extra or renamed kind row, or a
    // row with another fail mode all fail. A rule row is `| \`kind\` | \`mode\` |`;
    // the exception table's second column is a bare scope, so it never matches.
    const rows = [...doc.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|/gm)].map((m) => [m[1], m[2]] as const)
    expect(rows.map(([kind]) => kind).sort()).toEqual(Object.keys(FAIL_MODE_POLICY).sort())
    expect(Object.fromEntries(rows)).toEqual(FAIL_MODE_POLICY)
  })

  it('names every exception with its scope', () => {
    for (const x of FAIL_MODE_EXCEPTIONS) {
      expect(doc, x.id).toMatch(new RegExp(`^\\| \`${x.id}\` \\| ${x.scope} \\| \`${x.failMode}\` \\|`, 'm'))
    }
  })
})
