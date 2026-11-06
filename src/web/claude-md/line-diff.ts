// C1 PR 8b: a unified diff of two line lists, for the dry-run report.
//
// Lines are compared by (tag, raw text with its line ending). The dry-run tags
// every line with where it comes from (owner text, a legacy generated block,
// the new region), so a generated line can never pair with an owner line that
// happens to read the same: the old blocks always show as removed, the region
// always as added, and owner lines only ever align with owner lines.
//
// The alignment is a longest common subsequence after trimming the common
// prefix and suffix. When the remaining middle is too large for the quadratic
// table (MAX_CELLS), the middle is shown as one block removed and one block
// added: still a correct diff, only a longer one.
//
// Output follows `diff -u` / `git diff`: `--- a/<from>` / `+++ b/<to>`, hunks
// `@@ -start,count +start,count @@` (a count of 1 is omitted), and
// "\ No newline at end of file" after a line without one. A line's own CR
// stays in it, so the text is exactly what `git apply` expects.

export interface DiffLine {
  raw: string // with its own line ending, if any
  tag: string
}

export type Side = ' ' | '-' | '+'

interface Op {
  side: Side
  a: number // index into the old list (for ' ' and '-')
  b: number // index into the new list (for ' ' and '+')
}

export const MAX_CELLS = 4_000_000

export function splitRaw(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

const same = (x: DiffLine, y: DiffLine) => x.tag === y.tag && x.raw === y.raw

function editScript(a: readonly DiffLine[], b: readonly DiffLine[], maxCells: number): Op[] {
  let pre = 0
  while (pre < a.length && pre < b.length && same(a[pre], b[pre])) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && same(a[a.length - 1 - suf], b[b.length - 1 - suf])) suf++
  const ops: Op[] = []
  for (let i = 0; i < pre; i++) ops.push({ side: ' ', a: i, b: i })
  const n = a.length - pre - suf
  const m = b.length - pre - suf
  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= maxCells) {
    // lcs[i][j]: LCS length of a[pre+i..] and b[pre+j..]
    const w = m + 1
    const lcs = new Int32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = same(a[pre + i], b[pre + j]) ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (same(a[pre + i], b[pre + j])) {
        ops.push({ side: ' ', a: pre + i, b: pre + j })
        i++
        j++
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
        ops.push({ side: '-', a: pre + i, b: pre + j })
        i++
      } else {
        ops.push({ side: '+', a: pre + i, b: pre + j })
        j++
      }
    }
    for (; i < n; i++) ops.push({ side: '-', a: pre + i, b: pre + m })
    for (; j < m; j++) ops.push({ side: '+', a: pre + n, b: pre + j })
  } else {
    for (let i = 0; i < n; i++) ops.push({ side: '-', a: pre + i, b: pre })
    for (let j = 0; j < m; j++) ops.push({ side: '+', a: pre + n, b: pre + j })
  }
  for (let k = 0; k < suf; k++) ops.push({ side: ' ', a: pre + n + k, b: pre + m + k })
  return ops
}

export interface DiffOptions {
  from: string
  to: string
  context?: number
  // How one line is printed (without its prefix and line ending); default: as is.
  show?: (side: Side, line: DiffLine, index: number) => string
  // The table limit; default MAX_CELLS (a parameter so the fallback is testable).
  maxCells?: number
}

function range(start: number, count: number): string {
  // 1-based start; for an empty range the line BEFORE it (0 at the very top).
  const s = count === 0 ? start : start + 1
  return count === 1 ? `${s}` : `${s},${count}`
}

// '' when the two lists are equal.
export function unifiedDiff(a: readonly DiffLine[], b: readonly DiffLine[], opts: DiffOptions): string {
  const ctx = Math.max(0, opts.context ?? 3)
  const ops = editScript(a, b, opts.maxCells ?? MAX_CELLS)
  const changed = ops.map((o, k) => (o.side !== ' ' ? k : -1)).filter((k) => k >= 0)
  if (changed.length === 0) return ''
  const show = opts.show ?? ((_s: Side, l: DiffLine) => l.raw.replace(/\n$/, ''))

  // Hunks: runs of changes whose gaps are at most 2*ctx equal lines.
  const hunks: [number, number][] = []
  let start = changed[0]
  let end = changed[0]
  for (const k of changed.slice(1)) {
    if (k - end - 1 <= 2 * ctx) end = k
    else {
      hunks.push([start, end])
      start = k
      end = k
    }
  }
  hunks.push([start, end])

  const out = [`--- a/${opts.from}`, `+++ b/${opts.to}`]
  for (const [s, e] of hunks) {
    const lo = Math.max(0, s - ctx)
    const hi = Math.min(ops.length - 1, e + ctx)
    const slice = ops.slice(lo, hi + 1)
    const aCount = slice.filter((o) => o.side !== '+').length
    const bCount = slice.filter((o) => o.side !== '-').length
    const aStart = slice.find((o) => o.side !== '+')?.a ?? ops[lo].a
    const bStart = slice.find((o) => o.side !== '-')?.b ?? ops[lo].b
    out.push(`@@ -${range(aStart, aCount)} +${range(bStart, bCount)} @@`)
    for (const o of slice) {
      const line = o.side === '+' ? b[o.b] : a[o.a]
      const index = o.side === '+' ? o.b : o.a
      out.push(`${o.side}${show(o.side, line, index)}`)
      if (!line.raw.endsWith('\n')) out.push('\\ No newline at end of file')
    }
  }
  return `${out.join('\n')}\n`
}
