// Who is calling, from a hook payload, for the gates that need it (the deploy helper's exception in
// db-write-gate.mjs first). A port of scripts/hooks/ledger_lib.py's transcript rule, STRICTER on purpose:
//
//   <install>/agents/<id>/...                          -> <id>   (a sub-agent's own config dir)
//   .../projects/<flat install>-agents-<id>[-...]/...  -> <id>   (a sub-agent on a shared config root)
//   <main config root>/projects/<flat install>/<file>  -> MAIN, only when BOTH hold:
//       the segment is EXACTLY the flattened install (no "-docs", no "-c-stuart-wt" sibling worktree), and
//       <main config root> is the root the launcher exported for the main agent on this boot, read from the
//       record store/main-agent-config-root.json (written by scripts/write-main-config-root.sh in every
//       launcher's pane command: channels.sh, channel-watchdog.sh, stuck-modal-guard.sh)
//   anything else                                      -> null   (the gate DENIES)
//
// Deliberate differences from ledger_lib (it books messages, so it may guess; a gate may not):
//   - no "segment starts with the flat install means MAIN" (ledger_lib.py:234-235),
//   - no "anywhere else in the install tree means MAIN" (ledger_lib.py:196-197),
//   - no "~/.claude without a known segment means MAIN" (ledger_lib.py:198-200),
//   - no MARVEEN_AGENT_ID and no cwd fallback (the cwd moves within a session, LEDGERCWD828),
//   - MAIN_AGENT_ID only from <install>/.env, never the 'marveen' default (ledger_lib.py:109).
// The payload path is resolved LEXICALLY, never with realpath: agents/<id>/.claude-config/projects is
// itself a symlink into ~/.claude/projects on a fleet host (ledger_lib.py:80-95).
//
// This is an accident and injection brake, NOT a security boundary: a same-user script file calls the
// helper without any hook (docs/db-write-gate.md). On a shared root ('shared' mode) the root is common
// to every agent on it, so only the exact segment tells them apart: a shared-root session started with
// its cwd exactly at the install reads as MAIN there.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

export const RECORD_REL = join('store', 'main-agent-config-root.json')
export const RECORD_MODES = Object.freeze(['explicit', 'rotated', 'isolated', 'token', 'shared'])
// What the record writer refuses in a directory: control characters, a quote, a backslash (C3).
const BAD_DIR_CHAR_RX = /[\u0000-\u001f\u007f"'\\]/

/** A record dir the writer would accept: absolute, normalised, no control character, quote or backslash. */
export function isRecordDir(dir) {
  if (typeof dir !== 'string' || dir.length === 0 || dir.length > 4096) return false
  if (!isAbsolute(dir) || BAD_DIR_CHAR_RX.test(dir)) return false
  return resolve(dir) === dir.replace(/\/+$/, '') || dir === '/'
}

/** The parsed record, or null when it is missing, unreadable or not of the expected shape. */
export function readConfigRootRecord(installRoot) {
  let raw
  try {
    raw = readFileSync(join(installRoot, RECORD_REL), 'utf8')
  } catch {
    return null
  }
  let rec
  try {
    rec = JSON.parse(raw)
  } catch {
    return null
  }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null
  if (!RECORD_MODES.includes(rec.mode) || !isRecordDir(rec.dir)) return null
  return { mode: rec.mode, dir: rec.dir.replace(/\/+$/, '') || '/', writer: typeof rec.writer === 'string' ? rec.writer : null }
}

/** MAIN_AGENT_ID from <install>/.env, or null (no default: a missing line means no MAIN). */
export function readMainAgentId(installRoot) {
  let text
  try {
    text = readFileSync(join(installRoot, '.env'), 'utf8')
  } catch {
    return null
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('MAIN_AGENT_ID=')) continue
    const v = line.slice('MAIN_AGENT_ID='.length).trim()
    return /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null
  }
  return null
}

/** The install dir as reached AND with symlinks resolved (ledger_lib.py:80-95); the payload path is never resolved. */
export function installForms(installRoot) {
  const out = [installRoot.replace(/\/+$/, '')]
  try {
    const real = realpathSync(installRoot).replace(/\/+$/, '')
    if (!out.includes(real)) out.push(real)
  } catch { /* the lexical form only */ }
  return out
}

function agentNames(installRoot) {
  try {
    return readdirSync(join(installRoot, 'agents'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

/** Everything the pure rule reads, from the install on disk. */
export function loadIdentityContext(installRoot) {
  return {
    installs: installForms(installRoot),
    agents: agentNames(installRoot),
    mainAgentId: readMainAgentId(installRoot),
    record: existsSync(join(installRoot, RECORD_REL)) ? readConfigRootRecord(installRoot) : null,
  }
}

const flat = (dir) => dir.split(sep).join('-')

function subAgentFromSegment(seg, install, names) {
  const prefix = flat(install) + '-agents-'
  if (!seg.startsWith(prefix)) return null
  const rest = seg.slice(prefix.length)
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    if (rest === name || rest.startsWith(name + '-')) return name
  }
  const head = rest.split('-')[0]
  return head || null
}

/**
 * The caller's agent id for a transcript path, or null. Pure: every input is in `ctx`
 * ({installs, agents, mainAgentId, record}, see loadIdentityContext).
 * @returns {{ id: string|null, why: string }}
 */
export function identifyTranscript(transcriptPath, ctx) {
  if (typeof transcriptPath !== 'string' || transcriptPath.trim() === '') return { id: null, why: 'no transcript_path' }
  const p = resolve(transcriptPath.trim())
  const installs = ctx.installs ?? []
  // 1. The config OWNER is authoritative: under <install>/agents/<id>/ it is that agent's own config dir.
  for (const install of installs) {
    const agentsRoot = join(install, 'agents') + sep
    if (p.startsWith(agentsRoot)) {
      const head = p.slice(agentsRoot.length).split(sep)[0]
      return head ? { id: head, why: 'agent config dir' } : { id: null, why: 'empty agent segment' }
    }
  }
  // 2. A sub-agent on a shared root: the flattened starting cwd names it.
  const marker = sep + 'projects' + sep
  const at = p.indexOf(marker)
  if (at >= 0) {
    const seg = p.slice(at + marker.length).split(sep)[0]
    for (const install of installs) {
      const sub = subAgentFromSegment(seg, install, ctx.agents ?? [])
      if (sub) return { id: sub, why: 'agent project segment' }
    }
  }
  // 3. MAIN: the launcher's root, then exactly /projects/<flat install>/<one file>.
  const rec = ctx.record
  if (!rec) return { id: null, why: 'no valid main-agent-config-root record' }
  if (!ctx.mainAgentId) return { id: null, why: 'no MAIN_AGENT_ID in .env' }
  const rootProjects = (rec.dir === '/' ? '' : rec.dir) + marker
  if (!p.startsWith(rootProjects)) return { id: null, why: `transcript root is not the recorded main root ${rec.dir} (writer ${rec.writer ?? '?'})` }
  const rest = p.slice(rootProjects.length).split(sep)
  if (rest.length !== 2 || rest[1] === '') return { id: null, why: 'not <root>/projects/<segment>/<file>' }
  if (!installs.some((install) => rest[0] === flat(install))) return { id: null, why: 'project segment is not exactly the install' }
  return { id: ctx.mainAgentId, why: `main root (${rec.mode})` }
}

/** True only when the payload's caller is the main agent. */
export function callerIsMain(payload, installRoot, ctx = loadIdentityContext(installRoot)) {
  const r = identifyTranscript(payload?.transcript_path, ctx)
  return { main: r.id !== null && r.id === ctx.mainAgentId, id: r.id, why: r.why }
}
