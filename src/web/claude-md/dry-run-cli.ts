// C1 PR 8: the dry-run CLI as functions (arguments, report text, JSON, exit
// code). The entry module is cli.ts, which only calls runCli; the usage, the
// exit codes and what the output may carry are documented there.

import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REGION_BUDGET, dryRun, UsageError, type AgentReport, type DryRunResult } from './dry-run.js'
import { TEMPLATES_DIR } from './render.js'
import { maskedExcerpt } from './owner-zone.js'

export const USAGE = 'usage: cli.js --dry-run --root <dir> (--agent <name> | --all) [--json] [--excerpts] [--redact-names]'
  + ' [--full-diff] [--show-chat-id] [--home <dir>]'

interface Options {
  root: string
  agent?: string
  json: boolean
  excerpts: boolean
  redactNames: boolean
  fullDiff: boolean
  showChatId: boolean
  home?: string
}

export function parseArgs(argv: readonly string[]): Options {
  let dry = false
  let all = false
  let root: string | undefined
  let agent: string | undefined
  let json = false
  let excerpts = false
  let redactNames = false
  let fullDiff = false
  let showChatId = false
  let home: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`)
      return v
    }
    if (a === '--dry-run') dry = true
    else if (a === '--all') all = true
    else if (a === '--json') json = true
    else if (a === '--excerpts') excerpts = true
    else if (a === '--redact-names') redactNames = true
    else if (a === '--full-diff') fullDiff = true
    else if (a === '--show-chat-id') showChatId = true
    else if (a === '--home') home = value()
    else if (a === '--root') root = value()
    else if (a === '--agent') agent = value()
    else throw new UsageError(`unknown argument: ${JSON.stringify(a)}`)
  }
  if (!dry) throw new UsageError('--dry-run is required (it is the only mode)')
  if (root === undefined) throw new UsageError('--root is required')
  if (all === (agent !== undefined)) throw new UsageError('give exactly one of --agent <name> and --all')
  const abs = isAbsolute(root) ? root : resolve(root)
  let isDir = false
  try {
    isDir = statSync(abs).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) throw new UsageError(`--root is not a directory: ${abs}`)
  if (home !== undefined && !isAbsolute(home)) throw new UsageError(`--home must be an absolute path: ${home}`)
  return { root: abs.replace(/(.)\/+$/, '$1'), agent, json, excerpts, redactNames, fullDiff, showChatId, home }
}

// Why a rendered value is only an assumption (live-context.ts).
const NOTES: Readonly<Record<string, string>> = {
  'profile.helperAllowed': 'simplified deny-rule reading; the dashboard passes agentUsesApiHelper',
  'profile.strict': 'a settings layer above the deciding one does not parse',
}

export function exitCodeOf(result: DryRunResult): 0 | 1 {
  return result.agents.some((a) => a.status === 'refused' || a.status === 'unreadable' || a.status === 'error') ? 1 : 0
}

// The commit the running code was built from: dist/.built-commit (written by
// scripts/write-built-commit.cjs and the install scripts: 40 hex and a
// newline), next to this module's dist/web/claude-md/. "unknown" without one,
// or when it does not read as a sha (Ron S3, 13027).
export function codeVersion(stamp = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.built-commit')): string {
  try {
    const s = readFileSync(stamp, 'utf-8').trim()
    return /^[0-9a-f]{40}$/.test(s) ? s : 'unknown'
  } catch {
    return 'unknown'
  }
}

// --redact-names: the root becomes <ROOT>, every listed agent agent-01..NN in
// the listing order (main agent first, then the sub-agents in name order), the
// same number on every run of the same install, whichever agent is asked for.
// Applied to the report's own fields and to every free text it prints (error
// messages, excerpts, the region diff and the assumed values), where an agent
// name counts only as a whole word. The home and the checkout become <HOME>
// and <CHECKOUT> (Ron 13122). The configured OWNER_NAME and BOT_NAME
// (DryRunResult.identity) become <OWNER> and <BOT> at every occurrence, also
// inside a word (a Hungarian suffix is glued on: "Rolandnak") (Kevin 13039).
// Names match in any letter case ("Dennis" in owner text is the agent dennis;
// Ron, 8a review 13073); the paths match exactly.
export interface Redactor {
  name(n: string): string
  text(s: string): string
}

const IDENTITY: Redactor = { name: (n) => n, text: (s) => s }

// The paths outside the root that a report can print (an error message):
// the home whose settings layer was read, and the checkout the code runs from
// (render.ts finds its templates there).
export function outsidePaths(result: DryRunResult): [string, string][] {
  return [[result.homeDir, '<HOME>'], [dirname(dirname(TEMPLATES_DIR)), '<CHECKOUT>']]
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function makeRedactor(result: DryRunResult, outside: readonly [string, string][] = []): Redactor {
  const width = Math.max(2, String(result.listed.length).length)
  const map = new Map(result.listed.map((n, i) => [n, `agent-${String(i + 1).padStart(width, '0')}`]))

  // Paths first, case-sensitive, the longest first (the home is often a
  // prefix of the root), each only where a path name ends; on a tie (the
  // checkout is the install) the root wins.
  const pathTag = new Map<string, string>()
  for (const [p, tag] of [[result.root, '<ROOT>'] as [string, string], ...outside]) {
    if (p.length > 1 && !pathTag.has(p)) pathTag.set(p, tag)
  }
  const paths = [...pathTag.keys()].sort((x, y) => y.length - x.length)
  const pathRe = paths.length > 0 ? new RegExp(paths.map((p) => `${escapeRe(p)}(?![A-Za-z0-9_-])`).join('|'), 'g') : null

  // Then every name in ONE alternation, the longest first, so a person's name
  // that contains an agent name ("Roland Kevin Doros" and the agent kevin) is
  // replaced whole before the agent name could split it (Ron, 8b review
  // 13122). An agent name counts only as a whole word; a person's name at
  // every occurrence. A placeholder already written is skipped.
  const tags = new Map<string, string>()
  for (const [n, tag] of map) tags.set(n.toLowerCase(), tag)
  const people: [string, string][] = []
  if (result.identity.owner) people.push([result.identity.owner, '<OWNER>'])
  if (result.identity.bot) people.push([result.identity.bot, '<BOT>'])
  for (const [v, tag] of people) tags.set(v.toLowerCase(), tag)
  const alts = [
    ...[...map.keys()].filter((n) => n.length > 0).map((n) => ({ s: n, word: true })),
    ...people.map(([v]) => ({ s: v, word: false })),
  ].sort((x, y) => y.s.length - x.s.length)
  const nameRe = alts.length > 0
    ? new RegExp(`<(?:ROOT|HOME|CHECKOUT)>|${alts.map((x) => (x.word ? `(?<![A-Za-z0-9_-])${escapeRe(x.s)}(?![A-Za-z0-9_-])` : escapeRe(x.s))).join('|')}`, 'gi')
    : null

  return {
    name: (n) => map.get(n) ?? n,
    text: (s) => {
      const pathed = pathRe ? s.replace(pathRe, (m) => pathTag.get(m) ?? m) : s
      return nameRe ? pathed.replace(nameRe, (w) => tags.get(w.toLowerCase()) ?? w) : pathed
    },
  }
}

interface FormatOptions {
  excerpts?: boolean
  fullDiff?: boolean
  redactNames?: boolean
  code?: string
}

// The raw owner line; the caller redacts it first and masks it after, so a
// mask can never break a root or a name apart before the redaction sees it.
function rawLine(root: string, a: AgentReport, line: number): string {
  try {
    const text = readFileSync(resolve(root, a.file), 'utf-8').replace(/^\ufeff/, '')
    return text.split('\n')[line - 1] ?? ''
  } catch {
    return ''
  }
}

// An assumed value can be any JSON (a string, a list of names): redacted as
// its JSON text. The placeholders carry no JSON-special character.
function redactValues(r: Redactor, values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === undefined ? v : JSON.parse(r.text(JSON.stringify(v)))]))
}

// The report as printed: names redacted when asked, excerpts attached when asked.
function view(result: DryRunResult, opts: FormatOptions) {
  const r = opts.redactNames ? makeRedactor(result, outsidePaths(result)) : IDENTITY
  return {
    root: opts.redactNames ? '<ROOT>' : result.root,
    mainAgentId: r.name(result.mainAgentId),
    code: opts.code ?? codeVersion(),
    agents: result.agents.map((a) => ({
      ...a,
      name: r.name(a.name),
      file: r.text(a.file),
      ...(a.error ? { error: { ...a.error, message: r.text(a.error.message) } } : {}),
      ownerZone: {
        ...a.ownerZone,
        findings: a.ownerZone.findings.map((x) => (opts.excerpts ? { ...x, excerpt: maskedExcerpt(r.text(rawLine(result.root, a, x.line))) } : x)),
      },
      ...(a.context ? {
        context: {
          ...a.context,
          assumedRendered: redactValues(r, a.context.assumedRendered),
          hooksNotWired: a.context.hooksNotWired.map((h) => ({ ...h, path: h.path === null ? null : r.text(h.path) })),
        },
      } : {}),
      ...(a.diff !== undefined ? { diff: r.text(a.diff) } : {}),
    })),
  }
}

export function formatText(result: DryRunResult, opts: FormatOptions = {}): string {
  const v = view(result, opts)
  const out: string[] = [`claude-md dry-run (read-only), root ${v.root}, main agent ${v.mainAgentId}, code ${v.code}`]
  if (opts.excerpts) out.push('EXCERPTS ON: owner-zone text below, masked; not for a PR description')
  if (opts.fullDiff) out.push('FULL DIFF ON: owner text below, verbatim; not for a PR description')
  if (opts.redactNames) out.push('names redacted: root <ROOT>, agents agent-NN (main agent first, then the sub-agents in name order), owner <OWNER>, bot <BOT>, '
    + 'home <HOME>, checkout <CHECKOUT>')
  for (const a of v.agents) {
    out.push('')
    out.push(`${a.name} (${a.role}) ${a.file}: ${a.status}`)
    if (a.error) {
      const at = a.error.line !== undefined ? `:${a.error.line}` : ''
      const msg = a.error.message.replace(/^line \d+: /, '')
      const byte = a.error.byteOffset !== undefined ? ` (byte ${a.error.byteOffset})` : ''
      out.push(`  ${a.status}: ${a.file}${at}: ${msg}${byte}`)
    }
    if (a.notes.length > 0) out.push(`  notes: ${a.notes.join(', ')}`)
    if (a.chars) {
      out.push(`  chars: file ${a.chars.file}, generated ${a.chars.generated} (${a.blocks.length} block(s))`)
    }
    for (const b of a.blocks) out.push(`  block ${b.id} at line ${b.line}: ${b.chars} chars`)
    if (a.status === 'missing') continue
    const f = a.ownerZone.findings
    out.push(`  owner zone${a.ownerZone.segmented ? '' : ' (not segmented: every line scanned)'}: ${f.length} finding(s)`)
    for (const x of f) {
      const flags = x.flags.length > 0 ? ` [${x.flags.join(', ')}]` : ''
      out.push(`    ${a.file}:${x.line} ${x.detector} ${x.pattern}${flags}`)
      if ('excerpt' in x) out.push(`      | ${x.excerpt}`)
    }
    if (a.context) {
      const ctx = a.context
      const rendered = Object.entries(ctx.assumedRendered).map(([k, v]) => `${k}=${JSON.stringify(v)}${NOTES[k] ? ` (${NOTES[k]})` : ''}`)
      const other = ctx.assumptions.filter((f) => !(f in ctx.assumedRendered))
      out.push(`  assumed, rendered: ${rendered.length > 0 ? rendered.join('; ') : 'none'}`)
      out.push(`  assumed, not rendered: ${other.length > 0 ? other.join(', ') : 'none'}`)
      // Ron 13122 J1: a hook that reads false although it may be wired is named, never silent.
      const notWired = ctx.hooksNotWired.map((h) => `${h.id}${h.path === null ? '' : ` ${h.path}`} (${h.reason})`)
      out.push(`  hooks not wired: ${notWired.length > 0 ? notWired.join('; ') : 'none'}`)
    }
    if (a.after) {
      out.push(`  after: file ${a.after.file}, region ${a.after.region} chars (${a.after.regionLength} of the ${REGION_BUDGET} budget`
        + `${a.after.overBudget ? ', OVER BUDGET' : ''}); ${a.after.removedBlocks.length > 0
          ? `${a.after.removedBlocks.length} block(s) removed (${a.after.removedBlocks.join(', ')}), content not compared to the old template`
          : 'no block removed'}`)
    }
    if (a.diff !== undefined) {
      out.push('  diff (3 context lines, owner text verbatim, each removed generated block as one placeholder line):')
      out.push(a.diff.replace(/\n$/, '') || '  (no change)')
    }
  }
  const count = (s: string) => result.agents.filter((a) => a.status === s).length
  out.push('')
  out.push(`summary: ${result.agents.length} agent(s): ${count('ok')} ok, ${count('refused')} refused, `
    + `${count('unreadable')} unreadable, ${count('error')} error, ${count('missing')} missing; exit ${exitCodeOf(result)}`)
  return `${out.join('\n')}\n`
}

export function formatJson(result: DryRunResult, opts: FormatOptions = {}): string {
  const v = view(result, opts)
  return `${JSON.stringify({
    root: v.root, mainAgentId: v.mainAgentId, code: v.code, excerpts: opts.excerpts === true, fullDiff: opts.fullDiff === true,
    redactNames: opts.redactNames === true, agents: v.agents, exit: exitCodeOf(result),
  }, null, 2)}\n`
}

// The whole CLI as a function: argv in, text out through `write`, exit code back.
export function runCli(argv: readonly string[], write: (s: string) => void, writeErr: (s: string) => void): number {
  let opts: Options
  try {
    opts = parseArgs(argv)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    writeErr(`${err.message}\n${USAGE}\n`)
    return 2
  }
  let result: DryRunResult
  try {
    result = dryRun(opts.root, opts.agent, { homeDir: opts.home, fullDiff: opts.fullDiff, showChatId: opts.showChatId })
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    writeErr(`${err.message}\n${USAGE}\n`)
    return 2
  }
  const fmt = { excerpts: opts.excerpts, fullDiff: opts.fullDiff, redactNames: opts.redactNames }
  write(opts.json ? formatJson(result, fmt) : formatText(result, fmt))
  return exitCodeOf(result)
}
