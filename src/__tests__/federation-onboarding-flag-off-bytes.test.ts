// C1 PR 12b: with no CLAUDE.md builder flag on, the federation reconcile (federation/onboarding.ts
// ensureFederationClaudeMdSection) writes exactly what it wrote before 12b, also with the builder module loaded (it
// registers its region refresh there since 12b). The fixtures were written by THIS file at the base (447195d7, C1
// PR 12a, before 12b):
//   git worktree add <dir> 447195d7 && cp <this file> <dir>/src/__tests__/ &&
//   FED_FLAG_OFF_WRITE=<fixture dir> vitest run src/__tests__/federation-onboarding-flag-off-bytes.test.ts   (in <dir>)
// It only imports what the base has. The temp root is written as <ROOT> in the fixtures.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const { ROOT, HOME_BEFORE } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fed-flag-off-root-'))
  process.env.CLAUDECLAW_ENV_DIR = root
  const homeBefore = process.env.HOME
  process.env.HOME = path.join(root, 'home')
  return { ROOT: root, HOME_BEFORE: homeBefore }
})

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  PROJECT_ROOT: ROOT,
  STORE_DIR: `${ROOT}/store`,
  MAIN_AGENT_ID: 'boss',
}))

import { ensureFederationClaudeMdSection } from '../web/federation/onboarding.js'
import { reloadFederationForTest } from '../web/federation/config.js'
import '../web/claude-md/wire.js'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'federation-flag-off')
const WRITE_TO = process.env.FED_FLAG_OFF_WRITE
const LEGACY = '<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->\nold\n<!-- END GENERATED: autonomy-wiring -->\n'
// Synthetic, low-entropy tokens: the validator wants 32 characters.
const tok = (c: string) => c.repeat(32)
const PEER_A = { id: 'north', baseUrl: 'https://north.example', inboundToken: tok('a'), outboundToken: tok('b') }
const PEER_B = { id: 'south-lab', baseUrl: 'http://127.0.0.1:3999', inboundToken: tok('c'), outboundToken: '' }

function put(rel: string, content: string): void {
  const p = join(ROOT, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

// Every path under the root but .env and store/ (the test writes them), and every CLAUDE.md in full, <ROOT> for the root.
function dump(): string {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const n of readdirSync(dir).sort()) {
      const p = join(dir, n)
      const rel = relative(ROOT, p)
      if (rel === '.env' || rel === 'store' || rel === 'home') continue
      if (lstatSync(p).isDirectory()) { out.push(`D ${rel}`); walk(p); continue }
      out.push(`F ${rel}`)
      if (n === 'CLAUDE.md') out.push(readFileSync(p, 'utf-8'), `--- end ${rel}`)
    }
  }
  walk(ROOT)
  return out.join('\n').split(ROOT).join('<ROOT>')
}

function setFed(cfg: object): void {
  put('store/federation.json', JSON.stringify(cfg))
  reloadFederationForTest()
}

// Enable with two peers, add a third and switch the routing mode, disable: the main file and two subs after each.
function scenario(): string {
  const steps: string[] = []
  setFed({ enabled: true, peers: [PEER_A, PEER_B] })
  ensureFederationClaudeMdSection()
  steps.push(`== enabled\n${dump()}`)
  setFed({ enabled: true, routingMode: 'strong', peers: [PEER_A, PEER_B, { ...PEER_A, id: 'east', inboundToken: tok('d') }] })
  ensureFederationClaudeMdSection()
  steps.push(`== peer added, strong\n${dump()}`)
  ensureFederationClaudeMdSection()
  steps.push(`== again\n${dump()}`)
  setFed({ enabled: false, peers: [PEER_A] })
  ensureFederationClaudeMdSection()
  steps.push(`== disabled\n${dump()}`)
  return steps.join('\n')
}

// The .env lines the head reads as "off"; the base has no such reading, so all of them must give the base bytes.
const OFF = ['', 'CLAUDE_MD_BUILDER_MAIN=V2\n', 'CLAUDE_MD_BUILDER_MAIN=\n', 'CLAUDE_MD_BUILDER_HEARTBEAT=v2\n']

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(ROOT, 'home'), { recursive: true })
})
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  delete process.env.CLAUDECLAW_ENV_DIR
  if (HOME_BEFORE === undefined) delete process.env.HOME
  else process.env.HOME = HOME_BEFORE
})

describe('flag off: the federation reconcile writes the base bytes', () => {
  it('main + a sub + a sub with legacy blocks and an agent-config flag of another value, through enable, change, disable', () => {
    for (const off of WRITE_TO ? [''] : OFF) {
      rmSync(ROOT, { recursive: true, force: true })
      mkdirSync(join(ROOT, 'home'), { recursive: true })
      put('.env', `MAIN_AGENT_ID=boss\n${off}`)
      put('CLAUDE.md', '# Boss\n\nOwner text, ékezet.\n\n## Inter-agent kommunikáció\n\nSend with the helper.\n\n## Later\n\nmore\n')
      put('agents/alpha/CLAUDE.md', '# Alpha\n\nOwner text.\n')
      put('agents/beta/CLAUDE.md', `# Beta\n\n${LEGACY}`)
      put('agents/beta/agent-config.json', JSON.stringify({ claudeMdBuilder: 'V2' }))
      const got = scenario()
      if (WRITE_TO) {
        mkdirSync(WRITE_TO, { recursive: true })
        writeFileSync(join(WRITE_TO, 'scenario.txt'), got)
        continue
      }
      expect(got, JSON.stringify(off)).toBe(readFileSync(join(FIXTURE_DIR, 'scenario.txt'), 'utf-8'))
      expect(got).not.toContain('BEGIN MARVEEN GENERATED v2')
    }
  })
})
