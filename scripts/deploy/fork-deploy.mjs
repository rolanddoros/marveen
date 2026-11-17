#!/usr/bin/env node
// The fork deploy helper (fork deploy-gate plan v3 point 6, addendum A1-2/A1-3/A1-4, Ron 17165 C1/C4).
//
//   node /root/marveen/scripts/deploy/fork-deploy.mjs request
//   node /root/marveen/scripts/deploy/fork-deploy.mjs apply --approval <id> --sha <40hex>
//   node /root/marveen/scripts/deploy/fork-deploy.mjs status
//
// request  FROM = the install's HEAD, TO = the fork tip; writes the request log, files a code_deploy approval with
//          the owner text (deploy-describe.mjs) and tells whether the owner was notified (exit 3 when not).
// apply    re-derives everything from git, checks the approval field by field, consumes it right before the first
//          irreversible step, merges to the approved object id, builds into dist.next and swaps it in, restarts
//          the dashboard and proves the new process serves (restart-proof.mjs).
// status   the state file and the end of the last log; read-only.
//
// The db-write gate lets exactly these three shapes through, and only from the main agent (scripts/hooks/
// agent-identity.mjs). That check is an accident brake, not a boundary: the deploy's safety is the approved
// FROM..TO (content_hash + the byte-compared owner text) and where the approval came from (resolved_by).
import { openSync, writeSync, closeSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitRunner, preconditionFailures, fetchForkTip, isAncestor, mergeToApproved, OID_RE } from './deploy-git.mjs'
import { collect, ownerDescription, contentHash, LOG_PATH_RE, fullRender } from './deploy-describe.mjs'
import { detectScope, snapshot, scopeArgs, logSize, waitForStart } from './restart-proof.mjs'
import { sameDescription, approvalFailures, envValue, dashboardClient, pollOwnerNotified, consumeApproval, DESCRIPTION_CAP } from '../hooks/owner-approval.mjs'

export const REPO_URL = 'https://github.com/rolanddoros/marveen.git'
export const BRANCH = 'main'
export const CATEGORY = 'code_deploy'
export const CONSUMER = 'fork-deploy'
export const MAX_AGE_SECONDS = 1800
export const REQUEST_TIMEOUT_SECONDS = 3600
/**
 * SEC-5: only an approval whose resolved_by the server itself wrote (owner_session:, slack_reaction:) may deploy;
 * a born-approved `telegram_text` row is refused. The default is Roland's decision (plan v3 point 11); until he
 * decides, the fail-closed side. src/web/routes/approvals.ts carries the same value (pinned equal by a test).
 */
export const CODE_DEPLOY_OWNER_CHANNEL_ONLY = true
export const APPROVAL_ID_RE = /^[A-Za-z0-9-]{1,64}$/
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,49}$/

export const EXIT = Object.freeze({ OK: 0, STOP: 1, USAGE: 2, NOT_NOTIFIED: 3, STOP_AFTER_CONSUME: 4 })

const HERE = dirname(fileURLToPath(import.meta.url))
/** <install>/scripts/deploy -> <install>, lexically (the gate matches the literal path). */
export const INSTALL_ROOT = resolve(HERE, '..', '..')

class Stop extends Error {
  constructor(message, { consumed = false } = {}) {
    super(message)
    this.consumed = consumed
  }
}

function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/** Field 22 of /proc/<pid>/stat (start time in clock ticks), or null. The comm field may hold spaces and ')'. */
export function procStarttime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return rest[19] ?? null
  } catch {
    return null
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

/**
 * store/deploy.lock with O_EXCL; content pid + start time. A lock whose pid is gone, or whose pid now belongs to a
 * process with another start time, is stale and taken over (and said so). A live lock stops.
 */
export function takeLock(file, { pid = process.pid, starttime = procStarttime, alive = pidAlive, log = () => {} } = {}) {
  const mine = JSON.stringify({ pid, starttime: starttime(pid) })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const fd = openSync(file, 'wx', 0o600)
      writeSync(fd, mine)
      closeSync(fd)
      return mine
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e
    }
    let held = null
    try {
      held = JSON.parse(readFileSync(file, 'utf8'))
    } catch { /* unreadable: stale */ }
    if (held && Number.isSafeInteger(held.pid) && alive(held.pid) && starttime(held.pid) === held.starttime) {
      throw new Stop(`another deploy holds ${file} (pid ${held.pid})`)
    }
    log(`stale lock taken over: ${held ? `pid ${held.pid}` : 'unreadable'}`)
    rmSync(file, { force: true })
  }
  throw new Stop(`could not take ${file}`)
}

function releaseLock(file, mine) {
  try {
    if (readFileSync(file, 'utf8') === mine) rmSync(file, { force: true })
  } catch { /* already gone */ }
}

/** The approval's machine payload, as `request` filed it; every field checked. */
export function parsePayload(text, sha) {
  let p
  try {
    p = JSON.parse(text)
  } catch {
    throw new Stop('the approval has no valid JSON payload')
  }
  const out = []
  if (!p || typeof p !== 'object') throw new Stop('the approval payload is not an object')
  if (p.repo !== REPO_URL) out.push(`payload repo ${JSON.stringify(p.repo)}`)
  if (p.branch !== BRANCH) out.push(`payload branch ${JSON.stringify(p.branch)}`)
  if (!OID_RE.test(p.from ?? '')) out.push('payload FROM is not a 40-hex object id')
  if (!OID_RE.test(p.to ?? '')) out.push('payload TO is not a 40-hex object id')
  if (p.to !== sha) out.push(`--sha ${sha} is not the approved TO ${p.to}`)
  if (!LOG_PATH_RE.test(p.logPath ?? '')) out.push('payload request log path is not store/deploy-logs/request-<UTC>.log')
  if (out.length) throw new Stop(out.join('; '))
  return p
}

/** The unit and the main agent id from <install>/.env, like scripts/stop.sh, but with no "marveen" fallback. */
export function installIdentity(root) {
  const main = envValue(root, 'MAIN_AGENT_ID')
  if (!main || !SLUG_RE.test(main)) throw new Stop(`MAIN_AGENT_ID in ${join(root, '.env')} is missing or not a slug`)
  return { mainAgentId: main, unit: `${main}-dashboard.service`, provider: envValue(root, 'CHANNEL_PROVIDER') ?? '' }
}

function defaultBuild(root) {
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: false, timeout: 20 * 60_000 })
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status}): ${String(r.stderr).trim().slice(-400)}`)
  }
  return {
    npmCi: () => run('npm', ['ci', '--no-audit', '--no-fund']),
    compile: () => {
      run(process.execPath, ['scripts/clean-dist-tests.cjs', 'dist.next'])
      run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json', '--outDir', 'dist.next'])
      run(process.execPath, ['scripts/write-built-commit.cjs', 'dist.next'])
    },
    tarDist: (dest) => run('tar', ['-czf', dest, '-C', root, 'dist']),
  }
}

function defaultSystemctl(args) {
  const r = spawnSync('systemctl', args, { encoding: 'utf8', shell: false, timeout: 60_000 })
  return { status: r.status, stdout: r.stdout ?? '' }
}

/** Everything apply/request/status touch outside their own logic; tests replace any of it. */
export function defaultContext(root = INSTALL_ROOT) {
  return {
    root,
    git: gitRunner(root),
    systemctl: defaultSystemctl,
    client: dashboardClient(root),
    build: defaultBuild(root),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    out: (line) => process.stdout.write(line + '\n'),
    ignoreHangup: () => process.on('SIGHUP', () => {}),
    lockOpts: {},
    pollOpts: {},
    startOpts: {},
  }
}

function paths(root) {
  const store = join(root, 'store')
  return {
    lock: join(store, 'deploy.lock'),
    state: join(store, 'deploy-state.json'),
    logs: join(store, 'deploy-logs'),
    backups: join(store, 'deploy-backups'),
    dashboardLog: join(store, 'dashboard.log'),
  }
}

/**
 * apply: returns an EXIT code; every line it prints also goes to store/deploy-logs/<UTC>.log.
 */
export async function apply(ctx, { approvalId, sha }) {
  if (!APPROVAL_ID_RE.test(approvalId ?? '') || !OID_RE.test(sha ?? '')) {
    ctx.out('usage: fork-deploy.mjs apply --approval <id> --sha <40hex>')
    return EXIT.USAGE
  }
  const P = paths(ctx.root)
  const started = ctx.now()
  const logPath = join(P.logs, `${utcStamp(started)}.log`)
  mkdirSync(P.logs, { recursive: true })
  const say = (line) => {
    ctx.out(line)
    try {
      appendFileSync(logPath, `${new Date(ctx.now()).toISOString()} ${line}\n`)
    } catch { /* the console still has it */ }
  }
  let state = { approvalId, to: sha, step: 'start', logPath }
  const setState = (step, extra = {}) => {
    state = { ...state, ...extra, step, ts: ctx.now() }
    atomicWrite(P.state, JSON.stringify(state, null, 2) + '\n')
    say(`step: ${step}`)
  }
  let mine
  try {
    mine = takeLock(P.lock, { ...ctx.lockOpts, log: say })
  } catch (e) {
    say(`STOP: ${e.message}`)
    return EXIT.STOP
  }
  let consumed = false
  try {
    // 2. Preconditions, read-only.
    const id = installIdentity(ctx.root)
    const got = await ctx.client.get(`/api/approvals/${encodeURIComponent(approvalId)}`)
    if (got.status !== 200 || !got.data) throw new Stop(`the dashboard did not return approval ${approvalId} (HTTP ${got.status})`)
    const row = got.data
    const p = parsePayload(row.action_payload, sha)
    setState('preconditions', { from: p.from })
    const pre = preconditionFailures(ctx.git, { from: p.from, forkUrl: REPO_URL, branch: BRANCH })
    if (pre.length) throw new Stop(pre.join('; '))
    const scope = detectScope(ctx.systemctl, id.unit)
    if (!scope) throw new Stop(`no system or user unit ${id.unit}`)
    snapshot(ctx.systemctl, scope, id.unit) // A1-2: a missing InvocationID stops HERE, before anything changes
    // 3. The fork tip, from the fetch's own line.
    const tip = fetchForkTip(ctx.git, BRANCH)
    if (tip !== p.to) throw new Stop(`the fork tip is ${tip}, not the approved TO ${p.to}`)
    // 4. Fast-forward only.
    if (!isAncestor(ctx.git, p.from, p.to)) throw new Stop(`FROM ${p.from} is not an ancestor of TO ${p.to}`)
    // 5. The owner text, re-rendered from git, byte for byte (trimmed), and every field of the row.
    const c = collect(ctx.git, p.from, p.to)
    const rendered = ownerDescription(c, { repo: REPO_URL, branch: BRANCH, logPath: p.logPath })
    if (!sameDescription(row.action_description, rendered)) throw new Stop('the approved text differs from the text re-rendered from git for FROM..TO')
    const hash = contentHash({ repo: REPO_URL, branch: BRANCH, from: p.from, to: p.to })
    const fails = approvalFailures(row, { category: CATEGORY, mainAgentId: id.mainAgentId, contentHash: hash, requireOwnerChannel: ctx.ownerChannelOnly ?? CODE_DEPLOY_OWNER_CHANNEL_ONLY })
    if (fails.length) throw new Stop(fails.join('; '))
    say(`resolved_by: ${row.resolved_by}`)
    // 7. Restore points: a tag on FROM and the current dist.
    setState('backup')
    const tag = `deploy/pre-${utcStamp(started)}`
    ctx.git(['tag', tag, p.from])
    const tar = join(P.backups, `dist-${utcStamp(started)}.tar.gz`)
    mkdirSync(P.backups, { recursive: true })
    if (existsSync(join(ctx.root, 'dist'))) ctx.build.tarDist(tar)
    setState('consuming', { tag, tar })
    // 8. The one-shot consume, right before the first irreversible step.
    const cons = await consumeApproval(ctx.client, approvalId, { category: CATEGORY, contentHash: hash, consumer: CONSUMER, ref: p.to, maxAgeSeconds: MAX_AGE_SECONDS })
    if (cons.status !== 200) throw new Stop(`consume answered HTTP ${cons.status}: the tree is untouched`)
    consumed = true
    // 9. From here on a closed terminal does not stop the deploy halfway.
    ctx.ignoreHangup()
    // 10. Merge to the approved object id.
    setState('merging')
    const mf = mergeToApproved(ctx.git, p.to)
    if (mf.length) throw new Stop(`${mf.join('; ')}. The approval is consumed, the tree is at TO but differs from the commit.`, { consumed })
    // 11. Build into dist.next, swap only on success.
    setState('building', { npmCi: c.npmCi })
    const next = join(ctx.root, 'dist.next')
    rmSync(next, { recursive: true, force: true })
    try {
      if (c.npmCi) ctx.build.npmCi()
      ctx.build.compile()
      const stamp = readFileSync(join(next, '.built-commit'), 'utf8').trim()
      if (stamp !== p.to) throw new Error(`dist.next/.built-commit is ${stamp}, not TO ${p.to}`)
    } catch (e) {
      rmSync(next, { recursive: true, force: true })
      throw new Stop(`build failed (${e.message}). The tree is at TO, dist is the old one, the app runs the old code; recovery: docs/db-write-gate.md`, { consumed })
    }
    const prev = join(ctx.root, 'dist.prev')
    rmSync(prev, { recursive: true, force: true })
    if (existsSync(join(ctx.root, 'dist'))) renameSync(join(ctx.root, 'dist'), prev)
    renameSync(next, join(ctx.root, 'dist'))
    // 12. Restart, with the before-picture of the process.
    setState('restarting', { scope })
    const t0 = ctx.now()
    const before = snapshot(ctx.systemctl, scope, id.unit)
    const off0 = logSize(P.dashboardLog)
    const rs = ctx.systemctl([...scopeArgs(scope), 'restart', id.unit])
    if (rs.status !== 0) throw new Stop(`systemctl restart ${id.unit} failed (exit ${rs.status}); dist.prev holds the old build; recovery: docs/db-write-gate.md`, { consumed })
    // 13. A new process, its start line, then the API.
    const proof = await waitForStart({ run: ctx.systemctl, scope, unit: id.unit, before, logFile: P.dashboardLog, off0, t0, apiGet: () => ctx.client.get(`/api/approvals/${encodeURIComponent(approvalId)}`), now: ctx.now, sleep: ctx.sleep, ...ctx.startOpts })
    if (!proof.ok) throw new Stop(`the restart is not proven: ${proof.failed}; dist.prev holds the old build; recovery: docs/db-write-gate.md`, { consumed })
    // 14. Done.
    setState('done', { pid: proof.after.pid })
    say(`deployed ${p.from}..${p.to}: ${c.commits.length} commit(s), ${c.packages.added.length + c.packages.changed.length + c.packages.removed.length} package change(s), npm ci ${c.npmCi ? 'yes' : 'no'}, tag ${tag}, pid ${proof.after.pid}, ${Math.round((ctx.now() - started) / 1000)} s`)
    return EXIT.OK
  } catch (e) {
    const wasConsumed = consumed || e?.consumed
    say(`STOP${wasConsumed ? ' (approval consumed)' : ' (approval NOT consumed)'}: ${e?.message ?? e}`)
    try {
      setState(wasConsumed ? 'stopped-after-consume' : 'stopped', { error: String(e?.message ?? e) })
    } catch { /* the log has it */ }
    return wasConsumed ? EXIT.STOP_AFTER_CONSUME : EXIT.STOP
  } finally {
    releaseLock(P.lock, mine)
  }
}

/** request: files the approval; exit 3 when the owner's notification is not proven. */
export async function request(ctx) {
  try {
    const id = installIdentity(ctx.root)
    const from = ctx.git(['rev-parse', 'HEAD']).trim()
    const pre = preconditionFailures(ctx.git, { from, forkUrl: REPO_URL, branch: BRANCH })
    if (pre.length) throw new Stop(pre.join('; '))
    const to = fetchForkTip(ctx.git, BRANCH)
    if (to === from) {
      ctx.out(`nothing to deploy: the install is at the fork tip ${to}`)
      return EXIT.OK
    }
    if (!isAncestor(ctx.git, from, to)) throw new Stop(`HEAD ${from} is not an ancestor of the fork tip ${to}`)
    const c = collect(ctx.git, from, to)
    const logRel = `store/deploy-logs/request-${utcStamp(ctx.now())}.log`
    atomicWrite(join(ctx.root, logRel), fullRender(c) + '\n')
    const description = ownerDescription(c, { repo: REPO_URL, branch: BRANCH, logPath: logRel })
    const hash = contentHash({ repo: REPO_URL, branch: BRANCH, from, to })
    const posted = await ctx.client.post('/api/approvals', {
      agent_id: id.mainAgentId,
      category: CATEGORY,
      action_description: description,
      action_payload: JSON.stringify({ repo: REPO_URL, branch: BRANCH, from, to, logPath: logRel }),
      content_hash: hash,
      timeout_seconds: REQUEST_TIMEOUT_SECONDS,
    })
    if (posted.status !== 201 || !posted.data?.id) throw new Stop(`POST /api/approvals answered HTTP ${posted.status}`)
    const n = await pollOwnerNotified(ctx.client, posted.data.id, id.provider, { sleep: ctx.sleep, ...ctx.pollOpts })
    ctx.out(`approval: ${posted.data.id}`)
    ctx.out(`FROM ${from}`)
    ctx.out(`TO ${to}`)
    ctx.out(`description: ${description.length}/${DESCRIPTION_CAP} chars`)
    ctx.out(`request log: ${logRel}`)
    ctx.out(`owner notified: ${n.notified} (${n.why})`)
    ctx.out(`after the owner approves: node ${join(INSTALL_ROOT, 'scripts', 'deploy', 'fork-deploy.mjs')} apply --approval ${posted.data.id} --sha ${to}`)
    return n.notified === 'yes' ? EXIT.OK : EXIT.NOT_NOTIFIED
  } catch (e) {
    ctx.out(`STOP: ${e?.message ?? e}`)
    return EXIT.STOP
  }
}

/** status: the state file and the last lines of its log. Read-only. */
export function status(ctx) {
  const P = paths(ctx.root)
  let s
  try {
    s = JSON.parse(readFileSync(P.state, 'utf8'))
  } catch {
    ctx.out('no deploy state')
    return EXIT.OK
  }
  ctx.out(JSON.stringify(s, null, 2))
  if (typeof s.logPath === 'string' && s.logPath.startsWith(P.logs + '/')) {
    try {
      const lines = readFileSync(s.logPath, 'utf8').trimEnd().split('\n')
      ctx.out(lines.slice(-20).join('\n'))
    } catch { /* no log */ }
  }
  return EXIT.OK
}

/** argv -> mode; exactly the three shapes the gate allows, nothing else. */
export function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === 'request' || argv[0] === 'status')) return { mode: argv[0] }
  if (argv.length === 5 && argv[0] === 'apply' && argv[1] === '--approval' && APPROVAL_ID_RE.test(argv[2]) && argv[3] === '--sha' && OID_RE.test(argv[4])) {
    return { mode: 'apply', approvalId: argv[2], sha: argv[4] }
  }
  return null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const ctx = defaultContext()
  if (!args) {
    ctx.out('usage: fork-deploy.mjs request | status | apply --approval <id> --sha <40hex>')
    process.exit(EXIT.USAGE)
  }
  const code = args.mode === 'apply' ? await apply(ctx, args) : args.mode === 'request' ? await request(ctx) : status(ctx)
  process.exit(code)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
