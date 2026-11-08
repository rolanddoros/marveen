/**
 * C3-3a: the sub-agent settings generator (src/web/hooks/sub-generator.ts).
 *
 * 1. The 12 live sub-agent hooks blocks (lossless, anonymised fixture, read
 *    2026-11-08): the generator keeps every one's flattened multiset (the C3-3b
 *    gate), keeps the hand-added playwright hook on the five that carry it with
 *    its own timeout, converges on ONE layout (the manifest's), and is a fixpoint.
 * 2. The rules it inherits from the injectors and ensure* migrations, one case each.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOOK_NODE_BIN, injectWebSearchEnvelope, isUnsafeHookCommand } from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'
import { HOOK_MANIFEST, renderHooks, type RenderContext } from '../web/hooks/manifest.js'
import { generateSubHooks, type SubHookInputs } from '../web/hooks/sub-generator.js'
import { pairRewraps, type PlacedHook } from '../web/hooks/dry-run.js'

type Hook = Record<string, unknown>
type Group = { matcher?: string; hooks: Hook[] }
type Block = Record<string, Group[]>

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'hooks', '__fixtures__', 'live-sub-hooks.12.json')
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as {
  hooks: Hook[]
  agents: Record<string, { sha256: string; events: Record<string, Array<{ matcher?: string; hooks: number[] }>> }>
}
const PLAYWRIGHT = 'mcp__playwright__browser_.*'

function rebuild(name: string): Block {
  const out: Block = {}
  for (const [event, groups] of Object.entries(fixture.agents[name].events)) {
    out[event] = groups.map((g) => ({ ...g, hooks: g.hooks.map((i) => fixture.hooks[i]) }))
  }
  return out
}
/** The sanitised block on this checkout: its root and node binary. */
const onThisCheckout = (b: Block): Block => JSON.parse(JSON.stringify(b).replaceAll('${ROOT}', PROJECT_ROOT).replaceAll('${NODE_BIN}', HOOK_NODE_BIN))

const inputs = (over: Partial<SubHookInputs> = {}): SubHookInputs => ({
  root: PROJECT_ROOT, nodeBin: HOOK_NODE_BIN, profile: {}, agent: {}, prompts: { precompact: 'TEMPLATE PROMPT' },
  isUnsafe: isUnsafeHookCommand, ...over,
})
const flat = (b: Record<string, unknown>): string[] => Object.entries(b).flatMap(([event, groups]) => (groups as Group[])
  .flatMap((g) => g.hooks.map((h) => { const o = { event, ...(g.matcher === undefined ? {} : { matcher: g.matcher }), ...h }; return JSON.stringify(o, Object.keys(o).sort()) }))).sort()
/** The settings dry-run's own comparison: the multiset difference, then its one-to-one rewrap pairing. */
function rewrapDiff(before: Record<string, unknown>, after: Record<string, unknown>): ReturnType<typeof pairRewraps> {
  const placed = (b: Record<string, unknown>): PlacedHook[] => Object.entries(b).flatMap(([event, groups]) => (groups as Group[])
    .flatMap((g) => g.hooks.map((hook) => ({ event, ...(g.matcher === undefined ? {} : { matcher: g.matcher }), hook }))))
  const key = (p: PlacedHook) => { const o = { event: p.event, matcher: p.matcher, ...p.hook }; return JSON.stringify(o, Object.keys(o).sort()) }
  const minus = (xs: PlacedHook[], ys: PlacedHook[]) => {
    const left = ys.map(key)
    return xs.filter((x) => { const i = left.indexOf(key(x)); if (i < 0) return true; left.splice(i, 1); return false })
  }
  const [b, a] = [placed(before), placed(after)]
  return pairRewraps(minus(b, a), minus(a, b))
}
const json = (x: unknown) => JSON.stringify(x, null, 2)
const withoutPlaywright = (b: Record<string, unknown>) => JSON.parse(JSON.stringify(b, (_k, v) => (Array.isArray(v) ? v.filter((g) => g?.matcher !== PLAYWRIGHT) : v)))

describe('the 12 live sub-agent hooks blocks (fixture)', () => {
  const names = Object.keys(fixture.agents)

  it('rebuilds every block exactly (sha256 of the sanitised live block)', () => {
    expect(names).toHaveLength(12)
    for (const n of names) expect(createHash('sha256').update(JSON.stringify(rebuild(n))).digest('hex')).toBe(fixture.agents[n].sha256)
  })

  it('five carry the hand-added playwright hook: two without a timeout, three with 10', () => {
    const timeouts = names.flatMap((n) => (rebuild(n).PostToolUse ?? []).filter((g) => g.matcher === PLAYWRIGHT).map((g) => String(g.hooks[0].timeout)))
    expect(timeouts.sort()).toEqual(['10', '10', '10', 'undefined', 'undefined'])
  })

  for (const n of names) {
    // The fixture is the pre-C3-5 shape: the generator's output differs from it only by the window's 32 rewraps
    // (plan-c3-5.md 3a), nothing added or dropped.
    it(`${n}: rewrap only (32), playwright kept as is, manifest layout, fixpoint`, () => {
      const current = onThisCheckout(rebuild(n))
      const plan = generateSubHooks(current, inputs())
      const r = rewrapDiff(current, plan.hooks)
      expect([r.pairs.length, r.dropped.length, r.added.length]).toEqual([32, 0, 0])
      const pw = (current.PostToolUse ?? []).filter((g) => g.matcher === PLAYWRIGHT)
      expect(plan.kept.map((k) => k.matcher)).toEqual(pw.map(() => PLAYWRIGHT))
      expect((plan.hooks.PostToolUse ?? []).slice(-pw.length || undefined).filter((g) => g.matcher === PLAYWRIGHT)).toEqual(pw)
      // Everything but the kept hook is the manifest's render, with the agent's own PreCompact prompt.
      const prompt = String(current.PreCompact[0].hooks[0].prompt)
      expect(json(withoutPlaywright(plan.hooks))).toBe(json(renderHooks(HOOK_MANIFEST, 'sub', { ...inputs(), prompts: { precompact: prompt } })))
      expect(json(generateSubHooks(plan.hooks, inputs()).hooks)).toBe(json(plan.hooks))
      expect(plan.unsafe).toEqual([])
    })
  }
})

// A default agent's block as the generator writes it: the starting point of the rule cases.
const base = (): Block => JSON.parse(json(generateSubHooks({}, inputs()).hooks))
const gen = (current: unknown, over: Partial<SubHookInputs> = {}) => generateSubHooks(current, inputs(over)).hooks as Block
const groupsOf = (b: Block, event: string, file: string) => (b[event] ?? []).filter((g) => JSON.stringify(g).includes(file))

describe('the rules the generator inherits', () => {
  it('a legacy spelling, a stale matcher and a stale node path all come back canonical, once', () => {
    const b = base()
    const ups = b.UserPromptSubmit[0].hooks
    const i = ups.findIndex((h) => String(h.command).includes('staleness-guard.py'))
    ups[i] = { type: 'command', command: `python3 ${PROJECT_ROOT}/scripts/hooks/staleness-guard.py`, timeout: 10 }
    groupsOf(b, 'PreToolUse', 'email-send-gate.mjs')[0].matcher = 'Bash'
    const db = groupsOf(b, 'PreToolUse', 'db-write-gate.mjs')[0].hooks[0]
    db.command = String(db.command).replaceAll(HOOK_NODE_BIN, '/old/bin/node')
    expect(json(gen(b))).toBe(json(base()))
  })

  it('the thread-reply capability adds the flag, and taking it away removes it', () => {
    const on = gen(base(), { agent: { threadReply: true } })
    expect(JSON.stringify(groupsOf(on, 'PreToolUse', 'email-send-gate.mjs'))).toContain('email-send-gate.mjs\\" --allow-thread-reply')
    expect(json(gen(on))).toBe(json(base()))
  })

  it('second reviewer and sender-role gate: off removes them (offRemoves)', () => {
    const on = gen(base(), { profile: { secondReviewer: true }, agent: { senderRolePolicy: 'eyJyIjoxfQ' } })
    expect(groupsOf(on, 'PreToolUse', 'second-reviewer-gate.py')).toHaveLength(1)
    expect(groupsOf(on, 'PreToolUse', 'sender-role-gate.py')).toHaveLength(1)
    expect(json(gen(on))).toBe(json(base()))
  })

  it('destructive, credential and the heartbeat gates: off keeps an existing copy as it is, and adds none', () => {
    const on = gen(base(), { profile: { destructiveGate: true, credentialGate: true }, agent: { heartbeat: true } })
    for (const f of ['destructive-gate.py', 'credential-gate.py', 'kanban-write-gate.mjs', 'digest-provenance-gate.mjs']) expect(groupsOf(on, 'PreToolUse', f)).toHaveLength(1)
    groupsOf(on, 'PreToolUse', 'destructive-gate.py')[0].matcher = 'Bash'
    const off = gen(on)
    expect(flat(off)).toEqual(flat(on))
    expect(groupsOf(off, 'PreToolUse', 'destructive-gate.py')[0].matcher).toBe('Bash')
    expect(json(gen({}))).toBe(json(base()))
  })

  it("an operator's hook stays, also inside a group with a gate; the gate's script under a foreign matcher stays too", () => {
    const b = base()
    const own = { type: 'command', command: 'echo mine', timeout: 3 }
    groupsOf(b, 'PreToolUse', 'email-send-gate.mjs')[0].hooks.push(own)
    const copyUnderBash = { matcher: 'Bash', hooks: [groupsOf(b, 'PreToolUse', 'outgoing-copy-gate.py')[0].hooks[0]] }
    b.PreToolUse.push(copyUnderBash)
    b.Notification = [{ hooks: [own] }]
    const out = gen(b)
    expect(flat(out)).toEqual(flat(b))
    const email = groupsOf(out, 'PreToolUse', 'email-send-gate.mjs')
    expect(email).toHaveLength(1)
    expect(out.PreToolUse.slice(-2)).toEqual([{ matcher: email[0].matcher, hooks: [own] }, copyUnderBash])
    expect(out.Notification).toEqual([{ hooks: [own] }])
  })

  it('the envelope rule matches injectWebSearchEnvelope: covered by an operator group, the managed one goes or narrows', () => {
    const script = `python3 "${PROJECT_ROOT}/scripts/hooks/browser-content-notice.py"`
    for (const matcher of ['*', 'WebSearch|mcp__x__y', 'mcp__x__.*|WebFetch', 'mcp__x__y']) {
      const b = base()
      b.PostToolUse.push({ matcher, hooks: [{ type: 'command', command: script }] })
      const viaInjector = { hooks: JSON.parse(json(b)) as Block }
      injectWebSearchEnvelope(viaInjector)
      const envelope = (x: Block) => flat({ PostToolUse: x.PostToolUse.filter((g) => JSON.stringify(g).includes('browser-content-notice.py')) })
      expect(envelope(gen(b))).toEqual(envelope(viaInjector.hooks))
    }
  })

  it('install-local extras go last, and leave again when the file drops them', () => {
    const extra = { event: 'PreToolUse', matcher: 'Bash', command: ': extra-hook; /opt/x/local-hooks/a.sh', timeout: 5 }
    const withExtra = gen(base(), { extras: [extra] })
    expect(withExtra.PreToolUse.at(-1)).toEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: extra.command, timeout: 5 }] })
    expect(json(gen(withExtra))).toBe(json(base()))
  })

  it('the registration guard: a refused command is not rendered and its existing copy stays as it is', () => {
    const b = base()
    const egress = groupsOf(b, 'PreToolUse', 'egress-gate.mjs')[0]
    egress.hooks[0] = { ...egress.hooks[0], timeout: 99 }
    const plan = generateSubHooks(b, inputs({ isUnsafe: (c) => c.includes('egress-gate.mjs') || isUnsafeHookCommand(c) }))
    expect(plan.unsafe).toEqual(['egress-gate'])
    expect(groupsOf(plan.hooks as Block, 'PreToolUse', 'egress-gate.mjs')).toEqual([egress])
  })

  it('the browser capability renders the playwright hook and adopts a hand-added copy', () => {
    const b = base()
    b.PostToolUse.push({ matcher: PLAYWRIGHT, hooks: [{ type: 'command', command: `python3 ${PROJECT_ROOT}/scripts/hooks/browser-content-notice.py` }] })
    const out = gen(b, { agent: { browser: true } })
    const p = `${PROJECT_ROOT}/scripts/hooks/browser-content-notice.py`
    expect(out.PostToolUse.filter((g) => g.matcher === PLAYWRIGHT)).toEqual([
      { matcher: PLAYWRIGHT, hooks: [{ type: 'command', command: `bash -c '[ -f "${p}" ] && exec python3 "${p}"; exit 0'`, timeout: 10 }] },
    ])
  })

  it('PreCompact: the agent\'s own prompt stays, a missing one is the given one; a malformed event refuses', () => {
    const b = base()
    b.PreCompact[0].hooks[0].prompt = 'EDITED'
    expect(gen(b).PreCompact[0].hooks[0].prompt).toBe('EDITED')
    expect(gen(null).PreCompact[0].hooks[0].prompt).toBe('TEMPLATE PROMPT')
    expect(() => generateSubHooks({ PreToolUse: {} }, inputs())).toThrow(/is not a list/)
  })

  it('a node binary or root the render refuses throws (the caller leaves the file as it is)', () => {
    expect(() => generateSubHooks(base(), inputs({ nodeBin: '/bin/no"de' } as Partial<RenderContext>))).toThrow(/ctx.nodeBin must be/)
    expect(() => generateSubHooks(base(), inputs({ root: '/opt/mar veen' }))).toThrow(/ctx.root must be/)
  })
})
