// agent-team parse/serialize: autoDelegation was removed (c3/remove-autodelegation).
// Old agent-config.json files that still carry "autoDelegation" must keep loading
// without error, and the key must not appear in the serialized output.
import { describe, it, expect, vi } from 'vitest'
import { DEFAULT_TEAM, sanitizeTeamConfig } from '../web/agent-team.js'

vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...real, readAgentSecurityProfile: () => ({}) }
})
vi.mock('../logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }))

describe('agent-team without autoDelegation', () => {
  it('DEFAULT_TEAM has no autoDelegation key', () => {
    expect('autoDelegation' in DEFAULT_TEAM).toBe(false)
    expect(JSON.stringify(DEFAULT_TEAM)).not.toContain('autoDelegation')
  })

  it('sanitizeTeamConfig output has no autoDelegation key', () => {
    const { team } = sanitizeTeamConfig('test-agent', DEFAULT_TEAM)
    expect('autoDelegation' in team).toBe(false)
    expect(JSON.stringify(team)).not.toContain('autoDelegation')
  })

  it('writeAgentTeam writes the team without autoDelegation', async () => {
    const { writeAgentTeam } = await import('../web/agent-team.js')
    const { atomicWriteFileSync } = await import('../web/atomic-write.js')
    writeAgentTeam('test-agent', DEFAULT_TEAM)
    expect(atomicWriteFileSync).toHaveBeenCalled()
    const callArgs = vi.mocked(atomicWriteFileSync).mock.calls[0]
    const written = JSON.parse(callArgs[1] as string)
    expect('autoDelegation' in written.team).toBe(false)
    expect(JSON.stringify(written)).not.toContain('autoDelegation')
  })
})