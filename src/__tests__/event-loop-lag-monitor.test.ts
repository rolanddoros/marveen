// Event-loop-lag monitor. Pins the pure read/classify logic and the sample-once
// behaviour (log-on-block + always-reset) against a fake histogram, and the JS-timer
// recorder that replaced perf_hooks.monitorEventLoopDelay (clock-jump rules, window reset).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
import {
  readLagSample, classifyLagSample, sampleLagOnce, createLagRecorder, type LagHistogram,
} from '../web/event-loop-lag-monitor.js'

const MS = 1e6 // ns per ms

function fakeHistogram(over: Partial<LagHistogram> = {}): LagHistogram & { resetCalls: number } {
  return {
    max: 0, mean: 0,
    percentile: () => 0,
    resetCalls: 0,
    reset() { this.resetCalls++ },
    ...over,
  } as LagHistogram & { resetCalls: number }
}

describe('readLagSample (ns -> ms, empty-window safe)', () => {
  it('converts nanoseconds to milliseconds', () => {
    const s = readLagSample(fakeHistogram({ max: 1500 * MS, mean: 12 * MS, percentile: () => 900 * MS }))
    expect(s).toEqual({ maxMs: 1500, meanMs: 12, p99Ms: 900 })
  })
  it('normalizes an empty window (max 0 / NaN mean) to 0, never NaN', () => {
    const s = readLagSample(fakeHistogram({ max: 0, mean: NaN, percentile: () => 0 }))
    expect(s).toEqual({ maxMs: 0, meanMs: 0, p99Ms: 0 })
  })
})

describe('classifyLagSample (gate on the window max)', () => {
  it('blocked when max >= threshold, ok below', () => {
    expect(classifyLagSample({ maxMs: 1200, meanMs: 5, p99Ms: 800 }, 1000)).toBe('blocked')
    expect(classifyLagSample({ maxMs: 1000, meanMs: 5, p99Ms: 800 }, 1000)).toBe('blocked') // inclusive
    expect(classifyLagSample({ maxMs: 999, meanMs: 5, p99Ms: 800 }, 1000)).toBe('ok')
  })
})

describe('sampleLagOnce (log-on-block + always reset)', () => {
  beforeEach(() => { warn.mockClear() })
  it('reports blocked, logs ONE warning with the numbers and resets when the loop was blocked past the threshold', () => {
    const h = fakeHistogram({ max: 3000 * MS, mean: 40 * MS, percentile: () => 2500 * MS })
    expect(sampleLagOnce(h, 1000)).toBe('blocked')
    expect(h.resetCalls).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toEqual({ maxMs: 3000, meanMs: 40, p99Ms: 2500, thresholdMs: 1000 })
  })
  it('reports ok, logs nothing and STILL resets on a healthy window (fresh window each sample)', () => {
    const h = fakeHistogram({ max: 30 * MS, mean: 4 * MS, percentile: () => 12 * MS })
    expect(sampleLagOnce(h, 1000)).toBe('ok')
    expect(h.resetCalls).toBe(1)
    expect(warn).not.toHaveBeenCalled()
  })
  it('a reset failure never throws out of the sample (best-effort observability)', () => {
    const h = fakeHistogram({ max: 5000 * MS, reset() { throw new Error('boom') } })
    // Observability must never disrupt: the verdict is still returned and the throw is swallowed.
    expect(sampleLagOnce(h, 1000)).toBe('blocked')
  })
})

describe('sampleLagOnce resets even when reading the window throws', () => {
  it('a throwing percentile still resets the histogram', () => {
    const h = fakeHistogram({ max: 5000 * MS, percentile: () => { throw new Error('boom') } })
    expect(() => sampleLagOnce(h, 1000)).toThrow('boom')
    expect(h.resetCalls).toBe(1)
  })
})

describe('startEventLoopLagMonitor', () => {
  it('stop() clears every timer (initial, window interval, tick)', async () => {
    vi.useFakeTimers()
    try {
      const { startEventLoopLagMonitor } = await import('../web/event-loop-lag-monitor.js')
      const before = vi.getTimerCount()
      const handle = startEventLoopLagMonitor()
      // initial window timeout + window interval + the JS tick interval
      expect(vi.getTimerCount()).toBe(before + 3)
      handle.stop()
      expect(vi.getTimerCount()).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a WARN threshold below the floor falls back to the default; a sane one is kept', async () => {
    const prev = process.env.EVENT_LOOP_LAG_WARN_MS
    try {
      for (const [env, want] of [['1', 1000], ['0.001', 1000], ['abc', 1000], ['250', 250]] as const) {
        process.env.EVENT_LOOP_LAG_WARN_MS = env
        vi.resetModules()
        const m = await import('../web/event-loop-lag-monitor.js')
        const handle = m.startEventLoopLagMonitor()
        handle.stop()
        expect(handle.warnMs).toBe(want)
      }
    } finally {
      if (prev === undefined) delete process.env.EVENT_LOOP_LAG_WARN_MS
      else process.env.EVENT_LOOP_LAG_WARN_MS = prev
      vi.resetModules()
    }
  })
})

// Feed a recorder a list of tick timestamps (ms), starting from the anchor `start`.
function recorderFed(start: number, ticks: number[], tickMs = 20, capMs = 60_000) {
  const r = createLagRecorder(tickMs, capMs, start)
  for (const t of ticks) r.recordTick(t)
  return r
}

describe('createLagRecorder (JS-timer drift per tick)', () => {
  it('records drift = gap - tick; on-time ticks are 0, a late tick is its lateness', () => {
    const r = recorderFed(0, [20, 40, 1560, 1580]) // the third tick ran 1500ms late
    expect(r.count).toBe(4)
    expect(readLagSample(r)).toEqual({ maxMs: 1500, meanMs: 375, p99Ms: 1500 })
  })

  it('a tick that fires early by jitter counts as 0, never negative', () => {
    const r = recorderFed(0, [19.5, 39])
    expect(readLagSample(r)).toEqual({ maxMs: 0, meanMs: 0, p99Ms: 0 })
    expect(r.count).toBe(2)
  })

  it('an empty window reads as 0 / ok, never NaN', () => {
    const r = createLagRecorder(20, 60_000, 0)
    expect(readLagSample(r)).toEqual({ maxMs: 0, meanMs: 0, p99Ms: 0 })
  })

  it('a backward clock jump does not throw and does not change max/mean/p99 (dropped, re-anchored)', () => {
    const reference = recorderFed(0, [20, 50, 80]) // drifts 0, 10, 10
    let jumpy!: ReturnType<typeof createLagRecorder>
    // The clock steps back by ~1s between the 2nd and 3rd tick; the tick after it is 30ms later
    // on the NEW timeline (drift 10), exactly like the reference's third tick.
    expect(() => { jumpy = recorderFed(0, [20, 50, -1000, -970]) }).not.toThrow()
    expect(jumpy.count).toBe(reference.count)
    expect(readLagSample(jumpy)).toEqual(readLagSample(reference))
    expect(readLagSample(jumpy)).toEqual({ maxMs: 10, meanMs: 20 / 3, p99Ms: 10 })
  })

  it('a non-finite timestamp is ignored without throwing', () => {
    const r = recorderFed(0, [20, NaN, Infinity, 40])
    expect(r.count).toBe(2)
    expect(readLagSample(r).maxMs).toBe(0)
  })

  it('a huge forward jump is clamped to the 60s cap (default cap), so it warns once without blowing up mean/p99', () => {
    const r = createLagRecorder(undefined, undefined, 0) // module defaults: 20ms tick, 60s cap
    r.recordTick(20)
    r.recordTick(20 + 3_600_000) // the clock leaps one hour forward
    expect(readLagSample(r)).toEqual({ maxMs: 60_000, meanMs: 30_000, p99Ms: 60_000 })
    warn.mockClear()
    expect(sampleLagOnce(r, 1000)).toBe('blocked')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toEqual({ maxMs: 60_000, meanMs: 30_000, p99Ms: 60_000, thresholdMs: 1000 })
  })

  it('p99 is the nearest-rank 99th percentile of the window', () => {
    // 100 ticks: 99 on time, 1 late by 500ms -> p99 is still 0, max is 500
    const ticks: number[] = []
    let t = 0
    for (let i = 0; i < 100; i++) { t += i === 50 ? 520 : 20; ticks.push(t) }
    const r = recorderFed(0, ticks)
    expect(readLagSample(r)).toEqual({ maxMs: 500, meanMs: 5, p99Ms: 0 })
    t += 520; r.recordTick(t) // a second late tick: now 2 of 101 -> p99 picks it up
    expect(readLagSample(r).p99Ms).toBe(500)
  })

  it('every window starts fresh: a blocked window does not leak into the next one', () => {
    const r = recorderFed(0, [20, 1540]) // 1500ms block
    warn.mockClear()
    expect(sampleLagOnce(r, 1000)).toBe('blocked')
    expect(r.count).toBe(0)
    r.recordTick(1560); r.recordTick(1580) // the anchor survives the reset: on-time ticks, drift 0
    expect(readLagSample(r)).toEqual({ maxMs: 0, meanMs: 0, p99Ms: 0 })
    expect(sampleLagOnce(r, 1000)).toBe('ok')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a real busy loop past the threshold is measured on the real clock and timer', async () => {
    const r = createLagRecorder(20, 60_000, performance.now())
    const iv = setInterval(() => r.recordTick(performance.now()), 20)
    try {
      await new Promise((res) => setTimeout(res, 60))
      const until = performance.now() + 300
      while (performance.now() < until) { /* block the loop */ }
      await new Promise((res) => setTimeout(res, 60))
    } finally {
      clearInterval(iv)
    }
    warn.mockClear()
    expect(readLagSample(r).maxMs).toBeGreaterThanOrEqual(250)
    expect(sampleLagOnce(r, 200)).toBe('blocked')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('startEventLoopLagMonitor end to end (fake timers, injected clock)', () => {
  // Drive the monitor's own timers; the injected clock moves with them, plus any extra jump.
  async function drive(jumps: Record<number, number>) {
    vi.useFakeTimers()
    try {
      vi.resetModules()
      delete process.env.EVENT_LOOP_LAG_WARN_MS
      delete process.env.EVENT_LOOP_LAG_SAMPLE_MS
      const m = await import('../web/event-loop-lag-monitor.js')
      let t = 1_000_000
      warn.mockClear()
      const handle = m.startEventLoopLagMonitor(() => t)
      try {
        // 1000 ticks of 20ms = the 20s initial delay, when the first window is read.
        for (let i = 1; i <= 1000; i++) {
          t += 20 + (jumps[i] ?? 0)
          vi.advanceTimersByTime(20)
        }
      } finally {
        handle.stop()
      }
    } finally {
      vi.useRealTimers()
      vi.resetModules()
    }
  }

  it('a real block (a tick 1500ms late) yields the WARN line with the numbers', async () => {
    await drive({ 10: 1500 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatchObject({ maxMs: 1500, p99Ms: 0, thresholdMs: 1000 })
    expect(String(warn.mock.calls[0][1])).toContain('event-loop-lag: the event loop was BLOCKED past the threshold this window')
  })

  it('a backward clock jump mid-window neither throws nor warns', async () => {
    await expect(drive({ 10: -100_000 })).resolves.toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('stop() leaves no timer behind and nothing fires after it', async () => {
    vi.useFakeTimers()
    try {
      vi.resetModules()
      const m = await import('../web/event-loop-lag-monitor.js')
      const before = vi.getTimerCount()
      const clock = vi.fn(() => 0)
      const handle = m.startEventLoopLagMonitor(clock)
      expect(vi.getTimerCount()).toBe(before + 3)
      handle.stop()
      expect(vi.getTimerCount()).toBe(before)
      const calls = clock.mock.calls.length
      warn.mockClear()
      vi.advanceTimersByTime(120_000)
      expect(clock.mock.calls.length).toBe(calls)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      vi.resetModules()
    }
  })
})

describe('no native perf_hooks histogram in the module (the abort source)', () => {
  it('the code (comments stripped) never references monitorEventLoopDelay, createHistogram or perf_hooks', () => {
    const src = readFileSync(fileURLToPath(new URL('../web/event-loop-lag-monitor.ts', import.meta.url)), 'utf8')
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/monitorEventLoopDelay|createHistogram|perf_hooks/)
    expect(code).toContain('performance.now()')
  })
})
