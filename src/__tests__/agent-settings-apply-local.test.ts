// scripts/agent-settings/apply-local.mjs: request / baseline / rebaseline / apply / resume / status end to end (Fork C
// settings-protect plan v2 point 6, plan addendum 1 K2-K5, Ron 17402 K4). A throwaway install under its own temp
// dir, a stub dashboard in memory, a stub switch tuple (the dashboard's readers are tested where they live), the
// repository's own lock. Every STOP before the consume must leave the approval unconsumed and the disk untouched.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-expect-error -- plain .mjs script, no types
import { apply, request, resume, status, parseArgs, collect, contentHash, ownerDescription, fullRender, writeAtomicNoFollow, EXIT, CATEGORY, CONSUMER, MAX_AGE_SECONDS, BATCH_FORMAT, STATE_REL, RESUME_MAX_AGE_SECONDS, CODE_DEPLOY_OWNER_CHANNEL_ONLY } from '../../scripts/agent-settings/apply-local.mjs'
// @ts-expect-error -- plain .mjs hook module, no types
import { CODE_DEPLOY_OWNER_CHANNEL_ONLY as DEPLOY_SWITCH } from '../../scripts/deploy/fork-deploy.mjs'
// @ts-expect-error -- plain .mjs hook module, no types
import { agentDirRows, ownerCredentialRows, localRecord, BASELINE_FORMAT } from '../../scripts/hooks/agent-settings-baseline.mjs'
// @ts-expect-error -- plain .mjs hook module, no types
import { DESCRIPTION_CAP } from '../../scripts/hooks/owner-approval.mjs'
import { buildOwnerApprovalText } from '../web/routes/approvals.js'
import type { Approval } from '../db.js'

const MAIN = 'mainagent'
const T0 = Date.UTC(2026, 10, 17, 22, 0, 0)
const NODE = '/usr/local/bin/node'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const tuple = (over: Record<string, unknown> = {}) => ({
  profileId: 'default', profile: { destructiveGate: false, credentialGate: false, secondReviewer: false },
  threadReply: false, browser: false, heartbeat: false, senderRolePolicySha256: null, nodeBin: NODE, ...over,
})

let base: string
let inst: string
let home: string
let lines: string[]
let tuples: Record<string, Record<string, unknown>>
let clock: number

type Row = Record<string, unknown> & { id: string; status: string }
function dashboard(opts: { consumeStatus?: number; onConsume?: () => void } = {}) {
  const rows = new Map<string, Row>()
  const consumes: { id: string; body: Record<string, unknown> }[] = []
  const posts: Record<string, unknown>[] = []
  let n = 0
  const client = {
    get: async (path: string) => {
      const row = rows.get(decodeURIComponent(path.split('/').pop() ?? ''))
      return row ? { status: 200, data: { ...row } } : { status: 404, data: null }
    },
    post: async (path: string, body: Record<string, unknown>) => {
      if (path === '/api/approvals') {
        posts.push(body)
        const id = `appr-${++n}`
        rows.set(id, { id, ...body, action_description: String(body.action_description).trim(), status: 'pending', telegram_message_id: 4242, resolved_by: null, consumed_at: null, consumed_by: null, consumed_ref: null })
        return { status: 201, data: rows.get(id) }
      }
      const m = /^\/api\/approvals\/([^/]+)\/consume$/.exec(path)
      if (m) {
        const id = decodeURIComponent(m[1])
        consumes.push({ id, body })
        opts.onConsume?.()
        const st = opts.consumeStatus ?? 200
        if (st === 200) Object.assign(rows.get(id)!, { consumed_at: Math.floor(clock / 1000), consumed_by: body.consumer, consumed_ref: body.ref })
        return { status: st, data: {} }
      }
      return { status: 404, data: null }
    },
  }
  return { client, rows, consumes, posts }
}

type Dash = ReturnType<typeof dashboard>
const ctxOf = (d: Dash, over: Record<string, unknown> = {}) => ({
  root: inst,
  home,
  client: d.client,
  tupleOf: async (a: string) => tuples[a] ?? tuple({ heartbeat: a === 'heartbeat' }),
  tupleCheck: { fs: { realpathSync: (p: string) => p, lstatSync: () => ({ mode: 0o40755 }) } },
  now: () => clock,
  sleep: async () => {},
  out: (l: string) => { lines.push(l) },
  ignoreHangup: () => {},
  lockOpts: {},
  pollOpts: { tries: 1 },
  ...over,
})
const approve = (d: Dash, id: string, over: Record<string, unknown> = {}) => Object.assign(d.rows.get(id)!, { status: 'approved', resolved_by: 'owner_session:roland', ...over })
const localPath = (a: string) => join(inst, 'agents', a, '.claude', 'settings.local.json')
const writeLocal = (a: string, o: unknown) => { const t = `${JSON.stringify(o, null, 2)}\n`; writeFileSync(localPath(a), t); return t }
const readBaseline = () => JSON.parse(readFileSync(join(inst, 'store', 'agent-settings-baseline.json'), 'utf-8'))
const stage = (id: string, files: { agent: string; content: string }[], isolated = ['sally']) => {
  mkdirSync(join(inst, 'store', 'agent-settings-staging'), { recursive: true })
  writeFileSync(join(inst, 'store', 'agent-settings-staging', `${id}.json`), JSON.stringify({ format: BATCH_FORMAT, isolated, files }))
}
/** Today's correct deny rows for each agent of the set, as the live files carry them. */
const rowsFor = (a: string, all: string[], isolated = ['sally']) => (isolated.includes(a)
  ? [...all.filter((m) => m !== a).flatMap((m) => agentDirRows(inst, m)), ...ownerCredentialRows(inst, home)]
  : isolated.filter((s) => s !== a).flatMap((s) => agentDirRows(inst, s)))
const AGENTS = ['alpha', 'beta', 'sally']

async function enrolAll(d: Dash) {
  expect(await request(ctxOf(d), { kind: 'baseline', isolated: ['sally'] })).toBe(EXIT.OK)
  const id = [...d.rows.keys()].pop()!
  approve(d, id)
  expect(await apply(ctxOf(d), { approvalId: id })).toBe(EXIT.OK)
  return id
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-settings-apply-')))
  inst = join(base, 'inst')
  home = join(base, 'home')
  mkdirSync(home)
  mkdirSync(inst, { recursive: true })
  writeFileSync(join(inst, '.env'), `MAIN_AGENT_ID=${MAIN}\nCHANNEL_PROVIDER=telegram\n`)
  mkdirSync(join(inst, 'agents', MAIN, '.claude'), { recursive: true })
  for (const a of AGENTS) {
    mkdirSync(join(inst, 'agents', a, '.claude'), { recursive: true })
    writeLocal(a, { permissions: { deny: rowsFor(a, AGENTS) } })
  }
  lines = []
  tuples = {}
  clock = T0
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('parseArgs: exactly the six shapes the gate allows', () => {
  it('accepts each shape and nothing else', () => {
    expect(parseArgs(['request', '--batch', 'b-1'])).toEqual({ mode: 'request', spec: { kind: 'batch', batchId: 'b-1' } })
    expect(parseArgs(['baseline', '--isolated', 'sally,kevin'])).toEqual({ mode: 'request', spec: { kind: 'baseline', isolated: ['kevin', 'sally'] } })
    expect(parseArgs(['baseline', '--isolated', 'none'])).toEqual({ mode: 'request', spec: { kind: 'baseline', isolated: [] } })
    expect(parseArgs(['rebaseline', '--agent', 'sally'])).toEqual({ mode: 'request', spec: { kind: 'rebaseline', agent: 'sally' } })
    expect(parseArgs(['apply', '--approval', 'a-1'])).toEqual({ mode: 'apply', approvalId: 'a-1' })
    expect(parseArgs(['resume'])).toEqual({ mode: 'resume' })
    expect(parseArgs(['status'])).toEqual({ mode: 'status' })
    for (const bad of [[], ['request'], ['request', '--batch', '../x'], ['request', '--batch', 'b', 'x'], ['baseline', '--isolated', 'a,,b'],
      ['baseline'], ['rebaseline', '--agent', '../x'], ['apply', '--approval', 'a b'], ['resume', 'x'], ['status', '--json'], ['apply', '--sha', 'a']]) {
      expect(parseArgs(bad)).toBeNull()
    }
  })
  it('SEC-5: the owner-channel switch is the deploy helper\'s one value', () => {
    expect(CODE_DEPLOY_OWNER_CHANNEL_ONLY).toBe(DEPLOY_SWITCH)
    expect(CATEGORY).toBe('agent_settings')
  })
})

describe('baseline: the first one, one approval for every sub-agent', () => {
  it('files one approval over every sub-agent but the main agent, writes only the baseline', async () => {
    const d = dashboard()
    const before = Object.fromEntries(AGENTS.map((a) => [a, readFileSync(localPath(a), 'utf-8')]))
    await enrolAll(d)
    const b = readBaseline()
    expect(b.format).toBe(BASELINE_FORMAT)
    expect(b.isolated).toEqual(['sally'])
    expect(Object.keys(b.agents).sort()).toEqual(AGENTS)
    for (const a of AGENTS) {
      expect(readFileSync(localPath(a), 'utf-8')).toBe(before[a])
      expect(b.agents[a].local).toEqual(localRecord(before[a]))
      expect(b.agents[a].switches).toEqual(tuple())
    }
    expect(d.posts).toHaveLength(1)
    expect(d.posts[0]).toMatchObject({ agent_id: MAIN, category: CATEGORY })
    expect(String(d.posts[0].action_description)).toContain('első baseline, 3 ágens')
    expect(String(d.posts[0].action_description)).not.toContain('SÉRÜL')
    expect(d.consumes[0].body).toMatchObject({ category: CATEGORY, consumer: CONSUMER, max_age_seconds: MAX_AGE_SECONDS })
  })
  it('an isolated agent missing its rows shows SÉRÜL in the text, it is not silently sanctified', async () => {
    writeLocal('alpha', { permissions: { deny: agentDirRows(inst, 'sally').slice(1) } })
    const d = dashboard()
    expect(await request(ctxOf(d), { kind: 'baseline', isolated: ['sally'] })).toBe(EXIT.OK)
    expect(String(d.posts[0].action_description)).toContain('SÉRÜL: alpha: 1 deny-sor hiányzik (sally elkülönítése)')
  })
  it('a second baseline is refused: changes go through request or rebaseline', async () => {
    const d = dashboard()
    await enrolAll(d)
    expect(await request(ctxOf(d), { kind: 'baseline', isolated: ['sally'] })).toBe(EXIT.STOP)
    expect(lines.pop()).toContain('exists: change it with request or rebaseline')
  })
})

describe('request: validated before any approval exists', () => {
  it('a value outside the rules, the main agent\'s file or a linked target: refused, no approval, every reason listed', async () => {
    const d = dashboard()
    await enrolAll(d)
    const posts = d.posts.length
    stage('bad', [
      { agent: 'alpha', content: JSON.stringify({ env: { NODE_OPTIONS: '--require /x' }, permissions: { allow: ['Bash(*)'] } }) },
      { agent: MAIN, content: '{}' },
    ])
    expect(await request(ctxOf(d), { kind: 'batch', batchId: 'bad' })).toBe(EXIT.STOP)
    const out = lines.pop()!
    expect(out).toContain('refused, no approval filed')
    expect(out).toContain('alpha: env.NODE_OPTIONS: not an allowed name')
    expect(out).toContain('alpha: permissions.allow: not allowed in agent-local')
    expect(out).toContain(`${MAIN}: the main agent's file is not the helper's`)
    rmSync(localPath('beta'))
    symlinkSync(join(base, 'elsewhere.json'), localPath('beta'))
    stage('link', [{ agent: 'beta', content: '{}' }])
    expect(await request(ctxOf(d), { kind: 'batch', batchId: 'link' })).toBe(EXIT.STOP)
    expect(lines.pop()).toContain('agents/beta/.claude/settings.local.json is not a regular file')
    expect(d.posts.length).toBe(posts)
  })
  it('a switch tuple the lock cannot render is refused (N2-4, no default fallback)', async () => {
    const d = dashboard()
    await enrolAll(d)
    tuples.alpha = tuple({ profileId: 'Not A Profile' })
    expect(await request(ctxOf(d), { kind: 'rebaseline', agent: 'alpha' })).toBe(EXIT.STOP)
    expect(lines.pop()).toContain('alpha: switches: profileId: not a plain profile id')
    tuples.alpha = tuple({ heartbeat: true })
    expect(await request(ctxOf(d), { kind: 'rebaseline', agent: 'alpha' })).toBe(EXIT.STOP)
    expect(lines.pop()).toContain('heartbeat: does not follow the agent name')
  })
  it('the GH_CONFIG_DIR value is in the text verbatim; no value hash anywhere (plan v2 6)', async () => {
    const d = dashboard()
    await enrolAll(d)
    const gh = join(inst, 'agents', 'alpha', '.config', 'gh')
    mkdirSync(gh, { recursive: true })
    stage('gh', [{ agent: 'alpha', content: `${JSON.stringify({ env: { GH_CONFIG_DIR: gh }, permissions: { deny: rowsFor('alpha', AGENTS) } })}\n` }])
    expect(await request(ctxOf(d), { kind: 'batch', batchId: 'gh' })).toBe(EXIT.OK)
    const text = String(d.posts.at(-1)!.action_description)
    expect(text).toContain('alpha: env: GH_CONFIG_DIR=<saját .config/gh>;')
    expect(text).not.toContain('ENV:')
    const log = readFileSync(join(inst, JSON.parse(String(d.posts.at(-1)!.action_payload)).logPath), 'utf-8')
    for (const s of [text, log]) {
      expect(s).not.toContain(sha(gh).slice(0, 8))
      expect(s).not.toContain(sha(`"${gh}"`).slice(0, 8))
    }
  })
})

describe('apply: the batch end to end', () => {
  it('writes the approved bytes, then the baseline; the text names removed rows in the never-cut head', async () => {
    const d = dashboard()
    await enrolAll(d)
    const next = `${JSON.stringify({ claudeMdExcludes: ['x'], permissions: { deny: [...rowsFor('alpha', AGENTS).slice(1), 'Read(//etc/**)'] } })}\n`
    stage('b1', [{ agent: 'alpha', content: next }])
    expect(await request(ctxOf(d), { kind: 'batch', batchId: 'b1' })).toBe(EXIT.OK)
    const id = [...d.rows.keys()].pop()!
    const text = String(d.rows.get(id)!.action_description)
    expect(text).toContain(`ELTÁVOLÍTVA: alpha: ${agentDirRows(inst, 'sally')[0]}`)
    expect(text).toContain('SÉRÜL: alpha: 1 deny-sor hiányzik (sally elkülönítése)')
    expect(text).toContain('alpha: Read(//etc/**)')
    expect(text).toContain(`content_hash ${d.rows.get(id)!.content_hash}`)
    approve(d, id)
    expect(await apply(ctxOf(d), { approvalId: id })).toBe(EXIT.OK)
    expect(readFileSync(localPath('alpha'), 'utf-8')).toBe(next)
    expect(readBaseline().agents.alpha.local).toEqual(localRecord(next))
    expect(readBaseline().agents.beta.local).toEqual(localRecord(readFileSync(localPath('beta'), 'utf-8')))
    expect(JSON.parse(readFileSync(join(inst, STATE_REL), 'utf-8'))).toMatchObject({ step: 'done', approvalId: id, files: { alpha: sha(next) } })
  })
  it('K5 (g): a new agent in a batch that forgets the isolated agent\'s side: SÉRÜL for the isolated agent, though it is not in the batch', async () => {
    // sally's baselined file already lacks alpha's rows: the set is every baseline agent, not only the batch's
    writeLocal('sally', { permissions: { deny: rowsFor('sally', AGENTS).filter((r) => !r.includes('agents/alpha')) } })
    const d = dashboard()
    await enrolAll(d)
    mkdirSync(join(inst, 'agents', 'gamma', '.claude'), { recursive: true })
    stage('new', [{ agent: 'gamma', content: `${JSON.stringify({ permissions: { deny: agentDirRows(inst, 'sally') } })}\n` }])
    expect(await request(ctxOf(d), { kind: 'batch', batchId: 'new' })).toBe(EXIT.OK)
    const text = String(d.posts.at(-1)!.action_description)
    expect(text).toContain('SÉRÜL: sally: 8 deny-sor hiányzik (sally elkülönítése)')
    expect(text).not.toContain('SÉRÜL: gamma')
    // with sally's four new rows in the same batch: no SÉRÜL
    stage('new2', [
      { agent: 'gamma', content: `${JSON.stringify({ permissions: { deny: agentDirRows(inst, 'sally') } })}\n` },
      { agent: 'sally', content: `${JSON.stringify({ permissions: { deny: [...rowsFor('sally', AGENTS), ...agentDirRows(inst, 'gamma')] } })}\n` },
    ])
    expect(await request(ctxOf(d), { kind: 'batch', batchId: 'new2' })).toBe(EXIT.OK)
    expect(String(d.posts.at(-1)!.action_description)).not.toContain('SÉRÜL')
  })
  it('a batch that changes the isolated list says so, and the hash binds it', async () => {
    const d = dashboard()
    await enrolAll(d)
    const content = readFileSync(localPath('beta'), 'utf-8')
    stage('i1', [{ agent: 'beta', content }], ['sally'])
    stage('i2', [{ agent: 'beta', content }], ['beta', 'sally'])
    const c1 = await collect(ctxOf(d), { kind: 'batch', batchId: 'i1' })
    const c2 = await collect(ctxOf(d), { kind: 'batch', batchId: 'i2' })
    expect(c1.contentHash).not.toBe(c2.contentHash)
    expect(ownerDescription(c2, 'store/agent-settings-logs/request-20261117T220000Z-0000abcd.log')).toContain('Elkülönített ágensek: beta, sally (VÁLTOZIK, eddig: sally)')
  })
  it('any other GH_CONFIG_DIR value goes verbatim into a never-cut ENV line, however long the path', async () => {
    const d = dashboard()
    await enrolAll(d)
    const gh = join(inst, 'agents', 'alpha', 'a-rather-long-directory-name-that-a-row-cut-would-hide', '.config', 'gh')
    mkdirSync(gh, { recursive: true })
    stage('gh2', [{ agent: 'alpha', content: `${JSON.stringify({ env: { GH_CONFIG_DIR: gh }, permissions: { deny: rowsFor('alpha', AGENTS) } })}\n` }])
    expect(await request(ctxOf(d), { kind: 'batch', batchId: 'gh2' })).toBe(EXIT.OK)
    const text = String(d.posts.at(-1)!.action_description)
    expect(text).toContain(`\nENV: alpha: GH_CONFIG_DIR=${gh}\n`)
    expect(text).toContain('alpha: env: GH_CONFIG_DIR=<lásd ENV>;')
  })
  it('two batches with the same text but different bytes: the hash differs, STOP before the consume', async () => {
    const d = dashboard()
    await enrolAll(d)
    const obj = { claudeMdExcludes: ['x'], permissions: { deny: rowsFor('alpha', AGENTS) } }
    stage('b2', [{ agent: 'alpha', content: JSON.stringify(obj) }])
    expect(await request(ctxOf(d), { kind: 'batch', batchId: 'b2' })).toBe(EXIT.OK)
    const id = [...d.rows.keys()].pop()!
    approve(d, id)
    const before = readFileSync(localPath('alpha'), 'utf-8')
    stage('b2', [{ agent: 'alpha', content: JSON.stringify(obj, null, 1) }])
    expect(await apply(ctxOf(d), { approvalId: id })).toBe(EXIT.STOP)
    // the request log's sha256 (file hashes inside) is in the head, so the re-rendered text differs first
    expect(lines.join('\n')).toContain('the approved text differs')
    expect(d.consumes.filter((c) => c.id === id)).toEqual([])
    expect(readFileSync(localPath('alpha'), 'utf-8')).toBe(before)
  })
  it('every approval field is checked before the consume', async () => {
    const d = dashboard()
    await enrolAll(d)
    stage('b3', [{ agent: 'alpha', content: readFileSync(localPath('alpha'), 'utf-8') }])
    const cases: [Record<string, unknown>, string][] = [
      [{ category: 'code_deploy' }, 'category code_deploy != agent_settings'],
      [{ agent_id: 'alpha' }, 'agent_id alpha is not the main agent'],
      [{ status: 'rejected' }, 'status rejected'],
      [{ consumed_at: 5 }, 'already consumed'],
      [{ resolved_by: 'telegram_text:x' }, 'is not an owner channel'],
      [{ action_description: 'kézzel írt szöveg' }, 'the approved text differs'],
      [{ action_payload: '{"kind":"batch"}' }, 'request log path'],
      [{ content_hash: '0'.repeat(64) }, 'content_hash differs'],
    ]
    for (const [over, want] of cases) {
      expect(await request(ctxOf(d), { kind: 'batch', batchId: 'b3' })).toBe(EXIT.OK)
      const id = [...d.rows.keys()].pop()!
      approve(d, id, over)
      lines = []
      expect(await apply(ctxOf(d), { approvalId: id })).toBe(EXIT.STOP)
      expect(lines.join('\n')).toContain(want)
      expect(d.consumes.filter((c) => c.id === id)).toEqual([])
    }
  })
  it('identity: no MAIN_AGENT_ID means no main agent, STOP', async () => {
    const d = dashboard()
    await enrolAll(d)
    stage('b4', [{ agent: 'alpha', content: '{}' }])
    expect(await request(ctxOf(d), { kind: 'batch', batchId: 'b4' })).toBe(EXIT.OK)
    const id = [...d.rows.keys()].pop()!
    approve(d, id)
    writeFileSync(join(inst, '.env'), 'CHANNEL_PROVIDER=telegram\n')
    expect(await apply(ctxOf(d), { approvalId: id })).toBe(EXIT.STOP)
    expect(lines.join('\n')).toContain('MAIN_AGENT_ID')
    expect(d.consumes.filter((c) => c.id === id)).toEqual([])
  })
  it('a target turned into a link after the request: STOP before the consume, nothing written', async () => {
    const d = dashboard()
    await enrolAll(d)
    stage('b5', [{ agent: 'alpha', content: '{}' }])
    expect(await request(ctxOf(d), { kind: 'batch', batchId: 'b5' })).toBe(EXIT.OK)
    const id = [...d.rows.keys()].pop()!
    approve(d, id)
    const victim = join(base, 'victim.json')
    writeFileSync(victim, 'untouched')
    rmSync(localPath('alpha'))
    symlinkSync(victim, localPath('alpha'))
    expect(await apply(ctxOf(d), { approvalId: id })).toBe(EXIT.STOP)
    expect(readFileSync(victim, 'utf-8')).toBe('untouched')
    expect(d.consumes.filter((c) => c.id === id)).toEqual([])
    // a linked .claude directory as well
    rmSync(join(inst, 'agents', 'alpha', '.claude'), { recursive: true })
    mkdirSync(join(base, 'outside'))
    symlinkSync(join(base, 'outside'), join(inst, 'agents', 'alpha', '.claude'))
    expect(await apply(ctxOf(d), { approvalId: id })).toBe(EXIT.STOP)
    expect(readdirSync(join(base, 'outside'))).toEqual([])
  })
})

describe('the temp file (V2-A1-REL-2): random name, O_EXCL, O_NOFOLLOW', () => {
  it('a planted link at the temp name stops the write; neither the link target nor the target changes', () => {
    const dir = join(inst, 'agents', 'alpha', '.claude')
    const victim = join(base, 'victim')
    writeFileSync(victim, 'untouched')
    const before = readFileSync(localPath('alpha'), 'utf-8')
    symlinkSync(victim, join(dir, '.settings-0000000000000000.tmp'))
    expect(() => writeAtomicNoFollow(dir, 'settings.local.json', 'new', 0o600, () => '0000000000000000')).toThrow()
    expect(readFileSync(victim, 'utf-8')).toBe('untouched')
    expect(readFileSync(localPath('alpha'), 'utf-8')).toBe(before)
    // an existing regular file at the name: O_EXCL refuses it too
    writeFileSync(join(dir, '.settings-1111111111111111.tmp'), 'planted')
    expect(() => writeAtomicNoFollow(dir, 'settings.local.json', 'new', 0o600, () => '1111111111111111')).toThrow(/EEXIST/)
    expect(readFileSync(localPath('alpha'), 'utf-8')).toBe(before)
  })
  it('the default name is 16 random hex and the mode is kept', () => {
    const dir = join(inst, 'agents', 'beta', '.claude')
    const names: string[] = []
    writeAtomicNoFollow(dir, 'settings.local.json', 'x', 0o640, () => { const n = 'abcdef0123456789'; names.push(n); return n })
    expect(statSync(localPath('beta')).mode & 0o777).toBe(0o640)
    expect(existsSync(join(dir, '.settings-abcdef0123456789.tmp'))).toBe(false)
    expect(() => writeAtomicNoFollow(join(base, 'nope'), 'f', 'x')).toThrow()
  })
})

describe('a partial apply, status and resume (V2-A1-REL-2)', () => {
  async function partial(d: Dash) {
    await enrolAll(d)
    const a = `${JSON.stringify({ claudeMdExcludes: ['a'], permissions: { deny: rowsFor('alpha', AGENTS) } })}\n`
    const b = `${JSON.stringify({ claudeMdExcludes: ['b'], permissions: { deny: rowsFor('beta', AGENTS) } })}\n`
    stage('p1', [{ agent: 'alpha', content: a }, { agent: 'beta', content: b }])
    expect(await request(ctxOf(d), { kind: 'batch', batchId: 'p1' })).toBe(EXIT.OK)
    const id = [...d.rows.keys()].pop()!
    approve(d, id)
    return { id, a, b }
  }
  it('a target that turns into a link after the consume: alpha written, the baseline unchanged, exit 4, resume refuses until the disk matches', async () => {
    const swap = () => {
      rmSync(join(inst, 'agents', 'beta', '.claude'), { recursive: true })
      mkdirSync(join(base, 'beta-out'))
      symlinkSync(join(base, 'beta-out'), join(inst, 'agents', 'beta', '.claude'))
    }
    let armed = false
    const d = dashboard({ onConsume: () => { if (armed) swap() } })
    const { id, a, b } = await partial(d)
    const baselineBefore = readFileSync(join(inst, 'store', 'agent-settings-baseline.json'), 'utf-8')
    armed = true
    expect(await apply(ctxOf(d), { approvalId: id })).toBe(EXIT.STOP_AFTER_CONSUME)
    expect(readFileSync(localPath('alpha'), 'utf-8')).toBe(a)
    expect(readFileSync(join(inst, 'store', 'agent-settings-baseline.json'), 'utf-8')).toBe(baselineBefore)
    expect(lines.join('\n')).toContain('apply-local.mjs resume')
    lines = []
    status(ctxOf(d))
    expect(lines.join('\n')).toContain('"step": "stopped-after-consume"')
    // resume: beta's disk is not the approved content
    rmSync(join(inst, 'agents', 'beta', '.claude'))
    mkdirSync(join(inst, 'agents', 'beta', '.claude'))
    writeFileSync(localPath('beta'), 'something else')
    expect(await resume(ctxOf(d))).toBe(EXIT.STOP)
    expect(lines.join('\n')).toContain('rebaseline needed')
    expect(readFileSync(join(inst, 'store', 'agent-settings-baseline.json'), 'utf-8')).toBe(baselineBefore)
    // every file equal to the approved bytes: sealed, no new approval
    writeFileSync(localPath('beta'), b)
    const posts = d.posts.length
    expect(await resume(ctxOf(d))).toBe(EXIT.OK)
    expect(readBaseline().agents.alpha.local.sha256).toBe(sha(a))
    expect(readBaseline().agents.beta.local.sha256).toBe(sha(b))
    expect(d.posts.length).toBe(posts)
    expect(await resume(ctxOf(d))).toBe(EXIT.OK)
    expect(lines.pop()).toContain('already applied')
  })
  it('resume trusts nothing in the state file: not consumed, another consumer, too old, another ref', async () => {
    const opts = { consumeStatus: 200 }
    const d = dashboard(opts)
    const { id } = await partial(d)
    opts.consumeStatus = 409
    expect(await apply(ctxOf(d), { approvalId: id })).toBe(EXIT.STOP)
    expect(await resume(ctxOf(d))).toBe(EXIT.STOP)
    expect(lines.pop()).toContain('not consumed')
    const row = d.rows.get(id)!
    Object.assign(row, { consumed_at: Math.floor(clock / 1000), consumed_by: 'fork-deploy', consumed_ref: row.content_hash })
    expect(await resume(ctxOf(d))).toBe(EXIT.STOP)
    expect(lines.pop()).toContain('not by this helper')
    Object.assign(row, { consumed_by: CONSUMER, consumed_at: Math.floor(clock / 1000) - RESUME_MAX_AGE_SECONDS - 1 })
    expect(await resume(ctxOf(d))).toBe(EXIT.STOP)
    expect(lines.pop()).toContain('older than')
    Object.assign(row, { consumed_at: Math.floor(clock / 1000), consumed_ref: 'x' })
    expect(await resume(ctxOf(d))).toBe(EXIT.STOP)
    expect(lines.pop()).toContain('consume ref')
  })
})

describe('rebaseline: today\'s file and today\'s switches', () => {
  it('a switch change of an existing entry is a never-cut KAPCSOLÓ line; the baseline takes the new tuple', async () => {
    const d = dashboard()
    await enrolAll(d)
    tuples.beta = tuple({ browser: true })
    expect(await request(ctxOf(d), { kind: 'rebaseline', agent: 'beta' })).toBe(EXIT.OK)
    const id = [...d.rows.keys()].pop()!
    expect(String(d.rows.get(id)!.action_description)).toContain('KAPCSOLÓ: beta: browser false -> true')
    approve(d, id)
    expect(await apply(ctxOf(d), { approvalId: id })).toBe(EXIT.OK)
    expect(readBaseline().agents.beta.switches.browser).toBe(true)
  })
  it('a hand edit since the baseline: the removed row is named', async () => {
    const d = dashboard()
    await enrolAll(d)
    writeLocal('beta', { permissions: { deny: [] } })
    expect(await request(ctxOf(d), { kind: 'rebaseline', agent: 'beta' })).toBe(EXIT.OK)
    const text = String(d.posts.at(-1)!.action_description)
    expect(text).toContain(`ELTÁVOLÍTVA: beta: ${agentDirRows(inst, 'sally')[3]}`)
    expect(text).toContain('SÉRÜL: beta: 4 deny-sor hiányzik (sally elkülönítése)')
  })
})

describe('the owner text is bounded (V2-A1-REL-1)', () => {
  const fourteen = Array.from({ length: 14 }, (_, i) => `agent${String(i).padStart(2, '0')}`)
  function bigInstall(remove: number) {
    for (const a of fourteen) mkdirSync(join(inst, 'agents', a, '.claude'), { recursive: true })
    const old = (a: string) => Array.from({ length: 40 }, (_, i) => `Read(//srv/${a}/old-${i}/**)`)
    const agents: Record<string, unknown> = {}
    for (const a of fourteen) {
      const t = `${JSON.stringify({ permissions: { deny: old(a) } })}\n`
      writeFileSync(localPath(a), t)
      agents[a] = { switches: tuple(), local: localRecord(t) }
    }
    mkdirSync(join(inst, 'store'), { recursive: true })
    writeFileSync(join(inst, 'store', 'agent-settings-baseline.json'), JSON.stringify({ format: BASELINE_FORMAT, isolated: [], agents }))
    stage('big', fourteen.map((a) => ({ agent: a, content: `${JSON.stringify({ permissions: { deny: [...old(a).slice(remove), ...Array.from({ length: 39 }, (_, i) => `Read(//srv/${a}/new-${i}/**)`)] } })}\n` })), ['agent00'])
  }
  it('worst case 14 agents x 40 rows: at most 3000 characters, every SÉRÜL and ELTÁVOLÍTVA line in it, the owner message under 4096', async () => {
    bigInstall(1)
    const d = dashboard()
    expect(await request(ctxOf(d), { kind: 'batch', batchId: 'big' })).toBe(EXIT.OK)
    const text = String(d.posts[0].action_description)
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_CAP)
    for (const a of fourteen) {
      expect(text).toContain(`ELTÁVOLÍTVA: ${a}: Read(//srv/${a}/old-0/**)`)
      if (a !== 'agent00') expect(text).toContain(`SÉRÜL: ${a}: 4 deny-sor hiányzik (agent00 elkülönítése)`)
    }
    expect(text).toContain('SÉRÜL: agent00:')
    expect(text).toMatch(/\.\.\. és még \d+ sor \(teljes lista: store\/agent-settings-logs\/request-/)
    const owner = buildOwnerApprovalText({ id: 'x'.repeat(36), agent_id: MAIN, category: CATEGORY, action_description: text, action_payload: null, status: 'pending', timeout_at: Math.floor(T0 / 1000) + 3600, telegram_message_id: null, requested_at: Math.floor(T0 / 1000), resolved_at: null, resolved_by: null, content_hash: null, consumed_at: null } as Approval)
    expect(owner.length).toBeLessThan(4096)
  })
  it('too many removals for the never-cut block: refused, split into smaller batches, no approval', async () => {
    bigInstall(12)
    const d = dashboard()
    expect(await request(ctxOf(d), { kind: 'batch', batchId: 'big' })).toBe(EXIT.STOP)
    expect(lines.pop()).toContain('split the change into smaller batches')
    expect(d.posts).toEqual([])
  })
})

describe('pure pieces', () => {
  it('contentHash covers the kind, the isolated list, each file and each tuple, in name order', () => {
    const e = [{ agent: 'b', content: 'B', tuple: tuple() }, { agent: 'a', content: null, tuple: tuple() }]
    const h = contentHash('batch', ['s'], e)
    expect(contentHash('batch', ['s'], [...e].reverse())).toBe(h)
    expect(contentHash('rebaseline', ['s'], e)).not.toBe(h)
    expect(contentHash('batch', [], e)).not.toBe(h)
    expect(contentHash('batch', ['s'], [{ ...e[0], content: 'B ' }, e[1]])).not.toBe(h)
    expect(contentHash('batch', ['s'], [{ ...e[0], tuple: tuple({ browser: true }) }, e[1]])).not.toBe(h)
    expect(contentHash('batch', ['s'], [e[0], { ...e[1], content: '' }])).not.toBe(h)
  })
  it('the full render is the request log and carries every row', async () => {
    const d = dashboard()
    const c = await collect(ctxOf(d), { kind: 'baseline', isolated: ['sally'] })
    const full = fullRender(c)
    for (const r of rowsFor('sally', AGENTS)) expect(full).toContain(`deny ${r}`)
    expect(ownerDescription(c, 'store/agent-settings-logs/request-20261117T220000Z-0000abcd.log')).toContain(`sha256 ${sha(full)}`)
    expect(() => ownerDescription(c, 'store/x.log')).toThrow('request log path')
  })
  it('lstat sanity: the fixture agents are real directories', () => {
    expect(lstatSync(join(inst, 'agents', 'alpha')).isDirectory()).toBe(true)
  })
})
