// SEC-5's cookie rule stands on its own, not on mayActAsOwner (plan-v3 5): before the first dashboard login exists
// the bare shared token IS the owner for mayActAsOwner, and it approves any other category, but not a code_deploy
// row; and a sub-agent token beside a valid owner cookie is refused even where mayActAsOwner would let it through
// (simulated here, so a later change of mayActAsOwner cannot open the deploy).
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'marveen', TELEGRAM_BOT_TOKEN: 'test-token', CHANNEL_PROVIDER: 'telegram' }))
vi.mock('../owner-chat.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../owner-chat.js')>()), resolveOwnerChatId: () => '777' }))
vi.mock('../web/telegram.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../web/telegram.js')>()), sendTelegramMessage: vi.fn(async () => 4242) }))
const actAsOwner = vi.hoisted(() => ({ force: false }))
vi.mock('../web/routes/auth.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/routes/auth.js')>()
  return { ...real, mayActAsOwner: (...a: Parameters<typeof real.mayActAsOwner>) => actAsOwner.force || real.mayActAsOwner(...a) }
})

import { initDatabase, getApproval, getDb } from '../db.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import { createSession } from '../web/auth-sessions.js'
import { SESSION_COOKIE_NAME } from '../web/auth-gate.js'

const td = mkdtempSync(join(tmpdir(), 'approvals-code-deploy-first-run-'))
afterAll(() => rmSync(td, { recursive: true, force: true }))
const store = join(td, 'store'); mkdirSync(store, { recursive: true })
writeFileSync(join(store, 'autonomy-config.json'), JSON.stringify({ categories: [] }))
initDatabase(join(store, 'claudeclaw.db'))

type Auth = { kind: 'token'; agent?: string; tokenAgent?: string }
const TOKEN: Auth = { kind: 'token', agent: 'soma' }
const SUB: Auth = { kind: 'token', agent: 'stuart', tokenAgent: 'stuart' }

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

describe('before the first login (no dashboard user)', () => {
  it('the bare shared token approves another category, but not a code_deploy row', async () => {
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM dashboard_users').get() as { n: number }).n).toBe(0)
    const other = await call('POST', '/api/approvals', { agent_id: 'stuart', category: 'email_send', action_description: 'x' }, TOKEN)
    expect((await call('PATCH', `/api/approvals/${other.body.id}`, { status: 'approved', resolved_by: 'owner' }, TOKEN)).status).toBe(200)
    const d = await call('POST', '/api/approvals', deployRow, TOKEN)
    expect((await call('PATCH', `/api/approvals/${d.body.id}`, { status: 'approved', resolved_by: 'owner' }, TOKEN)).status).toBe(403)
    expect(getApproval(d.body.id)?.status).toBe('pending')
  })
})

describe('where mayActAsOwner would pass', () => {
  it('a sub-agent token beside a valid owner cookie is still refused for code_deploy', async () => {
    const { createDashboardUser } = await import('../db.js')
    const u = createDashboardUser('owner', 'x'.repeat(60))
    const cookie = { cookie: `${SESSION_COOKIE_NAME}=${createSession({ userId: u.id, username: 'owner' })}` }
    const d = await call('POST', '/api/approvals', deployRow, TOKEN)
    actAsOwner.force = true
    try {
      expect((await call('PATCH', `/api/approvals/${d.body.id}`, { status: 'approved', resolved_by: 'owner' }, SUB, cookie)).status).toBe(403)
      expect(getApproval(d.body.id)?.status).toBe('pending')
      // the positive control through the same seam: the shared bearer with the cookie passes
      expect((await call('PATCH', `/api/approvals/${d.body.id}`, { status: 'approved', resolved_by: 'owner' }, TOKEN, cookie)).status).toBe(200)
    } finally {
      actAsOwner.force = false
    }
  })
})
