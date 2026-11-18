// Kanban 8f51c983 (Ron 17451 N1, Johnny 17455, plan approved by Ron 17674): PUT /api/agents/:name/capabilities and
// PUT /api/agents/:name/security sat behind the outer Bearer gate only. With AGENT_TOKENS off every agent sends the
// SHARED dashboard token, so any agent could rewrite another agent's roster tags (embedded in every peer's CLAUDE.md)
// or move a sub-agent to a looser security profile (its hook settings are regenerated from it). Once a dashboard
// login exists both take the owner (mayActAsOwner: the session, the shared token with the owner's cookie, or a full
// Bridge key beside it). The gate sits before the agent-exists check and before the body is read: a non-owner gets
// 403 for any name (no name oracle) and no body is parsed. The GETs stay readable with the token.
// Real resolveAuth, real sessions, real device keys; the writers and readBody are counted.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = vi.hoisted(() => ({ dir: '' }))
vi.mock('../config.js', async (importOriginal) => {
  const { mkdtempSync: mk, mkdirSync: md } = await import('node:fs')
  const { tmpdir: td } = await import('node:os')
  const { join: j } = await import('node:path')
  ROOTS.dir = mk(j(td(), 'agent-puts-owner-'))
  md(j(ROOTS.dir, 'store'), { recursive: true })
  return { ...(await importOriginal<typeof import('../config.js')>()), PROJECT_ROOT: ROOTS.dir, STORE_DIR: j(ROOTS.dir, 'store'), MAIN_AGENT_ID: 'host-main' }
})

const counts = vi.hoisted(() => ({ readBody: 0, capabilities: 0, securityProfile: 0, settingsFromProfile: 0 }))
vi.mock('../web/http-helpers.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/http-helpers.js')>()
  return { ...real, readBody: (...a: Parameters<typeof real.readBody>) => { counts.readBody++; return real.readBody(...a) } }
})
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  writeAgentCapabilities: () => { counts.capabilities++ },
  writeAgentSecurityProfile: () => { counts.securityProfile++ },
}))
vi.mock('../web/agent-scaffold.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-scaffold.js')>()),
  writeAgentSettingsFromProfile: () => { counts.settingsFromProfile++ },
}))
vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => false,
}))
vi.mock('../web/profiles.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/profiles.js')>()
  return { ...real, loadProfileTemplate: (id: string) => ({ ...real.resolveProfileTemplate(id).profile, id }) }
})

const { initDatabase, getDb, getDashboardUser } = await import('../db.js')
const { resolveAuth, SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')
const { tryHandleAuth, OWNER_SESSION_REQUIRED } = await import('../web/routes/auth.js')
const { tryHandleFleetQ } = await import('../web/routes/fleet-q.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { createDeviceKey, _clearDeviceKeyCacheForTest } = await import('../web/auth-device-keys.js')
const { _clearSessionCacheForTest, createSession } = await import('../web/auth-sessions.js')
type Auth = import('../web/routes/types.js').RouteContext['auth']
type Handler = (ctx: any, ...rest: any[]) => Promise<boolean>

afterAll(() => { rmSync(ROOTS.dir, { recursive: true, force: true }) })

const TOKEN = 'd'.repeat(64)
const AGENT = 'vera'

function reqWith(headers: Record<string, string>, path: string, method: string, body?: unknown): http.IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = headers
  ;(req as any).url = path
  ;(req as any).method = method
  ;(req as any).socket = { remoteAddress: '127.0.0.1' }
  return req
}

// One call through a real handler. `auth` given: that principal; otherwise resolveAuth decides from the headers.
async function hit(handler: Handler, method: string, path: string, headers: Record<string, string>, body?: unknown, auth?: Auth) {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(s: number) { out.status = s; return res }, setHeader() {},
    end(c?: string | Buffer) { if (c) try { out.body = JSON.parse(c.toString()) } catch { out.body = c.toString() } },
  }
  const req = reqWith(headers, path, method, body)
  const url = new URL(`http://127.0.0.1:3420${path}`)
  const resolved = auth ?? (resolveAuth(req, url, path, method, TOKEN) as Auth)
  expect(resolved, 'the request resolves to a principal').toBeTruthy()
  expect(await handler({ req, res, path: url.pathname, method, url, auth: resolved } as any)).toBe(true)
  return out
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' })
let cookie = ''
const withCookie = (h: Record<string, string>) => ({ ...h, cookie: `${SESSION_COOKIE_NAME}=${cookie}` })
async function addOwner() {
  const r = await hit(tryHandleAuth, 'POST', '/api/auth/users', bearer(TOKEN), { username: 'owner', password: 'super-secret-pw' })
  expect(r.status).toBe(201)
  cookie = createSession({ userId: getDashboardUser('owner')!.id, username: 'owner' })
  counts.readBody = 0 // the user creation above read its own body; count only the route under test
}

// The two routes, each with its body, its writers and its success shape.
const ROUTES = [
  {
    label: 'PUT /api/agents/:name/capabilities',
    handler: tryHandleFleetQ as Handler,
    path: (n: string) => `/api/agents/${n}/capabilities`,
    body: { capabilities: ['browser'] },
    writes: () => ({ capabilities: counts.capabilities }),
    wrote: { capabilities: 1 },
    none: { capabilities: 0 },
  },
  {
    label: 'PUT /api/agents/:name/security',
    handler: tryHandleAgents as Handler,
    path: (n: string) => `/api/agents/${n}/security`,
    body: { profile: 'default' },
    writes: () => ({ securityProfile: counts.securityProfile, settingsFromProfile: counts.settingsFromProfile }),
    wrote: { securityProfile: 1, settingsFromProfile: 1 },
    none: { securityProfile: 0, settingsFromProfile: 0 },
  },
] as const

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  mkdirSync(join(ROOTS.dir, 'agents', AGENT), { recursive: true })
})
beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users; DELETE FROM device_keys')
  _clearSessionCacheForTest()
  _clearDeviceKeyCacheForTest()
  cookie = ''
  for (const k of Object.keys(counts) as Array<keyof typeof counts>) counts[k] = 0
})

for (const r of ROUTES) {
  describe(r.label, () => {
    const refused = (out: { status: number; body: any }) => {
      expect(out.status).toBe(403)
      expect(out.body).toEqual(OWNER_SESSION_REQUIRED)
      expect(r.writes()).toEqual(r.none)
      expect(counts.readBody, 'no body is read for a caller who may not act').toBe(0)
    }
    const passed = (out: { status: number; body: any }) => {
      expect(out.status, JSON.stringify(out.body)).toBe(200)
      expect(out.body.ok).toBe(true)
      expect(r.writes()).toEqual(r.wrote)
    }

    it('first run (no dashboard login yet): the shared token still passes and writes', async () => {
      passed(await hit(r.handler, 'PUT', r.path(AGENT), bearer(TOKEN), r.body))
    })

    it('after the first login: the shared token alone is 403 owner_session_required, nothing written', async () => {
      await addOwner()
      refused(await hit(r.handler, 'PUT', r.path(AGENT), bearer(TOKEN), r.body))
    })

    it('after the first login: an unknown agent name is 403 too, not 404 (no name oracle)', async () => {
      await addOwner()
      refused(await hit(r.handler, 'PUT', r.path('no-such-agent'), bearer(TOKEN), r.body))
      // CONTROL: the owner gets the route's own 404 for that name, so the 403 above is the gate's.
      const owner = await hit(r.handler, 'PUT', r.path('no-such-agent'), withCookie(bearer(TOKEN)), r.body)
      expect(owner.status).toBe(404)
    })

    it('a sub-agent\'s own token is 403 even before the first login', async () => {
      refused(await hit(r.handler, 'PUT', r.path(AGENT), bearer(TOKEN), r.body, { kind: 'token', agent: 'zara', tokenAgent: 'zara' } as Auth))
    })

    it('a federation peer is 403', async () => {
      await addOwner()
      refused(await hit(r.handler, 'PUT', r.path(AGENT), bearer(TOKEN), r.body, { kind: 'federation', peer: 'other-install' } as Auth))
    })

    it('the owner session passes and writes', async () => {
      await addOwner()
      passed(await hit(r.handler, 'PUT', r.path(AGENT), { 'content-type': 'application/json' }, r.body, { kind: 'session', user: 'owner' } as Auth))
    })

    it('the shared token WITH the owner\'s cookie passes and writes (the dashboard browser)', async () => {
      await addOwner()
      passed(await hit(r.handler, 'PUT', r.path(AGENT), withCookie(bearer(TOKEN)), r.body))
    })

    it('a full device key alone is 403; beside the owner\'s cookie it passes', async () => {
      await addOwner()
      const key = createDeviceKey('Bridge').key
      refused(await hit(r.handler, 'PUT', r.path(AGENT), bearer(key), r.body))
      passed(await hit(r.handler, 'PUT', r.path(AGENT), withCookie(bearer(key)), r.body))
    })

    it('an operator-scope device key is 403, even beside the owner\'s cookie', async () => {
      await addOwner()
      const op = createDeviceKey('Op', { scope: 'operator', expiresInDays: 7 }).key
      refused(await hit(r.handler, 'PUT', r.path(AGENT), withCookie(bearer(op)), r.body))
    })
  })
}

describe('the reads stay readable with the shared token after the first login', () => {
  it('GET /api/agents/:name/security', async () => {
    await addOwner()
    const out = await hit(tryHandleAgents, 'GET', `/api/agents/${AGENT}/security`, bearer(TOKEN))
    expect(out.status).toBe(200)
    expect(typeof out.body.profile).toBe('string')
  })
  it('GET /.well-known/fleetq', async () => {
    await addOwner()
    const out = await hit(tryHandleFleetQ, 'GET', '/.well-known/fleetq', bearer(TOKEN))
    expect(out.status).toBe(200)
    expect(Object.keys(out.body)).toContain(AGENT)
  })
})
