import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// C1 PR 11c-2 (Roland TG 3151 = C, Kevin 13410): the creation form asks whether the new
// agent will have a Telegram bot. POST /api/agents takes it as `telegram` (boolean;
// missing = true, today's behaviour; anything else = 400), stores it as
// personaAtCreation, and without Telegram creates no persona: generateClaudeMd gets
// { telegram: false }, generateSoulMd is not called, no SOUL.md (not even the fallback
// template). Attaching Telegram later only logs a warning that the agent has no persona.
//
// Both routes run end to end; everything with a side effect outside the temp dir is
// stubbed (agent dir, model/profile/settings writers, context-guard row, DB queue,
// channel provider network checks, the welcome message, the process table).

const h = vi.hoisted(() => ({
  root: '',
  claudeArgs: [] as unknown[][],
  soulCalls: 0,
  fail: false,
  personaAtCreation: true,
  writePersona: vi.fn(),
}))

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...orig,
    agentDir: (name: string) => join(h.root, name),
    writeAgentModel: vi.fn(),
    writeAgentSecurityProfile: vi.fn(),
    writeAgentDisplayName: vi.fn(),
    writeAgentChannelProvider: vi.fn(),
    writeAgentPersonaAtCreation: h.writePersona,
    readAgentPersonaAtCreation: () => h.personaAtCreation,
    listAgentNames: () => [],
  }
})

vi.mock('../web/agent-scaffold.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-scaffold.js')>()
  return {
    ...orig,
    scaffoldAgentDir: (name: string) => { mkdirSync(join(h.root, name), { recursive: true }) },
    writeAgentSettingsFromProfile: vi.fn(),
    generateClaudeMd: async (...args: unknown[]) => {
      h.claudeArgs.push(args)
      if (h.fail) throw new Error('boom')
      return '# generated CLAUDE\n'
    },
    generateSoulMd: async () => {
      h.soulCalls++
      if (h.fail) throw new Error('boom')
      return '# generated SOUL\n'
    },
    buildCreationSections: async (name: string) => `## Memoria rendszer\n\n(the seven sections for ${name})`,
  }
})

vi.mock('../web/context-guard-store.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/context-guard-store.js')>()
  return { ...orig, seedContextGuardForNewAgent: vi.fn(() => null) }
})

vi.mock('../web/profiles.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/profiles.js')>()
  return { ...orig, loadProfileTemplate: vi.fn(() => ({})) }
})

vi.mock('../db.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../db.js')>()
  return { ...orig, createAgentMessage: vi.fn() }
})

vi.mock('../channel-provider.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...orig,
    getProvider: () => ({ validateToken: async () => ({ ok: true, botName: 'probe_bot' }) }),
    channelStateDir: (provider: string, base?: string) => join(base ?? join(h.root, '_main'), '.claude', 'channels', provider),
    readChannelToken: () => null,
    checkTelegramTokenBusy: async () => ({ busy: false }),
  }
})

vi.mock('../web/telegram.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/telegram.js')>()
  return { ...orig, sendWelcomeMessage: vi.fn(async () => {}) }
})

vi.mock('../web/agent-process.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-process.js')>()
  return { ...orig, isAgentRunning: () => false }
})

const { tryHandleAgents, PERSONALITY_PENDING_SENTINEL } = await import('../web/routes/agents.js')
const { CLI_VERSION_OVERRIDE_ENV, resetClaudeCliVersionCache } = await import('../web/claude-cli-version.js')
const { PROJECT_ROOT } = await import('../config.js')
const { logger } = await import('../logger.js')
type RouteContext = import('../web/routes/types.js').RouteContext

const NAME = 'zz-telegram-question-probe'
const NO_PERSONA_WARN = 'Telegram attached to an agent created without Telegram: it has no persona (no SOUL.md, none in CLAUDE.md); write one by hand if needed'

function call(method: string, path: string, payload: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const out = { status: 200, body: {} as Record<string, any> }
  const res = {
    setHeader() {},
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(payload)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  return tryHandleAgents(
    { req, res, path: url.pathname, method, url } as unknown as RouteContext,
    join(PROJECT_ROOT, 'web'),
  ).then((handled) => {
    expect(handled).toBe(true)
    return out
  })
}

const create = (extra: Record<string, unknown>) => call('POST', '/api/agents', { name: NAME, description: 'probe agent', ...extra })
const dir = () => join(h.root, NAME)

const savedCliEnv = process.env[CLI_VERSION_OVERRIDE_ENV]
beforeEach(() => {
  h.root = mkdtempSync(join(tmpdir(), 'telegram-question-'))
  h.claudeArgs = []
  h.soulCalls = 0
  h.fail = false
  h.personaAtCreation = true
  h.writePersona.mockReset()
  process.env[CLI_VERSION_OVERRIDE_ENV] = ''
  resetClaudeCliVersionCache()
})
afterEach(() => {
  rmSync(h.root, { recursive: true, force: true })
  vi.restoreAllMocks()
  if (savedCliEnv === undefined) delete process.env[CLI_VERSION_OVERRIDE_ENV]
  else process.env[CLI_VERSION_OVERRIDE_ENV] = savedCliEnv
})

describe('POST /api/agents: the telegram answer (C1 PR 11c-2)', () => {
  it('telegram=false: no persona asked for, no generateSoulMd, no SOUL.md; CLAUDE.md written; personaAtCreation false', async () => {
    const r = await create({ telegram: false })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, name: NAME })
    expect(h.claudeArgs).toEqual([[NAME, 'probe agent', expect.any(String), { telegram: false }]])
    expect(h.soulCalls).toBe(0)
    expect(readFileSync(join(dir(), 'CLAUDE.md'), 'utf8')).toBe('# generated CLAUDE\n')
    expect(existsSync(join(dir(), 'SOUL.md'))).toBe(false)
    expect(existsSync(join(dir(), 'SOUL.generated.md'))).toBe(false)
    expect(h.writePersona).toHaveBeenCalledTimes(1)
    expect(h.writePersona).toHaveBeenCalledWith(NAME, false)
  })

  it('telegram=true: CLAUDE.md and SOUL.md generated as today; personaAtCreation true', async () => {
    const r = await create({ telegram: true })
    expect(r.status).toBe(200)
    expect(h.claudeArgs).toEqual([[NAME, 'probe agent', expect.any(String), { telegram: true }]])
    expect(h.soulCalls).toBe(1)
    expect(readFileSync(join(dir(), 'SOUL.md'), 'utf8')).toBe('# generated SOUL\n')
    expect(h.writePersona).toHaveBeenCalledWith(NAME, true)
  })

  it('telegram missing: today\'s behaviour, the same as true', async () => {
    const r = await create({})
    expect(r.status).toBe(200)
    expect(h.claudeArgs).toEqual([[NAME, 'probe agent', expect.any(String), { telegram: true }]])
    expect(h.soulCalls).toBe(1)
    expect(existsSync(join(dir(), 'SOUL.md'))).toBe(true)
    expect(h.writePersona).toHaveBeenCalledWith(NAME, true)
  })

  for (const bad of ['false', 0, 1, null, 'yes', {}]) {
    it(`telegram=${JSON.stringify(bad)}: 400 before anything is created`, async () => {
      const r = await create({ telegram: bad })
      expect(r.status).toBe(400)
      expect(r.body).toEqual({ error: 'telegram must be true or false' })
      expect(existsSync(dir())).toBe(false)
      expect(h.claudeArgs).toHaveLength(0)
      expect(h.writePersona).not.toHaveBeenCalled()
    })
  }

  it('telegram=false and generation FAILS: the CLAUDE.md template lands, no SOUL.md template', async () => {
    h.fail = true
    const r = await create({ telegram: false })
    expect(r.status).toBe(200)
    expect(r.body.personalityPending).toBe(true)
    expect(h.soulCalls).toBe(0)
    expect(readFileSync(join(dir(), 'CLAUDE.md'), 'utf8')).toContain('SABLON')
    expect(existsSync(join(dir(), 'SOUL.md'))).toBe(false)
    expect(existsSync(join(dir(), PERSONALITY_PENDING_SENTINEL))).toBe(true)
  })

  it('telegram=true and generation FAILS: both templates land, as today', async () => {
    h.fail = true
    await create({ telegram: true })
    expect(readFileSync(join(dir(), 'CLAUDE.md'), 'utf8')).toContain('SABLON')
    expect(readFileSync(join(dir(), 'SOUL.md'), 'utf8')).toContain('SABLON')
  })
})

describe('POST /api/agents/:name/channels/telegram: attaching Telegram later (C1 PR 11c-2)', () => {
  const attach = (provider = 'telegram', extra: Record<string, unknown> = {}) => {
    mkdirSync(dir(), { recursive: true })
    return call('POST', `/api/agents/${NAME}/channels/${provider}`, { botToken: '123456:probe-token', ...extra })
  }
  const noPersonaWarns = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.filter((c: unknown[]) => c.includes(NO_PERSONA_WARN))

  it('created without Telegram: exactly one warning that it has no persona, the channel still saved', async () => {
    h.personaAtCreation = false
    const warn = vi.spyOn(logger, 'warn')
    const r = await attach()
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    const hits = noPersonaWarns(warn)
    expect(hits).toHaveLength(1)
    expect(hits[0][0]).toEqual({ name: NAME })
    expect(existsSync(join(dir(), '.claude', 'channels', 'telegram', '.env'))).toBe(true)
  })

  it('created with a persona: no such warning', async () => {
    h.personaAtCreation = true
    const warn = vi.spyOn(logger, 'warn')
    const r = await attach()
    expect(r.status).toBe(200)
    expect(noPersonaWarns(warn)).toHaveLength(0)
  })

  it('created without Telegram, Discord attached: no Telegram warning', async () => {
    h.personaAtCreation = false
    const warn = vi.spyOn(logger, 'warn')
    const r = await attach('discord', { channelId: '123456789012345678' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(noPersonaWarns(warn)).toHaveLength(0)
  })
})
