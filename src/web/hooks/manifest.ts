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
//   - renderHooks(HOOK_MANIFEST, 'sub', ctx) deep-equals what the real code
//     path (template seed, create, boot backfill, spawn) writes for a probe
//     agent, per profile and per gate condition
//     (src/__tests__/hook-manifest-sub.test.ts).
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
 *
 * One named case: the main agent's fleet-freeze-gate is recorded `closed`,
 * but its wrapper lets a missing script through while the fleet runs and
 * blocks only while store/fleet-freeze.json exists, the one state in which
 * the gate stops anything. So `closed` there means "closed while frozen", not
 * the failClosedRun behaviour (any broken gate blocks, always).
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
 * Sub (agents/<n>/.claude/settings.json, absolute P):
 *   failOpenExecUnquoted          failOpenExec with an unquoted absolute path (template)
 *   bare / bareQuoted             `python3 P` with no wrapper, path unquoted / quoted; only on
 *                                 events where no exit status blocks a call (see FailMode below)
 *   failClosedPythonProbe         pythonHookCommand(): `command -v python3` probe + failClosedRun
 *   failClosedNodeBin             hookCommand(): `test -x <HOOK_NODE_BIN>` probe + failClosedRun
 *   agentPrompt                   a prompt-type hook (`type: agent`), no command
 *
 * `bare` is recorded `open`: a crash (1) or a missing interpreter (127) does not
 * block, and the 2 python3 gives for a missing script reaches only events that
 * cannot block a call (SessionStart, SessionEnd, PostToolUse after the tool ran).
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

/**
 * Per-agent conditions that are not profile switches: the heartbeat agent, and
 * an agent with a sender-role policy (the policy rides on the command as the
 * last argument). The email thread-reply capability changes arguments only,
 * see HookManifestEntry.threadReplyArgs.
 */
export type HookAgentFlag = 'heartbeat' | 'senderRolePolicy'

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
  /**
   * Seconds the fail-closed wrapper's own deadline is computed from (minus 2),
   * where the command was built with another value than `timeout`. No entry
   * sets it today: second-reviewer-gate did (10, its gate cut at 8 s inside a
   * 180 s hook) until its builder passed the hook's own timeout.
   */
  wrapperTimeout?: number
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
  /** Sub-agents only: arguments appended when the agent has the email thread-reply capability. */
  threadReplyArgs?: readonly string[]
  /** Where one scope differs from the fields above today. Each override is a recorded main/sub difference. */
  override?: Partial<Record<HookScope, Partial<HookSpec>>>
  /**
   * false: a hook some agents carry today that no code path writes (added by
   * hand). Recorded by name so a generator cannot drop it unnoticed, never
   * rendered, never placed in a layout; `perAgent` says who carries it and how.
   */
  rendered?: false
  /** rendered:false only: the agents carrying the hook today; timeout absent = the hook has no timeout key. */
  perAgent?: Readonly<Record<string, { timeout?: number }>>
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
  /**
   * Path prefix of every script. Main default: the literal $CLAUDE_PROJECT_DIR.
   * Sub (required): the absolute project root. Plain path characters only, it
   * lands inside a single-quoted bash -c string.
   */
  root?: string
  /** Sub (required): the node binary hookCommand() burns in (HOOK_NODE_BIN); plain path characters only. */
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

/** The sub-agents' email gate matcher (EMAIL_GATE_MATCHER): Bash plus the main agent's mail matchers, as ONE group. */
const SUB_EMAIL_MATCHER = ['Bash', ...MAIN_MAIL_MATCHERS].join('|')

// ---------------------------------------------------------------------------
// The entries. Scope 'both' where the main agent and the sub-agents carry the
// same script under the same event; `override.sub` is then the recorded
// difference (C3-5 removes those, here every one stays as found). Main: 41
// entries, 56 settings entries (three hooks sit under more than one event, the
// two mail gates under several matchers). Sub: 42 rendered entries, 36 of them
// unconditional (39 settings entries on every sub-agent today), 6 behind a
// profile switch or an agent property, plus one recorded but not rendered.

const open = { wrapper: 'failOpenExec', failMode: 'open' } as const
/** The template's spelling of a fail-open hook on the sub-agents. */
const subOpen = { sub: { wrapper: 'failOpenExecUnquoted' } } as const
/** hookCommand() / pythonHookCommand() gates, sub-agents only. */
const nodeGate = { scope: 'sub', timeout: 10, wrapper: 'failClosedNodeBin', failMode: 'closed' } as const
const pythonGate = { scope: 'sub', timeout: 10, wrapper: 'failClosedPythonProbe', failMode: 'closed' } as const

export const HOOK_MANIFEST_ENTRIES: readonly HookManifestEntry[] = [
  // UserPromptSubmit
  { id: 'ledger-capture', script: 'scripts/hooks/ledger-capture.py', scope: 'main', events: ['UserPromptSubmit'], timeout: 15, ...open },
  { id: 'inbox-drain', script: 'scripts/hooks/inbox-drain.py', scope: 'main', events: ['UserPromptSubmit'], timeout: 15, ...open },
  { id: 'telegram-reply-directive', script: 'scripts/hooks/telegram-reply-directive.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 10, ...open, override: subOpen },
  { id: 'provenance-gate', script: 'scripts/hooks/provenance-gate.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 10, ...open, override: subOpen },
  { id: 'staleness-guard', script: 'scripts/hooks/staleness-guard.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 10, ...open, override: subOpen },
  { id: 'memory-lookup-nudge', script: 'scripts/hooks/memory-lookup-nudge.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 3, ...open, override: subOpen },
  { id: 'channel-inbox-drain', script: 'scripts/hooks/channel-inbox-drain.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 5, ...open, override: subOpen },
  { id: 'voice-reply-directive', script: 'scripts/hooks/voice-reply-directive.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 180, ...open, override: { sub: { wrapper: 'failOpenExecUnquoted', timeout: 60 } } },
  { id: 'telegram_progress', script: 'scripts/hooks/telegram_progress.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 15, ...open, override: subOpen },
  { id: 'slack_progress', script: 'scripts/hooks/slack_progress.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 15, ...open, override: subOpen },
  { id: 'marveen-commands', script: 'scripts/hooks/marveen-commands.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 45, ...open, override: subOpen },
  { id: 'taskstate-stub', script: 'scripts/hooks/taskstate-stub.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 10, ...open, override: subOpen },
  { id: 'directive-verify', script: 'scripts/hooks/directive-verify.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 10, ...open, override: subOpen },

  // PostToolUse / PostToolUseFailure
  { id: 'ledger-outbound', script: 'scripts/hooks/ledger-outbound.py', scope: 'main', events: ['PostToolUse'], matcher: 'mcp__plugin_[^_]+_[^_]+__reply', timeout: 15, ...open },
  { id: 'tool-log-capture', script: 'scripts/hooks/tool-log-capture.py', scope: 'both', events: ['PostToolUse', 'PostToolUseFailure'], timeout: 5, ...open, override: { sub: { wrapper: 'failOpenExecUnquoted', matcher: '*', timeout: 10 } } },
  { id: 'persona-change-notify', script: 'scripts/hooks/persona-change-notify.py', scope: 'main', events: ['PostToolUse'], timeout: 15, ...open },
  { id: 'telegram_progress_reply_clear', script: 'scripts/hooks/telegram_progress_reply_clear.py', scope: 'both', events: ['PostToolUse'], matcher: 'telegram.*reply', timeout: 15, ...open, override: subOpen },
  { id: 'browser-content-notice', script: 'scripts/hooks/browser-content-notice.py', scope: 'both', events: ['PostToolUse'], matcher: 'WebSearch|WebFetch', timeout: 10, ...open, override: { sub: { wrapper: 'bareQuoted' } } },
  // Hand-added on five sub-agents (skill playwright-mcp-agens), written by no code path. Measured
  // 2026-11-07 23:17 on the live files: bella and lilla without a timeout, kevin, margot, tom with 10.
  // C3-3 renders it behind a browser capability flag; until then it is data only.
  {
    id: 'browser-content-notice-playwright', script: 'scripts/hooks/browser-content-notice.py', scope: 'sub', events: ['PostToolUse'],
    matcher: 'mcp__playwright__browser_.*', wrapper: 'bare', failMode: 'open', rendered: false,
    perAgent: { bella: {}, kevin: { timeout: 10 }, lilla: {}, margot: { timeout: 10 }, tom: { timeout: 10 } },
  },
  { id: 'slack_progress_reply_clear', script: 'scripts/hooks/slack_progress_reply_clear.py', scope: 'both', events: ['PostToolUse'], matcher: 'slack.*reply', timeout: 15, ...open, override: subOpen },
  { id: 'skill-usage-capture', script: 'scripts/hooks/skill-usage-capture.py', scope: 'both', events: ['PostToolUse'], matcher: 'Skill|Read', timeout: 10, ...open, override: subOpen },
  { id: 'memory-frontmatter-bash-gate', script: 'scripts/hooks/memory-frontmatter-bash-gate.py', scope: 'both', events: ['PostToolUse', 'PostToolUseFailure', 'PreToolUse'], matcher: 'Bash', timeout: 10, ...open, override: subOpen },

  // PreToolUse
  // Main: fail-open while the fleet runs; a missing script blocks only while
  // frozen, the one state in which this gate stops anything. Sub: plain fail-open.
  { id: 'fleet-freeze-gate', script: 'scripts/hooks/fleet-freeze-gate.sh', scope: 'both', events: ['PreToolUse'], matcher: '*', timeout: 5, wrapper: 'failOpenExecClosedWhenFrozen', failMode: 'closed', override: { sub: { wrapper: 'failOpenExecUnquoted', failMode: 'open' } } },
  { id: 'outgoing-copy-gate', script: 'scripts/hooks/outgoing-copy-gate.py', scope: 'both', events: ['PreToolUse'], matcher: ['Bash', ...MAIN_MAIL_MATCHERS, TELEGRAM_REPLY_EDIT, DISCORD_REPLY_EDIT], timeout: 15, wrapper: 'failClosedRun', failMode: 'closed', override: { sub: { matcher: TELEGRAM_REPLY_EDIT, timeout: 10, wrapper: 'failClosedPythonProbe' } } },
  { id: 'email-approval-gate', script: 'scripts/hooks/email-approval-gate.py', scope: 'main', events: ['PreToolUse'], matcher: ['Bash', ...MAIN_MAIL_MATCHERS], timeout: 10, wrapper: 'failClosedRun', failMode: 'closed' },
  { id: 'channel-image-resize', script: 'scripts/hooks/channel-image-resize.sh', scope: 'both', events: ['PreToolUse'], matcher: 'Read', timeout: 15, ...open, override: subOpen },
  { id: 'egress-gate', script: 'scripts/hooks/egress-gate.mjs', scope: 'both', events: ['PreToolUse'], matcher: 'WebFetch', timeout: 10, wrapper: 'failClosedRunNodeProbe', failMode: 'closed', override: { sub: { wrapper: 'failClosedNodeBin' } } },
  { id: 'memory-frontmatter-gate', script: 'scripts/hooks/memory-frontmatter-gate.py', scope: 'both', events: ['PreToolUse'], matcher: 'Write|Edit|MultiEdit', timeout: 10, ...open, override: subOpen },
  { id: 'db-write-gate', script: 'scripts/hooks/db-write-gate.mjs', scope: 'both', events: ['PreToolUse'], matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', timeout: 10, wrapper: 'failClosedRunNodeProbe', failMode: 'closed', override: { sub: { wrapper: 'failClosedNodeBin' } } },
  { id: 'shell-rescan-guard', script: 'scripts/hooks/shell-rescan-guard.py', scope: 'both', events: ['PreToolUse'], matcher: 'Bash', timeout: 10, ...open, override: subOpen },
  { id: 'child-claude-channel-guard', script: 'scripts/hooks/child-claude-channel-guard.mjs', scope: 'both', events: ['PreToolUse'], matcher: 'Bash', timeout: 10, wrapper: 'failOpenNodeProbe', failMode: 'open', override: { sub: { wrapper: 'failClosedNodeBin', failMode: 'closed' } } },
  { id: 'token-argv-guard', script: 'scripts/hooks/token-argv-guard.py', scope: 'both', events: ['PreToolUse'], matcher: 'Bash', timeout: 10, ...open, override: subOpen },
  { id: 'email-send-gate', script: 'scripts/email-send-gate.mjs', events: ['PreToolUse'], matcher: SUB_EMAIL_MATCHER, threadReplyArgs: ['--allow-thread-reply'], ...nodeGate },
  { id: 'self-pace-gate', script: 'scripts/self-pace-gate.mjs', events: ['PreToolUse'], matcher: 'ScheduleWakeup|CronCreate|CronDelete|CronList|RemoteTrigger|Bash|Write|Edit|NotebookEdit', ...nodeGate },
  { id: 'kanban-write-gate', script: 'scripts/kanban-write-gate.mjs', events: ['PreToolUse'], matcher: 'Bash', agentFlag: 'heartbeat', ...nodeGate },
  { id: 'digest-provenance-gate', script: 'scripts/digest-provenance-gate.mjs', events: ['PreToolUse'], matcher: 'Bash', agentFlag: 'heartbeat', ...nodeGate },
  { id: 'sender-role-gate', script: 'scripts/hooks/sender-role-gate.py', events: ['PreToolUse'], matcher: '*', args: ['--policy'], agentFlag: 'senderRolePolicy', ...pythonGate },
  { id: 'destructive-gate', script: 'scripts/hooks/destructive-gate.py', events: ['PreToolUse'], matcher: 'Bash|Read|Edit|Write|NotebookEdit', profileFlag: 'destructiveGate', ...pythonGate },
  { id: 'credential-gate', script: 'scripts/hooks/credential-gate.py', events: ['PreToolUse'], matcher: SUB_EMAIL_MATCHER, profileFlag: 'credentialGate', ...pythonGate },
  { id: 'second-reviewer-gate', script: 'scripts/hooks/second-reviewer-gate.py', events: ['PreToolUse'], matcher: 'Bash|mcp__.*', profileFlag: 'secondReviewer', ...pythonGate, timeout: 180 },
  { id: 'bash-egress-parser', script: 'scripts/hooks/bash-egress-parser.mjs', events: ['PreToolUse'], matcher: 'Bash', ...nodeGate },

  // Stop / StopFailure
  { id: 'telegram-reply-guard', script: 'scripts/hooks/telegram-reply-guard.py', scope: 'main', events: ['Stop'], timeout: 10, ...open },
  { id: 'telegram_progress_clear', script: 'scripts/hooks/telegram_progress_clear.py', scope: 'both', events: ['Stop'], timeout: 15, ...open, override: subOpen },
  { id: 'slack_progress_clear', script: 'scripts/hooks/slack_progress_clear.py', scope: 'both', events: ['Stop'], timeout: 15, ...open, override: subOpen },
  { id: 'marveen-commands-stop', script: 'scripts/hooks/marveen-commands.py', scope: 'both', events: ['Stop'], args: ['--stop'], timeout: 10, ...open, override: subOpen },
  { id: 'ledger-turn-failure', script: 'scripts/hooks/ledger-turn-failure.py', scope: 'main', events: ['StopFailure'], timeout: 10, ...open },

  // SessionStart / SessionEnd / PreCompact
  { id: 'ledger-replay', script: 'scripts/hooks/ledger-replay.py', scope: 'main', events: ['SessionStart'], matcher: 'startup|resume|clear', timeout: 15, ...open },
  { id: 'taskstate-replay', script: 'scripts/hooks/taskstate-replay.py', scope: 'both', events: ['SessionStart'], matcher: 'compact|resume|clear', timeout: 15, ...open, override: { sub: { wrapper: 'bare' } } },
  { id: 'clear-replay', script: 'scripts/hooks/clear-replay.py', scope: 'both', events: ['SessionStart'], matcher: 'clear', timeout: 15, ...open, override: { sub: { wrapper: 'bare' } } },
  { id: 'marveen-commands-session-start', script: 'scripts/hooks/marveen-commands.py', scope: 'main', events: ['SessionStart'], args: ['--session-start'], timeout: 10, ...open },
  { id: 'clear-capture', script: 'scripts/hooks/clear-capture.py', scope: 'both', events: ['SessionEnd'], timeout: 15, ...open, override: { sub: { wrapper: 'bare' } } },
  // The prompt text (about 3 KB, from templates/settings.json.template) is passed in by the caller.
  { id: 'precompact', script: 'precompact', scope: 'sub', events: ['PreCompact'], matcher: 'auto', timeout: 180, wrapper: 'agentPrompt', failMode: 'advisory' },
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

// A sub-agent's written order as the real code path leaves it after the first
// spawn: the template's events and groups (templates/settings.json.template),
// then the gates in the order writeAgentSettingsFromProfile injects them (each
// injector drops its old entry and appends). Conditional entries hold their
// place and are skipped when off. The live files carry older orders and
// groupings (history); the C3-3 gate compares them as flattened multisets.
const SUB_LAYOUT: HookLayout = {
  PreCompact: ['precompact'],
  SessionStart: ['taskstate-replay', 'clear-replay'],
  SessionEnd: ['clear-capture'],
  PostToolUse: [
    'skill-usage-capture', 'tool-log-capture', 'telegram_progress_reply_clear', 'slack_progress_reply_clear',
    'memory-frontmatter-bash-gate', 'browser-content-notice',
  ],
  PostToolUseFailure: ['tool-log-capture', 'memory-frontmatter-bash-gate'],
  UserPromptSubmit: [[
    'staleness-guard', 'taskstate-stub', 'provenance-gate', 'memory-lookup-nudge', 'channel-inbox-drain',
    'voice-reply-directive', 'telegram-reply-directive', 'marveen-commands', 'telegram_progress', 'slack_progress',
    'directive-verify',
  ]],
  PreToolUse: [
    'fleet-freeze-gate', 'channel-image-resize', 'memory-frontmatter-gate', 'memory-frontmatter-bash-gate',
    'shell-rescan-guard', 'token-argv-guard',
    'email-send-gate', 'self-pace-gate', 'db-write-gate', 'kanban-write-gate', 'digest-provenance-gate',
    'outgoing-copy-gate', 'sender-role-gate', 'child-claude-channel-guard', 'destructive-gate', 'credential-gate',
    'second-reviewer-gate', 'egress-gate', 'bash-egress-parser',
  ],
  Stop: [['telegram_progress_clear', 'slack_progress_clear'], 'marveen-commands-stop'],
}

export const HOOK_MANIFEST: HookManifest = {
  entries: HOOK_MANIFEST_ENTRIES,
  layout: { main: MAIN_LAYOUT, sub: SUB_LAYOUT },
}

// ---------------------------------------------------------------------------
// Rendering.
//
// TEMPORARY DUPLICATE: the wrapper strings below repeat what the builders in
// agent-scaffold.ts (hookCommand, pythonHookCommand, failClosedGateRun,
// gateDeadlineSec), the settings template and the hand-written main settings
// spell today. They are copied, not imported, because agent-scaffold.ts will
// import this module in C3-3 and the reverse import would be a cycle. C3-3 is
// where the builders and these strings become one implementation; until then
// the deep-equal tests against the real outputs keep the copies identical.

const SCRIPT_RE = /^scripts\/[A-Za-z0-9_./-]+\.(py|mjs|sh)$/
const ARG_RE = /^[A-Za-z0-9_=.:-]+$/
/**
 * A root or node binary: an absolute path of plain characters. Both land inside
 * a single-quoted `bash -c '...'` string, and the main root also inside double
 * quotes, so a quote, `$`, backtick, backslash or space must never reach them.
 */
const PLAIN_ABS_PATH_RE = /^(?:\/[A-Za-z0-9_.+-]+)+$/
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
const GATE_FAIL_CLOSED_TAG = 'governance-kapu (fail-closed)'
const FLEET_FREEZE_MARKER = 'store/fleet-freeze.json'
const FLEET_FREEZE_MISSING_MSG = 'fleet-freeze-gate (fail-closed while frozen): the gate script is missing and '
  + 'store/fleet-freeze.json exists, so every tool call is blocked. Fix: restore scripts/hooks/fleet-freeze-gate.sh '
  + 'or unfreeze from the dashboard.'
const MAIN_NODE_MISSING_MSG = 'governance-kapu: node interpreter hianyzik, a kapu BLOKKOL'
const SUB_PYTHON_MISSING_MSG = 'governance-kapu: a hook interpretere nem talalhato (python3 nincs a PATH-on). A kapu ezert '
  + 'BLOKKOL. Javitas: telepitsd a python3-at, vagy inditsd ujra a dashboardot.'
const subNodeMissingMsg = (nodeBin: string): string => `governance-kapu: a hook interpretere nem talalhato (${nodeBin}). `
  + 'A kapu ezert BLOKKOL. Javitas: inditsd ujra a dashboardot, az ujrairja a hook-utakat.'

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

function subCommand(spec: HookSpec, script: string, args: readonly string[], root: string, nodeBin: string): string {
  const p = `${root}/${script}`
  const interp = interpreterFor(script)
  const a = args.map((x) => ` ${x}`).join('')
  switch (spec.wrapper) {
    case 'failOpenExecUnquoted':
      return `bash -c '[ -f ${p} ] && exec ${interp} ${p}${a}; exit 0'`
    case 'bare':
      return `${interp} ${p}${a}`
    case 'bareQuoted':
      return `${interp} "${p}"${a}`
    case 'failClosedPythonProbe':
      if (interp !== 'python3') throw new Error(`hook manifest: ${script} is not a python gate`)
      return `command -v python3 >/dev/null 2>&1 || { echo "${SUB_PYTHON_MISSING_MSG}" >&2; exit 2; }; `
        + failClosedRun(`python3 "${p}"${a}`, basenameOf(script), requireTimeout(spec, script))
    case 'failClosedNodeBin':
      if (interp !== 'node') throw new Error(`hook manifest: ${script} is not a node gate`)
      return `test -x "${nodeBin}" || { echo "${subNodeMissingMsg(nodeBin)}" >&2; exit 2; }; `
        + failClosedRun(`"${nodeBin}" "${p}"${a}`, basenameOf(script), requireTimeout(spec, script))
    default:
      throw new Error(`hook manifest: wrapper ${spec.wrapper} is not a sub-agent spelling (${script})`)
  }
}

function requireTimeout(spec: HookSpec, script: string): number {
  if (spec.wrapperTimeout !== undefined) return spec.wrapperTimeout
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
    wrapperTimeout: 'wrapperTimeout' in o ? o.wrapperTimeout : entry.wrapperTimeout,
    wrapper: o.wrapper ?? entry.wrapper,
    failMode: o.failMode ?? entry.failMode,
  }
}

function inScope(entry: HookManifestEntry, scope: HookScope): boolean {
  return entry.scope === scope || entry.scope === 'both'
}

/** In scope and rendered: the entries a layout of this scope must place. */
function placedIn(entry: HookManifestEntry, scope: HookScope): boolean {
  return inScope(entry, scope) && entry.rendered !== false
}

/** Whether a placed sub entry is switched on for this profile and agent. */
function activeFor(entry: HookManifestEntry, ctx: RenderContext): boolean {
  if (entry.profileFlag && ctx.profile?.[entry.profileFlag] !== true) return false
  if (entry.agentFlag === 'heartbeat' && ctx.agent?.heartbeat !== true) return false
  if (entry.agentFlag === 'senderRolePolicy' && !ctx.agent?.senderRolePolicy) return false
  return true
}

function matchersOf(spec: HookSpec): Array<string | undefined> {
  if (spec.matcher === undefined) return [undefined]
  return typeof spec.matcher === 'string' ? [spec.matcher] : [...spec.matcher]
}

function checkPlainPath(what: string, value: string): void {
  if (!PLAIN_ABS_PATH_RE.test(value)) throw new Error(`hook manifest: ${what} must be an absolute path of plain characters, got: ${value}`)
}

/**
 * Structural check of a manifest for one scope; throws on the first problem.
 * Ids unique, script paths and args plain, every layout slot names a rendered
 * entry of this scope that is registered under that event, every (entry, event)
 * of the scope is placed exactly once, profile and agent conditions only on
 * sub-only entries, and a not-rendered entry carries per-agent data and no place.
 */
export function validateManifest(m: HookManifest, scope: HookScope): void {
  const byId = new Map<string, HookManifestEntry>()
  for (const e of m.entries) {
    if (byId.has(e.id)) throw new Error(`hook manifest: duplicate id ${e.id}`)
    byId.set(e.id, e)
    const spec = specFor(e, scope)
    if (spec.wrapper !== 'agentPrompt' && !SCRIPT_RE.test(e.script)) throw new Error(`hook manifest: bad script path ${e.script}`)
    for (const a of [...(spec.args ?? []), ...(e.threadReplyArgs ?? [])]) {
      if (!ARG_RE.test(a)) throw new Error(`hook manifest: ${e.id}: argument needs quoting: ${a}`)
    }
    for (const t of [spec.timeout, spec.wrapperTimeout]) {
      if (t !== undefined && !(Number.isInteger(t) && t > 0)) throw new Error(`hook manifest: ${e.id}: timeout must be a positive integer`)
    }
    if (Array.isArray(spec.matcher) && spec.matcher.length === 0) throw new Error(`hook manifest: ${e.id}: empty matcher list`)
    if ((e.profileFlag || e.agentFlag || e.threadReplyArgs) && e.scope !== 'sub') {
      throw new Error(`hook manifest: ${e.id}: profile and agent conditions are sub-agent only`)
    }
    if (e.rendered === false) {
      const agents = Object.entries(e.perAgent ?? {})
      if (agents.length === 0) throw new Error(`hook manifest: ${e.id}: a not-rendered entry needs perAgent data`)
      for (const [name, data] of agents) {
        if (!AGENT_NAME_RE.test(name)) throw new Error(`hook manifest: ${e.id}: bad agent name ${name}`)
        if (data.timeout !== undefined && !(Number.isInteger(data.timeout) && data.timeout > 0)) {
          throw new Error(`hook manifest: ${e.id}: ${name}: timeout must be a positive integer`)
        }
      }
    } else if (e.perAgent !== undefined) {
      throw new Error(`hook manifest: ${e.id}: perAgent is for not-rendered entries only`)
    }
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
        if (e.rendered === false) throw new Error(`hook manifest: layout ${scope}.${event} names ${id}, which is not rendered`)
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
    if (!placedIn(e, scope)) continue
    for (const event of specFor(e, scope).events) {
      if (!placed.has(`${e.id}\u0000${event}`)) throw new Error(`hook manifest: ${e.id} (${event}) has no place in the ${scope} layout`)
    }
  }
}

/**
 * The `hooks` object one scope's settings carry, in written order. Pure: no
 * file is read or written. Main: every placed entry. Sub: the placed entries
 * whose profile switch and agent property are on (ctx.root, ctx.nodeBin and
 * the prompt of each agentPrompt entry are required); an event left with no
 * group is omitted. Not-rendered entries never appear.
 */
export function renderHooks(m: HookManifest, scope: HookScope, ctx: RenderContext = {}): RenderedHooks {
  validateManifest(m, scope)
  const root = ctx.root ?? (scope === 'main' ? MAIN_ROOT : undefined)
  if (root === undefined) throw new Error('hook manifest: the sub-agent render needs ctx.root')
  if (!(scope === 'main' && root === MAIN_ROOT)) checkPlainPath('ctx.root', root)
  const nodeBin = ctx.nodeBin ?? ''
  if (scope === 'sub') checkPlainPath('ctx.nodeBin', nodeBin)
  const policy = ctx.agent?.senderRolePolicy
  if (policy && !ARG_RE.test(policy)) throw new Error('hook manifest: the sender-role policy needs quoting')
  const byId = new Map(m.entries.map((e) => [e.id, e] as const))
  const out: RenderedHooks = {}
  for (const [event, groups] of Object.entries(m.layout[scope] ?? {}) as Array<[HookEvent, ReadonlyArray<string | readonly string[]>]>) {
    const rendered: RenderedGroup[] = []
    for (const slot of groups) {
      const ids = (typeof slot === 'string' ? [slot] : slot).filter((id) => scope === 'main' || activeFor(byId.get(id)!, ctx))
      if (ids.length === 0) continue
      const first = specFor(byId.get(ids[0])!, scope)
      for (const matcher of matchersOf(first)) {
        const hooks = ids.map((id) => renderHook(byId.get(id)!, scope, root, nodeBin, ctx))
        rendered.push(matcher === undefined ? { hooks } : { matcher, hooks })
      }
    }
    if (rendered.length > 0) out[event] = rendered
  }
  return out
}

function renderHook(e: HookManifestEntry, scope: HookScope, root: string, nodeBin: string, ctx: RenderContext): RenderedHook {
  const spec = specFor(e, scope)
  const withTimeout = <T extends RenderedHook>(h: T): T => (spec.timeout === undefined ? h : { ...h, timeout: spec.timeout })
  if (spec.wrapper === 'agentPrompt') {
    const prompt = ctx.prompts?.[e.script]
    if (prompt === undefined) throw new Error(`hook manifest: ${e.id} needs ctx.prompts.${e.script}`)
    return withTimeout({ type: 'agent', prompt })
  }
  if (scope === 'main') return withTimeout({ type: 'command', command: mainCommand(spec, e.script, root) })
  const args = [
    ...(spec.args ?? []),
    ...(ctx.agent?.threadReply ? e.threadReplyArgs ?? [] : []),
    ...(e.agentFlag === 'senderRolePolicy' ? [ctx.agent!.senderRolePolicy!] : []),
  ]
  return withTimeout({ type: 'command', command: subCommand(spec, e.script, args, root, nodeBin) })
}
