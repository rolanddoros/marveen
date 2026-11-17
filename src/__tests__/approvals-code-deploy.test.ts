// The code deploy's server side (plan-v3 3 and 5, Ron 17165): a code_deploy row is filed by the main agent only and
// always carries a content_hash; with CODE_DEPLOY_OWNER_CHANNEL_ONLY on (the fail-closed default) its approve takes
// the owner's own session cookie and stores the server's own `owner_session:<user>`; no body may imitate a
// server-written resolved_by prefix. The switch-off side: approvals-code-deploy-switch-off.test.ts.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'marveen', TELEGRAM_BOT_TOKEN: 'test-token', CHANNEL_PROVIDER: 'telegram' }))
vi.mock('../owner-chat.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../owner-chat.js')>()), resolveOwnerChatId: () => '777' }))
vi.mock('../web/telegram.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../web/telegram.js')>()), sendTelegramMessage: vi.fn(async () => 4242) }))

import { initDatabase, getApproval, createDashboardUser } from '../db.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import { createSession, revokeSession } from '../web/auth-sessions.js'
import { SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import { CODE_DEPLOY_OWNER_CHANNEL_ONLY } from '../code-deploy-policy.js'
// @ts-expect-error -- plain .mjs script, no types
import { CODE_DEPLOY_OWNER_CHANNEL_ONLY as HELPER_SWITCH, CATEGORY as HELPER_CATEGORY } from '../../scripts/deploy/fork-deploy.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import { OWNER_PREFIXES } from '../../scripts/hooks/owner-approval.mjs'

const td = mkdtempSync(join(tmpdir(), 'approvals-code-deploy-'))
afterAll(() => rmSync(td, { recursive: true, force: true }))
const store = join(td, 'store'); mkdirSync(store, { recursive: true })
writeFileSync(join(store, 'autonomy-config.json'), JSON.stringify({ categories: [] }))
initDatabase(join(store, 'claudeclaw.db'))
const ownerUser = createDashboardUser('owner', 'x'.repeat(60))
const sessionValue = () => createSession({ userId: ownerUser.id, username: 'owner' })
const cookie = (v = sessionValue()) => ({ cookie: `${SESSION_COOKIE_NAME}=${v}` })

type Auth = { kind: 'token' | 'session' | 'device'; agent?: string; user?: string; scope?: 'full' | 'operator'; tokenAgent?: string; device?: string }
const TOKEN: Auth = { kind: 'token', agent: 'soma' }
const SUB: Auth = { kind: 'token', agent: 'stuart', tokenAgent: 'stuart' }
const OWNER: Auth = { kind: 'session', user: 'owner' }
const BRIDGE: Auth = { kind: 'device', scope: 'full', device: 'bridge' }
const HASH = 'c'.repeat(64)

async function call(method: 'POST' | 'PATCH', path: string, body: unknown, auth: Auth, headers: Record<string, string> = {}) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const str = JSON.stringify(body)
  const req: any = { headers, method, url: path, on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data') cb(Buffer.from(str)); if (ev === 'end') cb() } }
  const url = new URL(`http://localhost${path}`)
  expect(await tryHandleApprovals({ req, res, path: url.pathname, method, url, auth } as any)).toBe(true)
  await new Promise((r) => setImmediate(r))
  return out
}
const post = (body: unknown, auth: Auth = TOKEN) => call('POST', '/api/approvals', body, auth)
const patch = (id: string, body: unknown, auth: Auth, headers: Record<string, string> = {}) => call('PATCH', `/api/approvals/${id}`, body, auth, headers)
const deployRow = (extra: Record<string, unknown> = {}) => ({ agent_id: 'marveen', category: 'code_deploy', action_description: 'marveen-code-deploy/v1\nFROM a\nTO b', content_hash: HASH, ...extra })
async function pending(): Promise<string> {
  const r = await post(deployRow())
  expect(r.status).toBe(201)
  return r.body.id as string
}

describe('the switch', () => {
  it('is on (the fail-closed side) and equal to the deploy helper\'s, and both read the same prefixes and category', () => {
    expect(CODE_DEPLOY_OWNER_CHANNEL_ONLY).toBe(true)
    expect(HELPER_SWITCH).toBe(CODE_DEPLOY_OWNER_CHANNEL_ONLY)
    expect(HELPER_CATEGORY).toBe('code_deploy')
    expect([...OWNER_PREFIXES]).toEqual(['owner_session:', 'slack_reaction:'])
  })
})

describe('filing a code_deploy row (plan-v3 3)', () => {
  it('the main agent with a content_hash: 201', async () => {
    const r = await post(deployRow())
    expect(r.status).toBe(201)
    expect(r.body.content_hash).toBe(HASH)
  })
  it('without a content_hash: 400, no row', async () => {
    const r = await post(deployRow({ content_hash: undefined }))
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/content_hash is required for code_deploy/)
  })
  it('another agent_id: 403', async () => {
    expect((await post(deployRow({ agent_id: 'stuart' }))).status).toBe(403)
  })
  it('a sub-agent token, even naming the main agent: 403', async () => {
    const r = await post(deployRow(), SUB)
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/main agent only/)
  })
  it('another category keeps its optional hash', async () => {
    expect((await post({ agent_id: 'stuart', category: 'email_send', action_description: 'x' })).status).toBe(201)
  })
})

describe('approving a code_deploy row, switch on (SEC-5, the eight cases)', () => {
  it('1. the owner cookie alone: approved, resolved_by is the server\'s owner_session:<user>', async () => {
    const id = await pending()
    const r = await patch(id, { status: 'approved', resolved_by: 'owner' }, OWNER, cookie())
    expect(r.status).toBe(200)
    expect(getApproval(id)?.resolved_by).toBe('owner_session:owner')
  })
  it('2. the cookie beside the shared bearer (the owner\'s browser sends both): approved', async () => {
    const id = await pending()
    const r = await patch(id, { status: 'approved', resolved_by: 'owner' }, TOKEN, cookie())
    expect(r.status).toBe(200)
    expect(getApproval(id)?.resolved_by).toBe('owner_session:owner')
  })
  it('3. the shared bearer alone: 403, still pending', async () => {
    const id = await pending()
    expect((await patch(id, { status: 'approved', resolved_by: 'owner' }, TOKEN)).status).toBe(403)
    expect(getApproval(id)?.status).toBe('pending')
  })
  it('4. a sub-agent token, with and without the cookie: 403', async () => {
    const id = await pending()
    expect((await patch(id, { status: 'approved', resolved_by: 'owner' }, SUB, cookie())).status).toBe(403)
    expect((await patch(id, { status: 'approved', resolved_by: 'owner' }, SUB)).status).toBe(403)
    expect(getApproval(id)?.status).toBe('pending')
  })
  it('5. a revoked session\'s cookie and an unknown cookie: 403', async () => {
    const id = await pending()
    const v = sessionValue()
    revokeSession(v)
    expect((await patch(id, { status: 'approved', resolved_by: 'owner' }, TOKEN, cookie(v))).status).toBe(403)
    expect((await patch(id, { status: 'approved', resolved_by: 'owner' }, TOKEN, cookie('not-a-session'))).status).toBe(403)
    expect(getApproval(id)?.status).toBe('pending')
  })
  it('6. a forged owner_session:roland in the body with a valid cookie: the cookie\'s user is stored', async () => {
    const id = await pending()
    expect((await patch(id, { status: 'approved', resolved_by: 'owner_session:roland' }, TOKEN, cookie())).status).toBe(200)
    expect(getApproval(id)?.resolved_by).toBe('owner_session:owner')
  })
  it('7. the same without a cookie: refused', async () => {
    const id = await pending()
    expect((await patch(id, { status: 'approved', resolved_by: 'owner_session:roland' }, TOKEN)).status).toBe(403)
    expect(getApproval(id)?.status).toBe('pending')
  })
  it('8. the Bridge\'s full key with the owner cookie: approved as owner_session (mayActAsOwner\'s key branch)', async () => {
    const id = await pending()
    expect((await patch(id, { status: 'approved', resolved_by: 'owner' }, BRIDGE, cookie())).status).toBe(200)
    expect(getApproval(id)?.resolved_by).toBe('owner_session:owner')
  })
  it('rejecting stays open to the token, with a plain resolved_by', async () => {
    const id = await pending()
    expect((await patch(id, { status: 'rejected', resolved_by: 'marveen-cancel' }, TOKEN)).status).toBe(200)
    expect(getApproval(id)?.status).toBe('rejected')
  })
})

describe('no body imitates a server-written prefix (switch on)', () => {
  it.each(['owner_session:owner', 'slack_reaction:U123', ' Owner_Session:x', 'SLACK_REACTION:U1'])('another category approved with %j: 400', async (by) => {
    const r = await post({ agent_id: 'stuart', category: 'email_send', action_description: 'x' })
    const res = await patch(r.body.id, { status: 'approved', resolved_by: by }, OWNER, cookie())
    expect(res.status).toBe(400)
    expect(getApproval(r.body.id)?.status).toBe('pending')
  })
  it('a code_deploy reject with such a prefix: 400', async () => {
    const id = await pending()
    expect((await patch(id, { status: 'rejected', resolved_by: 'slack_reaction:U1' }, TOKEN)).status).toBe(400)
  })
  it('another category approved by the owner with a plain resolved_by: unchanged (the body value is stored)', async () => {
    const r = await post({ agent_id: 'stuart', category: 'email_send', action_description: 'x' })
    expect((await patch(r.body.id, { status: 'approved', resolved_by: 'owner' }, OWNER, cookie())).status).toBe(200)
    expect(getApproval(r.body.id)?.resolved_by).toBe('owner')
  })
  it('the Slack route keeps writing its own prefix (pinned in source)', async () => {
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(join(process.cwd(), 'src', 'web', 'approval-slack-route.ts'), 'utf-8')).toContain('`slack_reaction:${v.userId}`')
  })
})
