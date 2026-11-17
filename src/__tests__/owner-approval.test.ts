// scripts/hooks/owner-approval.mjs: the owner-approval steps shared by the fork deploy helper and, next, the
// agent-settings helper (fork deploy-gate plan v3 [V3-2]/[V3-3] + addendum A1-3/A1-4, Ron 17165).
// Pinned here: the owner text stays under the cap without ever cutting the head, the cut is deterministic and
// takes turns between lists, the stored/rendered compare trims both sides, every field check (owner-channel
// prefix included, so a born-approved `telegram_text` row is refused with the switch on), the "owner notified"
// rule (pending AND a message id), the poll, the consume body and the token never leaving the client.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { renderBounded, sameDescription, approvalFailures, ownerNotified, envValue, dashboardClient, pollOwnerNotified, consumeApproval, DESCRIPTION_CAP, ROW_CAP, OWNER_PREFIXES } from '../../scripts/hooks/owner-approval.mjs'
import { buildOwnerApprovalText, approvalsPageUrl } from '../web/routes/approvals.js'
import type { Approval } from '../db.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

type Section = { title: string; rows: string[]; max?: number; more: (n: number) => string }

const HEX40 = 'a'.repeat(40)
const HEX64 = 'b'.repeat(64)

function head(extra: string[] = []): string[] {
  return ['marveen-code-deploy/v1', `FROM ${HEX40}`, `TO ${'c'.repeat(40)}`, `content_hash ${HEX64}`, 'npm ci: igen', 'commits: 200, packages: 300', ...extra]
}

function commits(n: number, len = 140): Section {
  return {
    title: 'Commitok:',
    rows: Array.from({ length: n }, (_, i) => `${String(i).padStart(7, '0')} ${'feat(scope): a long subject '.repeat(10)}`.slice(0, len)),
    more: (k) => `... és még ${k} commit`,
  }
}

function packages(n: number): Section {
  return {
    title: 'Csomagok:',
    rows: Array.from({ length: n }, (_, i) => `@a-very-long-scope-name/package-number-${String(i).padStart(4, '0')}-with-suffix 1.2.3 -> 1.2.4`),
    more: (k) => `... és még ${k} csomag`,
  }
}

/** Rows printed under `title` and the "még N" count after them, read back from the text. */
function readBack(text: string, title: string, moreRe: RegExp): { shown: number; more: number } {
  const block = text.split('\n\n').find((b) => b.startsWith(title + '\n'))
  if (!block) return { shown: 0, more: 0 }
  const lines = block.split('\n').slice(1)
  const m = lines.length ? moreRe.exec(lines[lines.length - 1]) : null
  return { shown: m ? lines.length - 1 : lines.length, more: m ? Number(m[1]) : 0 }
}

describe('renderBounded: the owner text', () => {
  it('worst case (200 commits, 300 long scoped packages, 100+ char subjects) fits the cap with every count right', () => {
    const c = commits(200)
    const p = packages(300)
    const text = renderBounded({ head: head(), sections: [c, p] })
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_CAP)
    for (const l of head()) expect(text).toContain(l)
    const rc = readBack(text, 'Commitok:', /^\.\.\. és még (\d+) commit$/)
    const rp = readBack(text, 'Csomagok:', /^\.\.\. és még (\d+) csomag$/)
    expect(rc.shown + rc.more).toBe(200)
    expect(rp.shown + rp.more).toBe(300)
    expect(rc.shown).toBeGreaterThan(0)
    expect(rp.shown).toBeGreaterThan(0)
  })

  it('is deterministic: the same input gives the same bytes', () => {
    const a = renderBounded({ head: head(), sections: [commits(200), packages(300)] })
    const b = renderBounded({ head: head(), sections: [commits(200), packages(300)] })
    expect(a).toBe(b)
  })

  it('cuts from the END of each list, taking turns, so neither list is emptied first', () => {
    const text = renderBounded({ head: head(), sections: [commits(200), packages(300)] })
    const rc = readBack(text, 'Commitok:', /^\.\.\. és még (\d+) commit$/)
    const rp = readBack(text, 'Csomagok:', /^\.\.\. és még (\d+) csomag$/)
    // Both start at the 40-row default and lose rows in turn: never more than one apart.
    expect(Math.abs(rc.shown - rp.shown)).toBeLessThanOrEqual(1)
    // The rows kept are the first ones, in input order.
    expect(text).toContain(commits(200).rows[0].slice(0, ROW_CAP - 1))
    expect(text).not.toContain(commits(200).rows[rc.shown].slice(0, 7) + ' ')
  })

  it('keeps the first `max` rows (default 40) and a "more" line when the text is short enough', () => {
    const text = renderBounded({ head: ['h'], sections: [{ title: 'L:', rows: Array.from({ length: 45 }, (_, i) => `r${i}`), more: (k: number) => `+${k}` }] })
    expect(text).toBe(['h', '', ['L:', ...Array.from({ length: 40 }, (_, i) => `r${i}`), '+5'].join('\n')].join('\n'))
    const capped = renderBounded({ head: ['h'], sections: [{ title: 'L:', rows: ['a', 'b', 'c'], max: 2, more: (k: number) => `+${k}` }] })
    expect(capped).toBe('h\n\nL:\na\nb\n+1')
  })

  it('a list with no rows prints nothing, not even its title', () => {
    expect(renderBounded({ head: ['h'], sections: [{ title: 'L:', rows: [], more: () => 'x' }] })).toBe('h')
  })

  it('a row longer than ROW_CAP ends in an ellipsis at exactly ROW_CAP characters; newlines become spaces', () => {
    const text = renderBounded({ head: ['h'], sections: [{ title: 'L:', rows: ['x'.repeat(250), 'a\nb\r\nc'], more: () => '' }] })
    const lines = text.split('\n')
    expect(lines[3]).toBe('x'.repeat(ROW_CAP - 1) + '…')
    expect(lines[4]).toBe('a b c')
  })

  it('never cuts a head line, even a long one (the gate/deploy path line with ten names)', () => {
    const pathLine = 'Kapu/deploy utak: 25 fájl: ' + Array.from({ length: 10 }, (_, i) => `scripts/hooks/a-long-hook-file-name-number-${i}.mjs`).join(', ') + ', ... és még 15'
    expect(pathLine.length).toBeGreaterThan(400)
    const text = renderBounded({ head: head([pathLine]), sections: [commits(200), packages(300)] })
    expect(text.split('\n')).toContain(pathLine)
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_CAP)
  })

  it('a head longer than the cap alone is an error, not a cut', () => {
    expect(() => renderBounded({ head: ['x'.repeat(DESCRIPTION_CAP + 1)], sections: [] })).toThrow(/always-in block/)
  })

  it('every list cut and still over the cap (titles + "more" lines) is an error', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ title: `${'T'.repeat(60)}${i}:`, rows: ['r'], more: (k: number) => `${'m'.repeat(60)} ${k}` }))
    expect(() => renderBounded({ head: ['h'], sections: many, cap: 2000 })).toThrow(/even with every list cut/)
  })

  it('produces no leading or trailing whitespace (the server stores the trimmed text)', () => {
    const text = renderBounded({ head: ['  h', 'x'], sections: [{ title: 'L:', rows: ['a  '], more: () => '' }] })
    expect(text).toBe(text.trim())
  })

  it('worst case wrapped by the server\'s owner text stays under the Telegram limit (4096) with a 50-char agent id and a long URL', () => {
    const description = renderBounded({ head: head(), sections: [commits(200), packages(300)] })
    const approval: Approval = {
      id: 'f'.repeat(36),
      agent_id: 'a'.repeat(50),
      category: 'code_deploy',
      action_description: description,
      action_payload: null,
      status: 'pending',
      timeout_at: 1_800_000_000,
      telegram_message_id: null,
      requested_at: 1_799_996_400,
      resolved_at: null,
      resolved_by: null,
      content_hash: HEX64,
      consumed_at: null,
    }
    const text = buildOwnerApprovalText(approval)
    const longUrl = approvalsPageUrl('https://' + 'd'.repeat(200) + '.example.org', 3420)
    expect(text.length - approvalsPageUrl().length + longUrl.length).toBeLessThan(4096)
  })
})

describe('sameDescription: stored (trimmed by the server) vs re-rendered', () => {
  const r = 'marveen-code-deploy/v1\nFROM x\nTO y'
  it('equal after trim on both sides, a trailing newline included', () => {
    expect(sameDescription(r, r)).toBe(true)
    expect(sameDescription(r, r + '\n')).toBe(true)
    expect(sameDescription('\n ' + r + '\n\n', r)).toBe(true)
  })
  it('one byte in the middle differs: false', () => {
    expect(sameDescription(r, r.replace('FROM x', 'FROM z'))).toBe(false)
    expect(sameDescription(r, r.replace('\nTO', ' TO'))).toBe(false)
  })
  it('a missing or non-string side is never equal', () => {
    for (const bad of [null, undefined, 0, {}, ['x']]) {
      expect(sameDescription(bad, r)).toBe(false)
      expect(sameDescription(r, bad)).toBe(false)
    }
  })
})

describe('approvalFailures: the field checks before the consume', () => {
  const opts = { category: 'code_deploy', mainAgentId: 'johnny', contentHash: HEX64, requireOwnerChannel: true }
  const good = { category: 'code_deploy', agent_id: 'johnny', status: 'approved', consumed_at: null, content_hash: HEX64, resolved_by: 'owner_session:roland' }

  it('a good row has no failures; the Slack reaction prefix passes too', () => {
    expect(approvalFailures(good, opts)).toEqual([])
    expect(approvalFailures({ ...good, resolved_by: 'slack_reaction:U123' }, opts)).toEqual([])
  })

  it('each bad field is named on its own', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ category: 'skill_patch' }, /^category skill_patch != code_deploy$/],
      [{ agent_id: 'stuart' }, /^agent_id stuart is not the main agent$/],
      [{ status: 'pending' }, /^status pending$/],
      [{ status: 'rejected' }, /^status rejected$/],
      [{ consumed_at: 1_799_000_000 }, /^already consumed$/],
      [{ content_hash: 'c'.repeat(64) }, /^content_hash differs$/],
      [{ content_hash: null }, /^content_hash differs$/],
      [{ resolved_by: 'roland' }, /^resolved_by "roland" is not an owner channel$/],
      [{ resolved_by: null }, /^resolved_by null is not an owner channel$/],
      [{ resolved_by: 'x owner_session:roland' }, /is not an owner channel$/],
    ]
    for (const [over, re] of cases) {
      const f = approvalFailures({ ...good, ...over }, opts)
      expect(f, JSON.stringify(over)).toHaveLength(1)
      expect(f[0]).toMatch(re)
    }
  })

  it('consumed_at undefined counts as not consumed (the field may be absent)', () => {
    const { consumed_at: _c, ...row } = good
    expect(approvalFailures(row, opts)).toEqual([])
  })

  it('a missing main agent id or expected hash never matches an equally missing row field', () => {
    expect(approvalFailures({ ...good, agent_id: undefined }, { ...opts, mainAgentId: undefined })).toContain('agent_id undefined is not the main agent')
    expect(approvalFailures({ ...good, content_hash: '' }, { ...opts, contentHash: '' })).toContain('content_hash differs')
  })

  it('no row at all', () => {
    expect(approvalFailures(null, opts)).toEqual(['no approval row'])
    expect(approvalFailures('x', opts)).toEqual(['no approval row'])
  })

  it('born-approved row (resolved_by telegram_text): switch ON refuses it, switch OFF lets it through', () => {
    const born = { ...good, resolved_by: 'telegram_text' }
    expect(approvalFailures(born, opts)).toEqual(['resolved_by "telegram_text" is not an owner channel'])
    expect(approvalFailures(born, { ...opts, requireOwnerChannel: false })).toEqual([])
  })

  it('the owner prefixes are exactly the two the server writes, and frozen', () => {
    expect(OWNER_PREFIXES).toEqual(['owner_session:', 'slack_reaction:'])
    expect(Object.isFrozen(OWNER_PREFIXES)).toBe(true)
  })
})

describe('ownerNotified: pending AND a telegram message id', () => {
  it('the matrix', () => {
    expect(ownerNotified({ status: 'pending', telegram_message_id: 812 }, 'telegram')).toEqual({ notified: 'yes', why: 'telegram message 812' })
    expect(ownerNotified({ status: 'pending', telegram_message_id: null }, 'telegram').notified).toBe('NO')
    // PATCH can write the id from its body: on a decided row the id proves nothing.
    expect(ownerNotified({ status: 'approved', telegram_message_id: 812 }, 'telegram')).toEqual({ notified: 'unknown', why: 'status approved' })
    expect(ownerNotified({ status: 'rejected', telegram_message_id: null }, 'telegram')).toEqual({ notified: 'unknown', why: 'status rejected' })
    expect(ownerNotified({ status: 'pending', telegram_message_id: 812 }, 'slack')).toEqual({ notified: 'unknown', why: 'provider slack, no message id' })
    expect(ownerNotified({ status: 'pending', telegram_message_id: 812 }, '')).toEqual({ notified: 'unknown', why: 'provider unset, no message id' })
    expect(ownerNotified(null, 'telegram')).toEqual({ notified: 'unknown', why: 'status missing' })
  })
  it('only a positive safe integer counts as a message id', () => {
    for (const bad of [0, -1, 1.5, '812', NaN, Number.MAX_SAFE_INTEGER + 2, undefined]) {
      expect(ownerNotified({ status: 'pending', telegram_message_id: bad }, 'telegram').notified, String(bad)).toBe('NO')
    }
  })
})

describe('pollOwnerNotified', () => {
  function fakeClient(rows: { status: number; data: unknown }[]) {
    const calls: string[] = []
    return {
      calls,
      get: async (path: string) => {
        calls.push(path)
        return rows[Math.min(calls.length - 1, rows.length - 1)]
      },
    }
  }
  const noSleep = async () => {}

  it('stops at the first "yes"', async () => {
    const c = fakeClient([{ status: 200, data: { status: 'pending', telegram_message_id: null } }, { status: 200, data: { status: 'pending', telegram_message_id: 9 } }])
    expect(await pollOwnerNotified(c, 'id/1', 'telegram', { sleep: noSleep })).toEqual({ notified: 'yes', why: 'telegram message 9' })
    expect(c.calls).toEqual(['/api/approvals/id%2F1', '/api/approvals/id%2F1'])
  })

  it('no id for all tries: NO after exactly `tries` reads, sleeping between them only', async () => {
    const c = fakeClient([{ status: 200, data: { status: 'pending', telegram_message_id: null } }])
    const sleeps: number[] = []
    const r = await pollOwnerNotified(c, 'x', 'telegram', { tries: 10, intervalMs: 2000, sleep: async (ms: number) => { sleeps.push(ms) } })
    expect(r.notified).toBe('NO')
    expect(c.calls).toHaveLength(10)
    expect(sleeps).toEqual(Array(9).fill(2000))
  })

  it('a row decided before the id shows: unknown with the status, no more reads', async () => {
    const c = fakeClient([{ status: 200, data: { status: 'rejected', telegram_message_id: 5 } }])
    expect(await pollOwnerNotified(c, 'x', 'telegram', { sleep: noSleep })).toEqual({ notified: 'unknown', why: 'status rejected' })
    expect(c.calls).toHaveLength(1)
  })

  it('a provider that stores no id: unknown after ONE read', async () => {
    const c = fakeClient([{ status: 200, data: { status: 'pending', telegram_message_id: null } }])
    expect((await pollOwnerNotified(c, 'x', 'slack', { sleep: noSleep })).notified).toBe('unknown')
    expect(c.calls).toHaveLength(1)
  })

  it('a failing GET keeps polling and ends unknown with the status code', async () => {
    const c = fakeClient([{ status: 503, data: null }])
    expect(await pollOwnerNotified(c, 'x', 'telegram', { tries: 3, sleep: noSleep })).toEqual({ notified: 'unknown', why: 'GET 503' })
    expect(c.calls).toHaveLength(3)
  })
})

describe('consumeApproval', () => {
  it('posts the one-shot consume with exactly the server fields', async () => {
    const seen: { path: string; body: unknown }[] = []
    const client = { post: async (path: string, body: unknown) => { seen.push({ path, body }); return { status: 200, data: { ok: true } } } }
    const r = await consumeApproval(client, 'ab/c', { category: 'code_deploy', contentHash: HEX64, consumer: 'fork-deploy', ref: HEX40, maxAgeSeconds: 1800 })
    expect(r).toEqual({ status: 200, data: { ok: true } })
    expect(seen).toEqual([{ path: '/api/approvals/ab%2Fc/consume', body: { category: 'code_deploy', content_hash: HEX64, consumer: 'fork-deploy', ref: HEX40, max_age_seconds: 1800 } }])
  })
})

describe('envValue and dashboardClient', () => {
  const TOKEN = 'tok-' + 'z'.repeat(16)
  let inst: string

  beforeEach(() => {
    inst = join(realpathSync(mkdtempSync(join(tmpdir(), 'owner-approval-'))), 'inst')
    mkdirSync(join(inst, 'store'), { recursive: true })
    writeFileSync(join(inst, 'store', '.dashboard-token'), TOKEN + '\n')
  })
  afterEach(() => rmSync(join(inst, '..'), { recursive: true, force: true }))

  it('envValue reads one key lexically: exact prefix, quotes stripped, CR trimmed, missing file null', () => {
    writeFileSync(join(inst, '.env'), 'X_CHANNEL_PROVIDER=slack\nCHANNEL_PROVIDER="telegram"\r\nWEB_PORT=4100\n# CHANNEL_PROVIDER=bad\n')
    expect(envValue(inst, 'CHANNEL_PROVIDER')).toBe('telegram')
    expect(envValue(inst, 'WEB_PORT')).toBe('4100')
    expect(envValue(inst, 'NOPE')).toBeNull()
    expect(envValue(join(inst, 'missing'), 'WEB_PORT')).toBeNull()
  })

  it('uses WEB_PORT from .env, 3420 when absent or not a port', () => {
    writeFileSync(join(inst, '.env'), 'WEB_PORT=4100\n')
    expect(dashboardClient(inst).base).toBe('http://localhost:4100')
    writeFileSync(join(inst, '.env'), 'WEB_PORT=41;rm\n')
    expect(dashboardClient(inst).base).toBe('http://localhost:3420')
    rmSync(join(inst, '.env'))
    expect(dashboardClient(inst).base).toBe('http://localhost:3420')
  })

  it('sends the token as Bearer and JSON bodies, and never returns the token', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fetchFn = async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response(JSON.stringify({ ok: true }), { status: 201 })
    }
    const c = dashboardClient(inst, { fetchFn })
    const got = await c.get('/api/approvals/1')
    const posted = await c.post('/api/approvals', { a: 1 })
    expect(got).toEqual({ status: 201, data: { ok: true } })
    expect(posted).toEqual({ status: 201, data: { ok: true } })
    expect(seen[0]).toMatchObject({ url: 'http://localhost:3420/api/approvals/1', init: { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } } })
    expect(seen[0].init.body).toBeUndefined()
    expect(seen[1].init).toMatchObject({ method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } })
    expect(JSON.stringify([got, posted, c])).not.toContain(TOKEN)
  })

  it('a non-JSON answer gives data null, not a throw', async () => {
    const c = dashboardClient(inst, { fetchFn: async () => new Response('<html>', { status: 502 }) })
    expect(await c.get('/x')).toEqual({ status: 502, data: null })
  })

  it('a fetch failure and a missing token file do not carry the token in the error', async () => {
    const c = dashboardClient(inst, { fetchFn: async () => { throw new Error('connect ECONNREFUSED') } })
    await expect(c.get('/x')).rejects.toThrow('ECONNREFUSED')
    await c.get('/x').catch((e: Error) => expect(String(e.stack)).not.toContain(TOKEN))
    rmSync(join(inst, 'store', '.dashboard-token'))
    await expect(dashboardClient(inst, { fetchFn: async () => new Response('{}') }).get('/x')).rejects.toThrow(/ENOENT/)
  })

  it('a hung dashboard is aborted after timeoutMs', async () => {
    const fetchFn = (_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
    await expect(dashboardClient(inst, { fetchFn, timeoutMs: 20 }).get('/x')).rejects.toThrow('aborted')
  })
})
