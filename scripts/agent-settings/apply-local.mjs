#!/usr/bin/env node
// The agent-settings helper (Fork C settings-protect plan v2 point 6, plan addendum 1 K2/K3/K4, Ron 17402 K4).
// The only way, besides the owner's own terminal, that a sub-agent's .claude/settings.local.json and the protected
// store/agent-settings-baseline.json change: every write waits for an owner-approved agent_settings approval.
//
//   node /root/marveen/scripts/agent-settings/apply-local.mjs request --batch <id>
//   node /root/marveen/scripts/agent-settings/apply-local.mjs baseline --isolated <name[,name...]|none>
//   node /root/marveen/scripts/agent-settings/apply-local.mjs rebaseline --agent <name>
//   node /root/marveen/scripts/agent-settings/apply-local.mjs apply --approval <id>
//   node /root/marveen/scripts/agent-settings/apply-local.mjs resume
//   node /root/marveen/scripts/agent-settings/apply-local.mjs status
//
// request     store/agent-settings-staging/<id>.json (the main agent writes it): new FULL settings.local.json texts
//             for some agents plus the isolated list. Validated, then filed as one approval.
// baseline    the first baseline (the day the feature is switched on): today's file of every sub-agent, one approval.
// rebaseline  accept today's file and today's switch tuple of one agent (after a hand edit, a profile or capability
//             change, a node upgrade), one approval.
// apply       re-derives everything, checks the approval field by field, consumes it right before the first write,
//             writes the files (batch only) and then the baseline.
// resume      after an apply that stopped between the consume and the baseline: seals the baseline only when every
//             file on disk still gives the consumed approval's content_hash; no new approval.
// status      the state file and the end of the last log; read-only.
//
// The content is bound by content_hash = sha256(HASH_PREFIX, kind, isolated list, then per agent in name order:
// name \0 file text (or ABSENT) \0 canonical switch tuple \0). The owner text is re-rendered at apply and compared
// byte for byte (owner-approval.mjs), so what the owner read is what is written.
//
// The db-write gate lets exactly these six shapes through, and only from the main agent. That check is an accident
// and injection brake, not a boundary (docs/db-write-gate.md): the safety is the owner-bound approval.
import { appendFileSync, closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { renderBounded, sameDescription, approvalFailures, envValue, dashboardClient, pollOwnerNotified, consumeApproval, DESCRIPTION_CAP } from '../hooks/owner-approval.mjs'
import { validateSettings, canonicalJson } from '../hooks/settings-validator.mjs'
import { BASELINE_REL, BASELINE_FORMAT, AGENT_NAME_RX, TUPLE_KEYS, PROFILE_KEYS, parseBaseline, tupleErrors, nodeBinErrors, policySha256, localRecord, isolationObligations } from '../hooks/agent-settings-baseline.mjs'
import { loadLock, switchesFromBaseline, GATES_REL } from '../hooks/verify-gate-wiring.mjs'
import { expectedHooks } from '../hooks/sub-hooks-lock.mjs'
import { takeLock, CODE_DEPLOY_OWNER_CHANNEL_ONLY } from '../deploy/fork-deploy.mjs'

export const CATEGORY = 'agent_settings'
/** SEC-5: the deploy helper's switch, one value for both categories (approvals.ts pins it equal). */
export { CODE_DEPLOY_OWNER_CHANNEL_ONLY }
export const CONSUMER = 'agent-settings-apply'
/**
 * resume lists at most this many agent_settings approvals (the dashboard's own cap) to prove its consume is the newest.
 * Never above the cap in src/web/routes/approvals.ts and src/db.ts listApprovals (a test reads both): a longer list
 * cannot come back, so the "cannot be proven" stop would never fire (Ron N3).
 */
export const RESUME_LIST_LIMIT = 500
export const MAX_AGE_SECONDS = 1800
export const REQUEST_TIMEOUT_SECONDS = 3600
/** resume seals only a consume this recent (seconds); an older stop needs a rebaseline with a new approval. */
export const RESUME_MAX_AGE_SECONDS = 86400
export const HASH_PREFIX = 'marveen-agent-settings/v1\n'
export const BATCH_FORMAT = 'marveen-agent-settings-batch/v1'
export const STATE_FORMAT = 'marveen-agent-settings-state/v1'
export const STAGING_REL = 'store/agent-settings-staging'
export const LOGS_REL = 'store/agent-settings-logs'
export const STATE_REL = 'store/agent-settings-state.json'
export const LOCK_REL = 'store/agent-settings.lock'
export const LOG_PATH_RE = /^store\/agent-settings-logs\/request-\d{8}T\d{6}Z-[0-9a-f]{8}\.log$/
export const APPROVAL_ID_RE = /^[A-Za-z0-9-]{1,64}$/
export const BATCH_ID_RE = /^[A-Za-z0-9-]{1,64}$/
export const ISOLATED_ARG_RE = /^(?:none|[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:,[A-Za-z0-9][A-Za-z0-9._-]{0,63})*)$/
export const KINDS = Object.freeze(['batch', 'baseline', 'rebaseline'])
export const MAX_FILES = 64
export const MAX_CONTENT = 256 * 1024
const ABSENT = '\u0001absent'
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,49}$/

export const EXIT = Object.freeze({ OK: 0, STOP: 1, USAGE: 2, NOT_NOTIFIED: 3, STOP_AFTER_CONSUME: 4 })

const HERE = dirname(fileURLToPath(import.meta.url))
/** <install>/scripts/agent-settings -> <install>, lexically (the gate matches the literal path). */
export const INSTALL_ROOT = resolve(HERE, '..', '..')

export class Stop extends Error {
  constructor(message, { consumed = false } = {}) {
    super(message)
    this.consumed = consumed
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function paths(root) {
  return {
    staging: join(root, STAGING_REL),
    logs: join(root, LOGS_REL),
    state: join(root, STATE_REL),
    lock: join(root, LOCK_REL),
    baseline: join(root, BASELINE_REL),
  }
}

/**
 * Write `text` to `file` in `dir` without following a planted link (plan v2 6, V2-A1-REL-2): `dir` and its parent
 * must be real directories, the temp is <dir>/.settings-<16 random hex>.tmp opened O_CREAT|O_EXCL|O_NOFOLLOW, fsync,
 * then renamed onto the target (a rename replaces a link, it never writes through it; a target that IS a link stops
 * before, see targetFailures).
 */
export function writeAtomicNoFollow(dir, file, text, mode = 0o600, rand = () => randomBytes(8).toString('hex')) {
  for (const d of [dirname(dir), dir]) {
    const st = lstatSync(d)
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Stop(`${d} is not a real directory`)
  }
  const tmp = join(dir, `.settings-${rand()}.tmp`)
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600)
  try {
    writeSync(fd, text)
    fchmodSync(fd, mode)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, join(dir, file))
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** Why an agent's settings.local.json may not be written: a linked agent dir, .claude dir or target file. */
export function targetFailures(root, agent) {
  const out = []
  const agentDir = join(root, 'agents', agent)
  for (const [p, what] of [[agentDir, `agents/${agent}`], [join(agentDir, '.claude'), `agents/${agent}/.claude`]]) {
    try {
      const st = lstatSync(p)
      if (st.isSymbolicLink() || !st.isDirectory()) out.push(`${what} is not a real directory`)
    } catch {
      out.push(`${what} does not exist`)
    }
  }
  try {
    const st = lstatSync(join(agentDir, '.claude', 'settings.local.json'))
    if (st.isSymbolicLink() || !st.isFile()) out.push(`agents/${agent}/.claude/settings.local.json is not a regular file`)
  } catch (e) {
    if (e?.code !== 'ENOENT') out.push(`agents/${agent}/.claude/settings.local.json cannot be checked`)
  }
  return out
}

/** A small file read with no link followed at the last step; null when it does not exist. */
function readNoFollow(file, cap = MAX_CONTENT) {
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw new Stop(`${file} cannot be read without following a link (${e?.code ?? 'error'})`)
  }
  try {
    const buf = readFileSync(fd)
    if (buf.length > cap) throw new Stop(`${file} is ${buf.length} bytes, at most ${cap}`)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return text
  } catch (e) {
    if (e instanceof Stop) throw e
    throw new Stop(`${file} is not UTF-8 text`)
  } finally {
    closeSync(fd)
  }
}

/** The main agent id from <install>/.env, with no fallback (deploy-gate SEC-1). */
export function mainAgentId(root) {
  const main = envValue(root, 'MAIN_AGENT_ID')
  if (!main || !SLUG_RE.test(main)) throw new Stop(`MAIN_AGENT_ID in ${join(root, '.env')} is missing or not a slug`)
  return main
}

/** The sub-agents on disk: real directories under agents/ with a plain name, the main agent left out. */
export function subAgentsOnDisk(root, main) {
  let names
  try {
    names = readdirSync(join(root, 'agents'))
  } catch {
    return []
  }
  return names.filter((n) => {
    if (n === main || !AGENT_NAME_RX.test(n)) return false
    try {
      const st = lstatSync(join(root, 'agents', n))
      return st.isDirectory() && !st.isSymbolicLink()
    } catch {
      return false
    }
  }).sort(byName)
}

/**
 * The live switch tuple of one agent, from the dashboard's own readers in the install's compiled tree (the same
 * inputs the generator uses). The owner sees it in the text; the verifier later trusts only the baseline copy.
 */
export function defaultTupleOf(root) {
  let mod = null
  return async (agent) => {
    mod ??= await import(pathToFileURL(join(root, 'dist', 'web', 'hooks', 'sub-inputs.js')).href)
    const f = mod.subHookFlags(root, agent)
    const profile = {}
    for (const k of PROFILE_KEYS) profile[k] = f.profile?.[k] === true
    return {
      profileId: f.profileId,
      profile,
      threadReply: f.agent.threadReply === true,
      browser: f.agent.browser === true,
      heartbeat: f.agent.heartbeat === true,
      senderRolePolicySha256: policySha256(f.agent.senderRolePolicy ?? null),
      nodeBin: mod.resolveHookNodeBin(process.execPath),
    }
  }
}

/** Why a tuple cannot be baselined: its shape, its node binary, the gates file, and no lock combination (N2-4). */
export function tupleProblems(root, agent, tuple, { lockPath, fs } = {}) {
  const shape = tupleErrors(tuple, agent)
  if (shape.length) return shape
  const out = [...nodeBinErrors(tuple.nodeBin, root, fs)]
  let gatesText = null
  try {
    gatesText = readFileSync(join(root, GATES_REL), 'utf8')
  } catch (e) {
    if (e?.code !== 'ENOENT') gatesText = ''
  }
  const { sw, errors } = switchesFromBaseline(agent, { switches: tuple }, { installDir: root, gatesText, fs })
  out.push(...errors.filter((e) => !e.includes('nodeBin')).map((e) => e.replace(/^baseline: /, '')))
  if (sw !== null) {
    try {
      expectedHooks(loadLock(lockPath), sw)
    } catch (e) {
      out.push(`no lock combination: ${e?.message ?? e}`)
    }
  }
  return out
}

/** content_hash over what the baseline and the files will hold (see the header). */
export function contentHash(kind, isolated, entries) {
  let s = `${HASH_PREFIX}kind ${kind}\nisolated ${[...isolated].sort(byName).join(',')}\n`
  for (const e of [...entries].sort((a, b) => byName(a.agent, b.agent))) {
    s += `${e.agent}\0${e.content === null ? ABSENT : e.content}\0${canonicalJson(e.tuple)}\0`
  }
  return sha256(s)
}

function denyOf(obj) {
  const d = obj?.permissions?.deny
  return Array.isArray(d) ? d.filter((r) => typeof r === 'string') : []
}

function parseLocal(text) {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function readBaseline(root) {
  const text = readNoFollow(join(root, BASELINE_REL), 16 * 1024 * 1024)
  if (text === null) return null
  try {
    return parseBaseline(text)
  } catch (e) {
    throw new Stop(`${BASELINE_REL}: ${e?.message ?? e}`)
  }
}

function parseIsolatedArg(arg) {
  if (typeof arg !== 'string' || !ISOLATED_ARG_RE.test(arg)) throw new Stop('the isolated list is not "none" or a comma list of names')
  return arg === 'none' ? [] : [...new Set(arg.split(','))].sort(byName)
}

/** The staging batch: { format, isolated: [names], files: [{ agent, content }] }, every field checked. */
export function parseBatch(text) {
  let b
  try {
    b = JSON.parse(text)
  } catch {
    throw new Stop('the batch is not JSON')
  }
  if (!isPlainObject(b) || b.format !== BATCH_FORMAT) throw new Stop(`the batch format is not ${BATCH_FORMAT}`)
  if (!Array.isArray(b.isolated) || !b.isolated.every((n) => typeof n === 'string' && AGENT_NAME_RX.test(n))) throw new Stop('the batch has no valid isolated list')
  if (!Array.isArray(b.files) || b.files.length === 0 || b.files.length > MAX_FILES) throw new Stop(`the batch needs 1 to ${MAX_FILES} files`)
  const seen = new Set()
  for (const f of b.files) {
    if (!isPlainObject(f) || Object.keys(f).sort().join(',') !== 'agent,content') throw new Stop('a batch file is not exactly { agent, content }')
    if (typeof f.agent !== 'string' || !AGENT_NAME_RX.test(f.agent)) throw new Stop('a batch file names no plain agent')
    if (seen.has(f.agent)) throw new Stop(`the batch names ${f.agent} twice`)
    seen.add(f.agent)
    if (typeof f.content !== 'string' || f.content.length > MAX_CONTENT) throw new Stop(`${f.agent}: the content is not a string of at most ${MAX_CONTENT} characters`)
  }
  return { isolated: [...new Set(b.isolated)].sort(byName), files: b.files.map((f) => ({ agent: f.agent, content: f.content })) }
}

/**
 * Everything a request or an apply derives, from the spec alone: { kind, isolated, prevIsolated, entries, others,
 * violations, contentHash, newBaseline }. Throws a Stop listing every reason when the batch may not be filed.
 * spec: { kind: 'batch', batchId } | { kind: 'baseline', isolated: [names] } | { kind: 'rebaseline', agent }
 */
export async function collect(ctx, spec) {
  const root = ctx.root
  const main = mainAgentId(root)
  const current = readBaseline(root)
  if (spec.kind !== 'baseline' && current === null) throw new Stop(`no ${BASELINE_REL} yet: the first one comes from the baseline mode`)
  if (spec.kind === 'baseline' && current !== null) throw new Stop(`${BASELINE_REL} exists: change it with request or rebaseline`)
  let isolated
  let targets
  if (spec.kind === 'batch') {
    if (!BATCH_ID_RE.test(spec.batchId ?? '')) throw new Stop('the batch id is not plain')
    const text = readNoFollow(join(root, STAGING_REL, `${spec.batchId}.json`), MAX_FILES * MAX_CONTENT * 2)
    if (text === null) throw new Stop(`no ${STAGING_REL}/${spec.batchId}.json`)
    const b = parseBatch(text)
    isolated = b.isolated
    targets = b.files
  } else if (spec.kind === 'baseline') {
    isolated = [...spec.isolated].sort(byName)
    targets = subAgentsOnDisk(root, main).map((agent) => ({ agent, content: undefined }))
    if (targets.length === 0) throw new Stop('no sub-agent directory under agents/')
  } else if (spec.kind === 'rebaseline') {
    if (!AGENT_NAME_RX.test(spec.agent ?? '')) throw new Stop('the agent name is not plain')
    isolated = [...current.isolated].sort(byName)
    targets = [{ agent: spec.agent, content: undefined }]
  } else {
    throw new Stop(`unknown kind ${JSON.stringify(spec.kind)}`)
  }
  const problems = []
  const entries = []
  for (const t of targets) {
    if (t.agent === main) {
      problems.push(`${t.agent}: the main agent's file is not the helper's (plan addendum 1 K7)`)
      continue
    }
    problems.push(...targetFailures(root, t.agent))
    let content = t.content
    if (content === undefined) {
      try {
        content = readNoFollow(join(root, 'agents', t.agent, '.claude', 'settings.local.json'))
      } catch (e) {
        problems.push(`${t.agent}: ${e?.message ?? e}`)
        continue
      }
    }
    const obj = parseLocal(content)
    if (obj === undefined) problems.push(`${t.agent}: settings.local.json is not JSON`)
    else if (obj !== null) problems.push(...validateSettings('agent-local', obj, { installDir: root, agent: t.agent, realpath: ctx.realpath }).errors.map((e) => `${t.agent}: ${e}`))
    let tuple
    try {
      tuple = await ctx.tupleOf(t.agent)
    } catch (e) {
      problems.push(`${t.agent}: the switch tuple cannot be read (${e?.message ?? e})`)
      continue
    }
    problems.push(...tupleProblems(root, t.agent, tuple, ctx.tupleCheck ?? {}).map((e) => `${t.agent}: switches: ${e}`))
    const prevEntry = current && Object.hasOwn(current.agents, t.agent) ? current.agents[t.agent] : null
    entries.push({ agent: t.agent, content, obj: obj ?? null, tuple, prev: prevEntry })
  }
  if (problems.length) throw new Stop(`refused, no approval filed:\n  ${problems.join('\n  ')}`)
  entries.sort((a, b) => byName(a.agent, b.agent))
  // The set the isolation invariant runs over: the baseline's agents (their recorded rows, which cannot change
  // between request and apply) plus the targets (their new rows).
  const rowsOf = new Map()
  const others = []
  if (current && spec.kind !== 'baseline') {
    for (const [agent, e] of Object.entries(current.agents)) {
      if (entries.some((x) => x.agent === agent)) continue
      rowsOf.set(agent, Array.isArray(e?.local?.denyRows) ? e.local.denyRows : [])
      others.push(agent)
    }
  }
  for (const e of entries) rowsOf.set(e.agent, denyOf(e.obj))
  const set = { installDir: root, home: ctx.home, agents: [...rowsOf.keys()], isolated }
  const violations = []
  for (const [agent, rows] of [...rowsOf.entries()].sort((a, b) => byName(a[0], b[0]))) {
    const have = new Set(rows)
    for (const o of isolationObligations(agent, set)) if (!have.has(o.row)) violations.push({ agent, row: o.row, isolated: o.isolated })
  }
  const newBaseline = {
    format: BASELINE_FORMAT,
    isolated,
    agents: spec.kind === 'baseline' ? {} : { ...current.agents },
  }
  for (const e of entries) newBaseline.agents[e.agent] = { switches: e.tuple, local: localRecord(e.content) }
  return {
    root,
    kind: spec.kind,
    isolated,
    prevIsolated: current ? [...current.isolated].sort(byName) : null,
    entries,
    others: others.sort(byName),
    violations,
    contentHash: contentHash(spec.kind, isolated, entries),
    newBaseline,
  }
}

const KIND_LABEL = { batch: 'új fájlok (request)', baseline: 'első baseline', rebaseline: 'a mai fájl elfogadása (rebaseline)' }
const yesNo = (b) => (b ? 'igen' : 'nem')

function prevRowsOf(e) {
  if (Array.isArray(e.prev?.local?.denyRows)) return e.prev.local.denyRows
  return null
}

function tupleChanges(prev, next) {
  if (!isPlainObject(prev)) return []
  const out = []
  for (const k of TUPLE_KEYS) {
    if (k === 'profile') {
      for (const p of PROFILE_KEYS) if (prev.profile?.[p] !== next.profile?.[p]) out.push(`${p} ${prev.profile?.[p]} -> ${next.profile?.[p]}`)
    } else if (prev[k] !== next[k]) {
      const show = (v) => (k === 'senderRolePolicySha256' && typeof v === 'string' ? v.slice(0, 12) : String(v))
      out.push(`${k} ${show(prev[k])} -> ${show(next[k])}`)
    }
  }
  return out
}

function tupleRow(t) {
  return `profil ${t.profileId}, destructive ${yesNo(t.profile.destructiveGate)}, credential ${yesNo(t.profile.credentialGate)}, reviewer ${yesNo(t.profile.secondReviewer)}, thread-reply ${yesNo(t.threadReply)}, browser ${yesNo(t.browser)}, sender-role ${t.senderRolePolicySha256 ? t.senderRolePolicySha256.slice(0, 12) : 'nincs'}, node ${t.nodeBin}`
}

function envRow(obj) {
  const env = isPlainObject(obj?.env) ? obj.env : {}
  const names = Object.keys(env).sort(byName)
  return names.length ? names.map((n) => `${n}=${env[n]}`).join(', ') : 'nincs'
}

/**
 * The env of one entry for the owner text (plan v2 point 6: the full semantic content, values verbatim). Only
 * GH_CONFIG_DIR passes the validator, a path inside the agent's own folder. The usual value, exactly
 * <install>/agents/<n>/.config/gh, is named short in the cuttable summary row; ANY other value goes verbatim into a
 * never-cut ENV line of the head, so a row cut can never hide it. Returns { short, head: [lines] }.
 */
function envForOwner(root, agent, obj) {
  const env = isPlainObject(obj?.env) ? obj.env : {}
  const usual = join(root, 'agents', agent, '.config', 'gh')
  const short = []
  const head = []
  for (const n of Object.keys(env).sort(byName)) {
    if (n === 'GH_CONFIG_DIR' && env[n] === usual) short.push(`${n}=<saját .config/gh>`)
    else {
      short.push(`${n}=<lásd ENV>`)
      head.push(`ENV: ${agent}: ${n}=${env[n]}`)
    }
  }
  return { short: short.length ? short.join(', ') : 'nincs', head }
}

/** The full, uncut record of the request: the request log's text, its sha256 is in the owner text's head. */
export function fullRender(c) {
  const lines = [
    'agent_settings request',
    `kind ${c.kind}`,
    `content_hash ${c.contentHash}`,
    `isolated ${c.isolated.join(',') || '-'}`,
    `previous isolated ${c.prevIsolated === null ? '(no baseline)' : c.prevIsolated.join(',') || '-'}`,
    `unchanged baseline agents ${c.others.join(',') || '-'}`,
  ]
  for (const e of c.entries) {
    const prev = prevRowsOf(e)
    const now = denyOf(e.obj)
    lines.push(`== ${e.agent} ==`)
    lines.push(`baseline entry ${e.prev ? 'exists' : 'new'}`)
    lines.push(`switches ${canonicalJson(e.tuple)}`)
    if (e.prev) lines.push(`previous switches ${canonicalJson(e.prev.switches ?? null)}`)
    lines.push(e.content === null ? 'file absent' : `file sha256 ${sha256(e.content)}`)
    lines.push(`keys ${e.obj ? Object.keys(e.obj).sort(byName).join(',') || '-' : '-'}`)
    lines.push(`env ${envRow(e.obj)}`)
    if (prev !== null) {
      for (const r of prev) if (!now.includes(r)) lines.push(`deny removed ${r}`)
      for (const r of now) if (!prev.includes(r)) lines.push(`deny added ${r}`)
    } else {
      for (const r of now) lines.push(`deny ${r}`)
    }
    lines.push(`deny total ${now.length}`)
  }
  lines.push('== isolation ==')
  if (c.violations.length === 0) lines.push('ok')
  for (const v of c.violations) lines.push(`missing ${v.agent} ${v.row} (isolation of ${v.isolated})`)
  return lines.join('\n') + '\n'
}

/**
 * The owner text (plan v2 point 6, V2-A1-REL-1), at most DESCRIPTION_CAP characters. Never cut: the header, the
 * content_hash, the isolated list, the request log and its sha256, every SÉRÜL (isolation) line, every ELTÁVOLÍTVA
 * (removed deny row) line, every switch change of an existing entry, every env value but the usual one. Throws a
 * Stop when that alone is too long.
 */
export function ownerDescription(c, logPath) {
  if (!LOG_PATH_RE.test(logPath)) throw new Stop(`request log path ${JSON.stringify(logPath)} is not ${LOGS_REL}/request-<UTC>-<hex>.log`)
  const head = [
    `Ágens-beállítás (agent_settings): ${KIND_LABEL[c.kind]}, ${c.entries.length} ágens`,
    `content_hash ${c.contentHash}`,
    `Elkülönített ágensek: ${c.isolated.join(', ') || 'nincs'}${c.prevIsolated !== null && c.prevIsolated.join(',') !== c.isolated.join(',') ? ` (VÁLTOZIK, eddig: ${c.prevIsolated.join(', ') || 'nincs'})` : ''}`,
    `Teljes lista: ${logPath} sha256 ${sha256(fullRender(c))}`,
  ]
  const groups = new Map()
  for (const v of c.violations) {
    const k = `${v.agent}\0${v.isolated}`
    groups.set(k, (groups.get(k) ?? 0) + 1)
  }
  for (const [k, n] of groups) {
    const [agent, iso] = k.split('\0')
    head.push(`SÉRÜL: ${agent}: ${n} deny-sor hiányzik (${iso} elkülönítése)`)
  }
  const added = []
  const summary = []
  const fresh = []
  for (const e of c.entries) {
    const prev = prevRowsOf(e)
    const now = denyOf(e.obj)
    let plus = 0
    let minus = 0
    if (prev !== null) {
      for (const r of prev) if (!now.includes(r)) {
        head.push(`ELTÁVOLÍTVA: ${e.agent}: ${r}`)
        minus++
      }
      for (const r of now) if (!prev.includes(r)) {
        added.push(`${e.agent}: ${r}`)
        plus++
      }
    } else if (c.kind !== 'baseline') {
      for (const r of now) added.push(`${e.agent}: ${r}`)
      plus = now.length
    }
    for (const ch of tupleChanges(e.prev?.switches, e.tuple)) head.push(`KAPCSOLÓ: ${e.agent}: ${ch}`)
    if (!e.prev) fresh.push(`${e.agent}: ${tupleRow(e.tuple)}`)
    const env = envForOwner(c.root, e.agent, e.obj)
    head.push(...env.head)
    const keys = e.obj ? Object.keys(e.obj).sort(byName).join(', ') || 'nincs' : 'nincs fájl'
    summary.push(`${e.agent}${e.prev ? '' : ' (új)'}: env: ${env.short}; ${c.kind === 'baseline' ? `${now.length} deny` : `+${plus} / -${minus} deny, összesen ${now.length}`}; kulcsok: ${keys}`)
  }
  try {
    return renderBounded({
      head,
      sections: [
        { title: 'Ágensenként:', rows: summary, max: 40, more: (n) => `... és még ${n} ágens (teljes lista: ${logPath})` },
        { title: 'Új baseline-bejegyzések kapcsolói:', rows: fresh, max: 40, more: (n) => `... és még ${n} (teljes lista: ${logPath})` },
        { title: 'Hozzáadott deny-sorok:', rows: added, max: 40, more: (n) => `... és még ${n} sor (teljes lista: ${logPath})` },
      ],
      cap: DESCRIPTION_CAP,
    })
  } catch (e) {
    throw new Stop(`the owner text does not fit ${DESCRIPTION_CAP} characters without cutting a SÉRÜL / ELTÁVOLÍTVA / KAPCSOLÓ line: split the change into smaller batches (${e?.message ?? e})`)
  }
}

/** The approval's machine payload, as request filed it; every field checked. */
export function parsePayload(text) {
  let p
  try {
    p = JSON.parse(text)
  } catch {
    throw new Stop('the approval has no valid JSON payload')
  }
  if (!isPlainObject(p) || !KINDS.includes(p.kind)) throw new Stop('the approval payload names no known kind')
  if (!LOG_PATH_RE.test(p.logPath ?? '')) throw new Stop('the payload request log path is not store/agent-settings-logs/request-<UTC>-<hex>.log')
  if (p.kind === 'batch' && !BATCH_ID_RE.test(p.batchId ?? '')) throw new Stop('the payload batch id is not plain')
  if (p.kind === 'rebaseline' && !AGENT_NAME_RX.test(p.agent ?? '')) throw new Stop('the payload agent is not plain')
  if (p.kind === 'baseline' && !(Array.isArray(p.isolated) && p.isolated.every((n) => typeof n === 'string' && AGENT_NAME_RX.test(n)))) throw new Stop('the payload isolated list is not plain')
  return p
}

function specOf(p) {
  if (p.kind === 'batch') return { kind: 'batch', batchId: p.batchId }
  if (p.kind === 'rebaseline') return { kind: 'rebaseline', agent: p.agent }
  return { kind: 'baseline', isolated: p.isolated }
}

/** Everything the modes touch outside their own logic; tests replace any of it. */
export function defaultContext(root = INSTALL_ROOT) {
  return {
    root,
    home: homedir(),
    client: dashboardClient(root),
    tupleOf: defaultTupleOf(root),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    out: (line) => process.stdout.write(line + '\n'),
    ignoreHangup: () => process.on('SIGHUP', () => {}),
    lockOpts: {},
    pollOpts: {},
  }
}

function writeStoreFile(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.agent-settings-${randomBytes(8).toString('hex')}.tmp`)
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** request / baseline / rebaseline: validate, write the request log, file the approval; exit 3 when not notified. */
export async function request(ctx, spec) {
  try {
    const main = mainAgentId(ctx.root)
    const c = await collect(ctx, spec)
    const logRel = `${LOGS_REL}/request-${utcStamp(ctx.now())}-${randomBytes(4).toString('hex')}.log`
    const description = ownerDescription(c, logRel)
    writeStoreFile(join(ctx.root, logRel), fullRender(c))
    const payload = { kind: c.kind, logPath: logRel }
    if (c.kind === 'batch') payload.batchId = spec.batchId
    if (c.kind === 'rebaseline') payload.agent = spec.agent
    if (c.kind === 'baseline') payload.isolated = c.isolated
    const posted = await ctx.client.post('/api/approvals', {
      agent_id: main,
      category: CATEGORY,
      action_description: description,
      action_payload: JSON.stringify(payload),
      content_hash: c.contentHash,
      timeout_seconds: REQUEST_TIMEOUT_SECONDS,
    })
    if (posted.status !== 201 || !posted.data?.id) throw new Stop(`POST /api/approvals answered HTTP ${posted.status}`)
    const n = await pollOwnerNotified(ctx.client, posted.data.id, envValue(ctx.root, 'CHANNEL_PROVIDER') ?? '', { sleep: ctx.sleep, ...ctx.pollOpts })
    ctx.out(`approval: ${posted.data.id}`)
    ctx.out(`kind: ${c.kind}, agents: ${c.entries.map((e) => e.agent).join(', ')}`)
    ctx.out(`content_hash: ${c.contentHash}`)
    ctx.out(`isolation: ${c.violations.length === 0 ? 'ok' : `${c.violations.length} missing deny row(s), see the request log`}`)
    ctx.out(`description: ${description.length}/${DESCRIPTION_CAP} chars`)
    ctx.out(`request log: ${logRel}`)
    ctx.out(`owner notified: ${n.notified} (${n.why})`)
    ctx.out(`after the owner approves: node ${join(INSTALL_ROOT, 'scripts', 'agent-settings', 'apply-local.mjs')} apply --approval ${posted.data.id}`)
    return n.notified === 'yes' ? EXIT.OK : EXIT.NOT_NOTIFIED
  } catch (e) {
    ctx.out(`STOP: ${e?.message ?? e}`)
    return EXIT.STOP
  }
}

function logger(ctx, prefix) {
  const P = paths(ctx.root)
  const logPath = join(P.logs, `${prefix}-${utcStamp(ctx.now())}-${randomBytes(4).toString('hex')}.log`)
  mkdirSync(P.logs, { recursive: true })
  const say = (line) => {
    ctx.out(line)
    try {
      appendFileSync(logPath, `${new Date(ctx.now()).toISOString()} ${line}\n`)
    } catch { /* the console still has it */ }
  }
  return { say, logPath }
}

/** apply: returns an EXIT code; every line it prints also goes to store/agent-settings-logs/apply-<UTC>.log. */
export async function apply(ctx, { approvalId }) {
  if (!APPROVAL_ID_RE.test(approvalId ?? '')) {
    ctx.out('usage: apply-local.mjs apply --approval <id>')
    return EXIT.USAGE
  }
  const P = paths(ctx.root)
  const { say, logPath } = logger(ctx, 'apply')
  let state = { format: STATE_FORMAT, approvalId, step: 'start', logPath }
  const setState = (step, extra = {}) => {
    state = { ...state, ...extra, step, ts: ctx.now() }
    writeStoreFile(P.state, JSON.stringify(state, null, 2) + '\n')
    say(`step: ${step}`)
  }
  let mine
  try {
    mine = takeLock(P.lock, { ...ctx.lockOpts, log: say })
  } catch (e) {
    say(`STOP: ${e.message}`)
    return EXIT.STOP
  }
  let consumed = false
  try {
    // 1-3. The row, the payload, everything re-derived from the batch bytes and the disk; identity is MAIN.
    const main = mainAgentId(ctx.root)
    const got = await ctx.client.get(`/api/approvals/${encodeURIComponent(approvalId)}`)
    if (got.status !== 200 || !got.data) throw new Stop(`the dashboard did not return approval ${approvalId} (HTTP ${got.status})`)
    const row = got.data
    const p = parsePayload(row.action_payload)
    const c = await collect(ctx, specOf(p))
    const rendered = ownerDescription(c, p.logPath)
    if (!sameDescription(row.action_description, rendered)) throw new Stop('the approved text differs from the text re-rendered from the batch and the disk')
    const fails = approvalFailures(row, { category: CATEGORY, mainAgentId: main, contentHash: c.contentHash, requireOwnerChannel: ctx.ownerChannelOnly ?? CODE_DEPLOY_OWNER_CHANNEL_ONLY })
    if (fails.length) throw new Stop(fails.join('; '))
    say(`resolved_by: ${row.resolved_by}`)
    for (const e of c.entries) {
      const tf = targetFailures(ctx.root, e.agent)
      if (tf.length) throw new Stop(tf.join('; '))
    }
    // 4. The state file holds the hashes the disk must show afterwards, BEFORE the first write (V2-A1-REL-2).
    const files = {}
    for (const e of c.entries) files[e.agent] = e.content === null ? null : sha256(e.content)
    setState('consuming', { kind: c.kind, contentHash: c.contentHash, spec: specOf(p), files })
    // 5. The one-shot consume, right before the first write.
    const cons = await consumeApproval(ctx.client, approvalId, { category: CATEGORY, contentHash: c.contentHash, consumer: CONSUMER, ref: c.contentHash, maxAgeSeconds: MAX_AGE_SECONDS })
    if (cons.status !== 200) throw new Stop(`consume answered HTTP ${cons.status}: nothing was written`)
    consumed = true
    ctx.ignoreHangup()
    // 6. The files (batch only), from the bytes already hashed, never re-read.
    if (c.kind === 'batch') {
      setState('writing')
      for (const e of c.entries) {
        const dir = join(ctx.root, 'agents', e.agent, '.claude')
        const tf = targetFailures(ctx.root, e.agent)
        if (tf.length) throw new Stop(`${tf.join('; ')}; the baseline is unchanged, so the agents of this batch do not start until resume or rebaseline`, { consumed })
        let mode = 0o600
        try {
          mode = lstatSync(join(dir, 'settings.local.json')).mode & 0o777
        } catch { /* a new file */ }
        writeAtomicNoFollow(dir, 'settings.local.json', e.content, mode)
        say(`wrote agents/${e.agent}/.claude/settings.local.json sha256 ${files[e.agent]}`)
      }
    }
    // 7. The baseline, last.
    setState('baseline')
    writeStoreFile(P.baseline, JSON.stringify(c.newBaseline, null, 2) + '\n')
    setState('done')
    say(`applied ${c.kind}: ${c.entries.length} agent(s), isolation ${c.violations.length === 0 ? 'ok' : `${c.violations.length} missing row(s)`}`)
    return EXIT.OK
  } catch (e) {
    const wasConsumed = consumed || e?.consumed
    say(`STOP${wasConsumed ? ' (approval consumed)' : ' (approval NOT consumed)'}: ${e?.message ?? e}`)
    try {
      setState(wasConsumed ? 'stopped-after-consume' : 'stopped', { error: String(e?.message ?? e) })
    } catch { /* the log has it */ }
    if (wasConsumed) say(`next: node ${join(INSTALL_ROOT, 'scripts', 'agent-settings', 'apply-local.mjs')} resume`)
    return wasConsumed ? EXIT.STOP_AFTER_CONSUME : EXIT.STOP
  } finally {
    try {
      if (readFileSync(P.lock, 'utf8') === mine) rmSync(P.lock, { force: true })
    } catch { /* already gone */ }
  }
}

/**
 * resume: after a stop between the consume and the baseline. The state file is not protected, so nothing in it is
 * trusted: the consumed approval is read back from the dashboard (and must be this helper's newest consume), the
 * batch and the disk are re-derived, and the baseline is sealed only when they give the approval's content_hash AND
 * every target file on disk is byte-equal to the approved content. Anything else: rebaseline, with a new approval.
 */
export async function resume(ctx) {
  const P = paths(ctx.root)
  const { say } = logger(ctx, 'resume')
  let state
  try {
    state = JSON.parse(readFileSync(P.state, 'utf8'))
  } catch {
    say('no agent-settings state: nothing to resume')
    return EXIT.STOP
  }
  if (!isPlainObject(state) || state.format !== STATE_FORMAT || !APPROVAL_ID_RE.test(state.approvalId ?? '')) {
    say('the state file is not one this helper wrote: nothing to resume')
    return EXIT.STOP
  }
  if (state.step === 'done') {
    say(`approval ${state.approvalId} is already applied: nothing to resume`)
    return EXIT.OK
  }
  let mine
  try {
    mine = takeLock(P.lock, { ...ctx.lockOpts, log: say })
  } catch (e) {
    say(`STOP: ${e.message}`)
    return EXIT.STOP
  }
  try {
    const main = mainAgentId(ctx.root)
    const got = await ctx.client.get(`/api/approvals/${encodeURIComponent(state.approvalId)}`)
    if (got.status !== 200 || !got.data) throw new Stop(`the dashboard did not return approval ${state.approvalId} (HTTP ${got.status})`)
    const row = got.data
    if (row.consumed_at == null) throw new Stop('the approval is not consumed: run apply, not resume')
    // Only this helper's own consume, recently: an old consumed approval is no way back to an old baseline.
    if (row.consumed_by !== CONSUMER) throw new Stop(`the approval was consumed by ${JSON.stringify(row.consumed_by)}, not by this helper`)
    if (!Number.isFinite(row.consumed_at) || Math.floor(ctx.now() / 1000) - row.consumed_at > RESUME_MAX_AGE_SECONDS) throw new Stop(`the consume is older than ${RESUME_MAX_AGE_SECONDS} s: rebaseline needed`)
    // ...and this helper's NEWEST consume: the state file is not protected, so an older approval it names (still within
    // the window) must not re-seal an older baseline over a newer one (Ron 17563, suggestion 7).
    const listed = await ctx.client.get(`/api/approvals?category=${encodeURIComponent(CATEGORY)}&limit=${RESUME_LIST_LIMIT}`)
    if (listed.status !== 200 || !Array.isArray(listed.data)) throw new Stop(`the dashboard did not list the ${CATEGORY} approvals (HTTP ${listed.status})`)
    if (listed.data.length >= RESUME_LIST_LIMIT) throw new Stop(`${RESUME_LIST_LIMIT} or more ${CATEGORY} approvals: the newest consume cannot be proven, rebaseline needed`)
    const newer = listed.data.filter((r) => isPlainObject(r) && r.id !== row.id && r.consumed_by === CONSUMER && Number.isFinite(r.consumed_at) && r.consumed_at >= row.consumed_at)
    if (newer.length > 0) throw new Stop('this helper consumed a newer (or equally new) approval since: rebaseline needed')
    const p = parsePayload(row.action_payload)
    const c = await collect(ctx, specOf(p))
    const fails = approvalFailures(row, { category: CATEGORY, mainAgentId: main, contentHash: c.contentHash, requireOwnerChannel: ctx.ownerChannelOnly ?? CODE_DEPLOY_OWNER_CHANNEL_ONLY })
      .filter((f) => f !== 'already consumed')
    if (fails.length) throw new Stop(`${fails.join('; ')}: rebaseline needed`)
    if (row.consumed_ref !== c.contentHash) throw new Stop('the consume ref is not this content_hash: rebaseline needed')
    for (const e of c.entries) {
      const now = readNoFollow(join(ctx.root, 'agents', e.agent, '.claude', 'settings.local.json'))
      if (now !== e.content) throw new Stop(`agents/${e.agent}/.claude/settings.local.json is not the approved content: rebaseline needed`)
    }
    writeStoreFile(P.baseline, JSON.stringify(c.newBaseline, null, 2) + '\n')
    writeStoreFile(P.state, JSON.stringify({ ...state, step: 'done', resumedAt: ctx.now() }, null, 2) + '\n')
    say(`resumed ${state.approvalId}: baseline sealed for ${c.entries.map((e) => e.agent).join(', ')}`)
    return EXIT.OK
  } catch (e) {
    say(`STOP: ${e?.message ?? e}`)
    return EXIT.STOP
  } finally {
    try {
      if (readFileSync(P.lock, 'utf8') === mine) rmSync(P.lock, { force: true })
    } catch { /* already gone */ }
  }
}

/** status: the state file and the last lines of its log. Read-only. */
export function status(ctx) {
  const P = paths(ctx.root)
  let s
  try {
    s = JSON.parse(readFileSync(P.state, 'utf8'))
  } catch {
    ctx.out('no agent-settings state')
    return EXIT.OK
  }
  ctx.out(JSON.stringify(s, null, 2))
  if (typeof s.logPath === 'string' && s.logPath.startsWith(P.logs + '/')) {
    try {
      ctx.out(readFileSync(s.logPath, 'utf8').trimEnd().split('\n').slice(-20).join('\n'))
    } catch { /* no log */ }
  }
  return EXIT.OK
}

/** argv -> mode; exactly the six shapes the gate allows, nothing else. */
export function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === 'resume' || argv[0] === 'status')) return { mode: argv[0] }
  if (argv.length !== 3) return null
  const [m, flag, v] = argv
  if (m === 'request' && flag === '--batch' && BATCH_ID_RE.test(v)) return { mode: 'request', spec: { kind: 'batch', batchId: v } }
  if (m === 'baseline' && flag === '--isolated' && ISOLATED_ARG_RE.test(v)) return { mode: 'request', spec: { kind: 'baseline', isolated: parseIsolatedArg(v) } }
  if (m === 'rebaseline' && flag === '--agent' && AGENT_NAME_RX.test(v)) return { mode: 'request', spec: { kind: 'rebaseline', agent: v } }
  if (m === 'apply' && flag === '--approval' && APPROVAL_ID_RE.test(v)) return { mode: 'apply', approvalId: v }
  return null
}

export const USAGE = 'usage: apply-local.mjs request --batch <id> | baseline --isolated <names|none> | rebaseline --agent <name> | apply --approval <id> | resume | status'

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const ctx = defaultContext()
  if (!args) {
    ctx.out(USAGE)
    process.exit(EXIT.USAGE)
  }
  const code = args.mode === 'apply' ? await apply(ctx, args)
    : args.mode === 'request' ? await request(ctx, args.spec)
    : args.mode === 'resume' ? await resume(ctx)
    : status(ctx)
  process.exit(code)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
