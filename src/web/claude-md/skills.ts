// C1 PR 9: the marveen-* product skills, rendered deterministically.
//
// The procedures that today sit as generated blocks in every CLAUDE.md
// (agent-scaffold.ts build*Body) move into skills under
// <project>/.claude/skills/marveen-<name>/SKILL.md. That folder is SHARED: every
// agent of the install reads the same file (the skills-path-trap block itself
// says so), so a skill can carry no per-agent value -- no agent name, no own
// token path, no owner chat_id. The context is therefore install-level
// (SkillContext), and whatever differs per agent is written into the text as a
// rule ("<your-name>", "your own directory").
//
// Templates live flat in templates/skills/marveen-<name>.md at the repo root,
// next to templates/claude-md/ (same reason as there: the build is a bare tsc
// that copies no .md into dist). They reuse the 7a whitelist renderer and its
// value and body checks unchanged.
//
// Not wired (C1 PR 9): nothing outside the tests imports this module. Writing
// into the live <project>/.claude/skills is PR 10 (or the main agent's rollout
// step); here the target directory is always an explicit parameter.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { atomicWriteFileSync } from '../atomic-write.js'
import { shellWord } from '../sanitize.js'
import { TEMPLATES_DIR, TemplateError, checkBody, checkValue, loadTemplate, renderTemplate, templateKeys } from './render.js'

// templates/skills, beside templates/claude-md.
export const SKILL_TEMPLATES_DIR = join(TEMPLATES_DIR, '..', 'skills')

// The rendered skills, in a fixed order (design 2.4). marveen-directive-auth
// stays until the directive-verify hook (C1 PR 13a) is wired live for every
// agent; dropping it is a separate step.
export const PRODUCT_SKILLS = [
  'marveen-fleet-auth',
  'marveen-background-work',
  'marveen-skill-authoring',
  'marveen-approvals',
  'marveen-messaging',
  'marveen-directive-auth',
] as const

export type ProductSkillName = (typeof PRODUCT_SKILLS)[number]

// Install-level input of a skill render. Every field is the same for every
// agent of the install; a per-agent value must not be added here.
export interface SkillContext {
  // Absolute path of the install's project root (PROJECT_ROOT).
  projectRoot: string
  // The main agent's id (MAIN_AGENT_ID).
  mainAgentId: string
  // The dashboard origin the curl recipes call (agent-scaffold.ts
  // resolveDashboardOrigin: AGENT_API_ORIGIN, DASHBOARD_PUBLIC_URL or
  // http://localhost:<port>), without a trailing slash.
  dashboardOrigin: string
}

// The origin goes into recipe lines unquoted, as in agent-scaffold.ts, so it
// may hold only URL characters the shell leaves alone.
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9._~:@[\]%/-]+$/

// The placeholder values a skill template may use. `apiHelper` is derived the
// same way agent-scaffold.ts builds it, so a space in the root is quoted
// instead of splitting the command in two.
function skillVars(ctx: SkillContext): Record<string, string> {
  if (!isAbsolute(ctx.projectRoot)) {
    throw new TemplateError(`projectRoot must be an absolute path: ${ctx.projectRoot}`)
  }
  checkValue('projectRoot', ctx.projectRoot)
  checkValue('mainAgentId', ctx.mainAgentId)
  checkValue('dashboardOrigin', ctx.dashboardOrigin)
  if (!ORIGIN_RE.test(ctx.dashboardOrigin) || ctx.dashboardOrigin.endsWith('/')) {
    throw new TemplateError(`dashboardOrigin must be an http(s) origin without a trailing slash: ${ctx.dashboardOrigin}`)
  }
  return {
    projectRoot: ctx.projectRoot,
    mainAgentId: ctx.mainAgentId,
    dashboardOrigin: ctx.dashboardOrigin,
    apiHelper: `bash ${shellWord(join(ctx.projectRoot, 'scripts', 'marveen-api.sh'))}`,
  }
}

// The full SKILL.md text of one product skill: LF line endings, exactly one
// trailing LF. Pure: the same context and template give the same bytes.
export function renderProductSkill(name: ProductSkillName, ctx: SkillContext, dir: string = SKILL_TEMPLATES_DIR): string {
  const template = loadTemplate(name, dir)
  const all = skillVars(ctx)
  const vars: Record<string, string> = {}
  for (const key of templateKeys(template)) {
    if (!Object.prototype.hasOwnProperty.call(all, key)) {
      throw new TemplateError(`${name}: unknown placeholder {{${key}}}`)
    }
    vars[key] = all[key]
  }
  const body = renderTemplate(template, vars, name).replace(/\r\n/g, '\n').replace(/\n+$/, '')
  checkBody(body)
  return `${body}\n`
}

export interface WriteResult {
  written: ProductSkillName[]
  unchanged: ProductSkillName[]
}

// Renders every product skill into <targetDir>/<name>/SKILL.md. Each file is
// written atomically and only when its bytes change. Nothing else in
// targetDir is touched: other skills stay, and a marveen-* folder that is no
// longer in PRODUCT_SKILLS is NOT removed (retiring one is a separate step).
// Everything is rendered before the first write, so a template error writes
// nothing.
export function writeProductSkills(targetDir: string, ctx: SkillContext, dir: string = SKILL_TEMPLATES_DIR): WriteResult {
  if (!isAbsolute(targetDir)) throw new TemplateError(`targetDir must be an absolute path: ${targetDir}`)
  const rendered = PRODUCT_SKILLS.map((name) => ({ name, text: renderProductSkill(name, ctx, dir) }))
  const result: WriteResult = { written: [], unchanged: [] }
  for (const { name, text } of rendered) {
    const skillDir = join(targetDir, name)
    const file = join(skillDir, 'SKILL.md')
    if (existsSync(file) && readFileSync(file, 'utf-8') === text) {
      result.unchanged.push(name)
      continue
    }
    mkdirSync(skillDir, { recursive: true })
    atomicWriteFileSync(file, text)
    result.written.push(name)
  }
  return result
}
