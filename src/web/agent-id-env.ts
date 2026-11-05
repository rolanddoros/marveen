// C2 PR6: every Claude Code session the dashboard launches carries its agent's canonical name as
// MARVEEN_AGENT_ID, so scripts/marveen-api.sh (scripts/lib/marveen_api.py) can default the identity
// arguments (<updated-by>, <agent>, <from>) instead of the model typing them on every call.
//
// ATTRIBUTION ONLY, NOT A SECURITY BOUNDARY: the value is self-asserted -- any process in the pane can
// change it, and the fleet shares one Bearer token (C5 is the per-agent token work). Nothing may
// authorise on it; an explicit argument to the helper always wins over it.

export const AGENT_ID_ENV_VAR = 'MARVEEN_AGENT_ID'

/**
 * The shell piece `export MARVEEN_AGENT_ID=<quoted name>` (no separator: the caller joins it with
 * its own `&&` / `;`). `quote` is the launch builder's own POSIX single-quote escaper, so the name is
 * one inert shell word whatever it contains.
 */
export function agentIdEnvExport(agentId: string, quote: (s: string) => string): string {
  return `export ${AGENT_ID_ENV_VAR}=${quote(agentId)}`
}
