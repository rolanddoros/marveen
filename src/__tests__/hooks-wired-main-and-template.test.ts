// C1 PR 13a (design 2.4 a, c, d): the repo-shipped main-agent settings wire the child-claude guard
// and directive-verify, the sub-agent template wires directive-verify, and the v2 region drops the
// two rules' prose ONLY while the hook is really wired (hooksFromSettings, J4: the script must exist).
// Read from the REAL files, not fixtures: a later edit that unwires either hook turns this red.
import { describe, it, expect } from 'vitest'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hooksFromSettings, type ScriptFileCheck } from '../web/claude-md/hooks-from-settings.js'
import { RULES, ruleLine } from '../web/claude-md/sections.js'
import { renderRegion } from '../web/claude-md/registry.js'
import { FIXTURES } from './fixtures/claude-md/contexts.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const mainSettings = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf-8'))
// The scaffold substitutes {{PROJECT_ROOT}} with the install root (substituteTemplatePlaceholders);
// the other placeholders sit inside strings and do not touch the hooks.
const template = JSON.parse(readFileSync(join(REPO, 'templates', 'settings.json.template'), 'utf-8')
  .replaceAll('{{PROJECT_ROOT}}', REPO).replace(/\{\{[A-Z_]+\}\}/g, 'x'))

function usable(missing: readonly string[] = []): ScriptFileCheck['usable'] {
  return (p: string) => {
    if (missing.some((m) => p.endsWith(`/scripts/hooks/${m}`))) return false
    try { accessSync(p, constants.R_OK); return statSync(p).isFile() } catch { return false }
  }
}
const mainHooks = (missing: readonly string[] = []) => hooksFromSettings([mainSettings], { projectDir: REPO, usable: usable(missing) })
const subHooks = (missing: readonly string[] = []) =>
  hooksFromSettings([template], { projectDir: join(REPO, 'agents', 'x'), usable: usable(missing) })
const rule = (id: string) => RULES.find((r) => r.id === id)!

describe('C1 PR 13a: the main agent settings (repo .claude/settings.json)', () => {
  it('wire the child-claude guard, directive-verify and the shell-rescan guard, all with their scripts present', () => {
    expect(mainHooks()).toEqual({ directiveVerify: true, childClaudeGuard: true, shellRescan: true })
  })

  it('J4: a missing script reads not wired, for each of the two new hooks separately', () => {
    expect(mainHooks(['directive-verify.py'])).toEqual({ directiveVerify: false, childClaudeGuard: true, shellRescan: true })
    expect(mainHooks(['child-claude-channel-guard.mjs'])).toEqual({ directiveVerify: true, childClaudeGuard: false, shellRescan: true })
  })

  it('the guard is a fail-open Bash hook (Kevin 13549 B1); directive-verify can never block a prompt', () => {
    const ptu = mainSettings.hooks.PreToolUse as { matcher?: string, hooks: { command: string, timeout: number }[] }[]
    const guard = ptu.filter((e) => JSON.stringify(e).includes('child-claude-channel-guard.mjs'))
    expect(guard).toHaveLength(1)
    expect(guard[0].matcher).toBe('Bash')
    const g = guard[0].hooks[0]
    expect(g.timeout).toBe(10)
    // Missing script or node: exit 0. Only an intentional 2 passes; every other status becomes 0.
    // The behaviour itself is pinned in main-hooks-failsafe.test.ts.
    expect(g.command).toContain('[ -f "$CLAUDE_PROJECT_DIR/scripts/hooks/child-claude-channel-guard.mjs" ] && command -v node >/dev/null 2>&1 || exit 0;')
    expect(g.command).toMatch(/\[ \$\? = 2 \] && exit 2; exit 0'$/)
    expect(g.command).not.toContain('governance-kapu')
    const ups = mainSettings.hooks.UserPromptSubmit as { matcher?: string, hooks: { command: string, timeout: number }[] }[]
    const dv = ups.filter((e) => JSON.stringify(e).includes('directive-verify.py'))
    expect(dv).toHaveLength(1)
    expect(dv[0].hooks).toEqual([{
      type: 'command',
      command: `bash -c '[ -f "$CLAUDE_PROJECT_DIR/scripts/hooks/directive-verify.py" ] && exec python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/directive-verify.py"; exit 0'`,
      timeout: 10,
    }])
  })
})

describe('C1 PR 13a: the sub-agent template', () => {
  it('wires directive-verify (the guard comes from injectChildClaudeGuard, not the template)', () => {
    expect(subHooks().directiveVerify).toBe(true)
    expect(subHooks(['directive-verify.py']).directiveVerify).toBe(false)
  })
})

describe('C1 PR 13a d): the region drops the prose only where the hook is wired', () => {
  it('main agent: both hooked one-liners with the real settings; the long fallback when a script is missing', () => {
    const on = { ...FIXTURES.main, hooks: mainHooks() }
    const region = renderRegion(on)
    for (const id of ['directive-auth', 'child-claude']) expect(region, id).toContain(ruleLine(rule(id), on))
    expect(region).toContain('verified by hook directive-verify')
    expect(region).toContain('is blocked by hook child-claude-channel-guard')
    const j4 = { ...FIXTURES.main, hooks: mainHooks(['directive-verify.py', 'child-claude-channel-guard.mjs']) }
    const fallback = renderRegion(j4)
    expect(fallback).not.toContain('verified by hook directive-verify')
    expect(fallback).not.toContain('is blocked by hook child-claude-channel-guard')
    expect(fallback).toContain('run `directive-verify N` first')
    expect(fallback).toContain('Never run `claude mcp list` or a child `claude` with the inherited environment')
  })

  it('sub-agent: the directive one-liner with the real template; the fallback when the script is missing', () => {
    const base = FIXTURES['sub-strict']
    const on = { ...base, hooks: { ...base.hooks, directiveVerify: subHooks().directiveVerify } }
    expect(renderRegion(on)).toContain(ruleLine(rule('directive-auth'), on))
    expect(renderRegion(on)).toContain('verified by hook directive-verify')
    const off = { ...base, hooks: { ...base.hooks, directiveVerify: subHooks(['directive-verify.py']).directiveVerify } }
    expect(renderRegion(off)).not.toContain('verified by hook directive-verify')
  })
})
