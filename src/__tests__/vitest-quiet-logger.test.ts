// B2-2a: the suite runs with the app logger silent by default, and a runner can
// still turn it back on with LOG_LEVEL. The config reads process.env when it is
// evaluated, so each case loads a FRESH copy of it (a distinct query string)
// under the env it wants.
import { describe, it, expect, afterEach, vi } from 'vitest'

async function configEnv(tag: string): Promise<Record<string, string> | undefined> {
  const mod = (await import(new URL(`../../vitest.config.ts?case=${tag}`, import.meta.url).href)) as {
    default?: { test?: { env?: Record<string, string> } }
  }
  return mod.default?.test?.env
}

afterEach(() => { vi.unstubAllEnvs() })

describe('the app logger is quiet in tests, but can be turned back on (B2-2a)', () => {
  it('no LOG_LEVEL from the runner: the tests get silent', async () => {
    vi.stubEnv('LOG_LEVEL', undefined)
    expect(await configEnv('unset')).toEqual({ LOG_LEVEL: 'silent' })
  })

  it('a LOG_LEVEL from the runner wins, so a failing test can be debugged with its logs', async () => {
    vi.stubEnv('LOG_LEVEL', 'debug')
    expect(await configEnv('debug')).toEqual({ LOG_LEVEL: 'debug' })
  })

  it('this worker got the config value: the env reached the test process', () => {
    // Positive control: if `test.env` were ignored by the runner, the cases above
    // would still pass while every test kept logging.
    expect(process.env.LOG_LEVEL).toBeDefined()
  })
})
