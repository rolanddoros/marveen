// C1 PR 10b, Ron S1 (Kevin 13036): the settings layers buildLiveContext reads must be the ones the session loads.
// A false "wired" is the dangerous error (the rule's prose is dropped while its hook does not run), so where the
// layers are not known, hooks are all false and ASSUMED, and the 10b write gate stops by itself.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildLiveContext, defaultManagedSettingsPath, RENDERED_FIELDS } from '../web/claude-md/live-context.js'

let root: string
let home: string
let managed: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lctx-layers-root-'))
  home = mkdtempSync(join(tmpdir(), 'lctx-layers-home-'))
  managed = join(home, 'managed-settings.json')
  put('scripts/hooks/shell-rescan-guard.py', 'x')
  mkdirSync(join(root, 'agents', 'kevin'), { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

function put(rel: string, content: string, base = root): string {
  const p = join(base, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  return p
}
const wired = () => {
  const s = join(root, 'scripts', 'hooks', 'shell-rescan-guard.py')
  return { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `bash -c '[ -f ${s} ] && exec python3 ${s}; exit 0'` }] }] } }
}
const build = (name: string, opts: Parameters<typeof buildLiveContext>[2] = {}) =>
  buildLiveContext(root, name, { helperAllowed: true, homeDir: home, managedSettingsPath: managed, ...opts })
const NONE = { directiveVerify: false, childClaudeGuard: false, shellRescan: false }

describe('the managed settings layer (highest priority)', () => {
  it('the default path is the platform one', () => {
    expect(defaultManagedSettingsPath('linux')).toBe('/etc/claude-code/managed-settings.json')
    expect(defaultManagedSettingsPath('darwin')).toBe('/Library/Application Support/ClaudeCode/managed-settings.json')
  })

  it('a hook wired only in the managed file is wired, for a sub and for the main agent', () => {
    put('managed-settings.json', JSON.stringify(wired()), home)
    expect(build('kevin').ctx.hooks.shellRescan).toBe(true)
    expect(build('marveen').ctx.hooks.shellRescan).toBe(true)
  })

  it('managed disableAllHooks turns every project hook off', () => {
    put('agents/kevin/.claude/settings.json', JSON.stringify(wired()))
    expect(build('kevin').ctx.hooks.shellRescan).toBe(true)
    put('managed-settings.json', JSON.stringify({ disableAllHooks: true }), home)
    expect(build('kevin').ctx.hooks).toEqual(NONE)
  })

  it('managed allowManagedHooksOnly: only the managed file\'s own hooks count', () => {
    put('agents/kevin/.claude/settings.json', JSON.stringify(wired()))
    put('managed-settings.json', JSON.stringify({ allowManagedHooksOnly: true }), home)
    expect(build('kevin').ctx.hooks).toEqual(NONE)
    put('managed-settings.json', JSON.stringify({ allowManagedHooksOnly: 'yes' }), home)
    expect(build('kevin').ctx.hooks).toEqual(NONE)
    put('managed-settings.json', JSON.stringify({ allowManagedHooksOnly: true, ...wired() }), home)
    expect(build('kevin').ctx.hooks.shellRescan).toBe(true)
    put('managed-settings.json', JSON.stringify({ allowManagedHooksOnly: false }), home)
    expect(build('kevin').ctx.hooks.shellRescan).toBe(true)
  })

  it('managed defaultMode decides over the project layers (without the override)', () => {
    put('agents/kevin/.claude/settings.json', JSON.stringify({ permissions: { defaultMode: 'default' } }))
    put('managed-settings.json', JSON.stringify({ permissions: { defaultMode: 'dontAsk' } }), home)
    expect(build('kevin').ctx.profile.strict).toBe(true)
    // The write path passes agentRunsStrict, and that wins (Ron S4: strict is the written settings' mode).
    expect(build('kevin', { strict: false }).ctx.profile.strict).toBe(false)
  })

  it('a managed file that does not parse: every hook false and "hooks" assumed (a rendered field: no write)', () => {
    put('agents/kevin/.claude/settings.json', JSON.stringify(wired()))
    put('managed-settings.json', '{broken', home)
    const r = build('kevin')
    expect(r.ctx.hooks).toEqual(NONE)
    expect(r.assumptions).toContain('hooks')
    expect(RENDERED_FIELDS as readonly string[]).toContain('hooks')
  })

  it('the host file today (channelsEnabled only, if present) changes nothing', () => {
    put('agents/kevin/.claude/settings.json', JSON.stringify(wired()))
    put('managed-settings.json', JSON.stringify({ channelsEnabled: true }), home)
    const r = build('kevin')
    expect(r.ctx.hooks.shellRescan).toBe(true)
    expect(r.assumptions).not.toContain('hooks')
  })
})

describe('the main agent on another config root', () => {
  const mainHooksAssumed = () => {
    put('.claude/settings.json', JSON.stringify(wired()), home)
    const r = build('marveen')
    return r.assumptions.includes('hooks') && r.ctx.hooks.shellRescan === false
  }

  it('the default (no setting): the user layer is <home>/.claude/settings.json, read as a source', () => {
    expect(mainHooksAssumed()).toBe(false)
  })

  it('MAIN_AGENT_ISOLATED_CONFIG on, in .env: hooks assumed; off spellings: not', () => {
    for (const [v, want] of [['1', true], ['true', true], ['yes', true], ['on', true], ['0', false], ['false', false], ['off', false], ['no', false], ['', false]] as const) {
      put('.env', `MAIN_AGENT_ISOLATED_CONFIG=${v}\n`)
      expect(mainHooksAssumed(), v).toBe(want)
    }
  })

  it('MAIN_AGENT_CONFIG_DIR set: hooks assumed', () => {
    put('.env', 'MAIN_AGENT_CONFIG_DIR=~/.claude-bot\n')
    expect(mainHooksAssumed()).toBe(true)
  })

  it('the store overrides file wins over .env, both ways; one that does not parse reads empty (the dashboard rule)', () => {
    put('.env', 'MAIN_AGENT_ISOLATED_CONFIG=1\n')
    put('store/config-overrides.json', JSON.stringify({ MAIN_AGENT_ISOLATED_CONFIG: '0' }))
    expect(mainHooksAssumed()).toBe(false)
    put('.env', '')
    put('store/config-overrides.json', JSON.stringify({ MAIN_AGENT_ISOLATED_CONFIG: 1 }))
    expect(mainHooksAssumed()).toBe(true)
    put('store/config-overrides.json', JSON.stringify({ MAIN_AGENT_CONFIG_DIR: '/srv/bot' }))
    expect(mainHooksAssumed()).toBe(true)
    put('.env', 'MAIN_AGENT_ISOLATED_CONFIG=1\n')
    put('store/config-overrides.json', '{broken')
    expect(mainHooksAssumed()).toBe(true)
  })

  it('a sub is not affected by the main agent\'s config root', () => {
    put('.env', 'MAIN_AGENT_ISOLATED_CONFIG=1\n')
    put('agents/kevin/.claude/settings.json', JSON.stringify(wired()))
    const r = build('kevin')
    expect(r.ctx.hooks.shellRescan).toBe(true)
    expect(r.assumptions).not.toContain('hooks')
  })
})
