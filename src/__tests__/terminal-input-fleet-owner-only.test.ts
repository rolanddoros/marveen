// Fork audit 2026-11-05 (server-api-data #1): POST /api/terminal-input and /api/fleet/{export,import}
// sat behind the shared dashboard token only. Every agent holds that token, so any agent could enable
// terminal input and then type into any pane via /api/agents/<n>/keys (the 2026-06-26 vector), or
// export the fleet (vault data included) / import over it. Once a dashboard login exists these now take
// the owner's session (mayActAsOwner: the session, or the Bridge key beside it); GET /api/terminal-input stays
// readable with the token. Upstream FLEETIMPORTGATE1022 gates only the vault export and the applied import; the
// fork gate also covers the plain export and the dry run (pinned below).
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'owner-only-root-'))
afterAll(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store'), MAIN_AGENT_ID: 'host-main',
}))

const toggle = { value: false }
vi.mock('../web/terminal-input-store.js', () => ({
  readTerminalInputEnabled: () => toggle.value,
  writeTerminalInputEnabled: (v: boolean) => { toggle.value = v; return v },
}))
const fleetTransfer = { exported: 0, imported: 0 }
vi.mock('../web/fleet-transfer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/fleet-transfer.js')>()),
  exportFleet: async () => { fleetTransfer.exported++; return { data: '{}', exportedAt: '2026-11-05T00:00:00Z' } },
  importFleet: async () => { fleetTransfer.imported++; return { applied: false } },
}))

const { tryHandleAgentTerminal } = await import('../web/routes/agent-terminal.js')
const { tryHandleFleet } = await import('../web/routes/fleet.js')
const { tryHandleAuth } = await import('../web/routes/auth.js')
const { initDatabase, getDb } = await import('../db.js')
const { _clearSessionCacheForTest } = await import('../web/auth-sessions.js')
type Auth = import('../web/routes/types.js').RouteContext['auth']

async function call(handler: (ctx: any) => Promise<boolean>, method: string, path: string, body: unknown, auth: Auth) {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(s: number) { out.status = s; return res }, setHeader() {},
    end(c?: string | Buffer) { if (c) try { out.body = JSON.parse(c.toString()) } catch { out.body = c.toString() } },
  }
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = {}
  ;(req as any).socket = { remoteAddress: '127.0.0.1' }
  const url = new URL(`http://localhost${path}`)
  expect(await handler({ req, res, path: url.pathname, method, url, auth } as any)).toBe(true)
  return out
}
const TOKEN: Auth = { kind: 'token', agent: 'some-agent' }
const SESSION: Auth = { kind: 'session', user: 'owner' }
const addOwner = () => call(tryHandleAuth, 'POST', '/api/auth/users', { username: 'owner', password: 'super-secret-pw' }, TOKEN)

beforeAll(() => { process.env.NODE_ENV = 'test'; initDatabase(':memory:') })
beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
  toggle.value = false
  fleetTransfer.exported = 0; fleetTransfer.imported = 0
})

describe('terminal-input toggle: owner session once a login exists', () => {
  it('the shared token cannot enable it (403, toggle stays off)', async () => {
    expect((await addOwner()).status).toBe(201)
    const r = await call(tryHandleAgentTerminal, 'POST', '/api/terminal-input', { enabled: true }, TOKEN)
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('owner_session_required')
    expect(toggle.value).toBe(false)
  })
  it('the shared token can still read the state', async () => {
    await addOwner()
    const r = await call(tryHandleAgentTerminal, 'GET', '/api/terminal-input', undefined, TOKEN)
    expect(r.body).toEqual({ enabled: false })
  })
  it('the owner session can flip it', async () => {
    await addOwner()
    const r = await call(tryHandleAgentTerminal, 'POST', '/api/terminal-input', { enabled: true }, SESSION)
    expect(r.body).toEqual({ enabled: true })
    expect(toggle.value).toBe(true)
  })
  it('first-run (no login yet): the token still works, as for every other credential route', async () => {
    const r = await call(tryHandleAgentTerminal, 'POST', '/api/terminal-input', { enabled: true }, TOKEN)
    expect(r.body).toEqual({ enabled: true })
  })
})

describe('fleet export/import: owner session once a login exists', () => {
  it('export with the shared token is 403 and nothing is exported', async () => {
    await addOwner()
    const r = await call(tryHandleFleet, 'GET', '/api/fleet/export', undefined, TOKEN)
    expect(r.status).toBe(403)
    expect(fleetTransfer.exported).toBe(0)
  })
  it('import with the shared token is 403 and nothing is imported', async () => {
    await addOwner()
    const r = await call(tryHandleFleet, 'POST', '/api/fleet/import?apply=true', { version: 1 }, TOKEN)
    expect(r.status).toBe(403)
    expect(fleetTransfer.imported).toBe(0)
  })
  it('the plain export and the dry-run import (left on the token upstream) are 403 with the shared token too', async () => {
    await addOwner()
    expect((await call(tryHandleFleet, 'GET', '/api/fleet/export', undefined, TOKEN)).status).toBe(403)
    const dry = await call(tryHandleFleet, 'POST', '/api/fleet/import', { version: 1 }, TOKEN)
    expect(dry.status).toBe(403)
    expect(fleetTransfer.exported + fleetTransfer.imported).toBe(0)
  })
  it('a bare full device key (no owner cookie beside it) is refused on all three', async () => {
    await addOwner()
    const KEY: Auth = { kind: 'device', scope: 'full', device: 'laptop' } as Auth
    expect((await call(tryHandleAgentTerminal, 'POST', '/api/terminal-input', { enabled: true }, KEY)).status).toBe(403)
    expect((await call(tryHandleFleet, 'GET', '/api/fleet/export', undefined, KEY)).status).toBe(403)
    expect((await call(tryHandleFleet, 'POST', '/api/fleet/import?apply=true', { version: 1 }, KEY)).status).toBe(403)
    expect(toggle.value).toBe(false)
  })
  it('the owner session exports', async () => {
    await addOwner()
    const r = await call(tryHandleFleet, 'GET', '/api/fleet/export', undefined, SESSION)
    expect(r.status).toBe(200)
    expect(fleetTransfer.exported).toBe(1)
  })
})
