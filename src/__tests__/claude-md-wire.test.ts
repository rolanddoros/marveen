// C1 PR 10b: the CLAUDE.md builder behind the per-agent flag (src/web/claude-md/wire.ts).
// Every file operation runs in a temp install root; config.js (PROJECT_ROOT, STORE_DIR, MAIN_AGENT_ID) and env.ts
// (CLAUDECLAW_ENV_DIR) point at it.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const { ROOT } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-wire-root-'))
  process.env.CLAUDECLAW_ENV_DIR = root
  return { ROOT: root }
})

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  PROJECT_ROOT: ROOT,
  STORE_DIR: `${ROOT}/store`,
  MAIN_AGENT_ID: 'boss',
}))

import { applyMainClaudeMdV2, applySubClaudeMdV2, defaultWireDeps, mainFlagOn, regionSkillRefs, subFlagOn, type WireDeps } from '../web/claude-md/wire.js'
import { defaultSkillInstallPaths } from '../web/claude-md/skill-install.js'
import { PRODUCT_SKILLS } from '../web/claude-md/skills.js'
import { REGION_BEGIN, REGION_END } from '../web/claude-md/render.js'
import type { ProfileTemplate } from '../web/profiles.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = { permissionMode: 'permissive' } as unknown as ProfileTemplate

function put(rel: string, content: string): void {
  const p = join(ROOT, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

// Every path under the root with its type and content hash: a write anywhere shows up.
function snapshot(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const n of readdirSync(dir).sort()) {
      const p = join(dir, n)
      const st = lstatSync(p)
      const rel = relative(ROOT, p)
      if (st.isSymbolicLink()) out.push(`L ${rel} -> ${readlinkSync(p)}`)
      else if (st.isDirectory()) { out.push(`D ${rel} ${(st.mode & 0o777).toString(8)}`); walk(p) }
      // The inode too: an atomic rewrite with the same bytes is still a write.
      else out.push(`F ${rel} ${(st.mode & 0o777).toString(8)} ${st.ino} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`)
    }
  }
  walk(ROOT)
  return out
}

function fixture(): void {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  put('CLAUDE.md', '# Boss\n\nOwner text with $& and $1, ékezet.\n')
  put('.env', 'MAIN_AGENT_ID=boss\n')
  put('agents/kevin/CLAUDE.md', '# Kevin\n\n<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->\nold\n<!-- END GENERATED: autonomy-wiring -->\n')
  put('agents/kevin/agent-config.json', JSON.stringify({ team: { reportsTo: 'boss' } }))
}

beforeEach(fixture)
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  delete process.env.CLAUDECLAW_ENV_DIR
})

describe('flag reading: only the exact string "v2" is on', () => {
  it('a sub: agent-config.json claudeMdBuilder, read fresh on every call', () => {
    expect(subFlagOn('kevin')).toBe(false)
    for (const [v, want] of [['v2', true], ['V2', false], [' v2', false], ['v3', false], [true, false], [2, false], [null, false]] as const) {
      put('agents/kevin/agent-config.json', JSON.stringify({ claudeMdBuilder: v }))
      expect(subFlagOn('kevin'), JSON.stringify(v)).toBe(want)
    }
    put('agents/kevin/agent-config.json', '{broken')
    expect(subFlagOn('kevin')).toBe(false)
    put('agents/kevin/agent-config.json', '["v2"]')
    expect(subFlagOn('kevin')).toBe(false)
    expect(subFlagOn('nobody')).toBe(false)
  })

  it('the main agent: CLAUDE_MD_BUILDER_MAIN in .env, read fresh on every call', () => {
    expect(mainFlagOn()).toBe(false)
    for (const [v, want] of [['v2', true], ['"v2"', true], ['V2', false], ['true', false], ['', false], ['v2 # on', false]] as const) {
      put('.env', `MAIN_AGENT_ID=boss\nCLAUDE_MD_BUILDER_MAIN=${v}\n`)
      expect(mainFlagOn(), v).toBe(want)
    }
  })
})

describe('flag off: the v2 entry points return false and touch nothing (the legacy sequence then runs unchanged)', () => {
  it('a sub, for every off value: false, and the whole root is byte-identical (no backup, no skills folder)', () => {
    for (const v of [undefined, 'V2', true, 'v3']) {
      put('agents/kevin/agent-config.json', JSON.stringify(v === undefined ? {} : { claudeMdBuilder: v }))
      const before = snapshot()
      expect(applySubClaudeMdV2('kevin', PROFILE), String(v)).toBe(false)
      expect(snapshot(), String(v)).toEqual(before)
    }
  })

  it('the main agent: false, and the whole root is byte-identical', () => {
    for (const v of ['', 'V2', 'v3']) {
      put('.env', `MAIN_AGENT_ID=boss\nCLAUDE_MD_BUILDER_MAIN=${v}\n`)
      const before = snapshot()
      expect(applyMainClaudeMdV2(), v).toBe(false)
      expect(snapshot(), v).toEqual(before)
    }
  })
})

// The legacy sequences as they were at the base f4fa24a1 (agent-process.ts startAgentProcess, web.ts boot). They now
// run inside `if (!applySubClaudeMdV2(name, profile)) { ... }` / `if (!applyMainClaudeMdV2()) { ... }` and must stay
// exactly these calls, in this order: a dropped, reordered or added call is red.
const BASE_SUB = [
  'ensureFleetRosterSection(name)', 'ensureProjectRootInClaudeMd(name)', 'ensureAutonomySection(name)',
  'ensureSkillsPathTrapSection(name)', 'ensureSkillSectionCurrent(name)', 'ensureSystemDirectiveAuthSection(name)',
  'ensureAgentIdHeaderSection(name)', 'if (profileWantsThinChiefHandoff(profile)) ensureThinChiefHandoffSection(name)',
  'ensureMemorySearchLabelSection(name)', 'ensureFleetAuthSection(name)', 'ensureEvidenceSection(name)',
  'ensureMcpListChannelSection(name)', 'ensureMessageCloseSection(name)', 'ensureStrictApiSection(name)',
  'ensureApiHelperSection(name)', 'ensureBackgroundCheckpointSection(name)',
]
const BASE_MAIN = [
  'ensureFederationClaudeMdSection()', 'ensureAutonomySection(MAIN_AGENT_ID)', 'ensureSkillsPathTrapSection(MAIN_AGENT_ID)',
  'ensureSystemDirectiveAuthSection(MAIN_AGENT_ID)', 'ensureAgentIdHeaderSection(MAIN_AGENT_ID)',
  'ensureMemorySearchLabelSection(MAIN_AGENT_ID)', 'ensureFleetAuthSection(MAIN_AGENT_ID)', 'ensureEvidenceSection(MAIN_AGENT_ID)',
  'ensureMcpListChannelSection(MAIN_AGENT_ID)', 'ensureMessageCloseSection(MAIN_AGENT_ID)', 'ensureApiHelperSection(MAIN_AGENT_ID)',
  'ensureBackgroundCheckpointSection(MAIN_AGENT_ID)',
]

// The statements of the block that `opener` opens, comments and blank lines dropped.
function guardedBlock(file: string, opener: string): string[] {
  const text = readFileSync(join(SRC, file), 'utf-8')
  const at = text.indexOf(opener)
  expect(at, `${file}: ${opener}`).toBeGreaterThan(-1)
  expect(text.indexOf(opener, at + 1), `${file}: one guard only`).toBe(-1)
  const lines = text.slice(at + opener.length).split('\n')
  const out: string[] = []
  for (const l of lines.slice(1)) {
    const t = l.trim()
    if (t === '}') break
    if (t === '' || t.startsWith('//')) continue
    out.push(t)
  }
  return out
}

describe('source parity: the guarded legacy sequences equal the base', () => {
  it('a sub: the 16 calls of startAgentProcess, behind the v2 guard, right after the token sync', () => {
    expect(guardedBlock('web/agent-process.ts', 'if (!applySubClaudeMdV2(name, profile)) {')).toEqual(BASE_SUB)
    const src = readFileSync(join(SRC, 'web/agent-process.ts'), 'utf-8')
    const order = ['writeAgentSettingsFromProfile(name, profile)', 'syncAgentTokenOnStart(name)', 'if (!applySubClaudeMdV2(name, profile)) {']
      .map((s) => src.indexOf(s))
    expect(order.every((i) => i > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('the main agent: the 12 calls of the boot, behind the v2 guard, inside the live-instance check', () => {
    expect(guardedBlock('web.ts', 'if (!applyMainClaudeMdV2()) {')).toEqual(BASE_MAIN)
    const src = readFileSync(join(SRC, 'web.ts'), 'utf-8')
    expect(src).toMatch(/ {2}if \(!servicesOff\) \{\n(?: {4}\/\/[^\n]*\n)* {4}if \(!applyMainClaudeMdV2\(\)\) \{\n/)
  })

  it('no other caller: the v2 entry points are called from these two places only', () => {
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n)
        if (lstatSync(p).isDirectory()) { if (n !== '__tests__') walk(p); continue }
        if (!p.endsWith('.ts') || p.endsWith('claude-md/wire.ts')) continue
        if (/apply(?:Sub|Main)ClaudeMdV2\(/.test(readFileSync(p, 'utf-8'))) callers.push(relative(SRC, p))
      }
    }
    walk(SRC)
    expect(callers.sort()).toEqual(['web.ts', 'web/agent-process.ts'])
  })
})

// ---- flag on: the v2 write ----

const NOW = new Date('2026-11-06T22:43:00Z')
const KEVIN = join(ROOT, 'agents', 'kevin', 'CLAUDE.md')
const deps = (over: Partial<WireDeps> = {}): WireDeps => ({
  ...defaultWireDeps(),
  skillPaths: defaultSkillInstallPaths(ROOT, join(ROOT, 'store'), join(ROOT, 'home')),
  federationEnabled: () => false,
  helperAllowed: () => true,
  strict: () => false,
  now: () => NOW,
  // the expected backup directory names below are Budapest times; the install zone of a CI host is UTC
  tz: 'Europe/Budapest',
  homeDir: join(ROOT, 'home'),
  managedSettingsPath: join(ROOT, 'managed-settings.json'),
  ...over,
})
const flagKevin = () => put('agents/kevin/agent-config.json', JSON.stringify({ team: { reportsTo: 'boss' }, claudeMdBuilder: 'v2' }))
const read = (p: string) => readFileSync(p, 'utf-8')
const count = (text: string, line: string) => text.split('\n').filter((l) => l === line).length
const backups = () => (existsSync(join(ROOT, 'store', 'claude-md-backup'))
  ? readdirSync(join(ROOT, 'store', 'claude-md-backup')).filter((n) => n !== 'product-skills').sort() : [])

describe('the backup zone is the install zone (ISSUE1895: no zone literal in code)', () => {
  it('defaultWireDeps passes config.ts APP_TZ', async () => {
    const { APP_TZ } = await import('../config.js')
    expect(defaultWireDeps().tz).toBe(APP_TZ)
  })
})

describe('regionSkillRefs', () => {
  it('the marveen-* skill names, lower-cased and unique; a file name such as marveen-api.sh is not one', () => {
    expect(regionSkillRefs('skill marveen-messaging and Skill MARVEEN-Approvals; bash /x/scripts/marveen-api.sh; marveen-messaging'))
      .toEqual(['marveen-approvals', 'marveen-messaging'])
  })
})

describe('flag on, a sub: the v2 region replaces the legacy blocks', () => {
  it('first run: one region, the legacy block gone, the owner zone kept, a backup of the old bytes, the skills installed', () => {
    put('agents/kevin/CLAUDE.md', '# Kevin\n\nOwner $& and $1 stay, ékezet.\n\n<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->\nold\n<!-- END GENERATED: autonomy-wiring -->\n')
    flagKevin()
    const before = read(KEVIN)
    expect(applySubClaudeMdV2('kevin', PROFILE, deps())).toBe(true)
    const after = read(KEVIN)
    expect(count(after, REGION_BEGIN)).toBe(1)
    expect(count(after, REGION_END)).toBe(1)
    expect(after).not.toContain('BEGIN GENERATED: autonomy-wiring')
    expect(after).not.toContain('\nold\n')
    expect(after).toContain('Owner $& and $1 stay, ékezet.')
    expect(backups()).toEqual(['20261106-234300'])
    const bdir = join(ROOT, 'store', 'claude-md-backup', '20261106-234300', 'kevin')
    expect(read(join(bdir, 'CLAUDE.md'))).toBe(before)
    for (const n of PRODUCT_SKILLS) expect(existsSync(join(ROOT, '.claude', 'skills', n, 'SKILL.md')), n).toBe(true)
    for (const r of regionSkillRefs(after)) expect(PRODUCT_SKILLS as readonly string[]).toContain(r)
  })

  it('second run: true, and nothing anywhere changes (no write, no new backup)', () => {
    flagKevin()
    expect(applySubClaudeMdV2('kevin', PROFILE, deps())).toBe(true)
    const snap = snapshot()
    expect(applySubClaudeMdV2('kevin', PROFILE, deps({ now: () => new Date('2026-11-07T10:00:00Z') }))).toBe(true)
    expect(snapshot()).toEqual(snap)
  })

  it('an update inside v2 (another owner name) rewrites the region without a new backup', () => {
    flagKevin()
    applySubClaudeMdV2('kevin', PROFILE, deps())
    put('.env', 'MAIN_AGENT_ID=boss\nOWNER_NAME=Roland\n')
    expect(applySubClaudeMdV2('kevin', PROFILE, deps({ now: () => new Date('2026-11-07T10:00:00Z') }))).toBe(true)
    expect(read(KEVIN)).toContain('Roland')
    expect(backups()).toEqual(['20261106-234300'])
  })
})

describe('flag on, refused: the legacy sequence runs, nothing is written', () => {
  const refused = (d: WireDeps, name = 'kevin', profile = PROFILE) => {
    const before = snapshot()
    expect(applySubClaudeMdV2(name, profile, d)).toBe(false)
    expect(snapshot()).toEqual(before)
  }
  it('federation enabled', () => { flagKevin(); refused(deps({ federationEnabled: () => true })) })
  it('a helper-denied agent', () => { flagKevin(); refused(deps({ helperAllowed: () => false })) })
  it('a thin-chief profile', () => { flagKevin(); refused(deps(), 'kevin', { permissionMode: 'permissive', thinChiefHandoff: true } as unknown as ProfileTemplate) })
  it('the heartbeat worker', () => {
    put('agents/heartbeat/CLAUDE.md', '# hb\n')
    put('agents/heartbeat/agent-config.json', JSON.stringify({ claudeMdBuilder: 'v2' }))
    refused(deps(), 'heartbeat')
  })
})

describe('flag on, a failure: nothing written; legacy runs only while the file has no region', () => {
  const failsLegacy = (d: WireDeps = deps()) => {
    const before = read(KEVIN)
    expect(applySubClaudeMdV2('kevin', PROFILE, d)).toBe(false)
    expect(read(KEVIN)).toBe(before)
    expect(backups()).toEqual([])
  }
  it('a ComposeError (an unclosed legacy block)', () => {
    put('agents/kevin/CLAUDE.md', '# Kevin\n<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->\nnever closed\n')
    flagKevin()
    failsLegacy()
  })
  it('a TemplateError (an emoji sequence in OWNER_NAME)', () => {
    put('.env', 'MAIN_AGENT_ID=boss\nOWNER_NAME=Ro\u200dland\n')
    flagKevin()
    failsLegacy()
  })
  it('the backup fails: no CLAUDE.md write', () => {
    flagKevin()
    failsLegacy(deps({ now: () => new Date(Number.NaN) }))
  })
  it('a foreign skill on one of the six names: no install, no write', () => {
    flagKevin()
    mkdirSync(join(ROOT, '.claude', 'skills', 'marveen-messaging'), { recursive: true })
    writeFileSync(join(ROOT, '.claude', 'skills', 'marveen-messaging', 'SKILL.md'), 'foreign\n')
    failsLegacy()
    expect(read(join(ROOT, '.claude', 'skills', 'marveen-messaging', 'SKILL.md'))).toBe('foreign\n')
    expect(existsSync(join(ROOT, '.claude', 'skills', 'marveen-approvals'))).toBe(false)
  })
  it('the .env main id is not the running one', () => {
    put('.env', 'MAIN_AGENT_ID=other\n')
    flagKevin()
    failsLegacy()
  })
  it('a file that already has its region: true (no legacy blocks appended to a v2 file), the file unchanged', () => {
    flagKevin()
    applySubClaudeMdV2('kevin', PROFILE, deps())
    const v2 = read(KEVIN)
    put('.env', 'MAIN_AGENT_ID=boss\nOWNER_NAME=Ro\u200dland\n')
    expect(applySubClaudeMdV2('kevin', PROFILE, deps())).toBe(true)
    expect(read(KEVIN)).toBe(v2)
  })
})

describe('flag on, the main agent', () => {
  it('CLAUDE_MD_BUILDER_MAIN=v2: the region in <root>/CLAUDE.md, a backup under the main id', () => {
    put('.env', 'MAIN_AGENT_ID=boss\nCLAUDE_MD_BUILDER_MAIN=v2\n')
    expect(applyMainClaudeMdV2(deps())).toBe(true)
    expect(count(read(join(ROOT, 'CLAUDE.md')), REGION_BEGIN)).toBe(1)
    expect(read(join(ROOT, 'CLAUDE.md'))).toContain('Owner text with $& and $1, ékezet.')
    expect(existsSync(join(ROOT, 'store', 'claude-md-backup', '20261106-234300', 'boss', 'CLAUDE.md'))).toBe(true)
  })
  it('refused with federation enabled', () => {
    put('.env', 'MAIN_AGENT_ID=boss\nCLAUDE_MD_BUILDER_MAIN=v2\n')
    const before = snapshot()
    expect(applyMainClaudeMdV2(deps({ federationEnabled: () => true }))).toBe(false)
    expect(snapshot()).toEqual(before)
  })
})

describe('the last flag off removes the rendered product skills', () => {
  it('kevin off, main still on: kept; main off too: the manifest files and the manifest go, foreign skills stay', () => {
    flagKevin()
    put('.env', 'MAIN_AGENT_ID=boss\nCLAUDE_MD_BUILDER_MAIN=v2\n')
    mkdirSync(join(ROOT, '.claude', 'skills', 'marveen-frissites'), { recursive: true })
    writeFileSync(join(ROOT, '.claude', 'skills', 'marveen-frissites', 'SKILL.md'), 'foreign\n')
    applySubClaudeMdV2('kevin', PROFILE, deps())
    put('agents/kevin/agent-config.json', JSON.stringify({ team: { reportsTo: 'boss' } }))
    applySubClaudeMdV2('kevin', PROFILE, deps())
    expect(existsSync(join(ROOT, '.claude', 'skills', 'marveen-messaging', 'SKILL.md'))).toBe(true)
    put('.env', 'MAIN_AGENT_ID=boss\n')
    applyMainClaudeMdV2(deps())
    for (const n of PRODUCT_SKILLS) expect(existsSync(join(ROOT, '.claude', 'skills', n)), n).toBe(false)
    expect(existsSync(join(ROOT, 'store', 'claude-md-backup', 'product-skills', 'MANIFEST.json'))).toBe(false)
    expect(read(join(ROOT, '.claude', 'skills', 'marveen-frissites', 'SKILL.md'))).toBe('foreign\n')
  })
})

describe('the v2 path keeps what the legacy start does besides the blocks', () => {
  it('strict comes from deps.strict (agentRunsStrict): a strict agent gets the strict region', () => {
    flagKevin()
    applySubClaudeMdV2('kevin', PROFILE, deps({ strict: () => false }))
    const loose = read(KEVIN)
    applySubClaudeMdV2('kevin', PROFILE, deps({ strict: () => true }))
    expect(read(KEVIN)).not.toBe(loose)
    expect(read(KEVIN)).toMatch(/dontAsk/)
    expect(loose).not.toMatch(/dontAsk/)
  })

  it('the v2 path keeps the owner-zone writers: project-root re-anchor and skill section (sub), federation block (main)', () => {
    const src = readFileSync(join(SRC, 'web/claude-md/wire.ts'), 'utf-8')
    const sub = src.slice(src.indexOf('export function applySubClaudeMdV2'), src.indexOf('export function applyMainClaudeMdV2'))
    const main = src.slice(src.indexOf('export function applyMainClaudeMdV2'))
    const at = (body: string, s: string) => { const i = body.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i }
    expect(at(sub, 'ensureProjectRootInClaudeMd(name)')).toBeLessThan(at(sub, 'writeV2('))
    expect(at(sub, 'ensureSkillSectionCurrent(name)')).toBeLessThan(at(sub, 'writeV2('))
    expect(at(main, 'ensureFederationClaudeMdSection()')).toBeLessThan(at(main, 'writeV2('))
  })
})

describe('Ron S1: hooks without a real source stop the write by themselves', () => {
  it('the main agent on another config root (MAIN_AGENT_ISOLATED_CONFIG=1): no region, legacy kept', () => {
    put('.env', 'MAIN_AGENT_ID=boss\nCLAUDE_MD_BUILDER_MAIN=v2\nMAIN_AGENT_ISOLATED_CONFIG=1\n')
    const before = read(join(ROOT, 'CLAUDE.md'))
    expect(applyMainClaudeMdV2(deps())).toBe(false)
    expect(read(join(ROOT, 'CLAUDE.md'))).toBe(before)
    expect(backups()).toEqual([])
  })
  it('Ron 10b J2: a sub with its own claudeConfigDir: no region, legacy kept', () => {
    put('agents/kevin/agent-config.json', JSON.stringify({ team: { reportsTo: 'boss' }, claudeMdBuilder: 'v2', claudeConfigDir: '/srv/kevin-login' }))
    const before = read(KEVIN)
    expect(applySubClaudeMdV2('kevin', PROFILE, deps())).toBe(false)
    expect(read(KEVIN)).toBe(before)
    expect(backups()).toEqual([])
  })
  it('a managed settings file that does not parse: no region for a sub, legacy kept', () => {
    flagKevin()
    put('managed-settings.json', '{broken')
    const before = read(KEVIN)
    expect(applySubClaudeMdV2('kevin', PROFILE, deps())).toBe(false)
    expect(read(KEVIN)).toBe(before)
  })
})

// C1 PR 10b E: before it, a flag turned off after a v2 write left the region, and the legacy sequence appended its
// blocks next to it. Now the region is stripped first (after a backup of the v2 file); a strip that cannot be done
// leaves the file and skips the legacy sequence.
describe('E: the flag off (or refused) on a file that still has its region: the region goes, then the legacy sequence runs', () => {
  const LATER = new Date('2026-11-07T10:00:00Z')
  const v2Kevin = () => {
    flagKevin()
    expect(applySubClaudeMdV2('kevin', PROFILE, deps())).toBe(true)
    expect(count(read(KEVIN), REGION_BEGIN)).toBe(1)
    return read(KEVIN)
  }
  const unflagKevin = () => put('agents/kevin/agent-config.json', JSON.stringify({ team: { reportsTo: 'boss' } }))

  it('a sub: false (legacy runs), the region and its separator gone, the owner text kept, the v2 file backed up', () => {
    const v2 = v2Kevin()
    unflagKevin()
    expect(applySubClaudeMdV2('kevin', PROFILE, deps({ now: () => LATER }))).toBe(false)
    expect(read(KEVIN)).toBe('# Kevin\n')
    expect(backups()).toEqual(['20261106-234300', '20261107-110000'])
    expect(read(join(ROOT, 'store', 'claude-md-backup', '20261107-110000', 'kevin', 'CLAUDE.md'))).toBe(v2)
  })

  it('a second flag-off start changes nothing anywhere (no write, no new backup)', () => {
    v2Kevin()
    unflagKevin()
    applySubClaudeMdV2('kevin', PROFILE, deps({ now: () => LATER }))
    const snap = snapshot()
    expect(applySubClaudeMdV2('kevin', PROFILE, deps({ now: () => new Date('2026-11-08T10:00:00Z') }))).toBe(false)
    expect(snapshot()).toEqual(snap)
  })

  it('the main agent: the same, under the main id', () => {
    put('.env', 'MAIN_AGENT_ID=boss\nCLAUDE_MD_BUILDER_MAIN=v2\n')
    expect(applyMainClaudeMdV2(deps())).toBe(true)
    const v2 = read(join(ROOT, 'CLAUDE.md'))
    put('.env', 'MAIN_AGENT_ID=boss\n')
    expect(applyMainClaudeMdV2(deps({ now: () => LATER }))).toBe(false)
    expect(read(join(ROOT, 'CLAUDE.md'))).toBe('# Boss\n\nOwner text with $& and $1, ékezet.\n')
    expect(read(join(ROOT, 'store', 'claude-md-backup', '20261107-110000', 'boss', 'CLAUDE.md'))).toBe(v2)
  })

  it('refused while the file has its region (federation enabled later): the region goes too, legacy runs', () => {
    v2Kevin()
    expect(applySubClaudeMdV2('kevin', PROFILE, deps({ now: () => LATER, federationEnabled: () => true }))).toBe(false)
    expect(read(KEVIN)).toBe('# Kevin\n')
  })

  it('the strip cannot be done (a broken file): true (no legacy blocks next to the region), the file unchanged, no backup', () => {
    const v2 = v2Kevin()
    put('agents/kevin/CLAUDE.md', `${v2}<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->\nnever closed\n`)
    const broken = read(KEVIN)
    unflagKevin()
    expect(applySubClaudeMdV2('kevin', PROFILE, deps({ now: () => LATER }))).toBe(true)
    expect(read(KEVIN)).toBe(broken)
    expect(backups()).toEqual(['20261106-234300'])
  })

  it('the backup fails: true, the file unchanged', () => {
    const v2 = v2Kevin()
    unflagKevin()
    expect(applySubClaudeMdV2('kevin', PROFILE, deps({ now: () => new Date(Number.NaN) }))).toBe(true)
    expect(read(KEVIN)).toBe(v2)
  })

  it('a failure before the write on a file that has its region: true (legacy skipped), the file unchanged', () => {
    const v2 = v2Kevin()
    expect(applySubClaudeMdV2('kevin', PROFILE, deps({ strict: () => { throw new Error('strict lookup failed') } }))).toBe(true)
    expect(read(KEVIN)).toBe(v2)
    put('.env', 'MAIN_AGENT_ID=boss\nCLAUDE_MD_BUILDER_MAIN=v2\n')
    expect(applyMainClaudeMdV2(deps())).toBe(true)
    const main = read(join(ROOT, 'CLAUDE.md'))
    expect(applyMainClaudeMdV2(deps({ federationEnabled: () => { throw new Error('federation config failed') } }))).toBe(true)
    expect(read(join(ROOT, 'CLAUDE.md'))).toBe(main)
    // without a region the same failure lets the legacy sequence run, as before
    put('agents/kevin/CLAUDE.md', '# Kevin\n')
    expect(applySubClaudeMdV2('kevin', PROFILE, deps({ strict: () => { throw new Error('strict lookup failed') } }))).toBe(false)
  })

  it('the marker line only inside a code fence is owner text: false, the whole root byte-identical', () => {
    put('agents/kevin/CLAUDE.md', `# Kevin\n\n\`\`\`\n${REGION_BEGIN}\nquoted\n${REGION_END}\n\`\`\`\n`)
    const before = snapshot()
    expect(applySubClaudeMdV2('kevin', PROFILE, deps())).toBe(false)
    expect(snapshot()).toEqual(before)
  })
})

// Ron 10b review (13191): B1 (invalid UTF-8 must never be re-encoded), J1 (the product skills stay while a region
// is left), J3 (the backup is the file before step 2).
describe('Ron 10b B1: a CLAUDE.md that is not valid UTF-8 is never rewritten, and a backup holds the exact bytes', () => {
  const rawKevin = (head: string, tail = '') => Buffer.concat([Buffer.from(head), Buffer.from([0x80, 0xff]), Buffer.from(tail)])
  const readBytes = (p: string) => readFileSync(p)

  it('flag on, no region yet: false (legacy decides, as for any file without a region), the bytes unchanged, no backup, no skills', () => {
    const raw = rawKevin('# Alpha\nowner ', ' line\n\n<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->\nold\n<!-- END GENERATED: autonomy-wiring -->\n')
    writeFileSync(KEVIN, raw)
    flagKevin()
    expect(applySubClaudeMdV2('kevin', PROFILE, deps())).toBe(false)
    expect(readBytes(KEVIN).equals(raw)).toBe(true)
    expect(backups()).toEqual([])
    expect(existsSync(join(ROOT, '.claude', 'skills'))).toBe(false)
  })

  it('flag on, the file already has its region: true (no legacy blocks next to it), the bytes unchanged', () => {
    const v2 = v2Bytes()
    const raw = Buffer.concat([Buffer.from([0x80, 0xff, 0x0a]), v2])
    writeFileSync(KEVIN, raw)
    expect(applySubClaudeMdV2('kevin', PROFILE, deps({ now: () => new Date('2026-11-07T10:00:00Z') }))).toBe(true)
    expect(readBytes(KEVIN).equals(raw)).toBe(true)
    expect(backups()).toEqual(['20261106-234300'])
  })

  it('the rollback (flag off) on such a file: true (the legacy sequence skipped), the bytes unchanged, no new backup', () => {
    const v2 = v2Bytes()
    const raw = Buffer.concat([Buffer.from([0x80, 0xff, 0x0a]), v2])
    writeFileSync(KEVIN, raw)
    put('agents/kevin/agent-config.json', JSON.stringify({ team: { reportsTo: 'boss' } }))
    expect(applySubClaudeMdV2('kevin', PROFILE, deps({ now: () => new Date('2026-11-07T10:00:00Z') }))).toBe(true)
    expect(readBytes(KEVIN).equals(raw)).toBe(true)
    expect(backups()).toEqual(['20261106-234300'])
  })

  it('the first-transition backup and the rollback backup are byte-identical to the file (BOM, CRLF, no final newline)', () => {
    const original = Buffer.from('﻿# Kevin\r\nOwner line, ékezet\r\nlast line without newline', 'utf-8')
    writeFileSync(KEVIN, original)
    flagKevin()
    expect(applySubClaudeMdV2('kevin', PROFILE, deps())).toBe(true)
    expect(readBytes(join(ROOT, 'store', 'claude-md-backup', '20261106-234300', 'kevin', 'CLAUDE.md')).equals(original)).toBe(true)
    const v2 = readBytes(KEVIN)
    put('agents/kevin/agent-config.json', JSON.stringify({ team: { reportsTo: 'boss' } }))
    expect(applySubClaudeMdV2('kevin', PROFILE, deps({ now: () => new Date('2026-11-07T10:00:00Z') }))).toBe(false)
    expect(readBytes(join(ROOT, 'store', 'claude-md-backup', '20261107-110000', 'kevin', 'CLAUDE.md')).equals(v2)).toBe(true)
    expect(read(KEVIN).startsWith('﻿# Kevin\r\n')).toBe(true)
  })

  function v2Bytes(): Buffer {
    flagKevin()
    expect(applySubClaudeMdV2('kevin', PROFILE, deps())).toBe(true)
    return readFileSync(KEVIN)
  }
})

describe('Ron 10b J1: the product skills go only once no CLAUDE.md carries a region', () => {
  it('kevin flagged off but not restarted, ron starts: the skills stay; kevin starts (rollback): they go', () => {
    put('agents/ron/CLAUDE.md', '# Ron\n')
    flagKevin()
    expect(applySubClaudeMdV2('kevin', PROFILE, deps())).toBe(true)
    put('agents/kevin/agent-config.json', JSON.stringify({ team: { reportsTo: 'boss' } }))
    expect(applySubClaudeMdV2('ron', PROFILE, deps())).toBe(false)
    for (const n of PRODUCT_SKILLS) expect(existsSync(join(ROOT, '.claude', 'skills', n, 'SKILL.md')), n).toBe(true)
    expect(applySubClaudeMdV2('kevin', PROFILE, deps({ now: () => new Date('2026-11-07T10:00:00Z') }))).toBe(false)
    for (const n of PRODUCT_SKILLS) expect(existsSync(join(ROOT, '.claude', 'skills', n)), n).toBe(false)
  })
})

describe('Ron 10b J3: the first-transition backup is the file before the owner-zone writers ran', () => {
  it('a foreign install path that step 2 re-anchors: the written file has the new root, the backup the old bytes', () => {
    const original = '# Kevin\n\nToken: $(cat /oldhost/fleet/store/.dashboard-token)\n'
    put('agents/kevin/CLAUDE.md', original)
    flagKevin()
    expect(applySubClaudeMdV2('kevin', PROFILE, deps())).toBe(true)
    expect(read(KEVIN)).toContain(`$(cat ${ROOT}/store/.dashboard-token)`) // step 2 ran: the precondition of the test
    expect(read(join(ROOT, 'store', 'claude-md-backup', '20261106-234300', 'kevin', 'CLAUDE.md'))).toBe(original)
  })
})
