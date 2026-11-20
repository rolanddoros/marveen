// Card 58b9aa06: voice STT runs OFF the router tick. With whisper large-v3 a transcription takes minutes (budget
// 900 s), and the tick used to await it: every agent's delivery stood still meanwhile. Pinned here, end to end
// through runMessageRouterTick with a transcription held open by the test:
// - another agent's message is delivered in the same tick and the next one while the STT is still running;
// - the voice row stays pending until its outcome is in, then goes out with the transcript;
// - a later row to the SAME agent waits behind the voice row (order kept), a STOP/urgent row does not;
// - a timed-out STT is never silent: the delivered prompt carries the timeout notice above the raw block;
// - a row closed meanwhile is not sent, and its job is dropped.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stateDir = mkdtempSync(join(tmpdir(), 'router-stt-offtick-'))
writeFileSync(join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=x\n')

type Outcome = { ok: true; text: string } | { ok: false; reason: 'timeout'; budgetS: number } | { ok: false; reason: 'failed' }
const stt = vi.hoisted(() => ({ calls: [] as Array<{ fileId: string; resolve: (o: unknown) => void }> }))
const statusOf = vi.hoisted(() => new Map<number, string>())
const mockSendPrompt = vi.fn(async (..._a: unknown[]) => 'sent' as const)

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
  VOICE_TRANSCRIBE_INBOUND: false,
}))
const pending: any[] = []
vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => (toAgent ? [] : pending.splice(0)),
  getMessageStatus: (id: number) => statusOf.get(id) ?? 'pending',
  markMessageDelivered: (id: number) => { statusOf.set(id, 'delivered'); return true },
  markMessageFailed: () => true,
  markMessageDone: () => true,
  markPendingFederatedFailed: () => true,
  setMessageResult: () => true,
  createAgentMessage: () => ({ id: 999 }),
  countNewerMessagesFromSameSender: () => 0,
  stampMessageTrace: () => false,
  upsertOtelSpan: () => undefined,
  closeOtelSpan: () => false,
}))
vi.mock('../web/voice-directive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/voice-directive.js')>()),
  resolveAgentChannelStateDir: () => stateDir,
}))
vi.mock('../web/routes/voice.js', () => ({
  transcribeVoiceFileOutcome: (fileId: string) => new Promise((resolve) => { stt.calls.push({ fileId, resolve }) }),
}))
vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentPullDelivery: () => false,
  readAgentVoiceConfig: () => ({ responseMode: 'voice', voiceModel: 'm' }),
  readAgentWorksourceChannel: () => false,
}))
vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(async () => true),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  sessionExistsOnHost: () => true,
  capturePane: () => '',
}))
vi.mock('../web/voice-modality.js', () => ({ setLastInboundModality: vi.fn() }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'orin-channels' }))
vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'channel-inbound', safeFrom: 'telegram' }),
  wrapAgentMessageForDelivery: (_c: unknown, _s: unknown, _f: unknown, content: string) => ({ prefix: '', wrapped: content }),
}))
vi.mock('../web/telegram-inbox-wake.js', () => ({ maybeWakeSubAgentsForTelegram: vi.fn() }))

import { runMessageRouterTick, voiceSttHoldsRow, _voiceSttJobsForTest, _resetVoiceSttJobsForTest } from '../web/message-router.js'

afterAll(() => rmSync(stateDir, { recursive: true, force: true }))

let nextId = 500
function row(to: string, content: string, extra: Record<string, unknown> = {}) {
  return { id: nextId++, from_agent: 'telegram', to_agent: to, content, created_at: Math.floor(Date.now() / 1000), origin_note: null, trace_id: null, span_id: null, urgent: 0, ...extra }
}
const voice = (to: string) => row(to, `<channel source="telegram" chat_id="12345" message_id="7" attachment_kind="voice" attachment_file_id="FILE${nextId}">(voice message)</channel>`)
const text = (to: string, t: string, extra: Record<string, unknown> = {}) => row(to, `<channel source="telegram" chat_id="12345" message_id="8">${t}</channel>`, extra)
const sentTo = () => mockSendPrompt.mock.calls.map((c) => ({ session: String(c[0]), text: String(c[1]) }))
const flush = () => new Promise((r) => setTimeout(r, 10))

/** One tick over the given still-pending rows (the DB snapshot the tick reads). */
async function tick(...rows: any[]) {
  pending.push(...rows.filter((r) => (statusOf.get(r.id) ?? 'pending') === 'pending'))
  await runMessageRouterTick()
  await flush()
}

describe('voice STT off the router tick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pending.length = 0
    stt.calls.length = 0
    statusOf.clear()
    _resetVoiceSttJobsForTest()
  })

  it('a running transcription does not hold another agent\'s message, now or on the next tick', async () => {
    const v = voice('dex')
    const other = text('eve', 'szia Eve')
    // The tick must COMPLETE while the STT is open; on the old code it awaited the STT and never returned.
    pending.push(v, other)
    const t = runMessageRouterTick()
    const finished = await Promise.race([t.then(() => true), new Promise((r) => setTimeout(() => r(false), 500))])
    try {
      expect(finished).toBe(true)
      await flush() // the STT call itself starts after a few awaits (callVoiceSTT's dynamic imports)
      expect(stt.calls).toHaveLength(1)
      expect(sentTo().map((s) => s.session)).toEqual(['agent-eve'])
      const other2 = text('eve', 'második')
      await tick(v, other2)
      expect(sentTo().map((s) => s.session)).toEqual(['agent-eve', 'agent-eve'])
      expect(stt.calls).toHaveLength(1) // not started twice
      expect(statusOf.get(v.id)).toBeUndefined() // still pending
    } finally {
      await flush()
      stt.calls.forEach((c) => c.resolve({ ok: true, text: 'x' }))
      await t
      await flush()
    }
  })

  it('the voice row goes out with the transcript once the outcome is in; the job is then dropped', async () => {
    const v = voice('dex')
    await tick(v)
    expect(sentTo()).toEqual([])
    stt.calls[0]!.resolve({ ok: true, text: 'hello from a voice note' } satisfies Outcome)
    await flush()
    await tick(v)
    expect(sentTo()).toHaveLength(1)
    expect(sentTo()[0]!.text).toContain('[Hang átirat]: hello from a voice note')
    expect(_voiceSttJobsForTest().size).toBe(0)
  })

  it('a later row to the same agent waits behind the voice row, and goes right after it', async () => {
    const v = voice('dex')
    const later = text('dex', 'és még valami')
    await tick(v, later)
    expect(sentTo()).toEqual([])
    expect(voiceSttHoldsRow(later)).toBe(true)
    await tick(v, later)
    expect(sentTo()).toEqual([])
    stt.calls[0]!.resolve({ ok: true, text: 'első' })
    await flush()
    await tick(v, later)
    expect(sentTo().map((s) => s.text)).toEqual([expect.stringContaining('[Hang átirat]: első'), expect.stringContaining('és még valami')])
  })

  it('an urgent row is not held behind a transcription', async () => {
    const v = voice('dex')
    const urgent = text('dex', 'STOP', { urgent: 1 })
    expect(voiceSttHoldsRow(urgent)).toBe(false) // no job yet
    await tick(v)
    expect(voiceSttHoldsRow(urgent)).toBe(false)
    expect(voiceSttHoldsRow(text('dex', 'plain'))).toBe(true)
    stt.calls[0]!.resolve({ ok: false, reason: 'failed' })
  })

  it('a timed-out transcription is delivered with the visible timeout notice above the raw voice block', async () => {
    const v = voice('dex')
    await tick(v)
    stt.calls[0]!.resolve({ ok: false, reason: 'timeout', budgetS: 900 } satisfies Outcome)
    await flush()
    await tick(v)
    const delivered = sentTo()[0]!.text
    expect(delivered).toMatch(/^\[Hang átirat\]: időtúllépés, 900 s alatt nem készült el az átirat \(transcription timed out\)\. Kézi újrapróbálás: scripts\/voice\/stt\.sh FILE\d+\n/)
    expect(delivered).toContain('attachment_kind="voice"')
  })

  it('a failed transcription still delivers the raw voice block (unchanged fallback)', async () => {
    const v = voice('dex')
    await tick(v)
    stt.calls[0]!.resolve({ ok: false, reason: 'failed' })
    await flush()
    await tick(v)
    expect(sentTo()[0]!.text).toContain('attachment_kind="voice"')
    expect(sentTo()[0]!.text).not.toContain('időtúllépés')
  })

  it('a row closed while its STT ran is not sent, and the job is swept', async () => {
    const v = voice('dex')
    await tick(v)
    stt.calls[0]!.resolve({ ok: true, text: 'késő' })
    await flush()
    statusOf.set(v.id, 'done')
    await tick(v) // not re-listed: the sweep at the tick start drops the finished job of a non-pending row
    expect(sentTo()).toEqual([])
    expect(_voiceSttJobsForTest().size).toBe(0)
  })
})
