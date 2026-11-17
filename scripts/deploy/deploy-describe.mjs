// What a fork deploy changes, rendered two ways from the same git data (fork deploy-gate plan v3 point 3,
// addendum A1-3, Ron 17165 C4):
//
//   fullRender        every commit, package change and gate/deploy path, never cut. Its sha256 is the
//                     "listák sha256" line of the owner text, so `apply` can recompute it from FROM..TO in git
//                     and the request log in store/ is only a human copy (C4).
//   ownerDescription  the owner text: a never-cut head, then the lists cut to DESCRIPTION_CAP by renderBounded.
//   contentHash       the approval's content_hash: repo, branch, FROM and TO.
//
// Nothing here runs git itself: `collect` takes a runner `git(args) -> stdout` (fork-deploy.mjs passes the one
// with the plan's SEC-4 environment), so the same function serves `request`, `apply` and the tests.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderBounded } from '../hooks/owner-approval.mjs'

export const HEADER = 'marveen-code-deploy/v1'
export const LOG_LINE_PREFIX = 'request-napló: '
export const GATE_LINE_NAMES = 10
export const LIST_MAX = 40
/** The request log path the helper writes and `apply` accepts from the payload: nothing else. */
export const LOG_PATH_RE = /^store\/deploy-logs\/request-[0-9]{8}T[0-9]{6}Z\.log$/

const HERE = dirname(fileURLToPath(import.meta.url))

/** The pattern list from gate-paths.json next to this file (or another file, for tests). */
export function loadGatePaths(file = join(HERE, 'gate-paths.json')) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(data.patterns) || !data.patterns.every((p) => typeof p === 'string' && p.length > 0)) {
    throw new Error(`${file}: "patterns" must be a list of non-empty strings`)
  }
  return { patterns: data.patterns, packageJsonScripts: data.packageJsonScripts === true }
}

/** 'dir/**' = under dir, '*' = inside one segment, else exact. */
export function matchesPattern(path, pattern) {
  if (pattern.endsWith('/**')) return path.startsWith(pattern.slice(0, -2))
  if (!pattern.includes('*')) return path === pattern
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$')
  return re.test(path)
}

/** Canonical JSON (sorted keys) so a reordered object is not a change. */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  }
  return JSON.stringify(value ?? null)
}

function parseJson(text, what) {
  if (text == null) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${what} is not valid JSON`)
  }
}

/** The `scripts` key of package.json changed (a missing file or key counts as {}). */
export function scriptsChanged(pkgFromText, pkgToText) {
  const a = parseJson(pkgFromText, 'package.json at FROM')?.scripts ?? {}
  const b = parseJson(pkgToText, 'package.json at TO')?.scripts ?? {}
  return canonical(a) !== canonical(b)
}

/** The source fields of a lock entry compared at the same version (Ron's code review SEC-1). */
const SOURCE_FIELDS = ['resolved', 'integrity']

/**
 * name -> { version, resolved, integrity } from package-lock.json's `packages` key; the root entry ("") is not a
 * package. A missing or non-string field is null, so "absent" and "absent" compare equal.
 */
function lockPackages(text, what) {
  const packages = parseJson(text, what)?.packages ?? {}
  const out = new Map()
  for (const [key, entry] of Object.entries(packages)) {
    if (key === '') continue
    const name = key.replace(/^node_modules\//, '')
    const field = (f) => (typeof entry?.[f] === 'string' ? entry[f] : null)
    out.set(name, { version: field('version') ?? '?', resolved: field('resolved'), integrity: field('integrity') })
  }
  return out
}

/**
 * Added, changed, removed, each by name. Nested copies keep their path (a/node_modules/b), so they stay distinct.
 * An entry at the same version whose `resolved` or `integrity` moved is changed too, with `source` naming the moved
 * fields (SEC-1: `npm ci` would fetch the other tarball, so the owner text must show it).
 */
export function packageChanges(lockFromText, lockToText) {
  const a = lockPackages(lockFromText, 'package-lock.json at FROM')
  const b = lockPackages(lockToText, 'package-lock.json at TO')
  const byName = (x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0)
  const added = [...b].filter(([n]) => !a.has(n)).map(([name, e]) => ({ name, version: e.version })).sort(byName)
  const removed = [...a].filter(([n]) => !b.has(n)).map(([name, e]) => ({ name, version: e.version })).sort(byName)
  const changed = []
  for (const [name, to] of b) {
    const from = a.get(name)
    if (!from) continue
    if (from.version !== to.version) {
      changed.push({ name, from: from.version, to: to.version })
      continue
    }
    const source = SOURCE_FIELDS.filter((f) => from[f] !== to[f])
    if (source.length > 0) changed.push({ name, from: from.version, to: to.version, source })
  }
  changed.sort(byName)
  return { added, changed, removed }
}

/** Package rows in the owner's order: added, changed, removed (A1-3: a cut hits the removed ones first). */
export function packageRows({ added, changed, removed }) {
  return [
    ...added.map((p) => `+ ${p.name} ${p.version}`),
    ...changed.map((p) => (p.source ? `~ ${p.name} ${p.to} (azonos verzió, más ${p.source.join(' és ')})` : `~ ${p.name} ${p.from} -> ${p.to}`)),
    ...removed.map((p) => `- ${p.name} ${p.version}`),
  ]
}

function showOrNull(git, rev, path) {
  try {
    return git(['show', `${rev}:${path}`])
  } catch {
    return null
  }
}

/**
 * Everything both renders need, from git only. `git` throws on a non-zero exit.
 * @returns {{ from: string, to: string, commits: string[], packages: ReturnType<typeof packageChanges>, gatePaths: string[], npmCi: boolean }}
 */
export function collect(git, from, to, gate = loadGatePaths()) {
  const commits = git(['log', '--first-parent', '--no-color', '--format=%h %s', `${from}..${to}`]).split('\n').filter(Boolean)
  const files = git(['diff', '--no-color', '--no-renames', '--name-only', '-z', from, to]).split('\0').filter(Boolean)
  const lockFrom = showOrNull(git, from, 'package-lock.json')
  const lockTo = showOrNull(git, to, 'package-lock.json')
  const gatePaths = files.filter((f) => gate.patterns.some((p) => matchesPattern(f, p)))
  if (gate.packageJsonScripts && files.includes('package.json') && scriptsChanged(showOrNull(git, from, 'package.json'), showOrNull(git, to, 'package.json'))) {
    gatePaths.push('package.json (scripts)')
  }
  gatePaths.sort()
  return { from, to, commits, packages: packageChanges(lockFrom, lockTo), gatePaths, npmCi: lockFrom !== lockTo }
}

/** Every list in full, one deterministic text: the source of the "listák sha256" line (C4) and the request log. */
export function fullRender(c) {
  const pkg = packageRows(c.packages)
  return [
    `${HEADER} lists`,
    `FROM ${c.from}`,
    `TO ${c.to}`,
    `npm ci: ${c.npmCi ? 'igen' : 'nem'}`,
    `commits ${c.commits.length}`,
    ...c.commits,
    `packages ${pkg.length}`,
    ...pkg,
    `gate paths ${c.gatePaths.length}`,
    ...c.gatePaths,
  ].join('\n')
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** content_hash of the approval (plan v3 point 3). */
export function contentHash({ repo, branch, from, to }) {
  return sha256(`${HEADER}\n${repo}\n${branch}\n${from}\n${to}`)
}

/** The never-cut gate/deploy path line: the count, at most GATE_LINE_NAMES names, and the rest as a number. */
export function gateLine(paths) {
  if (paths.length === 0) return 'Kapu/deploy utak: 0 fájl'
  const shown = paths.slice(0, GATE_LINE_NAMES).join(', ')
  const rest = paths.length - GATE_LINE_NAMES
  return `Kapu/deploy utak: ${paths.length} fájl: ${shown}${rest > 0 ? `, ... és még ${rest}` : ''}`
}

/**
 * The owner text (the approval's action_description). `logPath` is the request log the helper wrote; at `apply` it
 * comes from the approval's payload, never from a guess, and must match LOG_PATH_RE.
 */
export function ownerDescription(c, { repo, branch, logPath }) {
  if (!LOG_PATH_RE.test(logPath)) throw new Error(`request log path ${JSON.stringify(logPath)} is not store/deploy-logs/request-<UTC>.log`)
  const pkg = packageRows(c.packages)
  return renderBounded({
    head: [
      HEADER,
      `FROM ${c.from}`,
      `TO ${c.to}`,
      `content_hash ${contentHash({ repo, branch, from: c.from, to: c.to })}`,
      `listák sha256 ${sha256(fullRender(c))}`,
      `npm ci: ${c.npmCi ? 'igen' : 'nem'}`,
      `Commitok: ${c.commits.length}, csomagváltozás: ${pkg.length}`,
      gateLine(c.gatePaths),
      `${LOG_LINE_PREFIX}${logPath}`,
    ],
    sections: [
      { title: 'Commitok:', rows: c.commits, max: LIST_MAX, more: (n) => `... és még ${n} commit (teljes lista: ${logPath})` },
      { title: 'Csomagok:', rows: pkg, max: LIST_MAX, more: (n) => `... és még ${n} csomag` },
    ],
  })
}
