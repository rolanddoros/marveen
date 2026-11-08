// The sub-agent settings dry-run (C3-3a): per agent of an install tree, what the
// generator (sub-generator.ts) would write into its settings.json `hooks`, as a
// diff against the file on disk. Read only; the entry is hooks/cli.ts. The gate
// for C3-3b going live is the flattened multiset of the hooks (event, matcher,
// hook object): EMPTY for every agent; order and grouping may change (the first
// render normalises them, Johnny 13728).

import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unifiedDiff, splitRaw, type DiffLine } from '../claude-md/line-diff.js'
import { isAgentName } from '../claude-md/agent-name.js'
import { EXTRA_HOOK_EVENTS, loadExtraHookEntries } from '../extra-hook-entries.js'
import { HOOK_MANIFEST, nodeGateCommand, pythonGateCommand } from './manifest.js'
import { generateSubHooks, HookShapeError, scriptBasename } from './sub-generator.js'
import { isUnsafeHookCommand, listSubAgents, mainAgentIdOf, resolveHookNodeBin, subHookFlags } from './sub-inputs.js'

export class UsageError extends Error {}

export interface DryRunOptions {
  root: string
  nodeBin: string
  agents?: readonly string[]
  diff?: boolean
  redactNames?: boolean
}

export interface AgentDryRun {
  name: string
  status: 'ok' | 'no-settings' | 'error'
  error?: string
  profile?: string
  before: number
  after: number
  added: string[]
  dropped: string[]
  /** Hooks kept as they are (not the manifest's, or a switched-off gate's copy). */
  kept: string[]
  /** Order or grouping changes, per event. */
  normalised: string[]
  unsafe: string[]
  diff?: string
}

export interface DryRunSummary {
  agents: number
  /** Agents whose settings were read and compared. */
  compared: number
  empty: number
  drift: number
  /** Agents without a settings.json: exit stays 0, but the C3-5 go-live gate requires none (Kevin 13873). */
  noSettings: string[]
  errors: string[]
}

export interface DryRunResult {
  root: string
  nodeBin: string
  mainAgentId: string
  /** Problems of the install's extra-hooks file (its invalid entries are left out, as the dashboard does). */
  extrasErrors: string[]
  agents: AgentDryRun[]
  summary: DryRunSummary
  exit: 0 | 1
}

type Group = { matcher?: unknown; hooks?: unknown }
type Flat = { key: string; label: string }

/** A stand-in where an agent has no PreCompact prompt yet: the boot seeds the template's, the dry-run shows it as added. */
const SEED_PROMPT = '(the template PreCompact prompt, seeded by the boot)'

// This output is evidence that gets pasted into PRs and logs, so no value from an agent's settings file is printed
// as it is, in any mode, unless it is on a short list: an operator's hook can carry a credential in its command, an
// http hook's url or headers, an agent hook's prompt (Ron N1, N6). Printed as they are: the group's matcher (by
// design: the labels name it), a known event name, the hook fields below, each only with its expected type, and the
// key names of Claude Code's hook schema. Everything else is a tag.

/** Event names printed as they are: the manifest's and the extra-hooks file's; any other key of a file is a tag (Ron N7). */
const KNOWN_EVENTS: ReadonlySet<string> = new Set([...EXTRA_HOOK_EVENTS, ...HOOK_MANIFEST.entries.flatMap((e) => e.events)])
/** Hook types printed as they are: the five of Claude Code's hook schema (Ron N10: mcp_tool was a tag). */
const HOOK_TYPES: ReadonlySet<string> = new Set(['command', 'agent', 'prompt', 'http', 'mcp_tool'])
/** The hook fields printed as they are, each with the one value type it may have; statusMessage is free text, so a tag. */
const PLAIN_FIELDS: ReadonlyMap<string, (v: unknown) => boolean> = new Map([
  ['type', (v: unknown) => typeof v === 'string' && HOOK_TYPES.has(v)],
  ['timeout', (v: unknown) => typeof v === 'number' && Number.isFinite(v)],
  ['async', (v: unknown) => typeof v === 'boolean'],
])
/** Key NAMES printed as they are (Ron N8): Claude Code's hook fields and a group's two keys; any other name is `field #<tag>`. */
const HOOK_FIELDS: ReadonlySet<string> = new Set(['type', 'command', 'args', 'async', 'asyncRewake', 'shell', 'onFailure', 'url',
  'headers', 'allowedEnvVars', 'server', 'tool', 'input', 'prompt', 'model', 'if', 'timeout', 'statusMessage', 'once'])
const GROUP_KEYS: ReadonlySet<string> = new Set(['matcher', 'hooks'])

type Tagger = (value: unknown) => string

/**
 * `#` + 8 hex of an HMAC-SHA256 under a random key made for this run and never printed (Ron 13906: an unsalted hash
 * of a command is a guessing oracle for a weak secret in a known template). Within one run the same value gets the
 * same tag, so before and after line up; across runs nothing can be matched, and nothing can be guessed offline.
 */
function newTagger(): Tagger {
  const key = randomBytes(32)
  return (value) => `#${createHmac('sha256', key).update(JSON.stringify(value) ?? String(value)).digest('hex').slice(0, 8)}`
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const eventName = (event: string, tag: Tagger): string => (KNOWN_EVENTS.has(event) ? event : `event ${tag(event)}`)
const keyName = (key: string, known: ReadonlySet<string>, tag: Tagger): string => (known.has(key) ? key : `field ${tag(key)}`)

/** How a hook command is named in a label: the script file it runs, else `command #<tag>`. Never its text. */
function commandTag(command: string, tag: Tagger): string {
  return scriptBasename(command) ?? `command ${tag(command)}`
}

function hookField(field: string, value: unknown, tag: Tagger): unknown {
  if (field === 'command' && typeof value === 'string') return `${scriptBasename(value) ?? 'command'} ${tag(value)}`
  return PLAIN_FIELDS.get(field)?.(value) ? value : tag(value)
}

/** The hooks block as --diff shows it: the printable values as they are, every other value a tag. */
function shownHooks(hooks: Record<string, unknown>, tag: Tagger): unknown {
  const hook = (h: unknown) => (!isRecord(h) ? tag(h)
    : Object.fromEntries(Object.entries(h).map(([f, x]) => [keyName(f, HOOK_FIELDS, tag), hookField(f, x, tag)])))
  const group = (g: unknown) => (!isRecord(g) ? tag(g) : Object.fromEntries(Object.entries(g).map(([k, v]) => [keyName(k, GROUP_KEYS, tag),
    k === 'matcher' && typeof v === 'string' ? v : k === 'hooks' && Array.isArray(v) ? v.map(hook) : tag(v)])))
  return Object.fromEntries(Object.entries(hooks).map(([event, groups]) => [eventName(event, tag),
    Array.isArray(groups) ? groups.map(group) : tag(groups)]))
}

/**
 * The multiset key is the event, the group's matcher and the WHOLE hook object: type, command, timeout and any
 * other field (async, statusMessage, ...). A change to any of them is a drift, so a changed field can never read
 * as EMPTY.
 */
function flatten(hooks: unknown, tag: Tagger): Flat[] {
  const out: Flat[] = []
  if (typeof hooks !== 'object' || hooks === null) return out
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    for (const g of groups as Group[]) {
      for (const h of Array.isArray(g?.hooks) ? (g.hooks as Record<string, unknown>[]) : []) {
        const o = { event, ...(g.matcher === undefined ? {} : { matcher: g.matcher }), ...h } as Record<string, unknown>
        const what = typeof h?.command === 'string' ? commandTag(h.command, tag) : hookField('type', h?.type, tag)
        const timeout = h?.timeout === undefined ? '-' : hookField('timeout', h.timeout, tag)
        out.push({ key: JSON.stringify(o, Object.keys(o).sort()), label: `${eventName(event, tag)} [${typeof g.matcher === 'string' ? g.matcher : '-'}] ${what} timeout=${timeout}` })
      }
    }
  }
  return out
}

/** Multiset difference a - b, as labels. */
function minus(a: Flat[], b: Flat[]): string[] {
  const left = new Map<string, number>()
  for (const x of b) left.set(x.key, (left.get(x.key) ?? 0) + 1)
  const out: string[] = []
  for (const x of a) {
    const n = left.get(x.key) ?? 0
    if (n > 0) left.set(x.key, n - 1)
    else out.push(x.label)
  }
  return out
}

function shape(hooks: Record<string, unknown>, event: string): string {
  const groups = Array.isArray(hooks[event]) ? (hooks[event] as Group[]) : []
  return `[${groups.map((g) => (Array.isArray(g?.hooks) ? g.hooks.length : 0)).join(',')}]`
}

function normalised(before: Record<string, unknown>, after: Record<string, unknown>, tag: Tagger): string[] {
  const out: string[] = []
  if (Object.keys(before).join('\n') !== Object.keys(after).join('\n')) out.push('event order')
  const keys = (hooks: Record<string, unknown>, event: string) => flatten({ [event]: hooks[event] }, tag).map((f) => f.key).join('\n')
  for (const event of Object.keys(after)) {
    const a = shape(before, event)
    const b = shape(after, event)
    if (a !== b) out.push(`${eventName(event, tag)} ${a} -> ${b}`)
    else if (keys(before, event) !== keys(after, event)) out.push(`${eventName(event, tag)} order`)
  }
  return out
}

class SettingsReadError extends Error {}

// The extra-hooks file's errors as fixed texts (Ron N9): its loader quotes the file (a parser fragment, unknown key
// names, a script path). Only the entry's index and the problem's kind are printed; an unknown message is one fixed line.
const EXTRAS_ENTRY: ReadonlyMap<string, string> = new Map([['must', 'not an object'], ['unknown', 'unknown key(s)'],
  ...['event', 'scope', 'matcher', 'timeout', 'failClosed', 'script'].map((k): [string, string] => [k, `invalid ${k}`])])
const EXTRAS_FILE: ReadonlyArray<[string, string]> = [['unreadable: ', 'not readable'], ['not valid JSON: ', 'not valid JSON'],
  ['the file must be an object with an "entries" array', 'not an object with an "entries" array']]
function extrasError(e: string): string {
  const entry = /^entries\[(\d{1,6})\]: (\w+)/.exec(e)
  if (entry) return `entries[${entry[1]}]: ${EXTRAS_ENTRY.get(entry[2]) ?? 'invalid'}; this entry is left out`
  const file = EXTRAS_FILE.find(([prefix]) => e.startsWith(prefix))
  return file ? `${file[1]}; every extra ignored` : 'an error whose text is not printed'
}

// The errors name the problem, never the file's text or path: a JSON parse error quotes the text around the fault,
// and the path carries the agent's real name (--redact-names).
function readSettings(path: string): Record<string, unknown> | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return null
    throw new SettingsReadError(`settings.json is not readable (${code ?? 'unknown error'})`)
  }
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    throw new SettingsReadError('settings.json is not valid JSON')
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SettingsReadError('settings.json is not a JSON object')
  return v as Record<string, unknown>
}

export function dryRun(opts: DryRunOptions): DryRunResult {
  const { root, nodeBin } = opts
  if (!root.startsWith('/')) throw new UsageError(`--root must be an absolute path: ${root}`)
  const mainAgentId = mainAgentIdOf(root)
  const all = listSubAgents(root, mainAgentId).sort()
  for (const n of opts.agents ?? []) {
    if (!isAgentName(n) || !all.includes(n)) throw new UsageError(`unknown agent: ${JSON.stringify(n)}`)
  }
  const names = opts.agents?.length ? [...opts.agents] : all
  const alias = new Map(all.map((n, i) => [n, `sub-${String(i + 1).padStart(2, '0')}`]))
  const show = (s: string) => s.replaceAll(nodeBin, '${NODE_BIN}').replaceAll(root, '${ROOT}')
  const tag = newTagger()
  // An error text from the agent's file is never printed (Ron N7: the non-list event's key); the manifest's own
  // errors carry only shipped text and the install's paths (shown as ${ROOT}, ${NODE_BIN}).
  const errorText = (err: unknown): string => (err instanceof SettingsReadError ? err.message
    : err instanceof HookShapeError ? `hooks.${eventName(err.event, tag)} is not a list; the generator leaves this file alone`
      : err instanceof Error && err.message.startsWith('hook manifest: ') ? show(err.message)
        : `unexpected error (${err instanceof Error ? err.name : typeof err})`)
  const extras = loadExtraHookEntries(join(root, 'store', 'extra-hooks.json'), {
    projectRoot: root,
    shippedScriptsDir: join(root, 'scripts'),
    nodeBin,
    nodeGateCommand: (p, t) => nodeGateCommand(nodeBin, p, [], t),
    pythonGateCommand: (p, t) => pythonGateCommand(p, [], t),
    isUnsafe: isUnsafeHookCommand,
  })
  const agents: AgentDryRun[] = []
  for (const name of names) {
    const shown = opts.redactNames ? alias.get(name)! : name
    const base: AgentDryRun = { name: shown, status: 'ok', before: 0, after: 0, added: [], dropped: [], kept: [], normalised: [], unsafe: [] }
    try {
      const settings = readSettings(join(root, 'agents', name, '.claude', 'settings.json'))
      if (settings === null) {
        agents.push({ ...base, status: 'no-settings' })
        continue
      }
      const flags = subHookFlags(root, name)
      const before = (typeof settings.hooks === 'object' && settings.hooks !== null ? settings.hooks : {}) as Record<string, unknown>
      const plan = generateSubHooks(before, {
        root, nodeBin, profile: flags.profile, agent: flags.agent, prompts: { precompact: SEED_PROMPT },
        isUnsafe: isUnsafeHookCommand, extras: extras.entries,
      })
      const after = plan.hooks as Record<string, unknown>
      const fb = flatten(before, tag)
      const fa = flatten(after, tag)
      const report: AgentDryRun = {
        ...base, profile: flags.profileId, before: fb.length, after: fa.length,
        added: minus(fa, fb), dropped: minus(fb, fa),
        kept: plan.kept.map((k) => flatten({ [k.event]: [{ matcher: k.matcher, hooks: [k.hook] }] }, tag)[0].label),
        normalised: normalised(before, after, tag), unsafe: plan.unsafe,
      }
      if (opts.diff) {
        // The `hooks` key only (Ron N2: the whole object put neighbouring keys' values into the context lines),
        // every value off the short list as a tag.
        const lines = (o: Record<string, unknown>): DiffLine[] => splitRaw(show(JSON.stringify(shownHooks(o, tag), null, 2))).map((raw) => ({ raw, tag: '' }))
        report.diff = unifiedDiff(lines(before), lines(after), { from: `${shown}/settings.json hooks`, to: `${shown}/settings.json hooks (generated)` })
      }
      agents.push(report)
    } catch (err) {
      agents.push({ ...base, status: 'error', error: errorText(err) })
    }
  }
  const compared = agents.filter((a) => a.status === 'ok')
  const drifted = compared.filter((a) => a.added.length > 0 || a.dropped.length > 0)
  const errors = agents.filter((a) => a.status === 'error').map((a) => a.name)
  const summary: DryRunSummary = {
    agents: agents.length, compared: compared.length, empty: compared.length - drifted.length, drift: drifted.length,
    noSettings: agents.filter((a) => a.status === 'no-settings').map((a) => a.name), errors,
  }
  return {
    root: opts.redactNames ? '${ROOT}' : root, nodeBin: opts.redactNames ? '${NODE_BIN}' : nodeBin,
    mainAgentId: opts.redactNames ? '${MAIN}' : mainAgentId, extrasErrors: extras.errors.map(extrasError), agents, summary,
    exit: drifted.length > 0 || errors.length > 0 ? 1 : 0,
  }
}

export function formatDryRun(r: DryRunResult): string {
  const lines = [`hook-settings dry-run (read-only), root ${r.root}, node ${r.nodeBin}, main agent ${r.mainAgentId}, ${r.agents.length} sub-agent(s)`]
  for (const e of r.extrasErrors) lines.push(`  extra-hooks file: ${e}`)
  for (const a of r.agents) {
    if (a.status !== 'ok') {
      lines.push(`${a.name}: ${a.status}${a.error ? ` (${a.error})` : ''}`)
      continue
    }
    const empty = a.added.length === 0 && a.dropped.length === 0
    lines.push(`${a.name}: profile ${a.profile}, hooks ${a.before} -> ${a.after}, multiset ${empty ? 'EMPTY' : `+${a.added.length} -${a.dropped.length}`}, `
      + (a.normalised.length ? `normalised: ${a.normalised.join('; ')}` : 'order unchanged'))
    for (const k of a.kept) lines.push(`  kept as is: ${k}`)
    for (const u of a.unsafe) lines.push(`  not rendered (registration guard): ${u}`)
    for (const x of a.added) lines.push(`  + ${x}`)
    for (const x of a.dropped) lines.push(`  - ${x}`)
    if (a.diff) lines.push(a.diff.trimEnd())
  }
  const s = r.summary
  lines.push(`summary: ${s.agents} agent(s), ${s.empty}/${s.compared} multiset EMPTY, `
    + `${s.noSettings.length} without settings, ${s.errors.length} error; exit ${r.exit}`)
  if (s.noSettings.length) lines.push(`  without settings: ${s.noSettings.join(', ')}`)
  if (s.errors.length) lines.push(`  error: ${s.errors.join(', ')}`)
  return `${lines.join('\n')}\n`
}

const USAGE = 'usage: hook-settings --dry-run --root <install> [--agent <name>]... [--node-bin <path>] [--json] [--diff] [--redact-names]'

export function runHookSettingsCli(argv: readonly string[], write: (s: string) => void, writeErr: (s: string) => void): number {
  let dry = false
  let root: string | undefined
  let nodeBin = resolveHookNodeBin(process.execPath)
  const agents: string[] = []
  const flags = { json: false, diff: false, redactNames: false }
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]
      const value = () => {
        const v = argv[++i]
        if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`)
        return v
      }
      if (a === '--dry-run') dry = true
      else if (a === '--root') root = value()
      else if (a === '--agent') agents.push(value())
      else if (a === '--node-bin') nodeBin = value()
      else if (a === '--json') flags.json = true
      else if (a === '--diff') flags.diff = true
      else if (a === '--redact-names') flags.redactNames = true
      else throw new UsageError(`unknown argument: ${JSON.stringify(a)}`)
    }
    if (!dry) throw new UsageError('--dry-run is mandatory (this command never writes)')
    if (!root) throw new UsageError('--root is required')
    const r = dryRun({ root, nodeBin, agents, diff: flags.diff, redactNames: flags.redactNames })
    write(flags.json ? `${JSON.stringify(r, null, 2)}\n` : formatDryRun(r))
    return r.exit
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    writeErr(`${err.message}\n${USAGE}\n`)
    return 2
  }
}
