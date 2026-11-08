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
// The main agent's hooks block of .claude/settings.json and its sidecar
// .claude/hooks.metadata.json are generated from this module into a checkout
// (C3-4: main-artifact.ts, npm run hooks:generate; a test fails CI when the
// committed files differ). The sub-agents' gate builders in agent-scaffold.ts
// render from it too (C3-3a-1: injectSubHook); no caller writes a whole sub
// block from it yet (C3-3b). It imports nothing at runtime on purpose, so
// agent-scaffold.ts imports it without a cycle.
//
// Recorded as found, not fixed: every wrapper spelling, timeout and fail mode
// below is what the settings carry today, including the main/sub differences
// the audit lists. Normalising them is C3-5. Which fail mode each hook SHOULD
// have is the policy in docs/hook-fail-modes.md (C3-2): every entry carries its
// `kind`, and src/__tests__/hook-fail-mode-policy.test.ts checks the recorded
// failMode against the policy of that kind, with a named exception list.

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
 * The role a hook plays, which decides the fail mode it SHOULD have
 * (FAIL_MODE_POLICY in fail-mode-policy.ts, reasons in docs/hook-fail-modes.md):
 *   security-gate -- PreToolUse gate on a trust boundary or governance rule      (closed)
 *   kill-switch   -- the fleet freeze: blocks every call while frozen             (closed while frozen)
 *   guard         -- PreToolUse check against an accident, not a trust boundary   (open)
 *   enforcer      -- holds the turn open until a rule is met (Stop)              (open)
 *   directive     -- puts a directive, nudge, notice, replay or inbox into context (open)
 *   capture       -- records: ledger, logs, task state                           (open)
 *   handler       -- does work for the agent: owner commands, image resize, progress messages (open)
 *   prompt        -- a prompt-type hook                                          (advisory)
 * One kind per entry, the same in both scopes: a main/sub difference in the
 * fail mode is a recorded exception, not a second role.
 */
export type HookKind =
  | 'security-gate'
  | 'kill-switch'
  | 'guard'
  | 'enforcer'
  | 'directive'
  | 'capture'
  | 'handler'
  | 'prompt'

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
 * Per-agent conditions that are not profile switches: the heartbeat agent, an
 * agent with a sender-role policy (the policy rides on the command as the last
 * argument), and an agent with the `browser` capability (a Playwright MCP). The
 * email thread-reply capability changes arguments only, see
 * HookManifestEntry.threadReplyArgs.
 */
export type HookAgentFlag = 'heartbeat' | 'senderRolePolicy' | 'browser'

/** How one scope renders an entry. */
export interface HookSpec {
  /** Events the hook is registered under; the same matcher, args and timeout apply to each. */
  events: readonly HookEvent[]
  /** Absent: the group carries no matcher key. An array: one group per matcher, in this order. */
  matcher?: string | readonly string[]
  /** Extra arguments after the script path (plain flag characters only). */
  args?: readonly string[]
  /** Seconds; absent: the hook object carries no timeout key. A fail-closed wrapper's own deadline is this minus 2. */
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
  /** The hook's role; the fail-mode policy is keyed by it (docs/hook-fail-modes.md). */
  kind: HookKind
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
   * Sub-agents only (the generator, sub-generator.ts): an existing hook that runs
   * this script belongs to this entry only under one of these matchers. Under any
   * other matcher it is an operator's own wiring and stays as it is. Absent: the
   * script alone decides, under any matcher of this entry's events.
   */
  ownMatchers?: readonly string[]
  /**
   * Sub-agents only, a conditional entry: when its switch is off, the generator
   * removes an existing copy. Absent: an existing copy stays as it is, because
   * switching a gate off is not a teardown (profiles.ts, destructiveGate).
   */
  offRemoves?: true
  /**
   * The entry's text in .claude/hooks.metadata.json (the sidecar of the main
   * settings, HOOKDRIFT926). Required on every entry the main agent renders,
   * absent on every other (validateSidecarText); the renders ignore it. The
   * sidecar is generated from it (main-artifact.ts, npm run hooks:generate).
   */
  sidecar?: HookSidecarText
}

/**
 * What the sidecar says about one entry's matcher groups. The rest of a
 * sidecar entry is derived (sidecarGroupText, and C3-4 for index, hook, gate
 * and fingerprint).
 */
export interface HookSidecarText {
  /**
   * One sentence per group: a string, the same for every group of the entry;
   * an object with one sentence for each event the entry is registered under;
   * or an array parallel to the matcher array, one sentence per matcher group.
   */
  purpose: string | Partial<Record<HookEvent, string>> | readonly string[]
  /**
   * Exactly when the matcher is an array: the id suffix of each matcher group,
   * parallel to it, the first null (that group carries the bare id).
   */
  labels?: readonly (string | null)[]
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
   * Sub (required): the absolute project root. Plain path characters only where
   * it lands unquoted (the template wrappers, inside a single-quoted bash -c);
   * the gate wrappers quote it, see DQ_SAFE_ABS_PATH_RE.
   */
  root?: string
  /** Sub (required): the node binary hookCommand() burns in (HOOK_NODE_BIN), see DQ_SAFE_ABS_PATH_RE. */
  nodeBin?: string
  /** Sub: the agent's profile (only the gate switches are read). */
  profile?: Pick<ProfileTemplate, HookProfileFlag>
  /** Sub: per-agent conditions. */
  agent?: { heartbeat?: boolean; threadReply?: boolean; senderRolePolicy?: string | null; browser?: boolean }
  /** Sub: prompt texts of agentPrompt entries, keyed by the entry's script field. */
  prompts?: Record<string, string>
  /** Sub: ids not rendered this time (the generator's registration guard and covered envelope). */
  skip?: ReadonlySet<string>
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
// two mail gates under several matchers). Sub: 43 entries, 36 of them
// unconditional (39 settings entries on every sub-agent today), 7 behind a
// profile switch or an agent property.

const open = { wrapper: 'failOpenExec', failMode: 'open' } as const
/** The template's spelling of a fail-open hook on the sub-agents. */
const subOpen = { sub: { wrapper: 'failOpenExecUnquoted' } } as const
/** hookCommand() / pythonHookCommand() gates, sub-agents only. */
const nodeGate = { scope: 'sub', kind: 'security-gate', timeout: 10, wrapper: 'failClosedNodeBin', failMode: 'closed' } as const
const pythonGate = { scope: 'sub', kind: 'security-gate', timeout: 10, wrapper: 'failClosedPythonProbe', failMode: 'closed' } as const

export const HOOK_MANIFEST_ENTRIES: readonly HookManifestEntry[] = [
  // UserPromptSubmit
  { id: 'ledger-capture', kind: 'capture', script: 'scripts/hooks/ledger-capture.py', scope: 'main', events: ['UserPromptSubmit'], timeout: 15, ...open,
    sidecar: { purpose: 'Records every inbound channel message into the conversation ledger before the agent processes it.' } },
  { id: 'inbox-drain', kind: 'directive', script: 'scripts/hooks/inbox-drain.py', scope: 'main', events: ['UserPromptSubmit'], timeout: 15, ...open,
    sidecar: { purpose: 'UserPromptSubmit hook: PULL the MAIN agent\'s inter-agent inbox into context.' } },
  { id: 'telegram-reply-directive', kind: 'directive', script: 'scripts/hooks/telegram-reply-directive.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 10, ...open, override: subOpen,
    sidecar: { purpose: 'UserPromptSubmit hook: inject a reply-tool directive whenever an inbound Telegram TEXT message arrives.' } },
  { id: 'provenance-gate', kind: 'directive', script: 'scripts/hooks/provenance-gate.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 10, ...open, override: subOpen,
    sidecar: { purpose: 'Flags, never blocks, a prompt with no provenance envelope (channel, scheduled task, peer), i.e. text injected straight into the pane, that asks for an irreversible or outward-facing operation.' } },
  { id: 'staleness-guard', kind: 'directive', script: 'scripts/hooks/staleness-guard.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 10, ...open, override: subOpen,
    sidecar: { purpose: 'Warns when an inbound channel message is processed long after it was sent (lagging poller, re-delivery after restart).' } },
  { id: 'memory-lookup-nudge', kind: 'directive', script: 'scripts/hooks/memory-lookup-nudge.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 3, ...open, override: subOpen,
    sidecar: { purpose: 'UserPromptSubmit hook: on a human message, remind the agent to look in its memory.' } },
  { id: 'channel-inbox-drain', kind: 'directive', script: 'scripts/hooks/channel-inbox-drain.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 5, ...open, override: subOpen,
    sidecar: { purpose: 'UserPromptSubmit hook: drain sub-agent Telegram channel notifications.' } },
  { id: 'voice-reply-directive', kind: 'directive', script: 'scripts/hooks/voice-reply-directive.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 180, ...open, override: { sub: { wrapper: 'failOpenExecUnquoted', timeout: 60 } },
    sidecar: { purpose: 'UserPromptSubmit hook: voice-reply directive injection + server-side STT.' } },
  { id: 'telegram_progress', kind: 'handler', script: 'scripts/hooks/telegram_progress.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 15, ...open, override: subOpen,
    sidecar: { purpose: 'Posts the Telegram "processing" indicator when an inbound message starts a turn.' } },
  { id: 'slack_progress', kind: 'handler', script: 'scripts/hooks/slack_progress.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 15, ...open, override: subOpen,
    sidecar: { purpose: 'Posts the Slack "processing" indicator when an inbound message starts a turn.' } },
  { id: 'marveen-commands', kind: 'handler', script: 'scripts/hooks/marveen-commands.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 45, ...open, override: subOpen,
    sidecar: { purpose: 'Answers the owner\'s slash commands without a model turn.' } },
  { id: 'taskstate-stub', kind: 'capture', script: 'scripts/hooks/taskstate-stub.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 10, ...open, override: subOpen,
    sidecar: { purpose: 'UserPromptSubmit hook: write a minimal task-state stub when a prompt arrives and no live record exists for the agent.' } },
  { id: 'directive-verify', kind: 'directive', script: 'scripts/hooks/directive-verify.py', scope: 'both', events: ['UserPromptSubmit'], timeout: 10, ...open, override: subOpen,
    sidecar: { purpose: 'UserPromptSubmit hook: verify a [SYSTEM-DIREKTIVA msg_id:N] directive before the agent acts on it.' } },

  // PostToolUse / PostToolUseFailure
  { id: 'ledger-outbound', kind: 'capture', script: 'scripts/hooks/ledger-outbound.py', scope: 'main', events: ['PostToolUse'], matcher: 'mcp__plugin_[^_]+_[^_]+__reply', timeout: 15, ...open,
    sidecar: { purpose: 'Records the text of every outbound channel reply into the conversation ledger.' } },
  { id: 'tool-log-capture', kind: 'capture', script: 'scripts/hooks/tool-log-capture.py', scope: 'both', events: ['PostToolUse', 'PostToolUseFailure'], timeout: 5, ...open, override: { sub: { wrapper: 'failOpenExecUnquoted', matcher: '*', timeout: 10 } },
    sidecar: { purpose: 'PostToolUse + PostToolUseFailure hook: log every tool call to /api/tool-log for the activity dashboard.' } },
  { id: 'persona-change-notify', kind: 'handler', script: 'scripts/hooks/persona-change-notify.py', scope: 'main', events: ['PostToolUse'], timeout: 15, ...open,
    sidecar: { purpose: 'Notifies the owner when an agent\'s persona file (CLAUDE.md / SOUL.md) is changed.' } },
  { id: 'telegram_progress_reply_clear', kind: 'handler', script: 'scripts/hooks/telegram_progress_reply_clear.py', scope: 'both', events: ['PostToolUse'], matcher: 'telegram.*reply', timeout: 15, ...open, override: subOpen,
    sidecar: { purpose: 'Clears the Telegram progress placeholder as soon as a reply is actually sent.' } },
  // Sub: the managed WebSearch envelope (injectWebSearchEnvelope); the script under any other matcher is the
  // operator's (the generator keeps it, and skips this entry where such a group already covers both tools).
  { id: 'browser-content-notice', kind: 'directive', script: 'scripts/hooks/browser-content-notice.py', scope: 'both', events: ['PostToolUse'], matcher: 'WebSearch|WebFetch', timeout: 10, ...open, override: { sub: { wrapper: 'bareQuoted' } }, ownMatchers: ['WebSearch|WebFetch', 'WebSearch', 'WebFetch'],
    sidecar: { purpose: 'PostToolUse hook: envelope browser / search payloads as untrusted content.' } },
  // The Playwright MCP's content (skill playwright-mcp-agens), for an agent with the `browser` capability.
  // Before C3-3 it was added by hand, on five sub-agents (measured 2026-11-07 23:17 and 2026-11-08 01:2x: two
  // without a timeout, three with 10). Without the capability the generator keeps such a hand-added copy as it is.
  {
    id: 'browser-content-notice-playwright', kind: 'directive', script: 'scripts/hooks/browser-content-notice.py', scope: 'sub', events: ['PostToolUse'],
    matcher: 'mcp__playwright__browser_.*', timeout: 10, wrapper: 'bare', failMode: 'open', agentFlag: 'browser', ownMatchers: ['mcp__playwright__browser_.*'],
  },
  { id: 'slack_progress_reply_clear', kind: 'handler', script: 'scripts/hooks/slack_progress_reply_clear.py', scope: 'both', events: ['PostToolUse'], matcher: 'slack.*reply', timeout: 15, ...open, override: subOpen,
    sidecar: { purpose: 'Clears the Slack progress placeholder as soon as a reply is actually sent.' } },
  { id: 'skill-usage-capture', kind: 'capture', script: 'scripts/hooks/skill-usage-capture.py', scope: 'both', events: ['PostToolUse'], matcher: 'Skill|Read', timeout: 10, ...open, override: subOpen,
    sidecar: { purpose: 'PostToolUse hook: log skill usage to the persistent skill_usage table.' } },
  { id: 'memory-frontmatter-bash-gate', kind: 'guard', script: 'scripts/hooks/memory-frontmatter-bash-gate.py', scope: 'both', events: ['PostToolUse', 'PostToolUseFailure', 'PreToolUse'], matcher: 'Bash', timeout: 10, ...open, override: subOpen,
    sidecar: {
      purpose: {
        PostToolUse: 'Memory frontmatter check for memory files written from Bash (after the write).',
        PostToolUseFailure: 'Memory frontmatter check for memory files written from Bash (failed tool call).',
        PreToolUse: 'Memory frontmatter check for memory files written from Bash (before the write).',
      },
    } },

  // PreToolUse
  // Main: fail-open while the fleet runs; a missing script blocks only while
  // frozen, the one state in which this gate stops anything. Sub: plain fail-open.
  { id: 'fleet-freeze-gate', kind: 'kill-switch', script: 'scripts/hooks/fleet-freeze-gate.sh', scope: 'both', events: ['PreToolUse'], matcher: '*', timeout: 5, wrapper: 'failOpenExecClosedWhenFrozen', failMode: 'closed', override: { sub: { wrapper: 'failOpenExecUnquoted', failMode: 'open' } },
    sidecar: { purpose: 'PreToolUse hook (matcher "*"), KILLSWITCH1022: while the fleet is frozen (store/fleet-freeze.json exists), every tool call is denied with exit 2.' } },
  { id: 'outgoing-copy-gate', kind: 'security-gate', script: 'scripts/hooks/outgoing-copy-gate.py', scope: 'both', events: ['PreToolUse'], matcher: ['Bash', ...MAIN_MAIL_MATCHERS, TELEGRAM_REPLY_EDIT, DISCORD_REPLY_EDIT], timeout: 15, wrapper: 'failClosedRun', failMode: 'closed', override: { sub: { matcher: TELEGRAM_REPLY_EDIT, timeout: 10, wrapper: 'failClosedPythonProbe' } }, ownMatchers: [TELEGRAM_REPLY_EDIT],
    sidecar: {
      purpose: [
        'Copy QA gate on outgoing email sent from Bash.',
        'Copy QA gate on outgoing email (send_email tools).',
        'Copy QA gate on outgoing email (manage_email tools).',
        'Copy QA gate on outgoing email (Gmail connector tools).',
        'Copy QA gate on outgoing email drafts (draft_email tools).',
        'Copy QA gate on outgoing email (send / draft / reply / forward tool family).',
        'Copy QA gate on outgoing Telegram reply / edit_message text.',
        'Copy QA gate on outgoing Discord reply / edit_message text.',
      ],
      labels: [null, 'send-email', 'manage-email', 'gmail', 'draft-email', 'mail-tool-family', 'telegram-reply', 'discord-reply'],
    } },
  { id: 'email-approval-gate', kind: 'security-gate', script: 'scripts/hooks/email-approval-gate.py', scope: 'main', events: ['PreToolUse'], matcher: ['Bash', ...MAIN_MAIL_MATCHERS], timeout: 10, wrapper: 'failClosedRun', failMode: 'closed',
    sidecar: {
      purpose: [
        'Level-aware approval gate on outgoing email sent from Bash (EMAILKAPU901).',
        'Level-aware approval gate on outgoing email (send_email tools).',
        'Level-aware approval gate on outgoing email (manage_email tools).',
        'Level-aware approval gate on outgoing email (Gmail connector tools).',
        'Level-aware approval gate on outgoing email drafts (draft_email tools).',
        'Level-aware approval gate on outgoing email (send / draft / reply / forward tool family).',
      ],
      labels: [null, 'send-email', 'manage-email', 'gmail', 'draft-email', 'mail-tool-family'],
    } },
  { id: 'channel-image-resize', kind: 'handler', script: 'scripts/hooks/channel-image-resize.sh', scope: 'both', events: ['PreToolUse'], matcher: 'Read', timeout: 15, ...open, override: subOpen,
    sidecar: { purpose: 'PreToolUse hook: auto-resize channel-received large images before Read.' } },
  { id: 'egress-gate', kind: 'security-gate', script: 'scripts/hooks/egress-gate.mjs', scope: 'both', events: ['PreToolUse'], matcher: 'WebFetch', timeout: 10, wrapper: 'failClosedRunNodeProbe', failMode: 'closed', override: { sub: { wrapper: 'failClosedNodeBin' } },
    sidecar: { purpose: 'PreToolUse hook: WebFetch egress allowlist enforcement.' } },
  { id: 'memory-frontmatter-gate', kind: 'guard', script: 'scripts/hooks/memory-frontmatter-gate.py', scope: 'both', events: ['PreToolUse'], matcher: 'Write|Edit|MultiEdit', timeout: 10, ...open, override: subOpen,
    sidecar: { purpose: 'Blocks Write/Edit/MultiEdit on memory files whose frontmatter is missing or malformed.' } },
  { id: 'db-write-gate', kind: 'security-gate', script: 'scripts/hooks/db-write-gate.mjs', scope: 'both', events: ['PreToolUse'], matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', timeout: 10, wrapper: 'failClosedRunNodeProbe', failMode: 'closed', override: { sub: { wrapper: 'failClosedNodeBin' } },
    sidecar: { purpose: 'PreToolUse gate: agent writes to the dashboard\'s SECURITY surface (APPROVALDBGATE1030), for EVERY agent, the main agent included.' } },
  { id: 'shell-rescan-guard', kind: 'guard', script: 'scripts/hooks/shell-rescan-guard.py', scope: 'both', events: ['PreToolUse'], matcher: 'Bash', timeout: 10, ...open, override: subOpen,
    sidecar: { purpose: 'PreToolUse gate: refuse a Bash command whose own TEXT will be re-scanned by the shell, because that is how prose becomes an executed command.' } },
  { id: 'child-claude-channel-guard', kind: 'guard', script: 'scripts/hooks/child-claude-channel-guard.mjs', scope: 'both', events: ['PreToolUse'], matcher: 'Bash', timeout: 10, wrapper: 'failOpenNodeProbe', failMode: 'open', override: { sub: { wrapper: 'failClosedNodeBin', failMode: 'closed' } },
    sidecar: { purpose: 'PreToolUse hook (matcher: Bash): a session whose Telegram poller can be killed must not start a child `claude` that would kill it (CHILDCLAUDEPOLLER1010).' } },
  { id: 'token-argv-guard', kind: 'guard', script: 'scripts/hooks/token-argv-guard.py', scope: 'both', events: ['PreToolUse'], matcher: 'Bash', timeout: 10, ...open, override: subOpen,
    sidecar: { purpose: 'PreToolUse hook (matcher: Bash): warn when a command puts the dashboard token on a process argv.' } },
  { id: 'email-send-gate', script: 'scripts/email-send-gate.mjs', events: ['PreToolUse'], matcher: SUB_EMAIL_MATCHER, threadReplyArgs: ['--allow-thread-reply'], ...nodeGate },
  { id: 'self-pace-gate', script: 'scripts/self-pace-gate.mjs', events: ['PreToolUse'], matcher: 'ScheduleWakeup|CronCreate|CronDelete|CronList|RemoteTrigger|Bash|Write|Edit|NotebookEdit', ...nodeGate },
  { id: 'kanban-write-gate', script: 'scripts/kanban-write-gate.mjs', events: ['PreToolUse'], matcher: 'Bash', agentFlag: 'heartbeat', ...nodeGate },
  { id: 'digest-provenance-gate', script: 'scripts/digest-provenance-gate.mjs', events: ['PreToolUse'], matcher: 'Bash', agentFlag: 'heartbeat', ...nodeGate },
  { id: 'sender-role-gate', script: 'scripts/hooks/sender-role-gate.py', events: ['PreToolUse'], matcher: '*', args: ['--policy'], agentFlag: 'senderRolePolicy', offRemoves: true, ...pythonGate },
  { id: 'destructive-gate', script: 'scripts/hooks/destructive-gate.py', events: ['PreToolUse'], matcher: 'Bash|Read|Edit|Write|NotebookEdit', profileFlag: 'destructiveGate', ...pythonGate },
  { id: 'credential-gate', script: 'scripts/hooks/credential-gate.py', events: ['PreToolUse'], matcher: SUB_EMAIL_MATCHER, profileFlag: 'credentialGate', ...pythonGate },
  { id: 'second-reviewer-gate', script: 'scripts/hooks/second-reviewer-gate.py', events: ['PreToolUse'], matcher: 'Bash|mcp__.*', profileFlag: 'secondReviewer', offRemoves: true, ...pythonGate, timeout: 180 },
  { id: 'bash-egress-parser', script: 'scripts/hooks/bash-egress-parser.mjs', events: ['PreToolUse'], matcher: 'Bash', ...nodeGate },

  // Stop / StopFailure
  { id: 'telegram-reply-guard', kind: 'enforcer', script: 'scripts/hooks/telegram-reply-guard.py', scope: 'main', events: ['Stop'], timeout: 10, ...open,
    sidecar: { purpose: 'Stop hook: ENFORCE that an inbound Telegram message is answered through the reply tool before the turn ends.' } },
  { id: 'telegram_progress_clear', kind: 'handler', script: 'scripts/hooks/telegram_progress_clear.py', scope: 'both', events: ['Stop'], timeout: 15, ...open, override: subOpen,
    sidecar: { purpose: 'At turn end: clears the Telegram progress placeholder and owns the per-session progress state.' } },
  { id: 'slack_progress_clear', kind: 'handler', script: 'scripts/hooks/slack_progress_clear.py', scope: 'both', events: ['Stop'], timeout: 15, ...open, override: subOpen,
    sidecar: { purpose: 'At turn end: clears the Slack progress placeholder and owns the per-session progress state.' } },
  { id: 'marveen-commands-stop', kind: 'handler', script: 'scripts/hooks/marveen-commands.py', scope: 'both', events: ['Stop'], args: ['--stop'], timeout: 10, ...open, override: subOpen,
    sidecar: { purpose: 'Slash-command bookkeeping at turn end (--stop).' } },
  { id: 'ledger-turn-failure', kind: 'capture', script: 'scripts/hooks/ledger-turn-failure.py', scope: 'main', events: ['StopFailure'], timeout: 10, ...open,
    sidecar: { purpose: 'StopFailure hook: leave a trace when a turn that owed a channel reply died on an API error.' } },

  // SessionStart / SessionEnd / PreCompact
  { id: 'ledger-replay', kind: 'directive', script: 'scripts/hooks/ledger-replay.py', scope: 'main', events: ['SessionStart'], matcher: 'startup|resume|clear', timeout: 15, ...open,
    sidecar: { purpose: 'Replays the recent conversation ledger into a fresh, resumed or cleared session.' } },
  { id: 'taskstate-replay', kind: 'directive', script: 'scripts/hooks/taskstate-replay.py', scope: 'both', events: ['SessionStart'], matcher: 'compact|resume|clear', timeout: 15, ...open, override: { sub: { wrapper: 'bare' } },
    sidecar: { purpose: 'Re-injects a sub-agent\'s in-flight TASK-STATE after a compact, resume or respawn.' } },
  { id: 'clear-replay', kind: 'directive', script: 'scripts/hooks/clear-replay.py', scope: 'both', events: ['SessionStart'], matcher: 'clear', timeout: 15, ...open, override: { sub: { wrapper: 'bare' } },
    sidecar: { purpose: 'SessionStart hook: hand the cleared thread to the fresh session.' } },
  { id: 'marveen-commands-session-start', kind: 'handler', script: 'scripts/hooks/marveen-commands.py', scope: 'main', events: ['SessionStart'], args: ['--session-start'], timeout: 10, ...open,
    sidecar: { purpose: 'Slash-command bookkeeping at session start (--session-start).' } },
  { id: 'clear-capture', kind: 'capture', script: 'scripts/hooks/clear-capture.py', scope: 'both', events: ['SessionEnd'], timeout: 15, ...open, override: { sub: { wrapper: 'bare' } },
    sidecar: { purpose: 'SessionEnd hook: save the thread a /clear is about to erase.' } },
  // The prompt text (about 3 KB, from templates/settings.json.template) is passed in by the caller.
  { id: 'precompact', kind: 'prompt', script: 'precompact', scope: 'sub', events: ['PreCompact'], matcher: 'auto', timeout: 180, wrapper: 'agentPrompt', failMode: 'advisory' },
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
    'memory-frontmatter-bash-gate', 'browser-content-notice', 'browser-content-notice-playwright',
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
// The gate builders of agent-scaffold.ts (hookCommand, pythonHookCommand,
// failClosedGateRun, gateDeadlineSec) are the functions below since C3-3a: one
// implementation, imported there (this module imports nothing at runtime, so
// there is no cycle). The template's fail-open spelling and the main agent's
// hand-written wrappers are still spelled here a second time; the deep-equal
// tests against the template seed and the tracked main settings keep them equal.

const SCRIPT_RE = /^scripts\/[A-Za-z0-9_./-]+\.(py|mjs|sh)$/
const ARG_RE = /^[A-Za-z0-9_=.:-]+$/
/**
 * A root where it lands UNQUOTED: the main root (inside a single-quoted
 * `bash -c '...'` and double quotes) and a sub root under the template's
 * fail-open wrappers. Plain characters only, so a quote, `$`, backtick,
 * backslash or space never reaches the shell.
 */
const PLAIN_ABS_PATH_RE = /^(?:\/[A-Za-z0-9_.+-]+)+$/
/**
 * A path that only ever lands inside DOUBLE quotes in a plain command (the
 * node binary, a sub root under the gate wrappers): absolute (POSIX, or a
 * Windows drive), and free of the characters that are live inside double quotes
 * (`"`, `$`, backtick) and of control characters. A trailing backslash would
 * escape the closing quote, and a trailing slash names no file, so neither may
 * end it. Allowed on purpose (Ron 13754): `@` (brew node@22), space (a home
 * with a space, `C:\Program Files`), backslash and colon (Windows).
 */
const DQ_SAFE_ABS_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])[^"$`\x00-\x1f\x7f]*[^"$`\x00-\x1f\x7f\\/]$/
export const GATE_FAIL_CLOSED_TAG = 'governance-kapu (fail-closed)'
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

/** The gate's deadline inside a hook whose timeout is `hookTimeoutSec`: two seconds earlier, at least one. */
export function gateDeadlineSec(hookTimeoutSec: number): number {
  return Math.max(1, Math.floor(hookTimeoutSec) - 2)
}

function basenameOf(script: string): string {
  return script.slice(script.lastIndexOf('/') + 1)
}

/**
 * The run-and-map tail of a fail-closed gate: 0 and 2 pass through, any other status blocks
 * (card 723bbb70; the reasons are at hookCommand in agent-scaffold.ts).
 */
export function failClosedGateRun(invocation: string, label: string, hookTimeoutSec: number): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(label)) throw new Error(`gate label must be a plain file name, got: ${label}`)
  const fail = `${GATE_FAIL_CLOSED_TAG}: ${label}: a kapu nem 0-val vagy 2-vel lepett ki (rc=$rc: betoltesi hiba, hianyzo fajl, `
    + 'jel vagy idotullepes). A hivas ezert TILTVA. Javitas: a kapu fajlja vagy egy fuggosege hibas, a hibauzenet fent.'
  return `if command -v timeout >/dev/null 2>&1; then timeout -k 1 ${gateDeadlineSec(hookTimeoutSec)} ${invocation}; else ${invocation}; fi; `
    + `rc=$?; [ "$rc" = 0 ] || [ "$rc" = 2 ] || { echo "${fail}" >&2; exit 2; }; exit "$rc"`
}

// Extra arguments ride inside the invocation, never after the whole command: appended after the
// fail-closed tail they would land on `exit` instead of the gate. Only plain flag characters, so
// nothing needs shell quoting.
function gateInvocation(interpreter: string, scriptPath: string, args: readonly string[]): string {
  for (const a of args) {
    if (!ARG_RE.test(a)) throw new Error(`hook argument needs no quoting, got: ${a}`)
  }
  return [interpreter, `"${scriptPath}"`, ...args].join(' ')
}

/** Throws unless `nodeBin` may stand inside double quotes (DQ_SAFE_ABS_PATH_RE). */
export function checkNodeBin(nodeBin: string): void {
  if (!DQ_SAFE_ABS_PATH_RE.test(nodeBin)) throw new Error(`hook manifest: ctx.nodeBin must be an absolute path without ", $, backtick, control characters or a trailing slash or backslash, got: ${JSON.stringify(nodeBin)}`)
}

/** The failClosedNodeBin spelling: `test -x <nodeBin>` probe (a miss blocks), then the fail-closed run. */
export function nodeGateCommand(nodeBin: string, scriptPath: string, args: readonly string[], hookTimeoutSec: number): string {
  checkNodeBin(nodeBin)
  return `test -x "${nodeBin}" || { echo "${subNodeMissingMsg(nodeBin)}" >&2; exit 2; }; `
    + failClosedGateRun(gateInvocation(`"${nodeBin}"`, scriptPath, args), basenameOf(scriptPath), hookTimeoutSec)
}

/** The failClosedPythonProbe spelling: `command -v python3` probe (a miss blocks), then the fail-closed run. */
export function pythonGateCommand(scriptPath: string, args: readonly string[], hookTimeoutSec: number): string {
  return `command -v python3 >/dev/null 2>&1 || { echo "${SUB_PYTHON_MISSING_MSG}" >&2; exit 2; }; `
    + failClosedGateRun(gateInvocation('python3', scriptPath, args), basenameOf(scriptPath), hookTimeoutSec)
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
        + `then timeout -k 1 ${gateDeadlineSec(timeout)} ${inv}; else ${inv}; fi; [ $? = 2 ] && exit 2; exit 0'`
    }
    case 'failClosedRun':
      return failClosedGateRun(`${interp} ${p}${args}`, basenameOf(script), timeout)
    case 'failClosedRunNodeProbe':
      return `command -v node >/dev/null 2>&1 || { echo "${MAIN_NODE_MISSING_MSG}" >&2; exit 2; }; `
        + failClosedGateRun(`node ${p}${args}`, basenameOf(script), timeout)
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
      checkPlainPath('ctx.root', root)
      return `bash -c '[ -f ${p} ] && exec ${interp} ${p}${a}; exit 0'`
    case 'bare':
      checkPlainPath('ctx.root', root)
      return `${interp} ${p}${a}`
    case 'bareQuoted':
      return `${interp} "${p}"${a}`
    case 'failClosedPythonProbe':
      if (interp !== 'python3') throw new Error(`hook manifest: ${script} is not a python gate`)
      return pythonGateCommand(p, args, requireTimeout(spec, script))
    case 'failClosedNodeBin':
      if (interp !== 'node') throw new Error(`hook manifest: ${script} is not a node gate`)
      return nodeGateCommand(nodeBin, p, args, requireTimeout(spec, script))
    default:
      throw new Error(`hook manifest: wrapper ${spec.wrapper} is not a sub-agent spelling (${script})`)
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

/** Whether a sub entry is switched on for this profile and agent. */
export function activeFor(entry: HookManifestEntry, ctx: RenderContext): boolean {
  if (entry.profileFlag && ctx.profile?.[entry.profileFlag] !== true) return false
  if (entry.agentFlag === 'heartbeat' && ctx.agent?.heartbeat !== true) return false
  if (entry.agentFlag === 'senderRolePolicy' && !ctx.agent?.senderRolePolicy) return false
  if (entry.agentFlag === 'browser' && ctx.agent?.browser !== true) return false
  return true
}

/** The matchers an entry is registered under in one scope; undefined = a group without a matcher key. */
export function matchersOf(spec: HookSpec): Array<string | undefined> {
  if (spec.matcher === undefined) return [undefined]
  return typeof spec.matcher === 'string' ? [spec.matcher] : [...spec.matcher]
}

function checkPlainPath(what: string, value: string): void {
  if (!PLAIN_ABS_PATH_RE.test(value)) throw new Error(`hook manifest: ${what} must be an absolute path of plain characters, got: ${value}`)
}

const SIDECAR_LABEL_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function isSentence(s: unknown): s is string {
  return typeof s === 'string' && s !== '' && s.trim() === s && !/[\r\n]/.test(s)
}

/** Main scope: a rendered entry carries complete sidecar text, any other entry none. */
function checkSidecarText(e: HookManifestEntry, spec: HookSpec): void {
  const text = e.sidecar
  if (!inScope(e, 'main')) {
    if (text !== undefined) throw new Error(`hook manifest: ${e.id}: sidecar text is for entries the main agent renders only`)
    return
  }
  if (text === undefined) throw new Error(`hook manifest: ${e.id}: needs sidecar text (purpose)`)
  const matchers = Array.isArray(spec.matcher) ? spec.matcher : undefined
  const { purpose, labels } = text
  if (typeof purpose === 'string') {
    if (!isSentence(purpose)) throw new Error(`hook manifest: ${e.id}: sidecar purpose must be one non-empty, trimmed line`)
  } else if (Array.isArray(purpose)) {
    if (!matchers) throw new Error(`hook manifest: ${e.id}: a sidecar purpose array needs a matcher array`)
    if (purpose.length !== matchers.length) {
      throw new Error(`hook manifest: ${e.id}: ${purpose.length} sidecar purposes for ${matchers.length} matcher groups`)
    }
    if (!purpose.every(isSentence)) throw new Error(`hook manifest: ${e.id}: sidecar purpose must be one non-empty, trimmed line`)
  } else {
    const keys = Object.keys(purpose).sort()
    if (JSON.stringify(keys) !== JSON.stringify([...spec.events].sort())) {
      throw new Error(`hook manifest: ${e.id}: sidecar purposes by event must name exactly its events (${spec.events.join(', ')})`)
    }
    if (!Object.values(purpose).every(isSentence)) throw new Error(`hook manifest: ${e.id}: sidecar purpose must be one non-empty, trimmed line`)
  }
  if (!matchers) {
    if (labels !== undefined) throw new Error(`hook manifest: ${e.id}: sidecar labels are for a matcher array only`)
    return
  }
  if (labels === undefined) throw new Error(`hook manifest: ${e.id}: a matcher array needs sidecar labels`)
  if (labels.length !== matchers.length) {
    throw new Error(`hook manifest: ${e.id}: ${labels.length} sidecar labels for ${matchers.length} matcher groups`)
  }
  if (labels[0] !== null) throw new Error(`hook manifest: ${e.id}: the first sidecar label must be null (the bare id)`)
  const rest = labels.slice(1)
  if (!rest.every((l) => typeof l === 'string' && SIDECAR_LABEL_RE.test(l))) {
    throw new Error(`hook manifest: ${e.id}: a sidecar label after the first must be lower-case kebab-case`)
  }
  if (new Set(rest).size !== rest.length) throw new Error(`hook manifest: ${e.id}: duplicate sidecar label`)
}

/**
 * The sidecar text of the main scope: every entry the main agent renders
 * carries complete sidecar text (purpose, and labels for a matcher array, each
 * array as long as the matcher array), no other entry carries any. Apart from
 * validateManifest on purpose (Ron, C3-sch N2): a prose defect must not break
 * renderHooks('main'). Called by the main artifact generator (main-artifact.ts).
 */
export function validateSidecarText(m: HookManifest): void {
  for (const e of m.entries) checkSidecarText(e, specFor(e, 'main'))
}

/**
 * The sidecar id and purpose of one main matcher group: the group the entry
 * renders under `event` for its `matcherIndex`-th matcher (0 when the matcher
 * is not an array). The id is `<event in kebab-case>/<script stem>`, plus
 * `/<label>` after the first matcher group; the stem is the hook name
 * hook_switches.normalize gives (file name, no extension, lower-case).
 */
export function sidecarGroupText(e: HookManifestEntry, event: HookEvent, matcherIndex: number): { id: string; purpose: string } {
  const text = e.sidecar
  if (!text) throw new Error(`hook manifest: ${e.id}: no sidecar text`)
  const stem = basenameOf(e.script).replace(/\.(py|mjs|sh)$/, '').toLowerCase()
  const label = text.labels?.[matcherIndex] ?? null
  const id = `${event.replace(/(?<!^)(?=[A-Z])/g, '-').toLowerCase()}/${stem}${label === null ? '' : `/${label}`}`
  const p = text.purpose
  const purpose = typeof p === 'string' ? p : Array.isArray(p) ? p[matcherIndex] : (p as Partial<Record<HookEvent, string>>)[event]
  if (purpose === undefined) throw new Error(`hook manifest: ${e.id}: no sidecar purpose for ${event} matcher group ${matcherIndex}`)
  return { id, purpose }
}

function checkDqSafePath(what: string, value: string): void {
  if (!DQ_SAFE_ABS_PATH_RE.test(value)) throw new Error(`hook manifest: ${what} must be an absolute path without ", $, backtick or control characters, got: ${value}`)
}

/**
 * Structural check of a manifest for one scope; throws on the first problem.
 * Ids unique, script paths and args plain, every layout slot names an entry of
 * this scope that is registered under that event, every (entry, event) of the
 * scope is placed exactly once, profile/agent conditions and the generator's
 * ownership fields only on sub entries, and no two sub entries can own the same
 * existing hook (same event and script need disjoint ownMatchers).
 * The sidecar text is checked apart, by validateSidecarText.
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
    if (spec.timeout !== undefined && !(Number.isInteger(spec.timeout) && spec.timeout > 0)) throw new Error(`hook manifest: ${e.id}: timeout must be a positive integer`)
    if (Array.isArray(spec.matcher) && spec.matcher.length === 0) throw new Error(`hook manifest: ${e.id}: empty matcher list`)
    if ((e.profileFlag || e.agentFlag || e.threadReplyArgs) && e.scope !== 'sub') {
      throw new Error(`hook manifest: ${e.id}: profile and agent conditions are sub-agent only`)
    }
    if (e.offRemoves && !(e.profileFlag || e.agentFlag)) throw new Error(`hook manifest: ${e.id}: offRemoves needs a profile or agent condition`)
    if (e.ownMatchers && e.scope === 'main') throw new Error(`hook manifest: ${e.id}: ownMatchers is for sub-agent entries`)
    if (e.ownMatchers && e.ownMatchers.length === 0) throw new Error(`hook manifest: ${e.id}: empty ownMatchers`)
  }
  if (scope === 'sub') {
    const sub = m.entries.filter((e) => inScope(e, 'sub') && e.wrapper !== 'agentPrompt')
    for (const [i, a] of sub.entries()) {
      for (const b of sub.slice(i + 1)) {
        if (basenameOf(a.script) !== basenameOf(b.script)) continue
        if (!specFor(a, 'sub').events.some((ev) => specFor(b, 'sub').events.includes(ev))) continue
        if (!a.ownMatchers || !b.ownMatchers || a.ownMatchers.some((x) => b.ownMatchers!.includes(x))) {
          throw new Error(`hook manifest: ${a.id} and ${b.id} run the same script under one event and need disjoint ownMatchers`)
        }
      }
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

/** The root and node binary of a render, checked; throws on a missing or unsafe one. */
function renderPaths(scope: HookScope, ctx: RenderContext): { root: string; nodeBin: string } {
  const root = ctx.root ?? (scope === 'main' ? MAIN_ROOT : undefined)
  if (root === undefined) throw new Error('hook manifest: the sub-agent render needs ctx.root')
  if (scope === 'main' && root !== MAIN_ROOT) checkPlainPath('ctx.root', root)
  if (scope === 'sub') checkDqSafePath('ctx.root', root)
  const nodeBin = ctx.nodeBin ?? ''
  if (scope === 'sub') checkNodeBin(nodeBin)
  const policy = ctx.agent?.senderRolePolicy
  if (policy && !ARG_RE.test(policy)) throw new Error('hook manifest: the sender-role policy needs quoting')
  return { root, nodeBin }
}

/**
 * The `hooks` object one scope's settings carry, in written order. Pure: no
 * file is read or written. Main: every placed entry. Sub: the placed entries
 * whose profile switch and agent property are on and that ctx.skip does not
 * name (ctx.root, ctx.nodeBin and the prompt of each agentPrompt entry are
 * required); an event left with no group is omitted.
 */
export function renderHooks(m: HookManifest, scope: HookScope, ctx: RenderContext = {}): RenderedHooks {
  validateManifest(m, scope)
  const { root, nodeBin } = renderPaths(scope, ctx)
  const byId = new Map(m.entries.map((e) => [e.id, e] as const))
  const out: RenderedHooks = {}
  for (const [event, groups] of Object.entries(m.layout[scope] ?? {}) as Array<[HookEvent, ReadonlyArray<string | readonly string[]>]>) {
    const rendered: RenderedGroup[] = []
    for (const slot of groups) {
      const ids = (typeof slot === 'string' ? [slot] : slot)
        .filter((id) => scope === 'main' || (activeFor(byId.get(id)!, ctx) && !ctx.skip?.has(id)))
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

/** One sub entry's hook object as renderHooks writes it, whatever its switch (the injectors and the generator's guard use it). */
export function renderSubHook(e: HookManifestEntry, ctx: RenderContext): RenderedHook {
  if (!inScope(e, 'sub')) throw new Error(`hook manifest: ${e.id} is not a sub-agent entry`)
  const { root, nodeBin } = renderPaths('sub', ctx)
  return renderHook(e, 'sub', root, nodeBin, ctx)
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
    ...(e.agentFlag === 'senderRolePolicy' ? [ctx.agent?.senderRolePolicy ?? ''] : []),
  ]
  return withTimeout({ type: 'command', command: subCommand(spec, e.script, args, root, nodeBin) })
}
