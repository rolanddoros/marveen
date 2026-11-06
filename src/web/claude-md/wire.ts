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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID } from '../../config.js'
import { readEnvFile } from '../../env.js'
import { logger } from '../../logger.js'
import { agentDir } from '../agent-config.js'
import type { ProfileTemplate } from '../profiles.js'

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

// A sub agent at start, after its settings are written and its token synced. true = the v2 path handled the
// CLAUDE.md and the caller skips the legacy sequence; false = the caller runs it.
export function applySubClaudeMdV2(name: string, _profile: ProfileTemplate): boolean {
  if (!subFlagOn(name)) return false
  logger.warn({ name }, 'CLAUDE.md builder: v2 is not wired yet in this build; the legacy sections are kept')
  return false
}

// The main agent at boot (live instances only). Same contract as applySubClaudeMdV2.
export function applyMainClaudeMdV2(): boolean {
  if (!mainFlagOn()) return false
  logger.warn({ name: MAIN_AGENT_ID }, 'CLAUDE.md builder: v2 is not wired yet in this build; the legacy sections are kept')
  return false
}
