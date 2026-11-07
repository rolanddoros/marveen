import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  names: [] as string[],
  writePersona: vi.fn(),
}))

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...orig,
    agentDir: (name: string) => join(h.root, name),
    // C1 PR 11c-3: the listing reads CLAUDE.md through agentConfigRoot and the PUT
    // checks isKnownAgent; both resolve agentDir inside the module, so they are
    // pointed at the temp root here too.
    agentConfigRoot: (name: string) => join(h.root, name),
    isKnownAgent: (name: string) => existsSync(join(h.root, name)),
    writeAgentModel: vi.fn(),
    writeAgentSecurityProfile: vi.fn(),
    writeAgentDisplayName: vi.fn(),
    writeAgentChannelProvider: vi.fn(),
    writeAgentPersonaAtCreation: h.writePersona,
    readAgentPersonaAtCreation: () => h.personaAtCreation,
    listAgentNames: () => h.names,
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
  h.names = []
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
    // C1 PR 11c-3 (Ron Low 2): a successful creation logs no error. Without the
    // `content === null` skip the absent SOUL.md would throw into the catch, which
    // logs a false "generation failed" while the response still says ok.
    const error = vi.spyOn(logger, 'error')
    const r = await create({ telegram: false })
    expect(error).not.toHaveBeenCalled()
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

// C1 PR 11c-3 (Johnny 13431): telegram=false + failed generation speaks of the role
// description and CLAUDE.md only; the Telegram failure keeps today's wording. Texts verbatim.
describe('POST /api/agents: failure-path wording without Telegram (C1 PR 11c-3)', () => {
  const TG_WARNING = 'Agent created with a template personality because generation failed. Edit CLAUDE.md and SOUL.md to replace it.'
  const HEADLESS_WARNING = 'CLAUDE.md generation failed, a template role description was used. Edit CLAUDE.md.'
  const TG_HEADER = '> **FIGYELEM: ez egy SABLON.** Az ügynök személyiségének generálása nem sikerült a\n'
  const HEADLESS_HEADER = '> **FIGYELEM: ez egy SABLON.** Az ügynök szerepleírásának generálása nem sikerült a\n'

  it('telegram=false: the API warning is the headless one', async () => {
    h.fail = true
    const r = await create({ telegram: false })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, name: NAME, personalityPending: true, detail: 'boom' })
    expect(r.body.warning).toBe(HEADLESS_WARNING)
  })

  it('telegram=true: the API warning is today\'s', async () => {
    h.fail = true
    const r = await create({ telegram: true })
    expect(r.body.personalityPending).toBe(true)
    expect(r.body.warning).toBe(TG_WARNING)
  })

  it('telegram=false: the template CLAUDE.md header says the role description failed', async () => {
    h.fail = true
    await create({ telegram: false })
    const md = readFileSync(join(dir(), 'CLAUDE.md'), 'utf8')
    expect(md).toContain(HEADLESS_HEADER)
    expect(md).not.toContain('személyiség')
    // the mandatory sections still follow the template
    expect(md).toContain(`(the seven sections for ${NAME})`)
  })

  it('telegram=true: the template CLAUDE.md header is today\'s', async () => {
    h.fail = true
    await create({ telegram: true })
    const md = readFileSync(join(dir(), 'CLAUDE.md'), 'utf8')
    expect(md).toContain(TG_HEADER)
    expect(md).not.toContain('szerepleírás')
  })
})

// C1 PR 11c-3 (Ron Low 1): a persona-less agent never gets a SOUL.md, so CLAUDE.md
// alone makes it 'configured'; an agent created with a persona still needs both.
describe('GET /api/agents: status of an agent created without Telegram (C1 PR 11c-3)', () => {
  const statusOf = async (files: Record<string, string>) => {
    mkdirSync(dir(), { recursive: true })
    for (const [f, c] of Object.entries(files)) writeFileSync(join(dir(), f), c)
    h.names = [NAME]
    const r = await call('GET', '/api/agents', {})
    expect(r.status).toBe(200)
    const rows = r.body as unknown as Array<{ name: string; status: string }>
    expect(rows.map(a => a.name)).toEqual([NAME])
    return rows[0].status
  }

  it('without a persona: CLAUDE.md alone = configured', async () => {
    h.personaAtCreation = false
    expect(await statusOf({ 'CLAUDE.md': '# role\n' })).toBe('configured')
  })

  it('without a persona: no CLAUDE.md = draft', async () => {
    h.personaAtCreation = false
    expect(await statusOf({ 'CLAUDE.md': '  \n' })).toBe('draft')
  })

  it('with a persona: CLAUDE.md without SOUL.md = draft, both = configured (unchanged)', async () => {
    h.personaAtCreation = true
    expect(await statusOf({ 'CLAUDE.md': '# role\n' })).toBe('draft')
    expect(await statusOf({ 'SOUL.md': '# soul\n' })).toBe('configured')
  })
})

// C1 PR 11c-3 (Ron Low 4): the Settings tab's SOUL.md Save sends the field even when
// it is empty. For a persona-less agent without SOUL.md that save creates nothing;
// every other save writes as before.
describe('PUT /api/agents/:name soulMd: no empty SOUL.md for a persona-less agent (C1 PR 11c-3)', () => {
  const put = (payload: Record<string, unknown>) => {
    mkdirSync(dir(), { recursive: true })
    return call('PUT', `/api/agents/${NAME}`, payload)
  }
  const soul = () => join(dir(), 'SOUL.md')

  for (const empty of ['', '  \n\t']) {
    it(`without a persona, no SOUL.md, soulMd=${JSON.stringify(empty)}: 200 and no SOUL.md`, async () => {
      h.personaAtCreation = false
      const r = await put({ soulMd: empty })
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ ok: true })
      expect(existsSync(soul())).toBe(false)
    })
  }

  it('without a persona, non-empty soulMd: written (a hand-written persona is allowed)', async () => {
    h.personaAtCreation = false
    await put({ soulMd: '# by hand\n' })
    expect(readFileSync(soul(), 'utf8')).toBe('# by hand\n')
  })

  it('without a persona, an existing SOUL.md emptied: written empty (clearing is an edit, not a create)', async () => {
    h.personaAtCreation = false
    mkdirSync(dir(), { recursive: true })
    writeFileSync(soul(), '# old\n')
    await put({ soulMd: '' })
    expect(readFileSync(soul(), 'utf8')).toBe('')
  })

  it('with a persona, no SOUL.md, empty soulMd: the empty file is created as today', async () => {
    h.personaAtCreation = true
    await put({ soulMd: '' })
    expect(existsSync(soul())).toBe(true)
    expect(readFileSync(soul(), 'utf8')).toBe('')
  })

  it('without a persona, empty soulMd next to claudeMd: CLAUDE.md written, still no SOUL.md', async () => {
    h.personaAtCreation = false
    await put({ claudeMd: '# role\n', soulMd: '' })
    expect(readFileSync(join(dir(), 'CLAUDE.md'), 'utf8')).toBe('# role\n')
    expect(existsSync(soul())).toBe(false)
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
