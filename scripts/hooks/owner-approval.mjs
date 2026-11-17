// Shared owner-approval steps for the helpers that act on Roland's approval: the fork deploy helper
// (scripts/deploy/fork-deploy.mjs) first, the agent-settings helper next (settings-protect plan v2).
// Plan: fork deploy-gate v3 [V3-2]/[V3-3] + addendum A1-3/A1-4, Ron 17165.
//
//   renderBounded      the owner text, deterministic and at most CAP characters (Telegram takes 4096 in one
//                      message and the server sends it unsplit, approvals.ts:268-296); the head is never cut
//   sameDescription    the byte compare against the stored text, both sides trimmed (approvals.ts:570 trims)
//   approvalFailures   every field the helper checks before it consumes, with the owner-channel prefix
//   ownerNotified      whether the server's OWN Telegram send happened (status pending AND message id)
//   dashboardClient    GET/POST to the local dashboard with the main agent's token, never printed
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DESCRIPTION_CAP = 3000
export const ROW_CAP = 100
/** The resolved_by prefixes only the server writes: the owner's cookie session and the Slack reaction route. */
export const OWNER_PREFIXES = Object.freeze(['owner_session:', 'slack_reaction:'])

function oneLine(row) {
  return String(row).replace(/[\r\n]+/g, ' ')
}

function cutRow(row, max = ROW_CAP) {
  const s = oneLine(row)
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * The owner text. `head` lines are always in and never cut (FROM, TO, hashes, counts, the gate-path line);
 * then each section prints at most `max` rows and a "more" line for the rest. While the text is longer than
 * `cap`, rows are dropped from the END of the sections, one at a time, taking turns between sections, and
 * each section's "more" count grows with it. Deterministic: the same input gives the same bytes.
 * @param {{ head: string[], sections: { title: string, rows: string[], max?: number, more: (n: number) => string }[], cap?: number }} spec
 */
export function renderBounded({ head, sections, cap = DESCRIPTION_CAP }) {
  const headText = head.map(oneLine).join('\n')
  if (headText.length > cap) throw new Error(`the always-in block alone is ${headText.length} > ${cap} characters`)
  const state = sections.map((s) => {
    const rows = s.rows.map((r) => cutRow(r))
    return { s, rows, shown: Math.min(rows.length, s.max ?? 40) }
  })
  const build = () => {
    const parts = [headText]
    for (const st of state) {
      if (st.rows.length === 0) continue
      const lines = [st.s.title, ...st.rows.slice(0, st.shown)]
      if (st.shown < st.rows.length) lines.push(st.s.more(st.rows.length - st.shown))
      parts.push(lines.join('\n'))
    }
    return parts.join('\n\n').trim()
  }
  let text = build()
  let turn = 0
  while (text.length > cap) {
    const order = state.map((_, i) => (turn + i) % state.length)
    const pick = order.find((i) => state[i].shown > 0)
    if (pick === undefined) break
    state[pick].shown -= 1
    turn = pick + 1
    text = build()
  }
  if (text.length > cap) throw new Error(`the owner text is ${text.length} > ${cap} characters even with every list cut`)
  return text
}

/** The stored description is trimmed by the server; compare trimmed against trimmed, byte for byte. */
export function sameDescription(stored, rendered) {
  return typeof stored === 'string' && typeof rendered === 'string' && stored.trim() === rendered.trim()
}

/**
 * Every reason this row may not be used, empty when it may. `requireOwnerChannel`: resolved_by must carry a
 * prefix only the server writes (CODE_DEPLOY_OWNER_CHANNEL_ONLY on): a born-approved row (`telegram_text`,
 * approvals.ts:575-581) or a hand-written resolved_by is refused.
 */
export function approvalFailures(row, { category, mainAgentId, contentHash, requireOwnerChannel }) {
  const out = []
  if (!row || typeof row !== 'object') return ['no approval row']
  if (row.category !== category) out.push(`category ${row.category} != ${category}`)
  if (!mainAgentId || row.agent_id !== mainAgentId) out.push(`agent_id ${row.agent_id} is not the main agent`)
  if (row.status !== 'approved') out.push(`status ${row.status}`)
  if (row.consumed_at != null) out.push('already consumed')
  if (!contentHash || row.content_hash !== contentHash) out.push('content_hash differs')
  if (requireOwnerChannel && !OWNER_PREFIXES.some((p) => typeof row.resolved_by === 'string' && row.resolved_by.startsWith(p))) {
    out.push(`resolved_by ${JSON.stringify(row.resolved_by)} is not an owner channel`)
  }
  return out
}

/**
 * Did the owner get the request? Only the server's own Telegram send stores a message id while the row is
 * still pending; PATCH may write telegram_message_id from its body (approvals.ts:714), so a decided row
 * proves nothing. Other providers store no id: unknown, never yes.
 */
export function ownerNotified(row, provider) {
  if (!row || row.status !== 'pending') return { notified: 'unknown', why: `status ${row?.status ?? 'missing'}` }
  if (provider !== 'telegram') return { notified: 'unknown', why: `provider ${provider || 'unset'}, no message id` }
  if (Number.isSafeInteger(row.telegram_message_id) && row.telegram_message_id > 0) {
    return { notified: 'yes', why: `telegram message ${row.telegram_message_id}` }
  }
  return { notified: 'NO', why: 'no telegram message id: the request is only on the dashboard' }
}

/** One value of <install>/.env, or null; read lexically like MAIN_AGENT_ID. */
export function envValue(installRoot, key) {
  let text
  try {
    text = readFileSync(join(installRoot, '.env'), 'utf8')
  } catch {
    return null
  }
  for (const line of text.split('\n')) {
    if (line.startsWith(key + '=')) return line.slice(key.length + 1).trim().replace(/^"(.*)"$/, '$1')
  }
  return null
}

/**
 * The local dashboard API with the main agent's token (store/.dashboard-token). The token is read per call and
 * never returned, logged or put in an error message.
 */
export function dashboardClient(installRoot, { fetchFn = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const port = /^[0-9]{2,5}$/.test(envValue(installRoot, 'WEB_PORT') ?? '') ? envValue(installRoot, 'WEB_PORT') : '3420'
  const base = `http://localhost:${port}`
  async function call(method, path, body) {
    const token = readFileSync(join(installRoot, 'store', '.dashboard-token'), 'utf8').trim()
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetchFn(base + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      })
      let data = null
      try {
        data = await res.json()
      } catch { /* empty or not JSON */ }
      return { status: res.status, data }
    } finally {
      clearTimeout(t)
    }
  }
  return {
    base,
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
  }
}

/** Poll until the server's notification shows or `tries` run out; the last row decides. */
export async function pollOwnerNotified(client, id, provider, { tries = 10, intervalMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last = { notified: 'unknown', why: 'never read' }
  for (let i = 0; i < tries; i++) {
    const r = await client.get(`/api/approvals/${encodeURIComponent(id)}`)
    last = r.status === 200 ? ownerNotified(r.data, provider) : { notified: 'unknown', why: `GET ${r.status}` }
    // Decided already, or a provider that never stores a message id: more reads cannot change the answer.
    if (last.notified === 'yes' || (r.status === 200 && (r.data?.status !== 'pending' || provider !== 'telegram'))) return last
    if (i < tries - 1) await sleep(intervalMs)
  }
  return last
}

/** The one-shot consume; the server re-checks status, hash and window atomically (db.ts consumeCategoryApproval). */
export async function consumeApproval(client, id, { category, contentHash, consumer, ref, maxAgeSeconds }) {
  return client.post(`/api/approvals/${encodeURIComponent(id)}/consume`, {
    category,
    content_hash: contentHash,
    consumer,
    ref,
    max_age_seconds: maxAgeSeconds,
  })
}
