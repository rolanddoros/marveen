/**
 * C3-3a: the root-parameterised readers of hooks/sub-inputs.ts (the dry-run's)
 * give what the dashboard's own readers give on the same tree. Run on this
 * checkout (PROJECT_ROOT), with probe agents in its agents/ dir; never the live
 * install (the guard refuses before anything is written).
 */
import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS_BASE_DIR, listAllAgentNames, readAgentCapabilities, readAgentSenderRoleGatePolicy } from '../web/agent-config.js'
import { resolveAgentSecurityProfile } from '../web/agent-team.js'
import { listProfileTemplates, loadProfileTemplate, profileWantsCredentialGate, profileWantsDestructiveGate, profileWantsSecondReviewer } from '../web/profiles.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { capabilitiesOf, listSubAgents, mainAgentIdOf, profileFlagsOf, profileIdOf, senderRolePolicyOf, subHookFlags } from '../web/hooks/sub-inputs.js'

const PREFIX = 'hook-sub-inputs-probe-'
const MARKER = '.hook-sub-inputs-probe'
const made: string[] = []

function probe(suffix: string, config: Record<string, unknown>): string {
  if (realpathSync(PROJECT_ROOT) === '/root/marveen' || realpathSync(AGENTS_BASE_DIR) === '/root/marveen/agents') throw new Error('refusing: live install')
  const name = `${PREFIX}${suffix}`
  const dir = join(AGENTS_BASE_DIR, name)
  if (existsSync(dir) && !existsSync(join(dir, MARKER))) throw new Error(`refusing: ${dir} is not a probe`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, MARKER), '')
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify(config))
  made.push(dir)
  return name
}

afterAll(() => {
  for (const dir of made) if (existsSync(join(dir, MARKER))) rmSync(dir, { recursive: true, force: true })
})

describe('sub-inputs readers = the dashboard readers', () => {
  const cases: Record<string, Record<string, unknown>> = {
    plain: {},
    explicit: { securityProfile: 'researcher' },
    leader: { team: { role: 'leader' } },
    leaderExplicit: { securityProfile: 'sub-dev', team: { role: 'leader' } },
    caps: { capabilities: ['browser', 'email:thread-reply'] },
    capsEmpty: { capabilities: [] },
  }

  it('capabilities and the profile id, per probe agent', () => {
    for (const [suffix, cfg] of Object.entries(cases)) {
      const name = probe(suffix.toLowerCase(), cfg)
      expect(capabilitiesOf(PROJECT_ROOT, name)).toEqual(readAgentCapabilities(name))
      expect(profileIdOf(PROJECT_ROOT, name)).toBe(resolveAgentSecurityProfile(name))
    }
  })

  it('subHookFlags: the browser and thread-reply capabilities become agent flags, absent ones stay off', () => {
    const on = subHookFlags(PROJECT_ROOT, probe('flags-on', { capabilities: ['browser', 'email:thread-reply'] }))
    expect(on.agent).toMatchObject({ browser: true, threadReply: true, heartbeat: false })
    const off = subHookFlags(PROJECT_ROOT, probe('flags-off', { capabilities: ['email:thread-reply'] }))
    expect(off.agent).toMatchObject({ browser: false, threadReply: true, heartbeat: false })
  })

  it('capabilities from the persona frontmatter when agent-config.json has none', () => {
    const name = probe('persona', {})
    const personas = join(PROJECT_ROOT, 'personas')
    const created = !existsSync(personas)
    const file = join(personas, `${name}.md`)
    if (existsSync(file)) throw new Error(`refusing: ${file} exists`)
    mkdirSync(personas, { recursive: true })
    writeFileSync(file, "---\nname: x\ncapabilities: [browser, 'email:thread-reply']\n---\nbody\n")
    try {
      expect(capabilitiesOf(PROJECT_ROOT, name)).toEqual(['browser', 'email:thread-reply'])
      expect(capabilitiesOf(PROJECT_ROOT, name)).toEqual(readAgentCapabilities(name))
    } finally {
      rmSync(created ? personas : file, { recursive: true, force: true })
    }
  })

  it('the gate switches of every shipped profile, and of a missing one (default fallback)', () => {
    for (const id of [...listProfileTemplates().map((p) => p.id), 'no-such-profile']) {
      const p = loadProfileTemplate(id)
      expect(profileFlagsOf(PROJECT_ROOT, id)).toEqual({
        destructiveGate: profileWantsDestructiveGate(p), credentialGate: profileWantsCredentialGate(p), secondReviewer: profileWantsSecondReviewer(p),
      })
    }
  })

  it('the sender-role policy, from a gates file of every shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-sub-inputs-'))
    try {
      const path = join(dir, 'gates.json')
      const shapes = ['{}', '{"a":{"riskyTools":["Bash"]}}', '{"a":{"riskyTools":[]}}', '{"a":{"allowTools":[]}}', '{"a":null}',
        '{"a":"x"}', '{"a":{}}', '[]', 'not json', '{"b":{"riskyTools":["Bash"]}}']
      expect(senderRolePolicyOf(PROJECT_ROOT, 'a', path)).toBe(readAgentSenderRoleGatePolicy('a', path))
      for (const text of shapes) {
        writeFileSync(path, text)
        expect(senderRolePolicyOf(PROJECT_ROOT, 'a', path)).toBe(readAgentSenderRoleGatePolicy('a', path))
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the agent list and the main agent id', () => {
    probe('listed', {})
    expect(listSubAgents(PROJECT_ROOT, mainAgentIdOf(PROJECT_ROOT)).sort()).toEqual(listAllAgentNames().sort())
    expect(mainAgentIdOf(PROJECT_ROOT)).toBe(MAIN_AGENT_ID)
  })
})
