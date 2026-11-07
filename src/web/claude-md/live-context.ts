// C1 PR 10a: the live AgentDocContext, read from an install root.
//
// One function: buildLiveContext(root, name, opts) -> { ctx, assumptions }.
// The root is an ARGUMENT, never config.ts's PROJECT_ROOT: config.ts derives
// the root from the code location and reads .env from there, so a run from a
// worktree would measure the worktree (Stuart, C1 PR 8 plan). For the same
// reason, and because the dry-run CLI must provably write nothing, this
// module's import tree holds no config.js, logger.js, atomic-write.js,
// agent-scaffold.ts or federation/config.ts (a test reads the tree). It only
// reads: files, stat and access checks.
//
// Every value comes from a real source, or it is named in `assumptions`
// (Kevin 12997): never a silent default. The fields the v2 region renders are
// RENDERED_FIELDS; the dashboard path (PR 10b) refuses to write while one of
// them is still an assumption.
//
// Sources (mirrors of the legacy readers, each pinned by a parity test):
// - .env (parseEnvContent): MAIN_AGENT_ID (default "marveen"), OWNER_NAME
//   (an empty value reads the "Owner" placeholder, as an unset one does; a
//   set-but-empty MAIN_AGENT_ID throws), ALLOWED_CHAT_ID ("" or "0" -> null: the
//   install template renders "0" before pairing), BOT_NAME (default "Marveen").
//   None of the four is layered by store/config-overrides.json in config.ts.
// - role: the main agent id -> main; "heartbeat" (config.ts HEARTBEAT_AGENT_ID)
//   -> heartbeat; otherwise a sub, which must have its agents/<name> directory.
// - roster: listAllAgentNames + the .hidden-from-dashboard sentinel of
//   agent-config.ts (directories only; a symlink into agents/ is an alias, not
//   an agent; the main agent's id is never a sub), with the main agent put
//   first when absent, as buildFleetRosterBody does; without self.
// - team: agent-config.json team.reportsTo, trimmed, kept only when it names a
//   known agent other than self (buildFleetRosterBody); directReports are the
//   agents whose stored reportsTo is this agent, except this agent's own lead
//   (a two-agent cycle), as buildFleetRosterBody tags them. (team.delegatesTo, which the
//   legacy roster prints as its delegates line, is not part of the v2 ctx.)
// - profile.strict: opts.strict (the write path passes agentRunsStrict), else
//   the effective defaultMode OF THE WRITTEN SETTINGS === "dontAsk" (the highest
//   settings layer that sets a mode decides; a strict profile pins it,
//   agent-scaffold.ts enforceStrictPermissionMode). That is not the running
//   process's mode: a CLI switch (agent-process.ts --permission-mode) is outside
//   it (Ron S4). A layer above the deciding one that does not parse makes it
//   ASSUMED (read false). The main agent has no profile and is never strict.
// - profile.helperAllowed: opts.helperAllowed (the dashboard passes
//   agentUsesApiHelper), else a simplified deny-rule reading: ASSUMED.
// - capabilities.kanbanWrite: false only for the heartbeat worker
//   (agentGetsKanbanWriteGate); capabilities.federation and federation:
//   store/federation.json through the bridge's own validator
//   (federation/validate.ts, with the .env main id as the default systemId):
//   on only when the file validates and says enabled; absent, not JSON or
//   invalid reads off with no peers, as getFederationConfig fails closed (C1
//   PR 12b; before, an enabled file that failed its other checks read ON, the
//   conservative side for the v2 refusal that 12b removes). A peer's tokens
//   never reach the ctx, only `paired` (its outbound token is set);
//   capabilities.scheduleWrite: the main agent only (auth-gate rule
//   schedule-writes-main-agent-only).
// - autonomy: store/autonomy-config.json, each category clamped as
//   readAutonomyLevel does (an integer level, 1..3, capped by maxLevel; a
//   non-integer level reads 1). A missing file is no categories; an
//   unreadable one throws.
// - hooks: hooksFromSettings over the agent's settings layers, with the J4
//   file check (an existing, readable regular file). Layers: main
//   <root>/.claude/settings.json, settings.local.json and <home>/.claude/
//   settings.json; a sub agents/<n>/.claude/settings.json, settings.local.json
//   and agents/<n>/.claude-config/settings.json; above all of them the managed
//   settings file (/etc/claude-code/managed-settings.json, the macOS path on
//   darwin), whose allowManagedHooksOnly leaves only its own hooks. A missing
//   file is skipped; one that does not parse makes every hook false
//   (fail-closed). Ron S1: where the layers read are not the session's (the
//   main agent with MAIN_AGENT_CONFIG_DIR or MAIN_AGENT_ISOLATED_CONFIG; a sub
//   whose agent-config.json names its own claudeConfigDir or claudePlan, so
//   its user layer is not agents/<n>/.claude-config, Ron 10b J2; or a managed
//   file that does not parse), hooks are all false and ASSUMED, so the write
//   gate stops.
// - hooksNotWired (Ron 13122 J1, Kevin 13130): a hook reads false SILENTLY
//   when its wiring is there but the script fails the J4 check (one install
//   gave a 4328-char region without --permission and 4521 under it: the hook
//   script was outside the grant). So every such false is named, next to the
//   ctx: {id, path, reason "missing" | "not readable"} for a wired hook whose
//   script path is absent / exists but cannot be read as a regular file, and
//   one entry {id "all"} for the cases that make every hook false: the S1
//   ones above, and a project or user layer that does not parse. A hook that
//   no layer wires at all is not listed (that is configuration, not a fault),
//   nor are the explicit switches disableAllHooks and allowManagedHooksOnly.
// - capabilities.channel (C1 PR 11a-2): a sub reads channel.ts agentHasChannel
//   on its agent dir, the same source as the dashboard's per-agent channel
//   flags (fail safe: an unreadable channel file counts as a channel). The
//   main agent is the owner's channel agent: true by design (its channel
//   state is resolved by channelStateDir, env and home dependent, which this
//   module does not mirror). The heartbeat worker owns no channel: false.
// - ASSUMED (not rendered): profile.id, capabilities.emailSend, browser,
//   thinChief, tokenPath. botName falls back to the code default "Marveen",
//   which is config.ts's own default, so that is a source, not an assumption.

import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { parseEnvContent } from '../../env-parse.js'
import { isAgentName } from './agent-name.js'
import { agentHasChannel } from './channel.js'
import { HOOK_IDS, type AgentDocContext, type AgentRole, type AutonomyLevel, type HookId } from './context.js'
import { HOOK_SPECS, hooksFromSettings } from './hooks-from-settings.js'
import { DEFAULT_ROUTING_MODE, validateFederationConfigWith } from '../federation/validate.js'

export class LiveContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LiveContextError'
  }
}

export interface LiveContextOptions {
  // The dashboard path passes agentUsesApiHelper(name) / agentRunsStrict(name);
  // the read-only CLI cannot import agent-scaffold, so it leaves them out.
  helperAllowed?: boolean
  strict?: boolean
  // For the main agent's user-scope settings layer; default os.homedir().
  homeDir?: string
  // The managed settings file, Claude Code's highest-priority layer; default the platform path.
  managedSettingsPath?: string
}

// Claude Code's managed settings file (code.claude.com/docs/en/settings): the highest-priority layer, for every
// session on the host. It can set hooks, disableAllHooks, allowManagedHooksOnly and defaultMode.
export function defaultManagedSettingsPath(os: string = platform()): string {
  return os === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json'
}

export type HookNotWiredReason =
  | 'missing' // the script path a layer wires does not exist
  | 'not readable' // it exists, but is not a regular file that can be read here (a permission grant, a mode)
  | 'config root is not the session\'s' // Ron S1: the main agent on another config root; a sub with claudeConfigDir / claudePlan
  | 'managed settings do not parse' // Ron S1: the highest layer is unknown
  | 'settings layer does not parse' // a project or user layer: hooksFromSettings reads every hook false

// A hook that reads false although its wiring may be there. id "all": every hook reads false for this reason.
export interface HookNotWired {
  id: HookId | 'all'
  path: string | null // the script, or the settings file; null when there is no one file
  reason: HookNotWiredReason
}

export interface LiveContext {
  ctx: AgentDocContext
  // ctx field paths whose value has no real source, sorted.
  assumptions: string[]
  // Why a hook reads false where its wiring may be there (never silent, Ron 13122 J1), sorted by id, then path.
  hooksNotWired: HookNotWired[]
}

// The ctx fields the v2 region renders (sections.ts / registry.ts; a parity
// test reads them out of the source). A rendered field must never be an
// assumption on a real write.
export const RENDERED_FIELDS = [
  'capabilities.channel', 'capabilities.federation', 'capabilities.kanbanWrite', 'federation', 'hooks', 'mainAgentId',
  'name', 'owner.chatId', 'owner.name', 'profile.helperAllowed', 'profile.strict', 'projectRoot', 'role', 'roster', 'team',
] as const

const DEFAULT_MAIN_AGENT_ID = 'marveen'
const DEFAULT_OWNER_NAME = 'Owner'
const DEFAULT_BOT_NAME = 'Marveen'
const HEARTBEAT_AGENT_ID = 'heartbeat'
const HIDDEN_AGENT_SENTINEL = '.hidden-from-dashboard'

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw new LiveContextError(`cannot read ${path}: ${(err as Error).message}`)
  }
}

// A JSON object file: null when absent, the object when it parses to one,
// and `undefined` when it is present but not a JSON object.
function readJsonObject(path: string): Record<string, unknown> | null | undefined {
  const text = readText(path)
  if (text === null) return null
  try {
    const v = JSON.parse(text) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

// The J4 file check, with its reason: null = an existing, readable regular file. A path that does not exist
// (ENOENT, or a parent that is not a directory) is 'missing'; anything else that stops the read (not a regular
// file, no read permission, a symlink loop, a path outside a Node --permission grant) is 'not readable'.
function hookFileProblem(absPath: string): 'missing' | 'not readable' | null {
  let isFile: boolean
  try {
    isFile = statSync(absPath).isFile()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'not readable'
  }
  if (!isFile) return 'not readable'
  try {
    accessSync(absPath, constants.R_OK)
  } catch {
    return 'not readable'
  }
  return null
}

// The hook whose script a path names (the script names are distinct).
function hookOfScript(absPath: string): HookId | null {
  return HOOK_IDS.find((id) => absPath.endsWith(`/scripts/hooks/${HOOK_SPECS[id].script}`)) ?? null
}

// agent-config.ts listAllAgentNames + listAgentNames, against `root`.
function listAgents(root: string, mainAgentId: string): string[] {
  const base = join(root, 'agents')
  if (!existsSync(base)) return []
  let baseReal: string
  try { baseReal = realpathSync(base) } catch { baseReal = resolve(base) }
  return readdirSync(base).filter((f) => {
    if (f === mainAgentId) return false
    const path = join(base, f)
    try {
      const st = lstatSync(path)
      if (!st.isSymbolicLink()) {
        if (!st.isDirectory()) return false
      } else {
        const target = realpathSync(path)
        if (target === baseReal || target.startsWith(baseReal + sep)) return false
        if (!statSync(path).isDirectory()) return false
      }
      return !existsSync(join(path, HIDDEN_AGENT_SENTINEL))
    } catch {
      return false
    }
  })
}

function reportsToOf(root: string, name: string): string | null {
  const cfg = readJsonObject(join(root, 'agents', name, 'agent-config.json'))
  const team = cfg?.team
  if (typeof team !== 'object' || team === null) return null
  const r = (team as Record<string, unknown>).reportsTo
  return typeof r === 'string' && r.trim() ? r.trim() : null
}

function readAutonomy(root: string): Record<string, AutonomyLevel> {
  const path = join(root, 'store', 'autonomy-config.json')
  const text = readText(path)
  if (text === null) return {}
  let cfg: unknown
  try {
    cfg = JSON.parse(text)
  } catch {
    throw new LiveContextError(`${path}: not valid JSON`)
  }
  const cats = (cfg as { categories?: unknown })?.categories
  if (cats === undefined) return {}
  if (!Array.isArray(cats)) throw new LiveContextError(`${path}: "categories" is not a list`)
  const out: Record<string, AutonomyLevel> = {}
  for (const c of cats) {
    if (typeof c !== 'object' || c === null) continue
    const { key, level, maxLevel } = c as { key?: unknown; level?: unknown; maxLevel?: unknown }
    if (typeof key !== 'string' || key in out) continue
    const raw = Number(level)
    const cap = Number.isInteger(maxLevel) ? (maxLevel as number) : 3
    out[key] = (Number.isInteger(raw) ? Math.max(1, Math.min(3, raw, cap)) : 1) as AutonomyLevel
  }
  return out
}

// store/federation.json as the bridge reads it (see the header): on, the
// routing mode and the peers (id, paired) of a file that validates and is
// enabled; anything else is off.
function federationState(root: string, mainAgentId: string): { enabled: boolean; doc: AgentDocContext['federation'] } {
  const off = { enabled: false, doc: { routingMode: DEFAULT_ROUTING_MODE, peers: [] } }
  const text = readText(join(root, 'store', 'federation.json'))
  if (text === null) return off
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return off }
  const cfg = validateFederationConfigWith(parsed, mainAgentId)
  if (typeof cfg === 'string' || !cfg.enabled) return off
  return {
    enabled: true,
    doc: { routingMode: cfg.routingMode ?? DEFAULT_ROUTING_MODE, peers: cfg.peers.map((p) => ({ id: p.id, paired: p.outboundToken.length > 0 })) },
  }
}

// One settings layer: `value` is the parsed object, or null when the file is
// there but is not a JSON object.
interface SettingsLayer { file: string; value: Record<string, unknown> | null }

// The agent's settings layers in Claude Code precedence order, highest first:
// local project, shared project, then the user scope (the main agent's
// ~/.claude, a sub's isolated .claude-config). A missing file is left out.
function settingsLayers(root: string, name: string, role: AgentRole, homeDir: string): SettingsLayer[] {
  const projectDir = role === 'main' ? join(root, '.claude') : join(root, 'agents', name, '.claude')
  const userFile = role === 'main' ? join(homeDir, '.claude', 'settings.json') : join(root, 'agents', name, '.claude-config', 'settings.json')
  const files = [join(projectDir, 'settings.local.json'), join(projectDir, 'settings.json'), userFile]
  const layers: SettingsLayer[] = []
  for (const file of files) {
    const v = readJsonObject(file)
    if (v === null) continue
    layers.push({ file, value: v === undefined ? null : v })
  }
  return layers
}

// The simplified helper reading for the CLI (no override): a Bash deny rule
// that could catch `bash <root>/scripts/marveen-api.sh <verb>`. Conservative:
// an unreadable layer, a bare "Bash", "Bash(*)" or any rule naming
// marveen-api or starting with bash counts as a deny.
function helperDeniedSimplified(layers: unknown[]): boolean {
  for (const l of layers) {
    if (typeof l !== 'object' || l === null) return true
    const deny = ((l as { permissions?: { deny?: unknown } }).permissions?.deny)
    if (!Array.isArray(deny)) continue
    for (const r of deny) {
      if (typeof r !== 'string') continue
      if (r === 'Bash' || r === 'Bash(*)') return true
      const m = /^Bash\((.*)\)$/.exec(r)
      if (m && (m[1].includes('marveen-api') || /^bash\b/.test(m[1]) || m[1] === ':*')) return true
    }
  }
  return false
}

// Whether the main agent runs on a config root other than <home>/.claude: MAIN_AGENT_CONFIG_DIR set, or
// MAIN_AGENT_ISOLATED_CONFIG on, by the dashboard's own precedence (the store overrides file over .env; an
// overrides file that does not parse reads as empty there too). "On" is read wide: anything but empty, 0, false,
// off or no, so an unknown spelling counts as another root (the safe side).
function mainOnOtherConfigRoot(root: string, env: Record<string, string>): boolean {
  const overrides = readJsonObject(join(root, 'store', 'config-overrides.json')) ?? {}
  const value = (key: string): string => {
    const o = overrides[key]
    return String(o !== undefined && o !== null ? o : env[key] ?? '').trim()
  }
  if (value('MAIN_AGENT_CONFIG_DIR') !== '') return true
  return !['', '0', 'false', 'off', 'no'].includes(value('MAIN_AGENT_ISOLATED_CONFIG').toLowerCase())
}

// Whether a sub runs on a config root other than agents/<n>/.claude-config: its agent-config.json names a
// claudeConfigDir or a claudePlan (agent-config.ts readAgentClaudeConfigDir / readAgentClaudePlan; any
// non-blank string counts, the safe side), so the user layer read here is not the session's (Ron 10b J2).
function subOnOtherConfigRoot(cfg: Record<string, unknown> | null | undefined): boolean {
  const set = (v: unknown) => typeof v === 'string' && v.trim() !== ''
  return cfg !== null && cfg !== undefined && (set(cfg.claudeConfigDir) || set(cfg.claudePlan))
}

// The effective permissions.defaultMode is "dontAsk": the highest layer that
// sets a defaultMode decides, as in Claude Code. A strict profile pins it in the
// project settings the scaffold writes, and only a strict one does, because
// writeAgentSettingsFromProfile rebuilds `permissions` and only
// enforceStrictPermissionMode adds the mode (parity test). A user-scope dontAsk
// under a project layer without a mode is effective too, so it reads strict:
// the dontAsk recipes are then the ones that work. `undefined`: a layer above
// the deciding one does not parse, so the mode is unknown.
function effectiveDontAsk(layers: SettingsLayer[]): boolean | undefined {
  for (const l of layers) {
    if (l.value === null) return undefined
    const perms = l.value.permissions
    const mode = typeof perms === 'object' && perms !== null ? (perms as { defaultMode?: unknown }).defaultMode : undefined
    if (mode !== undefined) return mode === 'dontAsk'
  }
  return false
}

export function buildLiveContext(root: string, name: string, opts: LiveContextOptions = {}): LiveContext {
  if (!root.startsWith('/')) throw new LiveContextError(`root must be an absolute path: ${root}`)
  if (!isAgentName(name)) throw new LiveContextError(`not an agent name: ${JSON.stringify(name)}`)
  const assumptions: string[] = []
  const envText = readText(join(root, '.env'))
  const env = envText === null ? {} : parseEnvContent(envText)
  // config.ts reads `env.MAIN_AGENT_ID ?? 'marveen'`, so a set but empty value is
  // the main id "" there: no agent matches it, and guessing "marveen" here would
  // describe a different fleet than the dashboard sees. Refuse instead.
  if (env['MAIN_AGENT_ID'] === '') throw new LiveContextError(`${join(root, '.env')}: MAIN_AGENT_ID is set but empty`)
  const mainAgentId = env['MAIN_AGENT_ID'] ?? DEFAULT_MAIN_AGENT_ID
  const ownerName = (env['OWNER_NAME'] ?? '').trim() || DEFAULT_OWNER_NAME
  const chatRaw = (env['ALLOWED_CHAT_ID'] ?? '').trim()
  const botName = (env['BOT_NAME'] ?? '').trim() || DEFAULT_BOT_NAME

  const role: AgentRole = name === mainAgentId ? 'main' : name === HEARTBEAT_AGENT_ID ? 'heartbeat' : 'sub'
  const agentDir = role === 'main' ? root : join(root, 'agents', name)
  if (role !== 'main') {
    let isDir = false
    try { isDir = statSync(agentDir).isDirectory() } catch { /* absent */ }
    if (!isDir) throw new LiveContextError(`no agent directory for ${name}: ${agentDir}`)
  }

  const agents = listAgents(root, mainAgentId)
  const names = agents.includes(mainAgentId) ? agents : [mainAgentId, ...agents]
  const keptReportsTo = (n: string): string | null => {
    const r = n === mainAgentId ? null : reportsToOf(root, n)
    return r !== null && r !== n && names.includes(r) ? r : null
  }
  const reportsTo = role === 'main' ? null : keptReportsTo(name)
  // buildFleetRosterBody: a peer whose stored reportsTo is this agent, unless it is also this agent's own
  // (kept) lead, which breaks a two-agent cycle.
  const directReports = names.filter((n) => n !== name && n !== reportsTo
    && (n === mainAgentId ? null : reportsToOf(root, n)) === name)

  const projectLayers = settingsLayers(root, name, role, opts.homeDir ?? homedir())
  const managedFile = opts.managedSettingsPath ?? defaultManagedSettingsPath()
  const managedValue = readJsonObject(managedFile)
  const managed: SettingsLayer[] = managedValue === null ? [] : [{ file: managedFile, value: managedValue ?? null }]
  // Highest first: managed, then local project, shared project, user scope.
  const layers = [...managed, ...projectLayers]
  const values = layers.map((l) => l.value)
  // The J4 check, recording each script path it turns down (hooksFromSettings itself stays unchanged).
  const turnedDown = new Map<string, 'missing' | 'not readable'>()
  const check = {
    projectDir: agentDir,
    usable: (absPath: string): boolean => {
      const problem = hookFileProblem(absPath)
      if (problem !== null) turnedDown.set(absPath, problem)
      return problem === null
    },
  }
  // allowManagedHooksOnly: only the managed layer's hooks run. Anything but an absent or false value reads as on.
  const managedTop = managed.length > 0 ? managed[0].value : undefined
  const managedOnly = managedTop !== undefined && managedTop !== null
    && managedTop.allowManagedHooksOnly !== undefined && managedTop.allowManagedHooksOnly !== false
  let hooks = hooksFromSettings(managedOnly ? [managedTop] : values, check)
  let hooksNotWired: HookNotWired[] = []
  for (const [path, reason] of turnedDown) {
    const id = hookOfScript(path)
    if (id !== null && !hooks[id]) hooksNotWired.push({ id, path, reason })
  }
  if (!managedOnly) {
    for (const l of projectLayers) if (l.value === null) hooksNotWired.push({ id: 'all', path: l.file, reason: 'settings layer does not parse' })
  }
  // Ron S1: a false "wired" drops a rule's prose while its hook does not run. Where the layers read here are not
  // the ones the session loads, the hooks have no real source: all false and ASSUMED, so the write gate stops.
  // - The main agent on another config root (MAIN_AGENT_CONFIG_DIR, or MAIN_AGENT_ISOLATED_CONFIG on): its user
  //   layer is not <home>/.claude/settings.json.
  // - A sub with its own claudeConfigDir / claudePlan: its user layer is not agents/<n>/.claude-config (Ron 10b J2).
  // - A managed file that does not parse: the highest layer is unknown.
  const agentCfg = role === 'main' ? null : readJsonObject(join(agentDir, 'agent-config.json'))
  const otherRoot = role === 'main' ? mainOnOtherConfigRoot(root, env) : subOnOtherConfigRoot(agentCfg)
  if (otherRoot || managedTop === null) {
    hooks = hooksFromSettings([null], check)
    assumptions.push('hooks')
    hooksNotWired = []
    if (otherRoot) hooksNotWired.push({ id: 'all', path: null, reason: 'config root is not the session\'s' })
    if (managedTop === null) hooksNotWired.push({ id: 'all', path: managedFile, reason: 'managed settings do not parse' })
  }
  let strict: boolean
  if (role === 'main') {
    strict = false
  } else if (opts.strict !== undefined) {
    strict = opts.strict
  } else {
    const written = effectiveDontAsk(layers)
    strict = written === true
    if (written === undefined) assumptions.push('profile.strict')
  }
  let helperAllowed: boolean
  if (opts.helperAllowed !== undefined) {
    helperAllowed = opts.helperAllowed
  } else {
    helperAllowed = !helperDeniedSimplified(values)
    assumptions.push('profile.helperAllowed')
  }

  const storedProfile = agentCfg?.securityProfile
  const federation = federationState(root, mainAgentId)
  assumptions.push('profile.id', 'capabilities.emailSend', 'capabilities.browser', 'capabilities.thinChief', 'tokenPath')

  const ctx: AgentDocContext = {
    name,
    role,
    mainAgentId,
    botName,
    owner: { name: ownerName, chatId: chatRaw === '' || chatRaw === '0' ? null : chatRaw },
    projectRoot: root,
    tokenPath: join(root, 'store', '.dashboard-token'),
    profile: { id: typeof storedProfile === 'string' && storedProfile ? storedProfile : 'default', strict, helperAllowed },
    capabilities: {
      kanbanWrite: name !== HEARTBEAT_AGENT_ID,
      scheduleWrite: role === 'main',
      emailSend: 'none',
      browser: false,
      federation: federation.enabled,
      thinChief: false,
      channel: role === 'main' ? true : role === 'heartbeat' ? false : agentHasChannel(agentDir),
    },
    autonomy: readAutonomy(root),
    team: { reportsTo, directReports },
    roster: names.filter((n) => n !== name).map((n) => ({ name: n })),
    hooks,
    federation: federation.doc,
  }
  const order = (h: HookNotWired) => `${h.id === 'all' ? '' : h.id}\u0000${h.path ?? ''}\u0000${h.reason}`
  hooksNotWired.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0))
  return { ctx, assumptions: [...new Set(assumptions)].sort(), hooksNotWired }
}
