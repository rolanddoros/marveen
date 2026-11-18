// Fork A1 (kanban 23e0c5c7, Ron 17674 tier A, decision 17697 option 2b, Johnny 17693): PUT /api/agents/:name writes
// an agent's CLAUDE.md, SOUL.md, .mcp.json, API key, custom provider, plan and model. With AGENT_TOKENS off every
// agent holds the shared dashboard token, so the route takes the owner (mayActAsOwner) once a login exists, with ONE
// exception the main agent's quota skills need: the SHARED token may send exactly {model: <a Claude model>}, Claude
// as the launcher classifies it (resolveProviderEnv), because a model id alone can route a whole session to a third
// party with the fleet's keys. Fixed order (K1): (a) neither owner nor shared token: 403, body unread; (b) shared
// token: body read once, capped; (c) anything else than a bare Claude model: 403 before any write; (d) then the
// agent-exists 404 and the main-agent 400. Real resolveAuth, sessions and device keys; every writer and readBody
// counted.
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
  ROOTS.dir = mk(j(td(), 'agent-put-owner-'))
  md(j(ROOTS.dir, 'store'), { recursive: true })
  return { ...(await importOriginal<typeof import('../config.js')>()), PROJECT_ROOT: ROOTS.dir, STORE_DIR: j(ROOTS.dir, 'store'), MAIN_AGENT_ID: 'host-main' }
})

// The four write families of the route: files (CLAUDE.md, SOUL.md, .mcp.json), the model, the other agent-config
// fields, the vault (API key).
const counts = vi.hoisted(() => ({ readBody: 0, files: 0, model: 0, config: 0, vault: 0 }))
vi.mock('../web/http-helpers.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/http-helpers.js')>()
  return { ...real, readBody: (...a: Parameters<typeof real.readBody>) => { counts.readBody++; return real.readBody(...a) } }
})
vi.mock('../web/atomic-write.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/atomic-write.js')>()),
  atomicWriteFileSync: () => { counts.files++ },
}))
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  writeAgentModel: () => { counts.model++ },
  writeAgentModelProfile: () => { counts.config++ },
  writeAgentCustomProvider: () => { counts.config++ },
  writeAgentAuthMode: () => { counts.config++ },
  writeAgentClaudePlan: () => { counts.config++ },
  writeAgentMemoryIsolation: () => { counts.config++ },
}))
vi.mock('../web/vault.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/vault.js')>()),
  setSecret: () => { counts.vault++ },
  deleteSecret: () => { counts.vault++ },
}))
vi.mock('../web/claude-cli-version.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/claude-cli-version.js')>()),
  measureClaudeCliVersion: async () => ({ version: null }),
}))

const { initDatabase, getDb, getDashboardUser } = await import('../db.js')
const { resolveAuth, SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')
const { tryHandleAuth, OWNER_SESSION_REQUIRED } = await import('../web/routes/auth.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { createDeviceKey, _clearDeviceKeyCacheForTest } = await import('../web/auth-device-keys.js')
const { _clearSessionCacheForTest, createSession } = await import('../web/auth-sessions.js')
type Auth = import('../web/routes/types.js').RouteContext['auth']
type Handler = (ctx: any, ...rest: any[]) => Promise<boolean>

afterAll(() => { rmSync(ROOTS.dir, { recursive: true, force: true }) })

const TOKEN = 'e'.repeat(64)
const AGENT = 'vera'
const MAIN = 'host-main'

function reqWith(headers: Record<string, string>, path: string, method: string, raw?: string): http.IncomingMessage {
  const req = Readable.from(raw === undefined ? [] : [Buffer.from(raw)]) as unknown as http.IncomingMessage
  req.headers = headers
  ;(req as any).url = path
  ;(req as any).method = method
  ;(req as any).socket = { remoteAddress: '127.0.0.1' }
  return req
}
async function hit(handler: Handler, method: string, path: string, headers: Record<string, string>, body?: unknown, auth?: Auth) {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(s: number) { out.status = s; return res }, setHeader() {},
    end(c?: string | Buffer) { if (c) try { out.body = JSON.parse(c.toString()) } catch { out.body = c.toString() } },
  }
  const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  const req = reqWith(headers, path, method, raw)
  const url = new URL(`http://127.0.0.1:3420${path}`)
  const resolved = auth ?? (resolveAuth(req, url, path, method, TOKEN) as Auth)
  expect(resolved, 'the request resolves to a principal').toBeTruthy()
  expect(await handler({ req, res, path: url.pathname, method, url, auth: resolved } as any, '/nonexistent-webdir')).toBe(true)
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
const put = (name: string, headers: Record<string, string>, body: unknown, auth?: Auth) =>
  hit(tryHandleAgents, 'PUT', `/api/agents/${name}`, headers, body, auth)
const writes = () => ({ files: counts.files, model: counts.model, config: counts.config, vault: counts.vault })
const NONE = { files: 0, model: 0, config: 0, vault: 0 }
const refused = (out: { status: number; body: any }, bodyRead: 0 | 1) => {
  expect(out.status, JSON.stringify(out.body)).toBe(403)
  expect(out.body).toEqual(OWNER_SESSION_REQUIRED)
  expect(writes()).toEqual(NONE)
  expect(counts.readBody).toBe(bodyRead)
}

// Every writable field, the shape the owner may send in one request.
const ALL_FIELDS = {
  claudeMd: '# vera', soulMd: 'soul', mcpJson: '{}', model: 'claude-sonnet-5-5',
  authMode: 'api', apiKey: 'sk-test-0123', claudePlan: '', memoryIsolation: true, modelProfile: null, customProvider: null,
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  mkdirSync(join(ROOTS.dir, 'agents', AGENT), { recursive: true })
})
beforeEach(async () => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users; DELETE FROM device_keys')
  _clearSessionCacheForTest()
  _clearDeviceKeyCacheForTest()
  cookie = ''
  for (const k of Object.keys(counts) as Array<keyof typeof counts>) counts[k] = 0
})

describe('the shared token may send exactly {model: <Claude model>} (option 2b)', () => {
  it('a Claude model passes after the first login: the model is written once, nothing else; the body read once', async () => {
    await addOwner()
    const out = await put(AGENT, bearer(TOKEN), { model: 'claude-sonnet-5-5' })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(writes()).toEqual({ ...NONE, model: 1 })
    expect(counts.readBody).toBe(1)
  })

  it('an alias that resolves to Claude passes too (decided and pinned: opus)', async () => {
    await addOwner()
    const out = await put(AGENT, bearer(TOKEN), { model: 'opus' })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(writes()).toEqual({ ...NONE, model: 1 })
  })

  // Johnny 17702: the main agent's scheduled guard "ron-tom-modell-orseg" PUTs {"model":"claude-sonnet-5-5[1m]"}, and
  // the quota skills use aliases. Measured here on the real functions, then through the route.
  const TOKEN_CLAUDE_FORMS = ['claude-sonnet-5-5[1m]', 'claude-opus-5-5[1m]', 'sonnet', 'fable']
  it('the launcher classifies the [1m] forms and the aliases as Claude (measured on the real functions)', async () => {
    const { resolveProviderEnv } = await import('../web/agent-process.js')
    const { resolveModelId } = await import('../web/agent-config.js')
    const { isValidModelId } = await import('../model-id.js')
    const measured = TOKEN_CLAUDE_FORMS.map((m) => [m, isValidModelId(m), resolveProviderEnv(resolveModelId(m), () => '""', null).provider])
    expect(measured).toEqual(TOKEN_CLAUDE_FORMS.map((m) => [m, true, 'claude']))
  })
  for (const model of TOKEN_CLAUDE_FORMS) {
    it(`token + {model: ${JSON.stringify(model)}} passes, the model written once`, async () => {
      await addOwner()
      const out = await put(AGENT, bearer(TOKEN), { model })
      expect(out.status, JSON.stringify(out.body)).toBe(200)
      expect(writes()).toEqual({ ...NONE, model: 1 })
    })
  }
  it('the ron-tom-modell-orseg call itself (ron, claude-sonnet-5-5[1m]) passes', async () => {
    mkdirSync(join(ROOTS.dir, 'agents', 'ron'), { recursive: true })
    await addOwner()
    const out = await put('ron', bearer(TOKEN), { model: 'claude-sonnet-5-5[1m]' })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(writes()).toEqual({ ...NONE, model: 1 })
  })

  const REFUSED: Array<[string, unknown]> = [
    ['deepseek-* (third-party provider)', { model: 'deepseek-chat' }],
    ['minimax-* (third-party provider)', { model: 'minimax-m2' }],
    ['an x/y id (OpenRouter)', { model: 'deepseek/deepseek-v4-pro' }],
    ['a bare tag (the local/Ollama branch)', { model: 'foo' }],
    ['Claude-x (case: not the launcher\'s claude- prefix)', { model: 'Claude-sonnet-5-5' }],
    ['a non-string model', { model: 42 }],
    ['an empty body object', {}],
    ['model + claudeMd', { model: 'claude-sonnet-5-5', claudeMd: '# x' }],
    ['model + modelProfile', { model: 'claude-sonnet-5-5', modelProfile: 'fast' }],
    ['model + customProvider:null', { model: 'claude-sonnet-5-5', customProvider: null }],
    ['model + apiKey', { model: 'claude-sonnet-5-5', apiKey: 'sk-x' }],
    ['an array body', [{ model: 'claude-sonnet-5-5' }]],
    ['a body that is not JSON', 'model=claude-sonnet-5-5'],
    ['a __proto__ key beside the model', '{"model":"claude-sonnet-5-5","__proto__":{"x":1}}'],
  ]
  for (const [label, body] of REFUSED) {
    it(`refused before any write: ${label}`, async () => {
      await addOwner()
      refused(await put(AGENT, bearer(TOKEN), body), 1)
    })
  }

  it('a body over the token cap is refused (read once, nothing written)', async () => {
    await addOwner()
    refused(await put(AGENT, bearer(TOKEN), { model: 'claude-sonnet-5-5', pad: 'x'.repeat(8000) }), 1)
  })

  it('a sub-agent\'s own token is 403 even before the first login, body unread', async () => {
    refused(await put(AGENT, bearer(TOKEN), { model: 'claude-sonnet-5-5' }, { kind: 'token', agent: 'zara', tokenAgent: 'zara' } as Auth), 0)
  })

  it('a federation peer, a bare full key and an operator key (even with the cookie) are 403, body unread', async () => {
    await addOwner()
    refused(await put(AGENT, bearer(TOKEN), { model: 'claude-sonnet-5-5' }, { kind: 'federation', peer: 'other-install' } as Auth), 0)
    refused(await put(AGENT, bearer(createDeviceKey('Bridge').key), { model: 'claude-sonnet-5-5' }), 0)
    refused(await put(AGENT, withCookie(bearer(createDeviceKey('Op', { scope: 'operator', expiresInDays: 7 }).key)), { model: 'claude-sonnet-5-5' }), 0)
  })
})

describe('order (K1): the decision comes before the agent-exists 404 and the main-agent 400', () => {
  it('token + a Claude model on an unknown name: 404 (a token caller tells known from unknown, as GET /api/agents does)', async () => {
    await addOwner()
    const out = await put('no-such-agent', bearer(TOKEN), { model: 'claude-sonnet-5-5' })
    expect(out.status).toBe(404)
    expect(writes()).toEqual(NONE)
  })
  it('token + any other body on an unknown name: 403, not 404', async () => {
    await addOwner()
    refused(await put('no-such-agent', bearer(TOKEN), { claudeMd: '# x' }), 1)
  })
  it('the main agent: token + a Claude model gets the 400 after the decision; any other body from a non-owner is 403', async () => {
    await addOwner()
    const ok = await put(MAIN, bearer(TOKEN), { model: 'claude-sonnet-5-5' })
    expect(ok.status).toBe(400)
    expect(writes()).toEqual(NONE)
    expect(counts.readBody).toBe(1)
    counts.readBody = 0
    refused(await put(MAIN, bearer(TOKEN), { claudeMd: '# x' }), 1)
  })
})

describe('the owner writes every field', () => {
  const OWNERS: Array<[string, () => Promise<{ status: number; body: any }>]> = [
    ['the owner session', () => put(AGENT, { 'content-type': 'application/json' }, ALL_FIELDS, { kind: 'session', user: 'owner' } as Auth)],
    ['the shared token with the owner\'s cookie', () => put(AGENT, withCookie(bearer(TOKEN)), ALL_FIELDS)],
    ['a full device key with the owner\'s cookie', () => put(AGENT, withCookie(bearer(createDeviceKey('Bridge').key)), ALL_FIELDS)],
  ]
  for (const [label, call] of OWNERS) {
    it(label, async () => {
      await addOwner()
      const out = await call()
      expect(out.status, JSON.stringify(out.body)).toBe(200)
      // CLAUDE.md + SOUL.md + .mcp.json; the model; memoryIsolation, modelProfile, customProvider, authMode, claudePlan;
      // the API key into the vault.
      expect(writes()).toEqual({ files: 3, model: 1, config: 5, vault: 1 })
      expect(counts.readBody).toBe(1)
    })
  }

  it('first run (no login yet): the shared token is the owner and writes every field', async () => {
    const out = await put(AGENT, bearer(TOKEN), ALL_FIELDS)
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(writes()).toEqual({ files: 3, model: 1, config: 5, vault: 1 })
  })
})

describe('the read stays readable with the shared token after the first login', () => {
  it('GET /api/agents/:name', async () => {
    await addOwner()
    const out = await hit(tryHandleAgents, 'GET', `/api/agents/${AGENT}`, bearer(TOKEN))
    expect(out.status).toBe(200)
  })
})
