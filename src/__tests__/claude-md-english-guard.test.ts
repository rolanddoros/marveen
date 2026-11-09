// CLAUDE-EN (Roland TG 2972 + TG 3024, Kevin 14352): the text the v2 CLAUDE.md builder writes is English, on the main
// agent and on every sub-agent. The persona and owner zone are the owner's and are not checked here; the answer
// language of an agent is set there.
//
// The guard covers what the v2 path produces or ships:
// - the builder's source, src/web/claude-md/*.ts (its string literals end up in the region or the dry-run report);
// - the region templates, templates/claude-md/*.md;
// - the product skill templates, templates/skills/*.md (the v2 path installs them, the region points at them);
// - the golden files of the region, src/__tests__/fixtures/claude-md/golden*/;
// - and, rendered, the region of every golden fixture and every product skill, so a source change shows here before
//   anyone regenerates a golden.
// In the .ts sources, \uXXXX, \u{X} and \xXX escapes are decoded first, so an escaped accent counts as one.
//
// Some Hungarian words are fixed literals, not prose: a prefix the dashboard writes, a message frame another agent
// recognises word for word, or a detector that looks for the legacy Hungarian text. They are listed in ALLOWLIST, each
// with the one file it may live in and why. Anything else with a Hungarian accent fails, naming file and line. An
// allowlist entry that no longer occurs in its file fails too, so the list cannot go stale.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURES } from './fixtures/claude-md/contexts.js'
import { renderRegion } from '../web/claude-md/registry.js'
import { PRODUCT_SKILLS, renderProductSkill, type SkillContext } from '../web/claude-md/skills.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')

// The Hungarian accented letters, plus the tilde and circumflex look-alikes a wrong keyboard layout types for ő and ű.
const HU_ACCENT = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰõûÕÛ]/

interface Allowed {
  file: string
  literal: string
  reason: string
}

const COMPLETION_PREFIX = 'COMPLETION_REPORT_PREFIX (src/db.ts): the dashboard prefixes the receipt it sends on a message close with it; the skill names it so the reader recognises the receipt.'
const PING_FRAME = 'The fixed unknown-sender ping frame: the main agent recognises it by these words (templates/CLAUDE.md.template "Új ismeretlen sender" section, agent-scaffold.ts creation prompt).'
const HOLDING_REPLY = 'The holding reply an unknown sender gets, in the same words as templates/CLAUDE.md.template (DEFAULT-DENY step) and the agent-scaffold.ts creation prompt.'
const NOTICE_PREFIX = 'The level-1 notice prefix: the legacy autonomy block (agent-scaffold.ts buildAutonomyBody) and schedule-runner.ts send it too, so it stays one prefix on both paths while the agents move to v2.'

const ALLOWLIST: readonly Allowed[] = [
  { file: 'templates/skills/marveen-messaging.md', literal: '[Eredmény]', reason: COMPLETION_PREFIX },
  {
    file: 'templates/skills/marveen-messaging.md',
    literal: 'Ismeretlen sender [ID] jelezett első üzenettel: [üzenet röviden]. Ki ez, mit válaszoljak?',
    reason: PING_FRAME,
  },
  {
    file: 'templates/skills/marveen-messaging.md',
    literal: "Ismeretlen sender [ID] jelezett első üzenettel: '...'. Ki ez, mit válaszoljak?",
    reason: PING_FRAME,
  },
  {
    file: 'templates/skills/marveen-messaging.md',
    literal: "Egy sub-ágenshez ismeretlen, NEM párosított sender [ID] írt: '...'. Jóváhagyod?",
    reason: 'The main agent\'s fixed escalation to the owner for an unpaired sender, word for word from templates/CLAUDE.md.template (DEFAULT-DENY step).',
  },
  { file: 'templates/skills/marveen-messaging.md', literal: 'Egy pillanat, ellenőrzöm', reason: HOLDING_REPLY },
  { file: 'templates/skills/marveen-messaging.md', literal: 'egy pillanat, ellenőrzöm', reason: HOLDING_REPLY },
  { file: 'templates/skills/marveen-messaging.md', literal: '[FELHÍVÁS]', reason: NOTICE_PREFIX },
  { file: 'templates/skills/marveen-approvals.md', literal: '[FELHÍVÁS]', reason: NOTICE_PREFIX },
  {
    file: 'src/web/claude-md/owner-zone.ts',
    literal: 'AUTH-szabály',
    reason: 'SNIFF_LITERALS: the dry-run reports the legacy sniff of agent-scaffold.ts ensureFleetAuthSection (/AUTH-szabály/i), which matches the Hungarian legacy heading.',
  },
  {
    file: 'src/web/claude-md/owner-zone.ts',
    literal: '## Inter-agent kommunikáció',
    reason: 'SNIFF_LITERALS: the federation anchor heading of federation/onboarding.ts INTERAGENT_HEADING, an owner-zone heading the dry-run reports.',
  },
  {
    file: 'src/web/claude-md/owner-zone.ts',
    literal: 'egyszerre egy kérdés',
    reason: 'SHORTEN_PATTERNS one-question: classifies a Hungarian owner rule in the owner zone (the owner text stays Hungarian).',
  },
  {
    file: 'src/web/claude-md/owner-zone.ts',
    literal: 'kommunikáci',
    reason: 'SHORTEN_PATTERNS communication: classifies Hungarian owner text in the owner zone (the owner text stays Hungarian).',
  },
  {
    file: 'src/web/claude-md/dry-run.ts',
    literal: '## Öntanulás és Skill rendszer',
    reason: 'SKILL_SECTION_HEADING: mirrors agent-scaffold.ts, the owner-zone skill section the dry-run reports (the key of templates/retired-claude-md-sections.json).',
  },
]

function decodeEscapes(src: string): string {
  return src.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g,
    (_m, braced: string | undefined, four: string | undefined, two: string | undefined) =>
      String.fromCodePoint(parseInt(braced ?? four ?? two ?? '0', 16)))
}

const filesIn = (dir: string, ext: string) =>
  readdirSync(join(REPO, dir)).filter((f) => f.endsWith(ext)).sort().map((f) => `${dir}/${f}`)

const SCOPE = {
  source: filesIn('src/web/claude-md', '.ts'),
  regionTemplates: filesIn('templates/claude-md', '.md'),
  skillTemplates: filesIn('templates/skills', '.md'),
  goldens: [...filesIn('src/__tests__/fixtures/claude-md/golden', '.md'), ...filesIn('src/__tests__/fixtures/claude-md/golden-file', '.md')],
}
const ALL_FILES = Object.values(SCOPE).flat()

function readScoped(file: string): string {
  const raw = readFileSync(join(REPO, file), 'utf-8')
  return file.endsWith('.ts') ? decodeEscapes(raw) : raw
}

// The text with every allowlisted literal of `file` cut out, longest first (one literal may contain another).
function withoutAllowed(text: string, file: string): string {
  return ALLOWLIST.filter((a) => a.file === file)
    .map((a) => a.literal)
    .sort((a, b) => b.length - a.length)
    .reduce((t, lit) => t.split(lit).join(''), text)
}

function accentLines(text: string): string[] {
  return text.split('\n').flatMap((l, i) => (HU_ACCENT.test(l) ? [`${i + 1}: ${l.trim()}`] : []))
}

describe('CLAUDE-EN: the v2 builder writes English', () => {
  it('every scope group has files (a moved directory cannot empty the guard)', () => {
    expect(SCOPE.source.length).toBeGreaterThan(0)
    expect(SCOPE.regionTemplates.length).toBeGreaterThan(0)
    // Every product skill has its template in scope.
    for (const name of PRODUCT_SKILLS) expect(SCOPE.skillTemplates).toContain(`templates/skills/${name}.md`)
    // Every golden fixture has its golden file in scope.
    for (const name of Object.keys(FIXTURES)) expect(SCOPE.goldens).toContain(`src/__tests__/fixtures/claude-md/golden/${name}.md`)
  })

  for (const file of ALL_FILES) {
    it(`${file}: no Hungarian accent outside the allowlist`, () => {
      expect({ file, lines: accentLines(withoutAllowed(readScoped(file), file)) }).toEqual({ file, lines: [] })
    })
  }

  for (const name of Object.keys(FIXTURES)) {
    it(`rendered region ${name}: no Hungarian accent`, () => {
      expect({ name, lines: accentLines(renderRegion(FIXTURES[name])) }).toEqual({ name, lines: [] })
    })
  }

  const ctx: SkillContext = { projectRoot: '/srv/fleet', mainAgentId: 'chief', dashboardOrigin: 'http://localhost:4545' }
  for (const name of PRODUCT_SKILLS) {
    it(`rendered skill ${name}: no Hungarian accent outside the allowlist`, () => {
      const file = `templates/skills/${name}.md`
      expect({ name, lines: accentLines(withoutAllowed(renderProductSkill(name, ctx), file)) }).toEqual({ name, lines: [] })
    })
  }

  describe('the allowlist', () => {
    for (const a of ALLOWLIST) {
      it(`${a.file}: "${a.literal}" is in scope, still present, Hungarian and has a reason`, () => {
        expect(ALL_FILES).toContain(a.file)
        expect(readScoped(a.file)).toContain(a.literal)
        expect(a.literal).toMatch(HU_ACCENT)
        expect(a.reason.length).toBeGreaterThan(20)
      })
    }

    it('has no duplicate entry', () => {
      const keys = ALLOWLIST.map((a) => `${a.file}\0${a.literal}`)
      expect(new Set(keys).size).toBe(keys.length)
    })
  })
})
