import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CustomProviderDef } from '../web/custom-providers.js'

// buildCustomProviderLaunchEnv (the caller contract at the end of this file) reads the agent's
// provider, its model and the vault key, and writes the key to STORE_DIR/.launch-secrets.
// Those four are mocked, and STORE_DIR is a tmp dir of this file's own, so nothing here
// touches the real store or the .launch-secrets dir other suites use.
const providerMock = vi.hoisted(() => ({ current: null as CustomProviderDef | null }))
const LAUNCH_KEY = 'test-provider-key-0123456789abcdefghij'
vi.mock('../config.js', async (importOriginal) => {
  const { mkdtempSync: mk } = await import('node:fs')
  const { tmpdir: td } = await import('node:os')
  const { join: j } = await import('node:path')
  return { ...(await importOriginal<typeof import('../config.js')>()), STORE_DIR: mk(j(td(), 'stamp-launch-store-')) }
})
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  readAgentCustomProvider: () => 'test-provider',
  readAgentModel: () => 'test-model',
}))
vi.mock('../web/custom-providers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/custom-providers.js')>()),
  loadCustomProvider: () => providerMock.current,
}))
vi.mock('../web/vault.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/vault.js')>()),
  getSecret: () => 'test-provider-key-0123456789abcdefghij',
}))

const { stampCustomApiKeyApproval, buildCustomProviderLaunchEnv } = await import('../web/agent-process.js')
const { STORE_DIR } = await import('../config.js')
afterAll(() => { rmSync(STORE_DIR, { recursive: true, force: true }) })

// Mirrors the CLI's Jne function (empirically verified from 2.1.222 binary):
// function Jne(e) { return e.trim().slice(-20) }
const suffix = (key: string) => key.trim().slice(-20)

const KEY_XAPI   = 'test-litellm-xapikey0000000000000'

describe('stampCustomApiKeyApproval', () => {
  let dir: string
  let dotClaude: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'custom-api-key-stamp-'))
    dotClaude = join(dir, '.claude.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the last-20-char suffix into customApiKeyResponses.approved', () => {
    expect(stampCustomApiKeyApproval(dotClaude, KEY_XAPI)).toBe(true)
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(data.customApiKeyResponses.approved).toContain(suffix(KEY_XAPI))
  })

  it('creates the file when it does not yet exist', () => {
    expect(existsSync(dotClaude)).toBe(false)
    stampCustomApiKeyApproval(dotClaude, KEY_XAPI)
    expect(existsSync(dotClaude)).toBe(true)
  })

  it('is idempotent -- does not duplicate the suffix', () => {
    stampCustomApiKeyApproval(dotClaude, KEY_XAPI)
    expect(stampCustomApiKeyApproval(dotClaude, KEY_XAPI)).toBe(false) // already present
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(data.customApiKeyResponses.approved.filter((s: string) => s === suffix(KEY_XAPI))).toHaveLength(1)
  })

  it('preserves existing approved and rejected entries', () => {
    writeFileSync(dotClaude, JSON.stringify({
      customApiKeyResponses: { approved: ['existingkey0000000000'], rejected: ['rejectedkey000000000'] },
    }))
    stampCustomApiKeyApproval(dotClaude, KEY_XAPI)
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(data.customApiKeyResponses.approved).toContain('existingkey0000000000')
    expect(data.customApiKeyResponses.approved).toContain(suffix(KEY_XAPI))
    expect(data.customApiKeyResponses.rejected).toContain('rejectedkey000000000')
  })

  it('preserves unrelated .claude.json keys', () => {
    writeFileSync(dotClaude, JSON.stringify({ hasCompletedOnboarding: true, numStartups: 42 }))
    stampCustomApiKeyApproval(dotClaude, KEY_XAPI)
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(data.hasCompletedOnboarding).toBe(true)
    expect(data.numStartups).toBe(42)
  })

  it('trims whitespace from the key before slicing', () => {
    const keyWithSpaces = `  ${KEY_XAPI}  `
    stampCustomApiKeyApproval(dotClaude, keyWithSpaces)
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(data.customApiKeyResponses.approved).toContain(suffix(keyWithSpaces))
    expect(data.customApiKeyResponses.approved[0]).toBe(KEY_XAPI.slice(-20))
  })

  it('returns false and is a no-op for an empty key', () => {
    expect(stampCustomApiKeyApproval(dotClaude, '')).toBe(false)
    expect(existsSync(dotClaude)).toBe(false)
  })

  // A key shorter than the 20-char window is stored whole (slice(-20) of a short string is the
  // string itself), as the CLI does (Ron 12280, Stuart 12318).
  it('a key shorter than 20 chars is stored whole', () => {
    expect(stampCustomApiKeyApproval(dotClaude, 'short')).toBe(true)
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(data.customApiKeyResponses.approved).toEqual(['short'])
  })

  it('returns false and is a no-op for a whitespace-only key', () => {
    expect(stampCustomApiKeyApproval(dotClaude, '   ')).toBe(false)
    expect(existsSync(dotClaude)).toBe(false)
  })

  // JSONCLOBBER926B: this used to pin the opposite ("resets file rather than
  // crashing"). A corrupt .claude.json still must not crash the launch, but it
  // is no longer replaced: it carries onboarding/trust flags and local-scope MCP
  // servers, and the reset destroyed them silently. No stamp, file untouched.
  it('handles corrupted JSON without crashing and WITHOUT overwriting the file', () => {
    const corrupt = '{ "hasCompletedOnboarding": true, "mcpServers": { not valid json'
    writeFileSync(dotClaude, corrupt)
    let result: boolean | undefined
    expect(() => { result = stampCustomApiKeyApproval(dotClaude, KEY_XAPI) }).not.toThrow()
    expect(result).toBe(false)
    expect(readFileSync(dotClaude, 'utf-8')).toBe(corrupt)
  })
})

// The caller contract the stamp relies on: buildCustomProviderLaunchEnv hands the raw key to
// the caller for stamping ONLY on the x-api-key path (ANTHROPIC_API_KEY, which the CLI gates
// behind the approval prompt). Bearer and keyless providers export ANTHROPIC_AUTH_TOKEN, have
// no prompt, and get null, so no stamp. (This replaces a test of the same name that called
// nothing and asserted twice that a file did not exist.)
describe('buildCustomProviderLaunchEnv: only the x-api-key path hands a key to the stamp', () => {
  const def = (authHeader: CustomProviderDef['authHeader']): CustomProviderDef =>
    ({ id: 'test-provider', label: 'Test', baseUrl: 'http://127.0.0.1:9', authHeader, vaultKey: 'TEST_PROVIDER_KEY' })
  afterEach(() => { providerMock.current = null })

  it('x-api-key: customApiKeyForApproval is the key, and the launch line exports ANTHROPIC_API_KEY by reference', () => {
    providerMock.current = def('x-api-key')
    const env = buildCustomProviderLaunchEnv('stamp-agent')!
    expect(env.customApiKeyForApproval).toBe(LAUNCH_KEY)
    expect(env.envPrefix).toContain('export ANTHROPIC_API_KEY=')
    expect(env.envPrefix).not.toContain(LAUNCH_KEY)
  })

  it('Bearer: customApiKeyForApproval is null (no stamp), the key goes to ANTHROPIC_AUTH_TOKEN', () => {
    providerMock.current = def('Bearer')
    const env = buildCustomProviderLaunchEnv('stamp-agent')!
    expect(env.customApiKeyForApproval).toBeNull()
    expect(env.envPrefix).toContain('export ANTHROPIC_AUTH_TOKEN=')
    expect(env.envPrefix).not.toContain('ANTHROPIC_API_KEY')
  })

  it('none (keyless): customApiKeyForApproval is null', () => {
    providerMock.current = def('none')
    expect(buildCustomProviderLaunchEnv('stamp-agent')!.customApiKeyForApproval).toBeNull()
  })
})
