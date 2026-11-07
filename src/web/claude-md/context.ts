// C1 (deterministic CLAUDE.md builder): the typed input of one render.
//
// One AgentDocContext is built per render and passed to every section. The
// renderer is a pure function of the context and is tested with fixture
// contexts; the live builder (.env, store/autonomy-config.json, the agent's
// settings layers) is live-context.ts (C1 PR 10a), which names every value it
// could not read from a real source.
//
// Design: store/fork-audit/phase-c/C1-C2-design.md section 2.1. Deviations,
// agreed with Kevin (msg 12679):
// - `team` carries the hierarchy (reportsTo / directReports), because today's
//   fleet-roster block prints it (TEAMROSTER1023) and the v2 region must not lose it.
// - `hooks` is keyed by the closed HookId union, so a new hook can only arrive
//   by widening the type, and every exhaustive switch over it stops compiling
//   until it handles the new id.
// - `roster` carries names only (PR 7b, Kevin 12773); see the field.
// - `federation` carries the peer list and the routing mode (C1 PR 12b); see
//   the field.

import type { FederationRoutingMode } from '../federation/validate.js'

// A hook whose presence lets a rule drop its prose and render as one line
// ("enforced by hook X"). Which settings entry counts as "wired" for each id is
// decided in hooks-from-settings.ts, fail-closed.
export type HookId = 'directiveVerify' | 'childClaudeGuard' | 'shellRescan'

export const HOOK_IDS: readonly HookId[] = ['directiveVerify', 'childClaudeGuard', 'shellRescan']

export type AgentRole = 'main' | 'sub' | 'heartbeat'

export type AutonomyLevel = 1 | 2 | 3

export interface AgentDocContext {
  name: string
  role: AgentRole
  mainAgentId: string
  botName: string
  // chatId null -> the line is omitted, never rendered as "0" (the install
  // template renders "0" before pairing today).
  owner: { name: string; chatId: string | null }
  projectRoot: string
  // The agent's dashboard token file. NEVER rendered into the CLAUDE.md region
  // (a test asserts that), and not used by the product skills either: those
  // live in the shared <project>/.claude/skills, so they carry no per-agent
  // value and state the token-file rule as text (C1 PR 9, skills.ts). Its only
  // readers today are the tests that assert it stays out of the output.
  tokenPath: string
  profile: { id: string; strict: boolean; helperAllowed: boolean }
  capabilities: {
    kanbanWrite: boolean
    scheduleWrite: boolean
    emailSend: 'none' | 'gated'
    browser: boolean
    federation: boolean
    thinChief: boolean
    // The agent owns a channel (Telegram, Discord, Slack, Google Chat, Teams;
    // channel.ts agentHasChannel, fail safe). false = headless: the region
    // drops the channel-bound rules and the owner-communication lines (C1 PR
    // 11a-2).
    channel: boolean
  }
  autonomy: Record<string, AutonomyLevel>
  team: { reportsTo: string | null; directReports: string[] }
  // Every other agent of the fleet, without self. Names only (C1 PR 7b, Kevin
  // 12773, deviation from design 2.1): free text from an editable config (the
  // agent-config description) must never be able to break the render for every
  // sub at once, so no description reaches the region. The relation comes from
  // `team`.
  roster: { name: string }[]
  hooks: Record<HookId, boolean>
  // C1 PR 12b: store/federation.json as the bridge validates it
  // (federation/validate.ts). Rendered only when capabilities.federation is
  // on; off (or an invalid file) leaves no peers and the default mode. No
  // token reaches the ctx: `paired` says only whether the peer's outbound
  // token is set (empty = pairing pending, not addressable yet). Peer ids are
  // the validator's: [a-z0-9][a-z0-9_-]{0,63}, lower-cased.
  federation: { routingMode: FederationRoutingMode; peers: { id: string; paired: boolean }[] }
}
