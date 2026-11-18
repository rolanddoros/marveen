// Fork A4 (kanban 774c7ece, Ron 17674 tier A item 4, plan Ron 17800 K1-K4, Kevin 17802): the channel ACCESS routes
// decide who can write to an agent from outside (bot token, access.json, pairing, invites, Slack channels), the main
// agent's own channel included, and they sat behind the outer Bearer gate only. Once a dashboard login exists each
// takes the owner (mayActAsOwner), before the name checks, the 404, the body and any channel-file or DB read:
//   R1 POST /channels/:p (setup)        R2 DELETE /channels/:p          R3 POST /channels/:p/approve (pairing)
//   R4 POST /channels/:p/invites        G9 GET /channels/:p/invites     R5 DELETE /channels/:p/invites/:token
//   R6 DELETE /channels/:p/allowed/(user|group)/:id                     R7/R8 POST /channel-requests/:id/approve|deny
// (each also under the legacy /telegram form where it exists). Real resolveAuth, sessions and device keys; readBody,
// the start/stop/restart helpers, the main channels restart and fetch (token validation) are counted.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOTS = vi.hoisted(() => ({ dir: '' }))
vi.mock('../config.js', async (importOriginal) => {
  const { mkdtempSync: mk, mkdirSync: md } = await import('node:fs')
  const { tmpdir: td } = await import('node:os')
  const { join: j } = await import('node:path')
  ROOTS.dir = mk(j(td(), 'channel-access-owner-'))
  md(j(ROOTS.dir, 'store'), { recursive: true })
  return { ...(await importOriginal<typeof import('../config.js')>()), PROJECT_ROOT: ROOTS.dir, STORE_DIR: j(ROOTS.dir, 'store'), MAIN_AGENT_ID: 'host-main' }
})

const counts = vi.hoisted(() => ({ readBody: 0, start: 0, stop: 0, restart: 0, mainRestart: 0, fetch: 0 }))
vi.mock('../web/http-helpers.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/http-helpers.js')>()
  return { ...real, readBody: (...a: Parameters<typeof real.readBody>) => { counts.readBody++; return real.readBody(...a) } }
})
vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => false,
  startAgentProcess: async () => { counts.start++; return { ok: true } },
  stopAgentProcess: async () => { counts.stop++; return { ok: true } },
  restartAgentProcess: async () => { counts.restart++; return { ok: true } },
}))
vi.mock('../web/channel-monitor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/channel-monitor.js')>()),
  hardRestartMarveenChannels: () => { counts.mainRestart++; return { ok: true } },
}))

const { initDatabase, getDb, getDashboardUser, upsertChannelRequest } = await import('../db.js')
const { resolveAuth, SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')
const { tryHandleAuth, OWNER_SESSION_REQUIRED } = await import('../web/routes/auth.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { createDeviceKey, _clearDeviceKeyCacheForTest } = await import('../web/auth-device-keys.js')
const { _clearSessionCacheForTest, createSession } = await import('../web/auth-sessions.js')
const { createInvite } = await import('../web/channel-invites.js')
type Auth = import('../web/routes/types.js').RouteContext['auth']

// The main agent's channel dirs: every provider's STATE_DIR override points into the temp root, so no run can reach
// the install's or the host's real channel state (channelStateDir reads the override at call time).
const MAIN_CH = join(ROOTS.dir, 'main-channels')
const PROVIDERS = ['TELEGRAM', 'SLACK', 'DISCORD', 'GOOGLECHAT', 'TEAMS'] as const
const prevEnv = Object.fromEntries(PROVIDERS.map(p => [p, process.env[`${p}_STATE_DIR`]]))
for (const p of PROVIDERS) process.env[`${p}_STATE_DIR`] = join(MAIN_CH, p.toLowerCase())

const realFetch = globalThis.fetch
beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  globalThis.fetch = (async () => { counts.fetch++; throw new Error('no network in this test') }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  for (const p of PROVIDERS) {
    if (prevEnv[p] === undefined) delete process.env[`${p}_STATE_DIR`]
    else process.env[`${p}_STATE_DIR`] = prevEnv[p]
  }
  rmSync(ROOTS.dir, { recursive: true, force: true })
})

const TOKEN = 'f'.repeat(64)
const SUB = 'vera'
const MAIN = 'host-main'
const SUB_DIR = join(ROOTS.dir, 'agents', SUB)
const chDir = (name: string, provider = 'telegram') => (name === MAIN ? join(MAIN_CH, provider) : join(SUB_DIR, '.claude', 'channels', provider))
const inviteToken: Record<string, string> = {}
const requestId: Record<string, number> = {}

function seed() {
  rmSync(SUB_DIR, { recursive: true, force: true })
  rmSync(MAIN_CH, { recursive: true, force: true })
  mkdirSync(SUB_DIR, { recursive: true })
  writeFileSync(join(SUB_DIR, 'agent-config.json'), JSON.stringify({ channelProvider: 'slack' }, null, 2))
  for (const name of [SUB, MAIN]) {
    const dir = chDir(name)
    mkdirSync(join(dir, 'approved'), { recursive: true })
    writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=111111:seed-not-a-real-token\n', { mode: 0o600 })
    writeFileSync(join(dir, 'access.json'), JSON.stringify({
      dmPolicy: 'pairing', allowFrom: ['42', '43'], groups: { '-100': { requireMention: true } },
      pending: { ABC123: { senderId: '77', chatId: '77', createdAt: Date.now(), expiresAt: Date.now() + 3_600_000, replies: 1 } },
    }, null, 2))
    inviteToken[name] = createInvite(join(dir, 'access.json'), 'seed_bot', 'telegram').token
    mkdirSync(chDir(name, 'slack'), { recursive: true })
    writeFileSync(join(chDir(name, 'slack'), 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [], groups: {} }, null, 2))
  }
  getDb().exec('DELETE FROM pending_channel_requests')
  for (const name of [SUB, MAIN]) {
    upsertChannelRequest(name, `C-${name}`, 'U1')
    requestId[name] = (getDb().prepare('SELECT id FROM pending_channel_requests WHERE agent = ?').get(name) as { id: number }).id
  }
}

// Every file under both agents' channel state (and the sub-agent's config), as relative path -> sha256; plus the rows.
function snapshot() {
  const files: Record<string, string> = {}
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) { files[`${relative(ROOTS.dir, p)}/`] = 'dir'; walk(p) }
      else files[relative(ROOTS.dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex')
    }
  }
  walk(join(SUB_DIR)); walk(MAIN_CH)
  const rows = getDb().prepare('SELECT * FROM pending_channel_requests ORDER BY id').all()
  return { files, rows }
}

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown, auth?: Auth) {
  const out: { status: number; body: any; raw: string } = { status: 200, body: null, raw: '' }
  const res: any = {
    writeHead(s: number) { out.status = s; return res }, setHeader() {},
    end(c?: string | Buffer) { if (c) { out.raw = c.toString(); try { out.body = JSON.parse(out.raw) } catch { out.body = out.raw } } },
  }
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = { 'content-type': 'application/json', ...headers }
  ;(req as any).url = path
  ;(req as any).method = method
  ;(req as any).socket = { remoteAddress: '127.0.0.1' }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  const resolved = auth ?? (resolveAuth(req, url, url.pathname, method, TOKEN) as Auth)
  expect(resolved, 'the request resolves to a principal').toBeTruthy()
  expect(await tryHandleAgents({ req, res, path: url.pathname, method, url, auth: resolved } as any, '/nonexistent-webdir')).toBe(true)
  return out
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
let cookie = ''
const withCookie = (h: Record<string, string>) => ({ ...h, cookie: `${SESSION_COOKIE_NAME}=${cookie}` })
async function addOwner() {
  const out = { status: 0 }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end() {} }
  const req = Readable.from([Buffer.from(JSON.stringify({ username: 'owner', password: 'super-secret-pw' }))]) as unknown as http.IncomingMessage
  req.headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  const url = new URL('http://127.0.0.1:3420/api/auth/users')
  await tryHandleAuth({ req, res, path: url.pathname, method: 'POST', url, auth: { kind: 'token' } } as any)
  expect(out.status).toBe(201)
  cookie = createSession({ userId: getDashboardUser('owner')!.id, username: 'owner' })
  counts.readBody = 0
}

const sideEffects = () => ({ readBody: counts.readBody, start: counts.start, stop: counts.stop, restart: counts.restart, mainRestart: counts.mainRestart, fetch: counts.fetch })
const NONE = { readBody: 0, start: 0, stop: 0, restart: 0, mainRestart: 0, fetch: 0 }

// [id, method, paths(name) (new form first, then legacy where it exists), body]
type Route = { id: string; method: string; paths: (n: string) => string[]; body?: unknown }
const ROUTES: Route[] = [
  { id: 'R1 setup', method: 'POST', paths: n => [`/api/agents/${n}/channels/telegram`, `/api/agents/${n}/telegram`], body: { botToken: '222222:attacker-bot-token', allowFrom: ['666'] } },
  { id: 'R2 removal', method: 'DELETE', paths: n => [`/api/agents/${n}/channels/telegram`, `/api/agents/${n}/telegram`] },
  { id: 'R3 pairing approve', method: 'POST', paths: n => [`/api/agents/${n}/channels/telegram/approve`, `/api/agents/${n}/telegram/approve`], body: { code: 'ABC123' } },
  { id: 'R4 invite create', method: 'POST', paths: n => [`/api/agents/${n}/channels/telegram/invites`, `/api/agents/${n}/telegram/invites`], body: {} },
  { id: 'G9 invite list', method: 'GET', paths: n => [`/api/agents/${n}/channels/telegram/invites`, `/api/agents/${n}/telegram/invites`] },
  { id: 'R5 invite revoke', method: 'DELETE', paths: n => [`/api/agents/${n}/channels/telegram/invites/${inviteToken[n] ?? 'x'}`, `/api/agents/${n}/telegram/invites/${inviteToken[n] ?? 'x'}`] },
  { id: 'R6 allowed removal', method: 'DELETE', paths: n => [`/api/agents/${n}/channels/telegram/allowed/user/42`, `/api/agents/${n}/telegram/allowed/user/42`, `/api/agents/${n}/channels/telegram/allowed/group/-100`, `/api/agents/${n}/telegram/allowed/group/-100`] },
  { id: 'R7 channel request approve', method: 'POST', paths: n => [`/api/agents/${n}/channel-requests/${requestId[n] ?? 1}/approve`], body: { allowFromAll: true } },
  { id: 'R8 channel request deny', method: 'POST', paths: n => [`/api/agents/${n}/channel-requests/${requestId[n] ?? 1}/deny`], body: {} },
]

beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users; DELETE FROM device_keys')
  _clearSessionCacheForTest()
  _clearDeviceKeyCacheForTest()
  cookie = ''
  Object.assign(counts, NONE)
  seed()
})
afterEach(() => { vi.restoreAllMocks() })

async function expectRefused(method: string, path: string, headers: Record<string, string>, body?: unknown, auth?: Auth) {
  const before = snapshot()
  Object.assign(counts, NONE)
  const out = await call(method, path, headers, body, auth)
  expect(out.status, `${method} ${path}: ${out.raw}`).toBe(403)
  expect(out.body).toEqual(OWNER_SESSION_REQUIRED)
  expect(sideEffects(), `${method} ${path}: no body read, no start/restart, no token check`).toEqual(NONE)
  expect(snapshot(), `${method} ${path}: channel dirs and request rows untouched`).toEqual(before)
  return out
}

describe('after the first login the shared token is refused on every channel access route, every URL form', () => {
  for (const r of ROUTES) {
    for (const name of [SUB, MAIN]) {
      it(`${r.id} on ${name === MAIN ? 'the main agent' : 'a sub-agent'}`, async () => {
        await addOwner()
        for (const p of r.paths(name)) await expectRefused(r.method, p, bearer(TOKEN), r.body)
      })
    }
    it(`${r.id}: an unknown agent is 403 too, not 404 (no name oracle)`, async () => {
      await addOwner()
      for (const p of r.paths('nobody')) await expectRefused(r.method, p, bearer(TOKEN), r.body)
    })
  }

  it('G9: the refusal carries no invite token', async () => {
    await addOwner()
    for (const name of [SUB, MAIN]) {
      for (const p of ROUTES.find(r => r.id.startsWith('G9'))!.paths(name)) {
        const out = await expectRefused('GET', p, bearer(TOKEN))
        expect(out.raw).not.toContain(inviteToken[name])
      }
    }
  })
})

describe('other principals are refused the same way (every route, sub-agent and main agent)', () => {
  const others: Array<[string, () => Promise<{ headers: Record<string, string>; auth?: Auth }>]> = [
    ['a sub-agent\'s own token, before the first login', async () => ({ headers: bearer(TOKEN), auth: { kind: 'token', agent: 'zara', tokenAgent: 'zara' } as Auth })],
    ['a federation peer', async () => { await addOwner(); return { headers: bearer(TOKEN), auth: { kind: 'federation', peer: 'other-install' } as Auth } }],
    ['a bare full device key', async () => { await addOwner(); return { headers: bearer(createDeviceKey('Bridge').key) } }],
    ['an operator key with the owner\'s cookie', async () => { await addOwner(); return { headers: withCookie(bearer(createDeviceKey('Op', { scope: 'operator', expiresInDays: 7 }).key)) } }],
  ]
  for (const [label, principal] of others) {
    it(label, async () => {
      const { headers, auth } = await principal()
      for (const r of ROUTES) for (const name of [SUB, MAIN]) await expectRefused(r.method, r.paths(name)[0], headers, r.body, auth)
    })
  }
})

describe('the owner passes every gate and gets the old answers', () => {
  const owner = () => withCookie(bearer(TOKEN))
  it('R1 setup: an empty body is the old 400 (sub-agent and main agent), body read once', async () => {
    await addOwner()
    for (const name of [SUB, MAIN]) {
      counts.readBody = 0
      const out = await call('POST', `/api/agents/${name}/channels/telegram`, owner(), {})
      expect([out.status, out.body]).toEqual([400, { error: 'botToken is required' }])
      expect(counts.readBody).toBe(1)
    }
  })
  it('R2 removal: the sub-agent\'s .env and access.json go, 200; the main agent keeps the old 404', async () => {
    await addOwner()
    const out = await call('DELETE', `/api/agents/${SUB}/channels/telegram`, owner())
    expect([out.status, out.body]).toEqual([200, { ok: true }])
    expect(existsSync(join(chDir(SUB), '.env'))).toBe(false)
    expect(existsSync(join(chDir(SUB), 'access.json'))).toBe(false)
    expect((await call('DELETE', `/api/agents/${MAIN}/channels/telegram`, owner())).status).toBe(404)
  })
  it('R3 pairing approve: the pending sender joins allowFrom and approved/<id> is written (sub-agent and main agent)', async () => {
    await addOwner()
    for (const name of [SUB, MAIN]) {
      const out = await call('POST', `/api/agents/${name}/telegram/approve`, owner(), { code: 'ABC123' })
      expect([out.status, out.body]).toEqual([200, { ok: true, senderId: '77' }])
      expect(JSON.parse(readFileSync(join(chDir(name), 'access.json'), 'utf-8')).allowFrom).toContain('77')
      expect(existsSync(join(chDir(name), 'approved', '77'))).toBe(true)
    }
  })
  it('R4 + G9: the owner creates an invite and the list shows it', async () => {
    await addOwner()
    const created = await call('POST', `/api/agents/${SUB}/channels/telegram/invites`, owner(), {})
    expect(created.status, created.raw).toBe(200)
    expect(typeof created.body.token).toBe('string')
    for (const p of ROUTES.find(r => r.id.startsWith('G9'))!.paths(SUB)) {
      const list = await call('GET', p, owner())
      expect(list.status, list.raw).toBe(200)
      expect(list.raw).toContain(inviteToken[SUB])
      expect(list.raw).toContain(created.body.token)
    }
  })
  it('R5 invite revoke, new and legacy form', async () => {
    await addOwner()
    expect((await call('DELETE', `/api/agents/${SUB}/channels/telegram/invites/${inviteToken[SUB]}`, owner())).body).toEqual({ ok: true })
    expect((await call('DELETE', `/api/agents/${MAIN}/telegram/invites/${inviteToken[MAIN]}`, owner())).body).toEqual({ ok: true })
  })
  it('R6 allowed removal, new and legacy form, user and group', async () => {
    await addOwner()
    expect((await call('DELETE', `/api/agents/${SUB}/channels/telegram/allowed/user/42`, owner())).status).toBe(200)
    expect((await call('DELETE', `/api/agents/${SUB}/telegram/allowed/group/-100`, owner())).status).toBe(200)
    const access = JSON.parse(readFileSync(join(chDir(SUB), 'access.json'), 'utf-8'))
    expect(access.allowFrom).toEqual(['43'])
    expect(access.groups).toEqual({})
  })
  it('R7 / R8 channel request approve and deny (Slack sub-agent)', async () => {
    await addOwner()
    expect((await call('POST', `/api/agents/${SUB}/channel-requests/${requestId[SUB]}/approve`, owner(), {})).body).toEqual({ ok: true })
    const slack = JSON.parse(readFileSync(join(chDir(SUB, 'slack'), 'access.json'), 'utf-8'))
    expect(Object.keys(slack.channels)).toEqual([`C-${SUB}`])
    expect((await call('POST', `/api/agents/${MAIN}/channel-requests/${requestId[MAIN]}/deny`, owner(), {})).body).toEqual({ ok: true })
  })
  it('the owner session and a full device key beside the owner\'s cookie pass too (R3, G9)', async () => {
    await addOwner()
    expect((await call('POST', `/api/agents/${SUB}/channels/telegram/approve`, {}, { code: 'ABC123' }, { kind: 'session', user: 'owner' } as Auth)).status).toBe(200)
    expect((await call('GET', `/api/agents/${SUB}/channels/telegram/invites`, withCookie(bearer(createDeviceKey('Bridge').key)))).status).toBe(200)
  })
  it('first run (no login yet): the shared token is the owner - the onboarding wizard\'s R1 and R3 pass', async () => {
    const setup = await call('POST', `/api/agents/${MAIN}/channels/telegram`, bearer(TOKEN), {})
    expect([setup.status, setup.body]).toEqual([400, { error: 'botToken is required' }])
    expect((await call('POST', `/api/agents/${MAIN}/channels/telegram/approve`, bearer(TOKEN), { code: 'ABC123' })).status).toBe(200)
  })
})
