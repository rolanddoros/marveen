// C1 PR 12a: with the heartbeat flag off, ensureHeartbeatAgent writes exactly what it wrote before the v2 builder
// was wired into it. The fixtures were written by THIS file at the base (fork main 5b7c8578, before 12a), which has
// no flag at all:
//   git worktree add <tmp> 5b7c8578 && cp <this file> <tmp>/src/__tests__/ &&
//   HB_FLAG_OFF_WRITE=<fixture dir> vitest run src/__tests__/heartbeat-scaffold-flag-off-bytes.test.ts   (in <tmp>)
// It only imports what the base has. The temp root is written as <ROOT> in the fixtures.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const { ROOT, HOME_BEFORE } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-flag-off-root-'))
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

import { ensureHeartbeatAgent } from '../web/heartbeat-agent-scaffold.js'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'heartbeat-flag-off')
const WRITE_TO = process.env.HB_FLAG_OFF_WRITE
const REGION = '<!-- BEGIN MARVEEN GENERATED v2 (do not edit; source: src/web/claude-md) -->\n## Marveen\nold region\n<!-- END MARVEEN GENERATED v2 -->\n'
const LEGACY = '<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->\nold\n<!-- END GENERATED: autonomy-wiring -->\n'

// What the scaffold leaves behind: every path under the root but .env (the tests vary it), and the content of every
// file under agents/heartbeat, the temp root written as <ROOT>.
function dump(): string {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const n of readdirSync(dir).sort()) {
      const p = join(dir, n)
      const rel = relative(ROOT, p)
      if (rel === '.env') continue
      if (lstatSync(p).isDirectory()) { out.push(`D ${rel}`); walk(p); continue }
      out.push(`F ${rel}`)
      if (rel.startsWith('agents/heartbeat/')) out.push(readFileSync(p, 'utf-8'), `--- end ${rel}`)
    }
  }
  walk(ROOT)
  return out.join('\n').split(ROOT).join('<ROOT>')
}

const SCENARIOS: Record<string, () => void> = {
  'fresh': () => {},
  'legacy-file': () => put('agents/heartbeat/CLAUDE.md', `# Heartbeat agent\n\nold prose\n\n${LEGACY}`),
  'v2-file': () => put('agents/heartbeat/CLAUDE.md', `# Heartbeat agent\n\nold prose\n\n${REGION}`),
}
// The .env lines the head reads as "off"; the base has no flag, so all of them must give the base bytes.
const OFF = ['', 'CLAUDE_MD_BUILDER_HEARTBEAT=V2\n', 'CLAUDE_MD_BUILDER_HEARTBEAT=true\n', 'CLAUDE_MD_BUILDER_HEARTBEAT=\n', 'CLAUDE_MD_BUILDER_MAIN=v2\n']

function put(rel: string, content: string): void {
  const p = join(ROOT, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

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

describe('flag off: the heartbeat scaffold writes the base bytes', () => {
  for (const [name, setup] of Object.entries(SCENARIOS)) {
    it(`${name}: every off value gives the bytes the base wrote (no region, no backup, no skills)`, () => {
      for (const off of WRITE_TO ? [''] : OFF) {
        rmSync(ROOT, { recursive: true, force: true })
        mkdirSync(join(ROOT, 'home'), { recursive: true })
        put('.env', `MAIN_AGENT_ID=boss\n${off}`)
        setup()
        ensureHeartbeatAgent()
        const got = dump()
        if (WRITE_TO) {
          mkdirSync(WRITE_TO, { recursive: true })
          writeFileSync(join(WRITE_TO, `${name}.txt`), got)
          continue
        }
        expect(got, JSON.stringify(off)).toBe(readFileSync(join(FIXTURE_DIR, `${name}.txt`), 'utf-8'))
        expect(got).not.toContain('BEGIN MARVEEN GENERATED v2')
        expect(existsSync(join(ROOT, 'store'))).toBe(false)
        expect(existsSync(join(ROOT, '.claude'))).toBe(false)
      }
    })
  }
})
