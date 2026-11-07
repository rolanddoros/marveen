// C1 PR 11c: generateClaudeMd asks the model for role and persona only. The seven
// sections the creation prompt used to tell the model to "copy exactly" (memory,
// schedules, skills, time, deferred MCP tools, unknown sender, fleet rules) are
// appended by the code instead, byte for byte as the prompt carried them, with
// AGENT_NAME replaced by the agent's name (what the prompt asked the model to do).
//
// They are plain owner-zone text, not a marker block (Kevin 13332): the v2 region
// and the product skills do not carry all of them yet (Drive, email draft-only,
// flag-and-wait, memory tiers, time zone, deferred MCP tools), so a flag flip must
// not remove them. The fixtures under fixtures/creation-sections/ were captured
// from the base commit's prompt (3683630a) with the same mocks, the temporary root
// written as <ROOT>; this test pins the generated file against them.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURES = join(REPO, 'src', '__tests__', 'fixtures', 'creation-sections')
const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-creation-sections-'))
cpSync(join(REPO, 'templates', 'profiles'), join(tmpRoot, 'templates', 'profiles'), { recursive: true })
const captured: string[] = []
const settings: Record<string, string> = {}

vi.mock('../config.js', () => ({
  STORE_DIR: '/nonexistent/claudeclaw-test-store',
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  HEARTBEAT_AGENT_ID: 'heartbeat',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  AGENT_API_ORIGIN: '',
  APP_TZ: 'Europe/Budapest',
  mainAgentRecipientLedgerEnabled: () => false,
}))
vi.mock('../web/agent-config.js', () => {
  const dir = (n: string) => join(tmpRoot, 'agents', n)
  const readFileOr = (p: string, d: string) => (existsSync(p) ? readFileSync(p, 'utf-8') : d)
  return {
    agentDir: dir,
    agentConfigRoot: () => join(tmpRoot, 'agents'),
    listAgentNames: () => [],
    readAgentCapabilities: () => [],
    readAgentToolDeny: () => [],
    readFileOr,
    readJsonObjectForWrite: (p: string) => JSON.parse(readFileOr(p, '{}')),
    readAgentSecurityProfile: (n: string) => {
      try {
        return JSON.parse(readFileSync(join(dir(n), 'agent-config.json'), 'utf-8')).securityProfile || 'default'
      } catch {
        return 'default'
      }
    },
  }
})
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: (k: string) => settings[k] ?? '' }))
vi.mock('../agent.js', () => ({
  runAgent: async (prompt: string) => {
    captured.push(prompt)
    return { text: '# generated body' }
  },
}))

const S = await import('../web/agent-scaffold.js')

export interface CreationCase {
  id: string
  name: string
  profile?: string
  denyHelper?: boolean
  drive?: string
  ownToken?: boolean
}

// plain: the helper recipes; strict: developer-junior (dontAsk, helper forced);
// denied: settings deny the helper, so the curl recipes; drive: a configured
// OWNER_DRIVE_FOLDER; own-token: AGENT_TOKENS on with a provisioned token file.
export const CASES: CreationCase[] = [
  { id: 'plain', name: 'plain-c' },
  { id: 'strict', name: 'strict-c', profile: 'developer-junior' },
  { id: 'denied', name: 'denied-c', denyHelper: true },
  { id: 'drive', name: 'drive-c', drive: '1AbCdEfGhIjKlMnOp' },
  { id: 'own-token', name: 'owntok-c', ownToken: true },
]

export function stage(c: CreationCase): void {
  for (const k of Object.keys(settings)) delete settings[k]
  const dir = join(tmpRoot, 'agents', c.name)
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify(c.profile ? { securityProfile: c.profile } : {}), 'utf-8')
  if (c.denyHelper) {
    writeFileSync(join(dir, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { deny: [`Bash(bash ${join(tmpRoot, 'scripts', 'marveen-api.sh')} memory-save:*)`] } }), 'utf-8')
  }
  if (c.drive) settings.OWNER_DRIVE_FOLDER = c.drive
  if (c.ownToken) {
    settings.AGENT_TOKENS = '1'
    writeFileSync(join(dir, '.dashboard-token'), `${c.name}-0123456789abcdef0123456789abcdef\n`, { mode: 0o600 })
  }
}

export async function creation(c: CreationCase, opts?: { telegram?: boolean }): Promise<{ prompt: string; out: string }> {
  stage(c)
  captured.length = 0
  const out = opts === undefined
    ? await S.generateClaudeMd(c.name, 'desc', 'model')
    : await S.generateClaudeMd(c.name, 'desc', 'model', opts)
  return { prompt: captured[0] ?? '', out }
}

export const ROOT_PLACEHOLDER = '<ROOT>'
export const toFixture = (s: string) => s.split(tmpRoot).join(ROOT_PLACEHOLDER)
const fromFixture = (s: string) => s.split(ROOT_PLACEHOLDER).join(tmpRoot)

// The headings of the seven sections, in order.
const HEADINGS = [
  '## Memoria rendszer',
  '## Ütemezett feladatok',
  '## Öntanulás és Skill rendszer',
  '## Időkezelés',
  '## MCP-toolok deferred betöltése (FLEETDEFER809)',
  '## Új ismeretlen sender első üzenete (ARANYSZABÁLY)',
  '## Flotta-szabályok (MEGSZEGHETETLEN',
]

const FLEET_ROSTER_BEGIN = '<!-- BEGIN GENERATED: fleet-roster'

describe('generateClaudeMd: the seven mandatory sections come from the code, not the model (C1 PR 11c)', () => {
  beforeEach(() => { captured.length = 0 })

  for (const c of CASES) {
    it(`${c.id}: the file is the model's body, then the seven sections byte-identical to the base prompt, then the generated blocks`, async () => {
      const expected = fromFixture(readFileSync(join(FIXTURES, `${c.id}.md`), 'utf-8'))
      const { out } = await creation(c)
      expect(out.startsWith(`# generated body\n\n${expected}\n\n${FLEET_ROSTER_BEGIN}`)).toBe(true)
      expect(out).not.toContain('AGENT_NAME')
    })

    it(`${c.id}: the prompt carries none of the seven sections and no "copy them exactly" instruction`, async () => {
      const { prompt } = await creation(c)
      expect(prompt).not.toContain('copy them exactly')
      for (const h of HEADINGS) expect(prompt, h).not.toContain(h)
      for (const s of ['Memória mentés:', 'Napi napló (append-only):', '1. **Drive-írás', 'FLEETDEFER809', 'Bearer']) {
        expect(prompt, s).not.toContain(s)
      }
    })
  }

  it('the fixtures exercise every branch they claim to (helper, strict, curl, drive, own token)', () => {
    const f = (id: string) => readFileSync(join(FIXTURES, `${id}.md`), 'utf-8')
    expect(f('plain')).toContain('marveen-api.sh memory-save')
    expect(f('plain')).not.toContain('Authorization: Bearer')
    expect(f('strict')).toContain('skill-javaslat-indok.txt')
    expect(f('denied')).toContain('Authorization: Bearer $(cat <ROOT>/store/.dashboard-token)')
    expect(f('drive')).toContain('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp')
    expect(f('plain')).toContain('kérd el TestOwner-tól a megfelelő Drive mappát')
    expect(f('own-token')).toContain('A segéd a SAJÁT tokenedet küldi (AGENT_TOKENS)')
    for (const c of CASES) {
      const text = f(c.id)
      let at = -1
      for (const h of HEADINGS) {
        const i = text.indexOf(h)
        expect(i, `${c.id}: ${h}`).toBeGreaterThan(at)
        at = i
      }
    }
  })

  it('the prompt still asks for role and persona from the description, and leaves channels and owner messaging out', async () => {
    const { prompt } = await creation(CASES[0])
    expect(prompt).toContain('Agent name: plain-c')
    expect(prompt).toContain('Description of what the agent should do: desc')
    expect(prompt).toContain('The owner\'s name is TestOwner.')
    expect(prompt).toContain('NEVER write Hungarian without accents.')
    expect(prompt).toContain('Never use em dash')
    expect(prompt).not.toMatch(/Communication style/)
    expect(prompt).toMatch(/Do not write .*Telegram/)
  })

  // C1 PR 11c-2 (Roland TG 3151 = C, Kevin 13410): without a Telegram bot the model is
  // asked for no persona; the seven sections stay, byte-identical to the same fixtures.
  for (const c of CASES) {
    it(`${c.id}: telegram=false keeps the seven sections byte-identical to the base prompt`, async () => {
      const expected = fromFixture(readFileSync(join(FIXTURES, `${c.id}.md`), 'utf-8'))
      const { out, prompt } = await creation(c, { telegram: false })
      expect(out.startsWith(`# generated body\n\n${expected}\n\n${FLEET_ROSTER_BEGIN}`)).toBe(true)
      expect(out).not.toContain('AGENT_NAME')
      for (const h of HEADINGS) expect(prompt, h).not.toContain(h)
    })
  }

  it('the request without the option and with telegram=true is the same, the role and persona one', async () => {
    const { prompt: missing } = await creation(CASES[0])
    const { prompt: withTelegram } = await creation(CASES[0], { telegram: true })
    expect(withTelegram).toBe(missing)
    expect(missing).toContain("Generate the agent's role and persona only:\n- Clear role and responsibilities based on the description above\n- Behavioral guidelines\n")
    expect(missing).not.toContain('no persona')
  })

  it('telegram=false asks for role and work rules only: no persona, no behaviour or style guidelines', async () => {
    const { prompt } = await creation(CASES[0], { telegram: false })
    expect(prompt).not.toContain('role and persona only')
    expect(prompt).not.toContain('Behavioral guidelines')
    expect(prompt).toContain("Generate the agent's role and hard work rules only. This agent has no Telegram bot and no persona:")
    expect(prompt).toContain('do not write a persona, personality, character, communication style or tone of voice.')
    expect(prompt).toContain('Description of what the agent should do: desc')
    expect(prompt).toContain('Language rules (Hungarian with TestOwner')
    expect(prompt).toMatch(/Do not write sections on Telegram/)
    expect(prompt).toContain('NEVER write Hungarian without accents.')
  })
})
