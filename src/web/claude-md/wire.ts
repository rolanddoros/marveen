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
// 1. Refusals (warn-log, the legacy sequence runs): federation enabled (two
//    writers would flip the file, PR 12), the heartbeat worker (PR 12), a
//    thin-chief profile (the region does not carry that block), a
//    helper-denied agent (its v2 recipes need a skill that does not exist
//    yet, Kevin 12997). A refused agent whose file already has a v2 region is
//    taken BACK to legacy: the rollback below runs first.
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
// 7. A file without a v2 region yet is backed up first (BackupError stops it),
//    with its bytes as read BEFORE step 2: the owner-zone writers can migrate
//    the owner zone (a retired skill section), and the backup is the file as
//    it was before the transition (Ron 10b J3).
// 8. The atomic write.
// The file is read as bytes and decoded strictly (TextDecoder fatal, the BOM
// kept): a file that is not valid UTF-8 is not written, because a decoded and
// re-encoded string turns each invalid byte into U+FFFD, in the file and in
// its backup (Ron 10b B1; the dry-run refuses such a file the same way). The
// backup holds the bytes as read, never a re-encoded string.
// Any failure is error-logged and nothing more is written. The return value
// then tells the caller whether to run the legacy sequence: yes while the
// file has no v2 region (it stays a legacy file), no once it has one (legacy
// blocks must not be appended to a v2 file).
//
// Rollback (E): with the flag off, or refused, a file that still has a v2
// region (the flag was on before) gets the region stripped (stripV2Region),
// after a backup of the v2 file, and the caller then runs the legacy sequence,
// which writes its blocks again. Without the strip, the legacy writers
// appended their blocks next to the region. A strip that fails (a broken
// file, the backup, the write) leaves the file as it was and the legacy
// sequence is skipped: still no legacy blocks next to a region. A file
// without a region is only read, so a never-flagged install stays
// byte-identical. The rendered product skills go only once no flag is on AND
// no CLAUDE.md of the install still carries a region: an agent flagged off
// but not restarted yet keeps pointing at them (Ron 10b J1).

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGENT_API_ORIGIN, APP_TZ, DASHBOARD_PUBLIC_URL, HEARTBEAT_AGENT_ID, MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR, WEB_PORT } from '../../config.js'
import { readEnvFile } from '../../env.js'
import { logger } from '../../logger.js'
import { agentDir, listAllAgentNames } from '../agent-config.js'
import { agentRunsStrict, agentUsesApiHelper, ensureProjectRootInClaudeMd, ensureSkillSectionCurrent, resolveDashboardOrigin } from '../agent-scaffold.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { getFederationConfig } from '../federation/config.js'
import { ensureFederationClaudeMdSection } from '../federation/onboarding.js'
import { profileWantsThinChiefHandoff, type ProfileTemplate } from '../profiles.js'
import { backupClaudeMd } from './backup.js'
import { composeClaudeMd, stripV2Region } from './compose.js'
import { buildLiveContext, defaultManagedSettingsPath, RENDERED_FIELDS } from './live-context.js'
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
  // The backup directory's time zone: the install zone (config.ts APP_TZ).
  tz: string
  // The live ctx's settings sources (tests point them at the temp root).
  homeDir: string
  managedSettingsPath: string
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
    tz: APP_TZ,
    homeDir: homedir(),
    managedSettingsPath: defaultManagedSettingsPath(),
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
    if (anyRegionLeft(deps)) {
      logger.info('CLAUDE.md builder: no agent is on v2, but a CLAUDE.md still carries a region; the product skills stay until its next start')
      return
    }
    const r = removeProductSkills(deps.skillPaths)
    logger.info({ removed: r.removed, kept: r.kept }, 'CLAUDE.md builder: no agent is on v2 any more; the rendered product skills are removed')
    if (r.kept.length > 0) logger.warn({ kept: r.kept }, 'CLAUDE.md builder: these product skill files were changed by hand and are kept')
  } catch (err) {
    logger.error({ err }, 'CLAUDE.md builder: removing the rendered product skills failed; nothing more is removed')
  }
}

// Whether any CLAUDE.md of the install (the main agent's, every agent's) still carries a v2 region; cannot tell -> true.
function anyRegionLeft(deps: WireDeps): boolean {
  try {
    const files = [join(deps.root, 'CLAUDE.md'), ...listAllAgentNames().map((n) => join(agentDir(n), 'CLAUDE.md'))]
    return files.some((f) => fileHasV2Region(f))
  } catch {
    return true
  }
}

function refusal(deps: WireDeps, name: string, profile: ProfileTemplate | null): string | null {
  if (deps.federationEnabled()) return 'federation is enabled (its onboarding block has a second writer until C1 PR 12)'
  if (name === HEARTBEAT_AGENT_ID) return 'the heartbeat worker gets v2 in C1 PR 12'
  if (profile !== null && profileWantsThinChiefHandoff(profile)) return 'a thin-chief profile: the v2 region does not carry that block'
  if (!deps.helperAllowed(name)) return 'the agent settings deny the API helper: its v2 recipes need a skill that does not exist yet'
  return null
}

// The rollback of the header for one CLAUDE.md. Returns whether the caller may run the legacy sequence.
function rollbackV2(deps: WireDeps, name: string, claudeMdPath: string): boolean {
  let file: ClaudeMdFile
  try {
    file = readClaudeMd(claudeMdPath)
  } catch {
    return true // absent or unreadable: the legacy sequence decides, as before
  }
  if (!file.hasRegion) return true
  try {
    if (file.text === null) throw new Error(`${claudeMdPath} is not valid UTF-8: the region is not removed (the bytes would change)`)
    const stripped = stripV2Region(file.text)
    if (!stripped.changed) return true // the marker line sits in a code fence: owner text, no region
    backupClaudeMd(deps.storeDir, name, file.bytes, deps.now(), deps.tz)
    atomicWriteFileSync(claudeMdPath, stripped.text)
    logger.info({ name }, 'CLAUDE.md builder: v2 is off for this agent; the v2 region is removed (backed up) and the legacy sections are written again')
    return true
  } catch (err) {
    logger.error({ err, name }, 'CLAUDE.md builder: removing the v2 region failed; the file is left as it was and the legacy sections are not appended')
    return false
  }
}

// A CLAUDE.md as bytes and as text. The text is decoded strictly (fatal, the BOM kept as a character): null when
// the bytes are not valid UTF-8 (Ron 10b B1). hasRegion does not need valid UTF-8: the marker lines are ASCII.
interface ClaudeMdFile { bytes: Buffer; text: string | null; hasRegion: boolean }

function readClaudeMd(claudeMdPath: string): ClaudeMdFile {
  const bytes = readFileSync(claudeMdPath)
  let text: string | null
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    text = null
  }
  return { bytes, text, hasRegion: hasV2Region(text ?? new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)) }
}

// Whether the file has a v2 region; unreadable reads as no (the legacy sequence decides, as before).
function fileHasV2Region(claudeMdPath: string): boolean {
  try {
    return hasV2Region(readFileSync(claudeMdPath, 'utf-8'))
  } catch {
    return false
  }
}

// Steps 3-8 of the header for one CLAUDE.md. `before`: the file's bytes as read before step 2, for the backup.
// Returns whether the caller should run the legacy sequence.
function writeV2(deps: WireDeps, name: string, claudeMdPath: string, strict: boolean, before: Buffer): boolean {
  let hadRegion = false
  try {
    const file = readClaudeMd(claudeMdPath)
    hadRegion = file.hasRegion
    if (file.text === null) throw new Error(`${claudeMdPath} is not valid UTF-8: nothing is written (the bytes would change)`)
    const text = file.text
    const { ctx, assumptions } = buildLiveContext(deps.root, name, { helperAllowed: true, strict, homeDir: deps.homeDir, managedSettingsPath: deps.managedSettingsPath })
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
    if (!hadRegion) backupClaudeMd(deps.storeDir, name, before, deps.now(), deps.tz)
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
  // agentDir throws on a name it refuses; these entry points never throw (the legacy sequence then decides).
  let claudeMdPath: string | null = null
  try { claudeMdPath = join(agentDir(name), 'CLAUDE.md') } catch { /* stays null */ }
  if (!subFlagOn(name)) {
    const legacy = claudeMdPath === null || rollbackV2(deps, name, claudeMdPath)
    flagOffHousekeeping(deps)
    return !legacy
  }
  try {
    const why = refusal(deps, name, profile)
    if (why !== null) {
      logger.warn({ name, why }, 'CLAUDE.md builder: v2 refused; the legacy sections are kept')
      return claudeMdPath !== null && !rollbackV2(deps, name, claudeMdPath)
    }
    if (claudeMdPath === null) throw new Error(`no agent directory path for ${JSON.stringify(name)}`)
    if (!existsSync(claudeMdPath)) return false
    const before = readFileSync(claudeMdPath) // the backup's bytes, before step 2 can migrate the owner zone
    ensureProjectRootInClaudeMd(name)
    ensureSkillSectionCurrent(name)
    return !writeV2(deps, name, claudeMdPath, deps.strict(name, profile), before)
  } catch (err) {
    logger.error({ err, name }, 'CLAUDE.md builder: v2 path failed before the write; the legacy sections are kept')
    return claudeMdPath !== null && fileHasV2Region(claudeMdPath)
  }
}

// The main agent at boot (live instances only). Same contract as applySubClaudeMdV2.
export function applyMainClaudeMdV2(deps: WireDeps = defaultWireDeps()): boolean {
  const name = deps.mainAgentId
  const claudeMdPath = join(deps.root, 'CLAUDE.md')
  if (!mainFlagOn()) {
    const legacy = rollbackV2(deps, name, claudeMdPath)
    flagOffHousekeeping(deps)
    return !legacy
  }
  try {
    const why = refusal(deps, name, null)
    if (why !== null) {
      logger.warn({ name, why }, 'CLAUDE.md builder: v2 refused; the legacy sections are kept')
      return !rollbackV2(deps, name, claudeMdPath)
    }
    if (!existsSync(claudeMdPath)) return false
    const before = readFileSync(claudeMdPath) // the backup's bytes, before step 2 can change the file
    ensureFederationClaudeMdSection()
    return !writeV2(deps, name, claudeMdPath, false, before)
  } catch (err) {
    logger.error({ err, name }, 'CLAUDE.md builder: v2 path failed before the write; the legacy sections are kept')
    return fileHasV2Region(claudeMdPath)
  }
}
