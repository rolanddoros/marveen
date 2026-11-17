// The sub-agent hook lock (Fork C settings-protect addendum 1 D2-SEC-1 (b), Ron 17402 K1): the hook manifest's sub
// render, committed under the protected scripts/hooks/, so the standalone verifier knows the expected hooks WITHOUT
// importing src/ or dist/ (a changed src/dist manifest then shows up as a mismatch against this protected file).
//
// scripts/hooks/sub-hooks.lock.json is written only by `npm run hooks:lock` (scripts/generate-sub-hooks-lock.ts) in a
// worktree, and a test pins it to the manifest render, so it changes only through a reviewed PR. Its shape:
//   format     LOCK_FORMAT
//   layout     [[event, [slot, ...]], ...] in written order; a slot is the list of entry ids rendered as one group
//   entries    { id: { profileFlag?, agentFlag?, matchers: [string|null, ...], hook, hookThreadReply? } }
//   sha256     the sha256 of canonical JSON of everything above; parseLock refuses a lock whose content differs
// Strings carry the placeholders below unexpanded (the written settings.json has them expanded).
//
// expectedHooks() assembles the block exactly as src/web/hooks/manifest.ts renderHooks does for scope 'sub': the
// slots of each event in order, a slot's ids filtered by their switches, the matchers of the FIRST active id, one
// group per matcher, the threadReply variant of an entry when the agent has that capability. A test checks this
// against renderHooks for every switch combination.
import { createHash } from 'node:crypto'

export const LOCK_FORMAT = 'marveen-sub-hooks-lock/v1'
export const PLACEHOLDERS = Object.freeze({
  root: '${ROOT}',
  nodeBin: '${NODE_BIN}',
  senderRolePolicy: '${SENDER_ROLE_POLICY}',
  precompact: '${PRECOMPACT_PROMPT}',
})
export const PROFILE_FLAGS = Object.freeze(['destructiveGate', 'credentialGate', 'secondReviewer'])
export const AGENT_FLAGS = Object.freeze(['heartbeat', 'senderRolePolicy', 'browser'])

// The manifest's own path rule for a sub root / node binary inside double quotes (manifest.ts DQ_SAFE_ABS_PATH_RE):
// no quote, $, backtick or control character, so an expansion can never form another placeholder or break quoting.
const DQ_SAFE_ABS_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])[^"$`\x00-\x1f\x7f]*[^"$`\x00-\x1f\x7f\\/]$/
const POLICY_RE = /^[A-Za-z0-9_=.:-]+$/

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (isPlainObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

/** The sha256 a lock body (without its sha256 key) must carry. */
export function lockSha256(body) {
  const { sha256: _ignored, ...rest } = body
  return createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex')
}

/** Parse and check a lock text; throws with a reason (no content) when the shape or the sha256 is wrong. */
export function parseLock(text) {
  let lock
  try {
    lock = JSON.parse(text)
  } catch {
    throw new Error('sub-hooks lock: not JSON')
  }
  if (!isPlainObject(lock) || lock.format !== LOCK_FORMAT) throw new Error('sub-hooks lock: unknown format')
  if (typeof lock.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(lock.sha256)) throw new Error('sub-hooks lock: no sha256')
  if (lockSha256(lock) !== lock.sha256) throw new Error('sub-hooks lock: sha256 does not match its content')
  if (!Array.isArray(lock.layout) || !isPlainObject(lock.entries)) throw new Error('sub-hooks lock: no layout or entries')
  for (const row of lock.layout) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !Array.isArray(row[1])) throw new Error('sub-hooks lock: a malformed layout row')
    for (const slot of row[1]) {
      if (!Array.isArray(slot) || slot.length === 0 || !slot.every((id) => typeof id === 'string' && isPlainObject(lock.entries[id]))) {
        throw new Error('sub-hooks lock: a slot names an unknown entry')
      }
    }
  }
  for (const [id, e] of Object.entries(lock.entries)) {
    if (!Array.isArray(e.matchers) || e.matchers.length === 0 || !isPlainObject(e.hook)) throw new Error(`sub-hooks lock: entry ${id} is malformed`)
    if (e.profileFlag !== undefined && !PROFILE_FLAGS.includes(e.profileFlag)) throw new Error(`sub-hooks lock: entry ${id} has an unknown profile flag`)
    if (e.agentFlag !== undefined && !AGENT_FLAGS.includes(e.agentFlag)) throw new Error(`sub-hooks lock: entry ${id} has an unknown agent flag`)
  }
  return lock
}

function active(e, sw) {
  if (e.profileFlag && sw.profile?.[e.profileFlag] !== true) return false
  if (e.agentFlag === 'heartbeat' && sw.heartbeat !== true) return false
  if (e.agentFlag === 'senderRolePolicy' && !sw.senderRolePolicy) return false
  if (e.agentFlag === 'browser' && sw.browser !== true) return false
  return true
}

function expand(v, map) {
  if (typeof v === 'string') return map.reduce((s, [from, to]) => s.replaceAll(from, to), v)
  if (Array.isArray(v)) return v.map((x) => expand(x, map))
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x, map)]))
  return v
}

/**
 * The hooks block a sub-agent's settings.json must carry, from a parsed lock.
 * `sw`: { root, nodeBin, profile: { destructiveGate, credentialGate, secondReviewer }, heartbeat, threadReply,
 *         browser, senderRolePolicy (string or null), precompact (the agent prompt text), skip (Set of ids) }.
 * Throws when root, node binary or policy could not be placed safely.
 */
export function expectedHooks(lock, sw) {
  if (typeof sw.root !== 'string' || !DQ_SAFE_ABS_PATH_RE.test(sw.root)) throw new Error('sub-hooks lock: the root is not a safe absolute path')
  if (typeof sw.nodeBin !== 'string' || !DQ_SAFE_ABS_PATH_RE.test(sw.nodeBin)) throw new Error('sub-hooks lock: the node binary is not a safe absolute path')
  if (sw.senderRolePolicy && !POLICY_RE.test(sw.senderRolePolicy)) throw new Error('sub-hooks lock: the sender-role policy needs quoting')
  const map = [
    [PLACEHOLDERS.root, sw.root],
    [PLACEHOLDERS.nodeBin, sw.nodeBin],
    [PLACEHOLDERS.senderRolePolicy, sw.senderRolePolicy || ''],
    [PLACEHOLDERS.precompact, typeof sw.precompact === 'string' ? sw.precompact : ''],
  ]
  const out = {}
  for (const [event, slots] of lock.layout) {
    const groups = []
    for (const slot of slots) {
      const ids = slot.filter((id) => active(lock.entries[id], sw) && !sw.skip?.has(id))
      if (ids.length === 0) continue
      for (const matcher of lock.entries[ids[0]].matchers) {
        const hooks = ids.map((id) => {
          const e = lock.entries[id]
          return expand(sw.threadReply && e.hookThreadReply ? e.hookThreadReply : e.hook, map)
        })
        groups.push(matcher === null ? { hooks } : { matcher, hooks })
      }
    }
    if (groups.length > 0) out[event] = groups
  }
  return out
}
