// C1 PR 11a-2: does an agent own a channel (Telegram, Discord, Slack, Google
// Chat, Teams)? One source for the dashboard's per-agent channel flags
// (telegram.ts, /api/agents hasTelegram and friends) and for the CLAUDE.md
// render context (live-context.ts capabilities.channel), so the two cannot
// drift (Kevin 13317/13325).
//
// A provider is configured when its channel .env holds a non-empty value for
// its key (the bot token, or the id that stands for it): the same check the
// dashboard readers made inline until now. agentHasChannel() is fail safe:
// the channel-bound CLAUDE.md rules (unknown sender, child claude) are
// security rules, so only "no channel at all" reads as headless. A channel
// file that exists but cannot be read, an agent-config.json that cannot be
// parsed, or a channelProvider set in it all count as a channel.
//
// No token value leaves this module: every export returns a boolean or a
// state. Imports node:fs (reading only) and node:path; nothing else, so the
// read-only dry-run graph can take it (claude-md-dry-run-readonly.test.ts).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The key per provider, as the dashboard readers have checked it.
export const CHANNEL_ENV_KEYS = {
  telegram: 'TELEGRAM_BOT_TOKEN',
  discord: 'DISCORD_BOT_TOKEN',
  slack: 'SLACK_BOT_TOKEN',
  googlechat: 'GOOGLECHAT_PROJECT_ID',
  teams: 'TEAMS_BOT_APP_ID',
} as const

export type ChannelId = keyof typeof CHANNEL_ENV_KEYS
export const CHANNEL_IDS = Object.keys(CHANNEL_ENV_KEYS) as ChannelId[]

export type ChannelState = 'configured' | 'absent' | 'unreadable'

// <agentRoot>/.claude/channels/<provider>/.env
export function channelEnvPath(agentRoot: string, channel: ChannelId): string {
  return join(agentRoot, '.claude', 'channels', channel, '.env')
}

// `KEY=<non-blank>` anywhere in the text, the first match wins: the exact
// test the dashboard readers ran (`content.match(/KEY=(.+)/)`, then trim).
export function envKeySet(envText: string, key: string): boolean {
  const m = envText.match(new RegExp(`${key}=(.+)`))
  return !!m?.[1]?.trim()
}

function readOrState(path: string): string | 'absent' | 'unreadable' {
  try {
    return readFileSync(path, 'utf-8')
  } catch (err) {
    const code = (err as { code?: unknown }).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable'
  }
}

// One provider of one agent. A missing file is 'absent'; a file that is
// there without the key, or with a blank value, is 'absent' too.
export function agentChannelState(agentRoot: string, channel: ChannelId): ChannelState {
  const text = readOrState(channelEnvPath(agentRoot, channel))
  if (text === 'absent' || text === 'unreadable') return text
  return envKeySet(text, CHANNEL_ENV_KEYS[channel]) ? 'configured' : 'absent'
}

// agent-config.json channelProvider: set (a non-blank string), not set, or
// the file is there but cannot be read or parsed.
function channelProviderState(agentRoot: string): 'set' | 'unset' | 'unreadable' {
  const text = readOrState(join(agentRoot, 'agent-config.json'))
  if (text === 'absent') return 'unset'
  if (text === 'unreadable') return 'unreadable'
  try {
    const cfg: unknown = JSON.parse(text)
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return 'unreadable'
    const p = (cfg as Record<string, unknown>).channelProvider
    return typeof p === 'string' && p.trim() !== '' ? 'set' : 'unset'
  } catch {
    return 'unreadable'
  }
}

// True unless the agent has no channel at all (fail safe, see the header).
export function agentHasChannel(agentRoot: string): boolean {
  if (channelProviderState(agentRoot) !== 'unset') return true
  return CHANNEL_IDS.some((c) => agentChannelState(agentRoot, c) !== 'absent')
}
