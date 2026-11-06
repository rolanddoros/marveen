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
//        removal would leave a pile of empty lines behind.
//     2. Before the region: a missing final line break is added, and one blank
//        separator line when the owner zone does not already end with one.
//   Both additions use LF. Everything else (CRLF line endings, a BOM,
//   Hungarian text, trailing spaces) stays as it was.
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
  constructor(message: string) {
    super(message)
    this.name = 'ComposeError'
  }
}

export interface ComposeResult {
  text: string
  changed: boolean
  // ids of the removed blocks in file order; 'v2' for a previous region.
  removed: string[]
}

const V2_PAIR: MarkerPair = { id: 'v2', begin: REGION_BEGIN, end: REGION_END }

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

export function composeClaudeMd(
  fileText: string,
  region: string,
  legacyMarkers: readonly MarkerPair[] = LEGACY_MARKERS,
): ComposeResult {
  checkRegion(region, legacyMarkers)
  const pairs = [V2_PAIR, ...legacyMarkers]
  const beginOf = (c: string) => pairs.find((p) => p.begin === c)
  const endOf = (c: string) => pairs.find((p) => p.end === c)

  const out: Line[] = []
  const removed: string[] = []
  let fence: Fence | null = null
  let open: { pair: MarkerPair; line: number } | null = null
  let openedAfterBlank = false
  let dropNextBlank = false
  let v2Seen = 0

  const lines = splitLines(fileText)
  for (let i = 0; i < lines.length; i++) {
    const { content } = lines[i]
    const n = i + 1

    if (open) {
      if (content === open.pair.end) {
        removed.push(open.pair.id)
        open = null
        dropNextBlank = openedAfterBlank
        continue
      }
      const b = beginOf(content)
      if (b) throw new ComposeError(`line ${n}: BEGIN of "${b.id}" inside the open "${open.pair.id}" block (line ${open.line})`)
      const e = endOf(content)
      if (e) throw new ComposeError(`line ${n}: END of "${e.id}" inside the open "${open.pair.id}" block (line ${open.line})`)
      continue
    }

    if (fence) {
      if (closesFence(content, fence)) fence = null
      out.push(lines[i])
      dropNextBlank = false
      continue
    }

    const b = beginOf(content)
    if (b) {
      if (b === V2_PAIR && ++v2Seen > 1) throw new ComposeError(`line ${n}: a second v2 region`)
      open = { pair: b, line: n }
      openedAfterBlank = out.length === 0 || isBlank(out[out.length - 1].content)
      continue
    }
    const e = endOf(content)
    if (e) throw new ComposeError(`line ${n}: END of "${e.id}" without its BEGIN`)

    if (dropNextBlank) {
      dropNextBlank = false
      if (isBlank(content)) continue
    }
    const f = fenceOpener(content)
    if (f) fence = f
    out.push(lines[i])
  }
  if (open) throw new ComposeError(`line ${open.line}: BEGIN of "${open.pair.id}" without its END`)
  // The region goes at EOF; inside an unclosed fence it would be code, and the
  // next compose would not recognise it and append another one each time.
  if (fence) throw new ComposeError('unclosed code fence at EOF: the region would land inside it')

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
  return { text, changed: text !== fileText, removed }
}
