// Fork D part (a) (kanban f8bbd94c, Roland TG 3735, Ron plan review 18031): POST /api/agents (create) and
// DELETE /api/agents/:name (delete) take the same predicate as A1's PUT (ownerOrSharedToken in routes/agents.ts):
// the owner (mayActAsOwner) OR the SHARED dashboard token pass; a sub-agent's own token, a federation peer, a bare
// full Bridge key (D2, decided: as A1-A4), an operator key and a missing principal are 403 OWNER_SESSION_REQUIRED.
// The gate is the FIRST statement of both handlers: a refused caller gets the same 403 for an unknown, an existing
// and the main agent's name, the body is never read, the install default is never probed, and a refused delete
// leaves the directory, the desired-state row and the backup folder exactly as they were. Real resolveAuth, sessions
// and device keys; the passing cases run the real handlers on to their next answer (create: the 400 for a missing
// name, after the install-default probe; delete: the real backup and removal in a scratch PROJECT_ROOT).
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = vi.hoisted(() => ({ dir: '' }))
vi.mock('../config.js', async (importOriginal) => {
  const { mkdtempSync: mk, mkdirSync: md } = await import('node:fs')
  const { tmpdir: td } = await import('node:os')
  const { join: j } = await import('node:path')
  ROOTS.dir = mk(j(td(), 'agent-create-delete-gate-'))
  md(j(ROOTS.dir, 'store'), { recursive: true })
  return { ...(await importOriginal<typeof import('../config.js')>()), PROJECT_ROOT: ROOTS.dir, STORE_DIR: j(ROOTS.dir, 'store'), MAIN_AGENT_ID: 'host-main' }
})

// Every step a refused caller must never reach, counted: the body read, the install-default probe (create, before
// the name checks), the scaffold (create), the stop and the backup (delete).
const counts = vi.hoisted(() => ({ readBody: 0, installDefault: 0, scaffold: 0, stop: 0, backup: 0 }))
vi.mock('../web/http-helpers.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/http-helpers.js')>()
  return { ...real, readBody: (...a: Parameters<typeof real.readBody>) => { counts.readBody++; return real.readBody(...a) } }
})
vi.mock('../web/default-model-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/default-model-guard.js')>()),
  launchableInstallDefault: async () => { counts.installDefault++; return 'claude-sonnet-5-5' },
}))
vi.mock('../web/agent-scaffold.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-scaffold.js')>()),
  scaffoldAgentDir: () => { counts.scaffold++; throw new Error('scaffoldAgentDir must not run in this test') },
}))
vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => false,
  stopAgentProcess: async () => { counts.stop++ },
}))
// The create's CLI gate (refuseIfCliCannotLaunch) probes the installed claude; no probe here (as in A1's test).
vi.mock('../web/claude-cli-version.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/claude-cli-version.js')>()),
  measureClaudeCliVersion: async () => ({ version: null }),
}))
vi.mock('../web/agent-backup.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-backup.js')>()
  return { ...real, backupAgentDir: (...a: Parameters<typeof real.backupAgentDir>) => { counts.backup++; return real.backupAgentDir(...a) } }
})

const { initDatabase, getDb, getDashboardUser } = await import('../db.js')
const { resolveAuth, gateRequest, SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')
const { tryHandleAuth, OWNER_SESSION_REQUIRED } = await import('../web/routes/auth.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { addDesiredAgent, getDesiredAgents } = await import('../web/agent-desired-state.js')
const { createDeviceKey, _clearDeviceKeyCacheForTest } = await import('../web/auth-device-keys.js')
const { _clearSessionCacheForTest, createSession } = await import('../web/auth-sessions.js')
type Auth = import('../web/routes/types.js').RouteContext['auth']
type Handler = (ctx: any, ...rest: any[]) => Promise<boolean>

afterAll(() => { rmSync(ROOTS.dir, { recursive: true, force: true }) })

const TOKEN = 'f'.repeat(64)
const SUB_TOKEN = 'a'.repeat(64) // a sub-agent's own token (agents/zara/.dashboard-token), resolved below
const resolveSubToken = (t: string) => (t === SUB_TOKEN ? 'zara' : null)
const MAIN = 'host-main'
const AGENTS = () => join(ROOTS.dir, 'agents')
const BACKUPS = () => join(ROOTS.dir, 'store')

function reqWith(headers: Record<string, string>, path: string, method: string, raw?: string): http.IncomingMessage {
  const req = Readable.from(raw === undefined ? [] : [Buffer.from(raw)]) as unknown as http.IncomingMessage
  req.headers = headers
  ;(req as any).url = path
  ;(req as any).method = method
  ;(req as any).socket = { remoteAddress: '127.0.0.1' }
  return req
}
function fakeRes(out: { status: number; body: any }) {
  const res: any = {
    writeHead(s: number) { out.status = s; return res }, setHeader() {},
    end(c?: string | Buffer) { if (c) try { out.body = JSON.parse(c.toString()) } catch { out.body = c.toString() } },
  }
  return res
}
// `auth`: undefined = resolved from the headers by the real resolveAuth (with the sub-agent token resolver); 'none' =
// the route called with no principal at all (ctx.auth undefined, the gate bypassed); otherwise used as given.
async function hit(handler: Handler, method: string, path: string, headers: Record<string, string>, body?: unknown, auth?: Auth | 'none') {
  const out: { status: number; body: any } = { status: 200, body: null }
  const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  const req = reqWith(headers, path, method, raw)
  const url = new URL(`http://127.0.0.1:3420${path}`)
  let resolved: Auth
  if (auth === 'none') resolved = undefined
  else {
    resolved = auth ?? (resolveAuth(req, url, path, method, TOKEN, resolveSubToken) as Auth)
    expect(resolved, 'the request resolves to a principal').toBeTruthy()
  }
  expect(await handler({ req, res: fakeRes(out), path: url.pathname, method, url, auth: resolved } as any, '/nonexistent-webdir')).toBe(true)
  return out
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' })
let cookie = ''
const withCookie = (h: Record<string, string>) => ({ ...h, cookie: `${SESSION_COOKIE_NAME}=${cookie}` })
async function addOwner() {
  const r = await hit(tryHandleAuth, 'POST', '/api/auth/users', bearer(TOKEN), { username: 'owner', password: 'super-secret-pw' })
  expect(r.status).toBe(201)
  cookie = createSession({ userId: getDashboardUser('owner')!.id, username: 'owner' })
  counts.readBody = 0 // the user creation read its own body; count only the route under test
}

// A full create body: if a refused caller reached the handler body it would probe the install default (no model)
// and go on to the name checks and the scaffold.
const CREATE_BODY = { name: 'newbie', description: 'a new agent', telegram: false }
const create = (headers: Record<string, string>, auth?: Auth | 'none', body: unknown = CREATE_BODY) =>
  hit(tryHandleAgents, 'POST', '/api/agents', headers, body, auth)
const del = (name: string, headers: Record<string, string>, auth?: Auth | 'none') =>
  hit(tryHandleAgents, 'DELETE', `/api/agents/${name}`, headers, undefined, auth)

const ZERO = { readBody: 0, installDefault: 0, scaffold: 0, stop: 0, backup: 0 }
function expectRefused(out: { status: number; body: any }) {
  expect(out.status, JSON.stringify(out.body)).toBe(403)
  expect(out.body).toEqual(OWNER_SESSION_REQUIRED)
  expect({ ...counts }).toEqual(ZERO)
}

function seedAgent(name: string): string {
  const dir = join(AGENTS(), name)
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), `# ${name}\n`)
  addDesiredAgent(name)
  return dir
}
function listTree(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: false }).map(String).sort()
}

// The principal matrix, the same cases as A1's PUT (agent-put-owner-or-token-model.test.ts). `setup` runs first;
// `headers`/`auth` are read after it (the cookie and the device keys exist only then).
type Principal = { label: string; login: boolean; headers: () => Record<string, string>; auth?: () => Auth | 'none' }
const PASSING: Principal[] = [
  { label: 'the owner session', login: true, headers: () => ({ 'content-type': 'application/json' }), auth: () => ({ kind: 'session', user: 'owner' } as Auth) },
  { label: 'the shared token after the first login', login: true, headers: () => bearer(TOKEN) },
  { label: 'the shared token before the first login', login: false, headers: () => bearer(TOKEN) },
  { label: 'the shared token with the owner\'s cookie', login: true, headers: () => withCookie(bearer(TOKEN)) },
  { label: 'a full Bridge key with the owner\'s cookie', login: true, headers: () => withCookie(bearer(createDeviceKey('Bridge').key)) },
]
const REFUSED: Principal[] = [
  { label: 'a sub-agent\'s own token (resolved by the real resolveAuth), after the first login', login: true, headers: () => bearer(SUB_TOKEN) },
  { label: 'a sub-agent\'s own token before the first login', login: false, headers: () => bearer(SUB_TOKEN) },
  { label: 'a sub-agent\'s own token with the owner\'s cookie', login: true, headers: () => withCookie(bearer(SUB_TOKEN)) },
  { label: 'a federation peer', login: true, headers: () => bearer(TOKEN), auth: () => ({ kind: 'federation', peer: 'other-install' } as Auth) },
  { label: 'a bare full Bridge key (D2: no owner cookie beside it)', login: true, headers: () => bearer(createDeviceKey('Bridge').key) },
  { label: 'an operator key, even with the owner\'s cookie', login: true, headers: () => withCookie(bearer(createDeviceKey('Op', { scope: 'operator', expiresInDays: 7 }).key)) },
  { label: 'no principal at all (the gate bypassed)', login: true, headers: () => ({ 'content-type': 'application/json' }), auth: () => 'none' },
  { label: 'no principal at all, before the first login', login: false, headers: () => ({ 'content-type': 'application/json' }), auth: () => 'none' },
]

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  mkdirSync(AGENTS(), { recursive: true })
})
beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users; DELETE FROM device_keys')
  _clearSessionCacheForTest()
  _clearDeviceKeyCacheForTest()
  cookie = ''
  for (const k of Object.keys(counts) as Array<keyof typeof counts>) counts[k] = 0
})

describe('POST /api/agents: the owner or the shared token, nobody else', () => {
  for (const p of PASSING) {
    it(`passes: ${p.label} (the body read once, the install default probed, then the handler's own 400)`, async () => {
      if (p.login) await addOwner()
      const out = await create(p.headers(), p.auth?.(), { description: 'a new agent' })
      // Past the gate: the name check answers. readBody and the install-default probe ran exactly once.
      expect(out.status, JSON.stringify(out.body)).toBe(400)
      expect(out.body).toEqual({ error: 'Name is required' })
      expect({ ...counts }).toEqual({ ...ZERO, readBody: 1, installDefault: 1 })
    })
  }
  for (const p of REFUSED) {
    it(`403 before the body is read and before launchableInstallDefault: ${p.label}`, async () => {
      if (p.login) await addOwner()
      expectRefused(await create(p.headers(), p.auth?.()))
      expect(existsSync(join(AGENTS(), CREATE_BODY.name))).toBe(false)
    })
  }

  it('403 before the 409s: a refused caller gets the same answer for an existing, the main and a reserved name', async () => {
    await addOwner()
    seedAgent('taken')
    const answers = []
    for (const name of ['taken', MAIN, 'system', 'brand-new']) {
      answers.push(await create(bearer(SUB_TOKEN), undefined, { name, description: 'x', model: 'claude-sonnet-5-5' }))
    }
    for (const out of answers) expectRefused(out)
    expect(new Set(answers.map((a) => JSON.stringify([a.status, a.body]))).size).toBe(1)
    // CONTROL: the shared token on the existing name reaches the 409 (so the 403 above is the gate, not the name).
    const ok = await create(bearer(TOKEN), undefined, { name: 'taken', description: 'x', model: 'claude-sonnet-5-5' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(409)
    rmSync(join(AGENTS(), 'taken'), { recursive: true, force: true })
  })
})

describe('DELETE /api/agents/:name: the owner or the shared token, nobody else', () => {
  let n = 0
  for (const p of PASSING) {
    it(`passes: ${p.label} (the real backup, then the directory and the desired row are gone)`, async () => {
      if (p.login) await addOwner()
      const name = `doomed-${n++}`
      const dir = seedAgent(name)
      const out = await del(name, p.headers(), p.auth?.())
      expect(out.status, JSON.stringify(out.body)).toBe(200)
      expect(out.body.ok).toBe(true)
      expect(existsSync(out.body.backup)).toBe(true)
      expect(existsSync(dir)).toBe(false)
      expect(getDesiredAgents().has(name)).toBe(false)
      expect(counts.backup).toBe(1)
      expect(counts.readBody).toBe(0)
    })
  }
  for (const p of REFUSED) {
    it(`403, nothing touched (dir, desired row, no backup, no stop): ${p.label}`, async () => {
      if (p.login) await addOwner()
      const dir = seedAgent('keeper')
      const beforeTree = listTree(dir)
      const beforeBackups = listTree(BACKUPS())
      const beforeDesired = [...getDesiredAgents()].sort()
      expectRefused(await del('keeper', p.headers(), p.auth?.()))
      expect(listTree(dir)).toEqual(beforeTree)
      expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe('# keeper\n')
      expect([...getDesiredAgents()].sort()).toEqual(beforeDesired)
      expect(getDesiredAgents().has('keeper')).toBe(true)
      expect(listTree(BACKUPS())).toEqual(beforeBackups)
    })
  }

  it('403 before the 404 and the main-agent 400: unknown, existing and main names give the same answer', async () => {
    await addOwner()
    seedAgent('keeper')
    const answers = []
    for (const name of ['keeper', 'no-such-agent', MAIN]) answers.push(await del(name, bearer(SUB_TOKEN)))
    for (const out of answers) expectRefused(out)
    expect(new Set(answers.map((a) => JSON.stringify([a.status, a.body]))).size).toBe(1)
    // CONTROL: the shared token gets the 404 and the 400 on the same names (the 403 above is the gate).
    expect((await del('no-such-agent', bearer(TOKEN))).status).toBe(404)
    expect((await del(MAIN, bearer(TOKEN))).status).toBe(400)
  })
})

describe('the auth gate in front (unchanged by this PR, pinned so the two layers are seen together)', () => {
  async function gate(method: string, path: string, headers: Record<string, string>) {
    const out: { status: number; body: any } = { status: 200, body: null }
    const url = new URL(`http://127.0.0.1:3420${path}`)
    const auth = await gateRequest(reqWith(headers, path, method), fakeRes(out), url, path, method, {
      dashboardToken: TOKEN, resolveAgentToken: resolveSubToken, mainAgentId: MAIN,
    })
    return { auth, out }
  }
  for (const [method, path] of [['POST', '/api/agents'], ['DELETE', '/api/agents/keeper']] as const) {
    it(`${method} ${path}: no credential is 401 at the gate; a sub-agent token is 403 there too; the shared token passes`, async () => {
      await addOwner()
      const none = await gate(method, path, {})
      expect(none.auth).toBeNull()
      expect(none.out.status).toBe(401)
      const sub = await gate(method, path, bearer(SUB_TOKEN))
      expect(sub.auth).toBeNull()
      expect(sub.out.status).toBe(403)
      const shared = await gate(method, path, bearer(TOKEN))
      expect(shared.auth).toMatchObject({ kind: 'token' })
    })
  }
})
