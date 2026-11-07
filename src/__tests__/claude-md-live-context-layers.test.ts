// C1 PR 10b, Ron S1 (Kevin 13036): the settings layers buildLiveContext reads must be the ones the session loads.
// A false "wired" is the dangerous error (the rule's prose is dropped while its hook does not run), so where the
// layers are not known, hooks are all false and ASSUMED, and the 10b write gate stops by itself.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

// Ron 13122 J1 (Kevin 13130): a hook that reads false although its wiring is there is named, never silent.
// The tests run as root on the host, where a mode-000 file still reads: "not readable" is made with a directory
// and with a symlink loop, which no uid can read as a file (and an ERR_ACCESS_DENIED under --permission takes the
// same branch: any error other than ENOENT / ENOTDIR).
describe('hooksNotWired (Ron 13122 J1): why a wired hook reads false', () => {
  const SCRIPT = () => join(root, 'scripts', 'hooks', 'shell-rescan-guard.py')

  it('wired and the script there: no entry', () => {
    put('agents/kevin/.claude/settings.json', JSON.stringify(wired()))
    const r = build('kevin')
    expect(r.ctx.hooks.shellRescan).toBe(true)
    expect(r.hooksNotWired).toEqual([])
  })

  it('a hook no layer wires is not listed (configuration, not a fault)', () => {
    expect(build('kevin').hooksNotWired).toEqual([])
  })

  it('the script missing: one entry, reason "missing", with the resolved path', () => {
    put('agents/kevin/.claude/settings.json', JSON.stringify(wired()))
    rmSync(SCRIPT())
    const r = build('kevin')
    expect(r.ctx.hooks.shellRescan).toBe(false)
    expect(r.hooksNotWired).toEqual([{ id: 'shellRescan', path: SCRIPT(), reason: 'missing' }])
  })

  it('the script there but not readable as a file (a directory, a symlink loop): reason "not readable"', () => {
    put('agents/kevin/.claude/settings.json', JSON.stringify(wired()))
    rmSync(SCRIPT())
    mkdirSync(SCRIPT())
    expect(build('kevin').hooksNotWired).toEqual([{ id: 'shellRescan', path: SCRIPT(), reason: 'not readable' }])
    rmSync(SCRIPT(), { recursive: true })
    symlinkSync(SCRIPT(), SCRIPT())
    expect(build('kevin').hooksNotWired).toEqual([{ id: 'shellRescan', path: SCRIPT(), reason: 'not readable' }])
  })

  it('$CLAUDE_PROJECT_DIR resolves to the agent directory, and the entry names that path', () => {
    put('agents/kevin/.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR"/scripts/hooks/shell-rescan-guard.py' }] }] } }))
    expect(build('kevin').hooksNotWired).toEqual([{ id: 'shellRescan', path: join(root, 'agents', 'kevin', 'scripts', 'hooks', 'shell-rescan-guard.py'), reason: 'missing' }])
  })

  it('wired twice, one script missing and one there: the hook is wired, no entry', () => {
    const missing = join(root, 'elsewhere', 'scripts', 'hooks', 'shell-rescan-guard.py')
    put('agents/kevin/.claude/settings.local.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `python3 ${missing}` }] }] } }))
    put('agents/kevin/.claude/settings.json', JSON.stringify(wired()))
    const r = build('kevin')
    expect(r.ctx.hooks.shellRescan).toBe(true)
    expect(r.hooksNotWired).toEqual([])
  })

  it('two hooks with problems: both named, sorted by id', () => {
    const guard = join(root, 'scripts', 'hooks', 'child-claude-channel-guard.mjs')
    put('agents/kevin/.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: `python3 ${join(root, 'gone', 'scripts', 'hooks', 'shell-rescan-guard.py')}` },
      { type: 'command', command: `node ${guard}` },
    ] }] } }))
    expect(build('kevin').hooksNotWired).toEqual([
      { id: 'childClaudeGuard', path: guard, reason: 'missing' },
      { id: 'shellRescan', path: join(root, 'gone', 'scripts', 'hooks', 'shell-rescan-guard.py'), reason: 'missing' },
    ])
  })

  it('the same hook missing in two layers: both paths, sorted by path (not by layer order)', () => {
    const zz = join(root, 'zz', 'scripts', 'hooks', 'shell-rescan-guard.py')
    const aa = join(root, 'aa', 'scripts', 'hooks', 'shell-rescan-guard.py')
    const at = (p: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `python3 ${p}` }] }] } })
    put('agents/kevin/.claude/settings.local.json', at(zz)) // the higher layer, read first
    put('agents/kevin/.claude/settings.json', at(aa))
    expect(build('kevin').hooksNotWired).toEqual([
      { id: 'shellRescan', path: aa, reason: 'missing' },
      { id: 'shellRescan', path: zz, reason: 'missing' },
    ])
  })

  it('a project layer that does not parse: one "all" entry naming the file', () => {
    put('agents/kevin/.claude/settings.json', JSON.stringify(wired()))
    put('agents/kevin/.claude/settings.local.json', '{broken')
    const r = build('kevin')
    expect(r.ctx.hooks).toEqual(NONE)
    expect(r.hooksNotWired).toEqual([{ id: 'all', path: join(root, 'agents', 'kevin', '.claude', 'settings.local.json'), reason: 'settings layer does not parse' }])
  })

  it('Ron S1: a managed file that does not parse, and the main agent on another config root: one "all" entry each', () => {
    put('agents/kevin/.claude/settings.json', JSON.stringify(wired()))
    put('managed-settings.json', '{broken', home)
    expect(build('kevin').hooksNotWired).toEqual([{ id: 'all', path: managed, reason: 'managed settings do not parse' }])
    rmSync(managed)
    put('.env', 'MAIN_AGENT_CONFIG_DIR=/srv/bot\n')
    put('.claude/settings.json', JSON.stringify(wired()), home)
    expect(build('marveen').hooksNotWired).toEqual([{ id: 'all', path: null, reason: 'config root is not the session\'s' }])
    // the layers read are not the session's, so a script problem found in them is not reported as the cause
    rmSync(SCRIPT())
    expect(build('marveen').hooksNotWired).toEqual([{ id: 'all', path: null, reason: 'config root is not the session\'s' }])
  })

  it('the explicit switches are not faults: disableAllHooks and allowManagedHooksOnly give no entry', () => {
    put('agents/kevin/.claude/settings.json', JSON.stringify({ ...wired(), disableAllHooks: true }))
    rmSync(SCRIPT())
    expect(build('kevin').hooksNotWired).toEqual([])
    put('agents/kevin/.claude/settings.json', JSON.stringify(wired()))
    put('managed-settings.json', JSON.stringify({ allowManagedHooksOnly: true }), home)
    expect(build('kevin').hooksNotWired).toEqual([])
  })
})
