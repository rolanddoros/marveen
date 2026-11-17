// scripts/hooks/verify-gate-wiring.mjs, the checks (Fork C settings-protect plan v2 point 3, addendum 1 D2-SEC-1,
// Ron 17402 K1): a sub-agent's hooks block must equal the protected lock's block; a block written from a changed
// manifest is a mismatch, not a match; the settings files go through the one validator and may not be symlinks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { HOOK_MANIFEST, renderHooks, type HookManifest, type RenderContext } from '../web/hooks/manifest.js'
// @ts-expect-error -- plain .mjs hook module, no types
import { loadLock, readSettingsFile, checkHooksBlock, checkAgentFiles, precompactPromptOf, switchesFromBaseline, LOCK_PATH, EXTRA_HOOK_MARK, PRECOMPACT_PROMPT_MAX } from '../../scripts/hooks/verify-gate-wiring.mjs'
// @ts-expect-error -- plain .mjs hook module, no types
import { policySha256, senderRolePolicyFromGates } from '../../scripts/hooks/agent-settings-baseline.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOT = '/srv/marveen-inst'
const NODE = '/usr/local/bin/node'
const PROMPT = 'own prompt'
type Block = Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>
const sw = { root: ROOT, nodeBin: NODE, profile: {}, heartbeat: false, browser: false, threadReply: false, senderRolePolicy: null }
const ctxOf = (over: Partial<RenderContext> = {}): RenderContext => ({ root: ROOT, nodeBin: NODE, profile: {}, agent: {}, prompts: { precompact: PROMPT }, ...over })
const written = (m: HookManifest = HOOK_MANIFEST, over: Partial<RenderContext> = {}) => JSON.parse(JSON.stringify(renderHooks(m, 'sub', ctxOf(over)))) as Block
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

let base: string
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'verify-gate-wiring-'))) })
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('the lock', () => {
  it('is the protected file next to the verifier, and loads with its sha256 checked', () => {
    expect(LOCK_PATH).toBe(join(REPO, 'scripts', 'hooks', 'sub-hooks.lock.json'))
    expect(loadLock().format).toBe('marveen-sub-hooks-lock/v1')
  })
  it('a lock whose content changed, or that cannot be read, is refused (the agent does not start)', () => {
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf-8'))
    lock.entries['destructive-gate'].hook.timeout = 1
    const p = join(base, 'lock.json')
    writeFileSync(p, JSON.stringify(lock))
    expect(() => loadLock(p)).toThrow('sha256 does not match its content')
    expect(() => loadLock(join(base, 'missing.json'))).toThrow('cannot be read')
  })
})

describe('checkHooksBlock', () => {
  it('a block the dashboard wrote from the manifest is green, for the default and a switched agent', () => {
    const lock = loadLock()
    expect(checkHooksBlock(written(), lock, sw)).toEqual([])
    const on = { profile: { destructiveGate: true }, heartbeat: true, browser: true, threadReply: true, senderRolePolicy: 'cG9saWN5' }
    expect(checkHooksBlock(written(HOOK_MANIFEST, { profile: on.profile, agent: { heartbeat: true, browser: true, threadReply: true, senderRolePolicy: 'cG9saWN5' } }), lock, { ...sw, ...on })).toEqual([])
  })
  it('K1 mutant: a block written from a changed compiled manifest is a mismatch', () => {
    const lock = loadLock()
    const loosened: HookManifest = { ...HOOK_MANIFEST, entries: HOOK_MANIFEST.entries.map((e) => (e.id === 'email-send-gate' ? { ...e, args: ['--allow-thread-reply'] } : e)) }
    const errs = checkHooksBlock(written(loosened), lock, sw)
    expect(errs.length).toBeGreaterThan(0)
    expect(errs.every((e: string) => /^hooks\.PreToolUse\[\d+\]: differs from the lock$/.test(e))).toBe(true)
  })
  it('a dropped group, an added group, a changed timeout, an unexpected event, a missing event', () => {
    const lock = loadLock()
    const b = written()
    const dropped = clone(b); dropped.PreToolUse.splice(1, 1)
    expect(checkHooksBlock(dropped, lock, sw)[0]).toMatch(/^hooks\.PreToolUse: \d+ groups, expected \d+$/)
    const added = clone(b); added.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] })
    expect(checkHooksBlock(added, lock, sw)).toContain(`hooks.PreToolUse: ${b.PreToolUse.length + 1} groups, expected ${b.PreToolUse.length}`)
    const timeout = clone(b); timeout.PreToolUse[0].hooks[0].timeout = 999
    expect(checkHooksBlock(timeout, lock, sw)).toEqual(['hooks.PreToolUse[0]: differs from the lock'])
    expect(checkHooksBlock({ ...clone(b), Notification: [] }, lock, sw)).toEqual(['hooks.Notification: not expected'])
    const missing = clone(b) as Record<string, unknown>; delete missing.Stop
    expect(checkHooksBlock(missing, lock, sw)).toEqual(['hooks.Stop: missing'])
    expect(checkHooksBlock(null, lock, sw)).toEqual(['hooks: missing or not an object'])
  })
  it('the switches decide: a gate missing for a switched agent is a mismatch', () => {
    const lock = loadLock()
    expect(checkHooksBlock(written(), lock, { ...sw, profile: { destructiveGate: true } }).length).toBeGreaterThan(0)
  })
  it('a group marked as an extra hook is refused (no extras on this verifier)', () => {
    const b = written()
    b.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: `${EXTRA_HOOK_MARK} true` }] })
    expect(checkHooksBlock(b, loadLock(), sw)).toContain('hooks: a group marked as an extra hook (this verifier accepts none)')
  })
  it('the PreCompact prompt is the agent\'s own text; key order inside a hook does not matter', () => {
    const b = written(HOOK_MANIFEST, { prompts: { precompact: 'another prompt' } })
    expect(precompactPromptOf(b)).toBe('another prompt')
    expect(checkHooksBlock(b, loadLock(), sw)).toEqual([])
    const reordered = clone(b)
    reordered.PreToolUse[0].hooks[0] = Object.fromEntries(Object.entries(reordered.PreToolUse[0].hooks[0]).reverse())
    expect(checkHooksBlock(reordered, loadLock(), sw)).toEqual([])
  })
  it('a root that would break quoting is refused, not matched', () => {
    expect(checkHooksBlock(written(), loadLock(), { ...sw, root: '/a"b' })[0]).toMatch(/^hooks: the expected block cannot be built/)
  })
})

describe('readSettingsFile', () => {
  it('missing = null; a symlink, a directory or invalid JSON throws without the content', () => {
    expect(readSettingsFile(join(base, 'none.json'), 'x')).toBeNull()
    writeFileSync(join(base, 'ok.json'), '{"a":1}')
    expect(readSettingsFile(join(base, 'ok.json'), 'x')).toEqual({ a: 1 })
    symlinkSync(join(base, 'ok.json'), join(base, 'link.json'))
    expect(() => readSettingsFile(join(base, 'link.json'), '.claude/settings.json')).toThrow('.claude/settings.json: is a symlink')
    mkdirSync(join(base, 'dir.json'))
    expect(() => readSettingsFile(join(base, 'dir.json'), 'x')).toThrow('x: is not a regular file')
    writeFileSync(join(base, 'bad.json'), '{"secret": "sk-ant-123"')
    let msg = ''
    try { readSettingsFile(join(base, 'bad.json'), 'x') } catch (e) { msg = (e as Error).message }
    expect(msg).toBe('x: is not valid JSON')
  })
})

describe('checkAgentFiles', () => {
  const project = () => ({ permissions: { allow: [], deny: [] }, hooks: written(), claudeMdExcludes: [] })
  it('green files are green; each file\'s validator errors are named by file; unknown user keys alert', () => {
    const lock = loadLock()
    expect(checkAgentFiles({ project: project(), local: null, user: null }, lock, sw, {})).toEqual({ ok: true, errors: [], alerts: [] })
    const r = checkAgentFiles({ project: { ...project(), env: {} }, local: { env: { NODE_OPTIONS: '--require x' } }, user: { newKey: 1, hooks: {} } }, lock, sw, {})
    expect(r.ok).toBe(false)
    expect(r.errors).toEqual([
      '.claude/settings.json: env: not allowed in agent-project',
      '.claude/settings.local.json: env.NODE_OPTIONS: not an allowed name',
      '.claude-config/settings.json: hooks: not allowed in agent-user',
    ])
    expect(r.alerts).toEqual(['.claude-config/settings.json: unknown key newKey'])
  })
  it('a missing project settings file is an error', () => {
    expect(checkAgentFiles({ project: null, local: null, user: null }, loadLock(), sw, {}).errors).toEqual(['.claude/settings.json: missing'])
  })
})

describe('PreCompact (Ron 17451 N2-3): exactly one agent hook, all but the prompt from the lock, prompt capped', () => {
  const lock = () => loadLock()
  const pc = (b: Block) => b.PreCompact[0]
  it('one agent hook with a prompt of 1 to the cap is green; the cap is stated', () => {
    expect(PRECOMPACT_PROMPT_MAX).toBe(16384)
    expect(checkHooksBlock(written(HOOK_MANIFEST, { prompts: { precompact: 'x'.repeat(PRECOMPACT_PROMPT_MAX) } }), lock(), sw)).toEqual([])
  })
  it('an empty or over-cap prompt, a second hook, a command hook in its place, a second group: refused', () => {
    const msg = `hooks.PreCompact: not exactly one agent hook with a prompt of 1 to ${PRECOMPACT_PROMPT_MAX} characters`
    const empty = written(HOOK_MANIFEST, { prompts: { precompact: 'x' } }); pc(empty).hooks[0].prompt = ''
    const long = written(HOOK_MANIFEST, { prompts: { precompact: 'x'.repeat(PRECOMPACT_PROMPT_MAX + 1) } })
    const two = written(); pc(two).hooks.push({ type: 'agent', prompt: 'second' })
    const cmd = written(); pc(cmd).hooks[0] = { ...pc(cmd).hooks[0], type: 'command', command: 'true' }
    const groups = written(); groups.PreCompact.push(clone(pc(groups)))
    for (const b of [empty, long, two, cmd, groups]) expect(checkHooksBlock(b, lock(), sw)).toContain(msg)
  })
  it('the matcher and timeout still come from the lock', () => {
    const b = written(); pc(b).hooks[0].timeout = 5
    expect(checkHooksBlock(b, lock(), sw)).toEqual(['hooks.PreCompact[0]: differs from the lock'])
    const m = written(); pc(m).matcher = 'manual'
    expect(checkHooksBlock(m, lock(), sw)).toEqual(['hooks.PreCompact[0]: differs from the lock'])
  })
})

describe('switchesFromBaseline (Ron 17451 N1 direction, N2-1, N2-4): the baseline tuple selects, never the live inputs', () => {
  const nodeFs = { realpathSync: (p: string) => p, lstatSync: () => ({ mode: 0o40755 }) }
  const tuple = (over: Record<string, unknown> = {}) => ({
    profileId: 'default', profile: { destructiveGate: false, credentialGate: false, secondReviewer: false },
    threadReply: false, browser: false, heartbeat: false, senderRolePolicySha256: null, nodeBin: NODE, ...over,
  })
  const opts = (over: Record<string, unknown> = {}) => ({ installDir: ROOT, gatesText: null, fs: nodeFs, ...over })
  it('a good entry gives the switches; the block rendered with them is green', () => {
    const r = switchesFromBaseline('stuart', { switches: tuple() }, opts())
    expect(r.errors).toEqual([])
    expect(r.sw).toEqual({ ...sw, profile: { destructiveGate: false, credentialGate: false, secondReviewer: false } })
    expect(checkHooksBlock(written(), loadLock(), r.sw)).toEqual([])
  })
  it('the live render follows a changed live input, the baseline does not: mismatch until a rebaseline', () => {
    const r = switchesFromBaseline('stuart', { switches: tuple({ profile: { destructiveGate: true, credentialGate: true, secondReviewer: false } }) }, opts())
    expect(checkHooksBlock(written(), loadLock(), r.sw).length).toBeGreaterThan(0)
    const t = switchesFromBaseline('stuart', { switches: tuple() }, opts())
    expect(checkHooksBlock(written(HOOK_MANIFEST, { agent: { threadReply: true } }), loadLock(), t.sw).length).toBeGreaterThan(0)
  })
  it('no entry, or a tuple naming no lock combination: no switches, no default render (N2-4)', () => {
    expect(switchesFromBaseline('stuart', undefined, opts())).toEqual({ sw: null, errors: ['baseline: no entry for this agent (the main agent requests one; enrolment)'] })
    for (const bad of [tuple({ extra: true }), tuple({ browser: 'no' }), tuple({ heartbeat: true }), { ...tuple(), profile: {} }]) {
      const r = switchesFromBaseline('stuart', { switches: bad }, opts())
      expect(r.sw).toBeNull()
      expect(r.errors.length).toBeGreaterThan(0)
    }
  })
  it('the sender-role policy comes from the protected gates file and must match the baseline hash', () => {
    const gates = '{"stuart":{"allowTools":["Bash"]}}'
    const policy = senderRolePolicyFromGates(gates, 'stuart')
    const ok = switchesFromBaseline('stuart', { switches: tuple({ senderRolePolicySha256: policySha256(policy) }) }, opts({ gatesText: gates }))
    expect(ok.errors).toEqual([])
    expect(ok.sw.senderRolePolicy).toBe(policy)
    expect(checkHooksBlock(written(HOOK_MANIFEST, { agent: { senderRolePolicy: policy } }), loadLock(), ok.sw)).toEqual([])
    const changed = switchesFromBaseline('stuart', { switches: tuple({ senderRolePolicySha256: policySha256(policy) }) }, opts({ gatesText: '{"stuart":{"allowTools":["Read"]}}' }))
    expect(changed).toEqual({ sw: null, errors: ['baseline: the sender-role policy changed since the baseline (rebaseline needed)'] })
    expect(switchesFromBaseline('stuart', { switches: tuple() }, opts({ gatesText: gates })).sw).toBeNull()
  })
  it('the node binary comes from the baseline and is checked (N2-1)', () => {
    const r = switchesFromBaseline('stuart', { switches: tuple({ nodeBin: `${ROOT}/agents/stuart/node` }) }, opts())
    expect(r).toEqual({ sw: null, errors: ['baseline: nodeBin: under the install\'s agents/'] })
  })
})
