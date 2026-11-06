// C1 PR 7a: the whitelist renderer, the value check, the region frame and the
// section registry (src/web/claude-md/render.ts, registry.ts).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REGION_BEGIN, REGION_END, TemplateError, checkBody, checkValue, loadTemplate, renderTemplate,
  templateKeys, wrapRegion,
} from '../web/claude-md/render.js'
import { renderRegion, renderSections, type Section } from '../web/claude-md/registry.js'
import { FIXTURES } from './fixtures/claude-md/contexts.js'
import type { AgentDocContext } from '../web/claude-md/context.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_TEMPLATES = join(HERE, 'fixtures', 'claude-md', 'templates')
const MODULE_DIR = join(HERE, '..', 'web', 'claude-md')
const cp = (n: number) => String.fromCodePoint(n)

const ctx: AgentDocContext = {
  name: 'tom',
  role: 'sub',
  mainAgentId: 'main',
  botName: 'bot',
  owner: { name: 'Owner', chatId: null },
  projectRoot: '/srv/fleet',
  tokenPath: '/srv/fleet/store/.dashboard-token',
  profile: { id: 'developer-junior', strict: true, helperAllowed: true },
  capabilities: {
    kanbanWrite: false, scheduleWrite: false, emailSend: 'none', browser: false, federation: false, thinChief: false,
  },
  autonomy: {},
  team: { reportsTo: 'kevin', directReports: [] },
  roster: [{ name: 'kevin' }],
  hooks: { directiveVerify: false, childClaudeGuard: true, shellRescan: false },
}

describe('renderTemplate', () => {
  it('fills every placeholder', () => {
    expect(renderTemplate('Hi {{name}}, main is {{main}}.', { name: 'tom', main: 'johnny' })).toBe('Hi tom, main is johnny.')
  })

  it('repeats a key as often as the template uses it', () => {
    expect(renderTemplate('{{a}}-{{a}}', { a: 'x' })).toBe('x-x')
  })

  it('keeps "$&", "$1" and "{{x}}" inside a value literal (one pass, function replacer)', () => {
    expect(renderTemplate('[{{v}}]', { v: '$& $1 $$ {{w}}' })).toBe('[$& $1 $$ {{w}}]')
  })

  it('throws on a placeholder without a value', () => {
    expect(() => renderTemplate('{{a}} {{b}}', { a: 'x' })).toThrow(/no value for \{\{b\}\}/)
  })

  it('throws on a value no placeholder uses', () => {
    expect(() => renderTemplate('{{a}}', { a: 'x', b: 'y' })).toThrow(/\{\{b\}\} is not used/)
  })

  it('throws on a malformed placeholder', () => {
    expect(() => renderTemplate('{{a b}}', {})).toThrow(TemplateError)
    expect(() => templateKeys('{{a-b}}')).toThrow(/invalid placeholder/)
  })

  it('does not treat an inherited property as a value', () => {
    expect(() => renderTemplate('{{toString}}', {})).toThrow(/no value for \{\{toString\}\}/)
  })

  it('lists the keys in first-use order, without duplicates', () => {
    expect(templateKeys('{{b}} {{a}} {{b}}')).toEqual(['b', 'a'])
  })
})

describe('checkValue: one test per forbidden class', () => {
  const cases: [string, string, RegExp][] = [
    ['LF', `a${cp(0x0a)}b`, /line break/],
    ['CR', `a${cp(0x0d)}b`, /line break/],
    ['C0 NUL', `a${cp(0x00)}b`, /C0 control/],
    ['C0 TAB', `a${cp(0x09)}b`, /C0 control/],
    ['C0 ESC', `a${cp(0x1b)}b`, /C0 control/],
    ['DEL', `a${cp(0x7f)}b`, /C0 control character or DEL/],
    ['C1 U+0085 (NEL)', `a${cp(0x85)}b`, /C1 control/],
    ['C1 U+009B (CSI)', `a${cp(0x9b)}b`, /C1 control/],
    ['U+2028', `a${cp(0x2028)}b`, /line or paragraph separator/],
    ['U+2029', `a${cp(0x2029)}b`, /line or paragraph separator/],
    ['Cf bidi U+202A', `a${cp(0x202a)}b`, /invisible format character/],
    ['Cf bidi U+202E', `a${cp(0x202e)}b`, /invisible format character/],
    ['Cf bidi U+2066', `a${cp(0x2066)}b`, /invisible format character/],
    ['Cf bidi U+2069', `a${cp(0x2069)}b`, /invisible format character/],
    ['Cf bidi U+200F', `a${cp(0x200f)}b`, /invisible format character/],
    ['Cf bidi U+061C', `a${cp(0x061c)}b`, /invisible format character/],
    ['Cf zero-width space U+200B', `a${cp(0x200b)}b`, /invisible format character/],
    ['Cf ZWNJ U+200C', `a${cp(0x200c)}b`, /invisible format character/],
    ['Cf ZWJ U+200D', `a${cp(0x200d)}b`, /invisible format character/],
    ['Cf word joiner U+2060', `a${cp(0x2060)}b`, /invisible format character/],
    ['Cf BOM U+FEFF', `a${cp(0xfeff)}b`, /invisible format character/],
    ['Cf soft hyphen U+00AD', `a${cp(0x00ad)}b`, /invisible format character/],
    ['Cf tag U+E0041', `a${cp(0xe0041)}b`, /invisible format character/],
    ['Mn grapheme joiner U+034F', `a${cp(0x034f)}b`, /invisible format character/],
    ['comment open', 'a<!--b', /HTML comment marker/],
    ['comment close', 'a-->b', /HTML comment marker/],
  ]
  for (const [label, value, re] of cases) {
    it(`rejects ${label}`, () => {
      expect(() => checkValue('k', value)).toThrow(re)
      expect(() => renderTemplate('{{k}}', { k: value })).toThrow(re)
    })
  }

  it('the class boundaries are exact: U+00A0, U+00AC, U+034E, U+0350, U+2027, U+202F, U+205F and combining accents pass', () => {
    for (const n of [0xa0, 0xac, 0x34e, 0x350, 0x2027, 0x202f, 0x205f, 0x301]) {
      expect(checkValue('k', `a${cp(n)}b`)).toBe(`a${cp(n)}b`)
    }
  })

  it('accepts ordinary non-ASCII text (Hungarian accents)', () => {
    expect(renderTemplate('{{n}}', { n: 'Dörös Roland, Szőke Ünige' })).toBe('Dörös Roland, Szőke Ünige')
  })

  it('accepts a lone "-" or "<" that is not a comment marker', () => {
    expect(checkValue('k', 'a -> b <- c, <!- d')).toBe('a -> b <- c, <!- d')
  })
})

describe('loadTemplate', () => {
  it('reads <dir>/<name>.md and drops one trailing newline', () => {
    expect(loadTemplate('sample', FIXTURE_TEMPLATES)).toBe('Sample for {{name}}.\n')
  })

  it('refuses a name that could leave the templates directory', () => {
    for (const bad of ['../sample', 'a/b', 'sample.md', '.hidden', '', 'Sample']) {
      expect(() => loadTemplate(bad, FIXTURE_TEMPLATES)).toThrow(/invalid template name/)
    }
  })
})

describe('wrapRegion and checkBody', () => {
  it('frames the body with the v2 markers, LF endings, one final LF', () => {
    expect(wrapRegion('line 1\nline 2\n\n')).toBe(`${REGION_BEGIN}\nline 1\nline 2\n${REGION_END}\n`)
    expect(wrapRegion('')).toBe(`${REGION_BEGIN}\n${REGION_END}\n`)
  })

  it('rejects a body with CR, a comment marker or an invisible control (last gate)', () => {
    expect(() => wrapRegion('a\r\nb')).toThrow(/line break/)
    expect(() => wrapRegion(`ok\n${REGION_END}`)).toThrow(/HTML comment marker/)
    expect(() => checkBody(`a${cp(0x202e)}b`)).toThrow(/invisible format character/)
  })
})

describe('registry', () => {
  const s = (id: string, text: string, applies = true): Section => ({ id, appliesTo: () => applies, render: () => text })

  it('joins applicable sections in order with one blank line', () => {
    expect(renderSections(ctx, [s('a', 'A\n'), s('b', 'B', false), s('c', 'C\n\n')])).toBe('A\n\nC')
  })

  it('leaves out a section that renders to nothing', () => {
    expect(renderSections(ctx, [s('a', 'A'), s('b', '\n\n'), s('c', 'C')])).toBe('A\n\nC')
  })

  it('passes the context to appliesTo and render', () => {
    const sec: Section = {
      id: 'who', appliesTo: (c) => c.role === 'sub', render: (c) => renderTemplate('I am {{n}}.', { n: c.name }),
    }
    expect(renderSections(ctx, [sec])).toBe('I am tom.')
    expect(renderSections({ ...ctx, role: 'main' }, [sec])).toBe('')
  })

  it('throws on a duplicate or malformed section id', () => {
    expect(() => renderSections(ctx, [s('a', 'A'), s('a', 'B')])).toThrow(/duplicate section id/)
    expect(() => renderSections(ctx, [s('Bad_Id', 'A')])).toThrow(/invalid section id/)
  })

  it('a section that concatenates an unchecked value is caught by the frame', () => {
    const leaky: Section = { id: 'leak', appliesTo: () => true, render: (c) => `name: ${c.name}` }
    expect(() => renderRegion({ ...ctx, name: `x${cp(0x2028)}y` }, [leaky])).toThrow(/line or paragraph separator/)
  })

  it('is idempotent: rendering twice gives identical bytes', () => {
    const secs = [s('a', 'A'), s('b', 'B')]
    expect(renderRegion(ctx, secs)).toBe(renderRegion(ctx, secs))
  })

  it('the default registry renders a framed region without the token path', () => {
    const region = renderRegion(ctx)
    expect(region.startsWith(`${REGION_BEGIN}\n`)).toBe(true)
    expect(region.endsWith(`\n${REGION_END}\n`)).toBe(true)
    expect(region).not.toContain(ctx.tokenPath)
  })
})

describe('module source hygiene', () => {
  it('every file of src/web/claude-md is plain ASCII (no invisible character hides in a regex)', () => {
    const files = readdirSync(MODULE_DIR).filter((f) => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThanOrEqual(6)
    for (const f of files) {
      const text = readFileSync(join(MODULE_DIR, f), 'utf-8')
      // eslint-disable-next-line no-control-regex
      expect([...text].filter((c) => c.codePointAt(0)! > 0x7e || (c.codePointAt(0)! < 0x20 && c !== '\n')), f).toEqual([])
    }
  })
})

describe('the autonomy rule points at the file, never a snapshot (Ron S3, C1 PR 10b)', () => {
  it('every role, with and without categories: the file path and the level-1 default, no "Levels now" / "none set"', () => {
    for (const role of ['main', 'sub', 'heartbeat'] as const) {
      for (const autonomy of [{}, { kanban_archive_done: 1, memory_maintenance: 3 }] as Record<string, 1 | 2 | 3>[]) {
        const region = renderRegion({ ...FIXTURES.main, role, name: role === 'main' ? FIXTURES.main.mainAgentId : 'kevin', autonomy })
        const line = region.split('\n').find((l) => l.startsWith('- Autonomous action:'))!
        expect(line, role).toContain(`${FIXTURES.main.projectRoot}/store/autonomy-config.json`)
        expect(line, role).toContain('a category not listed there, or no file, is level 1')
        expect(line, role).not.toMatch(/Levels now|none set|kanban_archive_done/)
      }
    }
  })
})
