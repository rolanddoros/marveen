// C1 PR 10b: the CLAUDE.md builder behind the per-agent flag.
//
// The two places that render generated CLAUDE.md sections today, a sub
// agent's start (agent-process.ts startAgentProcess) and the main agent's
// boot (web.ts), keep their legacy call sequence where it is, unchanged, and
// run it only when applySubClaudeMdV2 / applyMainClaudeMdV2 return false:
//   if (!applySubClaudeMdV2(name, profile)) { ...the legacy sequence... }
// With the flag off (the default) these return false after doing nothing, so
// the files come out byte-identical (a source-parity test pins both sequences
// against the base f4fa24a1, a behaviour test pins the bytes). The legacy
// sequences stay at the call sites rather than moving here because fifteen
// wiring-contract tests in nine files read them there.
//
// The flag:
// - a sub: agents/<name>/agent-config.json "claudeMdBuilder", read fresh on
//   every start;
// - the main agent: CLAUDE_MD_BUILDER_MAIN in <root>/.env, read fresh at boot.
// Only the exact string "v2" is on. Anything else (absent, "V2", true, "v3")
// is off; a present value other than "v2" is warned about once per value.
// The flag acts only on these two paths: the federation routes and agents.ts
// keep calling their own writers.
//
// Flag on, the v2 path (writeV2), in this order, each step fail-closed:
// 1. Refusals (warn-log, legacy kept): federation enabled (two writers would
//    flip the file, PR 12), the heartbeat worker (PR 12), a thin-chief profile
//    (the region does not carry that block), a helper-denied agent (its v2
//    recipes need a skill that does not exist yet, Kevin 12997).
// 2. The owner-zone writers that also run today: a sub's
//    ensureProjectRootInClaudeMd + ensureSkillSectionCurrent, the main agent's
//    ensureFederationClaudeMdSection (it also cleans the sub files).
// 3. The live ctx: buildLiveContext with the dashboard's own helperAllowed /
//    strict (agentUsesApiHelper / agentRunsStrict); a RENDERED field still on
//    the assumptions list, or a main id other than config's, stops the write.
// 4. renderRegion (a TemplateError stops it).
// 5. The product skills: the guarded installer, then every marveen-* name the
//    region mentions must be one of them, installed as the manifest records.
// 6. composeClaudeMd; unchanged -> no write, no backup.
// 7. A file without a v2 region yet is backed up first (BackupError stops it).
// 8. The atomic write.
// Any failure is error-logged and nothing more is written. The return value
// then tells the caller whether to run the legacy sequence: yes while the
// file has no v2 region (it stays a legacy file), no once it has one (legacy
// blocks must not be appended to a v2 file).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_API_ORIGIN, DASHBOARD_PUBLIC_URL, HEARTBEAT_AGENT_ID, MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR, WEB_PORT } from '../../config.js'
import { readEnvFile } from '../../env.js'
import { logger } from '../../logger.js'
import { agentDir, listAllAgentNames } from '../agent-config.js'
import { agentRunsStrict, agentUsesApiHelper, ensureProjectRootInClaudeMd, ensureSkillSectionCurrent, resolveDashboardOrigin } from '../agent-scaffold.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { getFederationConfig } from '../federation/config.js'
import { ensureFederationClaudeMdSection } from '../federation/onboarding.js'
import { profileWantsThinChiefHandoff, type ProfileTemplate } from '../profiles.js'
import { backupClaudeMd } from './backup.js'
import { composeClaudeMd } from './compose.js'
import { buildLiveContext, RENDERED_FIELDS } from './live-context.js'
import { renderRegion } from './registry.js'
import { REGION_BEGIN } from './render.js'
import { defaultSkillInstallPaths, installProductSkills, productSkillsInstalled, removeProductSkills, type SkillInstallPaths } from './skill-install.js'
import { PRODUCT_SKILLS, type SkillContext } from './skills.js'

export const FLAG_ON = 'v2'
export const SUB_FLAG_KEY = 'claudeMdBuilder'
export const MAIN_FLAG_ENV = 'CLAUDE_MD_BUILDER_MAIN'

const warnedFlagValues = new Set<string>()

function warnUnknownFlag(where: string, value: unknown): void {
  const key = `${where}\u0000${JSON.stringify(value)}`
  if (warnedFlagValues.has(key)) return
  warnedFlagValues.add(key)
  logger.warn({ where, value }, `CLAUDE.md builder flag: only the exact string "${FLAG_ON}" turns v2 on; this value keeps the legacy sections`)
}

// A sub agent's flag, read fresh from its agent-config.json. A missing or
// unreadable file, or one that does not parse, is off.
export function subFlagOn(name: string): boolean {
  let raw: unknown
  try {
    const cfg = JSON.parse(readFileSync(join(agentDir(name), 'agent-config.json'), 'utf-8')) as unknown
    if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) return false
    raw = (cfg as Record<string, unknown>)[SUB_FLAG_KEY]
  } catch {
    return false
  }
  if (raw === FLAG_ON) return true
  if (raw !== undefined) warnUnknownFlag(name, raw)
  return false
}

// The main agent's flag, read fresh from .env (not config.ts's boot-time copy).
export function mainFlagOn(): boolean {
  const raw = readEnvFile([MAIN_FLAG_ENV])[MAIN_FLAG_ENV]
  if (raw === FLAG_ON) return true
  if (raw !== undefined && raw !== '') warnUnknownFlag(MAIN_AGENT_ID, raw)
  return false
}

export interface WireDeps {
  root: string
  storeDir: string
  mainAgentId: string
  skillPaths: SkillInstallPaths
  skillCtx: () => SkillContext
  federationEnabled: () => boolean
  helperAllowed: (name: string) => boolean
  strict: (name: string, profile?: ProfileTemplate) => boolean
  now: () => Date
}

export function defaultWireDeps(): WireDeps {
  return {
    root: PROJECT_ROOT,
    storeDir: STORE_DIR,
    mainAgentId: MAIN_AGENT_ID,
    skillPaths: defaultSkillInstallPaths(PROJECT_ROOT, STORE_DIR),
    skillCtx: () => ({ projectRoot: PROJECT_ROOT, mainAgentId: MAIN_AGENT_ID, dashboardOrigin: resolveDashboardOrigin(DASHBOARD_PUBLIC_URL, WEB_PORT, AGENT_API_ORIGIN) }),
    federationEnabled: () => getFederationConfig().enabled,
    helperAllowed: (name) => agentUsesApiHelper(name),
    strict: (name, profile) => agentRunsStrict(name, profile),
    now: () => new Date(),
  }
}

// The marveen-* skill names a rendered region points at (a file name such as marveen-api.sh is not one).
export function regionSkillRefs(region: string): string[] {
  return [...new Set([...region.matchAll(/\bmarveen-[a-z]+(?:-[a-z]+)*\b(?!\.[a-z])/gi)].map((m) => m[0].toLowerCase()))].sort()
}

// Whether the text has a v2 region, by its BEGIN marker as a whole line.
export function hasV2Region(text: string): boolean {
  return text.split('\n').some((l) => l.replace(/\r$/, '') === REGION_BEGIN)
}

// Whether any agent of the install has its flag on (the product skills stay installed while one has).
export function anyFlagOn(): boolean {
  if (mainFlagOn()) return true
  try {
    return listAllAgentNames().some((n) => subFlagOn(n))
  } catch {
    return true // cannot tell: keep the skills
  }
}

// The flag-off housekeeping that only acts on what v2 left behind: with no flag on anywhere, the product skills of
// the manifest are removed. Without a manifest it does nothing, so a never-flagged install stays byte-identical.
function flagOffHousekeeping(deps: WireDeps): void {
  try {
    if (!existsSync(deps.skillPaths.manifestPath) || anyFlagOn()) return
    const r = removeProductSkills(deps.skillPaths)
    logger.info({ removed: r.removed, kept: r.kept }, 'CLAUDE.md builder: no agent is on v2 any more; the rendered product skills are removed')
    if (r.kept.length > 0) logger.warn({ kept: r.kept }, 'CLAUDE.md builder: these product skill files were changed by hand and are kept')
  } catch (err) {
    logger.error({ err }, 'CLAUDE.md builder: removing the rendered product skills failed; nothing more is removed')
  }
}

function refusal(deps: WireDeps, name: string, profile: ProfileTemplate | null): string | null {
  if (deps.federationEnabled()) return 'federation is enabled (its onboarding block has a second writer until C1 PR 12)'
  if (name === HEARTBEAT_AGENT_ID) return 'the heartbeat worker gets v2 in C1 PR 12'
  if (profile !== null && profileWantsThinChiefHandoff(profile)) return 'a thin-chief profile: the v2 region does not carry that block'
  if (!deps.helperAllowed(name)) return 'the agent settings deny the API helper: its v2 recipes need a skill that does not exist yet'
  return null
}

// Steps 3-8 of the header for one CLAUDE.md. Returns whether the caller should run the legacy sequence.
function writeV2(deps: WireDeps, name: string, claudeMdPath: string, strict: boolean): boolean {
  let hadRegion = false
  try {
    const text = readFileSync(claudeMdPath, 'utf-8')
    hadRegion = hasV2Region(text)
    const { ctx, assumptions } = buildLiveContext(deps.root, name, { helperAllowed: true, strict })
    const assumedRendered = assumptions.filter((a) => (RENDERED_FIELDS as readonly string[]).includes(a))
    if (assumedRendered.length > 0) throw new Error(`rendered fields without a real source: ${assumedRendered.join(', ')}`)
    if (ctx.mainAgentId !== deps.mainAgentId) throw new Error(`.env MAIN_AGENT_ID ${ctx.mainAgentId} is not the running main id ${deps.mainAgentId}`)
    const region = renderRegion(ctx)
    installProductSkills(deps.skillPaths, deps.skillCtx())
    const refs = regionSkillRefs(region)
    const unknown = refs.filter((r) => !(PRODUCT_SKILLS as readonly string[]).includes(r))
    if (unknown.length > 0) throw new Error(`the region points at skills that are not product skills: ${unknown.join(', ')}`)
    if (!productSkillsInstalled(deps.skillPaths, refs)) throw new Error('a skill the region points at is not installed as the manifest records')
    const composed = composeClaudeMd(text, region)
    if (!composed.changed) return false
    if (!hadRegion) backupClaudeMd(deps.storeDir, name, text, deps.now())
    atomicWriteFileSync(claudeMdPath, composed.text)
    logger.info({ name, removed: composed.removed, firstV2: !hadRegion }, 'CLAUDE.md builder: v2 region written')
    return false
  } catch (err) {
    logger.error({ err, name }, 'CLAUDE.md builder: v2 write failed; the file is left as it was')
    return !hadRegion
  }
}

// A sub agent at start, after its settings are written and its token synced. true = the v2 path handled the
// CLAUDE.md and the caller skips the legacy sequence; false = the caller runs it.
export function applySubClaudeMdV2(name: string, profile: ProfileTemplate, deps: WireDeps = defaultWireDeps()): boolean {
  if (!subFlagOn(name)) {
    flagOffHousekeeping(deps)
    return false
  }
  try {
    const why = refusal(deps, name, profile)
    if (why !== null) {
      logger.warn({ name, why }, 'CLAUDE.md builder: v2 refused; the legacy sections are kept')
      return false
    }
    const claudeMdPath = join(agentDir(name), 'CLAUDE.md')
    if (!existsSync(claudeMdPath)) return false
    ensureProjectRootInClaudeMd(name)
    ensureSkillSectionCurrent(name)
    return !writeV2(deps, name, claudeMdPath, deps.strict(name, profile))
  } catch (err) {
    logger.error({ err, name }, 'CLAUDE.md builder: v2 path failed before the write; the legacy sections are kept')
    return false
  }
}

// The main agent at boot (live instances only). Same contract as applySubClaudeMdV2.
export function applyMainClaudeMdV2(deps: WireDeps = defaultWireDeps()): boolean {
  if (!mainFlagOn()) {
    flagOffHousekeeping(deps)
    return false
  }
  const name = deps.mainAgentId
  try {
    const why = refusal(deps, name, null)
    if (why !== null) {
      logger.warn({ name, why }, 'CLAUDE.md builder: v2 refused; the legacy sections are kept')
      return false
    }
    const claudeMdPath = join(deps.root, 'CLAUDE.md')
    if (!existsSync(claudeMdPath)) return false
    ensureFederationClaudeMdSection()
    return !writeV2(deps, name, claudeMdPath, false)
  } catch (err) {
    logger.error({ err, name }, 'CLAUDE.md builder: v2 path failed before the write; the legacy sections are kept')
    return false
  }
}
