// scripts/hooks/verify-gate-wiring.mjs, the entry points (Fork C settings-protect plan v2 points 3, 4 and 7, Ron K3,
// D2-REL-2, Johnny 17456): verifyGateWiring on a whole fake install, the report / enforce switch, the state file
// (alert once per state change, verified hashes) and the CLI the watchdog calls.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { HOOK_MANIFEST, renderHooks, type RenderContext } from '../web/hooks/manifest.js'
import { parseEnvContent } from '../env-parse.js'
// @ts-expect-error -- plain .mjs hook module, no types
import { parseEnvLikeDashboard, ENFORCE_KEYS } from '../../scripts/hooks/verify-gate-wiring.mjs'
// @ts-expect-error -- plain .mjs hook module, no types
import { verifyGateWiring, gateWiringMode, readEnforceEnv, recordState, writeFileAtomic, runCli, statusLineCommandsFor, INSTALL_ROOT, STATE_REL, ENFORCE_UNTIL_MAX_DAYS } from '../../scripts/hooks/verify-gate-wiring.mjs'
// @ts-expect-error -- plain .mjs hook module, no types
import { policySha256, senderRolePolicyFromGates, localRecord, agentDirRows } from '../../scripts/hooks/agent-settings-baseline.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOT = '/srv/marveen-inst'
const NODE = '/usr/local/bin/node'
const PROMPT = 'own prompt'
const nodeFs = { realpathSync: (p: string) => p, lstatSync: () => ({ mode: 0o40755 }) }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const hooksFor = (agent: RenderContext['agent'] = {}) =>
  JSON.parse(JSON.stringify(renderHooks(HOOK_MANIFEST, 'sub', { root: ROOT, nodeBin: NODE, profile: {}, agent, prompts: { precompact: PROMPT } })))
const tuple = (over: Record<string, unknown> = {}) => ({
  profileId: 'default', profile: { destructiveGate: false, credentialGate: false, secondReviewer: false },
  threadReply: false, browser: false, heartbeat: false, senderRolePolicySha256: null, nodeBin: NODE, ...over,
})

let base: string
let inst: string
let home: string
let ad: string
const LOCAL = `${JSON.stringify({ claudeMdExcludes: ['x'], permissions: { deny: ['Read(//root/x/**)'] } })}\n`
const writeJson = (p: string, v: unknown) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)) }
const baseline = (agents: Record<string, unknown>) => writeJson(join(inst, 'store', 'agent-settings-baseline.json'), { format: 'marveen-agent-settings-baseline/v1', isolated: [], agents })
const enrol = (over: Record<string, unknown> = {}, local: string | null = sha(LOCAL)) => baseline({ stuart: { switches: tuple(over), local: { sha256: local } } })
const verify = (o: Record<string, unknown> = {}) => verifyGateWiring('stuart', { installDir: inst, home, root: ROOT, fs: nodeFs, ...o })

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'verify-gate-wiring-entry-')))
  inst = join(base, 'inst')
  home = join(base, 'home')
  ad = join(inst, 'agents', 'stuart')
  writeJson(join(ad, '.claude', 'settings.json'), { hooks: hooksFor(), permissions: { allow: [], deny: [] }, effortLevel: 'high' })
  writeJson(join(ad, '.claude', 'settings.local.json'), LOCAL)
  writeJson(join(ad, '.claude-config', 'settings.json'), { enabledPlugins: { 'telegram@claude-plugins-official': true }, skipDangerousModePermissionPrompt: true })
  writeJson(join(home, '.claude', 'settings.json'), { enabledPlugins: { 'telegram@claude-plugins-official': true }, skipDangerousModePermissionPrompt: true })
  enrol()
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('verifyGateWiring on a fake install', () => {
  it('a baseline-matching agent is green, with the hashes of the very bytes it read', () => {
    const r = verify()
    expect(r).toMatchObject({ ok: true, errors: [], alerts: [] })
    expect(r.hashes.local).toBe(sha(LOCAL))
    expect(r.hashes.project).toBe(sha(readFileSync(join(ad, '.claude', 'settings.json'), 'utf-8')))
    expect(r.hashes.sharedLocal).toBeNull()
  })
  it('no baseline file, no entry, a broken baseline: no start, no default render', () => {
    rmSync(join(inst, 'store', 'agent-settings-baseline.json'))
    expect(verify().errors).toEqual(['baseline: missing (the main agent requests one; enrolment)'])
    baseline({})
    expect(verify().errors).toContain('baseline: no entry for this agent (the main agent requests one; enrolment)')
    writeJson(join(inst, 'store', 'agent-settings-baseline.json'), '{"format":"other"}')
    expect(verify().errors).toEqual(['baseline: unknown format'])
    baseline({ ['__proto__']: { switches: tuple() } })
    expect(verify().ok).toBe(false)
  })
  it('a bad agent name or a changed lock stops before anything is read', () => {
    expect(verifyGateWiring('../x', { installDir: inst, home }).errors).toEqual(['agent: not a plain agent name'])
    const lock = JSON.parse(readFileSync(join(REPO, 'scripts', 'hooks', 'sub-hooks.lock.json'), 'utf-8'))
    lock.layout.pop()
    writeJson(join(base, 'lock.json'), lock)
    expect(verify({ lockPath: join(base, 'lock.json') }).errors).toEqual(['sub-hooks lock: sha256 does not match its content'])
  })
  it('settings.local.json: byte-equal to the baseline record, or absent when the record is null', () => {
    writeJson(join(ad, '.claude', 'settings.local.json'), LOCAL.replace('x/**', 'y/**'))
    expect(verify().errors).toEqual(['.claude/settings.local.json: differs from the baseline (rebaseline needed)'])
    enrol({}, null)
    expect(verify().errors).toEqual(['.claude/settings.local.json: exists, the baseline records none (rebaseline needed)'])
    rmSync(join(ad, '.claude', 'settings.local.json'))
    expect(verify().ok).toBe(true)
    enrol({}, sha(LOCAL))
    expect(verify().errors).toEqual(['.claude/settings.local.json: differs from the baseline (rebaseline needed)'])
    baseline({ stuart: { switches: tuple() } })
    expect(verify().errors).toContain('baseline: no settings.local.json record')
  })
  it('K3 (e): with the full record the message names the change, a removed deny row first, never a value', () => {
    const before = `${JSON.stringify({ claudeMdExcludes: ['x'], env: { GH_CONFIG_DIR: join(ad, '.config', 'gh') }, permissions: { deny: ['Read(//root/x/**)', 'Bash(*agents/sally*)'] } })}\n`
    mkdirSync(join(ad, '.config', 'gh', 'other'), { recursive: true })
    writeJson(join(ad, '.claude', 'settings.local.json'), before)
    baseline({ stuart: { switches: tuple(), local: localRecord(before) } })
    expect(verify().ok).toBe(true)
    writeJson(join(ad, '.claude', 'settings.local.json'), `${JSON.stringify({ claudeMdExcludes: ['x'], env: { GH_CONFIG_DIR: join(ad, '.config', 'gh', 'other') }, permissions: { deny: ['Read(//root/x/**)'] } })}\n`)
    const errs = verify().errors
    expect(errs).toEqual(['.claude/settings.local.json: differs from the baseline (rebaseline needed): deny row removed: Bash(*agents/sally*)'])
    expect(errs.join('\n')).not.toContain('other')
  })
  it('K4 (g): an agent whose file lacks an isolated agent\'s rows does not pass, even when the hash matches', () => {
    const write = (o: unknown) => { const t = `${JSON.stringify(o)}\n`; writeJson(join(ad, '.claude', 'settings.local.json'), t); return t }
    const ok = write({ permissions: { deny: agentDirRows(inst, 'sally') } })
    writeJson(join(inst, 'store', 'agent-settings-baseline.json'), { format: 'marveen-agent-settings-baseline/v1', isolated: ['sally'], agents: { stuart: { switches: tuple(), local: localRecord(ok) } } })
    expect(verify().ok).toBe(true)
    const forgot = write({ permissions: { deny: agentDirRows(inst, 'sally').slice(0, 3) } })
    writeJson(join(inst, 'store', 'agent-settings-baseline.json'), { format: 'marveen-agent-settings-baseline/v1', isolated: ['sally'], agents: { stuart: { switches: tuple(), local: localRecord(forgot) } } })
    expect(verify().errors).toEqual(['isolation: stuart: missing deny row Bash(*agents/sally*) (sally is isolated)'])
    // the isolated agent itself owes every other baseline agent's rows and the owner credential rows
    writeJson(join(inst, 'store', 'agent-settings-baseline.json'), { format: 'marveen-agent-settings-baseline/v1', isolated: ['stuart'], agents: { stuart: { switches: tuple(), local: localRecord(forgot) }, kevin: {} } })
    const e = verify().errors
    expect(e).toHaveLength(1)
    expect(e[0]).toMatch(/^isolation: stuart: missing deny row Read\(\/\/.*\/agents\/kevin\/\*\*\) \(stuart is isolated\);/)
    expect(e[0]).toMatch(/; and \d+ more$/)
    // a baseline without the list is refused, not read as "nobody is isolated"
    writeJson(join(inst, 'store', 'agent-settings-baseline.json'), { format: 'marveen-agent-settings-baseline/v1', agents: { stuart: { switches: tuple(), local: localRecord(forgot) } } })
    expect(verify().errors).toEqual(['baseline: no valid isolated list'])
  })
  it('a live input changed the generated block, the baseline did not: mismatch (alert / no start)', () => {
    writeJson(join(ad, '.claude', 'settings.json'), { hooks: hooksFor({ threadReply: true }), permissions: { allow: [], deny: [] } })
    const r = verify()
    expect(r.ok).toBe(false)
    expect(r.errors.every((e: string) => e.startsWith('.claude/settings.json: hooks.'))).toBe(true)
  })
  it('symlinked directories or files are refused', () => {
    const real = join(base, 'elsewhere')
    mkdirSync(real)
    copyFileSync(join(ad, '.claude-config', 'settings.json'), join(real, 'settings.json'))
    rmSync(join(ad, '.claude-config'), { recursive: true })
    symlinkSync(real, join(ad, '.claude-config'))
    expect(verify().errors).toContain('.claude-config: is a symlink')
    rmSync(join(ad, '.claude-config'))
    mkdirSync(join(ad, '.claude-config'))
    symlinkSync(join(real, 'settings.json'), join(ad, '.claude-config', 'settings.json'))
    expect(verify().errors).toEqual(['.claude-config/settings.json: is a symlink'])
    rmSync(join(ad, '.claude'), { recursive: true })
    expect(verify().errors).toContain('.claude: missing')
  })
  it('the shared file: an unknown key alerts and does not stop; a disallowed env or hook switch does (K3 ii)', () => {
    writeJson(join(home, '.claude', 'settings.json'), { enabledPlugins: {}, someNewCliKey: 1 })
    expect(verify()).toMatchObject({ ok: true, alerts: ['~/.claude/settings.json: unknown key someNewCliKey'] })
    writeJson(join(home, '.claude', 'settings.json'), { env: { NODE_OPTIONS: '--require /x' } })
    expect(verify().errors).toEqual(['~/.claude/settings.json: env: not allowed in shared-user'])
    rmSync(join(home, '.claude', 'settings.json'))
    writeJson(join(home, '.claude', 'settings.local.json'), { disableAllHooks: true })
    expect(verify().errors).toEqual(['~/.claude/settings.local.json: disableAllHooks: not allowed in shared-user'])
  })
  it('an agent on the shared root (configDir null): only the shared file is its user scope', () => {
    writeJson(join(ad, '.claude-config', 'settings.json'), { disableAllHooks: true })
    expect(verify({ configDir: null }).ok).toBe(true)
    expect(verify().errors).toEqual(['.claude-config/settings.json: disableAllHooks: not allowed in agent-user'])
  })
  it('the isolated copy: the statusLine command derived from the install, the marketplaces equal to the shared file', () => {
    expect(statusLineCommandsFor('/root/marveen')).toEqual(['bash /root/marveen/scripts/statusline-ratelimit.sh'])
    writeJson(join(ad, '.claude-config', 'settings.json'), { statusLine: { type: 'command', command: `bash ${inst}/scripts/statusline-ratelimit.sh` } })
    expect(verify().ok).toBe(true)
    writeJson(join(ad, '.claude-config', 'settings.json'), { extraKnownMarketplaces: { own: {} } })
    expect(verify().errors).toEqual(['.claude-config/settings.json: extraKnownMarketplaces: differs from the shared file'])
    // the shared file has none: none is allowed; the same marketplace in both: green
    rmSync(join(home, '.claude', 'settings.json'))
    expect(verify().errors).toEqual(['.claude-config/settings.json: extraKnownMarketplaces: differs from the shared file'])
    writeJson(join(home, '.claude', 'settings.json'), { extraKnownMarketplaces: { own: {} } })
    expect(verify().ok).toBe(true)
  })
  it('a sender-role gate added after the baseline: rebaseline needed; with the matching hash: green', () => {
    const gates = '{"stuart":{"allowTools":["Bash"]}}'
    writeJson(join(inst, 'store', 'agent-sender-role-gates.json'), gates)
    expect(verify().errors).toEqual(['baseline: the sender-role policy changed since the baseline (rebaseline needed)'])
    const policy = senderRolePolicyFromGates(gates, 'stuart')
    enrol({ senderRolePolicySha256: policySha256(policy) })
    writeJson(join(ad, '.claude', 'settings.json'), { hooks: hooksFor({ senderRolePolicy: policy }), permissions: { allow: [], deny: [] } })
    expect(verify().ok).toBe(true)
  })
  it('the default install root is the checkout the verifier sits in', () => {
    expect(INSTALL_ROOT).toBe(realpathSync(REPO))
  })
})

describe('gateWiringMode: report by default, enforce on 1, a temporary 0 only with a capped date', () => {
  const now = new Date('2026-11-17T21:00:00Z')
  it('unset and empty: report (Johnny 17456)', () => {
    expect(gateWiringMode({}, now)).toEqual({ enforce: false, alert: null })
    expect(gateWiringMode({ GATE_WIRING_ENFORCE: '' }, now)).toEqual({ enforce: false, alert: null })
  })
  it('1: enforce', () => {
    expect(gateWiringMode({ GATE_WIRING_ENFORCE: '1' }, now)).toEqual({ enforce: true, alert: null })
  })
  it('0: report from today to today + the cap; no, a bad, a past or a too-far date: enforce with an alert', () => {
    expect(ENFORCE_UNTIL_MAX_DAYS).toBe(7)
    for (const until of ['2026-11-17', '2026-11-24']) expect(gateWiringMode({ GATE_WIRING_ENFORCE: '0', GATE_WIRING_ENFORCE_UNTIL: until }, now)).toEqual({ enforce: false, alert: null })
    for (const until of [undefined, '', '2026-11-16', '2026-11-25', '17.11.2026', '2026-11-17x']) {
      const m = gateWiringMode({ GATE_WIRING_ENFORCE: '0', GATE_WIRING_ENFORCE_UNTIL: until }, now)
      expect(m.enforce, String(until)).toBe(true)
      expect(m.alert).toContain('GATE_WIRING_ENFORCE_UNTIL')
    }
  })
  it('any other value: enforce with an alert (fail-closed)', () => {
    for (const v of ['yes', 'true', '2', ' 0']) expect(gateWiringMode({ GATE_WIRING_ENFORCE: v }, now)).toEqual({ enforce: true, alert: 'GATE_WIRING_ENFORCE has an unknown value; enforcing' })
  })
  it('Ron 17505 1c: the .env grammar is the dashboard\'s own (parity with src/env-parse.ts parseEnvContent)', () => {
    const cases = [
      'GATE_WIRING_ENFORCE = 1', 'GATE_WIRING_ENFORCE="0"\nGATE_WIRING_ENFORCE_UNTIL = \'2026-11-20\'', '  GATE_WIRING_ENFORCE=1  ',
      'GATE_WIRING_ENFORCE=1\nGATE_WIRING_ENFORCE=0', '# GATE_WIRING_ENFORCE=1', 'GATE_WIRING_ENFORCE', 'GATE_WIRING_ENFORCE="', 'GATE_WIRING_ENFORCE=a=b',
      'export GATE_WIRING_ENFORCE=1', 'GATE_WIRING_ENFORCE="1\'', 'OTHER=1\r\nGATE_WIRING_ENFORCE=1\r\n',
    ]
    for (const text of cases) expect(parseEnvLikeDashboard(text, [...ENFORCE_KEYS]), JSON.stringify(text)).toEqual(parseEnvContent(text, [...ENFORCE_KEYS]))
    writeFileSync(join(inst, '.env'), 'GATE_WIRING_ENFORCE = 1\n')
    expect(gateWiringMode(readEnforceEnv(inst), now)).toEqual({ enforce: true, alert: null })
  })
  it('Ron 17505 1b: no .env is report; an .env that exists but cannot be read is enforce with an alert', () => {
    expect(gateWiringMode(readEnforceEnv(inst), now).enforce).toBe(false)
    mkdirSync(join(inst, '.env'))
    expect(gateWiringMode(readEnforceEnv(inst), now)).toEqual({ enforce: true, alert: 'the install .env exists but cannot be read; enforcing' })
  })
  it('the switch is read from the install .env only, never from the caller\'s environment', () => {
    expect(readEnforceEnv(inst)).toEqual({})
    writeFileSync(join(inst, '.env'), 'WEB_PORT=3420\nGATE_WIRING_ENFORCE="0"\nGATE_WIRING_ENFORCE_UNTIL=\'2026-11-20\'\nOTHER=1\n')
    expect(readEnforceEnv(inst)).toEqual({ GATE_WIRING_ENFORCE: '0', GATE_WIRING_ENFORCE_UNTIL: '2026-11-20' })
    const saved = process.env.GATE_WIRING_ENFORCE
    process.env.GATE_WIRING_ENFORCE = '0'
    try {
      rmSync(join(inst, '.env'))
      expect(readEnforceEnv(inst)).toEqual({})
    } finally {
      if (saved === undefined) delete process.env.GATE_WIRING_ENFORCE
      else process.env.GATE_WIRING_ENFORCE = saved
    }
  })
})

describe('the state file (D2-REL-2)', () => {
  const ok = { ok: true, errors: [], alerts: [], hashes: { project: 'a', local: null, user: null, shared: null, sharedLocal: null } }
  const bad = { ok: false, errors: ['x: broken'], alerts: [], hashes: {} }
  it('alerts once per state change; the verified hashes move only on a green check', () => {
    const now = new Date('2026-11-17T21:00:00Z')
    expect(recordState(inst, 'stuart', ok, now)).toEqual({ changed: false })
    expect(recordState(inst, 'stuart', bad, now)).toEqual({ changed: true })
    expect(recordState(inst, 'stuart', bad, now)).toEqual({ changed: false })
    expect(recordState(inst, 'stuart', { ...bad, alerts: ['new key'] }, now)).toEqual({ changed: true })
    const s = JSON.parse(readFileSync(join(inst, STATE_REL), 'utf-8'))
    expect(s.agents.stuart.verified).toEqual({ at: now.toISOString(), hashes: ok.hashes })
    expect(recordState(inst, 'stuart', ok, now)).toEqual({ changed: true })
    expect(recordState(inst, 'dennis', bad, now)).toEqual({ changed: true })
    expect(Object.keys(JSON.parse(readFileSync(join(inst, STATE_REL), 'utf-8')).agents).sort()).toEqual(['dennis', 'stuart'])
  })
  it('written 0600 through a random temp, no temp left; a symlink at the target is replaced, not followed', () => {
    recordState(inst, 'stuart', ok)
    expect(statSync(join(inst, STATE_REL)).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(inst, 'store')).filter((f) => f.endsWith('.tmp'))).toEqual([])
    const victim = join(base, 'victim.txt')
    writeFileSync(victim, 'keep')
    const target = join(base, 'target.json')
    symlinkSync(victim, target)
    writeFileAtomic(target, 'new')
    expect(readFileSync(victim, 'utf-8')).toBe('keep')
    expect(lstatSync(target).isSymbolicLink()).toBe(false)
    expect(readFileSync(target, 'utf-8')).toBe('new')
  })
  it('a broken state file is rewritten (worst case one repeated alert)', () => {
    writeJson(join(inst, STATE_REL), '{broken')
    expect(recordState(inst, 'stuart', bad)).toEqual({ changed: true })
  })
})

describe('runCli: exit 0 starts, anything else does not', () => {
  const capture = () => { const out: string[] = []; return { out, stderr: { write: (s: string) => { out.push(s); return true } } } }
  const now = new Date('2026-11-17T21:00:00Z')
  it('usage errors: exit 2', () => {
    for (const argv of [[], ['--agent'], ['--agent', '../x'], ['--agent', 'stuart', '--extra'], ['--name', 'stuart']]) {
      const c = capture()
      expect(runCli(argv, { installDir: inst, home, now, stderr: c.stderr })).toBe(2)
    }
  })
  it('report mode: a problem is logged with NEW once, the agent still starts', () => {
    rmSync(join(inst, 'store', 'agent-settings-baseline.json'))
    const a = capture()
    expect(runCli(['--agent', 'stuart'], { installDir: inst, home, now, stderr: a.stderr })).toBe(0)
    expect(a.out.join('')).toBe('[GATE-WIRING] stuart report NEW: baseline: missing (the main agent requests one; enrolment)\n')
    const b = capture()
    expect(runCli(['--agent', 'stuart'], { installDir: inst, home, now, stderr: b.stderr })).toBe(0)
    expect(b.out.join('')).toBe('[GATE-WIRING] stuart report: baseline: missing (the main agent requests one; enrolment)\n')
  })
  it('enforce: a problem means exit 1 and NOT STARTED; an expired switch-off enforces and says so', () => {
    rmSync(join(inst, 'store', 'agent-settings-baseline.json'))
    writeFileSync(join(inst, '.env'), 'GATE_WIRING_ENFORCE=1\n')
    const c = capture()
    expect(runCli(['--agent', 'stuart'], { installDir: inst, home, now, stderr: c.stderr })).toBe(1)
    expect(c.out.join('')).toContain('[GATE-WIRING] stuart enforce NOT STARTED NEW: ')
    writeFileSync(join(inst, '.env'), 'GATE_WIRING_ENFORCE=0\nGATE_WIRING_ENFORCE_UNTIL=2026-11-01\n')
    const d = capture()
    expect(runCli(['--agent', 'stuart'], { installDir: inst, home, now, stderr: d.stderr })).toBe(1)
    expect(d.out.join('')).toContain('GATE_WIRING_ENFORCE=0 needs GATE_WIRING_ENFORCE_UNTIL')
  })
  it('an internal exception in the checks is a finding: report starts with the line, enforce does not (Ron 17563, suggestion 6)', () => {
    const throwingFs = { realpathSync: (p: string) => p, lstatSync: () => null }
    expect(() => verify({ fs: throwingFs })).toThrow(TypeError)
    const a = capture()
    expect(runCli(['--agent', 'stuart'], { installDir: inst, home, now, stderr: a.stderr, fs: throwingFs })).toBe(0)
    expect(a.out.join('')).toBe('[GATE-WIRING] stuart report NEW: verifier: an internal error (TypeError)\n')
    writeFileSync(join(inst, '.env'), 'GATE_WIRING_ENFORCE=1\n')
    const b = capture()
    expect(runCli(['--agent', 'stuart'], { installDir: inst, home, now, stderr: b.stderr, fs: throwingFs })).toBe(1)
    expect(b.out.join('')).toBe('[GATE-WIRING] stuart enforce NOT STARTED: verifier: an internal error (TypeError)\n')
    expect(existsSync(join(inst, STATE_REL))).toBe(true)
  })
  it('enforce with nothing wrong: exit 0, no output, the verified hashes recorded', () => {
    // the CLI expands the lock with the install as root (no root option on the watchdog path)
    writeJson(join(ad, '.claude', 'settings.json'), {
      hooks: JSON.parse(JSON.stringify(renderHooks(HOOK_MANIFEST, 'sub', { root: inst, nodeBin: NODE, profile: {}, agent: {}, prompts: { precompact: PROMPT } }))),
      permissions: { allow: [], deny: [] },
    })
    writeFileSync(join(inst, '.env'), 'GATE_WIRING_ENFORCE=1\n')
    const c = capture()
    const rc = runCli(['--agent', 'stuart'], { installDir: inst, home, now, stderr: c.stderr, fs: nodeFs })
    expect(c.out).toEqual([])
    expect(rc).toBe(0)
    expect(JSON.parse(readFileSync(join(inst, STATE_REL), 'utf-8')).agents.stuart.verified.hashes.local).toBe(sha(LOCAL))
  })
  it('as a process: the module runs its CLI only when executed directly, in the install it is copied into', () => {
    const hooks = join(inst, 'scripts', 'hooks')
    mkdirSync(hooks, { recursive: true })
    for (const f of ['verify-gate-wiring.mjs', 'sub-hooks-lock.mjs', 'settings-validator.mjs', 'agent-settings-baseline.mjs', 'sub-hooks.lock.json']) {
      copyFileSync(join(REPO, 'scripts', 'hooks', f), join(hooks, f))
    }
    rmSync(join(inst, 'store', 'agent-settings-baseline.json'))
    const r = spawnSync(process.execPath, [join(hooks, 'verify-gate-wiring.mjs'), '--agent', 'stuart'], { encoding: 'utf-8', env: { PATH: process.env.PATH, HOME: home, GATE_WIRING_ENFORCE: '1' } })
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('[GATE-WIRING] stuart report NEW: baseline: missing (the main agent requests one; enrolment)\n')
    expect(existsSync(join(inst, STATE_REL))).toBe(true)
    const u = spawnSync(process.execPath, [join(hooks, 'verify-gate-wiring.mjs')], { encoding: 'utf-8', env: { PATH: process.env.PATH, HOME: home } })
    expect(u.status).toBe(2)
  })
})
