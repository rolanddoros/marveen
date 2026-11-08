/**
 * C3-3b-1: sub-agent settings from the hook manifest's generator on every write path (plan
 * runlogs/c3/plan-c3-3b.md, Johnny 13927). The parity cases run the OLD chain (the boot's ten ensure* and the
 * spawn's inject* sequence, both still in the tree until 3b-2) against the new writer on the 12 live blocks
 * (hooks/__fixtures__) and on one fixture per conditional gate, ON and OFF again, and compare the flattened
 * multiset (event, matcher, whole hook object), the key the dry-run's go-live verdict uses.
 *
 * Probe agents live under the checkout's agents/ (runtime state, not tracked); each is removed again behind the
 * same guards as the other wiring suites. The sender-role store points at a temp file.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { GATES } = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return { GATES: join(mkdtempSync(join(tmpdir(), 'c33b1-gates-')), 'agent-sender-role-gates.json') }
})
vi.mock('../web/sender-role-gate-store.js', async (orig) => ({
  ...(await orig<typeof import('../web/sender-role-gate-store.js')>()),
  senderRoleGatesPath: () => GATES,
}))
// Ron N-A: a profile that turns the three profile gates on (no shipped profile does); every other id as it is.
vi.mock('../web/profiles.js', async (orig) => {
  const o = await orig<typeof import('../web/profiles.js')>()
  return {
    ...o,
    loadProfileTemplate: (id: string) => (id === 'c33b1b-all-gates'
      ? { ...o.loadProfileTemplate('default'), id, destructiveGate: true, credentialGate: true, secondReviewer: true }
      : o.loadProfileTemplate(id)),
  }
})
import * as S from '../web/agent-scaffold.js'
import { AGENTS_BASE_DIR, readAgentCapabilities, readAgentSenderRoleGatePolicy } from '../web/agent-config.js'
import { loadProfileTemplate, type ProfileTemplate } from '../web/profiles.js'
import { HEARTBEAT_AGENT_ID, MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import { generateSubHooks, type KeptHook } from '../web/hooks/sub-generator.js'
import { dryRun, pairRewraps, type PlacedHook } from '../web/hooks/dry-run.js'
import { withHeartbeatProbeLock } from './helpers/heartbeat-probe-lock.js'

type Hooks = Record<string, Array<{ matcher?: unknown; hooks?: Array<Record<string, unknown>> }>>
type Fixture = { agents: Record<string, { events: Record<string, Array<{ matcher?: string; hooks: number[] }>> }>; hooks: Array<Record<string, unknown>> }

const FIXTURE = JSON.parse(readFileSync(join(PROJECT_ROOT, 'src', 'web', 'hooks', '__fixtures__', 'live-sub-hooks.12.json'), 'utf-8')) as Fixture
const NO_EXTRAS = join(PROJECT_ROOT, 'store', 'c33b1-no-such-extra-hooks-file.json')
const PREFIX = 'c33b1-'
const created = new Set<string>()
const DEFAULT = loadProfileTemplate('default')

function liveBlock(sub: string): Hooks {
  const a = FIXTURE.agents[sub]
  const hooks = Object.fromEntries(Object.entries(a.events).map(([ev, gs]) => [ev, gs.map((g) => ({ ...g, hooks: g.hooks.map((i) => FIXTURE.hooks[i]) }))]))
  return JSON.parse(JSON.stringify(hooks).replaceAll('${ROOT}', PROJECT_ROOT).replaceAll('${NODE_BIN}', S.HOOK_NODE_BIN)) as Hooks
}

function removeProbe(name: string): void {
  const dir = join(AGENTS_BASE_DIR, name)
  if (!existsSync(dir)) return
  if (!dir.startsWith(join(AGENTS_BASE_DIR, name)) || (name !== HEARTBEAT_AGENT_ID && !name.startsWith(PREFIX))) throw new Error(`refusing: ${dir}`)
  if (existsSync(join(dir, 'CLAUDE.md')) || existsSync(join(dir, 'HANDOFF.md'))) throw new Error(`refusing: ${dir} looks like a live agent`)
  rmSync(dir, { recursive: true, force: true })
}

/** A probe agent with this settings text (or object) and agent-config.json. */
function probe(name: string, settings: unknown, config: Record<string, unknown> = { securityProfile: 'default' }): string {
  removeProbe(name)
  created.add(name)
  mkdirSync(join(AGENTS_BASE_DIR, name, '.claude'), { recursive: true })
  writeFileSync(join(AGENTS_BASE_DIR, name, 'agent-config.json'), JSON.stringify(config))
  const path = S.agentSettingsPath(name)
  writeFileSync(path, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2))
  return path
}

beforeEach(() => {
  if (existsSync(join(AGENTS_BASE_DIR, HEARTBEAT_AGENT_ID, 'HANDOFF.md'))) throw new Error('refusing: a live install')
  rmSync(GATES, { force: true })
})
afterEach(() => {
  for (const n of created) removeProbe(n)
  created.clear()
  vi.restoreAllMocks()
})
afterAll(() => rmSync(GATES, { force: true }))

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>

/** The dry-run's multiset key: event, the group's matcher and the whole hook object. */
function multiset(hooks: unknown): string[] {
  const out: string[] = []
  for (const [event, groups] of Object.entries((hooks ?? {}) as Hooks)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        const o: Record<string, unknown> = { event, ...(g.matcher === undefined ? {} : { matcher: g.matcher }), ...h }
        out.push(JSON.stringify(o, Object.keys(o).sort()))
      }
    }
  }
  return out.sort()
}

/**
 * The multiset difference left after the dry-run's rewrap pairing (C3-5b): the old chain writes the pre-C3-5
 * spellings, the generator the normalised ones, so the two sides may differ only by rewraps (same hook, another
 * known spelling or timeout). Unpaired hooks come back as multiset keys; {0 dropped, 0 added} = parity.
 */
function unpairedAfterRewrap(before: unknown, after: unknown): { pairs: number; dropped: string[]; added: string[] } {
  const placed = (hooks: unknown): PlacedHook[] => Object.entries((hooks ?? {}) as Hooks).flatMap(([event, groups]) => groups
    .flatMap((g) => (g.hooks ?? []).map((hook) => ({ event, ...(g.matcher === undefined ? {} : { matcher: g.matcher as string }), hook }))))
  const key = (p: PlacedHook) => multiset({ [p.event]: [{ ...(p.matcher === undefined ? {} : { matcher: p.matcher }), hooks: [p.hook] }] })[0]
  const minus = (xs: PlacedHook[], ys: PlacedHook[]) => {
    const left = ys.map(key)
    return xs.filter((x) => { const i = left.indexOf(key(x)); if (i < 0) return true; left.splice(i, 1); return false })
  }
  const [b, a] = [placed(before), placed(after)]
  const r = pairRewraps(minus(b, a), minus(a, b))
  return { pairs: r.pairs.length, dropped: r.dropped.map(key), added: r.added.map(key) }
}
const parity = (old: unknown, fresh: unknown) => { const r = unpairedAfterRewrap(old, fresh); return { dropped: r.dropped, added: r.added } }
const NO_DIFF = { dropped: [], added: [] }

// The spawn's inject* sequence as agent-scaffold.ts:1215-1243 ran it on c7f124ff (extras path aside). Test-only: it
// goes with the injectors in 3b-2.
function oldSpawnInjections(name: string, e: Record<string, unknown>, profile: ProfileTemplate): void {
  if (S.agentGetsEmailGate(name)) S.injectEmailSendGate(e, S.hasThreadReplyCapability(name, readAgentCapabilities(name)))
  if (S.agentGetsGovernanceGates(name)) S.injectSelfPaceGate(e)
  if (S.agentGetsGovernanceGates(name)) S.injectDbWriteGate(e)
  if (S.agentGetsKanbanWriteGate(name)) {
    S.injectKanbanWriteGate(e)
    S.injectDigestProvenanceGate(e)
  }
  if (S.agentGetsTelegramCopyGate(name)) S.injectTelegramCopyGate(e)
  const policy = S.agentGetsSenderRoleGate(name) ? readAgentSenderRoleGatePolicy(name) : null
  if (policy) S.injectSenderRoleGate(e, policy)
  else S.removeSenderRoleGate(e)
  if (S.agentGetsChildClaudeGuard(name)) S.injectChildClaudeGuard(e)
  if (S.agentGetsDestructiveGate(name, profile)) S.injectDestructiveGate(e)
  if (S.agentGetsCredentialGate(name, profile)) S.injectCredentialGate(e)
  if (S.agentGetsSecondReviewer(name, profile)) S.injectSecondReviewerGate(e)
  else S.removeSecondReviewerGate(e)
  S.injectEgressGate(e)
  if (S.agentGetsBashEgressParser(name)) S.injectBashEgressParser(e)
  S.injectWebSearchEnvelope(e)
  S.injectExtraHookEntries(name, e, NO_EXTRAS)
}

// The boot's ten ensure* in web.ts:726-749 order on c7f124ff.
function oldBoot(name: string, profile: ProfileTemplate): void {
  S.ensureAgentHooks(name)
  S.ensureAgentStalenessHook(name)
  S.ensureAgentProvenanceHook(name)
  S.ensureEgressGate(name)
  S.ensureBashEgressParser(name)
  S.ensureGovernanceGateCommands(name, profile)
  S.ensureTelegramCopyGate(name)
  S.ensureChildClaudeGuard(name)
  S.ensureWebSearchEnvelope(name)
  S.ensureExtraHookEntries(name, NO_EXTRAS)
}

/** The old lifecycle (boot, spawn, boot) from this settings object; returns the final hooks block. */
function oldChain(name: string, settings: Record<string, unknown>, profile: ProfileTemplate, config?: Record<string, unknown>): unknown {
  const path = probe(name, settings, config)
  oldBoot(name, profile)
  const s = readJson(path)
  oldSpawnInjections(name, s, profile)
  writeFileSync(path, JSON.stringify(s, null, 2))
  oldBoot(name, profile)
  return readJson(path).hooks
}

function newChain(name: string, settings: Record<string, unknown>, profile: ProfileTemplate, config?: Record<string, unknown>): unknown {
  probe(name, settings, config)
  return S.subSettingsHooks(name, settings, profile, NO_EXTRAS).hooks
}

describe('parity: the old chain and the generator give the same multiset', () => {
  it('on each of the 12 live blocks', () => {
    const diffs: string[] = []
    for (const sub of Object.keys(FIXTURE.agents)) {
      const cfg = sub === 'sub-05' ? { team: { role: 'leader' } } : { securityProfile: 'default' }
      const profile = loadProfileTemplate(sub === 'sub-05' ? 'applier' : 'default')
      const settings = { permissions: { allow: [] }, hooks: liveBlock(sub) }
      const fresh = newChain(`${PREFIX}${sub}`, settings, profile, cfg)
      const old = oldChain(`${PREFIX}${sub}`, settings, profile, cfg)
      const r = unpairedAfterRewrap(old, fresh)
      if (r.dropped.length || r.added.length) diffs.push(`${sub}: +${r.added.length} -${r.dropped.length}`)
    }
    expect(diffs).toEqual([])
  }, 120_000)

  const cases: Array<{ id: string; name?: string; profile?: Partial<ProfileTemplate>; config?: Record<string, unknown>; gates?: unknown; script: string }> = [
    { id: 'destructive', profile: { destructiveGate: true }, script: 'destructive-gate.py' },
    { id: 'credential', profile: { credentialGate: true }, script: 'credential-gate.py' },
    { id: 'second-reviewer', profile: { secondReviewer: true }, script: 'second-reviewer-gate.py' },
    { id: 'heartbeat', name: HEARTBEAT_AGENT_ID, script: 'kanban-write-gate.mjs' },
    { id: 'sender-role', gates: { riskyTools: ['Bash'], roles: [{ channel: 'telegram', sender: '111111', role: 'owner' }] }, script: 'sender-role-gate.py' },
    { id: 'thread-reply', config: { securityProfile: 'default', capabilities: ['email:thread-reply'] }, script: '--allow-thread-reply' },
  ]
  for (const c of cases) {
    it(`a conditional gate, ON then OFF again: ${c.id}`, () => {
      const name = c.name ?? `${PREFIX}${c.id}`
      // The heartbeat directory is shared with hook-manifest-sub (parallel workers): one at a time, removed inside.
      if (name === HEARTBEAT_AGENT_ID) {
        withHeartbeatProbeLock(AGENTS_BASE_DIR, () => {
          try { gateCase(c, name) } finally { removeProbe(name); created.delete(name) }
        })
      } else gateCase(c, name)
    }, 60_000)
  }
})

function gateCase(c: { profile?: Partial<ProfileTemplate>; config?: Record<string, unknown>; gates?: unknown; script: string }, name: string): void {
  const on = { ...DEFAULT, ...c.profile }
  const cfgOn = c.config ?? { securityProfile: 'default' }
  const setGates = (v: unknown) => writeFileSync(GATES, JSON.stringify(v === undefined ? {} : { [name]: v }))
  setGates(c.gates)
  const base = { permissions: { allow: [] }, hooks: liveBlock('sub-01') }
  const newOn = newChain(name, base, on, cfgOn)
  const oldOn = oldChain(name, base, on, cfgOn)
  expect(JSON.stringify(newOn)).toContain(c.script)
  expect(parity(oldOn, newOn)).toEqual(NO_DIFF)
  // OFF again, from the ON block: offRemoves entries go, the others stay as kept copies; the same both ways.
  setGates(undefined)
  const offBase = { permissions: { allow: [] }, hooks: oldOn }
  expect(parity(oldChain(name, offBase, DEFAULT), newChain(name, offBase, DEFAULT))).toEqual(NO_DIFF)
}

describe('the boot writer (ensureSubHookBlock)', () => {
  it('writes once, then never again while nothing changes; a spawn render is byte-identical to a boot render', () => {
    const path = probe(`${PREFIX}idem`, { permissions: { allow: [] }, hooks: liveBlock('sub-02') })
    expect(S.ensureSubHookBlock(`${PREFIX}idem`, NO_EXTRAS)).toBe(true)
    const bytes = readFileSync(path, 'utf-8')
    const mtime = statSync(path).mtimeMs
    expect(S.ensureSubHookBlock(`${PREFIX}idem`, NO_EXTRAS)).toBe(false)
    expect(readFileSync(path, 'utf-8')).toBe(bytes)
    expect(statSync(path).mtimeMs).toBe(mtime)
    // The live block is the pre-C3-5 shape: the window's 32 rewraps, nothing added or dropped.
    expect(unpairedAfterRewrap(liveBlock('sub-02'), readJson(path).hooks)).toEqual({ pairs: 32, ...NO_DIFF })
    S.writeAgentSettingsFromProfile(`${PREFIX}idem`, DEFAULT, NO_EXTRAS)
    expect(S.ensureSubHookBlock(`${PREFIX}idem`, NO_EXTRAS)).toBe(false)
  })

  it('never touches the main agent', () => {
    expect(S.ensureSubHookBlock(MAIN_AGENT_ID, NO_EXTRAS)).toBe(false)
    expect(() => S.subSettingsHooks(MAIN_AGENT_ID, {}, DEFAULT, NO_EXTRAS)).toThrow(/main agent/)
  })

  it('rollback safety: the old boot chain over a generator-written block changes no hook', () => {
    const path = probe(`${PREFIX}rollback`, { permissions: { allow: [] }, hooks: liveBlock('sub-07') })
    expect(S.ensureSubHookBlock(`${PREFIX}rollback`, NO_EXTRAS)).toBe(true)
    const written = readJson(path).hooks
    oldBoot(`${PREFIX}rollback`, DEFAULT)
    // The old ensure* may put back their pre-C3-5 spellings (a rewrap); no hook is added or dropped.
    expect(parity(written, readJson(path).hooks)).toEqual(NO_DIFF)
  })

  it('runs the PreCompact prompt migrations before the generator (Ron N3): a foreign root is re-anchored', () => {
    const hooks = liveBlock('sub-03')
    const pc = hooks.PreCompact[0].hooks![0]
    pc.prompt = `${String(pc.prompt)}\n\nA token: cat /opt/c33b1-old-install/store/.dashboard-token`
    const path = probe(`${PREFIX}migrate`, { hooks })
    expect(S.ensureSubHookBlock(`${PREFIX}migrate`, NO_EXTRAS)).toBe(true)
    const prompt = JSON.stringify(readJson(path).hooks)
    expect(prompt).not.toContain('/opt/c33b1-old-install')
    expect(prompt).toContain(`cat ${PROJECT_ROOT}/store/.dashboard-token`)
  })
})

describe('error rule: any throw leaves the file as it is, the log names the agent and the error class only', () => {
  const canary = 'CANARY-c33b1-k7'
  const bad: Array<[string, string]> = [
    ['a non-list unknown event', JSON.stringify({ hooks: { [canary]: 'x' } }, null, 2)],
    ['a __proto__ event key (Ron 13916)', `{ "hooks": { "__proto__": "${canary}", "Stop": [] } }`],
    ['a non-list known event', JSON.stringify({ hooks: { Stop: canary } }, null, 2)],
  ]
  for (const [what, text] of bad) {
    it(`${what}: boot and spawn write nothing, the next agent is still written`, () => {
      const warn = vi.spyOn(logger, 'warn')
      const path = probe(`${PREFIX}bad`, text)
      expect(S.ensureSubHookBlock(`${PREFIX}bad`, NO_EXTRAS)).toBe(false)
      expect(readFileSync(path, 'utf-8')).toBe(text)
      expect(() => S.writeAgentSettingsFromProfile(`${PREFIX}bad`, DEFAULT, NO_EXTRAS)).toThrow()
      expect(readFileSync(path, 'utf-8')).toBe(text)
      const logged = JSON.stringify(warn.mock.calls)
      expect(logged).toContain(`${PREFIX}bad`)
      expect(logged).not.toContain(canary)
      probe(`${PREFIX}good`, { hooks: liveBlock('sub-01') })
      expect(S.ensureSubHookBlock(`${PREFIX}good`, NO_EXTRAS)).toBe(true)
    })
  }

  it('the callers turn a throw into a refusal, error class only (pinned in source)', () => {
    const proc = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'agent-process.ts'), 'utf-8')
    expect(proc).toMatch(/try \{\n\s+writeAgentSettingsFromProfile\(name, profile\)\n\s+\} catch \(err\) \{\n\s+const error = hookErrorSummary\(err\)\n[^\n]*logger\.warn\(\{ agent: name, error \}[^\n]*\n\s+return \{ ok: false, error: `hook settings: \$\{error\}` \}/)
    const routes = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'routes', 'agents.ts'), 'utf-8')
    // The PUT refuses; the create runs on and answers 500 at the end (Ron N-C, behaviour in agent-create-telegram-route).
    expect(routes.match(/logger\.warn\(\{ agent: name, error: hookErrorSummary\(err\) \}/g)).toHaveLength(1)
    expect(routes).toMatch(/\} catch \(err\) \{\n\s+return \{ ok: false, error: hookErrorSummary\(err\) \}/)
    expect(routes).toContain('const hookSettings = writeNewAgentHookSettings(name, loadProfileTemplate(profileId))')
    expect(routes).toMatch(/writeAgentSecurityProfile\(name, requested\)\n\s+try \{\n\s+writeAgentSettingsFromProfile\(name, profile\)/)
  })
})

describe('Ron N2 and N3 (Johnny 13927): kept, never dropped, and reported', () => {
  const opHook = { type: 'command', command: "curl -sf 'https://ops.example.invalid/CANARY-n2'" }

  it('an operator hook inside a managed gate group is kept next to the rendered gate, marked, and logged without its text', () => {
    const hooks = liveBlock('sub-01')
    const egress = hooks.PreToolUse.find((g) => JSON.stringify(g).includes('egress-gate.mjs'))!
    egress.hooks!.push(opHook)
    const warn = vi.spyOn(logger, 'warn')
    const path = probe(`${PREFIX}n2`, { hooks })
    // The dry-run reads the block as it is before the switch writes it (the C3-5 go-live evidence).
    const label = /^\(was in a managed group\) PreToolUse \[WebFetch\] command #[0-9a-f]{8} timeout=-$/
    const before = dryRun({ root: PROJECT_ROOT, nodeBin: S.HOOK_NODE_BIN, agents: [`${PREFIX}n2`] })
    expect(before.agents[0].kept).toContainEqual(expect.stringMatching(label))
    expect(S.ensureSubHookBlock(`${PREFIX}n2`, NO_EXTRAS)).toBe(true)
    const out = readJson(path).hooks as Hooks
    // The rendered gate command names its script more than once; the gate must not be duplicated by the kept hook.
    const gateNames = (h: unknown) => JSON.stringify(h).match(/egress-gate\.mjs/g)?.length ?? 0
    expect(gateNames(out)).toBe(gateNames(liveBlock('sub-01')))
    expect(gateNames(out)).toBeGreaterThan(0)
    expect(multiset(out)).toContain(JSON.stringify({ command: opHook.command, event: 'PreToolUse', matcher: 'WebFetch', type: 'command' }))
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('operator hook kept inside a managed hook group')
    expect(logged).not.toContain('CANARY-n2')
    // Written, the kept hook sits in its own group next to the gate's: kept, and no longer marked.
    const after = dryRun({ root: PROJECT_ROOT, nodeBin: S.HOOK_NODE_BIN, agents: [`${PREFIX}n2`] })
    // The command tag is a per-run HMAC (3a-4), so two runs compare without it.
    const untagged = (k: string) => k.replace(/#[0-9a-f]{8}/, '#')
    expect(after.agents[0].kept.map(untagged)).toContain('PreToolUse [WebFetch] command # timeout=-')
    expect(after.agents[0].kept.filter((k) => k.startsWith('(was in a managed group)'))).toEqual([])
  })

  it('a hook alone in its own group is not marked (the live playwright shape)', () => {
    const plan = generateSubHooks({ PostToolUse: [{ matcher: 'mcp__x__.*', hooks: [opHook] }] }, { root: PROJECT_ROOT, nodeBin: S.HOOK_NODE_BIN, prompts: { precompact: 'p' } })
    expect(plan.kept).toEqual([{ event: 'PostToolUse', matcher: 'mcp__x__.*', hook: opHook }] satisfies KeptHook[])
  })

  it('a second type:agent hook under PreCompact auto is kept as foreign and listed; the first stays the prompt', () => {
    const second = { type: 'agent', prompt: 'an operator prompt', timeout: 60 }
    const plan = generateSubHooks({ PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'the prompt', timeout: 180 }, second] }] },
      { root: PROJECT_ROOT, nodeBin: S.HOOK_NODE_BIN, prompts: { precompact: 'seed' } })
    expect(plan.kept).toEqual([{ event: 'PreCompact', matcher: 'auto', hook: second, inManagedGroup: true }])
    const prompts = plan.hooks.PreCompact.flatMap((g) => (g.hooks as Array<{ prompt?: string }>).map((h) => h.prompt))
    expect(prompts).toEqual(['the prompt', 'an operator prompt'])
  })
})

// C3-3b-1b (Ron's 3b-1 review, Kevin 13959): what the boot writer still needs pinned before the go-live.
describe('C3-3b-1b: the boot writer, pinned', () => {
  const tplPrompt = () => (JSON.parse(S.resolveTemplatePlaceholders(readFileSync(join(PROJECT_ROOT, 'templates', 'settings.json.template'), 'utf-8')))
    .hooks.PreCompact[0].hooks[0].prompt as string)
  const promptOf = (hooks: unknown) => (hooks as Hooks).PreCompact.flatMap((g) => g.hooks ?? []).find((h) => h.type === 'agent')?.prompt as string
  const withPrompt = (prompt: string) => ({ ...liveBlock('sub-01'), PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt, timeout: 180 }] }] })
  const bootHooks = (name: string, hooks: unknown, config?: Record<string, unknown>) => {
    const path = probe(name, { permissions: { allow: ['Read'] }, hooks }, config)
    S.ensureSubHookBlock(name, NO_EXTRAS)
    return readJson(path).hooks
  }

  it('N-A: the boot renders the gates of the profile the agent resolves to', () => {
    const file = JSON.stringify(bootHooks(`${PREFIX}profile`, liveBlock('sub-01'), { securityProfile: 'c33b1b-all-gates' }))
    for (const script of ['destructive-gate.py', 'credential-gate.py', 'second-reviewer-gate.py']) expect(file).toContain(script)
  })

  it('N-B: an unreadable settings.json (a directory, a symlink to one) is left as it is and nothing is written', () => {
    for (const kind of ['directory', 'symlink'] as const) {
      const name = `${PREFIX}unreadable-${kind}`
      removeProbe(name)
      created.add(name)
      const dir = join(AGENTS_BASE_DIR, name)
      mkdirSync(join(dir, '.claude'), { recursive: true })
      writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ securityProfile: 'default' }))
      const path = S.agentSettingsPath(name)
      if (kind === 'directory') mkdirSync(path)
      else { mkdirSync(join(dir, 'real-dir')); symlinkSync(join(dir, 'real-dir'), path) }
      const warn = vi.spyOn(logger, 'warn')
      expect(S.ensureSubHookBlock(name, NO_EXTRAS)).toBe(false)
      expect(kind === 'directory' ? lstatSync(path).isDirectory() : lstatSync(path).isSymbolicLink()).toBe(true)
      expect(warn).toHaveBeenCalledWith({ agent: name, error: 'unexpected error (Error)' }, 'sub-agent hook block NOT written, settings.json left as it is (C3-3b)')
      warn.mockRestore()
    }
  })

  it('N-E: duplicate JSON keys are logged with their paths only, and the block is still written', () => {
    const warn = vi.spyOn(logger, 'warn')
    const block = JSON.stringify({ hooks: liveBlock('sub-01') }, null, 2)
    const raw = block.replace('"hooks": {', '"hooks": {\n    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "echo CANARY-dup" }] }],')
    const path = probe(`${PREFIX}dupkeys`, raw)
    expect(S.ensureSubHookBlock(`${PREFIX}dupkeys`, NO_EXTRAS)).toBe(true)
    expect(warn).toHaveBeenCalledWith({ agent: `${PREFIX}dupkeys`, dupKeys: ['hooks.PreToolUse'] },
      'duplicate JSON keys in settings.json: JSON.parse keeps only the last occurrence, hooks in the earlier block are silently dead')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('CANARY-dup')
    expect(readFileSync(path, 'utf-8')).not.toContain('CANARY-dup')
  })

  // N-M: one stale fixture per migration of migrateSubHookBlock. The three prompt passes change the prompt the
  // generator keeps; the command and matcher passes touch only template hooks, which the generator recognises by
  // their script and renders fresh, so their fixtures pin that no stale form survives (see the PR text).
  it('N-M: the task-state header pass upgrades an operator-edited prompt', () => {
    const anchor = "/api/agent-taskstate/SAJAT_NEVED -H 'Content-Type: application/json'"
    const out = promptOf(bootHooks(`${PREFIX}mig-header`, withPrompt(`my own words\ncurl -s -X POST http://h${anchor} -d @f\n`)))
    expect(out).toContain(`${anchor} -H 'X-Agent-Id: SAJAT_NEVED' -d @f`)
  })

  it('N-M: the recipes-to-helper pass rewrites the curl save recipes of an operator-edited prompt', () => {
    const old = S.resolveTemplatePlaceholders(readFileSync(join(PROJECT_ROOT, 'src', '__tests__', 'fixtures', 'precompact-prompt-pre2338.txt'), 'utf-8'))
    expect(old).toMatch(/\bcurl\b.*\/api\/memories\b/)
    const out = promptOf(bootHooks(`${PREFIX}mig-recipes`, withPrompt(`my own words\n${old}`)))
    expect(out.startsWith('my own words\n')).toBe(true)
    expect(out).not.toMatch(/\bcurl\b.*\/api\/(?:memories|daily-log|agent-taskstate)\b/)
    expect(out).toContain('marveen-api.sh')
  })

  it('N-M: every shipped retired stock prompt becomes the current template prompt', () => {
    const retired = S.readRetiredHookPrompts().PreCompact
    expect(retired.length).toBeGreaterThan(0)
    const wrong = retired.map((stock, i) => [i, promptOf(bootHooks(`${PREFIX}mig-retired-${i}`, withPrompt(stock)))] as const)
      .filter(([, out]) => out !== tplPrompt()).map(([i]) => i)
    expect(wrong).toEqual([])
  }, 60_000)

  // The legacy-command pass and the matcher sync change only template hooks, which the generator renders fresh;
  // what they still decide is the matcher of an operator's non-command hook in a template group (the sync compares
  // commands only, and a legacy command matches the template's only after the legacy pass).
  it('N-M: a legacy command and a stale matcher in a template group an operator extended: as the old chain does', () => {
    const hooks = liveBlock('sub-01')
    const g = hooks.SessionStart.find((x) => JSON.stringify(x).includes('taskstate-replay.py'))!
    const tplMatcher = g.matcher
    g.matcher = 'compact|resume'
    // A legacy spelling: the same script from an older install path (the template's form is `python3 <root>/...`).
    const legacy = 'python3 /opt/old-marveen/scripts/hooks/taskstate-replay.py'
    g.hooks!.find((x) => String(x.command).includes('taskstate-replay.py'))!.command = legacy
    g.hooks!.push({ type: 'http', url: 'https://ops.example.invalid/session' })
    const settings = { permissions: { allow: [] }, hooks }
    const fresh = newChain(`${PREFIX}mig-cmd-matcher`, settings, DEFAULT) as Hooks
    expect(parity(oldChain(`${PREFIX}mig-cmd-matcher`, settings, DEFAULT), fresh)).toEqual(NO_DIFF)
    expect(fresh.SessionStart.find((x) => x.hooks?.some((h) => h.type === 'http'))?.matcher).toBe(tplMatcher)
    expect(JSON.stringify(fresh)).not.toContain(legacy)
  })

  it('N-H: a first agent hook without a prompt does not push the real prompt out; both kept, as the old chain does', () => {
    const noPrompt = { type: 'agent', timeout: 180 }
    const real = { type: 'agent', prompt: 'the real prompt', timeout: 180 }
    const plan = generateSubHooks({ PreCompact: [{ matcher: 'auto', hooks: [noPrompt, real] }] },
      { root: PROJECT_ROOT, nodeBin: S.HOOK_NODE_BIN, prompts: { precompact: 'seed' } })
    expect(promptOf(plan.hooks)).toBe('the real prompt')
    expect(plan.kept).toEqual([{ event: 'PreCompact', matcher: 'auto', hook: noPrompt, inManagedGroup: true }])
    const settings = { permissions: { allow: [] }, hooks: { ...liveBlock('sub-01'), PreCompact: [{ matcher: 'auto', hooks: [noPrompt, real] }] } }
    expect(parity(oldChain(`${PREFIX}n-h`, settings, DEFAULT), newChain(`${PREFIX}n-h`, settings, DEFAULT))).toEqual(NO_DIFF)
  })
})
