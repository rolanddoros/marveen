// scripts/deploy/deploy-git.mjs: the fork deploy helper's git calls and read-only preconditions (plan v3 point 4
// [SEC-4], point 6 steps 2-4 and 10 [REL-4]). Real throwaway repositories: a "fork" and a "prod" clone of it.
// Pinned: the runner's argv and environment, no hook and no global config runs, a forbidden local key stops,
// every precondition on its own, the tip from the fetch's porcelain line, the ff-only merge to the object id.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs script, no types
import { gitRunner, forbiddenLocalConfig, preconditionFailures, fetchForkTip, isAncestor, mergeToApproved, LOCAL_CONFIG_ALLOWLIST } from '../../scripts/deploy/deploy-git.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let fork: string
let prod: string
let home: string

/** Test-side git (setup only), isolated from any global config. */
function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' },
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function commitIn(repo: string, file: string, content: string, msg: string): string {
  writeFileSync(join(repo, file), content)
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-q', '-m', msg)
  return sh(repo, 'rev-parse', 'HEAD')
}

const env = () => ({ PATH: process.env.PATH, HOME: home })

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-git-')))
  home = join(base, 'home')
  mkdirSync(home)
  fork = join(base, 'fork')
  prod = join(base, 'prod')
  mkdirSync(fork)
  sh(fork, 'init', '-q')
  commitIn(fork, 'a.txt', 'a', 'a')
  sh(base, 'clone', '-q', '--origin', 'fork', fork, prod)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('the runner (SEC-4)', () => {
  it('argv starts with the hook and fsmonitor overrides; no shell; only the allowlisted environment', () => {
    const seen: { cmd: string; args: string[]; opts: { env: Record<string, string>; shell: boolean; cwd: string } }[] = []
    const spawn = (cmd: string, args: string[], opts: { env: Record<string, string>; shell: boolean; cwd: string }) => {
      seen.push({ cmd, args, opts })
      return { status: 0, stdout: 'ok', stderr: '' }
    }
    const git = gitRunner('/x', { env: { PATH: '/p', HOME: '/h', GIT_DIR: '/evil', GIT_CONFIG_GLOBAL: '/evil', SECRET: 's' }, spawn })
    expect(git(['status'])).toBe('ok')
    expect(seen[0].cmd).toBe('git')
    expect(seen[0].args).toEqual(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'status'])
    expect(seen[0].opts.shell).toBe(false)
    expect(seen[0].opts.cwd).toBe('/x')
    expect(seen[0].opts.env).toEqual({ PATH: '/p', HOME: '/h', LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' })
  })

  it('a non-zero exit throws, with allowFail it returns the status', () => {
    const git = gitRunner(prod, { env: env() })
    expect(() => git(['rev-parse', 'no-such-ref'])).toThrow(/git rev-parse failed \(exit 128\)/)
    expect(git(['rev-parse', 'no-such-ref'], { allowFail: true }).status).toBe(128)
  })

  it('a hook in .git/hooks and a hooksPath in the GLOBAL config never run during the merge', () => {
    const marker = join(base, 'hook-ran')
    const hook = `#!/bin/sh\ntouch ${marker}\n`
    writeFileSync(join(prod, '.git', 'hooks', 'post-merge'), hook)
    chmodSync(join(prod, '.git', 'hooks', 'post-merge'), 0o755)
    mkdirSync(join(home, 'hooks'))
    writeFileSync(join(home, 'hooks', 'post-merge'), hook)
    chmodSync(join(home, 'hooks', 'post-merge'), 0o755)
    writeFileSync(join(home, '.gitconfig'), `[core]\n\thooksPath = ${join(home, 'hooks')}\n`)
    const to = commitIn(fork, 'b.txt', 'b', 'b')
    const git = gitRunner(prod, { env: env() })
    expect(fetchForkTip(git)).toBe(to)
    expect(mergeToApproved(git, to)).toEqual([])
    expect(existsSync(marker)).toBe(false)
    // Positive control: the same merge through plain git with the global config DOES run the hook.
    const to2 = commitIn(fork, 'c.txt', 'c', 'c')
    spawnSync('git', ['pull', '-q', '--ff-only', 'fork', 'main'], { cwd: prod, env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf8' })
    expect(sh(prod, 'rev-parse', 'HEAD')).toBe(to2)
    expect(existsSync(marker)).toBe(true)
  })
})

describe('forbidden local config', () => {
  it('a clean clone has none; the allowlist is empty (measured on the live install)', () => {
    expect(forbiddenLocalConfig(gitRunner(prod, { env: env() }))).toEqual([])
    expect(LOCAL_CONFIG_ALLOWLIST).toEqual([])
  })

  it('filter, hooksPath, fsmonitor, include, http, credential, url, merge and diff drivers are reported; branch.*.merge is not', () => {
    const git = gitRunner(prod, { env: env() })
    const keys: [string, string][] = [
      ['filter.x.smudge', 'touch /tmp/x'],
      ['core.hooksPath', '/tmp/h'],
      ['core.fsmonitor', 'true'],
      ['core.sshCommand', 'ssh -o x'],
      ['include.path', '/tmp/c'],
      ['http.proxy', 'http://p'],
      ['credential.helper', 'store'],
      ['url.https://evil/.insteadOf', 'https://github.com/'],
      ['merge.x.driver', 'touch /tmp/m'],
      ['diff.x.textconv', 'cat'],
      ['protocol.file.allow', 'always'],
    ]
    for (const [k, v] of keys) {
      sh(prod, 'config', '--local', k, v)
      const found = forbiddenLocalConfig(git)
      expect(found.map((l: string) => l.split(' ')[0]), k).toEqual([k.toLowerCase()])
      sh(prod, 'config', '--local', '--unset', k)
    }
    expect(sh(prod, 'config', '--local', '--get', 'branch.main.merge')).toBe('refs/heads/main')
    expect(forbiddenLocalConfig(git)).toEqual([])
  })

  it('a git config error (exit other than 0 or 1) is an error, never "no forbidden key"', () => {
    expect(() => forbiddenLocalConfig(() => ({ status: 3, stdout: '', stderr: 'bad config' }))).toThrow(/exit 3/)
    expect(forbiddenLocalConfig(() => ({ status: 1, stdout: '', stderr: '' }))).toEqual([])
  })
})

describe('preconditions (step 2 + HEAD == FROM)', () => {
  const URL_OF = () => fork
  function ok() {
    return { from: sh(prod, 'rev-parse', 'HEAD'), forkUrl: URL_OF() }
  }

  it('a clean main on FROM with the right remote: no failure', () => {
    expect(preconditionFailures(gitRunner(prod, { env: env() }), ok())).toEqual([])
  })

  it('each failure on its own', () => {
    const git = gitRunner(prod, { env: env() })
    const o = ok()
    expect(preconditionFailures(git, { ...o, from: 'f'.repeat(40) })).toEqual([`HEAD is ${o.from}, not FROM ${'f'.repeat(40)}`])
    expect(preconditionFailures(git, { ...o, forkUrl: 'https://github.com/rolanddoros/marveen.git' })).toEqual([`remote.fork.url is ${JSON.stringify(fork)}, not https://github.com/rolanddoros/marveen.git`])
    writeFileSync(join(prod, 'a.txt'), 'dirty')
    expect(preconditionFailures(git, o)).toEqual(['the working tree is not clean'])
    sh(prod, 'checkout', '-q', '--', 'a.txt')
    // An untracked file does not count (the install writes logs and stores next to the tree).
    writeFileSync(join(prod, 'untracked.log'), 'x')
    expect(preconditionFailures(git, o)).toEqual([])
    sh(prod, 'config', '--local', 'filter.lfs.smudge', 'evil')
    expect(preconditionFailures(git, o)).toEqual(['local git config carries filter.lfs.smudge'])
    sh(prod, 'config', '--local', '--unset', 'filter.lfs.smudge')
    sh(prod, 'checkout', '-q', '--detach')
    expect(preconditionFailures(git, o)).toEqual(['branch is detached, not main'])
    sh(prod, 'checkout', '-q', '-b', 'other')
    expect(preconditionFailures(git, o)).toEqual(['branch is other, not main'])
  })
})

describe('the fork tip and the merge (REL-4, step 10)', () => {
  it('the tip comes from the porcelain line; a later fetch that rewrites FETCH_HEAD does not change what was read', () => {
    const git = gitRunner(prod, { env: env() })
    const to = commitIn(fork, 'b.txt', 'b', 'b')
    const tip = fetchForkTip(git)
    expect(tip).toBe(to)
    commitIn(fork, 'c.txt', 'c', 'c')
    sh(prod, 'fetch', '-q', 'fork', 'main')
    expect(sh(prod, 'rev-parse', 'FETCH_HEAD')).not.toBe(tip)
    expect(mergeToApproved(git, tip)).toEqual([])
    expect(sh(prod, 'rev-parse', 'HEAD')).toBe(to)
  })

  it('FETCH_HEAD rewritten between the fetch and the read: the porcelain oid wins, FETCH_HEAD is never asked', () => {
    const asked: string[][] = []
    const fake = (args: string[]) => {
      asked.push(args)
      if (args[0] === 'fetch') return `* ${'0'.repeat(40)} ${'a'.repeat(40)} FETCH_HEAD\n`
      if (args[0] === 'rev-parse') return 'b'.repeat(40) + '\n'
      return ''
    }
    expect(fetchForkTip(fake)).toBe('a'.repeat(40))
    expect(asked).toEqual([['fetch', '--porcelain', '--no-tags', '--refmap=', 'fork', 'refs/heads/main']])
  })

  it('an unexpected porcelain shape is an error, never a guess', () => {
    for (const out of ['', 'a\nb\n', '* x y FETCH_HEAD\n', `* ${'0'.repeat(40)} ${'a'.repeat(40)} refs/remotes/fork/main\n`]) {
      expect(() => fetchForkTip(() => out), JSON.stringify(out)).toThrow(/git fetch --porcelain/)
    }
  })

  it('ancestry: true, false; the merge refuses a non-fast-forward and a non-oid TO', () => {
    const git = gitRunner(prod, { env: env() })
    const from = sh(prod, 'rev-parse', 'HEAD')
    const to = commitIn(fork, 'b.txt', 'b', 'b')
    fetchForkTip(git)
    expect(isAncestor(git, from, to)).toBe(true)
    commitIn(prod, 'local.txt', 'l', 'local commit')
    const local = sh(prod, 'rev-parse', 'HEAD')
    expect(isAncestor(git, local, to)).toBe(false)
    // With an identity a plain merge WOULD succeed here (a merge commit): only --ff-only makes it fail.
    sh(prod, 'config', '--local', 'user.name', 't')
    sh(prod, 'config', '--local', 'user.email', 't@t')
    expect(() => mergeToApproved(git, to)).toThrow(/git merge failed \(exit 128\):[\s\S]*fast-forward/)
    expect(sh(prod, 'rev-parse', 'HEAD')).toBe(local)
    expect(() => mergeToApproved(git, 'main')).toThrow(/not a 40-hex object id/)
    expect(() => isAncestor(git, 'nope', to)).toThrow(/merge-base/)
  })

  it('HEAD not on TO or a dirty tree after the merge is reported', () => {
    const to = 'a'.repeat(40)
    const fake = (headAfter: string, status: string) => (args: string[]) => (args[0] === 'rev-parse' ? headAfter + '\n' : args[0] === 'status' ? status : '')
    expect(mergeToApproved(fake(to, ''), to)).toEqual([])
    expect(mergeToApproved(fake('b'.repeat(40), ''), to)).toEqual([`HEAD is ${'b'.repeat(40)} after the merge, not TO ${to}`])
    expect(mergeToApproved(fake(to, ' M x\n'), to)).toEqual(['the working tree differs from the commit after the merge'])
  })
})
