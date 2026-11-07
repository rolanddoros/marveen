// Event-loop-lag monitor: the DETECT side of the event-loop wedge class.
//
// Closing a known wedge source (a synchronous shell-out in a periodic sweep) fixes that one source.
// This is the complement: it DETECTS a wedge from ANY source
// -- a future/unknown sync shell-out, a runaway loop, a giant JSON.parse -- so a blocked
// event loop surfaces in seconds (a log line) instead of when a human notices the dashboard
// has gone unresponsive and manually restarts it.
//
// Mechanism: a plain JS interval ticks every TICK_MS; on each tick the drift of
// performance.now() past the expected tick is the time the loop was blocked before the tick
// could run. The drifts go into a per-window recorder. Once per window we read the window's
// max/mean/p99 and, if the max exceeds the threshold (the loop was blocked that long at
// least once), log a WARN with the numbers, then reset for the next window. Observability
// only: it never restarts or mutates anything.
//
// Why not perf_hooks.monitorEventLoopDelay: its native histogram asserts that the clock never
// goes backwards (node::Histogram::RecordDelta, "(time) >= (prev_)"). On a VM whose clock
// jumps back (seen at the hourly storage snapshot) that assert aborts the whole process, and
// a native abort cannot be caught from JS. Here a backward step is just a negative number,
// which the recorder drops.
import { logger } from '../logger.js'

// Read the window max/mean/p99 (WARN threshold is on the max: a single long block is the
// wedge signal, not a raised average). Sampled every 30s; blocked past 1s is "wedged".
const SAMPLE_MS = (() => {
  const v = Number(process.env.EVENT_LOOP_LAG_SAMPLE_MS)
  return Number.isFinite(v) && v >= 1000 ? v : 30_000
})()
const WARN_MS = (() => {
  const v = Number(process.env.EVENT_LOOP_LAG_WARN_MS)
  // Below ~5x the tick resolution, ordinary timer jitter would warn every window.
  return Number.isFinite(v) && v >= 100 ? v : 1000
})()
const INITIAL_DELAY_MS = 20_000
// Tick resolution: how often the JS timer measures the loop delay. 20ms is fine-grained
// enough to catch a wedge while adding negligible overhead.
const TICK_MS = 20
// Upper bound for ONE tick's drift. A forward clock jump cannot be told apart from a real
// block (both are "the tick ran late"), so it is clamped, not dropped: a stall of any length
// still yields its one WARN, while an hours-long jump cannot blow the window's mean/p99 up to
// meaningless values. 60s is 60x the default threshold, already unambiguously "blocked"; never
// below WARN_MS, so a raised threshold can still be crossed.
const MAX_DRIFT_MS = Math.max(60_000, WARN_MS)

export interface LagSample { maxMs: number; meanMs: number; p99Ms: number }

// The window statistics this module reads, in nanoseconds (the unit the original perf_hooks
// histogram used, kept so readLagSample and its tests stay unchanged). Declared so the
// read+classify logic is unit-testable against a fake (no real event loop needed).
export interface LagHistogram {
  max: number // nanoseconds
  mean: number // nanoseconds
  percentile(p: number): number // nanoseconds
  reset(): void
}

// Pure: convert a histogram's raw nanosecond stats into a millisecond sample. A window
// with no recorded samples reports max = 0 / a non-finite mean -- normalize those to 0 so an
// empty window reads as 'ok', never NaN.
export function readLagSample(h: LagHistogram): LagSample {
  const toMs = (ns: number) => (Number.isFinite(ns) && ns > 0 ? ns / 1e6 : 0)
  return { maxMs: toMs(h.max), meanMs: toMs(h.mean), p99Ms: toMs(h.percentile(99)) }
}

// Pure: was the loop blocked past the threshold in this window? (Gate on the max.)
export function classifyLagSample(s: LagSample, thresholdMs: number): 'ok' | 'blocked' {
  return s.maxMs >= thresholdMs ? 'blocked' : 'ok'
}

// Read one window, log on a block, and reset. Extracted + injectable so a test can drive
// it with a fake histogram; returns the classification for assertions.
export function sampleLagOnce(h: LagHistogram, thresholdMs: number = WARN_MS): 'ok' | 'blocked' {
  try {
    const sample = readLagSample(h)
    const verdict = classifyLagSample(sample, thresholdMs)
    if (verdict === 'blocked') {
      logger.warn(
        { maxMs: Math.round(sample.maxMs), meanMs: Math.round(sample.meanMs), p99Ms: Math.round(sample.p99Ms), thresholdMs },
        'event-loop-lag: the event loop was BLOCKED past the threshold this window -- the dashboard was unresponsive (possible wedge; look for long synchronous work)',
      )
    }
    return verdict
  } finally {
    // Every window starts fresh, even when reading it threw; a reset error is swallowed.
    try { h.reset() } catch { /* ignore */ }
  }
}

// A per-window drift recorder fed by tick timestamps. count = drifts in the current window.
export interface LagRecorder extends LagHistogram {
  readonly count: number
  recordTick(nowMs: number): void
}

// Pure (no timers, no clock of its own): every recordTick(now) measures the gap since the
// previous tick. Rules, in order:
//  - non-finite now: ignored (no sample, anchor kept);
//  - now went BACKWARDS (gap < 0, a clock step back): dropped, no sample, and the anchor
//    moves to the new now, so the next tick is measured on the new timeline instead of
//    being dropped until the clock catches up;
//  - gap shorter than the tick (the timer fired early by jitter): drift 0;
//  - otherwise drift = gap - tickMs, clamped to capMs.
// The anchor survives reset(): the first tick of a new window is measured like any other.
export function createLagRecorder(tickMs: number = TICK_MS, capMs: number = MAX_DRIFT_MS, startMs?: number): LagRecorder {
  let last: number | undefined = startMs
  let samples: number[] = [] // drift per tick, ms
  let sum = 0
  let max = 0
  return {
    get count() { return samples.length },
    get max() { return max * 1e6 },
    get mean() { return samples.length ? (sum / samples.length) * 1e6 : NaN },
    percentile(p: number) {
      if (!samples.length) return 0
      const sorted = [...samples].sort((a, b) => a - b)
      const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))
      return sorted[rank - 1] * 1e6
    },
    reset() { samples = []; sum = 0; max = 0 },
    recordTick(nowMs: number) {
      if (!Number.isFinite(nowMs)) return
      const prev = last
      last = nowMs
      if (prev === undefined) return
      const gap = nowMs - prev
      if (gap < 0) return
      const drift = Math.min(capMs, Math.max(0, gap - tickMs))
      samples.push(drift)
      sum += drift
      if (drift > max) max = drift
    },
  }
}

export interface LagMonitorHandle { sampleMs: number; warnMs: number; stop(): void }

// Starts sampling; stop() clears all three timers (initial window, window interval, tick).
// No timer is unref'd, the same as before: the old window interval was a plain (ref'd)
// setInterval too, so the process lifetime does not change. `now` is injectable for tests.
export function startEventLoopLagMonitor(now: () => number = () => performance.now()): LagMonitorHandle {
  const recorder = createLagRecorder(TICK_MS, MAX_DRIFT_MS, now())
  // recordTick is plain arithmetic on a number and never throws, so no try/catch here.
  const tick = setInterval(() => recorder.recordTick(now()), TICK_MS)
  const run = () => {
    try { sampleLagOnce(recorder) } catch (err) { logger.debug({ err }, 'event-loop-lag: sample threw') }
  }
  const initial = setTimeout(run, INITIAL_DELAY_MS)
  const interval = setInterval(run, SAMPLE_MS)
  return {
    sampleMs: SAMPLE_MS,
    warnMs: WARN_MS,
    stop() { clearTimeout(initial); clearInterval(interval); clearInterval(tick) },
  }
}
