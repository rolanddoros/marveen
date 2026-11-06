// The sub-agent wake-nudge acts on what the send REALLY did (telegram-inbox-wake.ts).
//
// The send used to be fire-and-forget: sendPromptToSession is async and reports
// 'sent' | 'aborted-busy' | 'skipped-locked' | ..., but its result was ignored, so a
// busy or locked pane spent an attempt of the per-backlog budget and was logged as
// "nudged", and a rejection escaped the per-agent try/catch as an unhandled rejection
// (found by @typescript-eslint/no-floating-promises, B2-4). Rules (Johnny 12196, Kevin
// 12197): 'sent' -> lastWakeAt + attempts + the "nudged" line; anything else ->
// lastWakeAt only (debounce), attempts unchanged, and the line names the outcome; a
// rejected SEND -> the existing warn, lastWakeAt set (debounce), attempts unchanged; a failing
// check BEFORE the send -> the same warn, no debounce (Kevin 12202).
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
vi.mock('../web/agent-config.js', () => ({ listAgentNames: () => ['sub1'], readAgentRemoteHost: () => null }))
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
  _resetSubWakeStateForTest()
  send.mockReset()
  ready.mockReset()
  ready.mockResolvedValue(true)
  // a pending inbox, 60 s old: past the 25 s minimum age, nothing acted on yet
  writeFileSync(INBOX, '{"text":"hi"}\n')
  const t = (NOW - 60_000) / 1000
  utimesSync(INBOX, t, t)
})
afterEach(() => { vi.restoreAllMocks() })
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

  it('a rejected send lands in the per-agent catch (warn), debounces, and spends no attempt', async () => {
    send.mockRejectedValue(new Error('tmux gone'))
    const l = logs()
    await maybeWakeSubAgentsForTelegram(NOW)
    expect(send).toHaveBeenCalledTimes(1)
    expect(l.warn()).toEqual(['telegram-inbox-wake: wake check failed'])
    expect(_peekSubWakeStateForTest('sub1')).toMatchObject({ lastWakeAt: NOW, attempts: 0 })
    expect(l.info()).toEqual([])
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
