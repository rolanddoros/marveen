// C1 PR 12a: the heartbeat worker's CLAUDE.md through the v2 builder (src/web/claude-md/wire.ts
// writeHeartbeatClaudeMdV2, heartbeatFlagOn; src/web/heartbeat-agent-scaffold.ts ensureHeartbeatAgent).
// Every file operation runs in a temp install root: config.js (PROJECT_ROOT, STORE_DIR, MAIN_AGENT_ID), env.ts
// (CLAUDECLAW_ENV_DIR) and HOME point at it; the federation config is a stub the tests switch.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const { ROOT, HOME_BEFORE, FED } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-hbv2-root-'))
  process.env.CLAUDECLAW_ENV_DIR = root
  const homeBefore = process.env.HOME
  process.env.HOME = path.join(root, 'home')
  return { ROOT: root, HOME_BEFORE: homeBefore, FED: { enabled: false } }
})

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  PROJECT_ROOT: ROOT,
  STORE_DIR: `${ROOT}/store`,
  MAIN_AGENT_ID: 'boss',
}))

vi.mock('../web/federation/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/federation/config.js')>()),
  getFederationConfig: () => ({ enabled: FED.enabled, peers: [] }),
}))

import { applySubClaudeMdV2, defaultWireDeps, heartbeatFlagOn, writeHeartbeatClaudeMdV2, type WireDeps } from '../web/claude-md/wire.js'
import { currentHeartbeatIdentity, ensureHeartbeatAgent, renderHeartbeatClaudeMd, HEARTBEAT_AGENT_DIR, type HeartbeatIdentity } from '../web/heartbeat-agent-scaffold.js'
import { composeClaudeMd } from '../web/claude-md/compose.js'
import { renderRegion } from '../web/claude-md/registry.js'
import { REGION_BEGIN, REGION_END } from '../web/claude-md/render.js'
import { PRODUCT_SKILLS } from '../web/claude-md/skills.js'
import { loadProfileTemplate } from '../web/profiles.js'
import { resolveAgentSecurityProfile } from '../web/agent-team.js'
import { FIXTURES } from './fixtures/claude-md/contexts.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const HB = join(ROOT, 'agents', 'heartbeat')
const HB_MD = join(HB, 'CLAUDE.md')
const LEGACY_BLOCK = '<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->\nold\n<!-- END GENERATED: autonomy-wiring -->\n'

function put(rel: string, content: string): void {
  const p = join(ROOT, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}
const read = (p: string) => readFileSync(p, 'utf-8')
const count = (text: string, line: string) => text.split('\n').filter((l) => l === line).length
const prose = () => renderHeartbeatClaudeMd(currentHeartbeatIdentity())
const env = (extra = '') => put('.env', `MAIN_AGENT_ID=boss\n${extra}`)
const flagOn = (extra = '') => env(`CLAUDE_MD_BUILDER_HEARTBEAT=v2\n${extra}`)
const backups = () => (existsSync(join(ROOT, 'store', 'claude-md-backup'))
  ? readdirSync(join(ROOT, 'store', 'claude-md-backup')).filter((n) => n !== 'product-skills').sort() : [])
// The start right after the scaffold (agent-process.ts startAgentProcess), with the profile it loads.
const start = () => applySubClaudeMdV2('heartbeat', loadProfileTemplate(resolveAgentSecurityProfile('heartbeat')))

// Every path under the root with its type and content hash; the inode too, so an atomic rewrite with the same
// bytes still shows up as a write.
function snapshot(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const n of readdirSync(dir).sort()) {
      const p = join(dir, n)
      const st = lstatSync(p)
      const rel = relative(ROOT, p)
      if (st.isSymbolicLink()) out.push(`L ${rel} -> ${readlinkSync(p)}`)
      else if (st.isDirectory()) { out.push(`D ${rel}`); walk(p) }
      else out.push(`F ${rel} ${st.ino} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`)
    }
  }
  walk(ROOT)
  return out
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(ROOT, 'home'), { recursive: true })
  env()
  FED.enabled = false
})
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  delete process.env.CLAUDECLAW_ENV_DIR
  if (HOME_BEFORE === undefined) delete process.env.HOME
  else process.env.HOME = HOME_BEFORE
})

describe('the heartbeat flag: .env CLAUDE_MD_BUILDER_HEARTBEAT, only the exact string "v2"', () => {
  it('read fresh on every call', () => {
    expect(HEARTBEAT_AGENT_DIR).toBe(HB)
    expect(heartbeatFlagOn()).toBe(false)
    for (const [v, want] of [['v2', true], ['"v2"', true], ['V2', false], ['true', false], ['', false], ['v2 # on', false]] as const) {
      env(`CLAUDE_MD_BUILDER_HEARTBEAT=${v}\n`)
      expect(heartbeatFlagOn(), v).toBe(want)
    }
  })

  it('not the main flag, and not claudeMdBuilder in agents/heartbeat/agent-config.json (the scaffold rewrites that file)', () => {
    env('CLAUDE_MD_BUILDER_MAIN=v2\n')
    expect(heartbeatFlagOn()).toBe(false)
    env()
    ensureHeartbeatAgent()
    put('agents/heartbeat/agent-config.json', JSON.stringify({ claudeMdBuilder: 'v2' }))
    const before = snapshot()
    expect(start()).toBe(false)
    expect(snapshot()).toEqual(before)
  })
})

describe('flag on: the scaffold writes the prose with the v2 region after it', () => {
  it('first boot over a legacy file: prose + region, one region, the legacy block gone, a backup of the old bytes, the skills installed', () => {
    put('agents/heartbeat/CLAUDE.md', `${prose()}\n${LEGACY_BLOCK}`)
    const old = read(HB_MD)
    flagOn()
    ensureHeartbeatAgent()
    const after = read(HB_MD)
    expect(after.startsWith(prose())).toBe(true)
    expect(count(after, REGION_BEGIN)).toBe(1)
    expect(count(after, REGION_END)).toBe(1)
    expect(after.endsWith(`${REGION_END}\n`)).toBe(true)
    expect(after).not.toContain('BEGIN GENERATED')
    expect(after).not.toContain('\nold\n')
    const stamps = backups()
    expect(stamps).toHaveLength(1)
    expect(read(join(ROOT, 'store', 'claude-md-backup', stamps[0], 'heartbeat', 'CLAUDE.md'))).toBe(old)
    for (const n of PRODUCT_SKILLS) expect(existsSync(join(ROOT, '.claude', 'skills', n, 'SKILL.md')), n).toBe(true)
  })

  it('the region is the heartbeat region: role heartbeat, no fleet roster, no kanban writes', () => {
    flagOn()
    ensureHeartbeatAgent()
    const region = read(HB_MD).slice(read(HB_MD).indexOf(REGION_BEGIN))
    expect(region).toContain('the heartbeat worker of this install')
    expect(region).not.toContain('### Fleet')
    expect(region).toContain('- You never write kanban or schedules: report what you found, the main agent acts.')
  })

  it('a fresh install (no file yet): written, no backup', () => {
    flagOn()
    ensureHeartbeatAgent()
    expect(count(read(HB_MD), REGION_BEGIN)).toBe(1)
    expect(backups()).toEqual([])
  })

  it('second boot: nothing anywhere changes (no write, no new backup)', () => {
    flagOn()
    ensureHeartbeatAgent()
    const snap = snapshot()
    ensureHeartbeatAgent()
    expect(snapshot()).toEqual(snap)
  })

  it('the start right after the scaffold: true (the legacy sequence is skipped), and it writes nothing', () => {
    flagOn()
    ensureHeartbeatAgent()
    const snap = snapshot()
    expect(start()).toBe(true)
    expect(snapshot()).toEqual(snap)
  })

  it('an update inside v2 (another owner name): the region is rewritten, no new backup', () => {
    put('agents/heartbeat/CLAUDE.md', '# old heartbeat\n')
    flagOn()
    ensureHeartbeatAgent()
    expect(backups()).toHaveLength(1)
    flagOn('OWNER_NAME=Roland\n')
    ensureHeartbeatAgent()
    expect(read(HB_MD)).toContain('Roland')
    expect(backups()).toHaveLength(1)
  })
})

describe('flag on, refused or failed: the prose alone, as with the flag off', () => {
  it('federation enabled: refused, the prose is written, no region, no backup, no skills; the start runs the legacy sequence', () => {
    put('agents/heartbeat/CLAUDE.md', `${prose()}\n${LEGACY_BLOCK}`)
    flagOn()
    FED.enabled = true
    ensureHeartbeatAgent()
    expect(read(HB_MD)).toBe(prose())
    expect(backups()).toEqual([])
    expect(existsSync(join(ROOT, '.claude', 'skills'))).toBe(false)
    expect(start()).toBe(false)
  })

  it('writeHeartbeatClaudeMdV2 itself: false and nothing written on a refusal', () => {
    flagOn()
    put('agents/heartbeat/CLAUDE.md', '# hb\n')
    const before = snapshot()
    const deps: WireDeps = { ...defaultWireDeps(), federationEnabled: () => true }
    expect(writeHeartbeatClaudeMdV2(HB_MD, prose(), deps)).toBe(false)
    expect(snapshot()).toEqual(before)
  })

  it('a failure (the .env main id is not the running one): the prose, no region; a later failure drops a region the same way', () => {
    flagOn('MAIN_AGENT_ID=other\n')
    ensureHeartbeatAgent()
    expect(read(HB_MD)).toBe(prose())
    expect(backups()).toEqual([])
    flagOn()
    ensureHeartbeatAgent()
    expect(count(read(HB_MD), REGION_BEGIN)).toBe(1)
    flagOn('MAIN_AGENT_ID=other\n')
    ensureHeartbeatAgent()
    expect(read(HB_MD)).toBe(prose())
    expect(start()).toBe(false)
  })
})

describe('flag off after on: back to the prose', () => {
  it('the scaffold writes the prose (the region goes), the start runs the legacy sequence, the product skills go', () => {
    flagOn()
    ensureHeartbeatAgent()
    expect(existsSync(join(ROOT, '.claude', 'skills', 'marveen-messaging'))).toBe(true)
    env()
    ensureHeartbeatAgent()
    expect(read(HB_MD)).toBe(prose())
    expect(start()).toBe(false)
    for (const n of PRODUCT_SKILLS) expect(existsSync(join(ROOT, '.claude', 'skills', n)), n).toBe(false)
  })
})

// The whole v2 heartbeat file for a fixed identity and the heartbeat fixture context: role prose, one blank line,
// the region. src/__tests__/fixtures/claude-md/golden-file/heartbeat-file-v2.md (outside golden/: that directory
// holds exactly the region fixtures, claude-md-goldens.test.ts). CLAUDE_MD_GOLDEN_UPDATE=1 writes it and fails.
describe('golden heartbeat-file-v2', () => {
  const ID: HeartbeatIdentity = {
    ownerName: 'Nina',
    botName: 'Helios',
    mainAgentId: 'helios',
    storeDir: '/srv/app/store',
    dashboardOrigin: 'http://localhost:3420',
    calendarAccount: 'nina@example.com',
    metricsScript: '/srv/app/scripts/heartbeat-metrics.sh',
  }
  const file = join(HERE, 'fixtures', 'claude-md', 'golden-file', 'heartbeat-file-v2.md')

  it('prose + region matches the golden byte for byte', () => {
    const text = composeClaudeMd(renderHeartbeatClaudeMd(ID), renderRegion(FIXTURES.heartbeat)).text
    if (process.env.CLAUDE_MD_GOLDEN_UPDATE === '1') {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text)
      throw new Error('golden heartbeat-file-v2.md written: review the diff and rerun without CLAUDE_MD_GOLDEN_UPDATE')
    }
    expect(text).toBe(read(file))
    expect(text).toBe(`${renderHeartbeatClaudeMd(ID)}\n${renderRegion(FIXTURES.heartbeat)}`)
  })
})
