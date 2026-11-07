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
//     &, (, {, or then/else/do standing behind one of those; inside the
//     quoted body of a `bash -c` / `sh -c` that is itself in command position,
//     checked with the same rules; optionally behind `exec` and a
//     `timeout [options] <duration>` prefix), directly followed by an ABSOLUTE
//     or variable-rooted path ending in /scripts/hooks/<script> (it starts with
//     "/" or "$", optionally quoted; a relative ./scripts/hooks path resolves
//     against the hook's cwd and reads as false), outside a "#" comment;
//   - and the script word resolves (an absolute path, or $CLAUDE_PROJECT_DIR
//     resolved to the agent's project directory; any other variable is not
//     resolved) to an existing, readable regular file (J4, below);
// and no layer sets "disableAllHooks" to anything but false.
// So "echo python3 /x/scripts/hooks/<script>" reads false: python3 is an echo
// argument there, not a command.
// Quoted text that holds a blank or a separator is an argument, so its content
// is ignored outside a shell's -c body; that closes the 7a residual where a
// separator or keyword inside an argument read TRUE (`echo "a; python3
// /x/scripts/hooks/<script>"`, `echo do python3 ...`, `echo -c 'python3 ...'`,
// `echo "a | python3 ..."`; Ron 12738, closed in C1 PR 10a).
// Shell text is not parsed beyond that. Known to read FALSE although the
// script runs (fail-closed, only a longer
// region): interpreter flags (python3 -I), `nice`/`env`/`uv run`/`sudo`
// prefixes, a timeout option with a non-numeric value (`timeout -s KILL 8
// python3 X`), `exec` behind `timeout` (`timeout 8 exec python3 X`), an
// interpreter under a quoted variable (`"$CLAUDE_PROJECT_DIR"/.venv/bin/python3
// X`), a script run directly by its shebang (Ron, 7a review 12738). These entries are written by our own
// scaffold; the check is there against stale, mis-placed or disabled wiring,
// not against the settings' author. "Wired" is not "present" (Ron, 7a J4):
// the template form `[ -f X ] && exec python3 X; exit 0` exits 0 silently when
// X is missing, so a missing script must read false. Every form recognised
// here runs the script through an interpreter, so the rule is: an existing,
// readable regular file (a direct, shebang run would also need the exec bit,
// and reads false already). The caller supplies the file check, so this
// module stays pure.

import { posix } from 'node:path'
import { HOOK_IDS, type HookId } from './context.js'

interface HookSpec {
  event: 'UserPromptSubmit' | 'PreToolUse'
  script: string
  needsBashMatcher: boolean
}

// directive-verify.py is the UserPromptSubmit hook C1 PR 13a ships (wired in the
// repo's .claude/settings.json and in templates/settings.json.template). A rename
// changes this constant in the same PR.
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

// Quoted text that holds a blank or a separator is an argument, never a command word: its content is
// blanked before the command-position match (Ron 7a review 12738), so `echo "a; python3 X"` and
// `echo "a | python3 X"` read false. A quoted single word ("/usr/bin/node", "$CLAUDE_PROJECT_DIR"/...) stays.
function blankQuotedPhrases(code: string): string {
  return code.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (m) => (/[\s;&|]/.test(m) ? "''" : m))
}

// Where a command word can start. then/else/do count only behind a separator (or at the start), so
// `echo do python3 X` reads false (Ron 12738).
const START = String.raw`(?:^|&&|\|\||[;|&({]|(?:^|[;&|({\n])\s*(?:then|else|do)\b)`

// The body of a `bash -c '...'` / `sh -c "..."` whose shell is itself in command position; the body is
// checked with the same rules, recursively. A `-c` of any other command (`echo -c 'python3 X'`) is
// just an argument (Ron 12738).
const SHELL_C = new RegExp(
  String.raw`${START}\s*(?:exec\s+)?(?:"[^"\s]*\/)?(?:[^"'\s;&|]*\/)?(?:bash|sh)"?(?:\s+-[A-Za-z]+)*?\s+-[A-Za-z]*c\s+`
  + String.raw`(?:'([^']*)'|"((?:[^"\\]|\\.)*)")`,
  'g',
)

const MAX_DEPTH = 4

// The raw script-path words (quotes kept) of every place where `command` runs scripts/hooks/<script>
// through an interpreter in command position. Empty = not run.
export function scriptPathsRun(command: unknown, script: string, depth = 0): string[] {
  if (typeof command !== 'string' || depth > MAX_DEPTH) return []
  // Drop a shell comment: from the first "#" that starts a word.
  const code = command.replace(/(^|\s)#[\s\S]*$/, '$1')
  const found: string[] = []
  for (const m of code.matchAll(SHELL_C)) {
    const body = m[1] ?? m[2].replace(/\\(["\\$`])/g, '$1')
    found.push(...scriptPathsRun(body, script, depth + 1))
  }
  const outer = blankQuotedPhrases(code)
  const duration = String.raw`\d+(?:\.\d+)?[smhd]?`
  const prefix = String.raw`(?:\s*exec\b)?(?:\s*timeout(?:\s+-{1,2}[A-Za-z][\w-]*(?:=\S+|\s+${duration})?)*\s+${duration})?`
  const interp = String.raw`(?:"[^"\s]*\/)?(?:[^"'\s]*\/)?(?:node|python3|python|bash|sh)"?`
  // "/root/x/scripts/hooks/s", "$CLAUDE_PROJECT_DIR/scripts/hooks/s", "$CLAUDE_PROJECT_DIR"/scripts/hooks/s;
  // never "./scripts/hooks/s" or "scripts/hooks/s"
  const path = String.raw`(["']?(?=[\/$])[^\s;&|]*\/scripts\/hooks\/${escapeRe(script)}["']?)`
  const re = new RegExp(String.raw`${START}${prefix}\s*${interp}\s+${path}(?=$|[\s;&|)])`, 'g')
  for (const m of outer.matchAll(re)) found.push(m[1])
  return found
}

export function commandRunsScript(command: unknown, script: string): boolean {
  return scriptPathsRun(command, script).length > 0
}

// J4 (Ron, 7a review): "wired" also means the named script file is there. Every match above runs the
// script through an interpreter, so the file must be an existing, readable regular file; a script run
// directly by its shebang would also need the exec bit, but that form reads false already (header).
// The check itself is the caller's (`usable`), so this module stays free of fs.
export interface ScriptFileCheck {
  // The agent's project directory, what Claude Code sets as $CLAUDE_PROJECT_DIR for its hooks.
  projectDir: string
  // true iff the absolute path is an existing, readable regular file.
  usable: (absPath: string) => boolean
}

// The absolute path a raw script word names, or null when it cannot be resolved without running a
// shell (any variable other than $CLAUDE_PROJECT_DIR, a relative result): fail-closed.
export function resolveHookScriptPath(raw: string, projectDir: string): string | null {
  let p = raw.replace(/["']/g, '')
  const m = /^(?:\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\})(?=\/)/.exec(p)
  if (m) {
    if (!posix.isAbsolute(projectDir)) return null
    p = projectDir + p.slice(m[0].length)
  }
  if (p.includes('$') || !posix.isAbsolute(p)) return null
  return posix.normalize(p)
}

function layerWires(layer: Record<string, unknown>, spec: HookSpec, check: ScriptFileCheck): boolean {
  const hooks = layer.hooks
  if (!isPlainObject(hooks)) return false
  const entries = hooks[spec.event]
  if (!Array.isArray(entries)) return false
  return entries.some((entry) => {
    if (!isPlainObject(entry)) return false
    if (spec.needsBashMatcher && !matcherCoversBash(entry.matcher)) return false
    const list = entry.hooks
    if (!Array.isArray(list)) return false
    return list.some((h) => isPlainObject(h) && h.type === 'command'
      && scriptPathsRun(h.command, spec.script).some((raw) => {
        const abs = resolveHookScriptPath(raw, check.projectDir)
        return abs !== null && check.usable(abs)
      }))
  })
}

export function hooksFromSettings(layers: readonly unknown[], check: ScriptFileCheck): Record<HookId, boolean> {
  const none = Object.fromEntries(HOOK_IDS.map((id) => [id, false])) as Record<HookId, boolean>
  if (!layers.every(isPlainObject)) return none
  const objs = layers as readonly Record<string, unknown>[]
  // Only an absent or literal false value leaves hooks on: a "true" string or a 1
  // is not what Claude Code documents, but reading it as "on" would fail open.
  if (objs.some((l) => l.disableAllHooks !== undefined && l.disableAllHooks !== false)) return none
  const result = { ...none }
  for (const id of HOOK_IDS) {
    result[id] = objs.some((l) => layerWires(l, HOOK_SPECS[id], check))
  }
  return result
}
