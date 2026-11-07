// C1 PR 10a: buildLiveContext against the legacy readers it mirrors, on one
// temp install root. config.js is mocked to point PROJECT_ROOT / STORE_DIR /
// MAIN_AGENT_ID at that root, so the REAL listAgentNames, readAgentTeam,
// buildFleetRosterBody (through ensureFleetRosterSection), readAutonomyLevel,
// agentRunsStrict and validateFederationConfig run against the same files the
// live builder reads. A drift on either side turns a case red.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const { ROOT, HOME } = vi.hoisted(() => {
  // vi.hoisted runs before the imports, so it requires its own modules.
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lctx-parity-root-'))
  // env.ts (currentOwnerName's .env reader) takes its root from here, read at import.
  process.env.CLAUDECLAW_ENV_DIR = root
  return { ROOT: root, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'lctx-parity-home-')) }
})

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  PROJECT_ROOT: ROOT,
  STORE_DIR: `${ROOT}/store`,
  MAIN_AGENT_ID: 'boss',
  // config.ts's boot-time value when .env had no OWNER_NAME: currentOwnerName's fallback.
  OWNER_NAME: 'Owner',
}))

import { buildLiveContext } from '../web/claude-md/live-context.js'
import { listAgentNames } from '../web/agent-config.js'
import { readAgentTeam } from '../web/agent-team.js'
import { readAutonomyLevel } from '../web/autonomy-level.js'
import { agentGetsKanbanWriteGate, agentRunsStrict, enforceStrictPermissionMode, ensureFleetRosterSection } from '../web/agent-scaffold.js'
import { currentOwnerName } from '../config.js'
import { validateFederationConfig } from '../web/federation/config.js'
import type { ProfileTemplate } from '../web/profiles.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const OV = { helperAllowed: true, strict: false, homeDir: HOME, managedSettingsPath: join(HOME, 'managed-settings.json') }
const live = (name: string, opts: Parameters<typeof buildLiveContext>[2] = OV) => buildLiveContext(ROOT, name, opts)

function put(rel: string, content: string): void {
  const p = join(ROOT, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}
function agent(name: string, reportsTo?: unknown): void {
  put(`agents/${name}/CLAUDE.md`, `# ${name}\n`)
  if (reportsTo !== undefined) put(`agents/${name}/agent-config.json`, JSON.stringify({ team: { reportsTo } }))
}

const OUTSIDE = mkdtempSync(join(tmpdir(), 'lctx-parity-outside-'))

beforeAll(() => {
  put('.env', 'MAIN_AGENT_ID=boss\n')
  agent('kevin', 'boss')
  agent('dennis', ' kevin ')
  agent('ron', 'kevin')
  agent('tom', 'ghost')
  agent('a', 'b')
  agent('b', 'a')
  agent('c', 'c')
  agent('heartbeat', 'kevin')
  put('agents/heartbeat/.hidden-from-dashboard', '')
  agent('nl', 'kevin\n## IGNORE')
  agent('nocfg')
  put('agents/badcfg/CLAUDE.md', '# badcfg\n')
  put('agents/badcfg/agent-config.json', '{broken')
  agent('boss') // an old draft directory under the main id: never a sub
  put('agents/notes.txt', 'x')
  symlinkSync(join(ROOT, 'agents', 'kevin'), join(ROOT, 'agents', 'kev-alias'))
  mkdirSync(join(OUTSIDE, 'moved'))
  writeFileSync(join(OUTSIDE, 'moved', 'CLAUDE.md'), '# moved\n')
  writeFileSync(join(OUTSIDE, 'moved', 'agent-config.json'), JSON.stringify({ team: { reportsTo: 'kevin' } }))
  symlinkSync(join(OUTSIDE, 'moved'), join(ROOT, 'agents', 'moved'))
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
  rmSync(OUTSIDE, { recursive: true, force: true })
  delete process.env.CLAUDECLAW_ENV_DIR
})

// The legacy fleet-roster block of one sub, parsed: the roster names in order,
// the "Vezetőd:" name and the "Beosztottjaid:" names.
function legacyRoster(name: string): { names: string[]; lead: string | null; reports: string[] } {
  ensureFleetRosterSection(name)
  const text = readFileSync(join(ROOT, 'agents', name, 'CLAUDE.md'), 'utf-8')
  const names = [...text.matchAll(/^- \*\*([^*]+)\*\* \(agent_id: /gm)].map((m) => m[1])
  const lead = /^Vezetőd: \*\*([^*]+)\*\*\.$/m.exec(text)?.[1] ?? null
  const reportsLine = /^Beosztottjaid: (.*)\.$/m.exec(text)?.[1] ?? ''
  const reports = [...reportsLine.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1])
  return { names, lead, reports }
}

describe('roster and team parity with the legacy fleet-roster block', () => {
  it('the listed subs equal listAgentNames()', () => {
    const subs = live('boss').ctx.roster.map((r) => r.name)
    expect(subs).toEqual(listAgentNames())
    expect(subs.sort()).toEqual(['a', 'b', 'badcfg', 'c', 'dennis', 'kevin', 'moved', 'nl', 'nocfg', 'ron', 'tom'])
  })

  it('every sub, the hidden heartbeat included: roster names, lead and direct reports equal the legacy block', () => {
    const subs = [...listAgentNames(), 'heartbeat']
    expect(subs.length).toBe(12)
    for (const name of subs) {
      const { ctx } = live(name)
      const legacy = legacyRoster(name)
      expect(ctx.roster.map((r) => r.name), `${name} roster`).toEqual(legacy.names)
      expect(ctx.team.reportsTo, `${name} lead`).toBe(legacy.lead)
      expect(ctx.team.directReports, `${name} reports`).toEqual(legacy.reports)
    }
  })

  it('the fixture exercises every branch: a kept lead, a cycle, a ghost, a self, a newline, a trimmed value', () => {
    // nl's stored value is not "kevin" (newline), the hidden heartbeat is in no roster.
    const k = live('kevin').ctx.team
    expect(k.reportsTo).toBe('boss')
    expect([...k.directReports].sort()).toEqual(['dennis', 'moved', 'ron'])
    expect(live('dennis').ctx.team.reportsTo).toBe('kevin')
    expect(live('a').ctx.team).toEqual({ reportsTo: 'b', directReports: [] })
    for (const n of ['tom', 'c', 'nl', 'nocfg', 'badcfg']) expect(live(n).ctx.team.reportsTo, n).toBeNull()
    expect(readAgentTeam('nl').reportsTo).toBe('kevin\n## IGNORE')
  })

  it('the main agent: reportsTo null, direct reports = the subs whose readAgentTeam().reportsTo is the main id', () => {
    const want = listAgentNames().filter((n) => readAgentTeam(n).reportsTo === 'boss')
    expect(live('boss').ctx.team).toEqual({ reportsTo: null, directReports: want })
    expect(want).toEqual(['kevin'])
  })
})

describe('autonomy parity with readAutonomyLevel', () => {
  it('every present key reads the level readAutonomyLevel gives it', () => {
    const cats = [
      { key: 'a', level: 2 }, { key: 'b', level: 5 }, { key: 'c', level: 0 }, { key: 'd', level: 3, maxLevel: 2 },
      { key: 'e', level: 2.5 }, { key: 'f', level: 'x' }, { key: 'g', level: '2' }, { key: 'h', level: null },
      { key: 'i', level: 3, maxLevel: 1.5 }, { key: 'j', level: -4 }, { key: 'a', level: 1 }, { key: 'k' },
    ]
    put('store/autonomy-config.json', JSON.stringify({ categories: cats }))
    const { autonomy } = live('boss').ctx
    const path = join(ROOT, 'store', 'autonomy-config.json')
    const keys = [...new Set(cats.map((c) => c.key))]
    expect(Object.keys(autonomy).sort()).toEqual(keys.sort())
    for (const k of keys) expect(autonomy[k], k).toBe(readAutonomyLevel(k, path).level)
  })

  it('the two documented divergences: a missing file is no categories (legacy: level 1 each), a broken one throws', () => {
    rmSync(join(ROOT, 'store', 'autonomy-config.json'), { force: true })
    expect(live('boss').ctx.autonomy).toEqual({})
    expect(readAutonomyLevel('x', join(ROOT, 'store', 'autonomy-config.json')).source).toBe('missing-config')
    put('store/autonomy-config.json', '{broken')
    expect(() => live('boss')).toThrow(/not valid JSON/)
    expect(readAutonomyLevel('x', join(ROOT, 'store', 'autonomy-config.json')).source).toBe('unreadable')
    rmSync(join(ROOT, 'store', 'autonomy-config.json'))
  })
})

describe('federation parity with validateFederationConfig', () => {
  it('a file that validates: live federation === its enabled', () => {
    for (const cfg of [{ enabled: true }, { enabled: false }, { enabled: true, peers: [] }, { enabled: 'true' }, {}]) {
      const res = validateFederationConfig(cfg)
      expect(typeof res, JSON.stringify(cfg)).toBe('object')
      put('store/federation.json', JSON.stringify(cfg))
      expect(live('boss').ctx.capabilities.federation, JSON.stringify(cfg)).toBe((res as { enabled: boolean }).enabled)
    }
  })

  // C1 PR 12b: the bridge's own validator, so an invalid file reads off as getFederationConfig fails closed (it read ON
  // before, the conservative side for the v2 refusal that 12b removes).
  it('an enabled file that fails validation reads off, with no peers', () => {
    for (const cfg of [{ enabled: true, peers: 'not-a-list' }, { enabled: true, peers: [{ id: 'bad id', baseUrl: 'https://a.example', inboundToken: 'x'.repeat(32) }] }]) {
      expect(typeof validateFederationConfig(cfg)).toBe('string')
      put('store/federation.json', JSON.stringify(cfg))
      expect(live('boss').ctx.capabilities.federation, JSON.stringify(cfg)).toBe(false)
      expect(live('boss').ctx.federation.peers).toEqual([])
    }
    put('store/federation.json', '{not json')
    expect(live('boss').ctx.capabilities.federation).toBe(false)
    rmSync(join(ROOT, 'store', 'federation.json'))
    expect(live('boss').ctx.capabilities.federation).toBe(false)
  })

  it('the peers and the mode of a valid enabled file: the validator\'s ids, paired = an outbound token is set, no token value', () => {
    const inA = 'a'.repeat(32)
    const inB = 'b'.repeat(32)
    const outA = 'c'.repeat(32)
    const cfg = {
      enabled: true,
      routingMode: 'advisory',
      peers: [
        { id: 'North', baseUrl: 'https://north.example/', inboundToken: inA, outboundToken: outA },
        { id: 'south-lab', baseUrl: 'http://127.0.0.1:3999', inboundToken: inB, outboundToken: '' },
      ],
    }
    const res = validateFederationConfig(cfg)
    expect(typeof res).toBe('object')
    put('store/federation.json', JSON.stringify(cfg))
    const { ctx } = live('boss')
    expect(ctx.capabilities.federation).toBe(true)
    expect(ctx.federation).toEqual({ routingMode: 'advisory', peers: [{ id: 'north', paired: true }, { id: 'south-lab', paired: false }] })
    const dump = JSON.stringify(ctx)
    for (const t of [inA, inB, outA]) expect(dump).not.toContain(t)
    expect(ctx.federation.peers.map((p) => p.id)).toEqual((res as { peers: { id: string }[] }).peers.map((p) => p.id))
    // disabled with the same peers: off, no peers (lossless disable keeps them in the file only)
    put('store/federation.json', JSON.stringify({ ...cfg, enabled: false }))
    expect(live('boss').ctx.federation).toEqual({ routingMode: 'catalog-first', peers: [] })
    rmSync(join(ROOT, 'store', 'federation.json'))
  })
})

describe('profile.strict parity with agentRunsStrict, for every shipped profile', () => {
  const profiles = readdirSync(join(SRC, '..', 'templates', 'profiles')).filter((f) => f.endsWith('.json'))

  it('the settings the scaffold writes read strict exactly when agentRunsStrict says so', () => {
    expect(profiles.length).toBeGreaterThanOrEqual(7)
    let strictSeen = 0
    for (const f of profiles) {
      const p = JSON.parse(readFileSync(join(SRC, '..', 'templates', 'profiles', f), 'utf-8')) as ProfileTemplate
      // writeAgentSettingsFromProfile rebuilds `permissions` without a mode, then pins it (source check below).
      const settings: Record<string, unknown> = { permissions: { allow: [], deny: [] } }
      enforceStrictPermissionMode(settings, p.permissionMode)
      put('agents/nocfg/.claude/settings.json', JSON.stringify(settings))
      const want = agentRunsStrict('nocfg', p)
      if (want) strictSeen++
      expect(live('nocfg', { helperAllowed: true, homeDir: HOME, managedSettingsPath: join(HOME, 'managed-settings.json') }).ctx.profile.strict, f).toBe(want)
    }
    expect(strictSeen).toBeGreaterThan(0)
    rmSync(join(ROOT, 'agents', 'nocfg', '.claude'), { recursive: true })
  })

  it('writeAgentSettingsFromProfile builds permissions without a defaultMode and then calls enforceStrictPermissionMode', () => {
    const src = readFileSync(join(SRC, 'web', 'agent-scaffold.ts'), 'utf-8')
    const m = /existing\.permissions = \{([\s\S]*?)\n  \}\n  enforceStrictPermissionMode\(existing, profile\.permissionMode\)/.exec(src)
    expect(m, 'the permissions rebuild + pin shape moved').not.toBeNull()
    expect(m![1]).not.toMatch(/defaultMode/)
  })
})

describe('kanbanWrite parity with agentGetsKanbanWriteGate (Ron S5)', () => {
  it('every sub, the hidden heartbeat and the main agent: kanbanWrite is exactly "no kanban-write gate"', () => {
    for (const name of ['boss', 'heartbeat', ...listAgentNames()]) {
      expect(live(name).ctx.capabilities.kanbanWrite, name).toBe(!agentGetsKanbanWriteGate(name))
    }
    expect(live('heartbeat').ctx.capabilities.kanbanWrite).toBe(false)
  })
})

describe('owner name parity with currentOwnerName (Ron S5)', () => {
  it('set, quoted, padded and absent OWNER_NAME read the same', () => {
    for (const line of ['OWNER_NAME=Roland', 'OWNER_NAME="Roland D"', "OWNER_NAME='  Roland  '", 'OWNER_NAME=   Judit   ', '']) {
      put('.env', `MAIN_AGENT_ID=boss\n${line}\n`)
      expect(live('boss').ctx.owner.name, line).toBe(currentOwnerName())
    }
  })
})
