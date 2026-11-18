// Fork A3 (kanban 4314eef9, Ron 17674 tier A, plan Ron 17751): PUT /api/agents/:name/remote sat behind the outer
// Bearer gate only. The next start of an agent with a remote host runs its session on that host over ssh with the
// router's keys, without the local hook/settings scaffolding, and its messages and schedules follow it there; so
// with the shared token any agent could move any sub-agent off the box. Once a dashboard login exists the route takes
// the owner (mayActAsOwner), set and clear alike, before the main-agent and agent-exists checks and before the body.
// Real resolveAuth, sessions and device keys; readBody, the writer and the remote-status cache invalidates are counted.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = vi.hoisted(() => ({ dir: '' }))
vi.mock('../config.js', async (importOriginal) => {
  const { mkdtempSync: mk, mkdirSync: md } = await import('node:fs')
  const { tmpdir: td } = await import('node:os')
  const { join: j } = await import('node:path')
  ROOTS.dir = mk(j(td(), 'agent-remote-owner-'))
  md(j(ROOTS.dir, 'store'), { recursive: true })
  return { ...(await importOriginal<typeof import('../config.js')>()), PROJECT_ROOT: ROOTS.dir, STORE_DIR: j(ROOTS.dir, 'store'), MAIN_AGENT_ID: 'host-main' }
})

const counts = vi.hoisted(() => ({ readBody: 0, writer: [] as Array<[string, string, string]>, invalidate: 0 }))
vi.mock('../web/http-helpers.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/http-helpers.js')>()
  return { ...real, readBody: (...a: Parameters<typeof real.readBody>) => { counts.readBody++; return real.readBody(...a) } }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...real,
    writeAgentRemoteConfig: (name: string, host: string, workdir: string) => {
      counts.writer.push([name, host, workdir])
      return real.writeAgentRemoteConfig(name, host, workdir)
    },
  }
})
vi.mock('../web/remote-status-cache.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/remote-status-cache.js')>()
  class CountingCache<T> extends real.RemoteStatusCache<T> {
    override invalidate(key: string): void { counts.invalidate++; super.invalidate(key) }
  }
  return { ...real, RemoteStatusCache: CountingCache }
})

const { initDatabase, getDb, getDashboardUser } = await import('../db.js')
const { resolveAuth, SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')
const { tryHandleAuth, OWNER_SESSION_REQUIRED } = await import('../web/routes/auth.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { createDeviceKey, _clearDeviceKeyCacheForTest } = await import('../web/auth-device-keys.js')
const { _clearSessionCacheForTest, createSession } = await import('../web/auth-sessions.js')
type Auth = import('../web/routes/types.js').RouteContext['auth']

afterAll(() => { rmSync(ROOTS.dir, { recursive: true, force: true }) })

const TOKEN = 'f'.repeat(64)
const AGENT = 'vera'
const CFG = () => join(ROOTS.dir, 'agents', AGENT, 'agent-config.json')
const SEEDED = { model: 'claude-sonnet-5', remoteHost: 'oldbox', remoteWorkdir: '/srv/old' }
const readCfg = () => JSON.parse(readFileSync(CFG(), 'utf-8'))
const SET = JSON.stringify({ host: 'devbox', workdir: '/home/u/p' })
const CLEAR = JSON.stringify({ host: '', workdir: '' })
const JSON_CT = { 'content-type': 'application/json' }

async function call(name: string, headers: Record<string, string>, body: string, auth?: Auth) {
  const path = `/api/agents/${name}/remote`
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(s: number) { out.status = s; return res }, setHeader() {},
    end(c?: string | Buffer) { if (c) try { out.body = JSON.parse(c.toString()) } catch { out.body = c.toString() } },
  }
  const req = Readable.from([Buffer.from(body)]) as unknown as http.IncomingMessage
  req.headers = { ...JSON_CT, ...headers }
  ;(req as any).url = path
  ;(req as any).method = 'PUT'
  ;(req as any).socket = { remoteAddress: '127.0.0.1' }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  const resolved = auth ?? (resolveAuth(req, url, url.pathname, 'PUT', TOKEN) as Auth)
  expect(resolved, 'the request resolves to a principal').toBeTruthy()
  expect(await tryHandleAgents({ req, res, path: url.pathname, method: 'PUT', url, auth: resolved } as any, '/nonexistent-webdir')).toBe(true)
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
const refused = (out: { status: number; body: any }) => {
  expect(out.status, JSON.stringify(out.body)).toBe(403)
  expect(out.body).toEqual(OWNER_SESSION_REQUIRED)
  expect(counts.readBody, 'no body is read before the refusal').toBe(0)
  expect(counts.writer, 'the writer never runs').toEqual([])
  expect(counts.invalidate, 'no cache is invalidated').toBe(0)
  expect(readCfg(), 'agent-config.json is untouched').toEqual(SEEDED)
}

beforeAll(() => { process.env.NODE_ENV = 'test'; initDatabase(':memory:') })
beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users; DELETE FROM device_keys')
  _clearSessionCacheForTest()
  _clearDeviceKeyCacheForTest()
  cookie = ''
  counts.readBody = 0; counts.writer = []; counts.invalidate = 0
  mkdirSync(join(ROOTS.dir, 'agents', AGENT), { recursive: true })
  writeFileSync(CFG(), JSON.stringify(SEEDED, null, 2))
})

describe('after the first login the shared token cannot set or clear a remote host (no body read, no write)', () => {
  it('set', async () => {
    await addOwner()
    refused(await call(AGENT, bearer(TOKEN), SET))
  })
  it('clear', async () => {
    await addOwner()
    refused(await call(AGENT, bearer(TOKEN), CLEAR))
  })
  it('the main agent\'s name and an unknown name answer 403 too, not 400/404 (no name oracle)', async () => {
    await addOwner()
    refused(await call('host-main', bearer(TOKEN), SET))
    refused(await call('nobody', bearer(TOKEN), SET))
  })
})

describe('other principals are refused, body unread', () => {
  it('a sub-agent\'s own token, even before the first login (set and clear)', async () => {
    const sub = { kind: 'token', agent: 'zara', tokenAgent: 'zara' } as Auth
    refused(await call(AGENT, bearer(TOKEN), SET, sub))
    refused(await call(AGENT, bearer(TOKEN), CLEAR, sub))
  })
  it('a federation peer, a bare full key, an operator key with the owner\'s cookie', async () => {
    await addOwner()
    refused(await call(AGENT, bearer(TOKEN), SET, { kind: 'federation', peer: 'other-install' } as Auth))
    refused(await call(AGENT, bearer(createDeviceKey('Bridge').key), CLEAR))
    refused(await call(AGENT, withCookie(bearer(createDeviceKey('Op', { scope: 'operator', expiresInDays: 7 }).key)), SET))
  })
})

describe('the owner sets and clears; the writer and both cache invalidates run once', () => {
  const setOk = (out: { status: number; body: any }) => {
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(out.body).toEqual({ ok: true, remoteHost: 'devbox', remoteWorkdir: '/home/u/p' })
    expect(counts.readBody).toBe(1)
    expect(counts.invalidate).toBe(2)
    expect(readCfg()).toEqual({ model: 'claude-sonnet-5', remoteHost: 'devbox', remoteWorkdir: '/home/u/p' })
  }
  it('token + the owner\'s cookie: set (values passed as sent, trimmed by the writer)', async () => {
    await addOwner()
    setOk(await call(AGENT, withCookie(bearer(TOKEN)), JSON.stringify({ host: ' devbox ', workdir: '/home/u/p ' })))
    expect(counts.writer).toEqual([[AGENT, ' devbox ', '/home/u/p ']])
  })
  it('token + the owner\'s cookie: clear -> {ok, null, null}, fields removed', async () => {
    await addOwner()
    const out = await call(AGENT, withCookie(bearer(TOKEN)), CLEAR)
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(out.body).toEqual({ ok: true, remoteHost: null, remoteWorkdir: null })
    expect(counts.writer).toEqual([[AGENT, '', '']])
    expect(counts.invalidate).toBe(2)
    expect(readCfg()).toEqual({ model: 'claude-sonnet-5' })
  })
  it('the owner session (set)', async () => {
    await addOwner()
    setOk(await call(AGENT, {}, SET, { kind: 'session', user: 'owner' } as Auth))
  })
  it('a full device key beside the owner\'s cookie (set)', async () => {
    await addOwner()
    setOk(await call(AGENT, withCookie(bearer(createDeviceKey('Bridge').key)), SET))
  })
  it('first run (no login yet): the shared token is the owner (set)', async () => {
    setOk(await call(AGENT, bearer(TOKEN), SET))
  })
})

describe('behind the gate the owner gets the old answers unchanged', () => {
  it('main agent 400, unknown agent 404, bad JSON 400 (no write)', async () => {
    await addOwner()
    const main = await call('host-main', withCookie(bearer(TOKEN)), SET)
    expect([main.status, main.body]).toEqual([400, { error: 'Main agent is always local' }])
    const unknown = await call('nobody', withCookie(bearer(TOKEN)), SET)
    expect([unknown.status, unknown.body]).toEqual([404, { error: 'Agent not found' }])
    const bad = await call(AGENT, withCookie(bearer(TOKEN)), '{not json')
    expect([bad.status, bad.body]).toEqual([400, { error: 'invalid JSON' }])
    expect(counts.writer).toEqual([])
    expect(counts.invalidate).toBe(0)
    expect(readCfg()).toEqual(SEEDED)
  })
  it('a value the writer rejects: 400 with its error, config untouched', async () => {
    await addOwner()
    const out = await call(AGENT, withCookie(bearer(TOKEN)), JSON.stringify({ host: 'devbox', workdir: '' }))
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/^Both remoteHost and remoteWorkdir are required/)
    expect(counts.writer).toEqual([[AGENT, 'devbox', '']])
    expect(counts.invalidate).toBe(0)
    expect(readCfg()).toEqual(SEEDED)
  })
})
