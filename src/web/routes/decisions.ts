// /api/decisions -- the questions agents put to the owner (card 658026c5, the "Döntések" page; PR1: the API).
//
// Who may do what:
// - File (POST /api/decisions): an agent, by token. The asker is the body's `asker`; a sub-agent's OWN token
//   (AGENT_TOKENS) must name itself (auth-gate AGENT_IDENTITY_BINDINGS, repeated here), and the row says
//   asker_verified=1. On the shared token the asker is self-declared (asker_verified=0), the same trust
//   approvals.agent_id has today (AGENT_TOKENS is off on this install; Johnny 18324 approved this model). A
//   self-declared asker that disagrees with the request's own X-Agent-Id header is a 400. A browser session or a
//   device key does not file: the owner does not ask himself.
// - Read: the shared token and the owner see every decision; a sub-agent token sees only its own (another agent's
//   question text is not its business).
// - Answer (POST /api/decisions/:id/answer): the OWNER only, the same predicate that guards approving
//   (mayActAsOwner, approvals.ts PATCH). The shared token and every agent token get 403, so no agent answers its own
//   or another agent's question. Idempotent: a second answer is a 409 with the first one, and no second message.
// - Withdraw / supersede: the asker only (the body's `actor`, bound like `asker`), and only while open.
// Cross-site writes are refused before any route runs (web.ts, isBlockedCrossOriginWrite), as for approvals.
import { randomBytes } from 'node:crypto'
import {
  createDecision, getDecision, listDecisions, answerDecision, closeDecisionByAsker,
  DECISION_CATEGORIES, DECISION_PRIORITIES, DECISION_STATUSES,
  type Decision, type DecisionCategory, type DecisionOption, type DecisionPriority, type DecisionStatus,
} from '../../db.js'
import { logger, redactLogMessage } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { isKnownAgent } from '../agent-config.js'
import { mayActAsOwner, ownerCookieSession, OWNER_SESSION_REQUIRED } from './auth.js'
import type { RouteContext } from './types.js'

export const DECISION_LIMITS = Object.freeze({
  title: 120, question: 4000, context: 4000, blocks: 200, label: 120, consequence: 1000, answerText: 4000,
  minOptions: 2, maxOptions: 6,
})
const OPTION_KEY_RE = /^[A-Za-z0-9_-]{1,16}$/
const AGENT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
const DECISION_ID_RE = /^dec_[0-9a-f]{16}$/

const OWNER_ONLY = {
  ...OWNER_SESSION_REQUIRED,
  error: 'Answering a decision needs the dashboard login (an owner session); no agent token, the shared one included, answers a decision.',
}

/** True when the text carries a credential shape (Bearer value, token=…, sk-ant-, ghp_, a bot token, a JWT…): the
 *  same patterns the logger redacts. Decision text is shown on a page and pushed to a chat; a secret has no place in it. */
export function carriesSecretShape(text: string): boolean {
  return redactLogMessage(text) !== text
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

function optText(v: unknown, field: string, max: number): Parsed<string | null> {
  if (v === undefined || v === null || v === '') return { ok: true, value: null }
  if (typeof v !== 'string' || v.length > max) return { ok: false, error: `${field}, if given, must be a string of at most ${max} characters` }
  return { ok: true, value: v }
}

function reqText(v: unknown, field: string, max: number): Parsed<string> {
  if (typeof v !== 'string' || !v.trim() || v.length > max) return { ok: false, error: `${field} is required: 1-${max} characters` }
  return { ok: true, value: v }
}

function optEpoch(v: unknown, field: string): Parsed<number | null> {
  if (v === undefined || v === null) return { ok: true, value: null }
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return { ok: false, error: `${field}, if given, must be a unix time in whole seconds` }
  return { ok: true, value: v }
}

function parseOptions(v: unknown): Parsed<DecisionOption[]> {
  const L = DECISION_LIMITS
  const shape = `options must be ${L.minOptions}-${L.maxOptions} objects {key, label, consequence}: key 1-16 of [A-Za-z0-9_-], unique; label 1-${L.label} chars; consequence 1-${L.consequence} chars`
  if (!Array.isArray(v) || v.length < L.minOptions || v.length > L.maxOptions) return { ok: false, error: shape }
  const out: DecisionOption[] = []
  for (const o of v) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: shape }
    const { key, label, consequence } = o as Record<string, unknown>
    if (typeof key !== 'string' || !OPTION_KEY_RE.test(key) || out.some((x) => x.key === key)) return { ok: false, error: shape }
    if (typeof label !== 'string' || !label.trim() || label.length > L.label) return { ok: false, error: shape }
    if (typeof consequence !== 'string' || !consequence.trim() || consequence.length > L.consequence) return { ok: false, error: shape }
    out.push({ key, label, consequence })
  }
  return { ok: true, value: out }
}

export interface DecisionFiling {
  asker: string
  category: DecisionCategory
  priority: DecisionPriority
  title: string
  question: string
  context: string | null
  options: DecisionOption[]
  recommendation: string | null
  blocks: string | null
  due_at: number | null
  expires_at: number | null
}

/** Validates a filing body. Pure apart from the roster check (isKnown, injectable for tests). */
export function parseDecisionFiling(body: Record<string, unknown>, nowS: number, isKnown: (name: string) => boolean = isKnownAgent): Parsed<DecisionFiling> {
  const L = DECISION_LIMITS
  const { asker } = body
  if (typeof asker !== 'string' || !AGENT_NAME_RE.test(asker) || !isKnown(asker)) {
    return { ok: false, error: 'asker is required: the filing agent\'s own name (a registered agent)' }
  }
  if (typeof body.category !== 'string' || !(DECISION_CATEGORIES as readonly string[]).includes(body.category)) {
    return { ok: false, error: `category must be one of ${DECISION_CATEGORIES.join(', ')}` }
  }
  if (typeof body.priority !== 'string' || !(DECISION_PRIORITIES as readonly string[]).includes(body.priority)) {
    return { ok: false, error: `priority must be one of ${DECISION_PRIORITIES.join(', ')}` }
  }
  const title = reqText(body.title, 'title', L.title); if (!title.ok) return title
  const question = reqText(body.question, 'question', L.question); if (!question.ok) return question
  const context = optText(body.context, 'context', L.context); if (!context.ok) return context
  const blocks = optText(body.blocks, 'blocks', L.blocks); if (!blocks.ok) return blocks
  const options = parseOptions(body.options); if (!options.ok) return options
  let recommendation: string | null = null
  if (body.recommendation !== undefined && body.recommendation !== null) {
    if (typeof body.recommendation !== 'string' || !options.value.some((o) => o.key === body.recommendation)) {
      return { ok: false, error: 'recommendation, if given, must be one of the option keys' }
    }
    recommendation = body.recommendation
  }
  const due = optEpoch(body.due_at, 'due_at'); if (!due.ok) return due
  const expires = optEpoch(body.expires_at, 'expires_at'); if (!expires.ok) return expires
  if (expires.value !== null && expires.value <= nowS) return { ok: false, error: 'expires_at, if given, must be in the future' }
  const texts = [title.value, question.value, context.value, blocks.value, ...options.value.flatMap((o) => [o.label, o.consequence])]
  if (texts.some((t) => t !== null && carriesSecretShape(t))) {
    return { ok: false, error: 'the decision text carries a credential shape (token, key, Bearer value); a secret never goes into a decision' }
  }
  return {
    ok: true,
    value: {
      asker, category: body.category as DecisionCategory, priority: body.priority as DecisionPriority,
      title: title.value, question: question.value, context: context.value, options: options.value,
      recommendation, blocks: blocks.value, due_at: due.value, expires_at: expires.value,
    },
  }
}

async function readJsonObject(ctx: RouteContext): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse((await readBody(ctx.req)).toString()) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch { /* fall through */ }
  json(ctx.res, { error: 'body must be a JSON object' }, 400)
  return null
}

/** The sub-agent behind the request's OWN token, or undefined (shared token, session, device). */
function subAgentOf(ctx: RouteContext): string | undefined {
  return ctx.auth?.kind === 'token' ? ctx.auth.tokenAgent : undefined
}

/** Johnny 18324 (2): on the shared token the asker is self-declared, so a request that ALSO names itself in the
 *  X-Agent-Id header (ctx.auth.agent, roster-checked by the gate) must name the same agent; a mismatch is refused
 *  (400) instead of filing under one name while the header says another. Absent header: nothing to compare. */
function agentHeaderMismatch(ctx: RouteContext, named: string): string | null {
  const header = ctx.auth?.kind === 'token' ? ctx.auth.agent : undefined
  if (header === undefined || header === '' || header === named) return null
  return `the X-Agent-Id header names '${header}' but the body names '${named}'; they must be the same agent`
}

function visibleTo(ctx: RouteContext, d: Decision): boolean {
  const sub = subAgentOf(ctx)
  return sub === undefined || d.asker === sub
}

export async function tryHandleDecisions(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (path !== '/api/decisions' && !path.startsWith('/api/decisions/')) return false

  // POST /api/decisions -- file
  if (path === '/api/decisions' && method === 'POST') {
    if (ctx.auth?.kind !== 'token') {
      json(res, { error: 'decisions are filed by agents (a dashboard token); the owner answers them' }, 403)
      return true
    }
    const body = await readJsonObject(ctx); if (!body) return true
    const parsed = parseDecisionFiling(body, Math.floor(Date.now() / 1000))
    if (!parsed.ok) { json(res, { error: parsed.error }, 400); return true }
    const sub = subAgentOf(ctx)
    if (sub !== undefined && parsed.value.asker !== sub) {
      json(res, { error: `asker must be the calling agent '${sub}'`, rule: 'agent-identity-binding' }, 403)
      return true
    }
    const askerMismatch = agentHeaderMismatch(ctx, parsed.value.asker)
    if (askerMismatch) { json(res, { error: askerMismatch }, 400); return true }
    const decision = createDecision({ id: `dec_${randomBytes(8).toString('hex')}`, ...parsed.value, asker_verified: sub !== undefined })
    logger.info({ id: decision.id, asker: decision.asker, verified: decision.asker_verified, category: decision.category, priority: decision.priority }, 'decision filed')
    json(res, decision, 201)
    return true
  }

  // GET /api/decisions?status=&category=&asker=&limit=
  if (path === '/api/decisions' && method === 'GET') {
    const q = ctx.url.searchParams
    const status = q.get('status') || undefined
    const category = q.get('category') || undefined
    let asker = q.get('asker') || undefined
    if (status !== undefined && !DECISION_STATUSES.includes(status as DecisionStatus)) { json(res, { error: `status must be one of ${DECISION_STATUSES.join(', ')}` }, 400); return true }
    if (category !== undefined && !(DECISION_CATEGORIES as readonly string[]).includes(category)) { json(res, { error: `category must be one of ${DECISION_CATEGORIES.join(', ')}` }, 400); return true }
    if (asker !== undefined && !AGENT_NAME_RE.test(asker)) { json(res, { error: 'asker must be an agent name' }, 400); return true }
    const sub = subAgentOf(ctx)
    if (sub !== undefined) {
      if (asker !== undefined && asker !== sub) { json(res, { error: `a sub-agent token lists only its own decisions ('${sub}')`, rule: 'agent-identity-binding' }, 403); return true }
      asker = sub
    }
    const limitRaw = q.get('limit')
    const limit = limitRaw && /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : undefined
    json(res, listDecisions({ status: status as DecisionStatus | undefined, category: category as DecisionCategory | undefined, asker, limit }))
    return true
  }

  const m = /^\/api\/decisions\/([^/]+)(?:\/(answer|withdraw|supersede))?$/.exec(path)
  if (!m) { json(res, { error: 'Not found' }, 404); return true }
  const id = m[1]!
  const action = m[2]
  // One answer for a malformed id, a missing row and another agent's row (as approvals' consume does), so a
  // sub-agent learns nothing about ids that are not its own.
  const notFound = () => json(res, { error: 'Not found' }, 404)

  // GET /api/decisions/:id
  if (!action && method === 'GET') {
    const d = DECISION_ID_RE.test(id) ? getDecision(id) : undefined
    if (!d || !visibleTo(ctx, d)) { notFound(); return true }
    json(res, d)
    return true
  }

  // POST /api/decisions/:id/answer -- the owner only
  if (action === 'answer' && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) {
      logger.warn({ id, auth: ctx.auth?.kind, agent: ctx.auth?.agent }, 'decision answer refused: no owner session')
      json(res, OWNER_ONLY, 403)
      return true
    }
    const body = await readJsonObject(ctx); if (!body) return true
    const d = DECISION_ID_RE.test(id) ? getDecision(id) : undefined
    if (!d) { notFound(); return true }
    const key = body.answer_key === undefined || body.answer_key === null ? null : body.answer_key
    const text = optText(body.answer_text, 'answer_text', DECISION_LIMITS.answerText)
    if (!text.ok) { json(res, { error: text.error }, 400); return true }
    if (key !== null && (typeof key !== 'string' || !d.options.some((o) => o.key === key))) {
      json(res, { error: 'answer_key, if given, must be one of the decision\'s option keys' }, 400)
      return true
    }
    if (key === null && (text.value === null || !text.value.trim())) {
      json(res, { error: 'an answer needs answer_key, answer_text, or both' }, 400)
      return true
    }
    // The server names who answered; nothing in the body can. The cookie is the owner's proof; the bare shared token
    // passes mayActAsOwner only before the first dashboard login exists.
    const by = `owner_session:${ownerCookieSession(req) ?? (ctx.auth?.kind === 'session' ? ctx.auth.user ?? 'owner' : 'first-run')}`
    const r = answerDecision(id, { key: key as string | null, text: text.value, by, channel: 'page' })
    if (!r.ok) {
      if (r.reason === 'not_found') { notFound(); return true }
      json(res, { error: `Already ${r.decision?.status}`, decision: r.decision }, 409)
      return true
    }
    logger.info({ id, asker: r.decision.asker, key, by, messageId: r.messageId }, 'decision answered')
    json(res, { ok: true, decision: r.decision, message_id: r.messageId })
    return true
  }

  // POST /api/decisions/:id/withdraw | /supersede {new_id} -- the asker only
  if ((action === 'withdraw' || action === 'supersede') && method === 'POST') {
    if (ctx.auth?.kind !== 'token') {
      json(res, { error: 'a decision is withdrawn or superseded by the agent that filed it' }, 403)
      return true
    }
    const body = await readJsonObject(ctx); if (!body) return true
    const actor = body.actor
    if (typeof actor !== 'string' || !AGENT_NAME_RE.test(actor)) { json(res, { error: 'actor is required: the calling agent\'s name' }, 400); return true }
    const sub = subAgentOf(ctx)
    if (sub !== undefined && actor !== sub) {
      json(res, { error: `actor must be the calling agent '${sub}'`, rule: 'agent-identity-binding' }, 403)
      return true
    }
    const actorMismatch = agentHeaderMismatch(ctx, actor)
    if (actorMismatch) { json(res, { error: actorMismatch }, 400); return true }
    const d = DECISION_ID_RE.test(id) ? getDecision(id) : undefined
    if (!d || !visibleTo(ctx, d)) { notFound(); return true }
    let newId: string | undefined
    if (action === 'supersede') {
      const n = body.new_id
      const next = typeof n === 'string' && DECISION_ID_RE.test(n) && n !== id ? getDecision(n) : undefined
      if (!next || next.asker !== d.asker || next.status !== 'open') {
        json(res, { error: 'new_id must be another open decision filed by the same asker' }, 400)
        return true
      }
      newId = next.id
    }
    const r = closeDecisionByAsker(id, actor, action === 'withdraw' ? 'withdrawn' : 'superseded', newId)
    if (!r.ok) {
      if (r.reason === 'not_found') { notFound(); return true }
      if (r.reason === 'not_asker') { json(res, { error: 'only the agent that filed a decision withdraws or supersedes it' }, 403); return true }
      json(res, { error: `Already ${r.decision?.status}`, decision: r.decision }, 409)
      return true
    }
    logger.info({ id, actor, to: r.decision.status, superseded_by: r.decision.superseded_by }, 'decision closed by its asker')
    json(res, { ok: true, decision: r.decision })
    return true
  }

  json(res, { error: 'Method not allowed' }, 405)
  return true
}
