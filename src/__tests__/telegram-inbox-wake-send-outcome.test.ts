// The sub-agent wake-nudge acts on what the send REALLY did (telegram-inbox-wake.ts).
//
// The send used to be fire-and-forget: sendPromptToSession is async and reports
// 'sent' | 'aborted-busy' | 'skipped-locked' | ..., but its result was ignored, so a
// busy or locked pane spent an attempt of the per-backlog budget and was logged as
// "nudged", and a rejection escaped the per-agent try/catch as an unhandled rejection
// (found by @typescript-eslint/no-floating-promises, B2-4). Rules (Johnny 12196, Kevin
// 12197): 'sent' -> lastWakeAt + attempts + the "nudged" line; anything else ->
// lastWakeAt only (debounce), attempts unchanged, and the line names the outcome; a
// rejected SEND -> the existing warn, lastWakeAt set and one attempt spent, so the attempt budget
// ends a send that keeps failing (Kevin 12202, 12218); a failing check BEFORE the send -> the same
// warn, no debounce, no attempt.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STATE_DIR = mkdtempSync(join(tmpdir(), 'wake-outcome-'))

const send = vi.fn()
const ready = vi.fn()
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: true,
}))
vi.mock('../web/voice-directive.js', () => ({ resolveAgentChannelStateDir: () => STATE_DIR }))
let agentNames = ['sub1']
vi.mock('../web/agent-config.js', () => ({ listAgentNames: () => agentNames, readAgentRemoteHost: () => null }))
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: (...args: unknown[]) => ready(...args),
  clearFeedbackModalAndRecheck: async () => false,
  sessionExistsOnHost: () => true,
  sendPromptToSession: (...args: unknown[]) => send(...args),
}))

const { maybeWakeSubAgentsForTelegram, _resetSubWakeStateForTest, _peekSubWakeStateForTest } = await import('../web/telegram-inbox-wake.js')
const { logger } = await import('../logger.js')

const NOW = 1_800_000_000_000
const INBOX = join(STATE_DIR, 'inbox-pending.jsonl')

beforeEach(() => {
  // Only Date is faked: the wake reads Date.now() at the end of a delivered send, so the
  // clock is pinned to the tick time (NOW) unless a test moves it. Timers stay real
  // (vi.waitFor needs them).
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  agentNames = ['sub1']
  _resetSubWakeStateForTest()
  send.mockReset()
  ready.mockReset()
  ready.mockResolvedValue(true)
  // a pending inbox, 60 s old: past the 25 s minimum age, nothing acted on yet
  writeFileSync(INBOX, '{"text":"hi"}\n')
  const t = (NOW - 60_000) / 1000
  utimesSync(INBOX, t, t)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
afterAll(() => { rmSync(STATE_DIR, { recursive: true, force: true }) })

function logs() {
  const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  const lines = (spy: typeof info) => spy.mock.calls.map((c) => String(c[1] ?? c[0]))
  return { info: () => lines(info), warn: () => lines(warn), infoArgs: () => info.mock.calls.map((c) => c[0] as Record<string, unknown>) }
}

describe('maybeWakeSubAgentsForTelegram: the send outcome decides the state and the log line', () => {
  it("'sent': lastWakeAt is now, one attempt spent, and the line says nudged", async () => {
    send.mockResolvedValue('sent')
    const l = logs()
    await maybeWakeSubAgentsForTelegram(NOW)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('agent-sub1')
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: NOW, attempts: 1 })
    expect(l.info()).toEqual(['telegram-inbox-wake: nudged idle sub-agent (pending inbox)'])
    expect(l.warn()).toEqual([])
  })

  it.each(['aborted-busy', 'skipped-locked'])("'%s': lastWakeAt is now (debounce), no attempt spent, and the line names the outcome", async (outcome) => {
    send.mockResolvedValue(outcome)
    const l = logs()
    await maybeWakeSubAgentsForTelegram(NOW)
    expect(send).toHaveBeenCalledTimes(1)
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: NOW, attempts: 0 })
    expect(l.info()).toEqual([`telegram-inbox-wake: nudge not sent (${outcome})`])
    expect(l.infoArgs()[0]).toMatchObject({ agent: 'sub1', outcome, attempt: 0 })
    expect(l.info().join('\n')).not.toContain('nudged')
  })

  it("an 'aborted-busy' send debounces: the next tick inside the debounce window does not send again", async () => {
    send.mockResolvedValue('aborted-busy')
    logs()
    await maybeWakeSubAgentsForTelegram(NOW)
    await maybeWakeSubAgentsForTelegram(NOW + 30_000)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a rejected send lands in the per-agent catch (warn), debounces, and spends one attempt', async () => {
    send.mockRejectedValue(new Error('tmux gone'))
    const l = logs()
    await maybeWakeSubAgentsForTelegram(NOW)
    expect(send).toHaveBeenCalledTimes(1)
    expect(l.warn()).toEqual(['telegram-inbox-wake: wake check failed'])
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: NOW, attempts: 1 })
    expect(l.info()).toEqual([])
  })

  // Ron's cadence probe (12216), pinned as he ran it (Johnny 12221): a tick every 10 s for two
  // simulated hours against a send that always rejects. Uncounted, it retried at every debounce
  // with no end (121 sends); counted, the attempt budget is the brake: 5 sends, as on the base.
  it('a persistently rejecting send stops at the attempt budget (5 sends in 2 hours of 10 s ticks)', async () => {
    send.mockRejectedValue(new Error('tmux gone'))
    logs()
    for (let t = 0; t <= 2 * 60 * 60_000; t += 10_000) await maybeWakeSubAgentsForTelegram(NOW + t)
    expect(send).toHaveBeenCalledTimes(5)
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ attempts: 5 })
  })

  it('the peek is a copy: changing it does not change the wake state', async () => {
    send.mockResolvedValue('sent')
    logs()
    await maybeWakeSubAgentsForTelegram(NOW)
    const peek = _peekSubWakeStateForTest('sub1')!
    peek.attempts = 99
    peek.lastWakeAt = 0
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: NOW, attempts: 1 })
  })

  it('a check that throws BEFORE the send: the same warn, but no debounce and no send', async () => {
    ready.mockRejectedValue(new Error('capture-pane failed'))
    const l = logs()
    await maybeWakeSubAgentsForTelegram(NOW)
    expect(send).not.toHaveBeenCalled()
    expect(l.warn()).toEqual(['telegram-inbox-wake: wake check failed'])
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: 0, attempts: 0 })
  })
})

// The wake nudge is optional (it only triggers the drain hook), so it sends like the main
// inbox-nudge watcher: 'abort' after a 2 s idle wait, never a best-effort send into a busy
// pane (Kevin 12230, plan 12229).
describe('maybeWakeSubAgentsForTelegram: the send policy', () => {
  it("sends with { onBusyTimeout: 'abort', idleTimeoutMs: 2_000 }", async () => {
    send.mockResolvedValue('sent')
    logs()
    await maybeWakeSubAgentsForTelegram(NOW)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]).toHaveLength(4)
    expect(send.mock.calls[0][3]).toEqual({ onBusyTimeout: 'abort', idleTimeoutMs: 2_000 })
  })

  it("'aborted-busy' only debounces: +30 s does not send, +61 s does, and no attempt is spent", async () => {
    send.mockResolvedValue('aborted-busy')
    logs()
    await maybeWakeSubAgentsForTelegram(NOW)
    await maybeWakeSubAgentsForTelegram(NOW + 30_000)
    expect(send).toHaveBeenCalledTimes(1)
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: NOW, attempts: 0 })
    await maybeWakeSubAgentsForTelegram(NOW + 61_000)
    expect(send).toHaveBeenCalledTimes(2)
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: NOW + 61_000, attempts: 0 })
  })
})

// The router starts the wake with `void` on every tick, outside its own re-entrancy guard,
// and the call awaits the send. A send that outlasts the 60 s debounce (idle wait + lane
// wait) let the next tick nudge the same agent again (Ron 12216, probe 2: 2 sends). One
// in-flight wake per agent, cleared in finally; another agent is not held up (Kevin 12230).
describe('maybeWakeSubAgentsForTelegram: one wake in flight per agent', () => {
  function deferred() {
    let resolve!: (v: string) => void
    const promise = new Promise<string>((r) => { resolve = r })
    return { promise, resolve }
  }

  it('a send that takes > 60 s: later ticks do not send while it runs; the backoff counts from its END, so the first tick after it does not nudge again', async () => {
    const slow = deferred()
    send.mockReturnValueOnce(slow.promise).mockResolvedValue('sent')
    logs()
    const first = maybeWakeSubAgentsForTelegram(NOW)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    // past the 60 s debounce, twice: the second tick checks that a skipping call does not
    // clear the flag the first call holds
    await maybeWakeSubAgentsForTelegram(NOW + 61_000)
    await maybeWakeSubAgentsForTelegram(NOW + 122_000)
    expect(send).toHaveBeenCalledTimes(1)
    // the send returns 70 s after the tick that started it
    vi.setSystemTime(NOW + 70_000)
    slow.resolve('sent')
    await first
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: NOW + 70_000, attempts: 1 })
    // 121 s after the START, but only 51 s after the nudge landed: inside the 120 s backoff of
    // attempt 1, so no second nudge into the pane that just got one (Ron 12296, Kevin 12380)
    await maybeWakeSubAgentsForTelegram(NOW + 121_000)
    expect(send).toHaveBeenCalledTimes(1)
    // 121 s after the END: the flag is gone and the backoff is over, the next tick sends
    await maybeWakeSubAgentsForTelegram(NOW + 191_000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  // Only a DELIVERED nudge moves lastWakeAt to the end of the run (Ron 12422, mutant L2): a busy
  // pane or a failing send keeps the tick time, so its retry window is not stretched.
  it("an 'aborted-busy' send that takes 3 s keeps lastWakeAt at the tick (NOW), not the end of the run", async () => {
    send.mockImplementation(async () => { vi.setSystemTime(NOW + 3_000); return 'aborted-busy' })
    logs()
    await maybeWakeSubAgentsForTelegram(NOW)
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: NOW, attempts: 0 })
  })

  it('a rejecting send that takes 3 s keeps lastWakeAt at the tick (NOW), not the end of the run', async () => {
    send.mockImplementation(async () => { vi.setSystemTime(NOW + 3_000); throw new Error('tmux gone') })
    logs()
    await maybeWakeSubAgentsForTelegram(NOW)
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: NOW, attempts: 1 })
  })

  it('a SHORT delivered send behaves as before, shifted only by its own few seconds', async () => {
    // a 3 s send: lastWakeAt is the end of the run (NOW + 3 s), so the 120 s backoff of
    // attempt 1 ends at NOW + 123 s instead of NOW + 120 s
    send.mockImplementation(async () => { vi.setSystemTime(NOW + 3_000); return 'sent' })
    logs()
    await maybeWakeSubAgentsForTelegram(NOW)
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: NOW + 3_000, attempts: 1 })
    await maybeWakeSubAgentsForTelegram(NOW + 122_000)
    expect(send).toHaveBeenCalledTimes(1)
    await maybeWakeSubAgentsForTelegram(NOW + 123_000)
    expect(send).toHaveBeenCalledTimes(2)
    // the tick's own time is the floor: the mock clock (NOW + 3 s) is behind this tick
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: NOW + 123_000, attempts: 2 })
  })

  it('the flag is cleared when the send rejects, too', async () => {
    const slow = deferred()
    send.mockReturnValueOnce(slow.promise.then(() => { throw new Error('tmux gone') })).mockResolvedValue('sent')
    logs()
    const first = maybeWakeSubAgentsForTelegram(NOW)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    slow.resolve('x')
    await first
    await maybeWakeSubAgentsForTelegram(NOW + 121_000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it("one agent's wake in flight does not block another agent's wake", async () => {
    agentNames = ['sub1', 'sub2']
    const slow = deferred()
    send.mockImplementation((session: string) => (session === 'agent-sub1' ? slow.promise : Promise.resolve('sent')))
    logs()
    const first = maybeWakeSubAgentsForTelegram(NOW)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][0]).toBe('agent-sub1')
    // the first call is stuck on sub1 and has not reached sub2; the next tick skips sub1 and wakes sub2
    await maybeWakeSubAgentsForTelegram(NOW + 5_000)
    expect(send.mock.calls.map((c) => c[0])).toEqual(['agent-sub1', 'agent-sub2'])
    slow.resolve('sent')
    await first
  })
})

// A new inbound carries the last wake time over, clamped to the tick (Ron 12422, Kevin 12550):
// a clock stepped forward and then back left a FUTURE lastWakeAt, and the gate
// (now - lastWakeAt < backoff) blocked every new inbound until the clock caught up.
describe('maybeWakeSubAgentsForTelegram: a future lastWakeAt and a new inbound', () => {
  function newInbound(at: number) {
    writeFileSync(INBOX, '{"text":"hi"}\n{"text":"again"}\n')
    utimesSync(INBOX, at / 1000, at / 1000)
  }

  it('a clock stepped forward then back: the new inbound waits one backoff from the tick, not until the clock catches up', async () => {
    // the delivered send ends on a clock 1 h ahead, so lastWakeAt is NOW + 1 h
    send.mockImplementationOnce(async () => { vi.setSystemTime(NOW + 3_600_000); return 'sent' }).mockResolvedValue('sent')
    logs()
    await maybeWakeSubAgentsForTelegram(NOW)
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: NOW + 3_600_000, attempts: 1 })
    // the clock steps back; a new inbound lands at NOW + 10 s
    vi.setSystemTime(NOW + 40_000)
    newInbound(NOW + 10_000)
    await maybeWakeSubAgentsForTelegram(NOW + 40_000)
    // clamped to this tick, which is no immediate wake: 0 s is inside the 60 s backoff
    expect(send).toHaveBeenCalledTimes(1)
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: NOW + 40_000, attempts: 0, inboxMtimeMs: NOW + 10_000 })
    // one backoff later the new inbound is nudged, about an hour before the clock catches up
    vi.setSystemTime(NOW + 100_000)
    await maybeWakeSubAgentsForTelegram(NOW + 100_000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  // Why the clamp and not "a negative now - lastWakeAt counts as expired" at the gates: the
  // router's tick clock can be older than the END of a delivered send (calls overlap), and that
  // negative difference is a nudge that just landed, not a clock step (Ron 12296, Kevin 12380).
  it('a call whose tick clock is older than the end of a delivered send does not nudge again', async () => {
    send.mockImplementationOnce(async () => { vi.setSystemTime(NOW + 70_000); return 'sent' }).mockResolvedValue('sent')
    logs()
    await maybeWakeSubAgentsForTelegram(NOW)
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: NOW + 70_000, attempts: 1 })
    // a tick that took its clock at NOW + 61 s, before the send ended, reaches the agent after it
    await maybeWakeSubAgentsForTelegram(NOW + 61_000)
    expect(send).toHaveBeenCalledTimes(1)
    // the same backlog keeps the END: the clamp is only for a new inbound (Ron 12571, mutant Mall)
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: NOW + 70_000 })
  })

  // The clamp uses the wall clock, not the late call's tick clock (Ron 12571, Kevin 12573): with
  // `now`, a new inbound seen by a late call pulled the END of a delivered send back to that
  // `now`, and the next nudge came early.
  it('a late call that sees a new inbound keeps the END of a delivered send', async () => {
    send.mockImplementationOnce(async () => { vi.setSystemTime(NOW + 70_000); return 'sent' }).mockResolvedValue('sent')
    logs()
    await maybeWakeSubAgentsForTelegram(NOW)
    // a new inbound at NOW + 10 s; a tick that took its clock at NOW + 61 s runs after the send ended
    newInbound(NOW + 10_000)
    vi.setSystemTime(NOW + 71_000)
    await maybeWakeSubAgentsForTelegram(NOW + 61_000)
    expect(send).toHaveBeenCalledTimes(1)
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: NOW + 70_000, attempts: 0, inboxMtimeMs: NOW + 10_000 })
    // the 60 s backoff of the new backlog counts from the END
    vi.setSystemTime(NOW + 129_000)
    await maybeWakeSubAgentsForTelegram(NOW + 129_000)
    expect(send).toHaveBeenCalledTimes(1)
    vi.setSystemTime(NOW + 130_000)
    await maybeWakeSubAgentsForTelegram(NOW + 130_000)
    expect(send).toHaveBeenCalledTimes(2)
  })
})
