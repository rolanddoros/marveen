// C1 PR 11a-2: headless sub-agents (no channel of any provider). The channel
// source (channel.ts) and its parity with the dashboard readers (telegram.ts),
// capabilities.channel in the live context, what the region leaves out for a
// headless sub (sections.ts), and the dry-run's shortening candidates.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  CHANNEL_ENV_KEYS, CHANNEL_IDS, agentChannelState, agentHasChannel, channelEnvPath, envKeySet, launcherKeySet, type ChannelId,
} from '../web/claude-md/channel.js'
import { buildLiveContext } from '../web/claude-md/live-context.js'
import { renderRegion } from '../web/claude-md/registry.js'
import { headless } from '../web/claude-md/sections.js'
import { runCli } from '../web/claude-md/dry-run-cli.js'
import { ownerParts, SHORTEN_PATTERNS } from '../web/claude-md/owner-zone.js'
import { scanClaudeMd } from '../web/claude-md/compose.js'
import {
  readAgentDiscordConfig, readAgentGooglechatConfig, readAgentSlackConfig, readAgentTeamsConfig, readAgentTelegramConfig,
} from '../web/telegram.js'
import { AGENTS_BASE_DIR, readAgentExtraChannels, readAgentGromzo } from '../web/agent-config.js'
import { agentHasChannel as launcherHasPrimaryChannel, resolveAgentProvider } from '../web/agent-process.js'
import { buildExtraChannelLaunch } from '../web/agent-extra-channels.js'
import { FIXTURES } from './fixtures/claude-md/contexts.js'

// Literal, so a changed key in channel.ts cannot move the fixtures along with it (Ron 13351 suggestion 1).
const KEYS: Record<ChannelId, string> = {
  telegram: 'TELEGRAM_BOT_TOKEN', discord: 'DISCORD_BOT_TOKEN', slack: 'SLACK_BOT_TOKEN',
  googlechat: 'GOOGLECHAT_PROJECT_ID', teams: 'TEAMS_BOT_APP_ID',
}

let base: string
beforeAll(() => { base = mkdtempSync(join(tmpdir(), 'claude-md-headless-')) })
afterAll(() => { rmSync(base, { recursive: true, force: true }) })

let seq = 0
function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
const fresh = () => {
  const d = join(base, `a${seq++}`)
  mkdirSync(d, { recursive: true })
  return d
}

describe('channel.ts: the source', () => {
  it('envKeySet: the dashboard readers\' test (first match, trimmed, anywhere in the text)', () => {
    expect(envKeySet('TELEGRAM_BOT_TOKEN=abc\n', 'TELEGRAM_BOT_TOKEN')).toBe(true)
    expect(envKeySet('X=1\nTELEGRAM_BOT_TOKEN=  abc  \n', 'TELEGRAM_BOT_TOKEN')).toBe(true)
    expect(envKeySet('TELEGRAM_BOT_TOKEN=   \n', 'TELEGRAM_BOT_TOKEN')).toBe(false)
    expect(envKeySet('TELEGRAM_BOT_TOKEN=\nOTHER=1\n', 'TELEGRAM_BOT_TOKEN')).toBe(false)
    expect(envKeySet('OTHER=1\n', 'TELEGRAM_BOT_TOKEN')).toBe(false)
    expect(envKeySet('', 'TELEGRAM_BOT_TOKEN')).toBe(false)
  })

  it('agentChannelState: absent, blank, configured, unreadable', () => {
    const d = fresh()
    expect(agentChannelState(d, 'telegram')).toBe('absent')
    put(join(d, '.claude', 'channels', 'telegram', 'access.json'), '{}')
    expect(agentChannelState(d, 'telegram')).toBe('absent')
    put(channelEnvPath(d, 'telegram'), 'TELEGRAM_BOT_TOKEN=\n')
    expect(agentChannelState(d, 'telegram')).toBe('absent')
    put(channelEnvPath(d, 'telegram'), 'TELEGRAM_BOT_TOKEN=test-value\n')
    expect(agentChannelState(d, 'telegram')).toBe('configured')
    // a directory where the file should be cannot be read (root reads any mode, so no chmod here)
    mkdirSync(channelEnvPath(d, 'discord'), { recursive: true })
    expect(agentChannelState(d, 'discord')).toBe('unreadable')
  })

  it('agentHasChannel: false only when there is no channel at all', () => {
    const none = fresh()
    put(join(none, '.claude', 'channels', 'telegram', 'access.json'), '{}')
    put(join(none, 'agent-config.json'), JSON.stringify({ securityProfile: 'default' }))
    expect(agentHasChannel(none)).toBe(false)
    expect(agentHasChannel(fresh())).toBe(false)
    const blankProvider = fresh()
    put(join(blankProvider, 'agent-config.json'), JSON.stringify({ channelProvider: '  ' }))
    expect(agentHasChannel(blankProvider)).toBe(false)
  })

  it('the key per provider, as the dashboard readers and the launcher name them', () => {
    expect(CHANNEL_ENV_KEYS).toEqual(KEYS)
    expect(CHANNEL_IDS).toEqual(['telegram', 'discord', 'slack', 'googlechat', 'teams'])
  })

  it.each(CHANNEL_IDS)('Kevin 13325: only %s configured -> a channel', (id) => {
    const d = fresh()
    put(join(d, '.claude', 'channels', id, '.env'), `${KEYS[id]}=test-value\n`)
    expect(agentChannelState(d, id)).toBe('configured')
    expect(agentHasChannel(d)).toBe(true)
  })

  it('Ron 13351: gromzo and extraChannels in agent-config.json count, with no channel file at all', () => {
    const cfg = (v: unknown) => { const d = fresh(); put(join(d, 'agent-config.json'), JSON.stringify(v)); return agentHasChannel(d) }
    expect(cfg({ gromzo: true })).toBe(true)
    expect(cfg({ gromzo: 'yes' })).toBe(true) // fail safe: any value but false/null
    expect(cfg({ gromzo: false })).toBe(false)
    expect(cfg({ gromzo: null })).toBe(false)
    expect(cfg({ extraChannels: ['slack'] })).toBe(true) // even without its token
    expect(cfg({ extraChannels: [] })).toBe(false)
    expect(cfg({ extraChannels: 'discord' })).toBe(true)
  })

  it('a token only the launcher\'s line-anchored test finds still counts', () => {
    const text = 'OLD_TELEGRAM_BOT_TOKEN= \nTELEGRAM_BOT_TOKEN=test-value\n'
    expect(envKeySet(text, 'TELEGRAM_BOT_TOKEN')).toBe(false)
    expect(launcherKeySet(text, 'TELEGRAM_BOT_TOKEN')).toBe(true)
    const d = fresh()
    put(join(d, '.claude', 'channels', 'telegram', '.env'), text)
    expect(agentChannelState(d, 'telegram')).toBe('absent') // the dashboard flag, unchanged
    expect(agentHasChannel(d)).toBe(true)
    expect(launcherKeySet('# TELEGRAM_BOT_TOKEN=x\n', 'TELEGRAM_BOT_TOKEN')).toBe(false)
    expect(launcherKeySet('  TELEGRAM_BOT_TOKEN= v \n', 'TELEGRAM_BOT_TOKEN')).toBe(true)
  })

  it('fail safe: an unreadable channel file, a channelProvider, or an agent-config.json that does not parse', () => {
    const unreadable = fresh()
    mkdirSync(channelEnvPath(unreadable, 'slack'), { recursive: true })
    expect(agentHasChannel(unreadable)).toBe(true)
    const provider = fresh()
    put(join(provider, 'agent-config.json'), JSON.stringify({ channelProvider: 'discord' }))
    expect(agentHasChannel(provider)).toBe(true)
    for (const bad of ['{not json', '[]', 'null', '"x"']) {
      const d = fresh()
      put(join(d, 'agent-config.json'), bad)
      expect(agentHasChannel(d), bad).toBe(true)
    }
    const cfgDir = fresh()
    mkdirSync(join(cfgDir, 'agent-config.json'))
    expect(agentHasChannel(cfgDir)).toBe(true)
  })
})

describe('telegram.ts reads through channel.ts (one source with /api/agents)', () => {
  const PROBE = 'channel-source-probe'
  const probeDir = join(AGENTS_BASE_DIR, PROBE)
  function cleanup(): void {
    if (!existsSync(probeDir)) return
    if (existsSync(join(probeDir, 'CLAUDE.md'))) throw new Error(`refusing: ${probeDir} looks like a live agent`)
    rmSync(probeDir, { recursive: true, force: true })
  }
  beforeEach(cleanup)
  afterEach(cleanup)
  const readers: Record<ChannelId, () => boolean> = {
    telegram: () => readAgentTelegramConfig(PROBE).hasTelegram,
    discord: () => readAgentDiscordConfig(PROBE).hasDiscord,
    slack: () => readAgentSlackConfig(PROBE).hasSlack,
    googlechat: () => readAgentGooglechatConfig(PROBE).hasGooglechat,
    teams: () => readAgentTeamsConfig(PROBE).hasTeams,
  }
  it.each(CHANNEL_IDS)('%s: the dashboard flag equals agentChannelState(...) === "configured"', (id) => {
    expect(readers[id]()).toBe(false)
    put(join(probeDir, '.claude', 'channels', id, '.env'), `${KEYS[id]}=test-value\n`)
    expect(readers[id]()).toBe(true)
    for (const body of [`${KEYS[id]}=\n`, `${KEYS[id]}=test-value\n`, `# x\n${KEYS[id]}=  v \n`, 'OTHER=1\n']) {
      put(channelEnvPath(probeDir, id), body)
      expect(readers[id](), body).toBe(agentChannelState(probeDir, id) === 'configured')
    }
    expect(readers[id]()).toBe(false)
  })
})

// Ron 13351: every source the launcher loads a channel plugin from is one channel.ts knows. For each
// fixture, "the launcher would load a channel" implies agentHasChannel (channel.ts may say true more often).
describe('channel.ts covers every channel source of the launcher', () => {
  const PROBE = 'channel-launch-probe'
  const dir = join(AGENTS_BASE_DIR, PROBE)
  function cleanup(): void {
    if (!existsSync(dir)) return
    if (existsSync(join(dir, 'CLAUDE.md'))) throw new Error(`refusing: ${dir} looks like a live agent`)
    rmSync(dir, { recursive: true, force: true })
  }
  beforeEach(cleanup)
  afterEach(cleanup)
  // agent-process.ts startAgentProcess: hasAnyChannel = hasChannel || extra providers || gromzo 'on'
  // (the socket taken as usable, so a Gromzo agent counts wherever mxd runs).
  const launcherLoads = () => launcherHasPrimaryChannel(PROBE) || (() => {
    const l = buildExtraChannelLaunch(readAgentExtraChannels(PROBE), resolveAgentProvider(PROBE), dir, undefined,
      readAgentGromzo(PROBE) ? { slug: PROBE, sockUsable: true } : undefined)
    return l.providers.length > 0 || l.gromzo === 'on'
  })()
  const cases: [string, Record<string, string>][] = [
    ['nothing', {}],
    ['primary telegram token', { '.claude/channels/telegram/.env': 'TELEGRAM_BOT_TOKEN=test-value\n' }],
    ['primary teams via channelProvider', { 'agent-config.json': '{"channelProvider":"teams"}', '.claude/channels/teams/.env': 'TEAMS_BOT_APP_ID=test-value\n' }],
    ['extraChannels slack with its token', { 'agent-config.json': '{"extraChannels":["slack"]}', '.claude/channels/slack/.env': 'SLACK_BOT_TOKEN=test-value\n' }],
    ['gromzo only', { 'agent-config.json': '{"gromzo":true}' }],
    ['token only the anchored test finds', { '.claude/channels/telegram/.env': 'OLD_TELEGRAM_BOT_TOKEN= \nTELEGRAM_BOT_TOKEN=test-value\n' }],
    ['discord token, no channelProvider', { '.claude/channels/discord/.env': 'DISCORD_BOT_TOKEN=test-value\n' }],
  ]
  it.each(cases)('%s', (_n, files) => {
    mkdirSync(dir, { recursive: true })
    for (const [rel, body] of Object.entries(files)) put(join(dir, rel), body)
    if (launcherLoads()) expect(agentHasChannel(dir)).toBe(true)
    if (Object.keys(files).length === 0) expect(agentHasChannel(dir)).toBe(false)
  })

  it('the gromzo case is one the launcher does load (the fixture is not vacuous)', () => {
    put(join(dir, 'agent-config.json'), '{"gromzo":true}')
    expect(launcherLoads()).toBe(true)
    expect(agentHasChannel(dir)).toBe(true)
  })

  // A tripwire: a new channel input of the launch makes this red, so channel.ts gets it too.
  it('the launcher takes its channels from exactly these readers', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')
    // the launch itself (startAgentProcess), from the primary provider to hasAnyChannel
    const from = src.indexOf('  const agentProvider = resolveAgentProvider(name)\n  const provider = getProvider(agentProvider)')
    const launch = src.slice(from, src.indexOf('const hasAnyChannel', from))
    expect(from).toBeGreaterThan(0)
    expect([...new Set(launch.match(/\b(?:read|parse|resolve|detect|check|has|get|load|build)[A-Za-z]*\(/g))].sort()).toEqual([
      'buildExtraChannelLaunch(', 'getProvider(', 'parseTelegramToken(', 'readAgentExtraChannels(', 'readAgentGromzo(',
      'readChannelToken(', 'resolveAgentProvider(',
    ])
    // Ron 13374 (A2): the definitions themselves, verbatim, and no other assignment anywhere in the file, so a
    // channel source added inside a definition (`!!token || detectX(name)`) or by a later assignment is red too.
    expect(launch).toContain([
      '  const token = readChannelToken(agentProvider, join(agentChannelDir, \'.env\'))\n',
      '  // Backward compat: try legacy Telegram token if provider-aware lookup misses\n',
      '  let hasChannel = !!token\n',
      '  if (!token && agentProvider === \'telegram\') {\n',
      '    const legacyToken = parseTelegramToken(name)\n',
      '    hasChannel = !!legacyToken\n',
    ].join(''))
    expect(launch).toContain([
      '  const extraLaunch = buildExtraChannelLaunch(readAgentExtraChannels(name), agentProvider, dir, undefined,\n',
      '    readAgentGromzo(name)\n',
      '      ? { slug: name, sockUsable: mxdAgentSockUsable() }\n',
      '      : undefined)\n',
    ].join(''))
    expect(src).toContain("  const hasExtraChannels = extraLaunch.providers.length > 0 || extraLaunch.gromzo === 'on'\n  const hasAnyChannel = hasChannel || hasExtraChannels\n")
    const assignments = (text: string, v: string) => text.match(new RegExp(`\\b${v}\\s*(?:\\|\\||&&|\\?\\?)?=(?!=)`, 'g'))?.length ?? 0
    // the three flags in the whole file (they are startAgentProcess's own names); token and extraLaunch in the
    // launch (another function has a `token` of its own)
    expect(assignments(src, 'hasChannel'), 'hasChannel: the let and the legacy branch').toBe(2)
    expect(assignments(src, 'hasExtraChannels')).toBe(1)
    expect(assignments(src, 'hasAnyChannel')).toBe(1)
    expect(assignments(launch, 'token')).toBe(1)
    expect(assignments(launch, 'extraLaunch')).toBe(1)
  })
})

describe('live context: capabilities.channel', () => {
  let root: string
  let home: string
  beforeAll(() => {
    root = join(base, 'live')
    home = join(base, 'live-home')
    mkdirSync(home, { recursive: true })
    put(join(root, '.env'), 'MAIN_AGENT_ID=chief\n')
    mkdirSync(join(root, 'agents', 'quiet'), { recursive: true })
    put(join(root, 'agents', 'talky', '.claude', 'channels', 'discord', '.env'), 'DISCORD_BOT_TOKEN=test-value\n')
    // a channel file in the heartbeat dir does not make it a channel agent: false by design
    put(join(root, 'agents', 'heartbeat', '.claude', 'channels', 'telegram', '.env'), 'TELEGRAM_BOT_TOKEN=test-value\n')
  })
  const build = (n: string) => buildLiveContext(root, n, { homeDir: home, managedSettingsPath: join(home, 'managed.json'), helperAllowed: true, strict: false })

  it('a sub without a channel: false; a Discord-only sub: true; main: true; heartbeat: false', () => {
    expect(build('quiet').ctx.capabilities.channel).toBe(false)
    expect(build('talky').ctx.capabilities.channel).toBe(true)
    expect(build('chief').ctx.capabilities.channel).toBe(true)
    expect(build('heartbeat').ctx.capabilities.channel).toBe(false)
    // a measured value, never an assumption
    expect(build('quiet').assumptions).not.toContain('capabilities.channel')
  })

  it('a Discord-only sub keeps the channel-bound rules (Kevin 13325)', () => {
    const r = renderRegion(build('talky').ctx)
    expect(r).toContain('A senderId you do not know')
    expect(r).toContain('claude mcp list')
    const q = renderRegion(build('quiet').ctx)
    expect(q).not.toContain('A senderId you do not know')
    expect(q).not.toContain('claude mcp list')
  })
})

describe('the region of a headless sub', () => {
  const headlessCtx = FIXTURES['sub-headless']
  const withChannel = { ...headlessCtx, capabilities: { ...headlessCtx.capabilities, channel: true } }
  const lines = (s: string) => s.split('\n')

  it('drops exactly the two channel-bound rules, the chat id and the owner-language line', () => {
    const a = lines(renderRegion(withChannel))
    const b = lines(renderRegion(headlessCtx))
    const gone = a.filter((l) => !b.includes(l))
    expect(gone).toHaveLength(4)
    expect(gone[0]).toContain('Owner: Owner (chat_id 1000000001).')
    expect(gone[1]).toBe('Talk to the owner in the language of the owner text above this region.')
    expect(gone[2]).toContain('child `claude`')
    expect(gone[3]).toContain('A senderId you do not know')
    expect(b.filter((l) => !a.includes(l))).toEqual(['You are dev-c, a sub-agent of this install. Main agent: main. Your lead: pm. Owner: Owner.'])
  })

  it('headless(): subs only; main and the heartbeat render as before whatever the flag says', () => {
    expect(headless(headlessCtx)).toBe(true)
    expect(headless(withChannel)).toBe(false)
    for (const n of ['main', 'heartbeat']) {
      const ctx = FIXTURES[n]
      const flipped = { ...ctx, capabilities: { ...ctx.capabilities, channel: !ctx.capabilities.channel } }
      expect(headless(flipped), n).toBe(false)
      expect(renderRegion(flipped), n).toBe(renderRegion(ctx))
    }
  })
})

describe('dry-run: shortening candidates of a headless sub', () => {
  const OWNER = [
    'preamble PRESENTINEL',
    '# Zed',
    'intro HEADSENTINEL',
    '',
    '## Persona and tone',
    'PERSONASENTINEL',
    '### Deeper',
    'more',
    '## Workflow',
    'DOMAINSENTINEL',
    '```',
    '## Telegram in a fence',
    '```',
    '## Telegram rules',
    'chat_id TGSENTINEL',
  ]
  const TEXT = `${OWNER.join('\n')}\n`
  const chars = (a: number, b: number) => OWNER.slice(a - 1, b).reduce((n, l) => n + [...l].length + 1, 0)
  const SENTINELS = ['PRESENTINEL', 'HEADSENTINEL', 'PERSONASENTINEL', 'DOMAINSENTINEL', 'TGSENTINEL', 'Persona and tone', 'Telegram rules']
  let root: string
  let home: string
  beforeAll(() => {
    root = join(base, 'dry')
    home = join(base, 'dry-home')
    mkdirSync(home, { recursive: true })
    put(join(root, '.env'), 'MAIN_AGENT_ID=chief\n')
    put(join(root, 'CLAUDE.md'), '# chief\n')
    put(join(root, 'agents', 'zed', 'CLAUDE.md'), TEXT)
    put(join(root, 'agents', 'zed', '.claude', 'channels', 'telegram', 'access.json'), '{}')
    put(join(root, 'agents', 'kay', 'CLAUDE.md'), TEXT)
    put(join(root, 'agents', 'kay', '.claude', 'channels', 'telegram', '.env'), 'TELEGRAM_BOT_TOKEN=test-value\n')
  })
  function cli(...argv: string[]): string {
    let out = ''
    runCli(['--dry-run', '--root', root, '--home', home, ...argv], (s) => { out += s }, () => {})
    return out
  }

  it('ownerParts: level 1-2 headings outside a fence start a part; only the heading is judged', () => {
    const parts = ownerParts(scanClaudeMd(TEXT).lines)
    expect(parts).toEqual([
      { start: 1, end: 1, chars: chars(1, 1), heading: false },
      { start: 2, end: 4, chars: chars(2, 4), heading: true },
      { start: 5, end: 8, chars: chars(5, 8), heading: true, category: 'persona', patterns: ['persona', 'tone'] },
      { start: 9, end: 13, chars: chars(9, 13), heading: true },
      { start: 14, end: 15, chars: chars(14, 15), heading: true, category: 'telegram', patterns: ['telegram'] },
    ])
  })

  it('the text report: counts, line ranges, chars, categories; no owner text', () => {
    const out = cli('--agent', 'zed')
    const f = 'agents/zed/CLAUDE.md'
    expect(out).toContain(`  headless (no channel): 2 shortening candidate(s), ${chars(5, 8) + chars(14, 15)} chars; `
      + `3 domain part(s), ${chars(1, 4) + chars(9, 13)} chars\n`
      + `    candidate ${f}:5-8 (${chars(5, 8)} chars): persona [persona, tone]\n`
      + `    candidate ${f}:14-15 (${chars(14, 15)} chars): telegram [telegram]\n`
      + `    domain ${f}:1-1 (${chars(1, 1)} chars), before the first heading\n`
      + `    domain ${f}:2-4 (${chars(2, 4)} chars)\n`
      + `    domain ${f}:9-13 (${chars(9, 13)} chars)\n`)
    for (const s of SENTINELS) expect(out, s).not.toContain(s)
  })

  it.each([[['--json']], [['--redact-names']], [['--json', '--redact-names']], [['--excerpts']], [['--json', '--excerpts']]])('%j: no owner text either', (extra) => {
    const out = cli('--agent', 'zed', ...(extra as string[]))
    for (const s of SENTINELS) expect(out, s).not.toContain(s)
    expect(out).toMatch(/"headless": \{|headless \(no channel\)/)
  })

  it('--json carries the parts; an agent with a channel has none', () => {
    const data = JSON.parse(cli('--all', '--json')) as { agents: { name: string; headless?: { candidates: unknown[]; domain: unknown[] } }[] }
    const zed = data.agents.find((a) => a.name === 'zed')
    expect(zed?.headless?.candidates).toHaveLength(2)
    expect(zed?.headless?.domain).toHaveLength(3)
    expect(data.agents.find((a) => a.name === 'kay')?.headless).toBeUndefined()
    expect(data.agents.find((a) => a.name === 'chief')?.headless).toBeUndefined()
    expect(cli('--agent', 'kay')).not.toContain('headless (no channel)')
  })

  it('the patterns are ASCII in the source; the Hungarian headings match too', () => {
    for (const p of SHORTEN_PATTERNS) expect(/^[\x20-\x7e]*$/.test(p.re.source), p.id).toBe(true)
    const e = String.fromCharCode(0xe9)
    const a = String.fromCharCode(0xe1)
    const ids = (h: string) => SHORTEN_PATTERNS.filter((p) => p.re.test(h)).map((p) => p.id)
    expect(ids(`## Egyszerre egy k${e}rd${e}s (all agents)`)).toEqual(['one-question'])
    expect(ids(`## Communication (Kommunik${a}ci${String.fromCharCode(0xf3)}s st${String.fromCharCode(0xed)}lus)`)).toEqual(['communication'])
    expect(ids('## Role and lane')).toEqual([])
    // two categories: the first pattern in SHORTEN_PATTERNS order decides
    const [part] = ownerParts(scanClaudeMd('## Telegram and the owner\n').lines)
    expect(part).toMatchObject({ category: 'telegram', patterns: ['telegram', 'owner'] })
    const [p2] = ownerParts(scanClaudeMd('## Owner tone\n').lines)
    expect(p2).toMatchObject({ category: 'persona', patterns: ['tone', 'owner'] })
  })
})
