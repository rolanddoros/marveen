import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// C1 PR 11c-2: agent-config.json "personaAtCreation" = the creation form's "will have its
// own Telegram bot" answer. Written once at creation (routes/agents.ts); read when a
// channel is attached later. Absent or unreadable = created before the field = with a
// persona (true), so no existing agent is reported as persona-less.

const h = vi.hoisted(() => ({ root: '' }))
vi.mock('../config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../config.js')>()
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: j } = await import('node:path')
  h.root = mkdtempSync(j(tmpdir(), 'persona-at-creation-'))
  return { ...orig, PROJECT_ROOT: h.root }
})

const { writeAgentPersonaAtCreation, readAgentPersonaAtCreation, writeAgentSecurityProfile } = await import('../web/agent-config.js')

const cfg = (name: string) => join(h.root, 'agents', name, 'agent-config.json')
const stage = (name: string, content?: string) => {
  mkdirSync(join(h.root, 'agents', name), { recursive: true })
  if (content !== undefined) writeFileSync(cfg(name), content)
}

afterAll(() => { rmSync(h.root, { recursive: true, force: true }) })

describe('personaAtCreation in agent-config.json', () => {
  it('false is written and read back as false, next to the fields already there', () => {
    stage('p-false')
    writeAgentSecurityProfile('p-false', 'default')
    writeAgentPersonaAtCreation('p-false', false)
    const json = JSON.parse(readFileSync(cfg('p-false'), 'utf-8'))
    expect(json.personaAtCreation).toBe(false)
    expect(json.securityProfile).toBe('default')
    expect(readAgentPersonaAtCreation('p-false')).toBe(false)
  })

  it('true is written and read back as true', () => {
    stage('p-true')
    writeAgentPersonaAtCreation('p-true', true)
    expect(JSON.parse(readFileSync(cfg('p-true'), 'utf-8')).personaAtCreation).toBe(true)
    expect(readAgentPersonaAtCreation('p-true')).toBe(true)
  })

  it('an agent created before the field (absent), with no config, or an unreadable config reads as true', () => {
    stage('p-old', JSON.stringify({ securityProfile: 'default' }))
    expect(readAgentPersonaAtCreation('p-old')).toBe(true)
    stage('p-none')
    expect(readAgentPersonaAtCreation('p-none')).toBe(true)
    stage('p-broken', '{not json')
    expect(readAgentPersonaAtCreation('p-broken')).toBe(true)
  })

  it('only the boolean false means "created without a persona"', () => {
    stage('p-str', JSON.stringify({ personaAtCreation: 'false' }))
    expect(readAgentPersonaAtCreation('p-str')).toBe(true)
  })
})
