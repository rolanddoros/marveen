// The protected per-agent baseline (Fork C settings-protect plan v2 K3, Ron 17451 N1 direction): for each sub-agent
// the switch TUPLE its hooks render depends on, approved by the owner. The verifier expands the lock with this tuple
// only and never with the live inputs (agent-config.json, personas/, templates/profiles/, the dashboard's PUT routes
// all feed the dashboard's generator, so any change there shows up as a block that differs from the baseline render:
// an alert in report mode, no start in enforce, until an approved rebaseline).
//
// store/agent-settings-baseline.json is an exact-match protected path, written only by the owner-approved helper
// (scripts/agent-settings/apply-local.mjs: agent_settings approval, apply / rebaseline). Shape:
//   { "format": BASELINE_FORMAT,
//     "agents": { "<name>": { "switches": <tuple>, "local": { "sha256": <hex>|null } } } }
// <tuple> = { profileId, profile: { destructiveGate, credentialGate, secondReviewer }, threadReply, browser,
//             heartbeat, senderRolePolicySha256: <hex>|null, nodeBin }
import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, normalize, sep } from 'node:path'

export const BASELINE_REL = 'store/agent-settings-baseline.json'
export const BASELINE_FORMAT = 'marveen-agent-settings-baseline/v1'
export const TUPLE_KEYS = Object.freeze(['profileId', 'profile', 'threadReply', 'browser', 'heartbeat', 'senderRolePolicySha256', 'nodeBin'])
export const PROFILE_KEYS = Object.freeze(['destructiveGate', 'credentialGate', 'secondReviewer'])
/** src/web/hooks/sub-inputs.ts HEARTBEAT_AGENT_ID (pinned by a test): the heartbeat switch follows the name. */
export const HEARTBEAT_AGENT_ID = 'heartbeat'
/** src/web/hooks/sub-inputs.ts UNREADABLE_GATES_POLICY (pinned by a test): an unreadable gates file fails closed. */
export const UNREADABLE_GATES_POLICY = Buffer.from(JSON.stringify('unreadable'), 'utf-8').toString('base64url')
/** src/web/tmp-root-prefixes.ts TMP_ROOT_PREFIXES (pinned by a test). */
export const TMP_ROOT_PREFIXES = Object.freeze(['/tmp/', '/var/tmp/', '/private/tmp/', '/dev/shm/'])

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const SHA_RE = /^[0-9a-f]{64}$/

/** Parse a baseline text; throws with a reason (no content) when it is not one. */
export function parseBaseline(text) {
  let b
  try {
    b = JSON.parse(text)
  } catch {
    throw new Error('baseline: not JSON')
  }
  if (!isPlainObject(b) || b.format !== BASELINE_FORMAT || !isPlainObject(b.agents)) throw new Error('baseline: unknown format')
  return b
}

/**
 * Why a tuple names no combination the lock can render (N2-4): exact keys, booleans, a plain profile id, the heartbeat
 * switch equal to the name rule, a sha256 or null. An empty list means the tuple is usable as it stands.
 */
export function tupleErrors(tuple, agent) {
  if (!isPlainObject(tuple)) return ['the switch tuple is not an object']
  const errors = []
  const keys = Object.keys(tuple).sort()
  if (keys.join(',') !== [...TUPLE_KEYS].sort().join(',')) errors.push('the switch tuple does not have exactly the known keys')
  if (typeof tuple.profileId !== 'string' || !PROFILE_ID_RE.test(tuple.profileId)) errors.push('profileId: not a plain profile id')
  if (!isPlainObject(tuple.profile) || Object.keys(tuple.profile).sort().join(',') !== [...PROFILE_KEYS].sort().join(',')) errors.push('profile: not exactly the three gate switches')
  else for (const k of PROFILE_KEYS) if (typeof tuple.profile[k] !== 'boolean') errors.push(`profile.${k}: not a boolean`)
  for (const k of ['threadReply', 'browser', 'heartbeat']) if (typeof tuple[k] !== 'boolean') errors.push(`${k}: not a boolean`)
  if (typeof tuple.heartbeat === 'boolean' && tuple.heartbeat !== (agent === HEARTBEAT_AGENT_ID)) errors.push('heartbeat: does not follow the agent name')
  if (tuple.senderRolePolicySha256 !== null && !(typeof tuple.senderRolePolicySha256 === 'string' && SHA_RE.test(tuple.senderRolePolicySha256))) errors.push('senderRolePolicySha256: not a sha256 or null')
  if (typeof tuple.nodeBin !== 'string') errors.push('nodeBin: not a string')
  return errors
}

function senderRoleGateEnabled(gate) {
  if (!isPlainObject(gate)) return true
  if (Object.hasOwn(gate, 'allowTools')) return true
  const risky = gate.riskyTools
  if (risky === undefined) return false
  return !(Array.isArray(risky) && risky.length === 0)
}

/**
 * src/web/hooks/sub-inputs.ts senderRolePolicyOf on the text of the protected store/agent-sender-role-gates.json
 * (null = the file does not exist). Returns the policy argument the render carries, or null for no gate.
 */
export function senderRolePolicyFromGates(gatesText, agent) {
  if (gatesText === null) return null
  let gates
  try {
    gates = JSON.parse(gatesText)
  } catch {
    return UNREADABLE_GATES_POLICY
  }
  if (!isPlainObject(gates)) return UNREADABLE_GATES_POLICY
  if (!Object.hasOwn(gates, agent) || !senderRoleGateEnabled(gates[agent])) return null
  return Buffer.from(JSON.stringify(gates[agent]), 'utf-8').toString('base64url')
}

export function policySha256(policy) {
  return policy === null ? null : createHash('sha256').update(policy, 'utf8').digest('hex')
}

/**
 * N2-1: the node binary the tuple names, refused when it is not absolute and normalised, sits under the install's
 * agents/ or a tmp root, or when the file or any directory on its real path is group- or world-writable.
 */
export function nodeBinErrors(nodeBin, installDir, fs = { lstatSync, realpathSync }) {
  if (typeof nodeBin !== 'string' || !isAbsolute(nodeBin) || normalize(nodeBin) !== nodeBin || nodeBin.endsWith(sep)) return ['nodeBin: not an absolute normalised path']
  const bad = (p) => (TMP_ROOT_PREFIXES.some((t) => `${p}/`.startsWith(t)) ? 'under a tmp root'
    : typeof installDir === 'string' && `${p}/`.startsWith(`${normalize(installDir)}/agents/`) ? 'under the install\'s agents/' : null)
  const lexical = bad(nodeBin)
  if (lexical) return [`nodeBin: ${lexical}`]
  let real
  try {
    real = fs.realpathSync(nodeBin)
  } catch {
    return ['nodeBin: does not resolve']
  }
  const realBad = bad(real)
  if (realBad) return [`nodeBin: resolves ${realBad}`]
  const errors = []
  const parts = real.split(sep).filter(Boolean)
  for (let i = parts.length; i >= 0; i--) {
    const p = sep + parts.slice(0, i).join(sep)
    let st
    try {
      st = fs.lstatSync(p)
    } catch {
      errors.push('nodeBin: a directory on its path cannot be read')
      break
    }
    if ((st.mode & 0o022) !== 0) {
      errors.push(`nodeBin: ${i === parts.length ? 'the file' : 'a directory on its path'} is group- or world-writable`)
      break
    }
  }
  return errors
}
