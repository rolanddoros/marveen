// The scripts/__tests__ suites: discovery, sharding and the one way to run a suite.
//
// Not a test file on purpose (importing a test file executes its tests, see suite-outcome.ts): the
// four script-tests-runner.shard-<k>.test.ts files import it and run only their own share, and
// script-tests-runner.test.ts imports it to prove the shares add up.
//
// Why shards (C2 B2-5, Kevin 11596): one file ran every suite with it.for, serially, on one worker.
// Measured on the upstream CI run 42078141739 (2026-11-05): 192 cases, 509 s of an npm test that took
// 788 s, the longest branch of the whole run. Four files let vitest spread the suites over its workers
// (availableParallelism() - 1 by default), so one slow suite holds back only its own shard. On a host
// with fewer workers the shards simply queue; nothing depends on the count matching the machine.
//
// A suite's shard is a hash of its NAME, not its position in the sorted list: adding or removing a
// file then moves no other suite to another shard, so a shard's timing stays comparable between runs.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import { SKIP_REASON, hasSkipReason, suiteOutcome } from './suite-outcome.js'

export const ROOT = join(__dirname, '..', '..', '..')
export const SCRIPT_TESTS_DIR = join(ROOT, 'scripts', '__tests__')
export const SHARD_COUNT = 4
export const SUITE_TIMEOUT_MS = 300_000

// Every scripts/__tests__ suite, discovered, not enumerated: a new *.test.sh / *.test.py is in CI the
// moment it is written. `*-test.py` is the older naming; both spellings are real suites in this tree.
export function discoverScriptSuites(): string[] {
  return readdirSync(SCRIPT_TESTS_DIR)
    .filter((f) => /\.test\.(sh|py)$/.test(f) || /-test\.py$/.test(f))
    .sort()
}

// FNV-1a, 32 bit: small, dependency-free, and the same answer on every platform.
export function nameHash(name: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

export function shardOf(name: string): number {
  return (nameHash(name) % SHARD_COUNT) + 1
}

export function suitesForShard(shard: number): string[] {
  if (!Number.isInteger(shard) || shard < 1 || shard > SHARD_COUNT) throw new Error(`no shard ${shard}`)
  return discoverScriptSuites().filter((name) => shardOf(name) === shard)
}

// Runs one suite. The case function gets the test context: ctx.skip() makes the outcome a SKIPPED test
// that the reporter counts and shows. An early `return` from an `it` is counted as a pass, which is the
// silent skip this branch exists to prevent (pinned by script-tests-runner-skip.test.ts).
// dir and timeoutMs are for the runner's own tests only (C2 B2-5b): a throwaway suite, a short timeout, to prove
// that a failing or a hanging suite turns its case red. The shards pass neither.
export function runScriptSuite(
  name: string,
  ctx: { skip: (note?: string) => void },
  dir: string = SCRIPT_TESTS_DIR,
  timeoutMs: number = SUITE_TIMEOUT_MS,
): void {
  const runner = name.endsWith('.py') ? 'python3' : 'bash'
  const res = spawnSync(runner, [join(dir, name)], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    cwd: ROOT,
  })
  if (suiteOutcome(res.status) === 'skip') {
    // A suite whose positive control cannot be met on this platform has
    // measured NOTHING here. Failing it is a false alarm (see wait-for on
    // macOS); passing it silently is worse, because a skip would then be
    // indistinguishable from a green run. So it is a counted skip, and the
    // reason is required to be there -- a bare 77 with no explanation is a
    // failure. The streams are joined with a newline so that the marker on
    // stderr starts a line even when stdout did not end with one.
    const why = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
    expect(hasSkipReason(why), `${name} exited 77 without a "SKIP (control unmet)" line:\n${why}`).toBe(true)
    const line = why.split('\n').find((l) => SKIP_REASON.test(l)) ?? 'control unmet'
    ctx.skip(`${name}: ${line}`)
    return
  }
  if (res.status !== 0) {
    console.error(`--- ${name} stdout ---\n${res.stdout ?? ''}`)
    console.error(`--- ${name} stderr ---\n${res.stderr ?? ''}`)
  }
  expect(res.status).toBe(0)
}
