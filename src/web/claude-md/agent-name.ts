// The one agent-name pattern of the claude-md modules (Ron S5 via Kevin 13036, agreed with Stuart for C1 PR 8b):
// what sanitizeAgentName (src/web/sanitize.ts) produces, a lowercase letter or digit first, then lowercase letters,
// digits and hyphens. No separator, no dot, so a name can never leave agents/. Zero imports on purpose: the
// read-only dry-run CLI and live-context.ts import it.
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

export function isAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name)
}
