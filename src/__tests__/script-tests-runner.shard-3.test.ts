// Shard 3 of the scripts/__tests__ suites (C2 B2-5). The discovery, the shard rule and the run body
// live in setup/script-suites.ts; script-tests-runner.test.ts proves the shards cover every suite once.
// it.for, not it.each: the case function needs the test context for ctx.skip().
import { describe, it } from 'vitest'
import { SUITE_TIMEOUT_MS, runScriptSuite, suitesForShard } from './setup/script-suites.js'

describe('scripts/__tests__ suites, shard 3', () => {
  it.for(suitesForShard(3))('%s', { timeout: SUITE_TIMEOUT_MS + 10_000 }, (name, ctx) => runScriptSuite(name, ctx))
})
