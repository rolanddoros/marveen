// scripts/hooks/settings-validator.mjs: one validator for the four settings kinds that decide a sub-agent's hooks
// and environment (Fork C settings-protect plan v2 point 1, addendum 1 D2-REL-1, Ron 17402 K3).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { validateSettings, canonicalJson, KINDS, EFFORT_LEVELS, ENV_NAMES, HOOK_SWITCH_KEYS } from '../../scripts/hooks/settings-validator.mjs'
import { EFFORT_LEVELS as MAIN_MODEL_EFFORT_LEVELS } from '../web/main-model.js'
import { enforceStrictPermissionMode } from '../web/agent-scaffold.js'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

type Result = { ok: boolean; errors: string[]; alerts: string[] }
const v = (kind: string, obj: unknown, ctx: Record<string, unknown> = {}): Result => validateSettings(kind, obj, ctx)

// Today's measured shapes (plan v2 point 0, key names only), with placeholder values.
const PROJECT = {
  enabledPlugins: { 'telegram@claude-plugins-official': true },
  effortLevel: 'high',
  permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(sudo:*)'] },
  hooks: { PreToolUse: [] },
  claudeMdExcludes: ['/root/marveen/CLAUDE.md'],
}
const USER = { enabledPlugins: { 'telegram@claude-plugins-official': true }, extraKnownMarketplaces: { m: { source: { source: 'github', repo: 'a/b' } } }, skipDangerousModePermissionPrompt: true }
const SHARED = { ...USER }

let base: string
let install: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'settings-validator-')))
  install = join(base, 'inst')
  mkdirSync(join(install, 'agents', 'stuart', '.config', 'gh'), { recursive: true })
  mkdirSync(join(install, 'agents', 'dennis', '.config', 'gh'), { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))
const local = (gh: string) => ({ env: { GH_CONFIG_DIR: gh }, claudeMdExcludes: ['x'], permissions: { deny: ['Read(//root/x/**)'] } })
const ctx = () => ({ installDir: install, agent: 'stuart' })

describe('today\'s measured shapes are green in every kind', () => {
  it('agent-project, agent-local, agent-user, shared-user', () => {
    expect(v('agent-project', PROJECT)).toEqual({ ok: true, errors: [], alerts: [] })
    expect(v('agent-project', { ...PROJECT, permissions: { ...PROJECT.permissions, additionalDirectories: ['/mnt/e/x'], defaultMode: 'dontAsk' } }).ok).toBe(true)
    expect(v('agent-local', local(join(install, 'agents', 'stuart', '.config', 'gh')), ctx())).toEqual({ ok: true, errors: [], alerts: [] })
    expect(v('agent-local', { claudeMdExcludes: [], permissions: { deny: [] } }).ok).toBe(true)
    expect(v('agent-user', USER, { sharedMarketplaces: USER.extraKnownMarketplaces, enabledPlugins: USER.enabledPlugins })).toEqual({ ok: true, errors: [], alerts: [] })
    expect(v('shared-user', SHARED)).toEqual({ ok: true, errors: [], alerts: [] })
  })
})

describe('strict kinds: a key that is not listed is an error', () => {
  for (const key of ['disableAllHooks', 'allowManagedHooksOnly', 'env', 'statusLine', 'apiKeyHelper', 'model', 'whatever']) {
    it(`agent-project: ${key}`, () => {
      const r = v('agent-project', { ...PROJECT, [key]: key === 'env' ? {} : true })
      expect(r.ok).toBe(false)
      expect(r.errors).toContain(`${key}: not allowed in agent-project`)
    })
  }
  for (const key of ['hooks', 'disableAllHooks', 'statusLine', 'enabledPlugins', 'whatever']) {
    it(`agent-local: ${key}`, () => {
      expect(v('agent-local', { [key]: {} }, ctx()).errors).toContain(`${key}: not allowed in agent-local`)
    })
  }
  it('agent-project permissions: only allow, deny, additionalDirectories, defaultMode dontAsk', () => {
    expect(v('agent-project', { permissions: { ask: [] } }).errors).toEqual(['permissions.ask: not allowed'])
    expect(v('agent-project', { permissions: { defaultMode: 'bypassPermissions' } }).errors).toEqual(['permissions.defaultMode: not one the scaffold writes'])
    expect(v('agent-project', { permissions: { additionalDirectories: ['rel/dir', '/a/../b'] } }).errors).toHaveLength(2)
    expect(v('agent-project', { permissions: { allow: ['x'.repeat(501)] } }).errors).toEqual(['permissions.allow[0]: 501 characters, at most 500'])
    expect(v('agent-project', { permissions: { deny: ['a\nb'] } }).errors).toEqual(['permissions.deny[0]: a control character'])
  })
  it('agent-project: effortLevel is a known level; enabledPlugins is { id: boolean }; hooks is an object', () => {
    expect(v('agent-project', { effortLevel: 'turbo' }).errors).toEqual(['effortLevel: not a known level'])
    expect(v('agent-project', { enabledPlugins: { p: 'yes' } }).errors).toEqual(['enabledPlugins."p": not a boolean'])
    expect(v('agent-project', { hooks: [] }).errors).toEqual(['hooks: not an object'])
  })
  it('the effort levels are the ones /model knows (src/web/main-model.ts)', () => {
    expect([...EFFORT_LEVELS]).toEqual([...MAIN_MODEL_EFFORT_LEVELS])
  })
  it('agent-local permissions: deny only', () => {
    for (const k of ['allow', 'ask', 'defaultMode', 'additionalDirectories']) {
      expect(v('agent-local', { permissions: { [k]: [] } }).errors).toEqual([`permissions.${k}: not allowed in agent-local`])
    }
  })
})

describe('env: GH_CONFIG_DIR only, only in agent-local, only under the agent\'s own directory', () => {
  for (const name of ['NODE_OPTIONS', 'PATH', 'BASH_ENV', 'LD_PRELOAD', 'HOME', 'ENV', 'PYTHONPATH', 'NODE_PATH']) {
    it(`agent-local env.${name} is an error`, () => {
      expect(v('agent-local', { env: { [name]: '/x' } }, ctx()).errors).toEqual([`env.${name}: not an allowed name`])
    })
  }
  it('the allowlist is GH_CONFIG_DIR alone', () => {
    expect([...ENV_NAMES]).toEqual(['GH_CONFIG_DIR'])
  })
  it('own dir green; another agent, "..", relative, outside, through a symlink outward red', () => {
    const own = join(install, 'agents', 'stuart', '.config', 'gh')
    expect(v('agent-local', local(own), ctx()).ok).toBe(true)
    const bad: Array<[string, string]> = [
      [join(install, 'agents', 'dennis', '.config', 'gh'), 'outside agents/stuart/'],
      [`${join(install, 'agents', 'stuart')}/../dennis/.config/gh`, 'not an absolute normalised path'],
      ['agents/stuart/.config/gh', 'not an absolute normalised path'],
      ['/root/.config/gh', 'outside agents/stuart/'],
      [join(install, 'agents', 'stuartx', '.config'), 'outside agents/stuart/'],
    ]
    for (const [gh, why] of bad) expect(v('agent-local', local(gh), ctx()).errors, gh).toEqual([`env.GH_CONFIG_DIR: ${why}`])
    symlinkSync(join(install, 'agents', 'dennis', '.config', 'gh'), join(install, 'agents', 'stuart', 'gh-link'))
    expect(v('agent-local', local(join(install, 'agents', 'stuart', 'gh-link')), ctx()).errors).toEqual(['env.GH_CONFIG_DIR: resolves outside agents/stuart/'])
    expect(v('agent-local', local(join(install, 'agents', 'stuart', 'missing')), ctx()).errors).toEqual(['env.GH_CONFIG_DIR: does not resolve'])
    expect(v('agent-local', local(own), {}).errors).toEqual(['env.GH_CONFIG_DIR: no install dir or agent to check it against'])
  })
  it('env in a user kind is an error, whatever the name', () => {
    expect(v('agent-user', { env: { GH_CONFIG_DIR: '/x' } }).errors).toEqual(['env: not allowed in agent-user'])
    expect(v('shared-user', { env: {} }).errors).toEqual(['env: not allowed in shared-user'])
  })
})

describe('user kinds: an unknown key name alerts, the value rules stay fail-closed (K3 ii)', () => {
  it('an unknown key alerts and does not fail', () => {
    expect(v('shared-user', { ...SHARED, someNewCliKey: 1, another: 2 })).toEqual({ ok: true, errors: [], alerts: ['another', 'someNewCliKey'] })
    expect(v('agent-user', { ...USER, someNewCliKey: 1 })).toEqual({ ok: true, errors: [], alerts: ['someNewCliKey'] })
  })
  for (const kind of ['agent-user', 'shared-user']) {
    for (const key of [...HOOK_SWITCH_KEYS, ...(kind === 'shared-user' ? ['permissions'] : [])]) {
      it(`${kind}: ${key} is an error`, () => {
        expect(v(kind, { ...USER, [key]: key === 'disableAllHooks' ? true : {} }).errors).toEqual([`${key}: not allowed in ${kind}`])
      })
    }
  }
  it('agent-user permissions: exactly the strict-profile pin the provisioning writes, nothing else', () => {
    // agent-process.ts provisionIsolatedConfigDir -> enforceStrictPermissionMode (profile developer-junior)
    const pinned: Record<string, unknown> = {}
    expect(enforceStrictPermissionMode(pinned, 'strict')).toBe(true)
    expect(v('agent-user', { ...USER, ...pinned })).toEqual({ ok: true, errors: [], alerts: [] })
    const why = ['permissions: only the strict-profile pin { defaultMode: "dontAsk" } in agent-user']
    for (const p of [{}, { defaultMode: 'bypassPermissions' }, { defaultMode: 'plan' }, { defaultMode: 'dontAsk', allow: ['Bash(*)'] }, { allow: ['Bash(*)'] }, []]) {
      expect(v('agent-user', { ...USER, permissions: p }).errors, JSON.stringify(p)).toEqual(why)
    }
  })
  it('statusLine: never in the shared file; in the isolated copy only a fixed command', () => {
    const sl = { type: 'command', command: 'bash /x/statusline.sh' }
    expect(v('shared-user', { statusLine: sl }).errors).toEqual(['statusLine: not allowed in shared-user'])
    expect(v('agent-user', { statusLine: sl }).errors).toEqual(['statusLine: not one of the fixed commands'])
    expect(v('agent-user', { statusLine: sl }, { statusLineCommands: ['bash /x/statusline.sh'] }).ok).toBe(true)
    expect(v('agent-user', { statusLine: { ...sl, command: 'bash /x/other.sh' } }, { statusLineCommands: ['bash /x/statusline.sh'] }).ok).toBe(false)
    expect(v('agent-user', { statusLine: { ...sl, extra: 1 } }, { statusLineCommands: ['bash /x/statusline.sh'] }).errors).toEqual(['statusLine.extra: not allowed'])
  })
  it('agent-user: enabledPlugins equal to the provisioning, marketplaces equal to the shared file', () => {
    expect(v('agent-user', USER, { enabledPlugins: { other: true } }).errors).toEqual(['enabledPlugins: differs from what the provisioning sets for this agent'])
    expect(v('agent-user', USER, { sharedMarketplaces: {} }).errors).toEqual(['extraKnownMarketplaces: differs from the shared file'])
    expect(v('agent-user', { skipDangerousModePermissionPrompt: 'yes' }).errors).toEqual(['skipDangerousModePermissionPrompt: not a boolean'])
  })
})

describe('shape and messages', () => {
  it('an unknown kind or a non-object file fails', () => {
    expect(v('nope', {}).ok).toBe(false)
    expect(v('agent-project', []).errors).toEqual(['the file is not a JSON object'])
    expect(v('agent-project', null).errors).toEqual(['the file is not a JSON object'])
    expect([...KINDS]).toEqual(['agent-project', 'agent-local', 'agent-user', 'shared-user'])
  })
  it('no message carries a value', () => {
    const secret = 'sk-ant-secret-value-123'
    const r = v('agent-local', { env: { NODE_OPTIONS: secret, GH_CONFIG_DIR: `/elsewhere/${secret}` }, whatever: secret }, ctx())
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain(secret)
  })
  it('canonicalJson ignores key order only', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }))
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }))
  })
})
