// Typed hook manifest (C3-1): ONE description of the hook wiring, as data.
//
// Today the wiring has two sources of truth (audit hooks-gates.md 3.6): the
// main agent's hooks are hand-edited in the tracked .claude/settings.json, and
// the sub-agents' hooks are written by ensureAgentHooks + the inject*Gate
// functions in agent-scaffold.ts. This module describes that wiring AS IT IS
// TODAY, so a test can prove the description is exact before anything is
// generated from it:
//   - renderHooks(HOOK_MANIFEST, 'main') deep-equals the `hooks` object of the
//     tracked .claude/settings.json (src/__tests__/hook-manifest-main.test.ts).
//   - the sub-agent half follows in C3-1b.
//
// Nothing calls this module yet: no settings file is written from it and no
// caller changed (C3-3 makes the sub generator render from it, C3-4 turns the
// main file into a checked artifact). It imports nothing at runtime on purpose,
// so agent-scaffold.ts can import it later without a cycle.
//
// Recorded as found, not fixed: every wrapper spelling, timeout and fail mode
// below is what the settings carry today, including the main/sub differences
// the audit lists. Normalising them is C3-5; the fail-mode policy is C3-2.

import type { ProfileTemplate } from '../profiles.js'

export type HookEvent =
  | 'UserPromptSubmit'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PreToolUse'
  | 'Stop'
  | 'StopFailure'
  | 'SessionStart'
  | 'SessionEnd'
  | 'PreCompact'

export type HookScope = 'main' | 'sub'

/**
 * What happens when the hook itself breaks (script missing, interpreter
 * missing, crash, timeout), recorded per scope as the wrapper does it today:
 *   closed   -- the failure blocks the call (exit 2)
 *   open     -- the failure lets the call through
 *   advisory -- the hook never blocks (a prompt-type hook)
 */
export type FailMode = 'closed' | 'open' | 'advisory'

/**
 * The command spellings in use today. Each one is reproduced byte for byte by
 * renderHooks; `P` is the script path, `D` the gate deadline (timeout - 2, at
 * least 1), the interpreter follows the script extension (.py python3,
 * .mjs node, .sh bash).
 *
 * Main (tracked .claude/settings.json, P = "$CLAUDE_PROJECT_DIR/<script>", quoted):
 *   failOpenExec                  bash -c '[ -f P ] && exec <interp> P [args]; exit 0'
 *   failOpenExecClosedWhenFrozen  failOpenExec, but a missing script blocks while
 *                                 store/fleet-freeze.json exists (fleet-freeze-gate only)
 *   failOpenNodeProbe             bash -c: skip when the script or node is missing, run under
 *                                 `timeout`, pass exit 2 through, everything else exits 0
 *   failClosedRun                 run under `timeout`; any status other than 0 or 2 becomes 2
 *   failClosedRunNodeProbe        `command -v node` probe that blocks, then failClosedRun
 *
 * Sub (agents/<n>/.claude/settings.json, absolute P), rendered from C3-1b on:
 *   failOpenExecUnquoted          failOpenExec with an unquoted absolute path (template)
 *   bare / bareQuoted             `python3 P` with no wrapper, path unquoted / quoted
 *   failClosedPythonProbe         pythonHookCommand(): `command -v python3` probe + failClosedRun
 *   failClosedNodeBin             hookCommand(): `test -x <HOOK_NODE_BIN>` probe + failClosedRun
 *   agentPrompt                   a prompt-type hook (`type: agent`), no command
 */
export type WrapperKind =
  | 'failOpenExec'
  | 'failOpenExecClosedWhenFrozen'
  | 'failOpenNodeProbe'
  | 'failClosedRun'
  | 'failClosedRunNodeProbe'
  | 'failOpenExecUnquoted'
  | 'bare'
  | 'bareQuoted'
  | 'failClosedPythonProbe'
  | 'failClosedNodeBin'
  | 'agentPrompt'

/** The profile switches that opt a sub-agent into a gate (templates/profiles/*.json). */
export type HookProfileFlag = keyof Pick<ProfileTemplate, 'destructiveGate' | 'credentialGate' | 'secondReviewer'>

/** Per-agent conditions that are not profile switches (heartbeat agent, email thread-reply capability, sender-role policy). */
export type HookAgentFlag = 'heartbeat' | 'threadReply' | 'senderRolePolicy'

/** How one scope renders an entry. */
export interface HookSpec {
  /** Events the hook is registered under; the same matcher, args and timeout apply to each. */
  events: readonly HookEvent[]
  /** Absent: the group carries no matcher key. An array: one group per matcher, in this order. */
  matcher?: string | readonly string[]
  /** Extra arguments after the script path (plain flag characters only). */
  args?: readonly string[]
  /** Seconds; absent: the hook object carries no timeout key. */
  timeout?: number
  wrapper: WrapperKind
  failMode: FailMode
}

export interface HookManifestEntry extends HookSpec {
  /**
   * Stable id, referenced by the layout: the script's file name without its
   * extension, the same name the `hook` field of .claude/hooks.metadata.json
   * uses; a second registration of one script with other arguments appends
   * them (marveen-commands-stop).
   */
  id: string
  /** Script path relative to the project root (e.g. scripts/hooks/x.py); for agentPrompt the prompt key. */
  script: string
  scope: HookScope | 'both'
  /** Sub-agents only: the entry is rendered only when the profile sets this switch. */
  profileFlag?: HookProfileFlag
  /** Sub-agents only: the entry is rendered only when the agent has this property. */
  agentFlag?: HookAgentFlag
  /** Where one scope differs from the fields above today. Each override is a recorded main/sub difference. */
  override?: Partial<Record<HookScope, Partial<HookSpec>>>
}

/**
 * Written order per scope: for each event (in the order the settings file has
 * them), the groups in order. A string is one entry: one group per matcher.
 * An array is several entries sharing ONE group (they must have the same
 * matcher). Every (entry, event) of a scope appears exactly once.
 */
export type HookLayout = Partial<Record<HookEvent, ReadonlyArray<string | readonly string[]>>>

export interface HookManifest {
  entries: readonly HookManifestEntry[]
  layout: Partial<Record<HookScope, HookLayout>>
}

export type RenderedHook =
  | { type: 'command'; command: string; timeout?: number }
  | { type: 'agent'; prompt: string; timeout?: number }

export interface RenderedGroup {
  matcher?: string
  hooks: RenderedHook[]
}

export type RenderedHooks = Partial<Record<HookEvent, RenderedGroup[]>>

export interface RenderContext {
  /** Path prefix of every script. Main default: the literal $CLAUDE_PROJECT_DIR. Sub: the absolute project root. */
  root?: string
  /** Sub: the node binary hookCommand() burns in (HOOK_NODE_BIN). */
  nodeBin?: string
  /** Sub: the agent's profile (only the gate switches are read). */
  profile?: Pick<ProfileTemplate, HookProfileFlag>
  /** Sub: per-agent conditions. */
  agent?: { heartbeat?: boolean; threadReply?: boolean; senderRolePolicy?: string | null }
  /** Sub: prompt texts of agentPrompt entries, keyed by the entry's script field. */
  prompts?: Record<string, string>
}

const MAIN_ROOT = '$CLAUDE_PROJECT_DIR'

// ---------------------------------------------------------------------------
// Matchers shared by several entries.

/** The mail tool matchers the main agent's two mail gates are registered under (one group each). */
export const MAIN_MAIL_MATCHERS: readonly string[] = [
  '.*send_email.*',
  '.*manage_email.*',
  '.*[Gg]mail.*__.*',
  '.*draft_email.*',
  '.*send_draft.*|.*update_draft.*|.*create_draft.*|.*reply_all.*|.*send_gmail_message.*|.*draft_gmail_message.*'
    + '|.*[Gg][Mm][Aa][Ii][Ll].*send_message.*|.*[Gg][Mm][Aa][Ii][Ll].*reply.*|.*[Gg][Mm][Aa][Ii][Ll].*forward.*'
    + '|.*send[-_]mail.*|.*send[-_]shared[-_]mailbox[-_]mail.*|.*send[-_]shared[-_]mailbox[-_]draft.*'
    + '|.*send[-_]draft[-_]message.*|.*reply[-_]mail[-_]message.*|.*reply[-_]all[-_]mail[-_]message.*'
    + '|.*forward[-_]mail[-_]message.*|.*reply[-_]shared[-_]mailbox[-_]mail.*|.*reply[-_]all[-_]shared[-_]mailbox[-_]mail.*'
    + '|.*forward[-_]shared[-_]mailbox[-_]mail.*|.*forward[-_]calendar[-_]event.*|.*reply[-_]to[-_]group[-_]thread.*'
    + '|.*draft[-_]email.*|.*create[-_]shared[-_]mailbox[-_]draft.*|.*create[-_]reply[-_]draft.*'
    + '|.*create[-_]reply[-_]all[-_]draft.*|.*create[-_]forward[-_]draft.*|.*create[-_]shared[-_]mailbox[-_]reply[-_]draft.*'
    + '|.*create[-_]shared[-_]mailbox[-_]reply[-_]all[-_]draft.*|.*create[-_]shared[-_]mailbox[-_]forward[-_]draft.*'
    + '|.*update[-_]mail[-_]message.*|.*update[-_]shared[-_]mailbox[-_]message.*',
]

const TELEGRAM_REPLY_EDIT = 'mcp__plugin_telegram_telegram__reply|mcp__plugin_telegram_telegram__edit_message'
const DISCORD_REPLY_EDIT = 'mcp__plugin_discord_discord__reply|mcp__plugin_discord_discord__edit_message'

// ---------------------------------------------------------------------------
// The entries. C3-1a carries the main agent's 41 hooks (56 settings entries:
// three hooks sit under more than one event, the two mail gates under several
// matchers). C3-1b sets scope 'both' where a sub-agent carries the same hook,
// with its differences as `override.sub`, and adds the sub-only entries.

const open = { wrapper: 'failOpenExec', failMode: 'open' } as const

export const HOOK_MANIFEST_ENTRIES: readonly HookManifestEntry[] = [
  // UserPromptSubmit
  { id: 'ledger-capture', script: 'scripts/hooks/ledger-capture.py', scope: 'main', events: ['UserPromptSubmit'], timeout: 15, ...open },
  { id: 'inbox-drain', script: 'scripts/hooks/inbox-drain.py', scope: 'main', events: ['UserPromptSubmit'], timeout: 15, ...open },
  { id: 'telegram-reply-directive', script: 'scripts/hooks/telegram-reply-directive.py', scope: 'main', events: ['UserPromptSubmit'], timeout: 10, ...open },
  { id: 'provenance-gate', script: 'scripts/hooks/provenance-gate.py', scope: 'main', events: ['UserPromptSubmit'], timeout: 10, ...open },
  { id: 'staleness-guard', script: 'scripts/hooks/staleness-guard.py', scope: 'main', events: ['UserPromptSubmit'], timeout: 10, ...open },
  { id: 'memory-lookup-nudge', script: 'scripts/hooks/memory-lookup-nudge.py', scope: 'main', events: ['UserPromptSubmit'], timeout: 3, ...open },
  { id: 'channel-inbox-drain', script: 'scripts/hooks/channel-inbox-drain.py', scope: 'main', events: ['UserPromptSubmit'], timeout: 5, ...open },
  { id: 'voice-reply-directive', script: 'scripts/hooks/voice-reply-directive.py', scope: 'main', events: ['UserPromptSubmit'], timeout: 180, ...open },
  { id: 'telegram_progress', script: 'scripts/hooks/telegram_progress.py', scope: 'main', events: ['UserPromptSubmit'], timeout: 15, ...open },
  { id: 'slack_progress', script: 'scripts/hooks/slack_progress.py', scope: 'main', events: ['UserPromptSubmit'], timeout: 15, ...open },
  { id: 'marveen-commands', script: 'scripts/hooks/marveen-commands.py', scope: 'main', events: ['UserPromptSubmit'], timeout: 45, ...open },
  { id: 'taskstate-stub', script: 'scripts/hooks/taskstate-stub.py', scope: 'main', events: ['UserPromptSubmit'], timeout: 10, ...open },
  { id: 'directive-verify', script: 'scripts/hooks/directive-verify.py', scope: 'main', events: ['UserPromptSubmit'], timeout: 10, ...open },

  // PostToolUse / PostToolUseFailure
  { id: 'ledger-outbound', script: 'scripts/hooks/ledger-outbound.py', scope: 'main', events: ['PostToolUse'], matcher: 'mcp__plugin_[^_]+_[^_]+__reply', timeout: 15, ...open },
  { id: 'tool-log-capture', script: 'scripts/hooks/tool-log-capture.py', scope: 'main', events: ['PostToolUse', 'PostToolUseFailure'], timeout: 5, ...open },
  { id: 'persona-change-notify', script: 'scripts/hooks/persona-change-notify.py', scope: 'main', events: ['PostToolUse'], timeout: 15, ...open },
  { id: 'telegram_progress_reply_clear', script: 'scripts/hooks/telegram_progress_reply_clear.py', scope: 'main', events: ['PostToolUse'], matcher: 'telegram.*reply', timeout: 15, ...open },
  { id: 'browser-content-notice', script: 'scripts/hooks/browser-content-notice.py', scope: 'main', events: ['PostToolUse'], matcher: 'WebSearch|WebFetch', timeout: 10, ...open },
  { id: 'slack_progress_reply_clear', script: 'scripts/hooks/slack_progress_reply_clear.py', scope: 'main', events: ['PostToolUse'], matcher: 'slack.*reply', timeout: 15, ...open },
  { id: 'skill-usage-capture', script: 'scripts/hooks/skill-usage-capture.py', scope: 'main', events: ['PostToolUse'], matcher: 'Skill|Read', timeout: 10, ...open },
  { id: 'memory-frontmatter-bash-gate', script: 'scripts/hooks/memory-frontmatter-bash-gate.py', scope: 'main', events: ['PostToolUse', 'PostToolUseFailure', 'PreToolUse'], matcher: 'Bash', timeout: 10, ...open },

  // PreToolUse
  // Fail-open while the fleet runs; a missing script blocks only while frozen,
  // the one state in which this gate stops anything.
  { id: 'fleet-freeze-gate', script: 'scripts/hooks/fleet-freeze-gate.sh', scope: 'main', events: ['PreToolUse'], matcher: '*', timeout: 5, wrapper: 'failOpenExecClosedWhenFrozen', failMode: 'closed' },
  { id: 'outgoing-copy-gate', script: 'scripts/hooks/outgoing-copy-gate.py', scope: 'main', events: ['PreToolUse'], matcher: ['Bash', ...MAIN_MAIL_MATCHERS, TELEGRAM_REPLY_EDIT, DISCORD_REPLY_EDIT], timeout: 15, wrapper: 'failClosedRun', failMode: 'closed' },
  { id: 'email-approval-gate', script: 'scripts/hooks/email-approval-gate.py', scope: 'main', events: ['PreToolUse'], matcher: ['Bash', ...MAIN_MAIL_MATCHERS], timeout: 10, wrapper: 'failClosedRun', failMode: 'closed' },
  { id: 'channel-image-resize', script: 'scripts/hooks/channel-image-resize.sh', scope: 'main', events: ['PreToolUse'], matcher: 'Read', timeout: 15, ...open },
  { id: 'egress-gate', script: 'scripts/hooks/egress-gate.mjs', scope: 'main', events: ['PreToolUse'], matcher: 'WebFetch', timeout: 10, wrapper: 'failClosedRunNodeProbe', failMode: 'closed' },
  { id: 'memory-frontmatter-gate', script: 'scripts/hooks/memory-frontmatter-gate.py', scope: 'main', events: ['PreToolUse'], matcher: 'Write|Edit|MultiEdit', timeout: 10, ...open },
  { id: 'db-write-gate', script: 'scripts/hooks/db-write-gate.mjs', scope: 'main', events: ['PreToolUse'], matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', timeout: 10, wrapper: 'failClosedRunNodeProbe', failMode: 'closed' },
  { id: 'shell-rescan-guard', script: 'scripts/hooks/shell-rescan-guard.py', scope: 'main', events: ['PreToolUse'], matcher: 'Bash', timeout: 10, ...open },
  { id: 'child-claude-channel-guard', script: 'scripts/hooks/child-claude-channel-guard.mjs', scope: 'main', events: ['PreToolUse'], matcher: 'Bash', timeout: 10, wrapper: 'failOpenNodeProbe', failMode: 'open' },
  { id: 'token-argv-guard', script: 'scripts/hooks/token-argv-guard.py', scope: 'main', events: ['PreToolUse'], matcher: 'Bash', timeout: 10, ...open },

  // Stop / StopFailure
  { id: 'telegram-reply-guard', script: 'scripts/hooks/telegram-reply-guard.py', scope: 'main', events: ['Stop'], timeout: 10, ...open },
  { id: 'telegram_progress_clear', script: 'scripts/hooks/telegram_progress_clear.py', scope: 'main', events: ['Stop'], timeout: 15, ...open },
  { id: 'slack_progress_clear', script: 'scripts/hooks/slack_progress_clear.py', scope: 'main', events: ['Stop'], timeout: 15, ...open },
  { id: 'marveen-commands-stop', script: 'scripts/hooks/marveen-commands.py', scope: 'main', events: ['Stop'], args: ['--stop'], timeout: 10, ...open },
  { id: 'ledger-turn-failure', script: 'scripts/hooks/ledger-turn-failure.py', scope: 'main', events: ['StopFailure'], timeout: 10, ...open },

  // SessionStart / SessionEnd
  { id: 'ledger-replay', script: 'scripts/hooks/ledger-replay.py', scope: 'main', events: ['SessionStart'], matcher: 'startup|resume|clear', timeout: 15, ...open },
  { id: 'taskstate-replay', script: 'scripts/hooks/taskstate-replay.py', scope: 'main', events: ['SessionStart'], matcher: 'compact|resume|clear', timeout: 15, ...open },
  { id: 'clear-replay', script: 'scripts/hooks/clear-replay.py', scope: 'main', events: ['SessionStart'], matcher: 'clear', timeout: 15, ...open },
  { id: 'marveen-commands-session-start', script: 'scripts/hooks/marveen-commands.py', scope: 'main', events: ['SessionStart'], args: ['--session-start'], timeout: 10, ...open },
  { id: 'clear-capture', script: 'scripts/hooks/clear-capture.py', scope: 'main', events: ['SessionEnd'], timeout: 15, ...open },
]

// The main agent's written order (tracked .claude/settings.json). Every group
// there holds exactly one hook, so each slot is a single id.
const MAIN_LAYOUT: HookLayout = {
  UserPromptSubmit: [
    'ledger-capture', 'inbox-drain', 'telegram-reply-directive', 'provenance-gate', 'staleness-guard',
    'memory-lookup-nudge', 'channel-inbox-drain', 'voice-reply-directive', 'telegram_progress', 'slack_progress',
    'marveen-commands', 'taskstate-stub', 'directive-verify',
  ],
  PostToolUse: [
    'ledger-outbound', 'tool-log-capture', 'persona-change-notify', 'telegram_progress_reply_clear',
    'browser-content-notice', 'slack_progress_reply_clear', 'skill-usage-capture', 'memory-frontmatter-bash-gate',
  ],
  PostToolUseFailure: ['tool-log-capture', 'memory-frontmatter-bash-gate'],
  PreToolUse: [
    'fleet-freeze-gate', 'outgoing-copy-gate', 'email-approval-gate', 'channel-image-resize', 'egress-gate',
    'memory-frontmatter-gate', 'memory-frontmatter-bash-gate', 'db-write-gate', 'shell-rescan-guard',
    'child-claude-channel-guard', 'token-argv-guard',
  ],
  Stop: ['telegram-reply-guard', 'telegram_progress_clear', 'slack_progress_clear', 'marveen-commands-stop'],
  StopFailure: ['ledger-turn-failure'],
  SessionStart: ['ledger-replay', 'taskstate-replay', 'clear-replay', 'marveen-commands-session-start'],
  SessionEnd: ['clear-capture'],
}

export const HOOK_MANIFEST: HookManifest = {
  entries: HOOK_MANIFEST_ENTRIES,
  layout: { main: MAIN_LAYOUT },
}

// ---------------------------------------------------------------------------
// Rendering.
//
// TEMPORARY DUPLICATE: the wrapper strings below repeat what the builders in
// agent-scaffold.ts (hookCommand, pythonHookCommand, failClosedGateRun,
// gateDeadlineSec) and the hand-written main settings spell today. They are
// copied, not imported, because agent-scaffold.ts will import this module in
// C3-3 and the reverse import would be a cycle. C3-3 is where the builders and
// these strings become one implementation; until then the deep-equal tests
// against the real outputs are what keep the two copies identical.

const SCRIPT_RE = /^scripts\/[A-Za-z0-9_./-]+\.(py|mjs|sh)$/
const ARG_RE = /^[A-Za-z0-9_=.:-]+$/
const GATE_FAIL_CLOSED_TAG = 'governance-kapu (fail-closed)'
const FLEET_FREEZE_MARKER = 'store/fleet-freeze.json'
const FLEET_FREEZE_MISSING_MSG = 'fleet-freeze-gate (fail-closed while frozen): the gate script is missing and '
  + 'store/fleet-freeze.json exists, so every tool call is blocked. Fix: restore scripts/hooks/fleet-freeze-gate.sh '
  + 'or unfreeze from the dashboard.'
const MAIN_NODE_MISSING_MSG = 'governance-kapu: node interpreter hianyzik, a kapu BLOKKOL'

function interpreterFor(script: string): string {
  if (script.endsWith('.py')) return 'python3'
  if (script.endsWith('.mjs')) return 'node'
  if (script.endsWith('.sh')) return 'bash'
  throw new Error(`hook manifest: no interpreter for ${script}`)
}

function gateDeadline(timeout: number): number {
  return Math.max(1, Math.floor(timeout) - 2)
}

function basenameOf(script: string): string {
  return script.slice(script.lastIndexOf('/') + 1)
}

/** The run-and-map tail of a fail-closed gate: 0 and 2 pass through, any other status blocks. */
function failClosedRun(invocation: string, label: string, timeout: number): string {
  const fail = `${GATE_FAIL_CLOSED_TAG}: ${label}: a kapu nem 0-val vagy 2-vel lepett ki (rc=$rc: betoltesi hiba, hianyzo fajl, `
    + 'jel vagy idotullepes). A hivas ezert TILTVA. Javitas: a kapu fajlja vagy egy fuggosege hibas, a hibauzenet fent.'
  return `if command -v timeout >/dev/null 2>&1; then timeout -k 1 ${gateDeadline(timeout)} ${invocation}; else ${invocation}; fi; `
    + `rc=$?; [ "$rc" = 0 ] || [ "$rc" = 2 ] || { echo "${fail}" >&2; exit 2; }; exit "$rc"`
}

function mainCommand(spec: HookSpec, script: string, root: string): string {
  const p = `"${root}/${script}"`
  const interp = interpreterFor(script)
  const args = (spec.args ?? []).map((a) => ` ${a}`).join('')
  const timeout = requireTimeout(spec, script)
  switch (spec.wrapper) {
    case 'failOpenExec':
      return `bash -c '[ -f ${p} ] && exec ${interp} ${p}${args}; exit 0'`
    case 'failOpenExecClosedWhenFrozen':
      return `bash -c '[ -f ${p} ] && exec ${interp} ${p}${args}; [ -e "${root}/${FLEET_FREEZE_MARKER}" ] && `
        + `{ echo "${FLEET_FREEZE_MISSING_MSG}" >&2; exit 2; }; exit 0'`
    case 'failOpenNodeProbe': {
      const inv = `${interp} ${p}${args}`
      return `bash -c '[ -f ${p} ] && command -v ${interp} >/dev/null 2>&1 || exit 0; if command -v timeout >/dev/null 2>&1; `
        + `then timeout -k 1 ${gateDeadline(timeout)} ${inv}; else ${inv}; fi; [ $? = 2 ] && exit 2; exit 0'`
    }
    case 'failClosedRun':
      return failClosedRun(`${interp} ${p}${args}`, basenameOf(script), timeout)
    case 'failClosedRunNodeProbe':
      return `command -v node >/dev/null 2>&1 || { echo "${MAIN_NODE_MISSING_MSG}" >&2; exit 2; }; `
        + failClosedRun(`node ${p}${args}`, basenameOf(script), timeout)
    default:
      throw new Error(`hook manifest: wrapper ${spec.wrapper} is not a main-agent spelling (${script})`)
  }
}

function requireTimeout(spec: HookSpec, script: string): number {
  if (spec.timeout === undefined) throw new Error(`hook manifest: ${script} needs a timeout for wrapper ${spec.wrapper}`)
  return spec.timeout
}

/** The spec one scope renders: the entry's own fields with that scope's override applied. */
export function specFor(entry: HookManifestEntry, scope: HookScope): HookSpec {
  const o = entry.override?.[scope] ?? {}
  return {
    events: o.events ?? entry.events,
    matcher: 'matcher' in o ? o.matcher : entry.matcher,
    args: 'args' in o ? o.args : entry.args,
    timeout: 'timeout' in o ? o.timeout : entry.timeout,
    wrapper: o.wrapper ?? entry.wrapper,
    failMode: o.failMode ?? entry.failMode,
  }
}

function inScope(entry: HookManifestEntry, scope: HookScope): boolean {
  return entry.scope === scope || entry.scope === 'both'
}

function matchersOf(spec: HookSpec): Array<string | undefined> {
  if (spec.matcher === undefined) return [undefined]
  return typeof spec.matcher === 'string' ? [spec.matcher] : [...spec.matcher]
}

/**
 * Structural check of a manifest for one scope; throws on the first problem.
 * Ids unique, script paths and args plain, every layout slot names an entry of
 * this scope that is registered under that event, and every (entry, event) of
 * the scope is placed exactly once.
 */
export function validateManifest(m: HookManifest, scope: HookScope): void {
  const byId = new Map<string, HookManifestEntry>()
  for (const e of m.entries) {
    if (byId.has(e.id)) throw new Error(`hook manifest: duplicate id ${e.id}`)
    byId.set(e.id, e)
    const spec = specFor(e, scope)
    if (spec.wrapper !== 'agentPrompt' && !SCRIPT_RE.test(e.script)) throw new Error(`hook manifest: bad script path ${e.script}`)
    for (const a of spec.args ?? []) if (!ARG_RE.test(a)) throw new Error(`hook manifest: ${e.id}: argument needs quoting: ${a}`)
    if (spec.timeout !== undefined && !(Number.isInteger(spec.timeout) && spec.timeout > 0)) {
      throw new Error(`hook manifest: ${e.id}: timeout must be a positive integer`)
    }
    if (Array.isArray(spec.matcher) && spec.matcher.length === 0) throw new Error(`hook manifest: ${e.id}: empty matcher list`)
  }
  const layout = m.layout[scope]
  if (!layout) throw new Error(`hook manifest: no layout for scope ${scope}`)
  const placed = new Set<string>()
  for (const [event, groups] of Object.entries(layout) as Array<[HookEvent, ReadonlyArray<string | readonly string[]>]>) {
    for (const slot of groups) {
      const ids = typeof slot === 'string' ? [slot] : slot
      if (ids.length === 0) throw new Error(`hook manifest: empty group under ${event}`)
      const matchers = new Set<string>()
      for (const id of ids) {
        const e = byId.get(id)
        if (!e) throw new Error(`hook manifest: layout ${scope}.${event} names unknown id ${id}`)
        if (!inScope(e, scope)) throw new Error(`hook manifest: layout ${scope}.${event} names ${id}, which is not in scope ${scope}`)
        const spec = specFor(e, scope)
        if (!spec.events.includes(event)) throw new Error(`hook manifest: ${id} is not registered under ${event}`)
        const key = `${id}\u0000${event}`
        if (placed.has(key)) throw new Error(`hook manifest: ${id} placed twice under ${scope}.${event}`)
        placed.add(key)
        matchers.add(JSON.stringify(spec.matcher ?? null))
      }
      if (ids.length > 1 && (matchers.size > 1 || ids.some((id) => Array.isArray(specFor(byId.get(id)!, scope).matcher)))) {
        throw new Error(`hook manifest: group [${ids.join(', ')}] under ${event} mixes matchers`)
      }
    }
  }
  for (const e of m.entries) {
    if (!inScope(e, scope)) continue
    for (const event of specFor(e, scope).events) {
      if (!placed.has(`${e.id}\u0000${event}`)) throw new Error(`hook manifest: ${e.id} (${event}) has no place in the ${scope} layout`)
    }
  }
}

/**
 * The `hooks` object one scope's settings carry, in written order. Pure: no
 * file is read or written.
 *
 * C3-1a renders the main scope only; the sub scope (template merge + gate
 * injectors, profile and agent conditions) is C3-1b and throws until then.
 */
export function renderHooks(m: HookManifest, scope: HookScope, ctx: RenderContext = {}): RenderedHooks {
  if (scope !== 'main') throw new Error('hook manifest: the sub-agent render is not implemented yet (C3-1b)')
  validateManifest(m, scope)
  const root = ctx.root ?? MAIN_ROOT
  const byId = new Map(m.entries.map((e) => [e.id, e] as const))
  const out: RenderedHooks = {}
  for (const [event, groups] of Object.entries(m.layout[scope] ?? {}) as Array<[HookEvent, ReadonlyArray<string | readonly string[]>]>) {
    const rendered: RenderedGroup[] = []
    for (const slot of groups) {
      const ids = typeof slot === 'string' ? [slot] : slot
      const first = specFor(byId.get(ids[0])!, scope)
      for (const matcher of matchersOf(first)) {
        const hooks = ids.map((id): RenderedHook => {
          const e = byId.get(id)!
          const spec = specFor(e, scope)
          const command = mainCommand(spec, e.script, root)
          return spec.timeout === undefined ? { type: 'command', command } : { type: 'command', command, timeout: spec.timeout }
        })
        rendered.push(matcher === undefined ? { hooks } : { matcher, hooks })
      }
    }
    out[event] = rendered
  }
  return out
}
