/**
 * C3-1b: the typed hook manifest reproduces the sub-agents' wiring exactly.
 *
 * The reference is the REAL code path, run for a probe agent in this
 * checkout's agents/ dir, in the order a new agent goes through it: template
 * seed (scaffoldAgentDir) -> writeAgentSettingsFromProfile (create, routes/
 * agents.ts) -> the boot backfill (web.ts, same order) -> writeAgentSettings-
 * FromProfile (spawn, agent-process.ts). One more backfill + spawn round must
 * leave the file byte for byte unchanged (fixpoint).
 *
 * End to end: every shipped profile, the three profile switches, the
 * heartbeat agent (by its name) and the email thread-reply capability (the
 * probe's own agent-config.json). Injector level only: the sender-role gate,
 * whose policy is read from store/agent-sender-role-gates.json, a file every
 * test of the run shares; injectSenderRoleGate is applied to a real-path file.
 *
 * Never the main agent (its agentSettingsPath is the operator's ~/.claude), and
 * never the live install: the guards below refuse before anything is written.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  agentSettingsPath, ensureAgentHooks, ensureAgentProvenanceHook, ensureAgentStalenessHook, ensureBashEgressDeny,
  ensureBashEgressParser, ensureChildClaudeGuard, ensureEgressGate, ensureExtraHookEntries, ensureGovernanceGateCommands,
  ensureTelegramCopyGate, ensureWebSearchEnvelope, injectSenderRoleGate, removeSenderRoleGate, resolveTemplatePlaceholders,
  seedSettingsFromTemplate, writeAgentSettingsFromProfile, ytDlpIngestOnly, HOOK_NODE_BIN, EMAIL_THREAD_REPLY_CAPABILITY,
} from '../web/agent-scaffold.js'
import { pruneStaleHooksFromSettingsFile } from '../web/hook-registration-guard.js'
import { listProfileTemplates, loadProfileTemplate, type ProfileTemplate } from '../web/profiles.js'
import { AGENTS_BASE_DIR, senderRoleGatePolicyArg, writeAgentSecurityProfile } from '../web/agent-config.js'
import { HEARTBEAT_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { withHeartbeatProbeLock } from './helpers/heartbeat-probe-lock.js'
import {
  HOOK_MANIFEST, renderHooks, specFor, validateManifest,
  type FailMode, type HookManifest, type HookManifestEntry, type RenderContext, type RenderedHooks,
} from '../web/hooks/manifest.js'
import { ownerOf } from '../web/hooks/sub-generator.js'
import { pairRewraps, type PlacedHook } from '../web/hooks/dry-run.js'

const LIVE_INSTALL_ROOT = '/root/marveen'
const PROBE_PREFIX = 'hook-manifest-probe-'
const MARKER = '.hook-manifest-probe'
// No extras file: store/extra-hooks.json of a dev checkout must not leak into the reference.
const NO_EXTRAS = join(PROJECT_ROOT, 'hook-manifest-probe-no-extra-hooks.json')
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'hooks', '__fixtures__', 'live-sub-hooks.default.json')
const TEMPLATE = join(PROJECT_ROOT, 'templates', 'settings.json.template')

function assertNotLive(): void {
  if (realpathSync(PROJECT_ROOT) === LIVE_INSTALL_ROOT || PROJECT_ROOT === LIVE_INSTALL_ROOT) throw new Error('refusing: live install')
  const base = existsSync(AGENTS_BASE_DIR) ? realpathSync(AGENTS_BASE_DIR) : AGENTS_BASE_DIR
  if (base === `${LIVE_INSTALL_ROOT}/agents`) throw new Error('refusing: the live agents dir')
}

function removeProbe(dir: string): void {
  if (!existsSync(dir)) return
  if (!existsSync(join(dir, MARKER)) || existsSync(join(dir, 'CLAUDE.md'))) throw new Error(`refusing to remove ${dir}: not a probe`)
  rmSync(dir, { recursive: true, force: true })
}

function bootBackfill(name: string): void {
  // web.ts boot loop order; ensureProjectRootInClaudeMd and ensureQuarantineReader write no hooks.
  pruneStaleHooksFromSettingsFile(agentSettingsPath(name))
  ensureAgentHooks(name)
  ensureAgentStalenessHook(name)
  ensureAgentProvenanceHook(name)
  ensureEgressGate(name)
  ensureBashEgressDeny(name, null)
  ensureBashEgressParser(name)
  ensureGovernanceGateCommands(name)
  ensureTelegramCopyGate(name)
  ensureChildClaudeGuard(name)
  ensureWebSearchEnvelope(name)
  ensureExtraHookEntries(name, NO_EXTRAS)
}

interface ProbeRun { file: string; hooks: RenderedHooks; fixpoint: boolean }

function runRealPath(name: string, opts: { profileId?: string; profile?: ProfileTemplate; capabilities?: string[] } = {}): ProbeRun {
  assertNotLive()
  const dir = join(AGENTS_BASE_DIR, name)
  if (existsSync(dir) && !existsSync(join(dir, MARKER))) throw new Error(`refusing: ${dir} exists and is not a probe`)
  removeProbe(dir)
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, MARKER), '')
  try {
    const settings = agentSettingsPath(name)
    // Seed: scaffoldAgentDir's settings branch (the function itself also writes CLAUDE.md, .mcp.json, skills).
    writeFileSync(settings, seedSettingsFromTemplate(resolveTemplatePlaceholders(readFileSync(TEMPLATE, 'utf-8')), ytDlpIngestOnly()))
    const profileId = opts.profileId ?? 'default'
    writeAgentSecurityProfile(name, profileId)
    if (opts.capabilities) {
      const cfgPath = join(dir, 'agent-config.json')
      writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, 'utf-8')), capabilities: opts.capabilities }))
    }
    const profile = opts.profile ?? loadProfileTemplate(profileId)
    writeAgentSettingsFromProfile(name, profile, NO_EXTRAS)
    bootBackfill(name)
    writeAgentSettingsFromProfile(name, profile, NO_EXTRAS)
    const file = readFileSync(settings, 'utf-8')
    bootBackfill(name)
    writeAgentSettingsFromProfile(name, profile, NO_EXTRAS)
    return { file, hooks: JSON.parse(file).hooks, fixpoint: readFileSync(settings, 'utf-8') === file }
  } finally {
    removeProbe(dir)
  }
}

/** The PreCompact prompt as the seed resolves it; botName replaces {{BOT_NAME}} first when given (the fixture's placeholder). */
function templatePrompt(botName?: string): string {
  const raw = readFileSync(TEMPLATE, 'utf-8')
  const text = botName === undefined ? raw : raw.replaceAll('{{BOT_NAME}}', botName)
  return JSON.parse(resolveTemplatePlaceholders(text)).hooks.PreCompact[0].hooks[0].prompt
}

function ctxFor(profile: Partial<ProfileTemplate> = {}, agent: RenderContext['agent'] = {}): RenderContext {
  return { root: PROJECT_ROOT, nodeBin: HOOK_NODE_BIN, profile, agent, prompts: { precompact: templatePrompt() } }
}

const DEFAULT = loadProfileTemplate('default')
const ALL_SWITCHES = { destructiveGate: true, credentialGate: true, secondReviewer: true } as const
const POLICY = senderRoleGatePolicyArg({ senderRoleGate: { riskyTools: ['Bash'] } })!

function expectSame(rendered: RenderedHooks, run: ProbeRun): void {
  expect(run.fixpoint).toBe(true)
  expect(rendered).toEqual(run.hooks)
  // Key order too: what a generator writing the file in C3-3 has to match.
  expect(JSON.stringify(rendered, null, 2)).toBe(JSON.stringify(run.hooks, null, 2))
}

describe('hook manifest, sub scope, against the real code path', () => {
  it('never runs against the live install', () => {
    expect(() => assertNotLive()).not.toThrow()
    expect(realpathSync(PROJECT_ROOT)).not.toBe(LIVE_INSTALL_ROOT)
  })

  for (const p of listProfileTemplates()) {
    it(`profile ${p.id}`, () => {
      expectSame(renderHooks(HOOK_MANIFEST, 'sub', ctxFor(p)), runRealPath(`${PROBE_PREFIX}${p.id}`, { profileId: p.id }))
    })
  }

  for (const [label, flags] of Object.entries({
    destructiveGate: { destructiveGate: true }, credentialGate: { credentialGate: true },
    secondReviewer: { secondReviewer: true }, all: ALL_SWITCHES,
  })) {
    it(`profile switch: ${label}`, () => {
      const profile = { ...DEFAULT, ...flags }
      expectSame(renderHooks(HOOK_MANIFEST, 'sub', ctxFor(profile)), runRealPath(`${PROBE_PREFIX}switch-${label}`, { profile }))
    })
  }

  it('the heartbeat agent (kanban-write and digest-provenance gates)', () => {
    // The heartbeat directory is shared with hook-sub-switch (parallel workers): one at a time.
    expectSame(renderHooks(HOOK_MANIFEST, 'sub', ctxFor(DEFAULT, { heartbeat: true })), withHeartbeatProbeLock(AGENTS_BASE_DIR, () => runRealPath(HEARTBEAT_AGENT_ID)))
  })

  it('the email thread-reply capability (flag on the email gate)', () => {
    const run = runRealPath(`${PROBE_PREFIX}thread-reply`, { capabilities: [EMAIL_THREAD_REPLY_CAPABILITY] })
    expectSame(renderHooks(HOOK_MANIFEST, 'sub', ctxFor(DEFAULT, { threadReply: true })), run)
    expect(run.file).toContain('email-send-gate.mjs\\" --allow-thread-reply')
  })

  // As a multiset: the injector appends at the end; in a real spawn the injectors after it
  // (child guard ... bash-egress-parser) re-append behind it, which is the place the layout gives it.
  it('the sender-role gate, injector level: on with a policy, off again', () => {
    const settings = JSON.parse(runRealPath(`${PROBE_PREFIX}sender-role`).file) as { hooks: RenderedHooks }
    injectSenderRoleGate(settings, POLICY)
    expect(sorted(flatten(renderHooks(HOOK_MANIFEST, 'sub', ctxFor(DEFAULT, { senderRolePolicy: POLICY }))))).toEqual(sorted(flatten(settings.hooks)))
    expect(JSON.stringify(settings.hooks)).toContain(`sender-role-gate.py\\" --policy ${POLICY}`)
    removeSenderRoleGate(settings)
    expect(renderHooks(HOOK_MANIFEST, 'sub', ctxFor(DEFAULT))).toEqual(settings.hooks)
  })
})

type FlatHook = Record<string, unknown>
function flatten(hooks: RenderedHooks): FlatHook[] {
  const out: FlatHook[] = []
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of groups ?? []) for (const h of g.hooks) out.push({ event, ...(g.matcher === undefined ? {} : { matcher: g.matcher }), ...h })
  }
  return out
}
const sorted = (xs: FlatHook[]): string[] => xs.map((x) => JSON.stringify(x, Object.keys(x).sort())).sort()

describe('hook manifest, sub scope, against the live shape', () => {
  // The fixture stays the live shape before C3-5 (the window's before side). The render differs from it only by
  // rewraps (the settings dry-run's own rule): 32 of the 39 hooks, nothing added or dropped (plan-c3-5.md 3a).
  it('renders the live sub-agents\' multiset up to 32 rewraps, nothing added or dropped (fixture, the pre-C3-5 shape)', () => {
    const ctx = { ...ctxFor(DEFAULT), prompts: { precompact: templatePrompt('${BOT_NAME}') } }
    const live = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as FlatHook[]
    expect(live).toHaveLength(39)
    const desanitise = (s: string) => s.replaceAll('${NODE_BIN}', HOOK_NODE_BIN).replaceAll('${ROOT}', PROJECT_ROOT)
    const placed = (hs: FlatHook[]): PlacedHook[] => hs.map(({ event, matcher, ...hook }) => ({
      event: String(event), ...(matcher === undefined ? {} : { matcher }),
      hook: Object.fromEntries(Object.entries(hook).map(([k, v]) => [k, typeof v === 'string' ? desanitise(v) : v])),
    }))
    const key = (p: PlacedHook) => JSON.stringify({ event: p.event, matcher: p.matcher, ...p.hook }, Object.keys({ event: 0, matcher: 0, ...p.hook }).sort())
    const before = placed(live)
    const after = placed(flatten(renderHooks(HOOK_MANIFEST, 'sub', ctx)))
    const minus = (xs: PlacedHook[], ys: PlacedHook[]) => {
      const left = ys.map(key)
      return xs.filter((x) => { const i = left.indexOf(key(x)); if (i < 0) return true; left.splice(i, 1); return false })
    }
    const r = pairRewraps(minus(before, after), minus(after, before))
    expect([r.pairs.length, r.dropped.length, r.added.length]).toEqual([32, 0, 0])
  })

  it('the playwright hook is rendered only for an agent with the browser capability (C3-3a)', () => {
    const e = HOOK_MANIFEST.entries.find((x) => x.id === 'browser-content-notice-playwright')!
    expect(e).toMatchObject({ agentFlag: 'browser', scope: 'sub', matcher: 'mcp__playwright__browser_.*', script: 'scripts/hooks/browser-content-notice.py' })
    const allOn = ctxFor(ALL_SWITCHES, { heartbeat: true, threadReply: true, senderRolePolicy: POLICY })
    for (const text of [JSON.stringify(renderHooks(HOOK_MANIFEST, 'sub', allOn)), readFileSync(FIXTURE, 'utf-8')]) {
      expect(text).not.toContain('mcp__playwright__')
    }
    const groups = renderHooks(HOOK_MANIFEST, 'sub', ctxFor(DEFAULT, { browser: true })).PostToolUse!
    expect(groups.filter((g) => g.matcher === 'mcp__playwright__browser_.*')).toEqual([{
      matcher: 'mcp__playwright__browser_.*',
      hooks: [{ type: 'command', command: `bash -c '[ -f "${PROJECT_ROOT}/scripts/hooks/browser-content-notice.py" ] && exec python3 "${PROJECT_ROOT}/scripts/hooks/browser-content-notice.py"; exit 0'`, timeout: 10 }],
    }])
  })
})

// The fail mode a command's own text gives it (Ron N1, sub wrappers), independent of the manifest's wrapper field.
const FAIL_CLOSED = /^(?:test -x "[^"]+"|command -v python3 >\/dev\/null 2>&1) \|\| \{ echo "[^"]*" >&2; exit 2; \}; .*rc=\$\?; \[ "\$rc" = 0 \] \|\| \[ "\$rc" = 2 \] \|\| \{ echo "[^"]*" >&2; exit 2; \}; exit "\$rc"$/
const SCRIPT_IN_COMMAND = /\/(scripts\/[\w./-]+\.(?:py|mjs|sh))/

function failModeFromText(event: string, hook: { type: string; command?: string }): FailMode {
  if (hook.type === 'agent') return 'advisory'
  const cmd = hook.command ?? ''
  if (FAIL_CLOSED.test(cmd)) return 'closed'
  if (cmd.startsWith("bash -c '[ -f \"") && cmd.endsWith("; exit 0'") && !cmd.includes('fleet-freeze.json')) return 'open'
  throw new Error(`unclassified wrapper under ${event}: ${cmd.slice(0, 120)}`)
}

// The generator's own ownership rule (event, script, ownMatchers): two entries share browser-content-notice.py.
function entryOf(event: string, matcher: string | undefined, hook: { type: string; command?: string }): HookManifestEntry {
  const e = ownerOf(HOOK_MANIFEST, event, matcher, hook)
  if (!e) throw new Error(`${event}: no entry owns ${SCRIPT_IN_COMMAND.exec(hook.command ?? '')?.[1] ?? hook.type}`)
  return e
}

describe('hook manifest failMode, sub scope', () => {
  function check(ctx: RenderContext): Record<FailMode, number> {
    const counts = { closed: 0, open: 0, advisory: 0 }
    const mismatches: string[] = []
    for (const h of flatten(renderHooks(HOOK_MANIFEST, 'sub', ctx)) as Array<{ event: string; matcher?: string; type: string; command?: string }>) {
      const actual = failModeFromText(h.event, h)
      const e = entryOf(h.event, h.matcher, h)
      counts[actual]++
      if (actual !== specFor(e, 'sub').failMode) mismatches.push(`${h.event} ${e.id}: wrapper says ${actual}, manifest says ${specFor(e, 'sub').failMode}`)
    }
    expect(mismatches).toEqual([])
    return counts
  }

  it('every sub hook of a default agent: 7 closed, 31 open, 1 advisory (39 settings entries)', () => {
    expect(check(ctxFor(DEFAULT))).toEqual({ closed: 7, open: 31, advisory: 1 })
  })

  it('with every condition on: 13 closed, 32 open, 1 advisory (46 settings entries)', () => {
    expect(check(ctxFor(ALL_SWITCHES, { heartbeat: true, threadReply: true, senderRolePolicy: POLICY, browser: true }))).toEqual({ closed: 13, open: 32, advisory: 1 })
  })

  it('counts the sub entries: 13 closed, 29 open, 1 advisory', () => {
    const counts = { closed: 0, open: 0, advisory: 0 }
    for (const e of HOOK_MANIFEST.entries.filter((x) => x.scope !== 'main')) counts[specFor(e, 'sub').failMode]++
    expect(counts).toEqual({ closed: 13, open: 29, advisory: 1 })
  })
})

describe('RenderContext.skip (the generator names the entries it does not render this time)', () => {
  it('drops exactly the named entries: a whole group, and one hook of a shared group', () => {
    const full = renderHooks(HOOK_MANIFEST, 'sub', ctxFor(DEFAULT))
    const skip = new Set(['egress-gate', 'staleness-guard'])
    const less = renderHooks(HOOK_MANIFEST, 'sub', { ...ctxFor(DEFAULT), skip })
    const gone = (h: FlatHook) => /\/(egress-gate\.mjs|staleness-guard\.py)\b/.test(String(h.command ?? ''))
    expect(flatten(full).filter(gone)).toHaveLength(2)
    expect(sorted(flatten(less))).toEqual(sorted(flatten(full).filter((h) => !gone(h))))
    // The shared UserPromptSubmit group stays one group, one hook shorter.
    expect(less.UserPromptSubmit).toHaveLength(1)
    expect(less.UserPromptSubmit![0].hooks).toHaveLength(full.UserPromptSubmit![0].hooks.length - 1)
    expect(less.PreToolUse!.some((g) => g.matcher === 'WebFetch')).toBe(false)
  })

  it('skipping every entry of a shared group drops the group, and an unknown or inactive id changes nothing', () => {
    const full = renderHooks(HOOK_MANIFEST, 'sub', ctxFor(DEFAULT))
    const stop = new Set(['telegram_progress_clear', 'slack_progress_clear'])
    const less = renderHooks(HOOK_MANIFEST, 'sub', { ...ctxFor(DEFAULT), skip: stop })
    expect(less.Stop).toHaveLength(full.Stop!.length - 1)
    expect(renderHooks(HOOK_MANIFEST, 'sub', { ...ctxFor(DEFAULT), skip: new Set(['no-such-id', 'destructive-gate']) })).toEqual(full)
  })
})

describe('hook manifest validation, sub scope', () => {
  const entries = [...HOOK_MANIFEST.entries]
  const withEntries = (es: HookManifestEntry[], layout = HOOK_MANIFEST.layout): HookManifest => ({ entries: es, layout })
  const replace = (id: string, patch: Partial<HookManifestEntry>) => entries.map((e) => (e.id === id ? { ...e, ...patch } : e))

  it('accepts the shipped manifest for both scopes', () => {
    expect(() => validateManifest(HOOK_MANIFEST, 'sub')).not.toThrow()
    expect(() => validateManifest(HOOK_MANIFEST, 'main')).not.toThrow()
  })

  it('two sub entries on one script and event need disjoint ownMatchers (the generator could not tell them apart)', () => {
    expect(() => validateManifest(withEntries(replace('browser-content-notice-playwright', { ownMatchers: undefined })), 'sub')).toThrow(/need disjoint ownMatchers/)
    expect(() => validateManifest(withEntries(replace('browser-content-notice-playwright', { ownMatchers: ['WebSearch'] })), 'sub')).toThrow(/need disjoint ownMatchers/)
  })

  it('offRemoves only on a conditional entry, ownMatchers only on a sub entry', () => {
    expect(() => validateManifest(withEntries(replace('self-pace-gate', { offRemoves: true })), 'sub')).toThrow(/offRemoves needs a profile or agent condition/)
    expect(() => validateManifest(withEntries(replace('ledger-capture', { ownMatchers: ['x'] })), 'sub')).toThrow(/ownMatchers is for sub-agent entries/)
    expect(() => validateManifest(withEntries(replace('self-pace-gate', { ownMatchers: [] })), 'sub')).toThrow(/empty ownMatchers/)
  })

  it('profile and agent conditions only on sub-only entries', () => {
    expect(() => validateManifest(withEntries(replace('egress-gate', { profileFlag: 'destructiveGate' })), 'sub')).toThrow(/sub-agent only/)
  })
})

describe('hook manifest render inputs (Ron N4)', () => {
  const bad = ["/root/x'y", '/root/x y', '/root/$HOME', '/root/`id`', 'relative/path', '/root/x"y', '/root/x\\y', '/root/x/']

  it('rejects a root that could break out of the single-quoted bash -c string, in both scopes', () => {
    for (const root of bad) {
      expect(() => renderHooks(HOOK_MANIFEST, 'sub', { ...ctxFor(DEFAULT), root })).toThrow(/ctx.root must be/)
      expect(() => renderHooks(HOOK_MANIFEST, 'main', { root })).toThrow(/ctx.root must be/)
    }
  })

  // Ron 13754: the node binary only ever stands inside double quotes, so its rule is wider than the root's.
  const badNodeBin = ['/root/x"y', '/root/$HOME', '/root/`id`', 'relative/path', '/root/x/', 'C:\\nodejs\\', '/root/x\ny', '']
  const goodNodeBin = ['/opt/homebrew/opt/node@22/bin/node', 'C:\\Program Files\\nodejs\\node.exe', '/Users/John Doe/.nvm/versions/node/v22.11.0/bin/node']

  it('accepts a node binary with @, a space, backslashes or a drive colon, and quotes it in every node gate', () => {
    for (const nodeBin of goodNodeBin) {
      const commands = flatten(renderHooks(HOOK_MANIFEST, 'sub', { ...ctxFor(DEFAULT), nodeBin })).map((h) => String(h.command ?? ''))
      const gates = commands.filter((c) => c.includes('.mjs"'))
      expect(gates).toHaveLength(6)
      for (const c of gates) expect(c.startsWith(`test -x "${nodeBin}" || `) && c.includes(`; then timeout -k 1 8 "${nodeBin}" "`)).toBe(true)
    }
  })

  it('rejects a bad node binary, and a sub render without root or node binary', () => {
    for (const nodeBin of badNodeBin) expect(() => renderHooks(HOOK_MANIFEST, 'sub', { ...ctxFor(DEFAULT), nodeBin })).toThrow(/ctx.nodeBin must be/)
    expect(() => renderHooks(HOOK_MANIFEST, 'sub', { ...ctxFor(DEFAULT), root: undefined })).toThrow(/needs ctx.root/)
    expect(() => renderHooks(HOOK_MANIFEST, 'sub', { ...ctxFor(DEFAULT), nodeBin: undefined })).toThrow(/ctx.nodeBin must be/)
  })

  it('still renders the main default ($CLAUDE_PROJECT_DIR) and a plain sub root', () => {
    expect(() => renderHooks(HOOK_MANIFEST, 'main')).not.toThrow()
    expect(() => renderHooks(HOOK_MANIFEST, 'sub', { ...ctxFor(DEFAULT), root: '/opt/marveen-1.2_x', nodeBin: '/usr/local/bin/node' })).not.toThrow()
  })

  it('rejects a sender-role policy that would need quoting, and a missing prompt', () => {
    expect(() => renderHooks(HOOK_MANIFEST, 'sub', ctxFor(DEFAULT, { senderRolePolicy: "x'; rm -rf /" }))).toThrow(/policy needs quoting/)
    expect(() => renderHooks(HOOK_MANIFEST, 'sub', { ...ctxFor(DEFAULT), prompts: {} })).toThrow(/needs ctx.prompts.precompact/)
  })
})
