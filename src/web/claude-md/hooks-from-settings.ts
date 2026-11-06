// C1: which hooks are really wired for an agent, read from its settings.
//
// A rule marked "enforced by hook X" drops its prose from the region and
// renders as one line ONLY when hooks[X] is true. A false "true" here silently
// removes a security rule from the agent's instructions, so the mapping is
// fail-closed: anything unexpected yields false, and false only costs a longer
// region.
//
// Pure: the caller (PR 10) reads and parses the settings layers that apply to
// the agent (for example the agent's settings.json and settings.local.json) and
// passes the parsed objects. A layer that is not a plain object (a failed
// parse, null, an array) makes EVERY hook false, because the unreadable layer
// could be the one that disables hooks.
//
// true for a hook iff, in some layer:
//   - it sits under its own event (directiveVerify: UserPromptSubmit; the two
//     guards: PreToolUse, with a matcher that covers Bash: none, "", "*", or a
//     "|"-list of plain tool names that includes Bash; any other regex counts
//     as not covering);
//   - in a hooks[] entry of type "command" whose command runs the script: an
//     interpreter (node, python3, python, bash, sh; bare, path-qualified or
//     quoted) in COMMAND POSITION (the start of the text; after &&, ||, ;, |,
//     &, (, {, a `-c '` quote, or then/else/do; optionally behind `exec` and a
//     `timeout [options] <duration>` prefix), directly followed by an ABSOLUTE
//     or variable-rooted path ending in /scripts/hooks/<script> (it starts with
//     "/" or "$", optionally quoted; a relative ./scripts/hooks path resolves
//     against the hook's cwd and reads as false), outside a "#" comment;
// and no layer sets "disableAllHooks" to anything but false.
// So "echo python3 /x/scripts/hooks/<script>" reads false: python3 is an echo
// argument there, not a command.
// Shell text is not parsed beyond that. Known to read TRUE although nothing
// runs: a separator or keyword inside a quoted argument
// (`echo "a; python3 /x/scripts/hooks/<script>"`, `echo do python3 ...`). And
// known to read FALSE although the script runs (fail-closed, only a longer
// region): interpreter flags (python3 -I), `nice`/`env`/`uv run`/`sudo`
// prefixes, a timeout option with a non-numeric value (`timeout -s KILL 8
// python3 X`), `exec` behind `timeout` (`timeout 8 exec python3 X`), an
// interpreter under a quoted variable (`"$CLAUDE_PROJECT_DIR"/.venv/bin/python3
// X`), a script run directly by its shebang (Ron, 7a review 12738). These entries are written by our own
// scaffold; the check is there against stale, mis-placed or disabled wiring,
// not against the settings' author. "Wired" is not "present": whether the
// script file exists and is executable is PR 10's check (Ron, 7a J4).

import { HOOK_IDS, type HookId } from './context.js'

interface HookSpec {
  event: 'UserPromptSubmit' | 'PreToolUse'
  script: string
  needsBashMatcher: boolean
}

// directive-verify.py does not exist yet: it is the UserPromptSubmit hook of
// C1 step 13 (main agent). That step must ship it under this name, or change
// this constant in the same PR.
export const HOOK_SPECS: Readonly<Record<HookId, HookSpec>> = {
  directiveVerify: { event: 'UserPromptSubmit', script: 'directive-verify.py', needsBashMatcher: false },
  childClaudeGuard: { event: 'PreToolUse', script: 'child-claude-channel-guard.mjs', needsBashMatcher: true },
  shellRescan: { event: 'PreToolUse', script: 'shell-rescan-guard.py', needsBashMatcher: true },
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function matcherCoversBash(matcher: unknown): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true
  if (typeof matcher !== 'string') return false
  const alts = matcher.split('|')
  return alts.every((a) => /^[A-Za-z0-9_]+$/.test(a)) && alts.includes('Bash')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function commandRunsScript(command: unknown, script: string): boolean {
  if (typeof command !== 'string') return false
  // Drop a shell comment: from the first "#" that starts a word.
  const code = command.replace(/(^|\s)#[\s\S]*$/, '$1')
  // Where a command word can start, and what may stand between that and the interpreter.
  const start = String.raw`(?:^|&&|\|\||[;|&({]|-c\s+['"]|\b(?:then|else|do)\b)`
  const duration = String.raw`\d+(?:\.\d+)?[smhd]?`
  const prefix = String.raw`(?:\s*exec\b)?(?:\s*timeout(?:\s+-{1,2}[A-Za-z][\w-]*(?:=\S+|\s+${duration})?)*\s+${duration})?`
  const interp = String.raw`(?:"[^"\s]*\/)?(?:[^"'\s]*\/)?(?:node|python3|python|bash|sh)"?`
  // "/root/x/scripts/hooks/s", "$CLAUDE_PROJECT_DIR/scripts/hooks/s", "$CLAUDE_PROJECT_DIR"/scripts/hooks/s;
  // never "./scripts/hooks/s" or "scripts/hooks/s"
  const path = String.raw`["']?(?=[\/$])[^\s;&|]*\/scripts\/hooks\/${escapeRe(script)}["']?`
  const re = new RegExp(String.raw`${start}${prefix}\s*${interp}\s+${path}(?=$|[\s;&|)])`)
  return re.test(code)
}

function layerWires(layer: Record<string, unknown>, spec: HookSpec): boolean {
  const hooks = layer.hooks
  if (!isPlainObject(hooks)) return false
  const entries = hooks[spec.event]
  if (!Array.isArray(entries)) return false
  return entries.some((entry) => {
    if (!isPlainObject(entry)) return false
    if (spec.needsBashMatcher && !matcherCoversBash(entry.matcher)) return false
    const list = entry.hooks
    if (!Array.isArray(list)) return false
    return list.some((h) => isPlainObject(h) && h.type === 'command' && commandRunsScript(h.command, spec.script))
  })
}

export function hooksFromSettings(layers: readonly unknown[]): Record<HookId, boolean> {
  const none = Object.fromEntries(HOOK_IDS.map((id) => [id, false])) as Record<HookId, boolean>
  if (!layers.every(isPlainObject)) return none
  const objs = layers as readonly Record<string, unknown>[]
  // Only an absent or literal false value leaves hooks on: a "true" string or a 1
  // is not what Claude Code documents, but reading it as "on" would fail open.
  if (objs.some((l) => l.disableAllHooks !== undefined && l.disableAllHooks !== false)) return none
  const result = { ...none }
  for (const id of HOOK_IDS) {
    result[id] = objs.some((l) => layerWires(l, HOOK_SPECS[id]))
  }
  return result
}
