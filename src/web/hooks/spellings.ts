// The hook command spellings the manifest writes or has written (C3-5a, Ron 14094): fixed templates, one per
// wrapper kind, with slots. The settings dry-run (dry-run.ts) calls a hook REWRAPPED only when both its old and its
// new command are one of these spellings and the slots agree; any other text is unknown, so a hand edit or a
// behaviour change shows as a drift instead of being absorbed.
//
// Kept as literal text on purpose, not derived from the manifest's builders: a spelling the manifest no longer
// writes (C3-5b retires some) must still be recognised, on the window's before side and after a rollback.
// hook-spellings.test.ts ties the table to the manifest: every command the manifest renders, in both scopes and
// with every switch on, classifies as the entry's own wrapper kind, with its script, arguments and deadline.
//
// Pure: no import, no I/O.

/** A command matched to a known spelling: which one, and what its slots hold. */
export interface Spelling {
  kind: string
  /** python3, node, bash, or the burnt-in node binary of failClosedNodeBin. */
  interpreter: string
  /** The script path the command runs (every occurrence in the template is this same path). */
  path: string
  args: string[]
  /** The gate deadline in `timeout -k 1 <n>`, where the spelling has one. */
  deadline?: number
}

type Scope = 'main' | 'sub'

interface Template {
  kind: string
  scopes: readonly Scope[]
  text: string
  /** Only on these events (a spelling whose failure exit can block nothing, see `bare` in manifest.ts). */
  events?: readonly string[]
}

// Slots: {P} script path, {I} interpreter word, {A} argument words (each after a blank), {D} gate deadline,
// {L} gate label (the script's file name), {N} node binary, {R} install root.
const GATE_TAIL = '; rc=$?; [ "$rc" = 0 ] || [ "$rc" = 2 ] || { echo "governance-kapu (fail-closed): {L}: a kapu nem 0-val vagy '
  + '2-vel lepett ki (rc=$rc: betoltesi hiba, hianyzo fajl, jel vagy idotullepes). A hivas ezert TILTVA. Javitas: a kapu '
  + 'fajlja vagy egy fuggosege hibas, a hibauzenet fent." >&2; exit 2; }; exit "$rc"'
const gateRun = (inv: string) => `if command -v timeout >/dev/null 2>&1; then timeout -k 1 {D} ${inv}; else ${inv}; fi${GATE_TAIL}`
const NOT_BLOCKING = ['SessionStart', 'SessionEnd', 'PostToolUse', 'PostToolUseFailure']

const TEMPLATES: readonly Template[] = [
  // Fail-open. failOpenExec is the main spelling and the planned C3-5b sub spelling (listed for sub already, so a
  // revert of C3-5b still classifies the files it wrote).
  { kind: 'failOpenExec', scopes: ['main', 'sub'], text: `bash -c '[ -f "{P}" ] && exec {I} "{P}"{A}; exit 0'` },
  { kind: 'failOpenExecUnquoted', scopes: ['sub'], text: `bash -c '[ -f {P} ] && exec {I} {P}{A}; exit 0'` },
  { kind: 'bare', scopes: ['sub'], text: '{I} {P}{A}', events: NOT_BLOCKING },
  { kind: 'bareQuoted', scopes: ['sub'], text: '{I} "{P}"{A}', events: NOT_BLOCKING },
  {
    kind: 'failOpenNodeProbe', scopes: ['main'],
    text: `bash -c '[ -f "{P}" ] && command -v {I} >/dev/null 2>&1 || exit 0; if command -v timeout >/dev/null 2>&1; `
      + `then timeout -k 1 {D} {I} "{P}"{A}; else {I} "{P}"{A}; fi; [ $? = 2 ] && exit 2; exit 0'`,
  },
  {
    kind: 'failOpenExecClosedWhenFrozen', scopes: ['main'],
    text: `bash -c '[ -f "{P}" ] && exec {I} "{P}"{A}; [ -e "{R}/store/fleet-freeze.json" ] && { echo "fleet-freeze-gate `
      + '(fail-closed while frozen): the gate script is missing and store/fleet-freeze.json exists, so every tool call is '
      + `blocked. Fix: restore scripts/hooks/fleet-freeze-gate.sh or unfreeze from the dashboard." >&2; exit 2; }; exit 0'`,
  },
  // Fail-closed.
  { kind: 'failClosedRun', scopes: ['main'], text: gateRun('{I} "{P}"{A}') },
  {
    kind: 'failClosedRunNodeProbe', scopes: ['main'],
    text: 'command -v node >/dev/null 2>&1 || { echo "governance-kapu: node interpreter hianyzik, a kapu BLOKKOL" >&2; exit 2; }; '
      + gateRun('{I} "{P}"{A}'),
  },
  {
    kind: 'failClosedPythonProbe', scopes: ['main', 'sub'],
    text: 'command -v python3 >/dev/null 2>&1 || { echo "governance-kapu: a hook interpretere nem talalhato (python3 nincs a '
      + 'PATH-on). A kapu ezert BLOKKOL. Javitas: telepitsd a python3-at, vagy inditsd ujra a dashboardot." >&2; exit 2; }; '
      + gateRun('{I} "{P}"{A}'),
  },
  {
    kind: 'failClosedNodeBin', scopes: ['sub'],
    text: 'test -x "{N}" || { echo "governance-kapu: a hook interpretere nem talalhato ({N}). A kapu ezert BLOKKOL. Javitas: '
      + 'inditsd ujra a dashboardot, az ujrairja a hook-utakat." >&2; exit 2; }; ' + gateRun('"{N}" "{P}"{A}'),
  },
]

const SLOT: Readonly<Record<string, string>> = {
  P: String.raw`(?:\$CLAUDE_PROJECT_DIR)?\/[^\s"'$\x60\\;&|<>()]+\.(?:py|mjs|sh)`,
  I: 'python3|node|bash',
  A: String.raw`(?: [A-Za-z0-9_=.:-]+)*`,
  D: '[0-9]{1,5}',
  L: '[A-Za-z0-9_.-]+',
  N: String.raw`\/[^"$\x60\\\x00-\x1f\x7f]+`,
  R: String.raw`\$CLAUDE_PROJECT_DIR|\/[^\s"'$\x60\\;&|<>()]+`,
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The template as an anchored regex: a slot's first occurrence is a named group, every later one must repeat it. */
function compile(text: string): RegExp {
  const seen = new Set<string>()
  const re = text.split(/(\{[A-Z]\})/).map((part) => {
    const slot = /^\{([A-Z])\}$/.exec(part)?.[1]
    if (!slot) return escapeRe(part)
    if (seen.has(slot)) return `\\k<${slot}>`
    seen.add(slot)
    return `(?<${slot}>${SLOT[slot]})`
  }).join('')
  return new RegExp(`^${re}$`)
}

const COMPILED = TEMPLATES.map((t) => ({ ...t, re: compile(t.text) }))

const INTERPRETER_OF: Readonly<Record<string, string>> = { py: 'python3', mjs: 'node', sh: 'bash' }

/** The manifest's gate deadline for a hook timeout (manifest.ts gateDeadlineSec, repeated so this module imports nothing). */
function deadlineFor(timeout: unknown): number | undefined {
  return typeof timeout === 'number' && Number.isFinite(timeout) ? Math.max(1, Math.floor(timeout) - 2) : undefined
}

/**
 * The known spelling `command` is, for a hook with `timeout` under `event`, in `scope`; null when it is none. Beyond
 * the template: the interpreter fits the script's extension (a node binary for .mjs only), a gate's label is the
 * script's file name, and its deadline is the one the manifest derives from the hook's own timeout.
 */
export function classifySpelling(command: string, timeout: unknown, event: string, scope: Scope = 'sub'): Spelling | null {
  for (const t of COMPILED) {
    if (!t.scopes.includes(scope) || (t.events && !t.events.includes(event))) continue
    const g = t.re.exec(command)?.groups
    if (!g) continue
    const path = g.P
    const ext = path.slice(path.lastIndexOf('.') + 1)
    const interpreter = g.N ?? g.I
    if (g.N !== undefined ? ext !== 'mjs' : INTERPRETER_OF[ext] !== interpreter) continue
    if (t.kind === 'failClosedPythonProbe' && interpreter !== 'python3') continue
    if (t.kind === 'failClosedRunNodeProbe' && interpreter !== 'node') continue
    if (g.L !== undefined && g.L !== path.slice(path.lastIndexOf('/') + 1)) continue
    if (g.R !== undefined && !path.startsWith(`${g.R}/scripts/`)) continue
    let deadline: number | undefined
    if (g.D !== undefined) {
      deadline = Number(g.D)
      if (deadline !== deadlineFor(timeout)) continue
    }
    const args = g.A ? g.A.slice(1).split(' ') : []
    return { kind: t.kind, interpreter, path, args, ...(deadline === undefined ? {} : { deadline }) }
  }
  return null
}
