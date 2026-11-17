// The sub-agent hook lock (Fork C settings-protect addendum 1 D2-SEC-1 (b), Ron 17402 K1): the committed lock is the
// manifest's sub render, its own sha256 is checked, and the block the standalone verifier assembles from it equals
// the manifest's render for every switch combination and for both live fixtures.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOOK_NODE_BIN, isUnsafeHookCommand } from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'
import { HOOK_MANIFEST, renderHooks, type HookManifest, type RenderContext } from '../web/hooks/manifest.js'
import { generateSubHooks } from '../web/hooks/sub-generator.js'
import { pairRewraps, type PlacedHook } from '../web/hooks/dry-run.js'
// @ts-expect-error -- plain .mjs hook module, no types
import { parseLock, expectedHooks, lockSha256, PLACEHOLDERS, PROFILE_FLAGS } from '../../scripts/hooks/sub-hooks-lock.mjs'

type Hook = Record<string, unknown>
// scripts/ is outside src's rootDir: the generator is imported at run time, as hook-main-artifact-write-fail.test.ts does.
type LockCli = {
  buildLock: (m?: HookManifest) => Record<string, unknown>
  renderLockText: (m?: HookManifest) => string
  runGenerateSubHooksLock: (argv: readonly string[], out?: (l: string) => void, err?: (l: string) => void) => number
  LOCK_REL: string
}
type Group = { matcher?: string; hooks: Hook[] }
type Block = Record<string, Group[]>

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const { buildLock, renderLockText, runGenerateSubHooksLock, LOCK_REL } = (await import(join(REPO, 'scripts', 'generate-sub-hooks-lock.ts'))) as LockCli
const FIXTURES = join(REPO, 'src', 'web', 'hooks', '__fixtures__')
const lockText = () => readFileSync(join(REPO, LOCK_REL), 'utf-8')
const json = (x: unknown) => JSON.stringify(x, null, 2)
const ROOT = '/srv/marveen-inst'
const NODE = '/usr/local/bin/node'
const POLICY = 'eyJyb2xlIjoieCJ9'
const PROMPT = 'the agent\'s own PreCompact prompt'

type Switches = { profile: Record<string, boolean>; heartbeat: boolean; browser: boolean; threadReply: boolean; senderRolePolicy: string | null }
function* combinations(): Generator<Switches> {
  for (let bits = 0; bits < 128; bits++) {
    const b = (i: number) => (bits & (1 << i)) !== 0
    yield {
      profile: { destructiveGate: b(0), credentialGate: b(1), secondReviewer: b(2) },
      heartbeat: b(3), browser: b(4), threadReply: b(5), senderRolePolicy: b(6) ? POLICY : null,
    }
  }
}
const renderCtx = (s: Switches, over: Partial<RenderContext> = {}): RenderContext => ({
  root: ROOT, nodeBin: NODE, profile: s.profile,
  agent: { heartbeat: s.heartbeat, browser: s.browser, threadReply: s.threadReply, senderRolePolicy: s.senderRolePolicy },
  prompts: { precompact: PROMPT }, ...over,
})
const fromLock = (s: Switches, over: Record<string, unknown> = {}) => expectedHooks(parseLock(lockText()), { root: ROOT, nodeBin: NODE, precompact: PROMPT, ...s, ...over })

describe('the committed lock is the manifest\'s sub render', () => {
  it('equals the generator\'s output (a manifest change without `npm run hooks:lock` is red) and --check agrees', () => {
    expect(lockText()).toBe(renderLockText())
    const out: string[] = []
    const err: string[] = []
    expect(runGenerateSubHooksLock(['--check'], (l) => out.push(l), (l) => err.push(l))).toBe(0)
    expect(err).toEqual([])
  })
  it('keeps the placeholders unexpanded: no absolute install path or node binary in it', () => {
    const t = lockText()
    for (const p of Object.values(PLACEHOLDERS) as string[]) expect(t).toContain(p)
    expect(t).not.toContain(PROJECT_ROOT)
    expect(t).not.toContain(HOOK_NODE_BIN)
    expect(t).not.toMatch(/\/root\/|\/Users\//)
  })
  it('refuses the live install', () => {
    const err: string[] = []
    expect(runGenerateSubHooksLock(['--root', '/root/marveen'], () => {}, (l) => err.push(l))).toBe(2)
    expect(err.join('\n')).toContain('refusing')
  })
})

describe('the verifier\'s assembly equals renderHooks for every switch combination', () => {
  it('128 combinations: 3 profile switches x heartbeat x browser x threadReply x sender-role policy', () => {
    let n = 0
    for (const s of combinations()) {
      expect(json(fromLock(s)), JSON.stringify(s)).toBe(json(renderHooks(HOOK_MANIFEST, 'sub', renderCtx(s))))
      n++
    }
    expect(n).toBe(128)
    expect([...PROFILE_FLAGS]).toEqual(['destructiveGate', 'credentialGate', 'secondReviewer'])
  })
  it('with a skip set (the generator\'s registration guard), including the first id of a multi-id slot', () => {
    const multi = HOOK_MANIFEST.layout.sub!.PreToolUse!.find((s) => typeof s !== 'string' && s.length > 1) as readonly string[] | undefined
    const skip = new Set(['tool-log-capture', ...(multi ? [multi[0]] : [])])
    const s = [...combinations()][127]
    expect(json(fromLock(s, { skip }))).toBe(json(renderHooks(HOOK_MANIFEST, 'sub', renderCtx(s, { skip }))))
  })
})

describe('parseLock and expectedHooks refuse what they cannot trust', () => {
  it('a lock whose content changed but not its sha256 is refused (K1: the agent does not start)', () => {
    const lock = JSON.parse(lockText())
    lock.entries['email-send-gate'].hook.command += ' --allow-thread-reply'
    expect(() => parseLock(JSON.stringify(lock))).toThrow('sha256 does not match its content')
    lock.sha256 = lockSha256(lock)
    expect(() => parseLock(JSON.stringify(lock))).not.toThrow()
  })
  it('a missing or malformed sha256, an unknown format, a slot naming no entry, not JSON', () => {
    const base = JSON.parse(lockText())
    const resealed = (f: (l: Record<string, any>) => void) => { const l = JSON.parse(JSON.stringify(base)); f(l); l.sha256 = lockSha256(l); return JSON.stringify(l) }
    expect(() => parseLock(JSON.stringify({ ...base, sha256: undefined }))).toThrow('no sha256')
    expect(() => parseLock(resealed((l) => { l.format = 'x' }))).toThrow('unknown format')
    expect(() => parseLock(resealed((l) => { l.layout[0][1].push(['no-such-entry']) }))).toThrow('unknown entry')
    expect(() => parseLock(resealed((l) => { l.entries['destructive-gate'].profileFlag = 'other' }))).toThrow('unknown profile flag')
    expect(() => parseLock('{')).toThrow('not JSON')
  })
  it('a root, node binary or policy that would break quoting or form a placeholder is refused', () => {
    const s = [...combinations()][64]
    for (const over of [{ root: 'relative/root' }, { root: '/a/${NODE_BIN}' }, { root: '/a"b' }, { nodeBin: '/a/`x`' }, { nodeBin: '' }, { senderRolePolicy: 'a b' }]) {
      expect(() => fromLock(s, over), JSON.stringify(over)).toThrow()
    }
  })
  it('a PreCompact prompt with $$, $&, $` or $\' lands verbatim, equal to renderHooks (Ron 17563, blocker 1)', () => {
    const s = [...combinations()][0]
    for (const prompt of ['costs $$5', 'a $& b', 'a $` b', 'a $\' b', '$$ $& $` $\' ${PRECOMPACT_PROMPT}']) {
      const block = fromLock(s, { precompact: prompt }) as Block
      expect(block.PreCompact?.[0]?.hooks?.[0]?.prompt, prompt).toBe(prompt)
      expect(json(block), prompt).toBe(json(renderHooks(HOOK_MANIFEST, 'sub', renderCtx(s, { prompts: { precompact: prompt } }))))
    }
  })
})

describe('synthetic locks: the slot rules the real lock may not exercise', () => {
  const sealed = (body: Record<string, unknown>) => JSON.stringify({ ...body, sha256: lockSha256(body) })
  const SW = { root: '/srv/m', nodeBin: '/usr/bin/node', profile: {}, heartbeat: false, browser: false, threadReply: false, senderRolePolicy: null }
  it('a slot takes the matchers of its first ACTIVE id, not of its first listed id', () => {
    const lock = parseLock(sealed({
      format: 'marveen-sub-hooks-lock/v1',
      layout: [['PreToolUse', [['a', 'b']]]],
      entries: {
        a: { profileFlag: 'destructiveGate', matchers: ['Bash'], hook: { type: 'command', command: 'a' } },
        b: { matchers: ['Write', 'Edit'], hook: { type: 'command', command: 'b' } },
      },
    }))
    expect(expectedHooks(lock, SW)).toEqual({ PreToolUse: [
      { matcher: 'Write', hooks: [{ type: 'command', command: 'b' }] },
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'b' }] },
    ] })
    expect(expectedHooks(lock, { ...SW, profile: { destructiveGate: true } }).PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] },
    ])
  })
  it('an entry with an unknown agent flag or profile flag is refused, sha256 or not', () => {
    const base = { format: 'marveen-sub-hooks-lock/v1', layout: [['Stop', [['a']]]] }
    expect(() => parseLock(sealed({ ...base, entries: { a: { agentFlag: 'nope', matchers: [null], hook: {} } } }))).toThrow('entry a has an unknown agent flag')
    expect(() => parseLock(sealed({ ...base, entries: { a: { profileFlag: 'nope', matchers: [null], hook: {} } } }))).toThrow('entry a has an unknown profile flag')
  })
})

describe('both live fixtures (K1: every variant the verifier checks)', () => {
  const inputs = { root: PROJECT_ROOT, nodeBin: HOOK_NODE_BIN, profile: {}, agent: {}, isUnsafe: isUnsafeHookCommand }
  const off: Switches = { profile: {}, heartbeat: false, browser: false, threadReply: false, senderRolePolicy: null }
  const lockFor = (prompt: string) => expectedHooks(parseLock(lockText()), { ...off, root: PROJECT_ROOT, nodeBin: HOOK_NODE_BIN, precompact: prompt })

  it('live-sub-hooks.12.json: each of the 12 agents, regenerated, is the lock\'s block apart from its kept hand-added hooks', () => {
    const f = JSON.parse(readFileSync(join(FIXTURES, 'live-sub-hooks.12.json'), 'utf-8')) as { hooks: Hook[]; agents: Record<string, { events: Record<string, Array<{ matcher?: string; hooks: number[] }>> }> }
    const names = Object.keys(f.agents)
    expect(names).toHaveLength(12)
    for (const n of names) {
      const block: Block = {}
      for (const [event, groups] of Object.entries(f.agents[n].events)) block[event] = groups.map((g) => ({ ...g, hooks: g.hooks.map((i) => f.hooks[i]) }))
      const current = JSON.parse(JSON.stringify(block).replaceAll('${ROOT}', PROJECT_ROOT).replaceAll('${NODE_BIN}', HOOK_NODE_BIN)) as Block
      const prompt = String(current.PreCompact[0].hooks[0].prompt)
      const plan = generateSubHooks(current, { ...inputs, prompts: { precompact: prompt } })
      const keptOut = JSON.parse(JSON.stringify(plan.hooks, (_k, v) => (Array.isArray(v) ? v.filter((g) => !plan.kept.some((k) => k.matcher === g?.matcher && JSON.stringify(k.hook) === JSON.stringify(g?.hooks?.[0]))) : v)))
      expect(json(keptOut), n).toBe(json(lockFor(prompt)))
    }
  })

  it('N2-2 (Ron 17451), measured: the five agents with a hand-added Playwright hook, given the browser capability, regenerate to the lock\'s browser block with NO kept hook', () => {
    const f = JSON.parse(readFileSync(join(FIXTURES, 'live-sub-hooks.12.json'), 'utf-8')) as { hooks: Hook[]; agents: Record<string, { events: Record<string, Array<{ matcher?: string; hooks: number[] }>> }> }
    const PW = 'mcp__playwright__browser_.*'
    const five = Object.keys(f.agents).filter((n) => (f.agents[n].events.PostToolUse ?? []).some((g) => g.matcher === PW))
    expect(five).toHaveLength(5)
    for (const n of five) {
      const block: Block = {}
      for (const [event, groups] of Object.entries(f.agents[n].events)) block[event] = groups.map((g) => ({ ...g, hooks: g.hooks.map((i) => f.hooks[i]) }))
      const current = JSON.parse(JSON.stringify(block).replaceAll('${ROOT}', PROJECT_ROOT).replaceAll('${NODE_BIN}', HOOK_NODE_BIN)) as Block
      const prompt = String(current.PreCompact[0].hooks[0].prompt)
      const plan = generateSubHooks(current, { ...inputs, agent: { browser: true }, prompts: { precompact: prompt } })
      expect(plan.kept, n).toEqual([])
      const expected = expectedHooks(parseLock(lockText()), { ...off, browser: true, root: PROJECT_ROOT, nodeBin: HOOK_NODE_BIN, precompact: prompt })
      expect(json(plan.hooks), n).toBe(json(expected))
    }
  })

  it('live-sub-hooks.default.json: the lock\'s default block is the fixture up to the 31 rewraps and the fleet-freeze-gate change', () => {
    const live = JSON.parse(readFileSync(join(FIXTURES, 'live-sub-hooks.default.json'), 'utf-8')) as Array<Record<string, unknown>>
    expect(live).toHaveLength(39)
    const desanitise = (v: unknown) => (typeof v === 'string' ? v.replaceAll('${NODE_BIN}', HOOK_NODE_BIN).replaceAll('${ROOT}', PROJECT_ROOT) : v)
    const fromFixture: PlacedHook[] = live.map(({ event, matcher, ...hook }) => ({ event: String(event), ...(matcher === undefined ? {} : { matcher: String(matcher) }),
      hook: Object.fromEntries(Object.entries(hook).map(([k, v]) => [k, desanitise(v)])) }))
    const fromLockPlaced: PlacedHook[] = Object.entries(lockFor('P') as Block).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((hook) => ({ event, ...(g.matcher === undefined ? {} : { matcher: g.matcher }), hook }))))
    const key = (p: PlacedHook) => { const o = { event: p.event, matcher: p.matcher, ...p.hook, prompt: undefined }; return JSON.stringify(o, Object.keys(o).sort()) }
    const minus = (xs: PlacedHook[], ys: PlacedHook[]) => { const left = ys.map(key); return xs.filter((x) => { const i = left.indexOf(key(x)); if (i < 0) return true; left.splice(i, 1); return false }) }
    const r = pairRewraps(minus(fromFixture, fromLockPlaced), minus(fromLockPlaced, fromFixture))
    expect([r.pairs.length, r.dropped.length, r.added.length]).toEqual([31, 1, 1])
  })
})

describe('a changed manifest shows up as a mismatch against the protected lock (K1 mutant)', () => {
  it('dropping a fail-closed gate or changing its command: the rendered block no longer equals the lock\'s', () => {
    const s = [...combinations()][0]
    const dropped: HookManifest = {
      ...HOOK_MANIFEST,
      entries: HOOK_MANIFEST.entries.filter((e) => e.id !== 'email-send-gate'),
      layout: { ...HOOK_MANIFEST.layout, sub: { ...HOOK_MANIFEST.layout.sub, PreToolUse: HOOK_MANIFEST.layout.sub!.PreToolUse!
        .map((slot) => (typeof slot === 'string' ? slot : slot.filter((id) => id !== 'email-send-gate')))
        .filter((slot) => slot !== 'email-send-gate' && slot.length > 0) } },
    }
    expect(json(renderHooks(dropped, 'sub', renderCtx(s)))).not.toBe(json(fromLock(s)))
    const changed: HookManifest = { ...HOOK_MANIFEST, entries: HOOK_MANIFEST.entries.map((e) => (e.id === 'email-send-gate' ? { ...e, args: ['--allow-thread-reply'] } : e)) }
    expect(json(renderHooks(changed, 'sub', renderCtx(s)))).not.toBe(json(fromLock(s)))
    expect(JSON.stringify(buildLock(changed))).not.toBe(JSON.stringify(buildLock()))
  })
})
