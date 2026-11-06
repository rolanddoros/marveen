// C1 (deterministic CLAUDE.md builder): the typed input of one render.
//
// One AgentDocContext is built per render and passed to every section. In this
// PR (C1 PR 7a) nothing builds it from the live install: the renderer is a pure
// function of the context and is tested with fixture contexts. The live builder
// (.env, store/autonomy-config.json, the settings file just written) is PR 10.
//
// Design: store/fork-audit/phase-c/C1-C2-design.md section 2.1. Deviations,
// agreed with Kevin (msg 12679):
// - `team` carries the hierarchy (reportsTo / directReports), because today's
//   fleet-roster block prints it (TEAMROSTER1023) and the v2 region must not lose it.
// - `hooks` is keyed by the closed HookId union, so a new hook can only arrive
//   by widening the type, and every exhaustive switch over it stops compiling
//   until it handles the new id.

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
  // Carried for the product skills (PR 9). It is NEVER rendered into the
  // CLAUDE.md region; a test asserts that.
  tokenPath: string
  profile: { id: string; strict: boolean; helperAllowed: boolean }
  capabilities: {
    kanbanWrite: boolean
    scheduleWrite: boolean
    emailSend: 'none' | 'gated'
    browser: boolean
    federation: boolean
    thinChief: boolean
  }
  autonomy: Record<string, AutonomyLevel>
  team: { reportsTo: string | null; directReports: string[] }
  // Every other agent of the fleet, without self.
  roster: { name: string; role: string }[]
  hooks: Record<HookId, boolean>
}
