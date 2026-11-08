// The sub-agent settings dry-run (C3-3a): per agent of an install tree, what the
// generator (sub-generator.ts) would write into its settings.json `hooks`, as a
// diff against the file on disk. Read only; the entry is hooks/cli.ts. The gate
// for C3-3b going live is the flattened multiset of the hooks (event, matcher,
// hook object): EMPTY for every agent; order and grouping may change (the first
// render normalises them, Johnny 13728).

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unifiedDiff, splitRaw, type DiffLine } from '../claude-md/line-diff.js'
import { isAgentName } from '../claude-md/agent-name.js'
import { loadExtraHookEntries } from '../extra-hook-entries.js'
import { nodeGateCommand, pythonGateCommand } from './manifest.js'
import { generateSubHooks, scriptBasename } from './sub-generator.js'
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

const hash8 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8)

/**
 * How the output names a hook command: the script file it runs, else `command #<sha256, 8 hex>`. Never the
 * command's text, in any mode: an operator's hook can carry a credential (Ron N1: a `curl -H 'Authorization:
 * Bearer ...'` hook), and this output is evidence that gets pasted into PRs and logs.
 */
function commandTag(command: string): string {
  return scriptBasename(command) ?? `command #${hash8(command)}`
}

/** The hooks block as --diff shows it: every field as it is, each command replaced by its tag plus a hash. */
function taggedHooks(hooks: unknown): unknown {
  if (typeof hooks !== 'object' || hooks === null) return hooks
  return Object.fromEntries(Object.entries(hooks).map(([event, groups]) => [event, !Array.isArray(groups) ? groups
    : (groups as Group[]).map((g) => (typeof g !== 'object' || g === null || !Array.isArray(g.hooks) ? g : {
      ...g,
      hooks: (g.hooks as Record<string, unknown>[]).map((h) => (typeof h?.command === 'string'
        ? { ...h, command: `${scriptBasename(h.command) ?? 'command'} #${hash8(h.command)}` } : h)),
    }))]))
}

/**
 * The multiset key is the event, the group's matcher and the WHOLE hook object: type, command, timeout and any
 * other field (async, statusMessage, ...). A change to any of them is a drift, so a changed field can never read
 * as EMPTY.
 */
function flatten(hooks: unknown): Flat[] {
  const out: Flat[] = []
  if (typeof hooks !== 'object' || hooks === null) return out
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    for (const g of groups as Group[]) {
      for (const h of Array.isArray(g?.hooks) ? (g.hooks as Record<string, unknown>[]) : []) {
        const o = { event, ...(g.matcher === undefined ? {} : { matcher: g.matcher }), ...h } as Record<string, unknown>
        const what = typeof h?.command === 'string' ? commandTag(h.command) : String(h?.type)
        out.push({ key: JSON.stringify(o, Object.keys(o).sort()), label: `${event} [${typeof g.matcher === 'string' ? g.matcher : '-'}] ${what} timeout=${h?.timeout ?? '-'}` })
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

function normalised(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const out: string[] = []
  if (Object.keys(before).join('\n') !== Object.keys(after).join('\n')) out.push('event order')
  const keys = (hooks: Record<string, unknown>, event: string) => flatten({ [event]: hooks[event] }).map((f) => f.key).join('\n')
  for (const event of Object.keys(after)) {
    const a = shape(before, event)
    const b = shape(after, event)
    if (a !== b) out.push(`${event} ${a} -> ${b}`)
    else if (keys(before, event) !== keys(after, event)) out.push(`${event} order`)
  }
  return out
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
    throw new Error(`settings.json is not readable (${code ?? 'unknown error'})`)
  }
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    throw new Error('settings.json is not valid JSON')
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('settings.json is not a JSON object')
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
      const fb = flatten(before)
      const fa = flatten(after)
      const report: AgentDryRun = {
        ...base, profile: flags.profileId, before: fb.length, after: fa.length,
        added: minus(fa, fb), dropped: minus(fb, fa),
        kept: plan.kept.map((k) => flatten({ [k.event]: [{ matcher: k.matcher, hooks: [k.hook] }] })[0].label),
        normalised: normalised(before, after), unsafe: plan.unsafe,
      }
      if (opts.diff) {
        // The `hooks` key only (Ron N2: the whole object put neighbouring keys' values into the context lines),
        // commands as tags.
        const lines = (o: unknown): DiffLine[] => splitRaw(show(JSON.stringify(taggedHooks(o), null, 2))).map((raw) => ({ raw, tag: '' }))
        report.diff = unifiedDiff(lines(before), lines(after), { from: `${shown}/settings.json hooks`, to: `${shown}/settings.json hooks (generated)` })
      }
      agents.push(report)
    } catch (err) {
      const msg = show((err as Error).message)
      agents.push({ ...base, status: 'error', error: opts.redactNames ? msg.replaceAll(name, shown) : msg })
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
    mainAgentId: opts.redactNames ? '${MAIN}' : mainAgentId, extrasErrors: extras.errors.map(show), agents, summary,
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
