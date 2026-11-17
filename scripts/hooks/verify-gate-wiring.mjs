// The standalone gate-wiring verifier (Fork C settings-protect plan v2 point 3, addendum 1 D2-SEC-1 / D2-REL-2,
// Ron 17402 K1): before a sub-agent starts, its settings files must carry exactly the hooks the protected lock
// expects and pass the one validator. It imports neither src/ nor dist/: the expected hooks come from
// scripts/hooks/sub-hooks.lock.json alone (its own sha256 checked first), so a changed src/dist manifest shows up as
// a mismatch against a protected file instead of being trusted.
//
// The switches that select the lock's combination come from the protected baseline ONLY (Ron 17451 N1 direction):
// never from agent-config.json, personas/, templates/profiles/ or the dashboard, which can all change.
//
// A text brake's companion, NOT an OS boundary (docs/db-write-gate.md).
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseLock, expectedHooks, canonicalJson } from './sub-hooks-lock.mjs'
import { validateSettings } from './settings-validator.mjs'
import { BASELINE_REL, parseBaseline, tupleErrors, nodeBinErrors, senderRolePolicyFromGates, policySha256 } from './agent-settings-baseline.mjs'

export const LOCK_PATH = join(dirname(fileURLToPath(import.meta.url)), 'sub-hooks.lock.json')
/** The install this verifier belongs to: scripts/hooks/ is two levels below it. */
export const INSTALL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const GATES_REL = 'store/agent-sender-role-gates.json'
export const STATE_REL = 'store/gate-wiring-state.json'
export const STATE_FORMAT = 'marveen-gate-wiring-state/v1'
/** The longest temporary switch-off (GATE_WIRING_ENFORCE=0) in days; Roland decides the value (open item). */
export const ENFORCE_UNTIL_MAX_DAYS = 7
/** The same name rule as the gate's agent enumeration (db-write-gate.mjs AGENT_DIR_NAME_RX). */
const AGENT_NAME_RX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const DAY_RX = /^\d{4}-\d{2}-\d{2}$/
/** src/web/extra-hook-entries.ts EXTRA_HOOK_MARK: the marker of a group rendered from store/extra-hooks.json. */
export const EXTRA_HOOK_MARK = ': extra-hook;'
/** N2-3: the agent's own PreCompact prompt, at most this many characters (the template's is 4882 on 2026-11-17). */
export const PRECOMPACT_PROMPT_MAX = 16384

/** The lock next to this file, parsed and its sha256 checked; throws (the agent does not start) otherwise. */
export function loadLock(path = LOCK_PATH) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error('sub-hooks lock: cannot be read')
  }
  return parseLock(text)
}

/**
 * Read one settings file: it must be a regular file, not a symlink (plan v1 (d)); a missing file is null.
 * Throws with a reason naming the file kind, never its content.
 */
export function readSettingsFile(path, what) {
  const r = readSettingsFileHashed(path, what)
  return r === null ? null : r.obj
}

/** readSettingsFile plus the sha256 of the very bytes it parsed: { obj, sha256 }, or null when missing. */
export function readSettingsFileHashed(path, what) {
  let st
  try {
    st = lstatSync(path)
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw new Error(`${what}: cannot be read`)
  }
  if (st.isSymbolicLink()) throw new Error(`${what}: is a symlink`)
  if (!st.isFile()) throw new Error(`${what}: is not a regular file`)
  let buf
  try {
    buf = readFileSync(path)
  } catch {
    throw new Error(`${what}: cannot be read`)
  }
  let obj
  try {
    obj = JSON.parse(buf.toString('utf8'))
  } catch {
    throw new Error(`${what}: is not valid JSON`)
  }
  return { obj, sha256: createHash('sha256').update(buf).digest('hex') }
}

/**
 * N2-3: the agent's own PreCompact prompt, only when the PreCompact event is exactly one group with exactly one
 * agent-type hook and a non-empty prompt of at most PRECOMPACT_PROMPT_MAX characters; null otherwise. Everything
 * but the prompt is then compared with the lock like any other hook.
 */
export function precompactPromptOf(hooks) {
  const groups = hooks?.PreCompact
  if (!Array.isArray(groups) || groups.length !== 1 || !Array.isArray(groups[0]?.hooks) || groups[0].hooks.length !== 1) return null
  const h = groups[0].hooks[0]
  if (!h || h.type !== 'agent' || typeof h.prompt !== 'string' || h.prompt.length === 0 || h.prompt.length > PRECOMPACT_PROMPT_MAX) return null
  return h.prompt
}

/**
 * Compare a settings.json `hooks` block with the lock's block for these switches. Returns error strings naming the
 * event and group position only. `sw` is expectedHooks' input without precompact (taken from the file itself).
 */
export function checkHooksBlock(actual, lock, sw) {
  const errors = []
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return ['hooks: missing or not an object']
  if (JSON.stringify(actual).includes(EXTRA_HOOK_MARK)) errors.push('hooks: a group marked as an extra hook (this verifier accepts none)')
  const prompt = precompactPromptOf(actual)
  if (prompt === null) errors.push(`hooks.PreCompact: not exactly one agent hook with a prompt of 1 to ${PRECOMPACT_PROMPT_MAX} characters`)
  let expected
  try {
    expected = expectedHooks(lock, { ...sw, precompact: prompt ?? '' })
  } catch (e) {
    return [`hooks: the expected block cannot be built (${e instanceof Error ? e.message : 'error'})`]
  }
  const events = new Set([...Object.keys(actual), ...Object.keys(expected)])
  for (const ev of [...events].sort()) {
    const a = actual[ev]
    const x = expected[ev]
    if (x === undefined) { errors.push(`hooks.${ev}: not expected`); continue }
    if (!Array.isArray(a)) { errors.push(`hooks.${ev}: missing`); continue }
    if (a.length !== x.length) errors.push(`hooks.${ev}: ${a.length} groups, expected ${x.length}`)
    const n = Math.min(a.length, x.length)
    for (let i = 0; i < n; i++) if (canonicalJson(a[i]) !== canonicalJson(x[i])) errors.push(`hooks.${ev}[${i}]: differs from the lock`)
  }
  return errors
}

/**
 * The switches for one agent, from its protected baseline entry and the protected sender-role gates file only.
 * `gatesText` is store/agent-sender-role-gates.json's text, or null when it does not exist.
 * Returns { sw, errors }: sw is null when the entry cannot select a lock combination (no silent default, N2-4).
 */
export function switchesFromBaseline(agent, entry, { installDir, gatesText, root, fs } = {}) {
  if (entry === undefined || entry === null) return { sw: null, errors: ['baseline: no entry for this agent (the main agent requests one; enrolment)'] }
  const tuple = entry.switches
  const errors = tupleErrors(tuple, agent).map((e) => `baseline: ${e}`)
  if (errors.length > 0) return { sw: null, errors }
  errors.push(...nodeBinErrors(tuple.nodeBin, installDir, fs).map((e) => `baseline: ${e}`))
  const policy = senderRolePolicyFromGates(gatesText, agent)
  if (policySha256(policy) !== tuple.senderRolePolicySha256) errors.push('baseline: the sender-role policy changed since the baseline (rebaseline needed)')
  if (errors.length > 0) return { sw: null, errors }
  return {
    sw: {
      root: root ?? installDir,
      nodeBin: tuple.nodeBin,
      profile: { ...tuple.profile },
      heartbeat: tuple.heartbeat,
      threadReply: tuple.threadReply,
      browser: tuple.browser,
      senderRolePolicy: policy,
    },
    errors: [],
  }
}

/**
 * The checks on one sub-agent's three files, given the switches. `files` are parsed objects (or null when missing),
 * `ctx` is the validator's (installDir, agent, statusLineCommands, sharedMarketplaces, enabledPlugins).
 * Returns { ok, errors, alerts }.
 */
export function checkAgentFiles(files, lock, sw, ctx) {
  const errors = []
  const alerts = []
  if (files.project === null) errors.push('.claude/settings.json: missing')
  else {
    const r = validateSettings('agent-project', files.project, ctx)
    errors.push(...r.errors.map((e) => `.claude/settings.json: ${e}`))
    errors.push(...checkHooksBlock(files.project.hooks, lock, sw).map((e) => `.claude/settings.json: ${e}`))
  }
  if (files.local !== null) {
    const r = validateSettings('agent-local', files.local, ctx)
    errors.push(...r.errors.map((e) => `.claude/settings.local.json: ${e}`))
  }
  if (files.user !== null) {
    const r = validateSettings('agent-user', files.user, ctx)
    errors.push(...r.errors.map((e) => `.claude-config/settings.json: ${e}`))
    alerts.push(...r.alerts.map((k) => `.claude-config/settings.json: unknown key ${k}`))
  }
  return { ok: errors.length === 0, errors, alerts }
}

/** The isolated copy's only allowed statusLine command (Kevin 17428, measured by Johnny on this install's agents). */
export function statusLineCommandsFor(installDir) {
  return [`bash ${installDir}/scripts/statusline-ratelimit.sh`]
}

const reason = (e) => (e instanceof Error ? e.message : 'error')

/** A file's text; null when it does not exist, '' when it exists but cannot be read. */
function readOptional(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    return ''
  }
}

function dirIsNotSymlink(path, what, required) {
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink()) return [`${what}: is a symlink`]
    if (!st.isDirectory()) return [`${what}: is not a directory`]
    return []
  } catch (e) {
    if (e && e.code === 'ENOENT') return required ? [`${what}: missing`] : []
    return [`${what}: cannot be read`]
  }
}

/**
 * Everything the verifier checks for one sub-agent before it starts (plan v2 points 3, 4 and 7, Ron 17451 N1/N2):
 * the lock (own sha256), the protected baseline entry and its tuple, the three settings files (no symlinks, the
 * validator, the hooks block against the lock expanded with the baseline tuple ONLY), settings.local.json against
 * the baseline's hash, the shared ~/.claude/settings(.local).json as a user scope.
 * `opts`: installDir, home, lockPath, root, fs, statusLineCommands, enabledPlugins (the provisioning's exact map, the
 * dashboard knows it; without it the isolated copy's map is checked for shape only), configDir (null: the agent runs
 * on the shared ~/.claude root, so only the shared file is its user scope).
 * Returns { ok, errors, alerts, hashes }; messages name files, keys and reasons, never a value.
 */
export function verifyGateWiring(agent, opts = {}) {
  const installDir = opts.installDir ?? INSTALL_ROOT
  const home = opts.home ?? homedir()
  const errors = []
  const alerts = []
  const hashes = { project: null, local: null, user: null, shared: null, sharedLocal: null }
  const done = () => ({ ok: errors.length === 0, errors, alerts, hashes })
  if (typeof agent !== 'string' || !AGENT_NAME_RX.test(agent)) {
    errors.push('agent: not a plain agent name')
    return done()
  }
  let lock
  try {
    lock = loadLock(opts.lockPath)
  } catch (e) {
    errors.push(reason(e))
    return done()
  }
  const baselineText = readOptional(join(installDir, BASELINE_REL))
  if (baselineText === null) {
    errors.push('baseline: missing (the main agent requests one; enrolment)')
    return done()
  }
  let baseline
  try {
    baseline = parseBaseline(baselineText)
  } catch (e) {
    errors.push(baselineText === '' ? 'baseline: cannot be read' : reason(e))
    return done()
  }
  const entry = Object.hasOwn(baseline.agents, agent) ? baseline.agents[agent] : undefined
  const { sw, errors: swErrors } = switchesFromBaseline(agent, entry, {
    installDir, gatesText: readOptional(join(installDir, GATES_REL)), root: opts.root, fs: opts.fs,
  })
  errors.push(...swErrors)

  const agentDir = join(installDir, 'agents', agent)
  const configDir = opts.configDir === undefined ? join(agentDir, '.claude-config') : opts.configDir
  errors.push(...dirIsNotSymlink(join(agentDir, '.claude'), '.claude', true))
  if (configDir !== null) errors.push(...dirIsNotSymlink(configDir, '.claude-config', false))
  const read = (key, path, what) => {
    try {
      const r = readSettingsFileHashed(path, what)
      hashes[key] = r === null ? null : r.sha256
      return r === null ? null : r.obj
    } catch (e) {
      errors.push(reason(e))
      return undefined
    }
  }
  const files = {
    project: read('project', join(agentDir, '.claude', 'settings.json'), '.claude/settings.json'),
    local: read('local', join(agentDir, '.claude', 'settings.local.json'), '.claude/settings.local.json'),
    user: configDir === null ? null : read('user', join(configDir, 'settings.json'), '.claude-config/settings.json'),
  }
  const shared = read('shared', join(home, '.claude', 'settings.json'), '~/.claude/settings.json')
  const sharedLocal = read('sharedLocal', join(home, '.claude', 'settings.local.json'), '~/.claude/settings.local.json')
  for (const [obj, what] of [[shared, '~/.claude/settings.json'], [sharedLocal, '~/.claude/settings.local.json']]) {
    if (obj === null || obj === undefined) continue
    const r = validateSettings('shared-user', obj, {})
    errors.push(...r.errors.map((e) => `${what}: ${e}`))
    alerts.push(...r.alerts.map((k) => `${what}: unknown key ${k}`))
  }

  // settings.local.json is written only by the owner-approved helper: it must be byte-equal to the baseline's record.
  if (entry !== undefined && entry !== null && files.local !== undefined) {
    const want = entry.local?.sha256
    if (want !== null && (typeof want !== 'string' || !/^[0-9a-f]{64}$/.test(want))) errors.push('baseline: no settings.local.json record')
    else if (want === null && hashes.local !== null) errors.push('.claude/settings.local.json: exists, the baseline records none (rebaseline needed)')
    else if (want !== null && hashes.local !== want) errors.push('.claude/settings.local.json: differs from the baseline (rebaseline needed)')
  }

  if (sw !== null && files.project !== undefined && files.local !== undefined && files.user !== undefined) {
    const r = checkAgentFiles(files, lock, sw, {
      installDir,
      agent,
      statusLineCommands: opts.statusLineCommands ?? statusLineCommandsFor(installDir),
      // no key (or no shared file) means none: an own marketplace in the isolated copy could bring plugins and hooks
      sharedMarketplaces: shared?.extraKnownMarketplaces ?? {},
      enabledPlugins: opts.enabledPlugins,
    })
    errors.push(...r.errors)
    alerts.push(...r.alerts)
  }
  return done()
}

function utcDay(now) {
  return now.toISOString().slice(0, 10)
}
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/**
 * Report or enforce (plan v2 point 7, Ron K3, Johnny 17456 "report mode is the default"):
 *   unset or empty  report (the default until Roland flips it in .env, informed by the report)
 *   "1"             enforce
 *   "0"             report, only with GATE_WIRING_ENFORCE_UNTIL=YYYY-MM-DD between today and today + 7 (UTC days);
 *                   a missing, malformed, past or too-far date means enforce, with an alert
 *   anything else   enforce, with an alert (fail-closed)
 *   an .env that exists but cannot be read: enforce, with an alert (Ron 17505 1b)
 * Returns { enforce, alert }.
 */
export function gateWiringMode(env, now = new Date()) {
  if (env[ENV_UNREADABLE] === true) return { enforce: true, alert: 'the install .env exists but cannot be read; enforcing' }
  const v = env.GATE_WIRING_ENFORCE
  if (v === undefined || v === '') return { enforce: false, alert: null }
  if (v === '1') return { enforce: true, alert: null }
  if (v === '0') {
    const until = env.GATE_WIRING_ENFORCE_UNTIL
    const today = utcDay(now)
    if (typeof until === 'string' && DAY_RX.test(until) && until >= today && until <= addDays(today, ENFORCE_UNTIL_MAX_DAYS)) {
      return { enforce: false, alert: null }
    }
    return { enforce: true, alert: `GATE_WIRING_ENFORCE=0 needs GATE_WIRING_ENFORCE_UNTIL between today and ${ENFORCE_UNTIL_MAX_DAYS} days ahead; enforcing` }
  }
  return { enforce: true, alert: 'GATE_WIRING_ENFORCE has an unknown value; enforcing' }
}

/**
 * The two switch names from the install's .env, the file the dashboard loads at start (never a file under agents/
 * or store/, never the caller's own environment, which an agent could set).
 */
export function readEnforceEnv(installDir = INSTALL_ROOT) {
  let text
  try {
    text = readFileSync(join(installDir, '.env'), 'utf8')
  } catch (e) {
    // Ron 17505 1b: no .env is "no key" (report); any other read error must not fall back to report silently.
    if (e && e.code === 'ENOENT') return {}
    return { [ENV_UNREADABLE]: true }
  }
  return parseEnvLikeDashboard(text, ENFORCE_KEYS)
}

/** The keys readEnforceEnv takes from .env; a marker key for an .env that exists but cannot be read. */
export const ENFORCE_KEYS = Object.freeze(['GATE_WIRING_ENFORCE', 'GATE_WIRING_ENFORCE_UNTIL'])
export const ENV_UNREADABLE = '__envUnreadable'

/**
 * src/env-parse.ts parseEnvContent, line for line (Ron 17505 1c: the verifier must read the switch exactly as the
 * dashboard does, without importing src, K1; a parity test pins the two): trimmed line, # comments, the first `=`,
 * key and value trimmed, one pair of matching outer quotes removed, the last duplicate wins.
 */
export function parseEnvLikeDashboard(content, keys) {
  const result = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (keys && !keys.includes(key)) continue
    result[key] = value
  }
  return result
}

/** Write a file atomically: a random O_CREAT|O_EXCL|O_NOFOLLOW temp next to it (0600), fsync, rename. */
export function writeFileAtomic(path, text) {
  const tmp = join(dirname(path), `.gate-wiring-${randomBytes(8).toString('hex')}.tmp`)
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/**
 * store/gate-wiring-state.json (D2-REL-2): per agent the problem set's fingerprint (so an alert goes out once per
 * state change, not every watchdog tick) and the hashes of the last VERIFIED start (the timer's basis). Written only
 * by the verifier process. Returns { changed }: true when the problem set differs from the recorded one.
 */
export function recordState(installDir, agent, result, now = new Date()) {
  const path = join(installDir, STATE_REL)
  let state = { format: STATE_FORMAT, agents: {} }
  const text = readOptional(path)
  if (text) {
    try {
      const s = JSON.parse(text)
      if (s && s.format === STATE_FORMAT && s.agents && typeof s.agents === 'object' && !Array.isArray(s.agents)) state = s
    } catch { /* a broken state file is rewritten; the worst case is one repeated alert */ }
  }
  const problems = [...result.errors, ...result.alerts.map((a) => `alert: ${a}`)].sort()
  const key = problems.length === 0 ? null : createHash('sha256').update(problems.join('\n'), 'utf8').digest('hex')
  const prev = Object.hasOwn(state.agents, agent) ? state.agents[agent] : {}
  const changed = (prev.problems ?? null) !== key
  state.agents[agent] = {
    problems: key,
    checkedAt: now.toISOString(),
    verified: result.ok ? { at: now.toISOString(), hashes: result.hashes } : (prev.verified ?? null),
  }
  writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`)
  return { changed }
}

/**
 * CLI for scripts/watchdog.sh: `node verify-gate-wiring.mjs --agent <name>`.
 * Exit 0: start the agent (no problem, or report mode); 1: do not start (enforce and a problem); 2: usage.
 * Problems go to stderr as ONE line starting with [GATE-WIRING]; " NEW" marks a changed problem set (alert once).
 */
export function runCli(argv, { installDir = INSTALL_ROOT, now = new Date(), stderr = process.stderr, home, fs } = {}) {
  if (argv.length !== 2 || argv[0] !== '--agent' || !AGENT_NAME_RX.test(argv[1] ?? '')) {
    stderr.write('[GATE-WIRING] usage: verify-gate-wiring.mjs --agent <name>\n')
    return 2
  }
  const r = checkBeforeStart(argv[1], { installDir, home, fs, now })
  if (r.line !== null) stderr.write(`${r.line}\n`)
  return r.start ? 0 : 1
}

/**
 * Plan v2 point 4: the shared ~/.claude/settings(.local).json, checked BEFORE the dashboard's isolated provisioning
 * copies it into an agent's .claude-config (the copy carries its env and every other key). In enforce a finding means
 * no copy and no start for every isolated agent (the source is shared, so it fails closed for all); in report mode
 * the copy goes ahead and the full check before tmux logs the same finding. Returns { copy, line }.
 */
export function checkSharedBeforeCopy(agent, opts = {}) {
  const installDir = opts.installDir ?? INSTALL_ROOT
  const home = opts.home ?? homedir()
  const mode = gateWiringMode(readEnforceEnv(installDir), opts.now ?? new Date())
  const errors = []
  for (const [file, what] of [['settings.json', '~/.claude/settings.json'], ['settings.local.json', '~/.claude/settings.local.json']]) {
    let obj
    try {
      obj = readSettingsFile(join(home, '.claude', file), what)
    } catch (e) {
      errors.push(reason(e))
      continue
    }
    if (obj === null) continue
    errors.push(...validateSettings('shared-user', obj, {}).errors.map((e) => `${what}: ${e}`))
  }
  const copy = !(mode.enforce && errors.length > 0)
  const line = errors.length === 0 ? null
    : `[GATE-WIRING] ${agent} ${mode.enforce ? 'enforce' : 'report'}${copy ? '' : ' NOT STARTED'}: shared settings, before the isolated copy: ${errors.join('; ')}`
  return { copy, line }
}

/**
 * The one start decision both launch paths take (the watchdog through runCli, the dashboard's startAgentProcess
 * in process): mode from .env, verifyGateWiring, the state file, ONE log line (null when there is nothing to say).
 * `opts` is verifyGateWiring's plus `now`. Returns { start, line, changed, result }.
 */
export function checkBeforeStart(agent, opts = {}) {
  const installDir = opts.installDir ?? INSTALL_ROOT
  const now = opts.now ?? new Date()
  const mode = gateWiringMode(readEnforceEnv(installDir), now)
  const result = verifyGateWiring(agent, { ...opts, installDir })
  let changed = true
  if (AGENT_NAME_RX.test(String(agent))) {
    try {
      changed = recordState(installDir, agent, result, now).changed
    } catch {
      result.alerts.push('store/gate-wiring-state.json: cannot be written')
    }
  }
  const start = !(mode.enforce && !result.ok)
  const notes = [...result.errors, ...result.alerts.map((a) => `alert: ${a}`)]
  if (mode.alert) notes.unshift(mode.alert)
  const line = notes.length === 0 ? null
    : `[GATE-WIRING] ${agent} ${mode.enforce ? 'enforce' : 'report'}${start ? '' : ' NOT STARTED'}${changed ? ' NEW' : ''}: ${notes.join('; ')}`
  return { start, line, changed, result }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runCli(process.argv.slice(2))
}
