// C1 PR 7a: hooksFromSettings, the fail-closed map from an agent's written
// settings to ctx.hooks (src/web/claude-md/hooks-from-settings.ts). A false
// "true" drops a security rule's prose, so most cases here are negative.
import { describe, it, expect } from 'vitest'
import { commandRunsScript, hooksFromSettings, matcherCoversBash } from '../web/claude-md/hooks-from-settings.js'

// The three command shapes the fleet writes today.
const templateCmd = (s: string) => `bash -c '[ -f /srv/fleet/scripts/hooks/${s} ] && exec python3 /srv/fleet/scripts/hooks/${s}; exit 0'`
const nodeGateCmd = (s: string) =>
  `test -x "/usr/bin/node" || { echo "missing" >&2; exit 2; }; if command -v timeout >/dev/null 2>&1; then timeout -k 1 8 "/usr/bin/node" "/srv/fleet/scripts/hooks/${s}"; else "/usr/bin/node" "/srv/fleet/scripts/hooks/${s}"; fi; rc=$?; [ "$rc" = 0 ] || { echo "governance-kapu (fail-closed): ${s}: rc=$rc" >&2; exit 2; }; exit "$rc"`
const projectDirCmd = (s: string) => `bash -c '[ -f "$CLAUDE_PROJECT_DIR/scripts/hooks/${s}" ] && exec python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/${s}"; exit 0'`

const SHELL = 'shell-rescan-guard.py'
const CHILD = 'child-claude-channel-guard.mjs'
const DIRECTIVE = 'directive-verify.py'

const entry = (command: string, matcher?: unknown, type = 'command') =>
  ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type, command }] })

const wiredAll = {
  hooks: {
    UserPromptSubmit: [entry(projectDirCmd(DIRECTIVE))],
    PreToolUse: [entry(templateCmd(SHELL), 'Bash'), entry(nodeGateCmd(CHILD), 'Bash')],
  },
}
const ALL_TRUE = { directiveVerify: true, childClaudeGuard: true, shellRescan: true }
const ALL_FALSE = { directiveVerify: false, childClaudeGuard: false, shellRescan: false }

describe('positive: wired as a command under the right event', () => {
  it('all three hooks, in the shapes the scaffold and the main settings write', () => {
    expect(hooksFromSettings([wiredAll])).toEqual(ALL_TRUE)
  })

  it('each hook alone', () => {
    expect(hooksFromSettings([{ hooks: { PreToolUse: [entry(templateCmd(SHELL), 'Bash')] } }]))
      .toEqual({ ...ALL_FALSE, shellRescan: true })
    expect(hooksFromSettings([{ hooks: { PreToolUse: [entry(nodeGateCmd(CHILD), 'Bash')] } }]))
      .toEqual({ ...ALL_FALSE, childClaudeGuard: true })
    expect(hooksFromSettings([{ hooks: { UserPromptSubmit: [entry(templateCmd(DIRECTIVE))] } }]))
      .toEqual({ ...ALL_FALSE, directiveVerify: true })
  })

  it('wired in a later layer counts', () => {
    expect(hooksFromSettings([{}, { hooks: { PreToolUse: [entry(projectDirCmd(SHELL), 'Bash')] } }]).shellRescan).toBe(true)
  })

  it('a quoted project dir before the path ("$CLAUDE_PROJECT_DIR"/scripts/hooks/...)', () => {
    expect(commandRunsScript(`python3 "$CLAUDE_PROJECT_DIR"/scripts/hooks/${SHELL}`, SHELL)).toBe(true)
  })
})

describe('matcher must cover Bash (PreToolUse guards)', () => {
  it('none, "", "*" and a plain "|"-list with Bash cover it', () => {
    for (const m of [undefined, '', '*', 'Bash', 'Bash|Write', 'Edit|Bash']) expect(matcherCoversBash(m), String(m)).toBe(true)
  })

  it('a list without Bash, any regex, a case variant or a non-string does not', () => {
    for (const m of ['Write', 'Read|Edit', '.*', 'Ba.*', 'Bash.*', '^Bash$', '(Bash)', 'bash', 'Bash ', 'Bash|.*', 'Bash|Ba.*', 42, null, ['Bash']]) {
      expect(matcherCoversBash(m), JSON.stringify(m)).toBe(false)
    }
  })

  it('a guard under a matcher that misses Bash is not wired', () => {
    expect(hooksFromSettings([{ hooks: { PreToolUse: [entry(templateCmd(SHELL), 'Write')] } }]).shellRescan).toBe(false)
    expect(hooksFromSettings([{ hooks: { PreToolUse: [entry(nodeGateCmd(CHILD), '.*')] } }]).childClaudeGuard).toBe(false)
  })
})

describe('negative: wrong event', () => {
  it('a guard under PostToolUse, UserPromptSubmit or Stop is false', () => {
    for (const ev of ['PostToolUse', 'UserPromptSubmit', 'Stop', 'PreToolUseX', 'pretooluse']) {
      expect(hooksFromSettings([{ hooks: { [ev]: [entry(templateCmd(SHELL), 'Bash'), entry(nodeGateCmd(CHILD), 'Bash')] } }]), ev)
        .toEqual(ALL_FALSE)
    }
  })

  it('directiveVerify under PreToolUse (even with a Bash matcher) is false', () => {
    expect(hooksFromSettings([{ hooks: { PreToolUse: [entry(templateCmd(DIRECTIVE), 'Bash')] } }]).directiveVerify).toBe(false)
  })
})

describe('negative: the script name outside a command that runs it', () => {
  const ptu = (e: unknown) => hooksFromSettings([{ hooks: { PreToolUse: [e] } }]).shellRescan

  it('a non-command hook type (prompt, agent) mentioning the script', () => {
    expect(ptu(entry(templateCmd(SHELL), 'Bash', 'prompt'))).toBe(false)
    expect(ptu({ matcher: 'Bash', hooks: [{ type: 'prompt', prompt: `run /x/scripts/hooks/${SHELL}` }] })).toBe(false)
  })

  it('the script only in the matcher or in another field of the entry', () => {
    expect(ptu({ matcher: `Bash|${SHELL}`, hooks: [{ type: 'command', command: 'true' }] })).toBe(false)
    expect(ptu({ matcher: 'Bash', statusMessage: templateCmd(SHELL), hooks: [{ type: 'command', command: 'true' }] })).toBe(false)
    expect(ptu({ matcher: 'Bash', hooks: [{ type: 'command', command: 'true', description: templateCmd(SHELL) }] })).toBe(false)
  })

  it('a command that mentions but does not run it', () => {
    for (const c of [
      `echo /srv/fleet/scripts/hooks/${SHELL}`,
      `cat "/srv/fleet/scripts/hooks/${SHELL}"`,
      `[ -f /srv/fleet/scripts/hooks/${SHELL} ]`,
      `python3 ${SHELL}`,
      `python3 /srv/fleet/hooks/${SHELL}`,
      `true # python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `#python3 /srv/fleet/scripts/hooks/${SHELL}`,
    ]) {
      expect(commandRunsScript(c, SHELL), c).toBe(false)
      expect(ptu(entry(c, 'Bash')), c).toBe(false)
    }
  })

  it('a look-alike script name', () => {
    for (const c of [
      `python3 /srv/fleet/scripts/hooks/${SHELL}.bak`,
      `python3 /srv/fleet/scripts/hooks/${SHELL}c`,
      `python3 /srv/fleet/scripts/hooks/x${SHELL}`,
      `python3 /srv/fleet/scripts/hooks/shell-rescan-guardXpy`,
    ]) {
      expect(commandRunsScript(c, SHELL), c).toBe(false)
    }
  })

  it('a non-string command', () => {
    expect(commandRunsScript(undefined, SHELL)).toBe(false)
    expect(commandRunsScript(['python3', `/x/scripts/hooks/${SHELL}`], SHELL)).toBe(false)
  })
})

describe('negative: disabled, empty or malformed blocks', () => {
  it('disableAllHooks in the same or in another layer turns everything off', () => {
    expect(hooksFromSettings([{ ...wiredAll, disableAllHooks: true }])).toEqual(ALL_FALSE)
    expect(hooksFromSettings([wiredAll, { disableAllHooks: true }])).toEqual(ALL_FALSE)
  })

  it('disableAllHooks with a non-boolean value fails closed; an explicit false keeps hooks on', () => {
    for (const v of ['true', 1, 'yes', null, {}]) {
      expect(hooksFromSettings([{ ...wiredAll, disableAllHooks: v }]), JSON.stringify(v)).toEqual(ALL_FALSE)
    }
    expect(hooksFromSettings([{ ...wiredAll, disableAllHooks: false }])).toEqual(ALL_TRUE)
  })

  it('empty and malformed hook blocks', () => {
    for (const layer of [
      {},
      { hooks: {} },
      { hooks: null },
      { hooks: [] },
      { hooks: 'PreToolUse' },
      { hooks: { PreToolUse: [] } },
      { hooks: { PreToolUse: {} } },
      { hooks: { PreToolUse: [null, 'x', 42] } },
      { hooks: { PreToolUse: [{ matcher: 'Bash' }] } },
      { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } },
      { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: {} }] } },
      { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [null, templateCmd(SHELL)] }] } },
    ]) {
      expect(hooksFromSettings([layer]), JSON.stringify(layer)).toEqual(ALL_FALSE)
    }
  })

  it('no layers at all', () => {
    expect(hooksFromSettings([])).toEqual(ALL_FALSE)
  })

  it('an unreadable layer (not a plain object) turns everything off, even next to a wired one', () => {
    for (const bad of [null, undefined, 'settings', 42, [wiredAll]]) {
      expect(hooksFromSettings([wiredAll, bad]), String(bad)).toEqual(ALL_FALSE)
    }
  })
})
