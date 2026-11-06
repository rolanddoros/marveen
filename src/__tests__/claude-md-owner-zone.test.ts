// C1 PR 8a: the owner-zone detectors (owner-zone.ts) and the parity of their
// copied constants with the legacy writers they describe.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scanClaudeMd } from '../web/claude-md/compose.js'
import {
  DEFAULT_MAIN_AGENT_ID, HEARTBEAT_AGENT_ID, HIDDEN_AGENT_SENTINEL, SKILL_SECTION_HEADING, firstInvalidUtf8,
} from '../web/claude-md/dry-run.js'
import {
  INSTALL_ANCHORED_SUFFIXES, SNIFF_LITERALS, maskedExcerpt, ownerZoneFindings, retiredSectionFindings,
} from '../web/claude-md/owner-zone.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8')
const ROOT = '/srv/fleet'

const owner = (text: string) => scanClaudeMd(text).lines.filter((l) => l.kind === 'owner')
const find = (text: string, root = ROOT) => ownerZoneFindings(owner(text), root)
const curl = (text: string) => find(text).filter((f) => f.detector === 'curl-recipe')

describe('curl-recipe', () => {
  it.each([
    'curl -s http://localhost:3420/api/kanban',
    '  curl -s http://h/api/x',
    'x | curl -s http://h/api/x',
    'true && curl http://h/api/x',
    'false || curl http://h/api/x',
    'a; curl http://h/api/x',
    'R=$(curl -s http://h/api/x)',
    '(curl http://h/api/x)',
    'Run `curl -s http://h/api/x` first.',
  ])('command position: %s', (line) => {
    expect(curl(`${line}\n`)).toHaveLength(1)
  })

  it.each([
    'use curl to read http://h/api/x',
    'xcurl http://h/api/x',
    'curling http://h/api/x',
    'curl -s http://h/health',
  ])('not a dashboard recipe: %s', (line) => {
    expect(curl(`${line}\n`)).toEqual([])
  })

  it('joins backslash continuations and reports the first line', () => {
    const f = curl('intro\ncurl -s -X POST http://h/api/messages \\\n  -H "Authorization: Bearer ${TOKEN}" \\\n  -d "{}"\nafter\n')
    expect(f).toEqual([{ line: 2, detector: 'curl-recipe', pattern: 'curl-api', flags: ['token-on-argv', 'double-quoted-payload'] }])
  })

  it('a generated block ends a continuation', () => {
    const begin = '<!-- BEGIN GENERATED: fleet-roster (auto-generated, do not edit by hand) -->'
    const end = '<!-- END GENERATED: fleet-roster -->'
    const f = curl(`curl -s \\\n${begin}\nx\n${end}\nhttp://h/api/x\n`)
    expect(f).toEqual([])
  })

  it.each([
    ['-H "Authorization: Bearer $(cat /x/store/.dashboard-token)"', ['token-on-argv']],
    ["-H 'Authorization: Bearer '\"$T\"", ['token-on-argv']],
    ['-H "X: `cat /x/.dashboard-token`"', ['token-on-argv']],
    ["-H @<(printf 'Authorization: Bearer '; cat /x/store/.dashboard-token)", []],
    ['--data "{}"', ['double-quoted-payload']],
    ['--data-binary "{}"', ['double-quoted-payload']],
    ["--data-binary '{}'", []],
    ["--data-binary @- <<'JSON'", []],
    ['"http://h/api/memories?q=x"', ['raw-q']],
    ['-G --data-urlencode "q=x"', []],
  ])('flags for %s', (part, flags) => {
    expect(curl(`curl -s http://h/api/x ${part}\n`)[0].flags).toEqual(flags)
  })
})

describe('dashboard-token, stale-path', () => {
  it('flags a token path on a foreign root, not one under the root', () => {
    expect(find(`cat ${ROOT}/store/.dashboard-token\n`)).toEqual([
      { line: 1, detector: 'dashboard-token', pattern: 'dashboard-token', flags: [] },
    ])
    expect(find('cat /old/fleet/store/.dashboard-token\n')).toEqual([
      { line: 1, detector: 'dashboard-token', pattern: 'dashboard-token', flags: ['foreign-root'] },
      { line: 1, detector: 'stale-path', pattern: '/store/.dashboard-token', flags: [] },
    ])
  })

  it.each([
    ['/srv/fleet-dev/scripts/hooks/a.py', true], // a sibling directory is foreign (HOSTMOVE1003 boundary)
    ['/srv/fleet/scripts/hooks/a.py', false],
    ['/srv/fleet/agents/x/scripts/hooks/a.py', false], // inside the install is never foreign
    ['~/fleet/scripts/hooks/a.py', false],
    ['{{ROOT}}/scripts/hooks/a.py', false],
    ['scripts/hooks/a.py', false],
    ['/Users/old/m/scripts/marveen-api.sh', true],
    ['/Users/old/m/scripts/skill-lint.mjs', true],
    ['/Users/old/m/scripts/other.sh', false],
  ])('stale %s -> %s', (path, stale) => {
    expect(find(`run ${path} now\n`).some((f) => f.detector === 'stale-path')).toBe(stale)
  })

  it('reports the suffix only, never the foreign prefix, once per suffix per line', () => {
    const f = find('a /home/someone/x/scripts/hooks/a /home/someone/x/scripts/hooks/b\n')
    expect(f).toEqual([{ line: 1, detector: 'stale-path', pattern: '/scripts/hooks/', flags: [] }])
  })

  it('a trailing slash on the root does not change the boundary', () => {
    expect(find(`x ${ROOT}/scripts/hooks/a\n`, `${ROOT}/`)).toEqual([])
  })
})

describe('sniff literals', () => {
  it.each([
    ['Read the X-MEMORY-SEARCH header', 'x-memory-search'],
    ['## Flotta-szintű AUTH-szabály', 'auth-szabaly'],
    ['  ## Inter-agent kommunikáció  ', 'interagent-heading'],
    ['<!-- MARVEEN-FEDERATION:POLICY -->', 'federation-policy-anchor'],
  ])('%s -> %s', (line, id) => {
    expect(find(`${line}\n`)).toEqual([{ line: 1, detector: 'sniff-literal', pattern: id, flags: [] }])
  })

  it('the heading matches only as a whole line, as the federation writer does', () => {
    expect(find('see ## Inter-agent kommunikáció\n')).toEqual([])
  })

  it('a literal inside a generated block is not owner text', () => {
    const b = '<!-- BEGIN GENERATED: fleet-auth (auto-generated, do not edit by hand) -->'
    const e = '<!-- END GENERATED: fleet-auth -->'
    expect(find(`${b}\n## Flotta-szintű AUTH-szabály\n${e}\n`)).toEqual([])
  })
})

describe('retired sections', () => {
  const SEC = '## Öntanulás és Skill rendszer\n\nold text\n'
  it('finds a byte-equal copy at its first line, in each contiguous owner run', () => {
    const b = '<!-- BEGIN GENERATED: fleet-roster (auto-generated, do not edit by hand) -->'
    const e = '<!-- END GENERATED: fleet-roster -->'
    const text = `a\n${SEC}${b}\nx\n${e}\nb\n${SEC}`
    expect(retiredSectionFindings(owner(text), ['other', SEC])).toEqual([
      { line: 2, detector: 'sniff-literal', pattern: 'retired-skill-section-1', flags: [] },
      { line: 9, detector: 'sniff-literal', pattern: 'retired-skill-section-1', flags: [] },
    ])
  })
  it('a section split by a generated block, an edited copy or an empty list find nothing', () => {
    expect(retiredSectionFindings(owner(`${SEC.replace('old', 'new')}`), [SEC])).toEqual([])
    expect(retiredSectionFindings(owner(SEC), [])).toEqual([])
    expect(retiredSectionFindings(owner(SEC), [''])).toEqual([])
  })
})

describe('masked excerpt', () => {
  it('masks Bearer values, 6+ digit runs and e-mail addresses, and cuts long lines', () => {
    expect(maskedExcerpt('  Authorization: Bearer abcdef0123456789xyz chat 6947718 a.b@c.hu  '))
      .toBe('Authorization: Bearer <masked> chat <masked> <masked>')
    expect(maskedExcerpt('x'.repeat(200))).toBe(`${'x'.repeat(160)}...`)
    expect(maskedExcerpt('ok 12345')).toBe('ok 12345')
  })
})

describe('firstInvalidUtf8', () => {
  it.each([
    [[0x61, 0x62], -1],
    [[0xc3, 0xa1], -1], // á
    [[0xef, 0xbb, 0xbf, 0x61], -1], // BOM
    [[0xf0, 0x9f, 0x98, 0x80], -1], // U+1F600
    [[0x61, 0x80], 1], // lone continuation
    [[0xc0, 0x80], 0], // overlong
    [[0xe0, 0x80, 0x80], 0], // overlong
    [[0xed, 0xa0, 0x80], 0], // surrogate
    [[0xf4, 0x90, 0x80, 0x80], 0], // above U+10FFFF
    [[0x61, 0xe2, 0x82], 1], // truncated
  ])('%j -> %i, and agrees with the fatal TextDecoder', (bytes, at) => {
    const buf = Uint8Array.from(bytes as number[])
    expect(firstInvalidUtf8(buf)).toBe(at)
    let decoderOk = true
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { decoderOk = false }
    expect(decoderOk).toBe(at === -1)
  })
})

// The copies below cannot import their source (agent-scaffold.ts and
// agent-config.ts pull in config.js; see dry-run.ts), so the sources are read
// as text and the copies must match them.
describe('parity with the legacy writers', () => {
  const scaffold = read('web/agent-scaffold.ts')
  const onboarding = read('web/federation/onboarding.ts')

  it('INSTALL_ANCHORED_SUFFIXES is the agent-scaffold.ts list', () => {
    const m = /export const INSTALL_ANCHORED_SUFFIXES = \[([\s\S]*?)\] as const/.exec(scaffold)
    expect(m).not.toBeNull()
    const theirs = [...(m as RegExpExecArray)[1].matchAll(/^\s*'([^']+)',/gm)].map((x) => x[1])
    expect([...INSTALL_ANCHORED_SUFFIXES]).toEqual(theirs)
  })

  it('the foreign-root pattern is the FOREIGN_ROOT_RE construction of agent-scaffold.ts', () => {
    const pat = '`(?<![\\\\w~}.\\\\-/])(/[^\\\\s"\'\\`()<>\\\\[\\\\]]*?)(${INSTALL_ANCHORED_SUFFIXES.map('
    expect(scaffold).toContain(`const FOREIGN_ROOT_RE = new RegExp(\n  ${pat}`)
    expect(read('web/claude-md/owner-zone.ts')).toContain(`    ${pat}escapeRe).join('|')})\`,\n    'g',`)
    expect(scaffold).toContain('if (prefix === root || prefix.startsWith(root + \'/\')) return whole')
  })

  it('every sniff of agent-scaffold.ts that skips a block is listed', () => {
    const sniffs = [...scaffold.matchAll(/if \(!hasBlock && (\/[^/]+\/i)\.test\(existing\)\) return/g)].map((m) => m[1])
    expect(sniffs).toEqual(['/x-memory-search/i', '/AUTH-szabály/i'])
    const ids = SNIFF_LITERALS.map((s) => s.id)
    expect(ids).toEqual(['x-memory-search', 'auth-szabaly', 'interagent-heading', 'federation-policy-anchor'])
    for (const s of sniffs) expect(SNIFF_LITERALS.some((l) => l.source.endsWith(s))).toBe(true)
  })

  it('the federation literals are onboarding.ts constants, used the same way', () => {
    expect(onboarding).toContain("const INTERAGENT_HEADING = '## Inter-agent kommunikáció'")
    expect(onboarding).toContain('lines.findIndex((l) => l.trim() === INTERAGENT_HEADING)')
    expect(onboarding).toContain("export const FEDERATION_POLICY_ANCHOR = '<!-- MARVEEN-FEDERATION:POLICY -->'")
    expect(onboarding).toContain('!working.includes(FEDERATION_POLICY_ANCHOR)')
  })

  it('the token-on-argv rules are the product-skill argv ban (C1 PR 9b)', () => {
    const skillsTest = read('__tests__/claude-md-skills.test.ts')
    expect(skillsTest).toContain(String.raw`/Authorization:\s*Bearer\s*['"]*\s*\$/`)
    const oz = read('web/claude-md/owner-zone.ts')
    expect(oz).toContain(String.raw`/Authorization:\s*Bearer\s*['"]*\s*\$/,`)
  })

  it('agent listing and section constants match their sources', () => {
    const cfg = read('config.ts')
    const agentConfig = read('web/agent-config.ts')
    expect(cfg).toContain(`export const MAIN_AGENT_ID = env['MAIN_AGENT_ID'] ?? '${DEFAULT_MAIN_AGENT_ID}'`)
    expect(cfg).toContain(`export const HEARTBEAT_AGENT_ID = '${HEARTBEAT_AGENT_ID}'`)
    expect(agentConfig).toContain(`export const HIDDEN_AGENT_SENTINEL = '${HIDDEN_AGENT_SENTINEL}'`)
    expect(scaffold).toContain(`const SKILL_SECTION_HEADING = '${SKILL_SECTION_HEADING}'`)
    expect(scaffold).toContain("join(PROJECT_ROOT, 'templates', 'retired-claude-md-sections.json')")
  })
})
