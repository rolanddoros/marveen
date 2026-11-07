/**
 * C3-2: the hook manifest follows the fail-mode policy (docs/hook-fail-modes.md).
 *
 * Each manifest entry carries its role (`kind`); FAIL_MODE_POLICY says which
 * fail mode that role should have. The manifest's failMode is pinned to the
 * actual wrapper text by hook-manifest-main/sub tests, so this test compares
 * policy with what the settings really do. Today's departures are a named
 * exception list, recorded and not fixed here.
 *
 * Read-only: the tracked sidecar (.claude/hooks.metadata.json) and the doc of
 * THIS checkout, located from this file's own path. Nothing is written.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOOK_MANIFEST, specFor, type HookKind, type HookManifest, type HookManifestEntry } from '../web/hooks/manifest.js'
import {
  FAIL_MODE_EXCEPTIONS,
  FAIL_MODE_POLICY,
  closedButNotLocked,
  failModePolicyFindings,
  scopesOf,
} from '../web/hooks/fail-mode-policy.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SIDECAR_PATH = join(REPO_ROOT, '.claude', 'hooks.metadata.json')
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

/** Hook names the sidecar flags `gate: true` in every group that runs them. */
function sidecarLockedHooks(): Set<string> {
  const meta = JSON.parse(readFileSync(SIDECAR_PATH, 'utf-8')) as {
    hooks: Record<string, Array<{ hook: string; gate: boolean }>>
  }
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
      'fleet-freeze-gate (sub) open',
      'child-claude-channel-guard (sub) closed',
    ])
    // Without the list, the checker reports these two departures and nothing else.
    expect(failModePolicyFindings(HOOK_MANIFEST, [])).toEqual([
      'fleet-freeze-gate (sub): kind kill-switch should fail closed, the manifest records open, and no exception names it',
      'child-claude-channel-guard (sub): kind guard should fail open, the manifest records closed, and no exception names it',
    ])
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
    expect(failModePolicyFindings(HOOK_MANIFEST, [{ ...base[0], failMode: 'advisory' }, base[1]]))
      .toEqual(['fleet-freeze-gate (sub): the exception records advisory, the manifest records open'])
    expect(failModePolicyFindings(HOOK_MANIFEST, [...base, { id: 'email-approval-gate', scope: 'sub', failMode: 'open', reason: 'x' }]))
      .toEqual(['email-approval-gate (sub): exception names no entry of that scope'])
    expect(failModePolicyFindings(HOOK_MANIFEST, [...base, base[1]]))
      .toEqual(['child-claude-channel-guard (sub): listed twice as an exception'])
    expect(failModePolicyFindings(HOOK_MANIFEST, [base[0], { ...base[1], reason: ' ' }]))
      .toEqual(['child-claude-channel-guard (sub): exception without a reason'])
  })

  it('a hook that fails closed off PreToolUse', () => {
    const m = withEntries(replace('staleness-guard', { kind: 'security-gate', wrapper: 'failClosedRun', failMode: 'closed', override: undefined }))
    expect(failModePolicyFindings(m)).toEqual([
      'staleness-guard (main): fails closed on UserPromptSubmit; only PreToolUse may fail closed',
      'staleness-guard (sub): fails closed on UserPromptSubmit; only PreToolUse may fail closed',
    ])
  })

  it('closed while frozen is for the kill switch only, and the kill switch is closed only that way', () => {
    const gate = byId('egress-gate')
    const frozenGate = withEntries(replace('egress-gate', { wrapper: 'failOpenExecClosedWhenFrozen', override: { sub: gate.override!.sub } }))
    expect(failModePolicyFindings(frozenGate)).toEqual([
      'egress-gate (main): wrapper failOpenExecClosedWhenFrozen is closed only while frozen, which only a kill-switch may be',
    ])
    const freeze = byId('fleet-freeze-gate')
    const alwaysClosed = withEntries(replace('fleet-freeze-gate', { wrapper: 'failClosedRun', override: freeze.override }))
    expect(failModePolicyFindings(alwaysClosed)).toEqual([
      'fleet-freeze-gate (main): a kill-switch fails closed while frozen, but wrapper failClosedRun is not a closed-while-frozen spelling',
    ])
  })
})

describe('gate (sidecar) vs failMode (Ron N5)', () => {
  it('every hook that fails closed on the main agent is locked (gate: true) in the sidecar', () => {
    const locked = sidecarLockedHooks()
    expect(closedButNotLocked(HOOK_MANIFEST, locked)).toEqual([])
    const closedMain = entries.filter((e) => scopesOf(e).includes('main') && specFor(e, 'main').failMode === 'closed').map((e) => e.id)
    expect(closedMain.sort()).toEqual(['db-write-gate', 'egress-gate', 'email-approval-gate', 'fleet-freeze-gate', 'outgoing-copy-gate'])
  })

  it('locked does not imply closed: 16 locked hooks, 11 of them fail open', () => {
    const locked = sidecarLockedHooks()
    expect(locked.size).toBe(16)
    const openLocked = entries.filter((e) => scopesOf(e).includes('main') && locked.has(e.id) && specFor(e, 'main').failMode === 'open')
    expect(openLocked.map((e) => e.id).sort()).toEqual([
      'child-claude-channel-guard', 'ledger-capture', 'ledger-outbound', 'ledger-turn-failure', 'memory-frontmatter-bash-gate',
      'memory-frontmatter-gate', 'provenance-gate', 'shell-rescan-guard', 'staleness-guard', 'telegram-reply-guard', 'token-argv-guard',
    ])
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
