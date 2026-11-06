// C1 PR 7a: composeClaudeMd, the pure region-into-file step
// (src/web/claude-md/compose.ts). Fixtures are synthetic: the fork is public,
// so no live owner zone is copied here; the live tree is the PR 8 dry run.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComposeError, checkRegion, composeClaudeMd } from '../web/claude-md/compose.js'
import { REGION_BEGIN, REGION_END, wrapRegion } from '../web/claude-md/render.js'
import { FEDERATION_MARKERS, LEGACY_MARKERS, type MarkerPair } from '../web/claude-md/legacy-markers.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OWNER_HU = readFileSync(join(HERE, 'fixtures', 'claude-md', 'owner-hu.md'), 'utf-8')

const REGION = wrapRegion('Identity: tom.\nRule: `$&` and $1 stay literal.')
const REGION2 = wrapRegion('Identity: tom, second render.')
const pair = (id: string) => LEGACY_MARKERS.find((p) => p.id === id)!
const block = (p: MarkerPair, body = 'legacy body') => `${p.begin}\n${body}\n${p.end}\n`
const ROSTER = pair('fleet-roster')
const EVIDENCE = pair('evidence-rule')
const count = (hay: string, needle: string) => hay.split(needle).length - 1

function idempotent(text: string, region = REGION): void {
  const once = composeClaudeMd(text, region)
  const twice = composeClaudeMd(once.text, region)
  expect(twice.changed).toBe(false)
  expect(twice.text).toBe(once.text)
}

describe('owner zone and region placement', () => {
  it('an empty file becomes the region alone', () => {
    const r = composeClaudeMd('', REGION)
    expect(r).toEqual({ text: REGION, changed: true, removed: [] })
  })

  it('an owner-only file keeps its bytes and gets one blank line, then the region', () => {
    const owner = '# Agent\n\nOwner text.\n'
    expect(composeClaudeMd(owner, REGION).text).toBe(`${owner}\n${REGION}`)
  })

  it('a missing final line break is added (LF), then the blank separator', () => {
    expect(composeClaudeMd('Owner text.', REGION).text).toBe(`Owner text.\n\n${REGION}`)
  })

  it('an owner zone that already ends with a blank line gets no second one', () => {
    expect(composeClaudeMd('Owner.\n\n', REGION).text).toBe(`Owner.\n\n${REGION}`)
  })

  it('the synthetic Hungarian fixture (decoys in fences, $&, trailing spaces) stays byte for byte', () => {
    const r = composeClaudeMd(OWNER_HU, REGION)
    expect(r.removed).toEqual([])
    expect(r.text).toBe(`${OWNER_HU}\n${REGION}`)
    expect(r.text.startsWith(OWNER_HU)).toBe(true)
    idempotent(OWNER_HU)
  })

  it('changed is false only for byte-identical output', () => {
    const once = composeClaudeMd('Owner.\n', REGION).text
    expect(composeClaudeMd(once, REGION).changed).toBe(false)
    expect(composeClaudeMd(once, REGION2).changed).toBe(true)
  })
})

describe('existing v2 region', () => {
  it('is replaced in place at EOF by the new render', () => {
    const r = composeClaudeMd(`Owner.\n\n${REGION}`, REGION2)
    expect(r.text).toBe(`Owner.\n\n${REGION2}`)
    expect(r.removed).toEqual(['v2'])
  })

  it('a region not at EOF is removed and re-rendered at EOF; the text after it stays', () => {
    const r = composeClaudeMd(`A\n\n${REGION}\nB\n`, REGION2)
    expect(r.text).toBe(`A\n\nB\n\n${REGION2}`)
    idempotent(`A\n\n${REGION}\nB\n`, REGION2)
  })

  it('two v2 regions are an error, no output', () => {
    expect(() => composeClaudeMd(`A\n${REGION}B\n${REGION}`, REGION)).toThrow(/second v2 region/)
  })
})

describe('legacy blocks', () => {
  it('a file with all 14 generated blocks and the federation block ends with exactly one v2 region', () => {
    const blocks = LEGACY_MARKERS.map((p, i) => block(p, `body ${i} with $& and $1`))
    const mid = Math.floor(blocks.length / 2)
    const text = [
      '# Agent\n\nPersona: árvíztűrő.\n\n',
      blocks.slice(0, mid).join('\n'),
      '\n## Owner rules\n\nKeep this.\n\n',
      blocks.slice(mid).join('\n'),
    ].join('')
    const r = composeClaudeMd(text, REGION)
    expect(r.removed).toEqual(LEGACY_MARKERS.map((p) => p.id))
    for (const p of LEGACY_MARKERS) {
      expect(r.text).not.toContain(p.begin)
      expect(r.text).not.toContain(p.end)
    }
    expect(count(r.text, REGION_BEGIN)).toBe(1)
    expect(count(r.text, REGION_END)).toBe(1)
    expect(r.text.endsWith(REGION)).toBe(true)
    expect(r.text).toBe(`# Agent\n\nPersona: árvíztűrő.\n\n## Owner rules\n\nKeep this.\n\n${REGION}`)
    idempotent(text)
  })

  it('"$&" and "$1" in a removed body, in the owner zone and in the region stay literal', () => {
    const text = `Owner $& $1 $$.\n\n${block(EVIDENCE, 'gone $&')}`
    const r = composeClaudeMd(text, REGION)
    expect(r.text).toBe(`Owner $& $1 $$.\n\n${REGION}`)
    expect(r.text).toContain('Rule: `$&` and $1 stay literal.')
    expect(r.text).not.toContain('gone')
  })

  it('a removed block takes one blank line with it when the line before it is blank', () => {
    expect(composeClaudeMd(`A\n\n${block(ROSTER)}\nC\n`, REGION).text).toBe(`A\n\nC\n\n${REGION}`)
  })

  it('exactly ONE blank line goes: two blank lines after a removed block leave one', () => {
    expect(composeClaudeMd(`A\n\n${block(ROSTER)}\n\nC\n`, REGION).text).toBe(`A\n\n\nC\n\n${REGION}`)
    expect(composeClaudeMd(`A\n\n${block(ROSTER)}   \n\t\nC\n`, REGION).text).toBe(`A\n\n\t\nC\n\n${REGION}`)
  })

  it('a block that opens the file takes its following blank line too', () => {
    expect(composeClaudeMd(`${block(ROSTER)}\nA\n`, REGION).text).toBe(`A\n\n${REGION}`)
  })

  it('a block after a non-blank line keeps the blank line that follows it', () => {
    expect(composeClaudeMd(`A\n${block(ROSTER)}\nC\n`, REGION).text).toBe(`A\n\nC\n\n${REGION}`)
  })

  it('only the given pairs are removed; another pair stays as owner text', () => {
    const text = `A\n\n${block(ROSTER)}\n${block(FEDERATION_MARKERS)}`
    const r = composeClaudeMd(text, REGION, [ROSTER])
    expect(r.removed).toEqual(['fleet-roster'])
    expect(r.text).toBe(`A\n\n${block(FEDERATION_MARKERS)}\n${REGION}`)
  })

  it('a marker that is not the whole line is owner text', () => {
    const text = ` ${ROSTER.begin}\n${ROSTER.end} trailing\nSee ${ROSTER.begin} inline.\n`
    const r = composeClaudeMd(text, REGION)
    expect(r.removed).toEqual([])
    expect(r.text).toBe(`${text}\n${REGION}`)
  })
})

describe('structural errors: no output', () => {
  it('BEGIN without END', () => {
    expect(() => composeClaudeMd(`A\n${ROSTER.begin}\nbody\n`, REGION)).toThrow(/BEGIN of "fleet-roster" without its END/)
  })

  it('END without BEGIN', () => {
    expect(() => composeClaudeMd(`A\n${ROSTER.end}\n`, REGION)).toThrow(/END of "fleet-roster" without its BEGIN/)
    expect(() => composeClaudeMd(`A\n${REGION_END}\n`, REGION)).toThrow(/END of "v2" without its BEGIN/)
  })

  it('a nested BEGIN (legacy in legacy, v2 in legacy)', () => {
    expect(() => composeClaudeMd(`${ROSTER.begin}\n${EVIDENCE.begin}\n${EVIDENCE.end}\n${ROSTER.end}\n`, REGION))
      .toThrow(/BEGIN of "evidence-rule" inside the open "fleet-roster" block/)
    expect(() => composeClaudeMd(`${ROSTER.begin}\n${REGION}${ROSTER.end}\n`, REGION))
      .toThrow(/BEGIN of "v2" inside the open "fleet-roster" block/)
  })

  it('the END of another pair inside an open block', () => {
    expect(() => composeClaudeMd(`${ROSTER.begin}\n${EVIDENCE.end}\n${ROSTER.end}\n`, REGION))
      .toThrow(/END of "evidence-rule" inside the open "fleet-roster" block/)
  })

  it('every error is a ComposeError', () => {
    expect(() => composeClaudeMd(`${ROSTER.end}\n`, REGION)).toThrow(ComposeError)
  })
})

describe('code fences (CommonMark)', () => {
  it('a marker inside a backtick or tilde fence is not recognised', () => {
    for (const f of ['```', '~~~', '````', '```markdown', '   ```']) {
      const close = f.trim().replace(/[a-z]+$/, '')
      const text = `A\n${f}\n${ROSTER.begin}\n${ROSTER.end}\n${REGION_END}\n${close}\n`
      const r = composeClaudeMd(text, REGION)
      expect(r.removed, f).toEqual([])
      expect(r.text, f).toBe(`${text}\n${REGION}`)
    }
  })

  it('a fence closes only with the same character', () => {
    const text = `\`\`\`\n~~~\n${ROSTER.end}\n\`\`\`\n`
    expect(composeClaudeMd(text, REGION).text).toBe(`${text}\n${REGION}`)
  })

  it('a fence closes only with a run at least as long as the opener', () => {
    const text = `\`\`\`\`\n\`\`\`\n${ROSTER.end}\n\`\`\`\`\`\n`
    expect(composeClaudeMd(text, REGION).text).toBe(`${text}\n${REGION}`)
  })

  it('a closing run with an info string does not close; one with trailing spaces does', () => {
    const notClosed = `\`\`\`\n\`\`\`bash\n${ROSTER.end}\n\`\`\`\n`
    expect(composeClaudeMd(notClosed, REGION).text).toBe(`${notClosed}\n${REGION}`)
    const closed = `\`\`\`\nx\n\`\`\`  \n${ROSTER.end}\n`
    expect(() => composeClaudeMd(closed, REGION)).toThrow(/END of "fleet-roster" without its BEGIN/)
  })

  it('an unclosed fence runs to EOF: a marker after it is not recognised, and the region cannot be appended', () => {
    // Recognised, the END would raise "without its BEGIN"; it raises the fence error instead.
    expect(() => composeClaudeMd(`A\n\`\`\`\n${ROSTER.end}\n`, REGION)).toThrow(/unclosed code fence at EOF/)
    expect(() => composeClaudeMd(`A\n\`\`\`\n${ROSTER.begin}\n`, REGION)).toThrow(/unclosed code fence at EOF/)
  })

  it('four-space indentation and a backtick in a backtick info string open no fence', () => {
    expect(() => composeClaudeMd(`    \`\`\`\n${ROSTER.end}\n`, REGION)).toThrow(/without its BEGIN/)
    expect(() => composeClaudeMd(`\`\`\` a\`b\n${ROSTER.end}\n`, REGION)).toThrow(/without its BEGIN/)
  })

  it('a fence inside a removed legacy block is not tracked: the block ends at its first END line', () => {
    const text = `A\n\n${ROSTER.begin}\n\`\`\`bash\nunclosed in our own body\n${ROSTER.end}\n\nB\n`
    expect(composeClaudeMd(text, REGION).text).toBe(`A\n\nB\n\n${REGION}`)
  })
})

describe('line endings', () => {
  it('a CRLF owner zone keeps CRLF byte for byte; the region and the added separator use LF', () => {
    const owner = '# Agent\r\n\r\nÁrvíztűrő owner text.\r\n'
    const r = composeClaudeMd(owner, REGION)
    expect(r.text).toBe(`${owner}\n${REGION}`)
    expect(r.text.slice(owner.length + 1)).toBe(REGION)
    expect(REGION.includes('\r')).toBe(false)
    idempotent(owner)
  })

  it('CRLF legacy markers are recognised and removed; the CRLF owner lines around them stay', () => {
    const crlf = (s: string) => s.replace(/\n/g, '\r\n')
    const text = crlf(`A\n\n${block(ROSTER)}\nB\n`)
    expect(composeClaudeMd(text, REGION).text).toBe(`A\r\n\r\nB\r\n\n${REGION}`)
  })

  it('a CRLF v2 region (hand-edited) is still recognised and replaced', () => {
    const text = `A\r\n\r\n${REGION.replace(/\n/g, '\r\n')}`
    expect(composeClaudeMd(text, REGION2).text).toBe(`A\r\n\r\n${REGION2}`)
  })
})

describe('a leading BOM', () => {
  const BOM = String.fromCharCode(0xfeff)

  it('is kept in front of an owner zone, byte for byte', () => {
    const text = `${BOM}# Agent\n`
    const r = composeClaudeMd(text, REGION)
    expect(r.text).toBe(`${BOM}# Agent\n\n${REGION}`)
    idempotent(text)
  })

  it('does not hide a marker on the first line: the block is removed and the BOM stays', () => {
    const text = `${BOM}${block(ROSTER)}\nOwner.\n`
    const r = composeClaudeMd(text, REGION)
    expect(r.removed).toEqual(['fleet-roster'])
    expect(r.text).toBe(`${BOM}Owner.\n\n${REGION}`)
    idempotent(text)
  })

  it('is kept when the whole file was generated', () => {
    expect(composeClaudeMd(`${BOM}${REGION2}`, REGION).text).toBe(`${BOM}${REGION}`)
    expect(composeClaudeMd(BOM, REGION).text).toBe(`${BOM}${REGION}`)
  })

  it('only a leading BOM is file-level: one later in the text is ordinary owner text', () => {
    const text = `A\n${BOM}${ROSTER.end}\n`
    expect(composeClaudeMd(text, REGION).text).toBe(`${text}\n${REGION}`)
  })
})

describe('checkRegion', () => {
  it('accepts what wrapRegion produces', () => {
    expect(() => checkRegion(REGION)).not.toThrow()
    expect(() => checkRegion(wrapRegion(''))).not.toThrow()
  })

  it('rejects a malformed region before touching the file', () => {
    expect(() => composeClaudeMd('A\n', `${REGION_BEGIN}\nno end\n`)).toThrow(/must start with the v2 BEGIN line/)
    expect(() => composeClaudeMd('A\n', REGION.replace(/\n$/, ''))).toThrow(/must start with the v2 BEGIN line/)
    expect(() => composeClaudeMd('A\n', REGION.replace('\n', '\r\n'))).toThrow(/CR found/)
    expect(() => composeClaudeMd('A\n', `${REGION_BEGIN}\n${ROSTER.begin}\n${REGION_END}\n`)).toThrow(/marker line inside/)
    expect(() => composeClaudeMd('A\n', `${REGION_BEGIN}\nx <!-- y\n${REGION_END}\n`)).toThrow(/HTML comment marker/)
  })
})
