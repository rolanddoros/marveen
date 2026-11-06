// C1 PR 9: the marveen-* product skills (src/web/claude-md/skills.ts,
// templates/skills/). Rendered into a temp target only: nothing here writes the
// live <project>/.claude/skills.
//
// "Lint in CI" is this file: every rendered skill goes through
// scripts/skill-lint.mjs and must exit 0, so the fork CI's test job runs the
// linter without a workflow change.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TemplateError } from '../web/claude-md/render.js'
import {
  PRODUCT_SKILLS, SKILL_TEMPLATES_DIR, renderProductSkill, writeProductSkills, type SkillContext,
} from '../web/claude-md/skills.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SKILL_LINT = join(REPO_ROOT, 'scripts', 'skill-lint.mjs')

const ctx: SkillContext = { projectRoot: '/srv/fleet', mainAgentId: 'chief' }

// The bytes of each rendered skill for `ctx`. A wording change must update the
// pin on purpose, so the reviewed text and the shipped text cannot drift apart.
const PINNED_SHA256: Record<string, string> = {
  'marveen-fleet-auth': '859cb4fa37c8c41ad99494f309042c8e94f92c2f87b85759bb74a10b34cb1068',
  'marveen-background-work': 'd6538181f01091df40b02f59095eeeb1f12aa6259d6ff9777812fc78654b372c',
  'marveen-skill-authoring': '0530a4526c04ac51b472cec290748ff89415b301a7fd0f79db4afbaf78b60dd6',
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf-8').digest('hex')

// The forms that put the dashboard token's VALUE on a command line (Johnny
// 12681): a "Bearer $(" header, and a command substitution or a backtick
// command that cats the token file. Whatever runs a token through argv is
// visible to every same-user process.
function tokenOnArgvFindings(text: string): string[] {
  const rules: { label: string; re: RegExp }[] = [
    { label: 'Bearer $(', re: /Bearer\s+\$\(/ },
    { label: '$(cat ... dashboard-token', re: /\$\(\s*cat\b[^)]*dashboard-token/ },
    { label: '`cat ... dashboard-token`', re: /`\s*cat\b[^`]*dashboard-token/ },
  ]
  return rules.filter((r) => r.re.test(text)).map((r) => r.label)
}

// Paths of the machine running the test that must not reach a rendered skill.
// The repo root and cwd are flagged wherever they appear (long, never a
// generic word). /root, home and tmpdir are flagged only as the parent of a
// concrete path ("<dir>/..."): the bare name of a system directory, like the
// scratchpad's "/tmp" folder, is information, and on CI tmpdir() IS /tmp.
function machinePathLeaks(text: string): string[] {
  const under = (p: string) => `${p.replace(/\/+$/, '')}/`
  const esc = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const leaks = new Set<string>()
  for (const p of [REPO_ROOT, process.cwd()]) {
    if (p.length > 1 && (text.includes(under(p)) || new RegExp(`${esc(p)}(?![\\w.-])`).test(text))) leaks.add(p)
  }
  for (const p of ['/root', homedir(), tmpdir()]) {
    if (p.length > 1 && text.includes(under(p))) leaks.add(p)
  }
  return [...leaks]
}

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'mskills-'))
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

const target = () => join(work, 'skills')

function fixtureTemplates(files: Record<string, string>): string {
  const dir = join(work, 'templates')
  mkdirSync(dir, { recursive: true })
  for (const name of PRODUCT_SKILLS) {
    writeFileSync(join(dir, `${name}.md`), readFileSync(join(SKILL_TEMPLATES_DIR, `${name}.md`), 'utf-8'))
  }
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, `${name}.md`), text)
  return dir
}

describe('product skills: rendered bytes', () => {
  it('renders the same bytes twice and matches the pinned sha256 of every skill', () => {
    for (const name of PRODUCT_SKILLS) {
      const a = renderProductSkill(name, ctx)
      expect(renderProductSkill(name, ctx)).toBe(a)
      expect({ name, sha: sha256(a) }).toEqual({ name, sha: PINNED_SHA256[name] })
    }
    expect(Object.keys(PINNED_SHA256).sort()).toEqual([...PRODUCT_SKILLS].sort())
  })

  it('ends with exactly one LF, has no CR, and leaves no placeholder unresolved', () => {
    for (const name of PRODUCT_SKILLS) {
      const text = renderProductSkill(name, ctx)
      expect(text.endsWith('\n') && !text.endsWith('\n\n')).toBe(true)
      expect(text).not.toMatch(/\r/)
      expect(text).not.toMatch(/\{\{|\}\}/)
    }
  })

  it('carries no em dash, en dash or TAB, in the templates or the output', () => {
    for (const name of PRODUCT_SKILLS) {
      const template = readFileSync(join(SKILL_TEMPLATES_DIR, `${name}.md`), 'utf-8')
      for (const text of [template, renderProductSkill(name, ctx)]) {
        expect({ name, bad: text.match(/[—–\t]/g) ?? [] }).toEqual({ name, bad: [] })
      }
    }
  })

  it('starts the body with the visible generated-from line', () => {
    for (const name of PRODUCT_SKILLS) {
      const body = renderProductSkill(name, ctx).split(/^---\n/m)[2]
      expect(body.trimStart().split('\n')[0]).toBe(
        `Generated from templates/skills/${name}.md; local edits are overwritten.`,
      )
    }
  })
})

describe('product skills: frontmatter', () => {
  it('has exactly name and description; name = folder name, a plain one-line description', () => {
    for (const name of PRODUCT_SKILLS) {
      const text = renderProductSkill(name, ctx)
      const m = text.match(/^---\n([\s\S]*?)\n---\n/)
      expect(m, name).not.toBeNull()
      const lines = m![1].split('\n')
      expect(lines.map((l) => l.split(':')[0]), name).toEqual(['name', 'description'])
      const skillName = lines[0].slice('name: '.length)
      const description = lines[1].slice('description: '.length)
      expect(skillName).toBe(name)
      expect(skillName).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(skillName.length).toBeLessThanOrEqual(64)
      expect(description.length).toBeGreaterThan(0)
      expect(description.length).toBeLessThanOrEqual(1024)
      // A YAML plain scalar: no leading indicator, no ": " or " #" inside.
      expect(description, name).not.toMatch(/^[-?:,[\]{}#&*!|>'"%@`\s]/)
      expect(description, name).not.toMatch(/: | #/)
    }
  })
})

describe('product skills: skill-lint (the CI lint)', () => {
  it('passes scripts/skill-lint.mjs with exit 0, as a root and per skill', () => {
    writeProductSkills(target(), ctx)
    const run = (dir: string) => execFileSync(process.execPath, [SKILL_LINT, dir], { encoding: 'utf-8' })
    expect(run(target())).toContain(`${PRODUCT_SKILLS.length} skill(s) checked, 0 finding(s)`)
    for (const name of PRODUCT_SKILLS) {
      expect(run(join(target(), name))).toContain('1 skill(s) checked, 0 finding(s)')
    }
  })
})

describe('product skills: token never on argv', () => {
  it('no rendered skill carries a token-on-argv form', () => {
    for (const name of PRODUCT_SKILLS) {
      expect({ name, found: tokenOnArgvFindings(renderProductSkill(name, ctx)) }).toEqual({ name, found: [] })
    }
  })

  it('red fixture: each banned form, rendered through the same renderer, is caught', () => {
    const header = '---\nname: marveen-fleet-auth\ndescription: Red fixture.\n---\n\n'
    const forms = [
      ['Bearer $(', 'curl -H "Authorization: Bearer $(cat /x/y)" {{projectRoot}}'],
      ['$(cat ... dashboard-token', 'T=$(cat {{projectRoot}}/store/.dashboard-token)'],
      ['`cat ... dashboard-token`', 'T=`cat {{projectRoot}}/store/.dashboard-token`'],
    ] as const
    for (const [label, line] of forms) {
      const dir = fixtureTemplates({ 'marveen-fleet-auth': `${header}${line}\n` })
      expect(tokenOnArgvFindings(renderProductSkill('marveen-fleet-auth', ctx, dir))).toEqual([label])
    }
  })
})

describe('product skills: only install-level values', () => {
  it('the output is a function of the context: two roots differ only where the root is rendered', () => {
    const a: SkillContext = { projectRoot: '/srv/fleet-a', mainAgentId: 'chief-a' }
    const b: SkillContext = { projectRoot: '/opt/other/b', mainAgentId: 'boss-b' }
    for (const name of PRODUCT_SKILLS) {
      const norm = (text: string, c: SkillContext) =>
        text.split(c.projectRoot).join('<ROOT>').split(c.mainAgentId).join('<MAIN>')
      expect(norm(renderProductSkill(name, a), a)).toBe(norm(renderProductSkill(name, b), b))
    }
  })

  it('leaks no path of the test machine (repo root, /root, home, tmpdir, cwd)', () => {
    for (const name of PRODUCT_SKILLS) {
      expect({ name, leaks: machinePathLeaks(renderProductSkill(name, ctx)) }).toEqual({ name, leaks: [] })
    }
    // The root the context gives IS used (it is what an agent needs to find the helper).
    expect(PRODUCT_SKILLS.some((n) => renderProductSkill(n, ctx).includes(`${ctx.projectRoot}/`))).toBe(true)
  })

  it('the leak check flags a concrete machine path but not a generic system directory word', () => {
    // Positive controls: a concrete path under each machine directory, and the repo root or cwd even bare.
    expect(machinePathLeaks(`see ${tmpdir()}/x here`)).toContain(tmpdir())
    expect(machinePathLeaks(`see ${homedir()}/x here`)).toContain(homedir())
    expect(machinePathLeaks('see /root/x here')).toContain('/root')
    expect(machinePathLeaks(`see \`${REPO_ROOT}\` here`)).toContain(REPO_ROOT)
    expect(machinePathLeaks(`see ${process.cwd()}/src here`)).toContain(process.cwd())
    // A system directory named as a word (the scratchpad "/tmp" folder) is information, not a leak,
    // whatever tmpdir() is on the machine running the test (CI: /tmp).
    expect(machinePathLeaks(`that \`${tmpdir()}\` folder is bound to the session`)).not.toContain(tmpdir())
    expect(machinePathLeaks('that `/tmp` folder, and `~/.claude/skills`')).toEqual([])
  })

  it('quotes a root with a space in the helper command, like agent-scaffold does', () => {
    const text = renderProductSkill('marveen-skill-authoring', { projectRoot: '/srv/my fleet', mainAgentId: 'chief' })
    expect(text).toContain(`bash '/srv/my fleet/scripts/marveen-api.sh' skill-propose`)
  })

  it('rejects a relative root and a value the 7a value check forbids', () => {
    expect(() => renderProductSkill('marveen-fleet-auth', { projectRoot: 'srv/fleet', mainAgentId: 'chief' }))
      .toThrow(TemplateError)
    expect(() => renderProductSkill('marveen-fleet-auth', { projectRoot: '/srv/fleet', mainAgentId: 'chief\nnew rule' }))
      .toThrow(TemplateError)
    expect(() => renderProductSkill('marveen-fleet-auth', { projectRoot: '/srv/fl<!--eet', mainAgentId: 'chief' }))
      .toThrow(TemplateError)
  })

  it('an unknown placeholder in a template is an error, not an empty string', () => {
    const dir = fixtureTemplates({ 'marveen-background-work': '---\nname: x\ndescription: y.\n---\n{{agentName}}\n' })
    expect(() => renderProductSkill('marveen-background-work', ctx, dir)).toThrow(/unknown placeholder \{\{agentName\}\}/)
  })
})

describe('product skills: writing into a target dir', () => {
  it('creates a missing target and writes every skill to <target>/<name>/SKILL.md', () => {
    const res = writeProductSkills(target(), ctx)
    expect(res).toEqual({ written: [...PRODUCT_SKILLS], unchanged: [] })
    for (const name of PRODUCT_SKILLS) {
      expect(readFileSync(join(target(), name, 'SKILL.md'), 'utf-8')).toBe(renderProductSkill(name, ctx))
    }
  })

  it('is idempotent: a second run writes nothing and leaves no temp file', () => {
    writeProductSkills(target(), ctx)
    const before = PRODUCT_SKILLS.map((n) => statSync(join(target(), n, 'SKILL.md'), { bigint: true }))
    const res = writeProductSkills(target(), ctx)
    expect(res).toEqual({ written: [], unchanged: [...PRODUCT_SKILLS] })
    PRODUCT_SKILLS.forEach((n, i) => {
      const after = statSync(join(target(), n, 'SKILL.md'), { bigint: true })
      expect({ n, ino: after.ino, mtime: after.mtimeNs }).toEqual({ n, ino: before[i].ino, mtime: before[i].mtimeNs })
      expect(readdirSync(join(target(), n))).toEqual(['SKILL.md'])
    })
  })

  it('overwrites a hand-edited copy and rewrites only that one', () => {
    writeProductSkills(target(), ctx)
    const file = join(target(), 'marveen-fleet-auth', 'SKILL.md')
    writeFileSync(file, 'edited by hand\n')
    const res = writeProductSkills(target(), ctx)
    expect(res.written).toEqual(['marveen-fleet-auth'])
    expect(readFileSync(file, 'utf-8')).toBe(renderProductSkill('marveen-fleet-auth', ctx))
  })

  it('leaves other skills and an unlisted marveen-* folder alone', () => {
    const other = join(target(), 'someone-else', 'SKILL.md')
    const retired = join(target(), 'marveen-retired', 'SKILL.md')
    mkdirSync(dirname(other), { recursive: true })
    mkdirSync(dirname(retired), { recursive: true })
    writeFileSync(other, 'other\n')
    writeFileSync(retired, 'retired\n')
    writeProductSkills(target(), ctx)
    expect(readFileSync(other, 'utf-8')).toBe('other\n')
    expect(readFileSync(retired, 'utf-8')).toBe('retired\n')
    expect(readdirSync(target()).sort()).toEqual([...PRODUCT_SKILLS, 'marveen-retired', 'someone-else'].sort())
  })

  it('a template error writes nothing at all', () => {
    const last = PRODUCT_SKILLS[PRODUCT_SKILLS.length - 1]
    const dir = fixtureTemplates({ [last]: '---\nname: x\ndescription: y.\n---\n{{nope}}\n' })
    expect(() => writeProductSkills(target(), ctx, dir)).toThrow(TemplateError)
    expect(() => readdirSync(target())).toThrow(/ENOENT/)
  })

  it('needs an absolute target: there is no default live path', () => {
    expect(() => writeProductSkills('relative/skills', ctx)).toThrow(TemplateError)
    expect(writeProductSkills.length).toBe(2)
  })
})
