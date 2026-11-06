// C1 PR 7b: the v2 region content (src/web/claude-md/sections.ts and
// templates/claude-md/*.md) against golden files, the 5.5k budget, the
// rule-hook coupling and the helper parity.
//
// Goldens: src/__tests__/fixtures/claude-md/golden/<fixture>.md, compared byte
// for byte. To regenerate after an intended change run the file once with
// CLAUDE_MD_GOLDEN_UPDATE=1: it writes the files and FAILS on purpose, so a
// run with the flag can never pass silently; review the diff, rerun without it.
import { describe, it, expect } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURES } from './fixtures/claude-md/contexts.js'
import { renderRegion } from '../web/claude-md/registry.js'
import { RULES, ruleLine } from '../web/claude-md/sections.js'
import { composeClaudeMd } from '../web/claude-md/compose.js'
import { TEMPLATES_DIR, templateKeys } from '../web/claude-md/render.js'
import { HOOK_IDS, type AgentDocContext } from '../web/claude-md/context.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN = join(HERE, 'fixtures', 'claude-md', 'golden')
const REPO = join(HERE, '..', '..')
const UPDATE = process.env.CLAUDE_MD_GOLDEN_UPDATE === '1'
const BUDGET = 5500
const cp = (n: number) => String.fromCodePoint(n)
const names = Object.keys(FIXTURES)
const golden = (n: string) => readFileSync(join(GOLDEN, `${n}.md`), 'utf-8')

describe('golden files', () => {
  it('there are the eight agreed fixtures', () => {
    expect(names.sort()).toEqual([
      'heartbeat', 'main', 'main-no-hooks', 'main-with-federation',
      'sub-all-hooks', 'sub-helper-denied', 'sub-permissive', 'sub-strict',
    ])
  })

  for (const n of names) {
    it(`${n}: the region matches its golden byte for byte`, () => {
      const region = renderRegion(FIXTURES[n])
      if (UPDATE) {
        mkdirSync(GOLDEN, { recursive: true })
        writeFileSync(join(GOLDEN, `${n}.md`), region)
        throw new Error(`golden ${n}.md written: review the diff and rerun without CLAUDE_MD_GOLDEN_UPDATE`)
      }
      expect(region).toBe(golden(n))
    })
  }

  it('no golden file without a fixture', () => {
    expect(readdirSync(GOLDEN).sort()).toEqual(names.map((n) => `${n}.md`).sort())
  })
})

describe('budget and invariants (every golden)', () => {
  for (const n of names) {
    it(`${n}: <= ${BUDGET} chars incl. markers, idempotent, no token, no curl, no em dash, no TAB`, () => {
      const ctx = FIXTURES[n]
      const region = renderRegion(ctx)
      expect(region.length, `${n} is ${region.length} chars`).toBeLessThanOrEqual(BUDGET)
      expect(renderRegion(ctx)).toBe(region)
      const once = composeClaudeMd('# Owner zone\n', region)
      expect(composeClaudeMd(once.text, region).changed).toBe(false)
      expect(region).not.toContain(ctx.tokenPath)
      expect(region).not.toContain('.dashboard-token')
      // the word appears ("a curl recipe elsewhere"); a curl CALL or an auth header must not
      expect(region).not.toMatch(/\bcurl\s+[-"]|Bearer|Authorization/)
      expect(region).not.toContain(cp(0x2014))
      expect(region).not.toContain('\t')
    })
  }
})

describe('content per role', () => {
  it('the owner chat id is rendered when known and omitted when null (never "0")', () => {
    expect(golden('main')).toContain('Owner: Owner (chat_id 1000000001).')
    expect(golden('main-no-hooks')).toContain('Owner: Owner.')
    expect(golden('main-no-hooks')).not.toContain('chat_id')
  })

  it('a helper-denied agent gets the pointer to marveen-messaging and no helper index, no recipe', () => {
    const g = golden('sub-helper-denied')
    expect(g).toContain('Your profile denies the API helper.')
    expect(g).toContain('skill marveen-messaging')
    expect(g).not.toContain('marveen-api.sh')
    expect(g).not.toContain('### API helper')
  })

  it('the strict note only for a strict profile; kanban write verbs only with kanbanWrite', () => {
    expect(golden('sub-strict')).toContain('Your profile denies heredocs and pipes')
    expect(golden('sub-permissive')).not.toContain('Your profile denies heredocs and pipes')
    expect(golden('sub-all-hooks')).toContain('kanban-create')
    expect(golden('sub-permissive')).not.toContain('kanban-create')
  })

  it('the roster: subs only, names with their relation, never self', () => {
    const g = golden('sub-all-hooks')
    expect(g).toContain('- main (your lead)')
    expect(g).toContain('- dev-a (reports to you)')
    expect(g).not.toMatch(/^- pm\b/m)
    expect(golden('sub-permissive')).toContain('- pm (your lead)')
    expect(golden('sub-permissive')).toContain('- main (main agent)')
    for (const n of ['main', 'heartbeat']) expect(golden(n)).not.toContain('### Fleet')
  })

  it('federation only for the main agent with federation enabled', () => {
    expect(golden('main-with-federation')).toContain('### Federation')
    for (const n of names.filter((x) => x !== 'main-with-federation')) expect(golden(n)).not.toContain('### Federation')
    // a sub or the heartbeat with the federation flag on still gets no federation section
    for (const n of ['sub-permissive', 'heartbeat']) {
      const ctx = FIXTURES[n]
      expect(renderRegion({ ...ctx, capabilities: { ...ctx.capabilities, federation: true } }), n).toBe(golden(n))
    }
  })

  it('"Your lead" only for a sub: a main or heartbeat context with a reportsTo renders none', () => {
    for (const n of ['main', 'heartbeat']) {
      const ctx = FIXTURES[n]
      expect(renderRegion({ ...ctx, team: { ...ctx.team, reportsTo: 'pm' } }), n).not.toContain('Your lead')
    }
  })

  it('the agent-config description never reaches the region: newline, ZWJ emoji and "-->" change nothing', () => {
    const hostile = `line one\nline two ${cp(0x1f468)}${cp(0x200d)}${cp(0x1f4bb)} --> <!-- x`
    for (const n of names) {
      const ctx = FIXTURES[n]
      const withDescriptions = {
        ...ctx,
        roster: ctx.roster.map((r) => ({ ...r, description: hostile, role: hostile })),
      } as unknown as AgentDocContext
      expect(renderRegion(withDescriptions), n).toBe(golden(n))
    }
  })
})

describe('rule-hook coupling', () => {
  const hooked = RULES.filter((r) => r.enforcedBy !== undefined)

  it('every hook id has a coupled rule, and every coupled rule has a fallback', () => {
    expect(new Set(hooked.map((r) => r.enforcedBy))).toEqual(new Set(HOOK_IDS))
    for (const r of hooked) expect(r.fallback, r.id).toBeTruthy()
  })

  it('wired -> the one-line hooked text; not wired -> the fallback; per hook, both branches', () => {
    for (const r of hooked) {
      const role = r.roles[0]
      const on = { ...FIXTURES.main, role, hooks: { directiveVerify: false, childClaudeGuard: false, shellRescan: false, [r.enforcedBy!]: true } }
      const off = { ...on, hooks: { ...on.hooks, [r.enforcedBy!]: false } }
      const lineOn = ruleLine(r, on)
      const lineOff = ruleLine(r, off)
      expect(lineOn, r.id).toContain('hook ')
      expect(lineOff, r.id).not.toBe(lineOn)
      expect(golden('main')).toContain(lineOn)
      expect(golden('main-no-hooks')).toContain(ruleLine(r, { ...FIXTURES['main-no-hooks'] }))
      expect(golden('main-no-hooks')).not.toContain(lineOn)
    }
  })

  it('rule ids are unique and every rule names at least one role', () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length)
    for (const r of RULES) expect(r.roles.length, r.id).toBeGreaterThan(0)
  })
})

describe('templates', () => {
  const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.md')).sort()
  const sectionsSrc = readFileSync(join(REPO, 'src', 'web', 'claude-md', 'sections.ts'), 'utf-8')

  it('every template file is loaded by a section, and every loaded name exists', () => {
    const loaded = [...sectionsSrc.matchAll(/loadTemplate\('([a-z0-9-]+)'\)/g)].map((m) => `${m[1]}.md`)
    expect([...new Set(loaded)].sort()).toEqual(files)
  })

  it('every fixture renders, so every template\'s keys match what its section passes (the renderer is strict both ways)', () => {
    for (const n of names) expect(() => renderRegion(FIXTURES[n])).not.toThrow()
    // and the key sets are the documented ones
    const keys = Object.fromEntries(files.map((f) => [f, templateKeys(readFileSync(join(TEMPLATES_DIR, f), 'utf-8'))]))
    expect(keys['identity.md'].sort()).toEqual(['leadSentence', 'mainAgentId', 'name', 'ownerSentence', 'roleText'])
    expect(keys['helper-index.md'].sort()).toEqual(['kanbanWriteVerbs', 'projectRoot', 'strictNote'])
    for (const f of files.filter((x) => x !== 'identity.md' && x !== 'helper-index.md')) expect(keys[f], f).toEqual([])
  })

  it('no em dash and no TAB in any template', () => {
    for (const f of files) {
      const t = readFileSync(join(TEMPLATES_DIR, f), 'utf-8')
      expect(t, f).not.toContain(cp(0x2014))
      expect(t, f).not.toContain('\t')
    }
  })
})

describe('helper index parity with scripts/lib/marveen_api.py', () => {
  const py = readFileSync(join(REPO, 'scripts', 'lib', 'marveen_api.py'), 'utf-8')
  const usage = py.slice(py.indexOf('usage: bash scripts/marveen-api.sh'), py.indexOf('A <content-file> is a path'))
  const usageVerbs = new Set([...usage.matchAll(/^ {2}([a-z]+(?:-[a-z]+)*)\b/gm)].map((m) => m[1]))
  const indexText = renderRegion(FIXTURES['sub-all-hooks'])
  const indexBlock = indexText.slice(indexText.indexOf('### API helper'), indexText.indexOf('\nExit:'))

  it('the USAGE block was found', () => {
    expect(usageVerbs.size).toBeGreaterThanOrEqual(20)
  })

  it('every verb the index teaches exists, and every helper verb is in the index', () => {
    const listed = new Set<string>()
    for (const line of indexBlock.split('\n').filter((l) => l.startsWith('- '))) {
      for (const part of line.replace(/^- [a-z]+: /, '').split(', ')) listed.add(part.replace(/ \(.*$/, '').trim())
    }
    expect([...listed].filter((v) => !usageVerbs.has(v))).toEqual([])
    expect([...usageVerbs].filter((v) => !listed.has(v))).toEqual([])
    expect(listed.size).toBeGreaterThanOrEqual(20)
  })

  it('the exit line names every code of EXIT_CODES', () => {
    const codes = [...py.matchAll(/^ {4}\((\d+), '([a-z_]+)'/gm)].map((m) => Number(m[1]))
    expect(codes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    const exit = indexText.slice(indexText.indexOf('\nExit:'))
    for (const c of codes) expect(exit, `exit code ${c}`).toMatch(new RegExp(`(?:Exit: |; |or )${c} `))
  })
})
