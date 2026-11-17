// Every git call of the fork deploy helper, and its read-only preconditions (fork deploy-gate plan v3 point 4 [SEC-4],
// point 6 steps 2-4 and 10 [REL-4]).
//
// SEC-4: the merge must not read the repository's config or hooks. Each call runs without a shell (spawnSync argv),
// with an allowlisted environment (PATH, HOME, LANG), GIT_CONFIG_GLOBAL=/dev/null + GIT_CONFIG_NOSYSTEM=1, and
// `-c core.hooksPath=/dev/null -c core.fsmonitor=false`. The local config is checked against the keys that could
// still run code or redirect the fetch: any match stops the helper. The allowlist was measured on the live install
// on 2026-11-17 and is empty.
//
// REL-4: the fork tip comes from `git fetch --porcelain`'s own output, never from FETCH_HEAD, which another fetch
// (one the gate allows) could overwrite. Measured on git 2.53: one line "* <old> <new> FETCH_HEAD", and
// refs/remotes/fork/main is not touched.
import { spawnSync } from 'node:child_process'

export const FORBIDDEN_LOCAL_CONFIG = '^(filter\\.|core\\.(hookspath|fsmonitor|attributesfile|sshcommand)|include|http\\.|credential\\.|protocol\\.|merge\\.|diff\\.|url\\.)'
export const LOCAL_CONFIG_ALLOWLIST = Object.freeze([])
export const OID_RE = /^[0-9a-f]{40}$/

/**
 * A git runner for `cwd`: (args, { allowFail }) -> stdout, or { status, stdout, stderr } with allowFail.
 * Throws on a non-zero exit unless allowFail.
 */
export function gitRunner(cwd, { env = process.env, spawn = spawnSync, timeoutMs = 120_000 } = {}) {
  const base = {
    PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: env.HOME ?? '/root',
    LANG: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
  return (args, { allowFail = false } = {}) => {
    const r = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      cwd,
      env: base,
      encoding: 'utf8',
      shell: false,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (allowFail) return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    if (r.status !== 0) throw new Error(`git ${args[0]} failed (exit ${r.status}): ${String(r.stderr ?? '').trim().slice(0, 300)}`)
    return r.stdout ?? ''
  }
}

/** Local config keys that match the forbidden pattern and are not allowlisted. */
export function forbiddenLocalConfig(git) {
  const r = git(['config', '--local', '--get-regexp', FORBIDDEN_LOCAL_CONFIG], { allowFail: true })
  // exit 1 = no key matched; anything else but 0 is an error, not "clean".
  if (r.status === 1) return []
  if (r.status !== 0) throw new Error(`git config --get-regexp failed (exit ${r.status})`)
  return r.stdout.split('\n').filter(Boolean).filter((l) => !LOCAL_CONFIG_ALLOWLIST.includes(l.split(' ')[0]))
}

/**
 * Step 2 and the HEAD == FROM check: every reason not to touch this tree; empty when it may proceed. Read-only.
 */
export function preconditionFailures(git, { from, forkUrl, branch = 'main' }) {
  const out = []
  const head = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true })
  if (head.status !== 0 || head.stdout.trim() !== branch) out.push(`branch is ${head.status === 0 ? head.stdout.trim() : 'detached'}, not ${branch}`)
  const url = git(['config', '--local', '--get', 'remote.fork.url'], { allowFail: true })
  if (url.status !== 0 || url.stdout.trim() !== forkUrl) out.push(`remote.fork.url is ${JSON.stringify(url.stdout.trim())}, not ${forkUrl}`)
  const bad = forbiddenLocalConfig(git)
  if (bad.length) out.push(`local git config carries ${bad.map((l) => l.split(' ')[0]).join(', ')}`)
  const status = git(['status', '--porcelain', '--untracked-files=no'])
  if (status.trim()) out.push('the working tree is not clean')
  const headOid = git(['rev-parse', 'HEAD']).trim()
  if (headOid !== from) out.push(`HEAD is ${headOid}, not FROM ${from}`)
  return out
}

/** The fork tip from the fetch's own porcelain line; FETCH_HEAD is never read. */
export function fetchForkTip(git, branch = 'main') {
  const out = git(['fetch', '--porcelain', '--no-tags', '--refmap=', 'fork', `refs/heads/${branch}`])
  const lines = out.split('\n').filter(Boolean)
  if (lines.length !== 1) throw new Error(`git fetch --porcelain printed ${lines.length} lines, expected 1`)
  const parts = lines[0].split(' ')
  if (parts.length !== 4 || parts[3] !== 'FETCH_HEAD' || !OID_RE.test(parts[2])) throw new Error(`git fetch --porcelain line not understood: ${JSON.stringify(lines[0])}`)
  return parts[2]
}

export function isAncestor(git, from, to) {
  const r = git(['merge-base', '--is-ancestor', from, to], { allowFail: true })
  if (r.status === 0) return true
  if (r.status === 1) return false
  throw new Error(`git merge-base --is-ancestor failed (exit ${r.status})`)
}

/** Step 10: fast-forward to the approved object id, then HEAD == TO and a clean tree, or the reasons why not. */
export function mergeToApproved(git, to) {
  if (!OID_RE.test(to)) throw new Error(`TO ${JSON.stringify(to)} is not a 40-hex object id`)
  git(['merge', '--ff-only', '--no-edit', to])
  const out = []
  const head = git(['rev-parse', 'HEAD']).trim()
  if (head !== to) out.push(`HEAD is ${head} after the merge, not TO ${to}`)
  if (git(['status', '--porcelain', '--untracked-files=no']).trim()) out.push('the working tree differs from the commit after the merge')
  return out
}
