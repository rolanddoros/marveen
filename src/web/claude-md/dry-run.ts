// C1 PR 8a: the read-only dry-run over an install's CLAUDE.md files.
//
// For each agent: is the file one the v2 composer accepts (and if not, which
// line refuses it), which legacy generated blocks it carries and how many
// characters they take, and what the owner zone holds that the region rollout
// will have to clean (owner-zone.ts). For every accepted file (PR 8b) also:
// the live AgentDocContext (live-context.ts, C1 PR 10a) with its assumptions,
// the v2 region it renders, what composeClaudeMd would write, and the unified
// diff between today's file and that.
//
// READ-ONLY by construction, because the main agent runs it against the live
// tree: this module and everything it imports use only reading fs calls
// (readFileSync, readdirSync, lstatSync, statSync, realpathSync) and no
// network, child process, temp file or cache. The install root is a
// parameter, never derived from this file's location: src/config.ts computes
// PROJECT_ROOT from the CODE's directory, so importing it (directly or through
// agent-config.ts, agent-scaffold.ts, logger.ts) would measure the checkout
// the CLI runs from, not the install it is pointed at. claude-md-dry-run-readonly.test.ts
// pins the import graph and runs the CLI under `node --permission` with read
// access only.

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { parseEnvContent } from '../../env-parse.js'
import { ComposeError, composeClaudeMd, scanClaudeMd, type ScannedLine } from './compose.js'
import { type DiffLine, splitRaw, unifiedDiff } from './line-diff.js'
import { LiveContextError, RENDERED_FIELDS, buildLiveContext } from './live-context.js'
import { ownerZoneFindings, retiredSectionFindings, type Finding } from './owner-zone.js'
import { renderRegion } from './registry.js'
import { TemplateError } from './render.js'

export type AgentRole = 'main' | 'sub' | 'heartbeat'
// 'error': the file was accepted, but its context or region could not be built.
export type FileStatus = 'ok' | 'refused' | 'missing' | 'unreadable' | 'error'

export interface BlockInfo {
  id: string
  line: number // the BEGIN line
  chars: number // markers and line endings included, in code points
}

export interface AgentReport {
  name: string
  role: AgentRole
  file: string // relative to the root
  status: FileStatus
  error?: { message: string; line?: number; byteOffset?: number }
  notes: string[] // 'bom', 'crlf'
  chars?: { file: number; generated: number }
  blocks: BlockInfo[]
  ownerZone: { segmented: boolean; findings: Finding[] }
  // PR 8b, for an accepted file:
  context?: {
    // every ctx field path without a real source (live-context.ts), sorted
    assumptions: string[]
    // the rendered ones among them, with the value the region was rendered with
    assumedRendered: Record<string, unknown>
  }
  after?: {
    file: number // code points
    region: number // code points
    regionLength: number // UTF-16 units, the unit of the budget test (claude-md-goldens.test.ts)
    overBudget: boolean
    removedBlocks: string[]
  }
  // The unified diff, today's file -> what composeClaudeMd would write
  // (PlanOptions decide how much owner text it shows).
  diff?: string
}

export interface PlanOptions {
  // The main agent's user-scope settings layer lives under it (live-context.ts).
  homeDir?: string
  // false (default): no owner text in the diff: no context lines, and a
  // changed non-blank owner line (the last line gaining its final newline)
  // is printed as a placeholder. true: 3 context lines, verbatim; NOT for a
  // PR description.
  fullDiff?: boolean
  // false (default): the owner chat_id is masked wherever the diff shows it.
  showChatId?: boolean
}

// The v2 region budget of design 2.3, as claude-md-goldens.test.ts measures it.
export const REGION_BUDGET = 5500

// src/config.ts defaults: MAIN_AGENT_ID ?? 'marveen'; HEARTBEAT_AGENT_ID is a constant.
export const DEFAULT_MAIN_AGENT_ID = 'marveen'
export const HEARTBEAT_AGENT_ID = 'heartbeat'
// agent-config.ts HIDDEN_AGENT_SENTINEL
export const HIDDEN_AGENT_SENTINEL = '.hidden-from-dashboard'
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/
// agent-scaffold.ts SKILL_SECTION_HEADING, the key of the retired-sections file.
export const SKILL_SECTION_HEADING = '## \u00d6ntanul\u00e1s \u00e9s Skill rendszer'

const codePoints = (s: string) => [...s].length

// The main agent's id from <root>/.env. Only this one key is kept: the file
// holds secrets, and nothing else of it is needed (8a).
export function readMainAgentId(root: string): string {
  let content: string
  try {
    content = readFileSync(join(root, '.env'), 'utf-8')
  } catch {
    return DEFAULT_MAIN_AGENT_ID
  }
  const v = parseEnvContent(content, ['MAIN_AGENT_ID']).MAIN_AGENT_ID
  return v === undefined ? DEFAULT_MAIN_AGENT_ID : v
}

// The sub-agents the dashboard lists (agent-config.ts listAgentNames): the
// directories of <root>/agents, not the main id, without the hidden sentinel.
// A symlink into agents/ itself is an alias, not an agent (ROSTERALIAS1026);
// a symlink to a directory outside agents/ is kept. Sorted.
export function listSubAgents(root: string, mainId: string): string[] {
  const base = join(root, 'agents')
  let entries: string[]
  try {
    entries = readdirSync(base)
  } catch {
    return []
  }
  let baseReal: string
  try {
    baseReal = realpathSync(base)
  } catch {
    baseReal = base
  }
  return entries
    .filter((f) => {
      if (f === mainId) return false
      const path = join(base, f)
      try {
        const st = lstatSync(path)
        if (st.isSymbolicLink()) {
          const target = realpathSync(path)
          if (target === baseReal || target.startsWith(baseReal + sep)) return false
          if (!statSync(path).isDirectory()) return false
        } else if (!st.isDirectory()) {
          return false
        }
        lstatSync(join(path, HIDDEN_AGENT_SENTINEL))
        return false // the sentinel exists
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' && existsDir(path)
      }
    })
    .sort()
}

function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// The first byte offset where `buf` stops being well-formed UTF-8 (the WHATWG
// decoder's byte ranges), or -1.
export function firstInvalidUtf8(buf: Uint8Array): number {
  let i = 0
  while (i < buf.length) {
    const b = buf[i]
    if (b < 0x80) {
      i++
      continue
    }
    let need: number
    let lo = 0x80
    let hi = 0xbf
    if (b >= 0xc2 && b <= 0xdf) need = 1
    else if (b === 0xe0) { need = 2; lo = 0xa0 }
    else if (b >= 0xe1 && b <= 0xec) need = 2
    else if (b === 0xed) { need = 2; hi = 0x9f }
    else if (b >= 0xee && b <= 0xef) need = 2
    else if (b === 0xf0) { need = 3; lo = 0x90 }
    else if (b >= 0xf1 && b <= 0xf3) need = 3
    else if (b === 0xf4) { need = 3; hi = 0x8f }
    else return i
    for (let k = 1; k <= need; k++) {
      const c = buf[i + k]
      if (c === undefined) return i
      const [l, h] = k === 1 ? [lo, hi] : [0x80, 0xbf]
      if (c < l || c > h) return i
    }
    i += need + 1
  }
  return -1
}

// The retired stock skill sections of <root>/templates/retired-claude-md-sections.json
// (the file the live writer reads); [] when it is missing or unreadable.
export function readRetiredSections(root: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'templates', 'retired-claude-md-sections.json'), 'utf-8')) as Record<string, unknown>
    const list = parsed[SKILL_SECTION_HEADING]
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

// One file's report from its bytes (null: the file does not exist).
export function evaluateFile(
  name: string,
  role: AgentRole,
  file: string,
  bytes: Uint8Array | null,
  root: string,
  retired: readonly string[] = [],
): AgentReport {
  const base: AgentReport = { name, role, file, status: 'ok', notes: [], blocks: [], ownerZone: { segmented: false, findings: [] } }
  if (bytes === null) return { ...base, status: 'missing' }
  const bad = firstInvalidUtf8(bytes)
  if (bad >= 0) {
    let line = 1
    for (let i = 0; i < bad; i++) if (bytes[i] === 0x0a) line++
    return { ...base, status: 'refused', error: { message: 'not valid UTF-8', line, byteOffset: bad } }
  }
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  const notes: string[] = []
  if (text.startsWith('\ufeff')) notes.push('bom')
  if (text.includes('\r\n')) notes.push('crlf')

  let lines: ScannedLine[]
  try {
    lines = scanClaudeMd(text).lines
  } catch (err) {
    if (!(err instanceof ComposeError)) throw err
    // Not segmented: the detectors run on every line, so nothing is hidden.
    const all = text.replace(/^\ufeff/, '').match(/[^\n]*\n|[^\n]+$/g) ?? []
    const every: ScannedLine[] = all.map((raw, i) => ({ n: i + 1, raw, content: raw.replace(/\r?\n$/, ''), kind: 'owner' }))
    return {
      ...base,
      status: 'refused',
      error: { message: err.message, line: err.line },
      notes,
      chars: { file: codePoints(text), generated: 0 },
      ownerZone: { segmented: false, findings: sortFindings([...ownerZoneFindings(every, root), ...retiredSectionFindings(every, retired)]) },
    }
  }

  const blocks: BlockInfo[] = []
  let generated = 0
  for (const l of lines) {
    if (l.kind === 'owner') continue
    const cp = codePoints(l.raw)
    generated += cp
    if (l.kind === 'begin') blocks.push({ id: l.block as string, line: l.n, chars: cp })
    else blocks[blocks.length - 1].chars += cp
  }
  const owner = lines.filter((l) => l.kind === 'owner')
  return {
    ...base,
    notes,
    chars: { file: codePoints(text), generated },
    blocks,
    ownerZone: { segmented: true, findings: sortFindings([...ownerZoneFindings(owner, root), ...retiredSectionFindings(owner, retired)]) },
  }
}

function sortFindings(f: Finding[]): Finding[] {
  const order = { 'curl-recipe': 0, 'dashboard-token': 1, 'sniff-literal': 2, 'stale-path': 3 } as const
  return f.sort((a, b) => a.line - b.line || order[a.detector] - order[b.detector] || a.pattern.localeCompare(b.pattern))
}

function readOrNull(path: string): Uint8Array | null | Error {
  try {
    return readFileSync(path)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : (err as Error)
  }
}

export interface DryRunResult {
  root: string
  mainAgentId: string
  agents: AgentReport[]
  // Every listed agent (main first, then the subs in name order), also when
  // one agent was asked for: --redact-names numbers agents by this list.
  listed: string[]
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

// The dry run over `root`: every listed agent (main first, then the subs in
// name order), or the one named. Throws UsageError for an unknown agent.
function valueAt(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj)
}

// The region part of the report: context, region, composed file, diff lines.
// Old lines are tagged with the scan (owner / generated), new lines as owner
// text up to the region and as region after it, so the diff never pairs an
// owner line with a generated one (line-diff.ts).
export function planRegion(report: AgentReport, text: string, root: string, opts: PlanOptions = {}): AgentReport {
  let live
  let region: string
  let composed
  try {
    live = buildLiveContext(root, report.name, opts.homeDir === undefined ? {} : { homeDir: opts.homeDir })
    region = renderRegion(live.ctx)
    composed = composeClaudeMd(text, region)
  } catch (err) {
    if (err instanceof LiveContextError || err instanceof TemplateError || err instanceof ComposeError) {
      return { ...report, status: 'error', error: { message: `${err.name}: ${err.message}` } }
    }
    throw err
  }
  const rendered = new Set<string>(RENDERED_FIELDS)
  const assumedRendered: Record<string, unknown> = {}
  for (const f of live.assumptions) if (rendered.has(f)) assumedRendered[f] = valueAt(live.ctx, f)

  const bom = text.startsWith('\ufeff') ? '\ufeff' : ''
  const scanned = scanClaudeMd(text).lines
  const oldLines: DiffLine[] = scanned.map((l) => ({ raw: l.raw, tag: l.kind === 'owner' ? 'owner' : 'generated' }))
  const newRaw = splitRaw(composed.text.slice(bom.length))
  const regionCount = splitRaw(region).length
  const newLines: DiffLine[] = newRaw.map((raw, i) => ({ raw, tag: i >= newRaw.length - regionCount ? 'region' : 'owner' }))
  // A BOM is file-level (compose keeps it); it rides on line 1 of both sides.
  if (bom && oldLines.length > 0) oldLines[0] = { ...oldLines[0], raw: bom + oldLines[0].raw }
  if (bom && newLines.length > 0) newLines[0] = { ...newLines[0], raw: bom + newLines[0].raw }

  const chatId = live.ctx.owner.chatId
  const mask = (line: string) => (chatId && !opts.showChatId ? line.split(chatId).join('<chat_id masked>') : line)
  const diff = unifiedDiff(oldLines, newLines, {
    from: report.file,
    to: report.file,
    context: opts.fullDiff ? 3 : 0,
    show: (_side, line, index) => {
      const content = line.raw.replace(/\n$/, '')
      if (!opts.fullDiff && line.tag === 'owner' && content.trim() !== '') return `<owner line ${index + 1}, text not shown>`
      return mask(content)
    },
  })

  return {
    ...report,
    context: { assumptions: live.assumptions, assumedRendered },
    after: {
      file: codePoints(composed.text),
      region: codePoints(region),
      regionLength: region.length,
      overBudget: region.length > REGION_BUDGET,
      removedBlocks: composed.removed,
    },
    diff,
  }
}

export function dryRun(root: string, agent?: string, opts: PlanOptions = {}): DryRunResult {
  const mainId = readMainAgentId(root)
  const subs = listSubAgents(root, mainId)
  const roleOf = (n: string): AgentRole => (n === mainId ? 'main' : n === HEARTBEAT_AGENT_ID ? 'heartbeat' : 'sub')
  const listed = [mainId, ...subs]
  let names = listed
  if (agent !== undefined) {
    if (!AGENT_NAME_RE.test(agent) || !names.includes(agent)) throw new UsageError(`unknown agent: ${JSON.stringify(agent)}`)
    names = [agent]
  }
  const retired = readRetiredSections(root)
  const agents = names.map((n) => {
    const file = n === mainId ? 'CLAUDE.md' : `agents/${n}/CLAUDE.md`
    const got = readOrNull(join(root, file))
    if (got instanceof Error) {
      return {
        name: n, role: roleOf(n), file, status: 'unreadable' as const, error: { message: got.message.split('\n')[0] },
        notes: [], blocks: [], ownerZone: { segmented: false, findings: [] },
      }
    }
    const report = evaluateFile(n, roleOf(n), file, got, root, retired)
    if (report.status !== 'ok' || got === null) return report
    return planRegion(report, new TextDecoder('utf-8', { ignoreBOM: true }).decode(got), root, opts)
  })
  return { root, mainAgentId: mainId, agents, listed }
}
