// agent-team parse/serialize: autoDelegation was removed (c3/remove-autodelegation).
// Old agent-config.json files that still carry "autoDelegation" must keep loading
// without error, and the key must not appear in the serialized output.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

// Create temp root at module level so vi.mock's hoisted factory can capture it.
const tmpRoot = join(tmpdir(), 'neo-autodeleg-test-' + randomBytes(4).toString('hex'))

vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...real,
    readAgentSecurityProfile: () => ({}),
    agentDir: (name: string) => join(tmpRoot, name),
  }
})
vi.mock('../logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }))

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ok */ }
})

function makeAgentConfig(name: string, team: Record<string, unknown>) {
  const dir = join(tmpRoot, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ team, otherKey: 'kept' }, null, 2))
}

import { DEFAULT_TEAM, sanitizeTeamConfig, readAgentTeam, writeAgentTeam } from '../web/agent-team.js'
import { atomicWriteFileSync } from '../web/atomic-write.js'

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

  it('writeAgentTeam writes the team without autoDelegation', () => {
    vi.mocked(atomicWriteFileSync).mockClear()
    writeAgentTeam('test-agent', DEFAULT_TEAM)
    expect(atomicWriteFileSync).toHaveBeenCalled()
    const callArgs = vi.mocked(atomicWriteFileSync).mock.calls[0]
    const written = JSON.parse(callArgs[1] as string)
    expect('autoDelegation' in written.team).toBe(false)
    expect(JSON.stringify(written)).not.toContain('autoDelegation')
  })

  it('readAgentTeam: config with autoDelegation: true loads without the key', () => {
    makeAgentConfig('neo-auto-true', { role: 'leader', autoDelegation: true, reportsTo: 'boss' })
    const team = readAgentTeam('neo-auto-true')
    expect('autoDelegation' in team).toBe(false)
    expect(team.role).toBe('leader')
    expect(team.reportsTo).toBe('boss')
  })

  it('readAgentTeam: config with autoDelegation: false loads without the key', () => {
    makeAgentConfig('neo-auto-false', { role: 'member', autoDelegation: false })
    const team = readAgentTeam('neo-auto-false')
    expect('autoDelegation' in team).toBe(false)
    expect(team.role).toBe('member')
  })

  it('full round-trip: read with autoDelegation, sanitize, write - no trace', () => {
    makeAgentConfig('neo-roundtrip', { role: 'leader', autoDelegation: true, reportsTo: 'boss', delegatesTo: ['sub'] })
    vi.mocked(atomicWriteFileSync).mockClear()

    const team = readAgentTeam('neo-roundtrip')
    expect('autoDelegation' in team).toBe(false)
    expect(team.role).toBe('leader')
    // reportsTo may be sanitized to null by writeAgentTeam (unknown agent in real list),
    // but the other keys that were in the config are preserved.
    expect(team.delegatesTo).toEqual(['sub'])

    const { team: sanitized } = sanitizeTeamConfig('neo-roundtrip', team)
    expect('autoDelegation' in sanitized).toBe(false)

    writeAgentTeam('neo-roundtrip', team)
    const callArgs = vi.mocked(atomicWriteFileSync).mock.calls[0]
    const written = JSON.parse(callArgs[1] as string)
    expect('autoDelegation' in written.team).toBe(false)
    expect(written.team.role).toBe('leader')
  })
})