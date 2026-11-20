// Card 658026c5 (Decisions page, PR1): the /api/decisions API. What must hold:
// - only the OWNER answers (mayActAsOwner, the approve predicate): the shared token, a sub-agent's own token and a
//   bare device key get 403, and the row stays open;
// - an answer is idempotent: a second answer is a 409 carrying the first, with no second event and no second
//   [DECISION_ANSWER] message;
// - a sub-agent token files, reads, withdraws and supersedes only as itself and sees only its own rows;
// - answered_by is written by the server, never taken from the body;
// - both tables are on the db-write gate's security list, and the agent-token allowlist leaves the answer route out.
import { describe, it, expect, vi, afterAll } from 'vitest'
import http from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'marveen' }))
const ROSTER = new Set(['marveen', 'kevin', 'soma', 'dennis'])
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  isKnownAgent: (n: string) => ROSTER.has(n),
}))

import { initDatabase, createDashboardUser, getDb, getDecision, listDecisionEvents, decisionAnswerText } from '../db.js'
import { tryHandleDecisions, parseDecisionFiling, carriesSecretShape } from '../web/routes/decisions.js'
import { createSession } from '../web/auth-sessions.js'
import { SESSION_COOKIE_NAME, isAgentAllowed, agentIdentityViolation } from '../web/auth-gate.js'
import { isBlockedCrossOriginWrite } from '../web/csrf-origin.js'
// @ts-expect-error -- plain .mjs hook script, no types
import { SECURITY_TABLES } from '../../scripts/self-pace-gate.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const td = mkdtempSync(join(tmpdir(), 'decisions-api-'))
afterAll(() => rmSync(td, { recursive: true, force: true }))
const store = join(td, 'store'); mkdirSync(store, { recursive: true })
initDatabase(join(store, 'claudeclaw.db'))
// A dashboard login exists (the normal state): the bare shared token is no longer the owner.
const ownerUser = createDashboardUser('owner', 'x'.repeat(60))
const ownerCookie = () => `${SESSION_COOKIE_NAME}=${createSession({ userId: ownerUser.id, username: 'owner' })}`

type Auth = { kind: 'token' | 'session' | 'device'; agent?: string; user?: string; scope?: 'full' | 'operator'; tokenAgent?: string }
const SHARED: Auth = { kind: 'token' }
const SOMA_OWN: Auth = { kind: 'token', agent: 'soma', tokenAgent: 'soma' }
const DENNIS_OWN: Auth = { kind: 'token', agent: 'dennis', tokenAgent: 'dennis' }
const OWNER: Auth = { kind: 'session', user: 'owner' }

async function call(method: string, path: string, body: unknown, auth: Auth | undefined, headers: Record<string, string> = {}) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { setHeader() {}, writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const str = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const req: any = { method, headers, on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data' && str) cb(Buffer.from(str)); if (ev === 'end') cb() } }
  const url = new URL(`http://localhost${path}`)
  expect(await tryHandleDecisions({ req, res, path: url.pathname, method, url, auth } as any)).toBe(true)
  await new Promise((r) => setImmediate(r))
  return out
}

let seq = 0
function filing(over: Record<string, unknown> = {}) {
  seq++
  return {
    asker: 'kevin', category: 'kiwele', priority: 'normal',
    title: `Merge window ${seq}`, question: 'Merge in the 16:00 window?',
    options: [
      { key: 'A', label: 'Yes, now', consequence: 'Lands at 16:00' },
      { key: 'B', label: 'At 20:00', consequence: 'Lands four hours later' },
    ],
    recommendation: 'A', blocks: 'KAN-768 merge',
    ...over,
  }
}
const file = (over: Record<string, unknown> = {}, auth: Auth = SHARED) => call('POST', '/api/decisions', filing(over), auth)
const answer = (id: string, body: unknown, auth: Auth | undefined, headers: Record<string, string> = {}) => call('POST', `/api/decisions/${id}/answer`, body, auth, headers)
const asOwner = (id: string, body: unknown) => answer(id, body, OWNER, { cookie: ownerCookie() })

function messagesTo(agent: string, id: string): string[] {
  return (getDb().prepare('SELECT content FROM agent_messages WHERE to_agent = ? AND content LIKE ?').all(agent, `[DECISION_ANSWER] id=${id} %`) as { content: string }[]).map((r) => r.content)
}

describe('filing', () => {
  it('the shared token files a decision: 201, open, the asker self-declared (asker_verified=false), a filed event', async () => {
    const r = await file()
    expect(r.status).toBe(201)
    expect(r.body.id).toMatch(/^dec_[0-9a-f]{16}$/)
    expect(r.body).toMatchObject({ asker: 'kevin', asker_verified: false, status: 'open', recommendation: 'A', blocks: 'KAN-768 merge' })
    expect(r.body.options).toHaveLength(2)
    expect(listDecisionEvents(r.body.id).map((e) => e.event)).toEqual(['filed'])
  })

  it('a sub-agent\'s own token files as itself: asker_verified=true', async () => {
    const r = await file({ asker: 'soma' }, SOMA_OWN)
    expect(r.status).toBe(201)
    expect(r.body.asker_verified).toBe(true)
  })

  it('a sub-agent\'s own token naming another asker is 403 (route) and an identity violation (gate)', async () => {
    const r = await file({ asker: 'kevin' }, SOMA_OWN)
    expect(r.status).toBe(403)
    expect(r.body.rule).toBe('agent-identity-binding')
    expect(agentIdentityViolation('soma', 'POST', '/api/decisions', filing({ asker: 'kevin' }), 'marveen')).toMatch(/'asker' must be the calling agent/)
    expect(agentIdentityViolation('soma', 'POST', '/api/decisions', filing({ asker: 'soma' }), 'marveen')).toBeNull()
  })

  it('X-Agent-Id naming another agent than the body\'s asker is 400 (Johnny 18324); the same name or no header passes', async () => {
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n
    const r = await file({ asker: 'kevin' }, { kind: 'token', agent: 'dennis' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/X-Agent-Id header names 'dennis' but the body names 'kevin'/)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n).toBe(before)
    expect((await file({ asker: 'kevin' }, { kind: 'token', agent: 'kevin' })).status).toBe(201)
    expect((await file({ asker: 'kevin' }, SHARED)).status).toBe(201)
  })

  it('a browser session or a device key does not file', async () => {
    expect((await file({}, OWNER)).status).toBe(403)
    expect((await file({}, { kind: 'device', scope: 'full' })).status).toBe(403)
  })

  it('an unknown asker is 400 (the roster mock is live: kevin above passed, ghost does not)', async () => {
    const r = await file({ asker: 'ghost' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/asker/)
  })

  it.each([
    ['one option', { options: [{ key: 'A', label: 'x', consequence: 'y' }] }, /options/],
    ['seven options', { options: Array.from({ length: 7 }, (_, i) => ({ key: `K${i}`, label: 'x', consequence: 'y' })) }, /options/],
    ['duplicate keys', { options: [{ key: 'A', label: 'x', consequence: 'y' }, { key: 'A', label: 'z', consequence: 'w' }] }, /options/],
    ['an option without a consequence', { options: [{ key: 'A', label: 'x', consequence: '' }, { key: 'B', label: 'z', consequence: 'w' }] }, /options/],
    ['a recommendation that is not a key', { recommendation: 'C' }, /recommendation/],
    ['a category outside the fixed list', { category: 'misc' }, /category/],
    ['a priority outside the fixed list', { priority: 'critical' }, /priority/],
    ['a title over 120 chars', { title: 'x'.repeat(121) }, /title/],
    ['an expiry in the past', { expires_at: 1000 }, /expires_at/],
    ['a token in the question', { question: 'Use Bearer abcdefghij0123456789 for it?' }, /credential/],
    ['a GitHub token in an option consequence', { options: [{ key: 'A', label: 'x', consequence: 'push with ghp_abcdefghijklmnopqrstuvwxyz' }, { key: 'B', label: 'z', consequence: 'w' }] }, /credential/],
  ])('%s is 400 and writes nothing', async (_name, over, rx) => {
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n
    const r = await file(over)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(rx)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n).toBe(before)
  })

  it('a body that is not a JSON object is 400', async () => {
    expect((await call('POST', '/api/decisions', '[1,2]', SHARED)).status).toBe(400)
    expect((await call('POST', '/api/decisions', 'nope', SHARED)).status).toBe(400)
  })

  it('carriesSecretShape: plain prose passes, credential shapes do not', () => {
    expect(carriesSecretShape('Merge in the 16:00 window? Bearer tokens are discussed in KAN-512.')).toBe(false)
    expect(carriesSecretShape('api_key=s3cr3tvalue')).toBe(true)
  })

  it('parseDecisionFiling is the route\'s parser (injectable roster)', () => {
    expect(parseDecisionFiling(filing({ asker: 'x' }), 1, () => true).ok).toBe(true)
    expect(parseDecisionFiling(filing({ asker: 'x' }), 1, () => false).ok).toBe(false)
  })
})

describe('answer: the owner only', () => {
  it.each([
    ['the shared token', SHARED, false],
    ['the shared token with a forged answered_by', SHARED, false],
    ['a sub-agent\'s own token (its own question)', SOMA_OWN, false],
    ['a full device key without the owner cookie', { kind: 'device', scope: 'full' } as Auth, false],
    ['an operator device key, even with the owner cookie', { kind: 'device', scope: 'operator' } as Auth, true],
  ] as Array<[string, Auth, boolean]>)('%s is 403 and the row stays open with no message', async (_n, auth, withCookie) => {
    const d = (await file({ asker: 'soma' }, SOMA_OWN)).body
    const h: Record<string, string> = withCookie ? { cookie: ownerCookie() } : {}
    const r = await answer(d.id, { answer_key: 'A', answered_by: 'owner_session:owner' }, auth, h)
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('owner_session_required')
    expect(getDecision(d.id)?.status).toBe('open')
    expect(messagesTo('soma', d.id)).toEqual([])
  })

  it('POSITIVE CONTROL: the owner session answers: answered, the server names who, one message to the asker', async () => {
    const d = (await file()).body
    const r = await asOwner(d.id, { answer_key: 'B', answer_text: 'Inkább este, Tom akkor ér rá.', answered_by: 'someone-else', answer_channel: 'slack' })
    expect(r.status).toBe(200)
    expect(r.body.decision).toMatchObject({ status: 'answered', answer_key: 'B', answer_text: 'Inkább este, Tom akkor ér rá.', answered_by: 'owner_session:owner', answer_channel: 'page' })
    const msgs = messagesTo('kevin', d.id)
    expect(msgs).toEqual([`[DECISION_ANSWER] id=${d.id} key=B label="At 20:00"\nInkább este, Tom akkor ér rá.`])
    expect(listDecisionEvents(d.id).map((e) => e.event)).toEqual(['filed', 'answered', 'delivered'])
  })

  it('a full device key WITH the owner cookie answers (the Bridge case, as approve)', async () => {
    const d = (await file()).body
    const r = await answer(d.id, { answer_key: 'A' }, { kind: 'device', scope: 'full' }, { cookie: ownerCookie() })
    expect(r.status).toBe(200)
    expect(r.body.decision.answered_by).toBe('owner_session:owner')
  })

  it('idempotent: a second answer is 409 with the FIRST answer, no second event, no second message', async () => {
    const d = (await file()).body
    expect((await asOwner(d.id, { answer_key: 'A' })).status).toBe(200)
    const again = await asOwner(d.id, { answer_key: 'B', answer_text: 'mégis' })
    expect(again.status).toBe(409)
    expect(again.body.decision).toMatchObject({ status: 'answered', answer_key: 'A', answer_text: null })
    expect(messagesTo('kevin', d.id)).toHaveLength(1)
    expect(listDecisionEvents(d.id).filter((e) => e.event === 'answered')).toHaveLength(1)
  })

  it('a free-text-only answer is allowed: key=- and the text verbatim', async () => {
    const d = (await file()).body
    const r = await asOwner(d.id, { answer_text: 'Egyik sem: hétfőn beszéljük meg.' })
    expect(r.status).toBe(200)
    expect(messagesTo('kevin', d.id)).toEqual([`[DECISION_ANSWER] id=${d.id} key=- label=""\nEgyik sem: hétfőn beszéljük meg.`])
  })

  it.each([
    ['a key that is not an option', { answer_key: 'Z' }],
    ['neither key nor text', {}],
    ['a blank text only', { answer_text: '   ' }],
    ['a text over 4000 chars', { answer_key: 'A', answer_text: 'x'.repeat(4001) }],
  ])('%s is 400 and the row stays open', async (_n, body) => {
    const d = (await file()).body
    expect((await asOwner(d.id, body)).status).toBe(400)
    expect(getDecision(d.id)?.status).toBe('open')
  })

  it('an unknown or malformed id is 404', async () => {
    expect((await asOwner('dec_0000000000000000', { answer_key: 'A' })).status).toBe(404)
    expect((await asOwner('not-an-id', { answer_key: 'A' })).status).toBe(404)
  })

  it('decisionAnswerText quotes the label as JSON (a quote in a label cannot break the line)', () => {
    expect(decisionAnswerText({ id: 'dec_1', options: [{ key: 'A', label: 'say "yes"', consequence: 'c' }], answer_key: 'A', answer_text: null }))
      .toBe('[DECISION_ANSWER] id=dec_1 key=A label="say \\"yes\\""')
  })
})

describe('withdraw / supersede: the asker only', () => {
  it('the asker withdraws its open decision; then neither the owner nor a second withdraw changes it', async () => {
    const d = (await file()).body
    const r = await call('POST', `/api/decisions/${d.id}/withdraw`, { actor: 'kevin' }, SHARED)
    expect(r.status).toBe(200)
    expect(r.body.decision.status).toBe('withdrawn')
    expect((await call('POST', `/api/decisions/${d.id}/withdraw`, { actor: 'kevin' }, SHARED)).status).toBe(409)
    expect((await asOwner(d.id, { answer_key: 'A' })).status).toBe(409)
    expect(messagesTo('kevin', d.id)).toEqual([])
  })

  it('another actor on the shared token is 403 and the row stays open', async () => {
    const d = (await file()).body
    const r = await call('POST', `/api/decisions/${d.id}/withdraw`, { actor: 'dennis' }, SHARED)
    expect(r.status).toBe(403)
    expect(getDecision(d.id)?.status).toBe('open')
  })

  it('a sub-agent token: actor must be itself (403), and another agent\'s row is 404', async () => {
    const own = (await file({ asker: 'soma' }, SOMA_OWN)).body
    expect((await call('POST', `/api/decisions/${own.id}/withdraw`, { actor: 'kevin' }, SOMA_OWN)).status).toBe(403)
    // dennis acting as himself on soma's row: not his to see, so the same 404 as a missing id
    expect((await call('POST', `/api/decisions/${own.id}/withdraw`, { actor: 'dennis' }, DENNIS_OWN)).status).toBe(404)
    expect(getDecision(own.id)?.status).toBe('open')
    const kevins = (await file()).body
    expect((await call('POST', `/api/decisions/${kevins.id}/withdraw`, { actor: 'soma' }, SOMA_OWN)).status).toBe(404)
    expect(getDecision(kevins.id)?.status).toBe('open')
    expect((await call('POST', `/api/decisions/${own.id}/withdraw`, { actor: 'soma' }, SOMA_OWN)).status).toBe(200)
  })

  it('withdraw: an X-Agent-Id that disagrees with actor is 400 and the row stays open', async () => {
    const d = (await file()).body
    const r = await call('POST', `/api/decisions/${d.id}/withdraw`, { actor: 'kevin' }, { kind: 'token', agent: 'dennis' })
    expect(r.status).toBe(400)
    expect(getDecision(d.id)?.status).toBe('open')
    expect((await call('POST', `/api/decisions/${d.id}/withdraw`, { actor: 'kevin' }, { kind: 'token', agent: 'kevin' })).status).toBe(200)
  })

  it('a session does not withdraw (the owner answers instead)', async () => {
    const d = (await file()).body
    expect((await call('POST', `/api/decisions/${d.id}/withdraw`, { actor: 'kevin' }, OWNER, { cookie: ownerCookie() })).status).toBe(403)
  })

  it('supersede: needs another open decision of the same asker; then superseded_by points at it', async () => {
    const old = (await file()).body
    const other = (await file({ asker: 'dennis' })).body
    const fresh = (await file()).body
    expect((await call('POST', `/api/decisions/${old.id}/supersede`, { actor: 'kevin', new_id: other.id }, SHARED)).status).toBe(400)
    expect((await call('POST', `/api/decisions/${old.id}/supersede`, { actor: 'kevin', new_id: old.id }, SHARED)).status).toBe(400)
    expect((await call('POST', `/api/decisions/${old.id}/supersede`, { actor: 'kevin' }, SHARED)).status).toBe(400)
    const r = await call('POST', `/api/decisions/${old.id}/supersede`, { actor: 'kevin', new_id: fresh.id }, SHARED)
    expect(r.status).toBe(200)
    expect(r.body.decision).toMatchObject({ status: 'superseded', superseded_by: fresh.id })
    expect(listDecisionEvents(old.id).map((e) => [e.event, e.detail])).toEqual([['filed', null], ['superseded', fresh.id]])
  })
})

describe('reading', () => {
  it('a sub-agent token lists and gets only its own rows; the shared token sees all', async () => {
    const somas = (await file({ asker: 'soma' }, SOMA_OWN)).body
    const kevins = (await file()).body
    const mine = await call('GET', '/api/decisions', undefined, SOMA_OWN)
    expect(mine.status).toBe(200)
    expect(mine.body.length).toBeGreaterThan(0)
    expect(mine.body.every((d: any) => d.asker === 'soma')).toBe(true)
    expect((await call('GET', '/api/decisions?asker=kevin', undefined, SOMA_OWN)).status).toBe(403)
    expect((await call('GET', `/api/decisions/${kevins.id}`, undefined, SOMA_OWN)).status).toBe(404)
    expect((await call('GET', `/api/decisions/${somas.id}`, undefined, SOMA_OWN)).status).toBe(200)
    const all = await call('GET', '/api/decisions', undefined, SHARED)
    expect(all.body.some((d: any) => d.asker === 'kevin') && all.body.some((d: any) => d.asker === 'soma')).toBe(true)
  })

  it('sorted by priority, then blocking first, then due_at (none last), then age', async () => {
    getDb().prepare('DELETE FROM decisions').run()
    const low = (await file({ priority: 'low', blocks: 'x' })).body
    const normalFree = (await file({ priority: 'normal', blocks: null })).body
    const normalLate = (await file({ priority: 'normal', due_at: 2_000_000_000 })).body
    const normalSoon = (await file({ priority: 'normal', due_at: 1_900_000_000 })).body
    const normalNoDue = (await file({ priority: 'normal' })).body
    const urgent = (await file({ priority: 'urgent', blocks: null })).body
    const r = await call('GET', '/api/decisions?status=open', undefined, SHARED)
    expect(r.body.map((d: any) => d.id)).toEqual([urgent.id, normalSoon.id, normalLate.id, normalNoDue.id, normalFree.id, low.id])
  })

  it('bad filters are 400', async () => {
    expect((await call('GET', '/api/decisions?status=closed', undefined, SHARED)).status).toBe(400)
    expect((await call('GET', '/api/decisions?category=misc', undefined, SHARED)).status).toBe(400)
  })
})

describe('the gates around it', () => {
  it('both tables are security tables: an agent\'s SQL write on them is denied', () => {
    expect(SECURITY_TABLES).toEqual(expect.arrayContaining(['decisions', 'decision_events']))
    const DB = 'store/claude' + 'claw.db'
    for (const sql of [`UPDATE decisions SET status='answered'`, 'INSERT INTO decision_events VALUES (1)', 'DELETE FROM decisions']) {
      expect(gateDecision('Bash', { command: `sqlite3 ${DB} "${sql}"` }, { cwd: td, root: td })).toEqual({ deny: true, reason: 'db' })
    }
    // positive control: a read and another table's write still pass
    expect(gateDecision('Bash', { command: `sqlite3 ${DB} "SELECT * FROM decisions"` }, { cwd: td, root: td })).toEqual({ deny: false })
  })

  it('agent-token scope: file, poll, withdraw and supersede are allowed; answer is not', () => {
    expect(isAgentAllowed('/api/decisions', 'POST', 'soma')).toBe(true)
    expect(isAgentAllowed('/api/decisions', 'GET', 'soma')).toBe(true)
    expect(isAgentAllowed('/api/decisions/dec_0123456789abcdef', 'GET', 'soma')).toBe(true)
    expect(isAgentAllowed('/api/decisions/dec_0123456789abcdef/withdraw', 'POST', 'soma')).toBe(true)
    expect(isAgentAllowed('/api/decisions/dec_0123456789abcdef/supersede', 'POST', 'soma')).toBe(true)
    expect(isAgentAllowed('/api/decisions/dec_0123456789abcdef/answer', 'POST', 'soma')).toBe(false)
    expect(isAgentAllowed('/api/decisions/dec_0123456789abcdef', 'DELETE', 'soma')).toBe(false)
  })

  it('a cross-site answer never reaches the route: web.ts runs the Origin gate before dispatching to it', async () => {
    const src = readFileSync(join(REPO, 'src', 'web.ts'), 'utf-8')
    const gateAt = src.indexOf('if (isBlockedCrossOriginWrite(')
    const routeAt = src.indexOf('if (await tryHandleDecisions(routeCtx)) return')
    expect(gateAt).toBeGreaterThan(0)
    expect(routeAt).toBeGreaterThan(gateAt)
    // And the gate itself, on a real server in front of the real route: a foreign Origin is 403 with the owner's cookie,
    // the same request without Origin (same-origin fetch) is answered.
    const d = (await file()).body
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (isBlockedCrossOriginWrite(req.method ?? 'GET', req.headers.origin, req.headers.host, undefined, new Set())) {
        res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"Origin not allowed"}'); return
      }
      await tryHandleDecisions({ req, res, path: url.pathname, method: req.method ?? 'GET', url, auth: OWNER } as any)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    try {
      const send = (origin?: string) => fetch(`http://127.0.0.1:${port}/api/decisions/${d.id}/answer`, {
        method: 'POST', body: JSON.stringify({ answer_key: 'A' }),
        headers: { 'content-type': 'application/json', cookie: ownerCookie(), ...(origin ? { origin } : {}) },
      })
      const foreign = await send('https://evil.example')
      expect(foreign.status).toBe(403)
      expect(getDecision(d.id)?.status).toBe('open')
      const same = await send()
      expect(same.status).toBe(200)
      expect(getDecision(d.id)?.status).toBe('answered')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
