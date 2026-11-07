// C1 PR 13b: token-argv-guard is wired for the main agent (the repo's .claude/settings.json) and for
// the sub-agents (templates/settings.json.template; ensureAgentHooks' add pass carries a new template
// command to the existing fleet), PreToolUse on Bash, with the fail-open wrapper: a missing script
// exits 0, the script's own status passes through (warn = 0, enforce = 2). It is locked in
// hook_switches (Kevin 13564), so its sidecar entry is a gate; its off switch is TOKEN_ARGV_GUARD.
// The behaviour itself is pinned in scripts/__tests__/token-argv-guard.test.py.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf-8')

interface Group { matcher?: string, hooks: { type: string, command: string, timeout: number }[] }
const groupsWith = (groups: Group[], script: string) => groups.filter((g) => JSON.stringify(g).includes(script))

describe('C1 PR 13b: token-argv-guard wiring', () => {
  it('main agent: one PreToolUse group on Bash, the fail-open wrapper, 10 s', () => {
    const settings = JSON.parse(read('.claude', 'settings.json')) as { hooks: Record<string, Group[]> }
    const g = groupsWith(settings.hooks.PreToolUse, 'token-argv-guard.py')
    expect(g).toHaveLength(1)
    expect(g[0].matcher).toBe('Bash')
    expect(g[0].hooks).toEqual([{
      type: 'command',
      command: `bash -c '[ -f "$CLAUDE_PROJECT_DIR/scripts/hooks/token-argv-guard.py" ] && exec python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/token-argv-guard.py"; exit 0'`,
      timeout: 10,
    }])
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (event !== 'PreToolUse') expect(groupsWith(groups, 'token-argv-guard.py'), event).toHaveLength(0)
    }
  })

  it('sub-agents: the template carries the same group with the project root placeholder', () => {
    const tpl = read('templates', 'settings.json.template')
    const settings = JSON.parse(tpl) as { hooks: Record<string, Group[]> }
    const g = groupsWith(settings.hooks.PreToolUse, 'token-argv-guard.py')
    expect(g).toHaveLength(1)
    expect(g[0].matcher).toBe('Bash')
    expect(g[0].hooks).toEqual([{
      type: 'command',
      command: "bash -c '[ -f {{PROJECT_ROOT}}/scripts/hooks/token-argv-guard.py ] && exec python3 {{PROJECT_ROOT}}/scripts/hooks/token-argv-guard.py; exit 0'",
      timeout: 10,
    }])
  })

  it('the sidecar marks it a gate, and hook_switches locks it', () => {
    const meta = JSON.parse(read('.claude', 'hooks.metadata.json')) as { hooks: Record<string, { hook: string, gate: boolean }[]> }
    const entries = meta.hooks.PreToolUse.filter((e) => e.hook === 'token-argv-guard')
    expect(entries).toHaveLength(1)
    expect(entries[0].gate).toBe(true)
    expect(read('scripts', 'hooks', 'hook_switches.py')).toMatch(/^ {4}"token-argv-guard",/m)
  })
})
