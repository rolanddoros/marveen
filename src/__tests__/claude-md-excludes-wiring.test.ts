/**
 * C1 PR 11a-1 (Kevin 13217): every sub-agent's settings.json excludes the main
 * agent's root CLAUDE.md (claudeMdExcludes), written once, kept across
 * spawns, next to whatever entries are already there; the main agent is
 * never touched. The pure function first, then the FINAL settings file after
 * a render.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { injectClaudeMdExcludes, writeAgentSettingsFromProfile, agentSettingsPath } from '../web/agent-scaffold.js'
import { loadProfileTemplate } from '../web/profiles.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'

const ROOT_MD = join(PROJECT_ROOT, 'CLAUDE.md')
const SUB = 'claude-md-excludes-probe'

describe('injectClaudeMdExcludes', () => {
  it('a sub-agent without the key gets the root CLAUDE.md, as an array', () => {
    const s: Record<string, unknown> = { env: { A: '1' } }
    expect(injectClaudeMdExcludes(SUB, s)).toBe(true)
    expect(s).toEqual({ env: { A: '1' }, claudeMdExcludes: [ROOT_MD] })
  })

  it('a second run adds nothing', () => {
    const s: Record<string, unknown> = {}
    injectClaudeMdExcludes(SUB, s)
    expect(injectClaudeMdExcludes(SUB, s)).toBe(false)
    expect(s.claudeMdExcludes).toEqual([ROOT_MD])
  })

  it('entries already there stay, in order; the root file is appended once', () => {
    const s: Record<string, unknown> = { claudeMdExcludes: ['**/vendor/**/CLAUDE.md', '/opt/x/CLAUDE.md'] }
    expect(injectClaudeMdExcludes(SUB, s)).toBe(true)
    expect(s.claudeMdExcludes).toEqual(['**/vendor/**/CLAUDE.md', '/opt/x/CLAUDE.md', ROOT_MD])
  })

  it('the root file already listed (as written by hand): unchanged', () => {
    const s: Record<string, unknown> = { claudeMdExcludes: [ROOT_MD, '**/vendor/**/CLAUDE.md'] }
    expect(injectClaudeMdExcludes(SUB, s)).toBe(false)
    expect(s.claudeMdExcludes).toEqual([ROOT_MD, '**/vendor/**/CLAUDE.md'])
  })

  it('a value that is not an array is left as the owner wrote it', () => {
    const s: Record<string, unknown> = { claudeMdExcludes: '/opt/x/CLAUDE.md' }
    expect(injectClaudeMdExcludes(SUB, s)).toBe(false)
    expect(s.claudeMdExcludes).toBe('/opt/x/CLAUDE.md')
  })

  it('the main agent is never touched', () => {
    const s: Record<string, unknown> = { env: { A: '1' } }
    expect(injectClaudeMdExcludes(MAIN_AGENT_ID, s)).toBe(false)
    expect(s).toEqual({ env: { A: '1' } })
    const t: Record<string, unknown> = { claudeMdExcludes: ['/opt/x/CLAUDE.md'] }
    expect(injectClaudeMdExcludes(MAIN_AGENT_ID, t)).toBe(false)
    expect(t.claudeMdExcludes).toEqual(['/opt/x/CLAUDE.md'])
  })
})

describe('writeAgentSettingsFromProfile: the sub-agent settings file', () => {
  const agentRoot = join(AGENTS_BASE_DIR, SUB)
  function cleanup(): void {
    if (!existsSync(agentRoot)) return
    if (existsSync(join(agentRoot, 'CLAUDE.md')) || existsSync(join(agentRoot, 'HANDOFF.md'))) {
      throw new Error(`refusing: ${agentRoot} looks like a live agent, not a test checkout`)
    }
    rmSync(agentRoot, { recursive: true, force: true })
  }
  beforeEach(cleanup)
  afterEach(cleanup)
  const read = () => JSON.parse(readFileSync(agentSettingsPath(SUB), 'utf-8')) as Record<string, unknown>

  it('a fresh agent gets it; a respawn keeps exactly one entry', () => {
    writeAgentSettingsFromProfile(SUB, loadProfileTemplate('default'))
    expect(read().claudeMdExcludes).toEqual([ROOT_MD])
    writeAgentSettingsFromProfile(SUB, loadProfileTemplate('default'))
    expect(read().claudeMdExcludes).toEqual([ROOT_MD])
  })

  it('an existing file: its own excludes and other keys stay', () => {
    mkdirSync(join(agentRoot, '.claude'), { recursive: true })
    writeFileSync(agentSettingsPath(SUB), JSON.stringify({ env: { KEEP: 'yes' }, claudeMdExcludes: ['**/vendor/**/CLAUDE.md'] }))
    writeAgentSettingsFromProfile(SUB, loadProfileTemplate('default'))
    const s = read()
    expect(s.claudeMdExcludes).toEqual(['**/vendor/**/CLAUDE.md', ROOT_MD])
    expect(s.env).toEqual({ KEEP: 'yes' })
  })
})
