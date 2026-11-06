// C1 PR 8: `node dist/web/claude-md/cli.js --dry-run --root <dir> (--agent <name> | --all)
//   [--json] [--excerpts] [--show-chat-id] [--home <dir>]`
//
// Read-only report over an install's CLAUDE.md files (dry-run.ts). The main
// agent runs it against the live tree and pastes the output into a PR
// description, so the DEFAULT output carries no owner-zone text: a finding is
// file:line, detector and pattern name, and the region diff (PR 8b) has no
// context lines and shows a changed owner line only as a placeholder. The
// owner chat_id is masked unless --show-chat-id. `--excerpts` adds a masked
// excerpt of each finding's line and a diff with 3 verbatim context lines;
// that output is NOT for a PR description (the owner zones belong to the
// agents' principals). `--home` names the directory whose .claude/settings.json
// is the main agent's user-scope settings layer (default: os.homedir()).
//
// --dry-run is mandatory: there is no other mode (the writing path is PR 10).
//
// On a live tree, run it under Node's permission model with read access only,
// so the kernel-side check does not depend on this code being right:
//   node --permission --allow-fs-read=<checkout>/dist --allow-fs-read=<checkout>/templates \
//     --allow-fs-read=<root> --allow-fs-read=<home>/.claude/settings.json \
//     <checkout>/dist/web/claude-md/cli.js --dry-run --root <root> --home <home> --all
// (templates: the region text; the settings file: the main agent's user layer.)
// A hook script outside the allowed paths reads as not wired (fail-closed: a
// longer region, never a dropped rule). claude-md-dry-run-readonly.test.ts runs
// this shape on a fixture tree.
//
// Exit codes:
//   0  every requested agent was evaluated (owner-zone findings are information);
//   1  at least one file was refused (the v2 composer would not accept it:
//      marker or fence problem, not UTF-8), could not be read, or its context
//      or region could not be built (status "error"); the report still covers
//      every other agent;
//   2  usage error (arguments, --root, unknown agent).

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REGION_BUDGET, dryRun, UsageError, type AgentReport, type DryRunResult } from './dry-run.js'
import { maskedExcerpt } from './owner-zone.js'

export const USAGE = 'usage: cli.js --dry-run --root <dir> (--agent <name> | --all) [--json] [--excerpts] [--show-chat-id] [--home <dir>]'

interface Options {
  root: string
  agent?: string
  json: boolean
  excerpts: boolean
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
  return { root: abs.replace(/(.)\/+$/, '$1'), agent, json, excerpts, showChatId, home }
}

// Why a rendered value is only an assumption (live-context.ts).
const NOTES: Readonly<Record<string, string>> = {
  'profile.helperAllowed': 'simplified deny-rule reading; the dashboard passes agentUsesApiHelper',
  'profile.strict': 'a settings layer above the deciding one does not parse',
}

export function exitCodeOf(result: DryRunResult): 0 | 1 {
  return result.agents.some((a) => a.status === 'refused' || a.status === 'unreadable' || a.status === 'error') ? 1 : 0
}

function excerptOf(root: string, a: AgentReport, line: number): string {
  try {
    const text = readFileSync(resolve(root, a.file), 'utf-8').replace(/^\ufeff/, '')
    return maskedExcerpt(text.split('\n')[line - 1] ?? '')
  } catch {
    return ''
  }
}

export function formatText(result: DryRunResult, excerpts = false): string {
  const out: string[] = [`claude-md dry-run (read-only), root ${result.root}, main agent ${result.mainAgentId}`]
  if (excerpts) out.push('EXCERPTS ON: owner-zone text below (findings masked, diff context verbatim); not for a PR description')
  for (const a of result.agents) {
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
      if (excerpts) out.push(`      | ${excerptOf(result.root, a, x.line)}`)
    }
    if (a.context) {
      const rendered = Object.entries(a.context.assumedRendered).map(([k, v]) => `${k}=${JSON.stringify(v)}${NOTES[k] ? ` (${NOTES[k]})` : ''}`)
      const other = a.context.assumptions.filter((f) => !(f in a.context!.assumedRendered))
      out.push(`  assumed, rendered: ${rendered.length > 0 ? rendered.join('; ') : 'none'}`)
      out.push(`  assumed, not rendered: ${other.length > 0 ? other.join(', ') : 'none'}`)
    }
    if (a.after) {
      out.push(`  after: file ${a.after.file}, region ${a.after.region} chars (${a.after.regionLength} of the ${REGION_BUDGET} budget`
        + `${a.after.overBudget ? ', OVER BUDGET' : ''}); removes ${a.after.removedBlocks.length > 0 ? a.after.removedBlocks.join(', ') : 'nothing'}`)
    }
    if (a.diff !== undefined) {
      out.push(excerpts ? '  diff (3 context lines, verbatim):' : '  diff (no owner text: no context lines, a changed owner line as a placeholder):')
      out.push(a.diff.replace(/\n$/, '') || '  (no change)')
    }
  }
  const count = (s: string) => result.agents.filter((a) => a.status === s).length
  out.push('')
  out.push(`summary: ${result.agents.length} agent(s): ${count('ok')} ok, ${count('refused')} refused, `
    + `${count('unreadable')} unreadable, ${count('error')} error, ${count('missing')} missing; exit ${exitCodeOf(result)}`)
  return `${out.join('\n')}\n`
}

export function formatJson(result: DryRunResult, excerpts = false): string {
  const agents = result.agents.map((a) => (excerpts
    ? { ...a, ownerZone: { ...a.ownerZone, findings: a.ownerZone.findings.map((x) => ({ ...x, excerpt: excerptOf(result.root, a, x.line) })) } }
    : a))
  return `${JSON.stringify({ root: result.root, mainAgentId: result.mainAgentId, excerpts, agents, exit: exitCodeOf(result) }, null, 2)}\n`
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
    result = dryRun(opts.root, opts.agent, { homeDir: opts.home, fullDiff: opts.excerpts, showChatId: opts.showChatId })
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    writeErr(`${err.message}\n${USAGE}\n`)
    return 2
  }
  write(opts.json ? formatJson(result, opts.excerpts) : formatText(result, opts.excerpts))
  return exitCodeOf(result)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2), (s) => process.stdout.write(s), (s) => process.stderr.write(s))
}
