import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAgentRemoteConfig, readAgentRemoteConfig, readAgentRemoteHost, agentDir } from '../web/agent-config.js'

// Exercises the persistence layer that backs `PUT /api/agents/:name/remote`.
// The HTTP handler itself imports db.js (better-sqlite3, ABI-mismatched in this
// runtime) so it cannot be loaded here, but writeAgentRemoteConfig is the whole
// of its validate-and-persist logic.

const TEST_AGENT = 'zz-remote-api-test-tmp'

describe('writeAgentRemoteConfig (PUT /remote backing logic)', () => {
  beforeEach(() => {
    mkdirSync(agentDir(TEST_AGENT), { recursive: true })
    // Seed an existing config to prove the remote write MERGES, not clobbers.
    writeFileSync(
      join(agentDir(TEST_AGENT), 'agent-config.json'),
      JSON.stringify({ model: 'claude-sonnet-5', displayName: 'Tmp' }, null, 2),
    )
  })
  afterEach(() => {
    rmSync(agentDir(TEST_AGENT), { recursive: true, force: true })
  })

  it('persists a valid host + workdir and preserves other config keys', () => {
    const res = writeAgentRemoteConfig(TEST_AGENT, 'devbox', '/home/user/proj')
    expect(res.ok).toBe(true)
    expect(readAgentRemoteConfig(TEST_AGENT)).toEqual({ host: 'devbox', workdir: '/home/user/proj' })
    const cfg = JSON.parse(readFileSync(join(agentDir(TEST_AGENT), 'agent-config.json'), 'utf-8'))
    expect(cfg.model).toBe('claude-sonnet-5')
    expect(cfg.displayName).toBe('Tmp')
  })

  it('rejects an invalid host (shell metachars) and does NOT persist', () => {
    const res = writeAgentRemoteConfig(TEST_AGENT, 'bad host;rm', '/x')
    expect(res.ok).toBe(false)
    expect(readAgentRemoteConfig(TEST_AGENT)).toEqual({ host: null, workdir: null })
  })

  it("rejects a host starting with '-' (an ssh option), says so, and does NOT persist", () => {
    const before = readFileSync(join(agentDir(TEST_AGENT), 'agent-config.json'), 'utf-8')
    const res = writeAgentRemoteConfig(TEST_AGENT, '-Jattacker.example', '/x')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("must not start with '-'")
    expect(readFileSync(join(agentDir(TEST_AGENT), 'agent-config.json'), 'utf-8')).toBe(before)
  })

  it("an already STORED '-' host (written before the check) reads back as local: start, router and UI all see null", () => {
    writeFileSync(
      join(agentDir(TEST_AGENT), 'agent-config.json'),
      JSON.stringify({ model: 'claude-sonnet-5', remoteHost: '-Jattacker.example', remoteWorkdir: '/home/user/proj' }),
    )
    expect(readAgentRemoteConfig(TEST_AGENT)).toEqual({ host: null, workdir: null })
    expect(readAgentRemoteHost(TEST_AGENT)).toBeNull()
  })

  it('rejects a host with a colon/port', () => {
    const res = writeAgentRemoteConfig(TEST_AGENT, 'devbox:22', '/x')
    expect(res.ok).toBe(false)
    expect(readAgentRemoteConfig(TEST_AGENT)).toEqual({ host: null, workdir: null })
  })

  it('rejects a relative/tilde workdir', () => {
    expect(writeAgentRemoteConfig(TEST_AGENT, 'devbox', '~/proj').ok).toBe(false)
    expect(writeAgentRemoteConfig(TEST_AGENT, 'devbox', 'rel/dir').ok).toBe(false)
  })

  it('clears the fields (revert to local) on empty input', () => {
    writeAgentRemoteConfig(TEST_AGENT, 'devbox', '/home/user/proj')
    const res = writeAgentRemoteConfig(TEST_AGENT, '', '')
    expect(res.ok).toBe(true)
    expect(readAgentRemoteConfig(TEST_AGENT)).toEqual({ host: null, workdir: null })
    // Other keys survive the clear.
    const cfg = JSON.parse(readFileSync(join(agentDir(TEST_AGENT), 'agent-config.json'), 'utf-8'))
    expect(cfg.model).toBe('claude-sonnet-5')
    expect('remoteHost' in cfg).toBe(false)
  })

  it('rejects a half-configured write (host without workdir)', () => {
    expect(writeAgentRemoteConfig(TEST_AGENT, 'devbox', '').ok).toBe(false)
    expect(readAgentRemoteConfig(TEST_AGENT)).toEqual({ host: null, workdir: null })
  })
})
