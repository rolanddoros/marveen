// C1 PR 8: the owner-zone report of the dry-run (design 2.6/1 and 2.6/4).
//
// The owner zone is every line outside the generated blocks, exactly as
// composeClaudeMd draws the boundary (compose.ts scanClaudeMd): the region
// rollout keeps it byte for byte, so whatever it carries that the v2 region
// would contradict has to be cleaned by hand (design 2.6/4). This module finds
// those places. Pure: text in, findings out; no file, no network.
//
// A finding names a line, a detector and a pattern NAME, never the text: the
// report goes into a PR description, and the owner zones belong to the
// agents' principals, other families included (Kevin 12995). The caller may
// attach a masked excerpt only on explicit request.
//
// Detectors and their sources:
// - curl-recipe: a logical shell line (backslash continuations joined) with
//   `curl` in command position and `/api/` in it. Design 1.3: the owner-zone
//   recipes are frozen T1 copies that drift. Flags:
//     token-on-argv          the token value lands on curl's argv (the argv-ban
//                            rules of the product-skill test, C1 PR 9b)
//     double-quoted-payload  -d/--data "..." (the shell runs `...` and $(...)
//                            inside it; the autonomy block forbids it)
//     raw-q                  a q= query without --data-urlencode (design 1.3:
//                            HTTP 400 on accented words)
//     raw-bearer-value       a literal token after Bearer (20+ token
//                            characters): the value itself is in the file
//                            (Ron S1, 13027)
// - dashboard-token: every `.dashboard-token` occurrence. Flags: in-curl-recipe,
//   foreign-root (its absolute path is not under the install root).
// - sniff-literal: text whose presence changes what a legacy writer does
//   (agent-scaffold.ts, federation/onboarding.ts; pinned by a parity test).
// - stale-path: an install-anchored absolute path on a foreign root, by the
//   rule of ensureProjectRootInClaudeMd (agent-scaffold.ts rewriteForeignProjectRoot,
//   INSTALL_ANCHORED_SUFFIXES; pinned by a parity test). Only the suffix is
//   reported: the foreign prefix is a path from another machine or user.

import type { ScannedLine } from './compose.js'

export type Detector = 'curl-recipe' | 'dashboard-token' | 'sniff-literal' | 'stale-path'

export interface Finding {
  line: number
  detector: Detector
  pattern: string
  flags: string[]
}

// agent-scaffold.ts INSTALL_ANCHORED_SUFFIXES, copied (that module cannot be
// imported here: config.js side effects; claude-md-owner-zone.test.ts pins it).
export const INSTALL_ANCHORED_SUFFIXES = [
  '/store/.dashboard-token',
  '/scripts/hooks/',
  '/scripts/skill-index.sh',
  '/scripts/recipient-ledger.mjs',
  '/scripts/skill-lint.mjs',
  '/scripts/marveen-api.sh',
] as const

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// agent-scaffold.ts FOREIGN_ROOT_RE, same construction (pinned by the parity test).
function foreignRootRe(): RegExp {
  return new RegExp(
    `(?<![\\w~}.\\-/])(/[^\\s"'\`()<>\\[\\]]*?)(${INSTALL_ANCHORED_SUFFIXES.map(escapeRe).join('|')})`,
    'g',
  )
}

// Literals whose presence in a CLAUDE.md changes what a legacy writer does.
// `test` runs on one owner line (all of them are single-line by nature).
export interface SniffLiteral {
  id: string
  source: string
  test(line: string): boolean
}

export const SNIFF_LITERALS: readonly SniffLiteral[] = [
  {
    // ensureMemorySearchLabelSection skips the block when the file matches it.
    id: 'x-memory-search',
    source: 'agent-scaffold.ts ensureMemorySearchLabelSection: /x-memory-search/i',
    test: (l) => /x-memory-search/i.test(l),
  },
  {
    // ensureFleetAuthSection skips the block when the file matches it.
    id: 'auth-szabaly',
    source: 'agent-scaffold.ts ensureFleetAuthSection: /AUTH-szab\u00e1ly/i',
    test: (l) => /AUTH-szab\u00e1ly/i.test(l),
  },
  {
    // The federation block anchors on this heading (a trimmed-line match).
    id: 'interagent-heading',
    source: 'federation/onboarding.ts INTERAGENT_HEADING',
    test: (l) => l.trim() === '## Inter-agent kommunik\u00e1ci\u00f3',
  },
  {
    // The federation policy seed is skipped when the file includes it.
    id: 'federation-policy-anchor',
    source: 'federation/onboarding.ts FEDERATION_POLICY_ANCHOR',
    test: (l) => l.includes('<!-- MARVEEN-FEDERATION:POLICY -->'),
  },
]

// The argv-ban rules of claude-md-skills.test.ts (C1 PR 9b, Johnny 12800):
// the token's VALUE on a command line.
const TOKEN_ON_ARGV: readonly RegExp[] = [
  /Authorization:\s*Bearer\s*['"]*\s*\$/,
  /\$\(\s*cat\s+[^)]*dashboard-token/,
  /`\s*cat\s+[^`]*dashboard-token/,
]

// `curl` where a command starts: line start, after | & ; ( or a `$(`, or at
// the start of an inline code span.
const CURL_CMD = /(?:^|[|&;(`]|\$\()\s*curl\b/
// A literal value after Bearer, not a $-form or a placeholder.
const RAW_BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/
const DOUBLE_QUOTED_PAYLOAD = /(?:^|\s)(?:-d|--data|--data-raw|--data-binary)\s+"/
const RAW_Q = /[?&\s'"]q=/

interface LogicalLine {
  start: number // first physical line number
  lines: number[]
  text: string
}

// Owner lines grouped into logical shell lines: a line ending in a backslash
// continues on the next owner line. A generated block between two owner lines
// ends the group.
function logicalLines(owner: readonly ScannedLine[]): LogicalLine[] {
  const out: LogicalLine[] = []
  let cur: LogicalLine | null = null
  let prevN = -1
  for (const l of owner) {
    if (cur && l.n !== prevN + 1) {
      out.push(cur)
      cur = null
    }
    const continues = /\\[ \t]*$/.test(l.content)
    const piece = continues ? l.content.replace(/\\[ \t]*$/, '') : l.content
    if (cur) {
      cur.lines.push(l.n)
      cur.text += ` ${piece}`
    } else {
      cur = { start: l.n, lines: [l.n], text: piece }
    }
    prevN = l.n
    if (!continues) {
      out.push(cur)
      cur = null
    }
  }
  if (cur) out.push(cur)
  return out
}

function underRoot(prefix: string, root: string): boolean {
  return prefix === root || prefix.startsWith(`${root}/`)
}

// The findings of one file's owner zone, sorted by line, then detector.
// `owner` is the owner lines of scanClaudeMd (or every line, when the file
// could not be scanned); `root` the install root, without a trailing slash.
export function ownerZoneFindings(owner: readonly ScannedLine[], root: string): Finding[] {
  const r = root.replace(/\/+$/, '')
  const findings: Finding[] = []
  const curlLines = new Set<number>()

  for (const ll of logicalLines(owner)) {
    if (!CURL_CMD.test(ll.text) || !ll.text.includes('/api/')) continue
    for (const n of ll.lines) curlLines.add(n)
    const flags: string[] = []
    if (TOKEN_ON_ARGV.some((re) => re.test(ll.text))) flags.push('token-on-argv')
    if (RAW_BEARER.test(ll.text)) flags.push('raw-bearer-value')
    if (DOUBLE_QUOTED_PAYLOAD.test(ll.text)) flags.push('double-quoted-payload')
    if (RAW_Q.test(ll.text) && !ll.text.includes('--data-urlencode')) flags.push('raw-q')
    findings.push({ line: ll.start, detector: 'curl-recipe', pattern: 'curl-api', flags })
  }

  for (const l of owner) {
    const c = l.content
    if (c.includes('.dashboard-token')) {
      const flags: string[] = []
      if (curlLines.has(l.n)) flags.push('in-curl-recipe')
      for (const m of c.matchAll(foreignRootRe())) {
        if (m[2] === '/store/.dashboard-token' && !underRoot(m[1], r)) {
          flags.push('foreign-root')
          break
        }
      }
      findings.push({ line: l.n, detector: 'dashboard-token', pattern: 'dashboard-token', flags })
    }
    for (const s of SNIFF_LITERALS) {
      if (s.test(c)) findings.push({ line: l.n, detector: 'sniff-literal', pattern: s.id, flags: [] })
    }
    const seen = new Set<string>()
    for (const m of c.matchAll(foreignRootRe())) {
      if (underRoot(m[1], r) || seen.has(m[2])) continue
      seen.add(m[2])
      findings.push({ line: l.n, detector: 'stale-path', pattern: m[2], flags: [] })
    }
  }

  const order: Record<Detector, number> = { 'curl-recipe': 0, 'dashboard-token': 1, 'sniff-literal': 2, 'stale-path': 3 }
  return findings.sort((a, b) => a.line - b.line || order[a.detector] - order[b.detector])
}

// A retired stock section (templates/retired-claude-md-sections.json, the
// entries under the skill-section heading) sitting byte for byte in the owner
// zone: ensureSkillSectionCurrent replaces such a section on the next start.
// Only the file's fixed entries are checked; the per-agent forms that function
// rebuilds at runtime (token path, helper or curl form) need agent-scaffold.ts
// and are not.
export function retiredSectionFindings(owner: readonly ScannedLine[], retired: readonly string[]): Finding[] {
  if (retired.length === 0) return []
  // Owner text per contiguous run, so a section never spans a generated block.
  const findings: Finding[] = []
  let run: ScannedLine[] = []
  const flush = () => {
    if (run.length === 0) return
    const text = run.map((l) => l.raw).join('')
    retired.forEach((section, idx) => {
      if (section.length === 0) return
      let from = 0
      for (;;) {
        const at = text.indexOf(section, from)
        if (at < 0) break
        let off = 0
        const hit = run.find((l) => {
          off += l.raw.length
          return off > at
        })
        findings.push({ line: (hit ?? run[0]).n, detector: 'sniff-literal', pattern: `retired-skill-section-${idx}`, flags: [] })
        from = at + 1
      }
    })
    run = []
  }
  let prevN = -1
  for (const l of owner) {
    if (l.n !== prevN + 1) flush()
    run.push(l)
    prevN = l.n
  }
  flush()
  return findings
}

// An excerpt for --excerpts: the line, masked and cut. Masks a Bearer value,
// every run of six or more digits (chat ids, phone numbers) and e-mail
// addresses. NOT for a PR description: owner-zone text belongs to the
// agent's principal.
export function maskedExcerpt(line: string, max = 160): string {
  const masked = line
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1<masked>')
    .replace(/\d{6,}/g, '<masked>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<masked>')
    .trim()
  return [...masked].length > max ? `${[...masked].slice(0, max).join('')}...` : masked
}
