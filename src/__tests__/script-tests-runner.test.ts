// Every scripts/__tests__ suite runs in CI, discovered, not enumerated.
//
// Measured 2026-09-05: scripts/__tests__ held 29 executable suites and only 4
// were reachable from the vitest run -- the other 25 had never been executed by
// anything but a human typing their path. Among the dead ones were the gate's
// own fail-closed exit-code contract (outgoing-copy-gate-failclosed), the shell
// portability suite written the night before, and the hook double-run audit.
// Two of the 25 were in fact FAILING: seed-skills asserted a template sentence
// that 827491c rewrote away, and stop-start-system-unit asserted the systemd
// branch on a machine that has no systemd. Nobody could know, because nothing
// ran them.
//
// Enumerating them here would rot the same way, so the list is discovered from
// disk: a new scripts/__tests__/*.test.sh is in CI the moment it is written.
// The suites with their own dedicated wrapper run twice; that is the cheap
// direction of the trade, because deleting a wrapper must not silently retire a
// suite.
//
// Except where the second run is not cheap: the email approval gate suite
// (EMAILKAPU901 PR2: the three level branches, one-shot + window approvals,
// the four-field anchor, every fail-closed branch) spawns the real hook once
// per case, and the spawn is the production entry point, so it stays. Its
// dedicated wrapper ran the identical command a second time, under a tighter
// budget, and in a full run the two copies ran concurrently in two workers,
// each loading the host for the other. That wrapper is gone; this runner is the
// suite's one CI entry, with the 300 s budget below.
//
// C2 B2-5 (Kevin 11596): the suites no longer run in this file. One file ran all of them serially on one
// worker (upstream CI run 42078141739: 192 cases, 509 s of a 788 s npm test). They run in the four
// script-tests-runner.shard-<k>.test.ts files now, with the discovery, the shard rule and the run body in
// setup/script-suites.ts. This file proves the split loses nothing: the shards together are exactly the
// suites on disk, each one in exactly one shard, and every shard file runs its own share.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, SCRIPT_TESTS_DIR, SHARD_COUNT, discoverScriptSuites, nameHash, shardOf, suitesForShard } from './setup/script-suites.js'

const SUITES = discoverScriptSuites()
const SRC_TESTS = join(ROOT, 'src', '__tests__')
const SHARD_FILE = /^script-tests-runner\.shard-(\d+)\.test\.ts$/

describe('scripts/__tests__ suites', () => {
  it('finds the suites on disk (a rename must not silently empty this run)', () => {
    expect(SUITES.length).toBeGreaterThan(20)
  })

  // Read the directory here too, with this file's own pattern: the shard check below is built on
  // discoverScriptSuites(), so a narrowed discovery would shrink both sides of it at once.
  it('the discovery finds every *.test.sh, *.test.py and *-test.py in the directory, both kinds', () => {
    const onDisk = readdirSync(SCRIPT_TESTS_DIR).filter((f) => f.endsWith('.test.sh') || f.endsWith('.test.py') || f.endsWith('-test.py'))
    expect(SUITES).toEqual(onDisk.sort())
    expect(SUITES.filter((f) => f.endsWith('.sh')).length).toBeGreaterThan(20)
    expect(SUITES.filter((f) => f.endsWith('.py')).length).toBeGreaterThan(20)
  })

  it('the shards together are exactly the suites on disk, each suite in one shard, no shard empty', () => {
    const shards = Array.from({ length: SHARD_COUNT }, (_, i) => suitesForShard(i + 1))
    const all = shards.flat()
    expect([...all].sort()).toEqual(SUITES)
    expect(new Set(all).size).toBe(all.length)
    for (const [i, share] of shards.entries()) expect(share.length, `shard ${i + 1}`).toBeGreaterThan(0)
  })

  it('the shard rule is a stable hash of the name, in 1..SHARD_COUNT', () => {
    for (const name of SUITES) {
      const k = shardOf(name)
      expect(k).toBeGreaterThanOrEqual(1)
      expect(k).toBeLessThanOrEqual(SHARD_COUNT)
      expect(shardOf(name)).toBe(k)
    }
    // a changed hash would reshuffle every shard silently: pinned on the FNV-1a 32-bit test vectors
    expect(['', 'a', 'foobar'].map(nameHash)).toEqual([0x811c9dc5, 0xe40c292c, 0xbf9cf968])
    expect(['email-approval-gate.test.py', 'wait-for.test.sh', 'approval-wait.test.py'].map(shardOf)).toEqual([1, 2, 4])
  })

  it('one shard file per shard, and each runs its own share through the shared run body', () => {
    const files = readdirSync(SRC_TESTS).filter((f) => SHARD_FILE.test(f)).sort()
    expect(files.map((f) => Number(f.match(SHARD_FILE)![1])).sort((a, b) => a - b))
      .toEqual(Array.from({ length: SHARD_COUNT }, (_, i) => i + 1))
    for (const f of files) {
      const k = f.match(SHARD_FILE)![1]
      const src = readFileSync(join(SRC_TESTS, f), 'utf-8')
      expect(src, f).toContain(`it.for(suitesForShard(${k}))`)
      expect(src, f).toContain('runScriptSuite(name, ctx)')
      expect(src.match(/suitesForShard\(/g)?.length, f).toBe(1)
    }
  })

  // The email gate suite must stay reachable from the shards (it has no other CI entry now) and must not
  // be re-run by a second wrapper.
  it('runs the email approval gate suite in one shard, and no other test file re-runs it', () => {
    expect(SUITES).toContain('email-approval-gate.test.py')
    const rerunners = readdirSync(SRC_TESTS)
      .filter((f) => f.endsWith('.ts') && f !== 'script-tests-runner.test.ts')
      .filter((f) => readFileSync(join(SRC_TESTS, f), 'utf-8').includes("'email-approval-gate.test.py'"))
    expect(rerunners).toEqual([])
  })
})
