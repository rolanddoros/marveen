// A sub-agent's hook inputs, read from an install tree given by its root, for
// the read-only dry-run (hooks/cli.ts): it reads the LIVE tree (--root) while
// running from another checkout. The dashboard's own readers (agent-config.ts,
// agent-team.ts, profiles.ts, sender-role-gate-store.ts) bind to their
// checkout's PROJECT_ROOT at import and pull in config and logger, so they
// cannot be pointed at another tree. These mirror them, read only, and
// src/__tests__/hook-sub-inputs.test.ts pins every one against the dashboard's
// own reader on the same tree. C3-3b makes the dashboard read through these too.

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { parseEnvContent } from '../../env-parse.js'
import { TMP_ROOT_PREFIXES } from '../tmp-root-prefixes.js'
import type { HookProfileFlag, RenderContext } from './manifest.js'

/** config.ts HEARTBEAT_AGENT_ID. */
export const HEARTBEAT_AGENT_ID = 'heartbeat'
/** config.ts: `env.MAIN_AGENT_ID ?? 'marveen'`. */
const DEFAULT_MAIN_AGENT_ID = 'marveen'
/** agent-scaffold.ts EMAIL_THREAD_REPLY_CAPABILITY. */
const THREAD_REPLY_CAPABILITY = 'email:thread-reply'
/** The capability that renders the Playwright content notice (manifest entry browser-content-notice-playwright). */
export const BROWSER_CAPABILITY = 'browser'
/** sender-role-gate-store.ts UNREADABLE_GATES_POLICY. */
const UNREADABLE_GATES_POLICY = Buffer.from(JSON.stringify('unreadable'), 'utf-8').toString('base64url')

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A JSON file's value; undefined when it is missing or does not parse. */
function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return undefined }
}

// claude-md/dry-run.ts has its own readMainAgentId and listSubAgents (the CLAUDE.md dry-run, C1 8a). They differ
// on purpose in one place: that listSubAgents mirrors listAgentNames (hidden agents left out, they get no CLAUDE.md
// sections), this one mirrors listAllAgentNames, because the boot hook pass seeds hidden agents too (the heartbeat
// worker needs its gates, HBGATEWIRE826). The main id is read the same way: only MAIN_AGENT_ID is kept from .env,
// which also holds secrets.

/** The main agent's id: MAIN_AGENT_ID of <root>/.env, as config.ts reads it. */
export function mainAgentIdOf(root: string): string {
  let text: string
  try { text = readFileSync(join(root, '.env'), 'utf-8') } catch { return DEFAULT_MAIN_AGENT_ID }
  return parseEnvContent(text, ['MAIN_AGENT_ID']).MAIN_AGENT_ID ?? DEFAULT_MAIN_AGENT_ID
}

/** agent-config.ts listAllAgentNames (hidden agents included, as in the boot hook pass), against `root`. */
export function listSubAgents(root: string, mainAgentId: string): string[] {
  const base = join(root, 'agents')
  if (!existsSync(base)) return []
  let baseReal: string
  try { baseReal = realpathSync(base) } catch { baseReal = resolve(base) }
  return readdirSync(base).filter((f) => {
    if (f === mainAgentId) return false
    const path = join(base, f)
    try {
      const st = lstatSync(path)
      if (!st.isSymbolicLink()) return st.isDirectory()
      const target = realpathSync(path)
      if (target === baseReal || target.startsWith(baseReal + sep)) return false
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  })
}

function agentConfig(root: string, name: string): Record<string, unknown> {
  const v = readJson(join(root, 'agents', name, 'agent-config.json'))
  return isObject(v) ? v : {}
}

/** agent-config.ts readAgentCapabilities: agent-config.json "capabilities", else the persona frontmatter line. */
export function capabilitiesOf(root: string, name: string): string[] {
  const caps = agentConfig(root, name).capabilities
  if (Array.isArray(caps)) return caps as string[]
  let content: string
  try { content = readFileSync(join(root, 'personas', `${name}.md`), 'utf-8') } catch { return [] }
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const line = fm?.[1].match(/^capabilities:\s*\[([^\]]*)\]/m)
  if (!line) return []
  return line[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

/** agent-team.ts resolveAgentSecurityProfile: an explicit non-default profile, else 'applier' for a team leader. */
export function profileIdOf(root: string, name: string): string {
  const cfg = agentConfig(root, name)
  const stored = typeof cfg.securityProfile === 'string' ? cfg.securityProfile.trim() : ''
  if (stored && stored !== 'default') return stored
  return isObject(cfg.team) && cfg.team.role === 'leader' ? 'applier' : 'default'
}

/** profiles.ts loadProfileTemplate's gate switches: the profile's file, else default.json, else none. */
export function profileFlagsOf(root: string, profileId: string): Record<HookProfileFlag, boolean> {
  const dir = join(root, 'templates', 'profiles')
  let p = readJson(join(dir, `${profileId}.json`))
  if (!isObject(p) && profileId !== 'default') p = readJson(join(dir, 'default.json'))
  const q = isObject(p) ? p : {}
  return { destructiveGate: q.destructiveGate === true, credentialGate: q.credentialGate === true, secondReviewer: q.secondReviewer === true }
}

/** agent-config.ts senderRoleGateEnabled, on the store's value for one agent. */
function senderRoleGateEnabled(gate: unknown): boolean {
  if (!isObject(gate)) return true
  if (Object.hasOwn(gate, 'allowTools')) return true
  const risky = gate.riskyTools
  if (risky === undefined) return false
  return !(Array.isArray(risky) && risky.length === 0)
}

/** agent-config.ts readAgentSenderRoleGatePolicy: from <root>/store/agent-sender-role-gates.json only; unreadable fails closed. */
export function senderRolePolicyOf(root: string, name: string, gatesPath = join(root, 'store', 'agent-sender-role-gates.json')): string | null {
  if (!existsSync(gatesPath)) return null
  let gates: unknown
  try {
    gates = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(gatesPath)))
  } catch {
    return UNREADABLE_GATES_POLICY
  }
  if (!isObject(gates)) return UNREADABLE_GATES_POLICY
  if (!Object.hasOwn(gates, name) || !senderRoleGateEnabled(gates[name])) return null
  return Buffer.from(JSON.stringify(gates[name]), 'utf-8').toString('base64url')
}

/** The profile switches and agent properties the sub render reads, for one agent of the tree at `root`. */
export function subHookFlags(root: string, name: string): Required<Pick<RenderContext, 'profile' | 'agent'>> & { profileId: string } {
  const profileId = profileIdOf(root, name)
  const caps = capabilitiesOf(root, name)
  return {
    profileId,
    profile: profileFlagsOf(root, profileId),
    agent: {
      heartbeat: name === HEARTBEAT_AGENT_ID,
      threadReply: caps.includes(THREAD_REPLY_CAPABILITY),
      senderRolePolicy: senderRolePolicyOf(root, name),
      browser: caps.includes(BROWSER_CAPABILITY),
    },
  }
}

// agent-scaffold.ts HOOK_NODE_BIN: a Homebrew Cellar node is burnt in as its stable opt symlink when that
// resolves to the same binary (the reasons are at resolveHookNodeBin there, which is this function).
const BREW_CELLAR_NODE_RE = /^(.+)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/
export function resolveHookNodeBin(
  execPath: string,
  fs: { existsSync: (p: string) => boolean; realpathSync: (p: string) => string } = { existsSync, realpathSync },
): string {
  const m = BREW_CELLAR_NODE_RE.exec(execPath)
  if (!m) return execPath
  const stable = `${m[1]}/opt/${m[2]}/bin/node`
  try {
    if (fs.existsSync(stable) && fs.realpathSync(stable) === fs.realpathSync(execPath)) return stable
  } catch {
    // An unreadable link is no better than the pinned path; keep execPath.
  }
  return execPath
}

/**
 * agent-scaffold.ts's registration guard (re-exported there): true when a hook command must not be written,
 * because it names a path under a volatile tmp directory, or its script path does not exist.
 */
export function isUnsafeHookCommand(command: string): boolean {
  if (TMP_ROOT_PREFIXES.some((p) => command.includes(p))) return true
  const m = command.match(/\/[^\s'"]+\.(?:py|mjs|js|sh)\b/)
  if (m && !existsSync(m[0])) return true
  return false
}
