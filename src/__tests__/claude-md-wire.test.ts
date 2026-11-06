// C1 PR 10b: the CLAUDE.md builder behind the per-agent flag (src/web/claude-md/wire.ts).
// Every file operation runs in a temp install root; config.js (PROJECT_ROOT, STORE_DIR, MAIN_AGENT_ID) and env.ts
// (CLAUDECLAW_ENV_DIR) point at it.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
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

import { applyMainClaudeMdV2, applySubClaudeMdV2, mainFlagOn, subFlagOn } from '../web/claude-md/wire.js'
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
      else out.push(`F ${rel} ${(st.mode & 0o777).toString(8)} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`)
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
  put('agents/kevin/CLAUDE.md', '# Kevin\n\n<!-- BEGIN GENERATED: autonomy -->\nold\n<!-- END GENERATED: autonomy -->\n')
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
