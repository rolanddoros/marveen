// Fork A2 (kanban 4fccfbee, Ron 17674 tier A, plan direction Ron 17725 R1, Kevin 17728): POST /api/agents/import sat
// behind the outer Bearer gate only. The importers copy the whole unpacked agent/ dir (CLAUDE.md, SOUL.md, .mcp.json,
// .claude/settings.json with its hooks, skills, agent-config.json, channel files), so with the shared token any agent
// could overwrite another agent wholesale, or create a new one carrying any config, stepping around the owner gates
// on PUT /api/agents/:name and /security. Once a dashboard login exists the WHOLE route takes the owner
// (mayActAsOwner), before the body is read, with or without overwrite, agent and fleet bundle alike.
// Real resolveAuth, sessions and device keys; readBody, the two importers and the context-guard seed are counted.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'

const ROOTS = vi.hoisted(() => ({ dir: '' }))
vi.mock('../config.js', async (importOriginal) => {
  const { mkdtempSync: mk, mkdirSync: md } = await import('node:fs')
  const { tmpdir: td } = await import('node:os')
  const { join: j } = await import('node:path')
  ROOTS.dir = mk(j(td(), 'agent-import-owner-'))
  md(j(ROOTS.dir, 'store'), { recursive: true })
  return { ...(await importOriginal<typeof import('../config.js')>()), PROJECT_ROOT: ROOTS.dir, STORE_DIR: j(ROOTS.dir, 'store'), MAIN_AGENT_ID: 'host-main' }
})

const counts = vi.hoisted(() => ({ readBody: 0, agentImport: 0, fleetImport: 0, seed: 0, overwrite: [] as boolean[] }))
vi.mock('../web/http-helpers.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/http-helpers.js')>()
  return { ...real, readBody: (...a: Parameters<typeof real.readBody>) => { counts.readBody++; return real.readBody(...a) } }
})
// A bundle whose bytes start with FLEET is a fleet bundle here; anything else a single agent.
vi.mock('../web/agent-bundle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-bundle.js')>()),
  peekBundleKind: (b: Buffer) => (b.subarray(0, 5).toString() === 'FLEET' ? 'fleet' : 'agent'),
  importAgentBundle: (_b: Buffer, opts: { overwrite?: boolean }) => {
    counts.agentImport++; counts.overwrite.push(opts.overwrite === true)
    return { name: 'vera', overwritten: opts.overwrite === true, manifest: { includesSecrets: false } }
  },
  importAllAgentsBundle: (_b: Buffer, opts: { overwrite?: boolean }) => {
    counts.fleetImport++; counts.overwrite.push(opts.overwrite === true)
    return { imported: [{ name: 'vera' }], skipped: [], includesSecrets: false }
  },
}))
vi.mock('../web/context-guard-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/context-guard-store.js')>()),
  seedContextGuardForNewAgent: () => { counts.seed++ },
}))

const { initDatabase, getDb, getDashboardUser } = await import('../db.js')
const { resolveAuth, SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')
const { tryHandleAuth, OWNER_SESSION_REQUIRED } = await import('../web/routes/auth.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { createDeviceKey, _clearDeviceKeyCacheForTest } = await import('../web/auth-device-keys.js')
const { _clearSessionCacheForTest, createSession } = await import('../web/auth-sessions.js')
type Auth = import('../web/routes/types.js').RouteContext['auth']

afterAll(() => { rmSync(ROOTS.dir, { recursive: true, force: true }) })

const TOKEN = 'f'.repeat(64)
const BOUNDARY = 'xBOUNDARYx'

function multipart(data: string, overwrite?: string): Buffer {
  const parts = [
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="b.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n${data}\r\n`,
  ]
  if (overwrite !== undefined) parts.push(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\n${overwrite}\r\n`)
  parts.push(`--${BOUNDARY}--\r\n`)
  return Buffer.from(parts.join(''))
}
const MP = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }
const RAW = { 'content-type': 'application/gzip' }

async function call(path: string, headers: Record<string, string>, body: Buffer, auth?: Auth) {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(s: number) { out.status = s; return res }, setHeader() {},
    end(c?: string | Buffer) { if (c) try { out.body = JSON.parse(c.toString()) } catch { out.body = c.toString() } },
  }
  const req = Readable.from([body]) as unknown as http.IncomingMessage
  req.headers = headers
  ;(req as any).url = path
  ;(req as any).method = 'POST'
  ;(req as any).socket = { remoteAddress: '127.0.0.1' }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  const resolved = auth ?? (resolveAuth(req, url, url.pathname, 'POST', TOKEN) as Auth)
  expect(resolved, 'the request resolves to a principal').toBeTruthy()
  expect(await tryHandleAgents({ req, res, path: url.pathname, method: 'POST', url, auth: resolved } as any, '/nonexistent-webdir')).toBe(true)
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
const imports = () => ({ agentImport: counts.agentImport, fleetImport: counts.fleetImport, seed: counts.seed })
const refused = (out: { status: number; body: any }) => {
  expect(out.status, JSON.stringify(out.body)).toBe(403)
  expect(out.body).toEqual(OWNER_SESSION_REQUIRED)
  expect(imports()).toEqual({ agentImport: 0, fleetImport: 0, seed: 0 })
  expect(counts.readBody, 'no body is read before the refusal').toBe(0)
}

// Every way to ask for an import: [label, path, headers, body, kind, overwrite asked].
const REQUESTS: Array<[string, string, Record<string, string>, Buffer, 'agent' | 'fleet', boolean]> = [
  ['agent bundle, multipart, no overwrite', '/api/agents/import', MP, multipart('AGENT'), 'agent', false],
  ['agent bundle, multipart overwrite=1', '/api/agents/import', MP, multipart('AGENT', '1'), 'agent', true],
  ['agent bundle, multipart overwrite=true', '/api/agents/import', MP, multipart('AGENT', 'true'), 'agent', true],
  ['agent bundle, raw body, no overwrite', '/api/agents/import', RAW, Buffer.from('AGENT'), 'agent', false],
  ['agent bundle, raw body ?overwrite=1', '/api/agents/import?overwrite=1', RAW, Buffer.from('AGENT'), 'agent', true],
  ['fleet bundle, multipart, no overwrite', '/api/agents/import', MP, multipart('FLEET'), 'fleet', false],
  ['fleet bundle, multipart overwrite=1', '/api/agents/import', MP, multipart('FLEET', '1'), 'fleet', true],
]

beforeAll(() => { process.env.NODE_ENV = 'test'; initDatabase(':memory:') })
beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users; DELETE FROM device_keys')
  _clearSessionCacheForTest()
  _clearDeviceKeyCacheForTest()
  cookie = ''
  counts.readBody = 0; counts.agentImport = 0; counts.fleetImport = 0; counts.seed = 0; counts.overwrite = []
})

describe('after the first login the shared token cannot import at all (no body read, no importer)', () => {
  for (const [label, path, headers, body] of REQUESTS) {
    it(label, async () => {
      await addOwner()
      refused(await call(path, { ...headers, ...bearer(TOKEN) }, body))
    })
  }
})

describe('the owner imports, with and without overwrite; the importer runs exactly once with that overwrite', () => {
  for (const [label, path, headers, body, kind, overwrite] of REQUESTS) {
    it(`token + the owner's cookie: ${label}`, async () => {
      await addOwner()
      const out = await call(path, withCookie({ ...headers, ...bearer(TOKEN) }), body)
      expect(out.status, JSON.stringify(out.body)).toBe(200)
      expect(imports()).toEqual(kind === 'fleet' ? { agentImport: 0, fleetImport: 1, seed: 1 } : { agentImport: 1, fleetImport: 0, seed: 1 })
      expect(counts.overwrite).toEqual([overwrite])
      expect(counts.readBody).toBe(1)
    })
  }
  it('the owner session (overwrite=1)', async () => {
    await addOwner()
    const out = await call('/api/agents/import', MP, multipart('AGENT', '1'), { kind: 'session', user: 'owner' } as Auth)
    expect(out.status).toBe(200)
    expect(counts.overwrite).toEqual([true])
  })
  it('a full device key beside the owner\'s cookie (no overwrite, then overwrite=1)', async () => {
    await addOwner()
    const key = createDeviceKey('Bridge').key
    expect((await call('/api/agents/import', withCookie({ ...MP, ...bearer(key) }), multipart('AGENT'))).status).toBe(200)
    expect((await call('/api/agents/import', withCookie({ ...MP, ...bearer(key) }), multipart('AGENT', '1'))).status).toBe(200)
    expect(counts.overwrite).toEqual([false, true])
  })
  it('first run (no login yet): the shared token is the owner and imports', async () => {
    const out = await call('/api/agents/import', { ...MP, ...bearer(TOKEN) }, multipart('AGENT', '1'))
    expect(out.status).toBe(200)
    expect(counts.overwrite).toEqual([true])
  })
})

describe('other principals are refused, body unread', () => {
  it('a sub-agent\'s own token, even before the first login', async () => {
    refused(await call('/api/agents/import', { ...MP, ...bearer(TOKEN) }, multipart('AGENT'), { kind: 'token', agent: 'zara', tokenAgent: 'zara' } as Auth))
  })
  it('a federation peer, a bare full key, an operator key with the owner\'s cookie', async () => {
    await addOwner()
    refused(await call('/api/agents/import', { ...MP, ...bearer(TOKEN) }, multipart('AGENT'), { kind: 'federation', peer: 'other-install' } as Auth))
    refused(await call('/api/agents/import', { ...MP, ...bearer(createDeviceKey('Bridge').key) }, multipart('AGENT')))
    refused(await call('/api/agents/import', withCookie({ ...MP, ...bearer(createDeviceKey('Op', { scope: 'operator', expiresInDays: 7 }).key) }), multipart('AGENT')))
  })
})
