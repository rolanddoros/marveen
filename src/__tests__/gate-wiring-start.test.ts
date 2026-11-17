// src/web/gate-wiring.ts + its call in startAgentProcess (Fork C settings-protect plan v2 point 3, Ron D2-REL-2):
// the dashboard's start path asks the PROTECTED verifier (loaded from the install's scripts/hooks/, never src/dist)
// right before tmux; only a clean start=true starts, a load failure or a throw does not; a NEW finding alerts once.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gateWiringBeforeStart, gateWiringSharedBeforeCopy, gateWiringVerifierPath, type GateWiringDeps } from '../web/gate-wiring.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let base: string
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'gate-wiring-start-'))) })
afterEach(() => rmSync(base, { recursive: true, force: true }))

const deps = (mod: unknown, sent: string[] = []): GateWiringDeps => ({
  installDir: '/inst',
  load: async (p: string) => { if (p !== '/inst/scripts/hooks/verify-gate-wiring.mjs') throw new Error(`unexpected path ${p}`); return mod as { checkBeforeStart?: unknown } },
  notify: async (t: string) => { sent.push(t) },
})

describe('gateWiringBeforeStart', () => {
  it('loads the verifier from the install\'s protected scripts/hooks/', () => {
    expect(gateWiringVerifierPath('/srv/m')).toBe('/srv/m/scripts/hooks/verify-gate-wiring.mjs')
  })
  it('passes the agent and its config dir; start=true starts, start=false does not', async () => {
    const calls: unknown[] = []
    const mod = { checkBeforeStart: (a: string, o: unknown) => { calls.push([a, o]); return { start: true, line: null, changed: false } } }
    expect(await gateWiringBeforeStart('alpha', '/a/.claude-config', deps(mod))).toEqual({ start: true, line: null })
    expect(calls).toEqual([['alpha', { installDir: '/inst', configDir: '/a/.claude-config' }]])
    const stop = { checkBeforeStart: () => ({ start: false, line: '[GATE-WIRING] alpha enforce NOT STARTED: x', changed: false }) }
    expect(await gateWiringBeforeStart('alpha', null, deps(stop))).toEqual({ start: false, line: '[GATE-WIRING] alpha enforce NOT STARTED: x' })
  })
  it('a NEW finding alerts the owner once; an unchanged one does not', async () => {
    const sent: string[] = []
    await gateWiringBeforeStart('alpha', null, deps({ checkBeforeStart: () => ({ start: true, line: '[GATE-WIRING] alpha report NEW: x', changed: true }) }, sent))
    await gateWiringBeforeStart('alpha', null, deps({ checkBeforeStart: () => ({ start: true, line: '[GATE-WIRING] alpha report: x', changed: false }) }, sent))
    expect(sent).toEqual(['⚠️ [GATE-WIRING] alpha report NEW: x'])
  })
  it('a verifier that cannot be loaded, has no entry point or throws: no start', async () => {
    const failing: GateWiringDeps = { installDir: '/inst', load: async () => { throw new Error('ENOENT') }, notify: async () => undefined }
    expect((await gateWiringBeforeStart('alpha', null, failing)).start).toBe(false)
    expect((await gateWiringBeforeStart('alpha', null, deps({}))).start).toBe(false)
    expect((await gateWiringBeforeStart('alpha', null, deps({ checkBeforeStart: () => { throw new Error('boom') } }))).start).toBe(false)
  })
  it('end to end with the real verifier copied into a fake install: report mode starts, enforce does not', async () => {
    const inst = join(base, 'inst')
    const hooks = join(inst, 'scripts', 'hooks')
    mkdirSync(hooks, { recursive: true })
    mkdirSync(join(inst, 'store'))
    for (const f of ['verify-gate-wiring.mjs', 'sub-hooks-lock.mjs', 'settings-validator.mjs', 'agent-settings-baseline.mjs', 'sub-hooks.lock.json']) {
      copyFileSync(join(REPO, 'scripts', 'hooks', f), join(hooks, f))
    }
    const real: GateWiringDeps = {
      installDir: inst,
      load: (p) => import(pathToFileURL(p).href) as Promise<{ checkBeforeStart?: unknown }>,
      notify: async () => undefined,
    }
    const r = await gateWiringBeforeStart('alpha', null, real)
    expect(r.start).toBe(true)
    expect(r.line).toContain('[GATE-WIRING] alpha report NEW: baseline: missing')
    writeFileSync(join(inst, '.env'), 'GATE_WIRING_ENFORCE=1\n')
    expect((await gateWiringBeforeStart('alpha', null, real)).start).toBe(false)
  })
})

describe('gateWiringSharedBeforeCopy (plan v2 point 4): the shared file before the isolated copy', () => {
  it('copy=false stops; a load failure or a missing entry point stops too', async () => {
    const mod = (copy: boolean) => ({ checkSharedBeforeCopy: () => ({ copy, line: copy ? null : '[GATE-WIRING] alpha enforce NOT STARTED: shared' }) })
    expect(await gateWiringSharedBeforeCopy('alpha', deps(mod(true)))).toEqual({ copy: true, line: null })
    expect((await gateWiringSharedBeforeCopy('alpha', deps(mod(false)))).copy).toBe(false)
    expect((await gateWiringSharedBeforeCopy('alpha', deps({}))).copy).toBe(false)
    expect((await gateWiringSharedBeforeCopy('alpha', { installDir: '/inst', load: async () => { throw new Error('x') }, notify: async () => undefined })).copy).toBe(false)
  })
  it('real verifier: a bad key in the shared file blocks the copy in enforce, not in report; a clean file copies', async () => {
    const inst = join(base, 'inst')
    const home = join(base, 'home')
    mkdirSync(join(inst, 'scripts', 'hooks'), { recursive: true })
    mkdirSync(join(home, '.claude'), { recursive: true })
    for (const f of ['verify-gate-wiring.mjs', 'sub-hooks-lock.mjs', 'settings-validator.mjs', 'agent-settings-baseline.mjs', 'sub-hooks.lock.json']) {
      copyFileSync(join(REPO, 'scripts', 'hooks', f), join(inst, 'scripts', 'hooks', f))
    }
    const mod = await import(pathToFileURL(join(inst, 'scripts', 'hooks', 'verify-gate-wiring.mjs')).href)
    const check = (o: Record<string, unknown> = {}) => mod.checkSharedBeforeCopy('alpha', { installDir: inst, home, ...o })
    expect(check()).toEqual({ copy: true, line: null })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { NODE_OPTIONS: '--require /x' } }))
    expect(check()).toEqual({ copy: true, line: '[GATE-WIRING] alpha report: shared settings, before the isolated copy: ~/.claude/settings.json: env: not allowed in shared-user' })
    writeFileSync(join(inst, '.env'), 'GATE_WIRING_ENFORCE=1\n')
    expect(check().copy).toBe(false)
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: {}, someNewCliKey: 1 }))
    expect(check()).toEqual({ copy: true, line: null })
    rmSync(join(home, '.claude', 'settings.json'))
    writeFileSync(join(home, '.claude', 'settings.local.json'), JSON.stringify({ hooks: {} }))
    expect(check().copy).toBe(false)
  })
})

describe('startAgentProcess calls it right before the sub-agent tmux start', () => {
  const SRC = readFileSync(join(REPO, 'src', 'web', 'agent-process.ts'), 'utf-8')
  const FN = SRC.slice(SRC.indexOf('export async function startAgentProcess('), SRC.indexOf('\n}\n', SRC.indexOf('export async function startAgentProcess(')))
  it('the gate sits between the scaffold write / provisioning and the first new-session, and returns on no start', () => {
    const gate = FN.indexOf('const gate = await gateWiringBeforeStart(name, claudeConfigDir ?? null)')
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeGreaterThan(FN.indexOf('writeAgentSettingsFromProfile(name, profile)'))
    expect(gate).toBeGreaterThan(FN.lastIndexOf('ensureIsolatedChannelConfigDir('))
    const firstStart = FN.indexOf("runTmux(startTarget, ['new-session'")
    expect(gate).toBeLessThan(firstStart)
    expect(FN.slice(gate, firstStart)).toContain("if (!gate.start) return { ok: false, error: gate.line ?? 'gate wiring: not started' }")
    expect(FN.slice(gate - 200, gate)).toContain('if (name !== MAIN_AGENT_ID) {')
  })
  it('the shared-file check is the first step of the provisioning block, before any isolated copy', () => {
    const block = FN.indexOf('if (!claudeConfigDir && (hasAnyChannel || needsFleetOauth || isOwnTeam) && name !== MAIN_AGENT_ID) {')
    const shared = FN.indexOf('const sharedGate = await gateWiringSharedBeforeCopy(name)')
    expect(block).toBeGreaterThan(0)
    expect(shared).toBeGreaterThan(block)
    expect(shared).toBeLessThan(FN.indexOf('ensureIsolatedChannelConfigDir(', block))
    expect(FN.slice(shared, FN.indexOf('ensureIsolatedChannelConfigDir(', block))).toContain("if (!sharedGate.copy) return { ok: false, error: sharedGate.line ?? 'gate wiring: shared settings' }")
    expect(FN.split('ensureIsolatedChannelConfigDir(').length - 1).toBe(3)
  })
})
