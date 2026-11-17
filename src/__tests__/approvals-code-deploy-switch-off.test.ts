// SEC-5, the other position of CODE_DEPLOY_OWNER_CHANNEL_ONLY (plan-v3 5: tests for both): off, a code_deploy
// approve is today's owner-gated approve (mayActAsOwner) and stores the body's resolved_by, which the deploy helper
// then only reports. Filing (main agent only, content_hash required) does not depend on the switch.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'marveen', TELEGRAM_BOT_TOKEN: 'test-token', CHANNEL_PROVIDER: 'telegram' }))
vi.mock('../owner-chat.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../owner-chat.js')>()), resolveOwnerChatId: () => '777' }))
vi.mock('../web/telegram.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../web/telegram.js')>()), sendTelegramMessage: vi.fn(async () => 4242) }))
vi.mock('../code-deploy-policy.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../code-deploy-policy.js')>()), CODE_DEPLOY_OWNER_CHANNEL_ONLY: false }))

import { initDatabase, getApproval, createDashboardUser } from '../db.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import { createSession } from '../web/auth-sessions.js'
import { SESSION_COOKIE_NAME } from '../web/auth-gate.js'

const td = mkdtempSync(join(tmpdir(), 'approvals-code-deploy-off-'))
afterAll(() => rmSync(td, { recursive: true, force: true }))
const store = join(td, 'store'); mkdirSync(store, { recursive: true })
writeFileSync(join(store, 'autonomy-config.json'), JSON.stringify({ categories: [] }))
initDatabase(join(store, 'claudeclaw.db'))
const ownerUser = createDashboardUser('owner', 'x'.repeat(60))
const cookie = () => ({ cookie: `${SESSION_COOKIE_NAME}=${createSession({ userId: ownerUser.id, username: 'owner' })}` })

type Auth = { kind: 'token' | 'session'; agent?: string; user?: string; tokenAgent?: string }
const TOKEN: Auth = { kind: 'token', agent: 'soma' }
const OWNER: Auth = { kind: 'session', user: 'owner' }

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
const deployRow = { agent_id: 'marveen', category: 'code_deploy', action_description: 'marveen-code-deploy/v1', content_hash: 'c'.repeat(64) }

describe('switch off', () => {
  it('the owner session approves and the body\'s resolved_by is stored as given', async () => {
    const r = await call('POST', '/api/approvals', deployRow, TOKEN)
    expect(r.status).toBe(201)
    expect((await call('PATCH', `/api/approvals/${r.body.id}`, { status: 'approved', resolved_by: 'owner' }, OWNER, cookie())).status).toBe(200)
    expect(getApproval(r.body.id)?.resolved_by).toBe('owner')
  })
  it('a body prefix is not refused (today\'s behaviour)', async () => {
    const r = await call('POST', '/api/approvals', { agent_id: 'stuart', category: 'email_send', action_description: 'x' }, TOKEN)
    expect((await call('PATCH', `/api/approvals/${r.body.id}`, { status: 'approved', resolved_by: 'owner_session:x' }, OWNER, cookie())).status).toBe(200)
  })
  it('the bare shared token still cannot approve (mayActAsOwner, unchanged)', async () => {
    const r = await call('POST', '/api/approvals', deployRow, TOKEN)
    expect((await call('PATCH', `/api/approvals/${r.body.id}`, { status: 'approved', resolved_by: 'owner' }, TOKEN)).status).toBe(403)
  })
  it('filing still needs the main agent and the hash', async () => {
    expect((await call('POST', '/api/approvals', { ...deployRow, content_hash: undefined }, TOKEN)).status).toBe(400)
    expect((await call('POST', '/api/approvals', deployRow, { kind: 'token', agent: 'stuart', tokenAgent: 'stuart' })).status).toBe(403)
  })
})
