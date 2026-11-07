// C1: put the v2 region into a CLAUDE.md text. Pure: file text in, file text
// out. No read, no write, no backup; PR 10 wires it behind the per-agent flag.
//
// What it does:
// - Removes every legacy generated block it is given (legacy-markers.ts) and
//   any existing v2 region, wherever they are, and appends the new region at
//   EOF. A file whose output is byte-equal to its input reports changed=false,
//   so the caller can skip the write.
// - Keeps the owner zone (every line outside those blocks) byte for byte,
//   with two stated exceptions:
//     1. After a removed block, one blank line is dropped when the line before
//        the block is blank too (or the block opens the file): that is the
//        separator the legacy writers inserted, and without this rule every
//        removal would leave a pile of empty lines behind. "Blank" means empty
//        or whitespace-only, so a whitespace-only line can be the one dropped.
//     2. Before the region: a missing final line break is added, and one blank
//        separator line when the owner zone does not already end with one.
//   Both additions use LF. Everything else (CRLF line endings, Hungarian
//   text, trailing spaces) stays as it was.
// - A leading BOM (U+FEFF) is file-level: it is set aside before the scan, so
//   a marker on the first line is still recognised, and put back at the start
//   of the output, even when everything after it was generated.
// - The region itself always uses LF (render.ts wrapRegion).
//
// Markers are recognised only as whole lines (exact match; a trailing CR of a
// CRLF line is ignored) and only OUTSIDE a fenced code block. Fences follow
// CommonMark: an opener is up to three spaces, then three or more backticks or
// tildes (a backtick opener's info string may not contain a backtick); a fence
// closes only with the same character, at least as long as the opener, and
// nothing but spaces or tabs after it; an unclosed fence runs to EOF, so no
// marker after it is recognised. Container blocks (lists, blockquotes) are not
// modelled: a marker line is column-0 by definition, and a column-0 line
// closes a list item or a blockquote's code fence anyway.
// Inside a generated block fences are NOT tracked: the block is our own
// output and ends at its first END line, as the legacy writers' non-greedy
// regex does.
//
// Errors (ComposeError, no output): a BEGIN without its END; an END without a
// BEGIN; a BEGIN (any known pair or v2) inside an open block; an END of
// another pair inside an open block; two v2 regions; a malformed region; a
// code fence still open at EOF (the region would be appended inside it, and
// the next run would not recognise it and append one more, every run).

import { REGION_BEGIN, REGION_END, checkBody } from './render.js'
import { LEGACY_MARKERS, type MarkerPair } from './legacy-markers.js'

export class ComposeError extends Error {
  // The 1-based line the error is about, when there is one: the offending
  // marker line, or for an unclosed fence the line that opened it (the
  // dry-run report names it; C1 PR 8). Counted after a leading BOM is set
  // aside, which does not change line numbers.
  readonly line: number | undefined

  constructor(message: string, line?: number) {
    super(message)
    this.name = 'ComposeError'
    this.line = line
  }
}

export interface ComposeResult {
  text: string
  changed: boolean
  // ids of the removed blocks in file order; 'v2' for a previous region.
  removed: string[]
}

const V2_PAIR: MarkerPair = { id: 'v2', begin: REGION_BEGIN, end: REGION_END }
const BOM = String.fromCharCode(0xfeff)

interface Line {
  raw: string // with its own line ending, if any
  content: string // without the ending (LF or CRLF)
}

function splitLines(text: string): Line[] {
  const lines: Line[] = []
  for (const m of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const raw = m[0]
    lines.push({ raw, content: raw.replace(/\r?\n$/, '') })
  }
  return lines
}

interface Fence {
  ch: string
  len: number
}

function fenceOpener(content: string): Fence | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content)
  if (!m) return null
  if (m[1][0] === '`' && m[2].includes('`')) return null
  return { ch: m[1][0], len: m[1].length }
}

function closesFence(content: string, fence: Fence): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(content)
  return m !== null && m[1][0] === fence.ch && m[1].length >= fence.len
}

function isBlank(content: string): boolean {
  return /^[ \t]*$/.test(content)
}

// The region must be exactly what wrapRegion produces: BEGIN line, body, END
// line, LF endings, one final LF, and no marker line of any kind in the body.
export function checkRegion(region: string, markers: readonly MarkerPair[] = LEGACY_MARKERS): void {
  if (region.includes('\r')) throw new ComposeError('region: CR found, the region uses LF only')
  if (!region.startsWith(`${REGION_BEGIN}\n`) || !region.endsWith(`\n${REGION_END}\n`)) {
    throw new ComposeError('region: must start with the v2 BEGIN line and end with the v2 END line and one LF')
  }
  const inner = region.slice(REGION_BEGIN.length + 1, region.length - REGION_END.length - 1)
  const all = [V2_PAIR, ...markers]
  for (const line of inner.split('\n')) {
    if (all.some((p) => line === p.begin || line === p.end)) {
      throw new ComposeError('region: a marker line inside the region body')
    }
  }
  checkBody(inner.replace(/\n$/, ''))
}

// One line of a scanned CLAUDE.md, classified the way composeClaudeMd sees it.
// 'owner': outside every generated block (inside or outside a code fence);
// 'begin' / 'inner' / 'end': a generated block's BEGIN line, body and END line,
// with the block's id ('v2' for a previous region).
export interface ScannedLine {
  n: number // 1-based
  raw: string // with its own line ending, if any
  content: string // without the ending (LF or CRLF)
  kind: 'owner' | 'begin' | 'inner' | 'end'
  block?: string
  inFence?: boolean // owner lines only: inside (or opening/closing) a code fence
}

export interface ScanResult {
  bom: boolean
  lines: ScannedLine[]
}

// The marker and fence scan that composeClaudeMd runs, as a separate pure
// function, so a read-only caller (the dry-run report, C1 PR 8) sees exactly
// the same boundary between the owner zone and the generated blocks. Throws
// the same ComposeErrors, in the same order, as composeClaudeMd.
export function scanClaudeMd(fileText: string, legacyMarkers: readonly MarkerPair[] = LEGACY_MARKERS): ScanResult {
  const pairs = [V2_PAIR, ...legacyMarkers]
  const beginOf = (c: string) => pairs.find((p) => p.begin === c)
  const endOf = (c: string) => pairs.find((p) => p.end === c)

  const scanned: ScannedLine[] = []
  let fence: (Fence & { line: number }) | null = null
  let open: { pair: MarkerPair; line: number } | null = null
  let v2Seen = 0

  const bom = fileText.startsWith(BOM)
  const lines = splitLines(bom ? fileText.slice(BOM.length) : fileText)
  for (let i = 0; i < lines.length; i++) {
    const { raw, content } = lines[i]
    const n = i + 1

    if (open) {
      if (content === open.pair.end) {
        scanned.push({ n, raw, content, kind: 'end', block: open.pair.id })
        open = null
        continue
      }
      const b = beginOf(content)
      if (b) throw new ComposeError(`line ${n}: BEGIN of "${b.id}" inside the open "${open.pair.id}" block (line ${open.line})`, n)
      const e = endOf(content)
      if (e) throw new ComposeError(`line ${n}: END of "${e.id}" inside the open "${open.pair.id}" block (line ${open.line})`, n)
      scanned.push({ n, raw, content, kind: 'inner', block: open.pair.id })
      continue
    }

    if (fence) {
      if (closesFence(content, fence)) fence = null
      scanned.push({ n, raw, content, kind: 'owner', inFence: true })
      continue
    }

    const b = beginOf(content)
    if (b) {
      if (b === V2_PAIR && ++v2Seen > 1) throw new ComposeError(`line ${n}: a second v2 region`, n)
      open = { pair: b, line: n }
      scanned.push({ n, raw, content, kind: 'begin', block: b.id })
      continue
    }
    const e = endOf(content)
    if (e) throw new ComposeError(`line ${n}: END of "${e.id}" without its BEGIN`, n)

    const f = fenceOpener(content)
    if (f) fence = { ...f, line: n }
    scanned.push({ n, raw, content, kind: 'owner', inFence: f !== null })
  }
  if (open) throw new ComposeError(`line ${open.line}: BEGIN of "${open.pair.id}" without its END`, open.line)
  // The region goes at EOF; inside an unclosed fence it would be code, and the
  // next compose would not recognise it and append another one each time.
  if (fence) throw new ComposeError('unclosed code fence at EOF: the region would land inside it', fence.line)
  return { bom, lines: scanned }
}

// C1 PR 10b E, the rollback's strip: the v2 region (its BEGIN, body and END
// lines) goes, nothing else. Owner lines and legacy generated blocks stay byte
// for byte, the BOM and the line endings too. The separator composeClaudeMd
// put next to the region goes with it: the blank line right before BEGIN when
// the region ends the file (compose appends it there), or the blank right
// after END when the region opened after a blank (compose's own rule for a
// removed block). So stripV2Region(composeClaudeMd(t, region).text).text === t
// for a t without generated blocks that ends in a non-blank line and an LF
// (an owner whose file ended in a blank line loses that one line).
// The same scan as composeClaudeMd: a broken file throws the same ComposeError,
// and a marker line inside a code fence is owner text, not a region.
export function stripV2Region(fileText: string, legacyMarkers: readonly MarkerPair[] = LEGACY_MARKERS): { text: string; changed: boolean } {
  const { bom, lines } = scanClaudeMd(fileText, legacyMarkers)
  const out: ScannedLine[] = []
  let found = false
  let openedAfterBlank = false
  let dropNextBlank = false
  for (const line of lines) {
    if (line.kind !== 'owner' && line.block === V2_PAIR.id) {
      if (line.kind === 'begin') {
        found = true
        openedAfterBlank = out.length === 0 || isBlank(out[out.length - 1].content)
      }
      if (line.kind === 'end') dropNextBlank = openedAfterBlank
      continue
    }
    if (dropNextBlank) {
      dropNextBlank = false
      if (line.kind === 'owner' && isBlank(line.content)) continue
    }
    out.push(line)
  }
  if (!found) return { text: fileText, changed: false }
  // The region ended the file: the separator is the blank before it.
  if (dropNextBlank && out.length > 0 && isBlank(out[out.length - 1].content)) out.pop()
  const text = (bom ? BOM : '') + out.map((l) => l.raw).join('')
  return { text, changed: text !== fileText }
}

export function composeClaudeMd(
  fileText: string,
  region: string,
  legacyMarkers: readonly MarkerPair[] = LEGACY_MARKERS,
): ComposeResult {
  checkRegion(region, legacyMarkers)
  const { bom, lines } = scanClaudeMd(fileText, legacyMarkers)

  const out: ScannedLine[] = []
  const removed: string[] = []
  let openedAfterBlank = false
  let dropNextBlank = false
  for (const line of lines) {
    if (line.kind === 'begin') {
      openedAfterBlank = out.length === 0 || isBlank(out[out.length - 1].content)
      continue
    }
    if (line.kind === 'inner') continue
    if (line.kind === 'end') {
      removed.push(line.block as string)
      dropNextBlank = openedAfterBlank
      continue
    }
    // An owner line. A block can open only outside a fence, so the line right
    // after its END is outside one too: the separator rule never drops a line
    // of code.
    if (dropNextBlank) {
      dropNextBlank = false
      if (isBlank(line.content)) continue
    }
    out.push(line)
  }

  let owner = out.map((l) => l.raw).join('')
  let text: string
  if (owner.length === 0) {
    text = region
  } else {
    if (!owner.endsWith('\n')) owner += '\n'
    const last = out[out.length - 1].content
    if (!isBlank(last)) owner += '\n'
    text = owner + region
  }
  text = (bom ? BOM : '') + text
  return { text, changed: text !== fileText, removed }
}
