// scripts/deploy/fork-deploy.mjs: request / apply / status end to end (fork deploy-gate plan v3 point 6, addendum
// A1-2/A1-3/A1-4, Ron 17165 C1/C4). A throwaway "fork" repository and an install cloned from it (remote.fork.url is
// the literal GitHub URL; the test's git wrapper points only the fetch at the local fork), a stub dashboard, a stub
// systemctl that answers in systemd's order and starts a new pid on restart, a stub build, and a fake clock.
// Every STOP before the consume must leave the approval unconsumed and the tree untouched.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs script, no types
import { apply, request, status, parseArgs, takeLock, procStarttime, EXIT, REPO_URL, CATEGORY, CONSUMER, MAX_AGE_SECONDS, CODE_DEPLOY_OWNER_CHANNEL_ONLY } from '../../scripts/deploy/fork-deploy.mjs'
// @ts-expect-error -- plain .mjs script, no types
import { gitRunner } from '../../scripts/deploy/deploy-git.mjs'
// @ts-expect-error -- plain .mjs script, no types
import { collect, ownerDescription, contentHash } from '../../scripts/deploy/deploy-describe.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const MAIN = 'mainagent'
const T_START = Date.UTC(2026, 10, 17, 16, 0, 0)

let base: string
let fork: string
let inst: string

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' },
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function commitIn(repo: string, files: Record<string, string>, msg: string): string {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(repo, p, '..'), { recursive: true })
    writeFileSync(join(repo, p), c)
  }
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-q', '-m', msg)
  return sh(repo, 'rev-parse', 'HEAD')
}

const lock = (v: string) => JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'm' }, 'node_modules/a': { version: v } } })

type Row = Record<string, unknown> & { id: string; status: string }

/** The dashboard, in memory. */
function dashboard(opts: { provider?: string; consumeStatus?: number; notify?: boolean } = {}) {
  const rows = new Map<string, Row>()
  const consumes: { id: string; body: unknown }[] = []
  const posts: { body: Record<string, unknown>; logExisted: boolean }[] = []
  let n = 0
  const client = {
    get: async (path: string) => {
      const id = decodeURIComponent(path.split('/').pop() ?? '')
      const row = rows.get(id)
      return row ? { status: 200, data: { ...row } } : { status: 404, data: { error: 'not found' } }
    },
    post: async (path: string, body: Record<string, unknown>) => {
      if (path === '/api/approvals') {
        const payload = JSON.parse(String(body.action_payload))
        posts.push({ body, logExisted: existsSync(join(inst, payload.logPath)) })
        const id = `appr-${++n}`
        rows.set(id, { id, ...body, action_description: String(body.action_description).trim(), status: 'pending', telegram_message_id: opts.notify === false ? null : 4242, resolved_by: null, consumed_at: null })
        return { status: 201, data: rows.get(id) }
      }
      const m = /^\/api\/approvals\/([^/]+)\/consume$/.exec(path)
      if (m) {
        consumes.push({ id: decodeURIComponent(m[1]), body })
        const st = opts.consumeStatus ?? 200
        if (st === 200) rows.get(decodeURIComponent(m[1]))!.consumed_at = 1
        return { status: st, data: {} }
      }
      return { status: 404, data: null }
    },
  }
  return { client, rows, consumes, posts }
}

/** systemctl, answering in systemd's alphabetical order; restart starts a new pid and logs its start line. */
function systemd(clock: { now: () => number }, opts: { noInvocation?: boolean; restartWorks?: boolean; restartExit?: number } = {}) {
  let gen = 0
  const calls: string[][] = []
  const props = () => {
    const p: Record<string, string> = {
      ActiveEnterTimestamp: 'Tue 2026-11-17 13:35:16 CET',
      ActiveEnterTimestampMonotonic: String(15349552899 + gen * 1000),
      MainPID: String(1720826 + gen),
    }
    if (!opts.noInvocation) p.InvocationID = (gen ? 'b' : 'a').repeat(32)
    return Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('\n') + '\n'
  }
  const run = (args: string[]) => {
    calls.push(args)
    if (args.includes('cat')) return { status: args[0] === '--user' ? 0 : 1, stdout: '' }
    if (args.includes('show')) return { status: 0, stdout: props() }
    if (args.includes('restart')) {
      if (opts.restartExit) return { status: opts.restartExit, stdout: '' }
      if (opts.restartWorks !== false) {
        gen++
        const d = new Date(clock.now() + 3_600_000) // +0100
        const ts = d.toISOString().replace('T', ' ').replace('Z', '')
        appendFileSync(join(inst, 'store', 'dashboard.log'), `[${ts} +0100] \x1b[32mINFO\x1b[39m (${1720826 + gen}): \x1b[36mWeb dashboard: http://localhost:3420\x1b[39m\n`)
      }
      return { status: 0, stdout: '' }
    }
    return { status: 1, stdout: '' }
  }
  return { run, calls }
}

function context(extra: Record<string, unknown> = {}) {
  let t = T_START
  const clock = { now: () => t, sleep: async (ms: number) => { t += ms } }
  const out: string[] = []
  const events: string[] = []
  const real = gitRunner(inst, { env: { PATH: process.env.PATH, HOME: base } })
  const git = (args: string[], o?: unknown) => {
    // Only the fetch goes to the local fork; the config the helper checks keeps the literal URL.
    const a = args[0] === 'fetch' ? args.map((x) => (x === 'fork' ? fork : x)) : args
    if (args[0] === 'merge') events.push('merge')
    return real(a, o)
  }
  const d = dashboard(extra.dash as object)
  const consumePost = d.client.post
  d.client.post = async (path: string, body: Record<string, unknown>) => {
    if (path.endsWith('/consume')) events.push('consume')
    return consumePost(path, body)
  }
  const sys = systemd(clock, extra.sys as object)
  const builds: string[] = []
  const build = {
    npmCi: () => builds.push('npm ci'),
    compile: () => {
      mkdirSync(join(inst, 'dist.next'), { recursive: true })
      if (extra.buildFails) {
        // A failing tsc leaves the files it emitted before the error: the helper must remove them.
        writeFileSync(join(inst, 'dist.next', 'partial.js'), 'half\n')
        throw new Error('tsc exit 2')
      }
      builds.push('compile')
      writeFileSync(join(inst, 'dist.next', '.built-commit'), (extra.badStamp as string) ?? sh(inst, 'rev-parse', 'HEAD') + '\n')
      writeFileSync(join(inst, 'dist.next', 'index.js'), 'new\n')
    },
    tarDist: (dest: string) => writeFileSync(dest, 'tar'),
  }
  const ctx = {
    root: inst,
    git,
    systemctl: sys.run,
    client: d.client,
    build,
    now: clock.now,
    sleep: clock.sleep,
    out: (l: string) => out.push(l),
    ignoreHangup: () => events.push('ignoreHangup'),
    lockOpts: {},
    pollOpts: { tries: 3 },
    startOpts: { timeoutMs: 20_000 },
    ...(extra.ctx as object),
  }
  return { ctx, out, events, d, sys, builds, clock }
}

let FROM: string
let TO: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'fork-deploy-')))
  fork = join(base, 'fork')
  mkdirSync(fork)
  sh(fork, 'init', '-q')
  FROM = commitIn(fork, { 'package.json': '{"scripts":{"build":"tsc"}}', 'package-lock.json': lock('1.0.0'), 'src/a.ts': '1' }, 'base')
  inst = join(base, 'inst')
  sh(base, 'clone', '-q', '--origin', 'fork', fork, inst)
  sh(inst, 'config', '--local', 'remote.fork.url', REPO_URL)
  writeFileSync(join(inst, '.env'), `MAIN_AGENT_ID=${MAIN}\nCHANNEL_PROVIDER=telegram\n`)
  mkdirSync(join(inst, 'store'))
  mkdirSync(join(inst, 'dist'))
  writeFileSync(join(inst, 'dist', '.built-commit'), FROM + '\n')
  writeFileSync(join(inst, 'dist', 'index.js'), 'old\n')
  writeFileSync(join(inst, 'store', 'dashboard.log'), '[2026-11-17 13:35:20.338 +0100] \x1b[32mINFO\x1b[39m (1720826): \x1b[36mWeb dashboard: http://localhost:3420\x1b[39m\n')
  // .gitignore so the install's own files do not make the tree dirty (as on the live install).
  TO = commitIn(fork, { 'src/a.ts': '2', 'scripts/hooks/new.mjs': 'x', 'package-lock.json': lock('1.1.0'), '.gitignore': 'store/\ndist/\ndist.next/\ndist.prev/\n.env\n' }, 'feat: change')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/** request, then the owner approves through the cookie session. */
async function requested(t: ReturnType<typeof context>, resolvedBy = 'owner_session:roland') {
  expect(await request(t.ctx)).toBe(EXIT.OK)
  const [id] = [...t.d.rows.keys()]
  const row = t.d.rows.get(id)!
  Object.assign(row, { status: 'approved', resolved_by: resolvedBy })
  return id
}

function untouched(t: ReturnType<typeof context>) {
  expect(sh(inst, 'rev-parse', 'HEAD')).toBe(FROM)
  expect(t.d.consumes).toEqual([])
  expect(readFileSync(join(inst, 'dist', 'index.js'), 'utf8')).toBe('old\n')
  expect(existsSync(join(inst, 'dist.next'))).toBe(false)
  expect(existsSync(join(inst, 'store', 'deploy.lock'))).toBe(false)
}

describe('argv: exactly the three shapes', () => {
  it('request, status, apply --approval <id> --sha <40hex>; nothing else', () => {
    expect(parseArgs(['request'])).toEqual({ mode: 'request' })
    expect(parseArgs(['status'])).toEqual({ mode: 'status' })
    expect(parseArgs(['apply', '--approval', 'ab-12', '--sha', 'a'.repeat(40)])).toEqual({ mode: 'apply', approvalId: 'ab-12', sha: 'a'.repeat(40) })
    for (const bad of [[], ['request', 'x'], ['apply'], ['apply', '--sha', 'a'.repeat(40), '--approval', 'x'], ['apply', '--approval', 'a b', '--sha', 'a'.repeat(40)], ['apply', '--approval', 'x', '--sha', 'A'.repeat(40)], ['apply', '--approval', 'x', '--sha', 'a'.repeat(39)], ['apply', '--approval', 'x'.repeat(65), '--sha', 'a'.repeat(40)]]) {
      expect(parseArgs(bad), JSON.stringify(bad)).toBeNull()
    }
  })
  it('the owner-channel switch defaults to the fail-closed side until Roland decides', () => {
    expect(CODE_DEPLOY_OWNER_CHANNEL_ONLY).toBe(true)
  })
})

describe('request', () => {
  it('files a code_deploy approval with the owner text, the payload and the hash; the log is written BEFORE the POST', async () => {
    const t = context()
    expect(await request(t.ctx)).toBe(EXIT.OK)
    expect(t.d.posts).toHaveLength(1)
    const { body, logExisted } = t.d.posts[0]
    expect(logExisted).toBe(true)
    expect(body).toMatchObject({ agent_id: MAIN, category: CATEGORY, timeout_seconds: 3600 })
    expect(JSON.parse(String(body.action_payload))).toMatchObject({ repo: REPO_URL, branch: 'main', from: FROM, to: TO })
    expect(String(body.action_description)).toContain(`FROM ${FROM}`)
    expect(String(body.action_description)).toContain('Kapu/deploy utak: 1 fájl: scripts/hooks/new.mjs')
    expect(t.out).toContain('owner notified: yes (telegram message 4242)')
    expect(t.out.find((l) => l.startsWith('after the owner approves: node '))).toMatch(new RegExp(`apply --approval appr-1 --sha ${TO}$`))
  })

  it('no telegram message id: owner notified NO, exit 3, the approval stays', async () => {
    const t = context({ dash: { notify: false } })
    expect(await request(t.ctx)).toBe(EXIT.NOT_NOTIFIED)
    expect(t.out.find((l) => l.startsWith('owner notified:'))).toMatch(/^owner notified: NO/)
    expect(t.d.rows.size).toBe(1)
  })

  it('another provider: unknown, exit 3', async () => {
    writeFileSync(join(inst, '.env'), `MAIN_AGENT_ID=${MAIN}\nCHANNEL_PROVIDER=slack\n`)
    const t = context()
    expect(await request(t.ctx)).toBe(EXIT.NOT_NOTIFIED)
    expect(t.out).toContain('owner notified: unknown (provider slack, no message id)')
  })

  it('nothing to deploy when the install is at the tip; no POST', async () => {
    sh(inst, 'pull', '-q', '--ff-only', fork, 'main')
    const t = context()
    expect(await request(t.ctx)).toBe(EXIT.OK)
    expect(t.d.posts).toEqual([])
  })

  it('no MAIN_AGENT_ID: STOP, nothing filed', async () => {
    writeFileSync(join(inst, '.env'), 'CHANNEL_PROVIDER=telegram\n')
    const t = context()
    expect(await request(t.ctx)).toBe(EXIT.STOP)
    expect(t.d.posts).toEqual([])
  })
})

describe('apply: the happy path', () => {
  it('consumes once, right before the merge, ignores SIGHUP from there, swaps the build, proves the restart', async () => {
    const t = context()
    const id = await requested(t)
    expect(await apply(t.ctx, { approvalId: id, sha: TO })).toBe(EXIT.OK)
    expect(sh(inst, 'rev-parse', 'HEAD')).toBe(TO)
    expect(t.d.consumes).toEqual([{ id, body: { category: CATEGORY, content_hash: t.d.rows.get(id)!.content_hash, consumer: CONSUMER, ref: TO, max_age_seconds: MAX_AGE_SECONDS } }])
    expect(t.events).toEqual(['consume', 'ignoreHangup', 'merge'])
    expect(t.builds).toEqual(['npm ci', 'compile'])
    expect(readFileSync(join(inst, 'dist', '.built-commit'), 'utf8').trim()).toBe(TO)
    expect(readFileSync(join(inst, 'dist.prev', 'index.js'), 'utf8')).toBe('old\n')
    expect(existsSync(join(inst, 'dist.next'))).toBe(false)
    expect(sh(inst, 'tag', '--list', 'deploy/pre-*')).toBe('deploy/pre-20261117T160000Z')
    expect(existsSync(join(inst, 'store', 'deploy-backups', 'dist-20261117T160000Z.tar.gz'))).toBe(true)
    expect(t.sys.calls).toContainEqual(['--user', 'restart', `${MAIN}-dashboard.service`])
    const st = JSON.parse(readFileSync(join(inst, 'store', 'deploy-state.json'), 'utf8'))
    expect(st).toMatchObject({ step: 'done', from: FROM, to: TO, approvalId: id, pid: 1720827 })
    expect(existsSync(join(inst, 'store', 'deploy.lock'))).toBe(false)
    expect(t.out).toContain('resolved_by: owner_session:roland')
  })

  it('no lockfile change: no npm ci', async () => {
    sh(fork, 'reset', '-q', '--hard', FROM)
    TO = commitIn(fork, { 'src/a.ts': '3', '.gitignore': 'store/\ndist/\ndist.next/\ndist.prev/\n.env\n' }, 'feat: code only')
    const t = context()
    const id = await requested(t)
    expect(await apply(t.ctx, { approvalId: id, sha: TO })).toBe(EXIT.OK)
    expect(t.builds).toEqual(['compile'])
  })

  it('C4: one byte of the request log changed between request and apply has no effect', async () => {
    const t = context()
    const id = await requested(t)
    const logRel = JSON.parse(String(t.d.rows.get(id)!.action_payload)).logPath
    appendFileSync(join(inst, logRel), 'x')
    expect(await apply(t.ctx, { approvalId: id, sha: TO })).toBe(EXIT.OK)
  })

  it('switch OFF: a born-approved telegram_text row passes and the report names it', async () => {
    const t = context({ ctx: { ownerChannelOnly: false } })
    const id = await requested(t, 'telegram_text')
    expect(await apply(t.ctx, { approvalId: id, sha: TO })).toBe(EXIT.OK)
    expect(t.out).toContain('resolved_by: telegram_text')
  })
})

describe('apply: STOP before the consume leaves everything as it was', () => {
  async function stopCase(prepare: (t: ReturnType<typeof context>, id: string) => void | Promise<void>, re: RegExp, extra: Record<string, unknown> = {}) {
    const t = context(extra)
    const id = await requested(t)
    await prepare(t, id)
    expect(await apply(t.ctx, { approvalId: id, sha: TO })).toBe(EXIT.STOP)
    expect(t.out.find((l) => l.startsWith('STOP'))).toMatch(re)
    untouched(t)
    return t
  }

  it('the install moved (HEAD != FROM)', async () => {
    const t = context()
    const id = await requested(t)
    const local = commitIn(inst, { 'local.txt': 'l' }, 'local')
    expect(await apply(t.ctx, { approvalId: id, sha: TO })).toBe(EXIT.STOP)
    expect(t.out.find((l) => l.startsWith('STOP'))).toMatch(new RegExp(`HEAD is ${local}, not FROM ${FROM}`))
    expect(sh(inst, 'rev-parse', 'HEAD')).toBe(local)
    expect(t.d.consumes).toEqual([])
    expect(readFileSync(join(inst, 'dist', 'index.js'), 'utf8')).toBe('old\n')
  })

  it('the owner text differs by one byte', async () => {
    await stopCase((t, id) => {
      const r = t.d.rows.get(id)!
      r.action_description = String(r.action_description).replace('Commitok:', 'Commitok;')
    }, /approved text differs/)
  })

  it('born-approved row (telegram_text) with the switch ON', async () => {
    const t = context()
    const id = await requested(t, 'telegram_text')
    expect(await apply(t.ctx, { approvalId: id, sha: TO })).toBe(EXIT.STOP)
    expect(t.out.find((l) => l.startsWith('STOP'))).toMatch(/resolved_by "telegram_text" is not an owner channel/)
    untouched(t)
  })

  it('still pending / another hash / another agent / already consumed', async () => {
    for (const [over, re] of [[{ status: 'pending' }, /status pending/], [{ content_hash: 'c'.repeat(64) }, /content_hash differs/], [{ agent_id: 'stuart' }, /not the main agent/], [{ consumed_at: 5 }, /already consumed/]] as [Record<string, unknown>, RegExp][]) {
      const t = context()
      const id = await requested(t)
      Object.assign(t.d.rows.get(id)!, over)
      expect(await apply(t.ctx, { approvalId: id, sha: TO }), JSON.stringify(over)).toBe(EXIT.STOP)
      expect(t.out.find((l) => l.startsWith('STOP'))).toMatch(re)
      untouched(t)
    }
  })

  it('C4: the fork tip moved after the approval (a commit in the range changed)', async () => {
    await stopCase(() => {
      sh(fork, 'commit', '-q', '--amend', '-m', 'feat: change, reworded')
    }, /fork tip is .*not the approved TO/)
  })

  it('FROM is not an ancestor of TO (an approval made for a rewritten fork): STOP before the consume', async () => {
    // The fork's main becomes an unrelated (orphan) history; the row is built with the helper's own renderers,
    // so every other check passes and only the ancestry check can stop it.
    sh(fork, 'checkout', '-q', '--orphan', 'rewrite')
    const orphan = commitIn(fork, { 'src/a.ts': 'z', '.gitignore': 'store/\ndist/\n.env\n' }, 'rewrite')
    sh(fork, 'branch', '-q', '-f', 'main', orphan)
    sh(fork, 'checkout', '-q', 'main')
    const t = context()
    sh(inst, 'fetch', '-q', fork, 'main')
    const git = gitRunner(inst, { env: { PATH: process.env.PATH, HOME: base } })
    const logPath = 'store/deploy-logs/request-20261117T160000Z.log'
    const c = collect(git, FROM, orphan)
    const description = ownerDescription(c, { repo: REPO_URL, branch: 'main', logPath })
    t.d.rows.set('x1', { id: 'x1', agent_id: MAIN, category: CATEGORY, action_description: description, action_payload: JSON.stringify({ repo: REPO_URL, branch: 'main', from: FROM, to: orphan, logPath }), content_hash: contentHash({ repo: REPO_URL, branch: 'main', from: FROM, to: orphan }), status: 'approved', resolved_by: 'owner_session:roland', consumed_at: null })
    expect(await apply(t.ctx, { approvalId: 'x1', sha: orphan })).toBe(EXIT.STOP)
    expect(t.out.find((l) => l.startsWith('STOP'))).toMatch(new RegExp(`FROM ${FROM} is not an ancestor of TO ${orphan}`))
    untouched(t)
  })

  it('--sha is not the approved TO', async () => {
    const t = context()
    const id = await requested(t)
    expect(await apply(t.ctx, { approvalId: id, sha: 'f'.repeat(40) })).toBe(EXIT.STOP)
    expect(t.out.find((l) => l.startsWith('STOP'))).toMatch(/is not the approved TO/)
    untouched(t)
  })

  it('A1-2: no InvocationID (old systemd) stops before the merge', async () => {
    await stopCase(() => {}, /missing InvocationID/, { sys: { noInvocation: true } })
  })

  it('a dirty tracked tree, a forbidden local config key', async () => {
    await stopCase(() => {
      writeFileSync(join(inst, 'package.json'), 'dirty')
    }, /working tree is not clean/)
    sh(inst, 'checkout', '-q', '--', 'package.json')
    await stopCase(() => {
      sh(inst, 'config', '--local', 'filter.x.smudge', 'evil')
    }, /local git config carries filter\.x\.smudge/)
  })

  it('the consume answers 409: STOP, the tree untouched', async () => {
    const t = context({ dash: { consumeStatus: 409 } })
    const id = await requested(t)
    expect(await apply(t.ctx, { approvalId: id, sha: TO })).toBe(EXIT.STOP)
    expect(t.out.find((l) => l.startsWith('STOP'))).toMatch(/consume answered HTTP 409: the tree is untouched/)
    expect(sh(inst, 'rev-parse', 'HEAD')).toBe(FROM)
    expect(t.events).toEqual(['consume'])
  })

  it('a live lock stops; a stale one (dead pid) is taken over', async () => {
    const t = context()
    const id = await requested(t)
    writeFileSync(join(inst, 'store', 'deploy.lock'), JSON.stringify({ pid: process.pid, starttime: procStarttime(process.pid) }))
    expect(await apply(t.ctx, { approvalId: id, sha: TO })).toBe(EXIT.STOP)
    expect(t.out.find((l) => l.startsWith('STOP'))).toMatch(/another deploy holds/)
    expect(t.d.consumes).toEqual([])
    writeFileSync(join(inst, 'store', 'deploy.lock'), JSON.stringify({ pid: 2 ** 22 + 7, starttime: '1' }))
    expect(await apply(t.ctx, { approvalId: id, sha: TO })).toBe(EXIT.OK)
    expect(t.out.some((l) => l.startsWith('stale lock taken over: pid'))).toBe(true)
  })

  it('a lock whose pid is alive but with another start time is stale', () => {
    const f = join(inst, 'store', 'x.lock')
    writeFileSync(f, JSON.stringify({ pid: process.pid, starttime: 'other' }))
    const logs: string[] = []
    expect(() => takeLock(f, { log: (l: string) => logs.push(l) })).not.toThrow()
    expect(logs).toEqual([`stale lock taken over: pid ${process.pid}`])
  })
})

describe('apply: STOP after the consume says so (exit 4)', () => {
  it('build fails: dist untouched, dist.next removed, the tree at TO', async () => {
    const t = context({ buildFails: true })
    const id = await requested(t)
    expect(await apply(t.ctx, { approvalId: id, sha: TO })).toBe(EXIT.STOP_AFTER_CONSUME)
    expect(t.out.find((l) => l.startsWith('STOP'))).toMatch(/^STOP \(approval consumed\): build failed \(tsc exit 2\)\. The tree is at TO, dist is the old one/)
    expect(sh(inst, 'rev-parse', 'HEAD')).toBe(TO)
    expect(readFileSync(join(inst, 'dist', 'index.js'), 'utf8')).toBe('old\n')
    expect(existsSync(join(inst, 'dist.next'))).toBe(false)
    expect(JSON.parse(readFileSync(join(inst, 'store', 'deploy-state.json'), 'utf8')).step).toBe('stopped-after-consume')
  })

  it('a build stamped with another commit is a failed build', async () => {
    const t = context({ badStamp: 'f'.repeat(40) })
    const id = await requested(t)
    expect(await apply(t.ctx, { approvalId: id, sha: TO })).toBe(EXIT.STOP_AFTER_CONSUME)
    expect(t.out.find((l) => l.startsWith('STOP'))).toMatch(/dist\.next\/\.built-commit is f{40}, not TO/)
    expect(readFileSync(join(inst, 'dist', 'index.js'), 'utf8')).toBe('old\n')
    expect(existsSync(join(inst, 'dist.next'))).toBe(false)
  })

  it('the restart did not start a new process: (a), dist.prev named', async () => {
    const t = context({ sys: { restartWorks: false } })
    const id = await requested(t)
    expect(await apply(t.ctx, { approvalId: id, sha: TO })).toBe(EXIT.STOP_AFTER_CONSUME)
    expect(t.out.find((l) => l.startsWith('STOP'))).toMatch(/the restart is not proven: \(a\) InvocationID unchanged.*dist\.prev holds the old build/)
  })

  it('systemctl restart fails', async () => {
    const t = context({ sys: { restartExit: 1 } })
    const id = await requested(t)
    expect(await apply(t.ctx, { approvalId: id, sha: TO })).toBe(EXIT.STOP_AFTER_CONSUME)
    expect(t.out.find((l) => l.startsWith('STOP'))).toMatch(/systemctl restart mainagent-dashboard\.service failed \(exit 1\)/)
  })
})

describe('status', () => {
  it('prints the state and the end of its log; without a state, says so', async () => {
    const t0 = context()
    expect(status(t0.ctx)).toBe(EXIT.OK)
    expect(t0.out).toEqual(['no deploy state'])
    const t = context()
    const id = await requested(t)
    await apply(t.ctx, { approvalId: id, sha: TO })
    const t2 = context()
    expect(status(t2.ctx)).toBe(EXIT.OK)
    expect(t2.out[0]).toContain('"step": "done"')
    expect(t2.out[1]).toMatch(/deployed /)
  })
})
