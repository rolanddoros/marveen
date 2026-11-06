// C1 PR 7a: hooksFromSettings, the fail-closed map from an agent's written
// settings to ctx.hooks (src/web/claude-md/hooks-from-settings.ts). A false
// "true" drops a security rule's prose, so most cases here are negative.
import { describe, it, expect } from 'vitest'
import { commandRunsScript, hooksFromSettings, matcherCoversBash, resolveHookScriptPath, scriptPathsRun, type ScriptFileCheck } from '../web/claude-md/hooks-from-settings.js'

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
// The 7a cases are about the command text: every named file counts as present here. The J4 file
// check has its own describe block at the end.
const ANY: ScriptFileCheck = { projectDir: '/srv/fleet', usable: () => true }
const hfs = (layers: readonly unknown[], check: ScriptFileCheck = ANY) => hooksFromSettings(layers, check)
const ALL_TRUE = { directiveVerify: true, childClaudeGuard: true, shellRescan: true }
const ALL_FALSE = { directiveVerify: false, childClaudeGuard: false, shellRescan: false }

describe('positive: wired as a command under the right event', () => {
  it('all three hooks, in the shapes the scaffold and the main settings write', () => {
    expect(hfs([wiredAll])).toEqual(ALL_TRUE)
  })

  it('each hook alone', () => {
    expect(hfs([{ hooks: { PreToolUse: [entry(templateCmd(SHELL), 'Bash')] } }]))
      .toEqual({ ...ALL_FALSE, shellRescan: true })
    expect(hfs([{ hooks: { PreToolUse: [entry(nodeGateCmd(CHILD), 'Bash')] } }]))
      .toEqual({ ...ALL_FALSE, childClaudeGuard: true })
    expect(hfs([{ hooks: { UserPromptSubmit: [entry(templateCmd(DIRECTIVE))] } }]))
      .toEqual({ ...ALL_FALSE, directiveVerify: true })
  })

  it('wired in a later layer counts', () => {
    expect(hfs([{}, { hooks: { PreToolUse: [entry(projectDirCmd(SHELL), 'Bash')] } }]).shellRescan).toBe(true)
  })

  it('a quoted project dir before the path ("$CLAUDE_PROJECT_DIR"/scripts/hooks/...)', () => {
    expect(commandRunsScript(`python3 "$CLAUDE_PROJECT_DIR"/scripts/hooks/${SHELL}`, SHELL)).toBe(true)
  })

  it('the interpreter in command position: start, after &&, ;, |, (, a -c quote, then/else, exec, timeout', () => {
    for (const c of [
      `python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `/srv/fleet/.venv/bin/python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `cd /srv/fleet && python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `true; python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `cat /dev/null | python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `(python3 /srv/fleet/scripts/hooks/${SHELL})`,
      `bash -c 'python3 /srv/fleet/scripts/hooks/${SHELL}'`,
      `if true; then python3 /srv/fleet/scripts/hooks/${SHELL}; fi`,
      `exec python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `timeout 8 python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `timeout -k 1 8 python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `timeout --signal=KILL 2.5s python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `python3 /scripts/hooks/${SHELL}`,
    ]) {
      expect(commandRunsScript(c, SHELL), c).toBe(true)
    }
  })
})

describe('matcher must cover Bash (PreToolUse guards)', () => {
  it('none, "", "*" and a plain "|"-list with Bash cover it', () => {
    for (const m of [undefined, '', '*', 'Bash', 'Bash|Write', 'Edit|Bash']) expect(matcherCoversBash(m), String(m)).toBe(true)
  })

  it('a list without Bash, any regex, a case variant or a non-string does not', () => {
    for (const m of ['Write', 'Read|Edit', '.*', 'Ba.*', 'Bash.*', '^Bash$', '(Bash)', 'bash', 'Bash ', 'Bash|.*', 'Bash|Ba.*', 'BashOutput', 'BashOutput|Edit', 'Bashx|Write', 42, null, ['Bash']]) {
      expect(matcherCoversBash(m), JSON.stringify(m)).toBe(false)
    }
  })

  it('a guard under a matcher that misses Bash is not wired', () => {
    expect(hfs([{ hooks: { PreToolUse: [entry(templateCmd(SHELL), 'Write')] } }]).shellRescan).toBe(false)
    expect(hfs([{ hooks: { PreToolUse: [entry(nodeGateCmd(CHILD), '.*')] } }]).childClaudeGuard).toBe(false)
  })
})

describe('negative: wrong event', () => {
  it('a guard under PostToolUse, UserPromptSubmit or Stop is false', () => {
    for (const ev of ['PostToolUse', 'UserPromptSubmit', 'Stop', 'PreToolUseX', 'pretooluse']) {
      expect(hfs([{ hooks: { [ev]: [entry(templateCmd(SHELL), 'Bash'), entry(nodeGateCmd(CHILD), 'Bash')] } }]), ev)
        .toEqual(ALL_FALSE)
    }
  })

  it('directiveVerify under PreToolUse (even with a Bash matcher) is false', () => {
    expect(hfs([{ hooks: { PreToolUse: [entry(templateCmd(DIRECTIVE), 'Bash')] } }]).directiveVerify).toBe(false)
  })
})

describe('negative: the script name outside a command that runs it', () => {
  const ptu = (e: unknown) => hfs([{ hooks: { PreToolUse: [e] } }]).shellRescan

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
      `true # ; python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `true #&& exec python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `echo python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `printf '%s' node "/srv/fleet/scripts/hooks/${SHELL}"`,
      `true && echo node "/srv/fleet/scripts/hooks/${SHELL}"`,
      `logger -t hook python3 /srv/fleet/scripts/hooks/${SHELL}`,
    ]) {
      expect(commandRunsScript(c, SHELL), c).toBe(false)
      expect(ptu(entry(c, 'Bash')), c).toBe(false)
    }
  })

  it('the documented fail-closed forms read false although the script would run (header list)', () => {
    for (const c of [
      `python3 -I /srv/fleet/scripts/hooks/${SHELL}`,
      `nice -n 19 python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `env A=1 python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `uv run /srv/fleet/scripts/hooks/${SHELL}`,
      `sudo python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `timeout -s KILL 8 python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `timeout 8 exec python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `"$CLAUDE_PROJECT_DIR"/.venv/bin/python3 /srv/fleet/scripts/hooks/${SHELL}`,
      `/srv/fleet/scripts/hooks/${SHELL}`,
    ]) {
      expect(commandRunsScript(c, SHELL), c).toBe(false)
    }
  })

  it('a relative path (resolves against the hook cwd) is not wired', () => {
    for (const c of [
      `python3 ./scripts/hooks/${SHELL}`,
      `python3 scripts/hooks/${SHELL}`,
      `python3 "./scripts/hooks/${SHELL}"`,
      `exec python3 ../fleet/scripts/hooks/${SHELL}`,
      `bash -c '[ -f ./scripts/hooks/${SHELL} ] && exec python3 ./scripts/hooks/${SHELL}; exit 0'`,
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
    expect(hfs([{ ...wiredAll, disableAllHooks: true }])).toEqual(ALL_FALSE)
    expect(hfs([wiredAll, { disableAllHooks: true }])).toEqual(ALL_FALSE)
  })

  it('disableAllHooks with a non-boolean value fails closed; an explicit false keeps hooks on', () => {
    for (const v of ['true', 1, 'yes', null, {}]) {
      expect(hfs([{ ...wiredAll, disableAllHooks: v }]), JSON.stringify(v)).toEqual(ALL_FALSE)
    }
    expect(hfs([{ ...wiredAll, disableAllHooks: false }])).toEqual(ALL_TRUE)
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
      expect(hfs([layer]), JSON.stringify(layer)).toEqual(ALL_FALSE)
    }
  })

  it('no layers at all', () => {
    expect(hfs([])).toEqual(ALL_FALSE)
  })

  it('an unreadable layer (not a plain object) turns everything off, even next to a wired one', () => {
    for (const bad of [null, undefined, 'settings', 42, [wiredAll]]) {
      expect(hfs([wiredAll, bad]), String(bad)).toEqual(ALL_FALSE)
    }
  })
})

describe('Ron 12738: a separator, keyword or -c inside an argument is not a command (closed in C1 PR 10a)', () => {
  it('the four measured residual forms read false now', () => {
    for (const c of [
      `echo "a; python3 /x/scripts/hooks/${SHELL}"`,
      `echo do python3 /x/scripts/hooks/${SHELL}`,
      `echo -c 'python3 /x/scripts/hooks/${SHELL}'`,
      `echo "a | python3 /x/scripts/hooks/${SHELL}"`,
      `echo 'a && python3 /x/scripts/hooks/${SHELL}'`,
      `echo bash -c 'python3 /x/scripts/hooks/${SHELL}'`,
      `printf '%s\n' "then python3 /x/scripts/hooks/${SHELL}"`,
    ]) {
      expect(commandRunsScript(c, SHELL), c).toBe(false)
      expect(hfs([{ hooks: { PreToolUse: [entry(c, 'Bash')] } }]).shellRescan, c).toBe(false)
    }
  })

  it('the forms the fleet writes still read true: the template body, the node gate, the project-dir form', () => {
    expect(scriptPathsRun(templateCmd(SHELL), SHELL)).toEqual([`/srv/fleet/scripts/hooks/${SHELL}`])
    expect(scriptPathsRun(nodeGateCmd(CHILD), CHILD)).toEqual([`"/srv/fleet/scripts/hooks/${CHILD}"`, `"/srv/fleet/scripts/hooks/${CHILD}"`])
    expect(scriptPathsRun(projectDirCmd(DIRECTIVE), DIRECTIVE)).toEqual([`"$CLAUDE_PROJECT_DIR/scripts/hooks/${DIRECTIVE}"`])
    // a -c body in double quotes, with an escaped quote inside, and a combined -lc flag
    expect(commandRunsScript(`sh -c "x=\\"1\\"; python3 /x/scripts/hooks/${SHELL}"`, SHELL)).toBe(true)
    expect(commandRunsScript(`bash -lc 'python3 /x/scripts/hooks/${SHELL}'`, SHELL)).toBe(true)
    // a quoted single word stays a word: the "#" is not a comment and the python3 after ; runs
    expect(commandRunsScript(`echo "#"; python3 /x/scripts/hooks/${SHELL}`, SHELL)).toBe(true)
    // then/do behind a separator still count
    expect(commandRunsScript(`for i in 1; do python3 /x/scripts/hooks/${SHELL}; done`, SHELL)).toBe(true)
  })

  it('a -c body nested too deep is not followed (bounded recursion, fail-closed)', () => {
    let c = `python3 /x/scripts/hooks/${SHELL}`
    for (let i = 0; i < 6; i++) c = `bash -c ${JSON.stringify(c)}`
    expect(commandRunsScript(c, SHELL)).toBe(false)
  })
})

describe('J4 (Ron 7a): wired means the named script is an existing, readable regular file', () => {
  const present = new Set([`/srv/fleet/scripts/hooks/${SHELL}`, `/srv/fleet/scripts/hooks/${CHILD}`, `/srv/agent/scripts/hooks/${DIRECTIVE}`])
  const check: ScriptFileCheck = { projectDir: '/srv/agent', usable: (p) => present.has(p) }
  const seen: string[] = []
  const spy: ScriptFileCheck = { projectDir: '/srv/agent', usable: (p) => { seen.push(p); return present.has(p) } }

  it('the template form with a missing script (it would exit 0 silently) is NOT wired; with the file it is', () => {
    const missing: ScriptFileCheck = { projectDir: '/srv/agent', usable: () => false }
    expect(hfs([wiredAll], missing)).toEqual(ALL_FALSE)
    expect(hfs([{ hooks: { PreToolUse: [entry(templateCmd(SHELL), 'Bash')] } }], check).shellRescan).toBe(true)
  })

  it('$CLAUDE_PROJECT_DIR resolves to the agent project dir, and the check sees the absolute path', () => {
    seen.length = 0
    expect(hfs([{ hooks: { UserPromptSubmit: [entry(projectDirCmd(DIRECTIVE))] } }], spy).directiveVerify).toBe(true)
    expect(seen).toEqual([`/srv/agent/scripts/hooks/${DIRECTIVE}`])
    expect(resolveHookScriptPath('"${CLAUDE_PROJECT_DIR}"/scripts/hooks/x.py', '/srv/agent')).toBe('/srv/agent/scripts/hooks/x.py')
  })

  it('a path that cannot be resolved without a shell is not wired, and the check is never asked', () => {
    for (const raw of ['$HOME/scripts/hooks/x.py', '"$ROOT"/scripts/hooks/x.py', '$CLAUDE_PROJECT_DIRX/scripts/hooks/x.py']) {
      expect(resolveHookScriptPath(raw, '/srv/agent'), raw).toBeNull()
    }
    expect(resolveHookScriptPath('$CLAUDE_PROJECT_DIR/scripts/hooks/x.py', 'relative/dir')).toBeNull()
    seen.length = 0
    expect(hfs([{ hooks: { PreToolUse: [entry(`python3 "$HOME/scripts/hooks/${SHELL}"`, 'Bash')] } }], spy).shellRescan).toBe(false)
    expect(seen).toEqual([])
  })

  it('the check sees the normalised path: a ".." traversal is checked where it really points', () => {
    const c = `python3 /srv/fleet/scripts/hooks/../../evil/scripts/hooks/${SHELL}`
    seen.length = 0
    expect(hfs([{ hooks: { PreToolUse: [entry(c, 'Bash')] } }], spy).shellRescan).toBe(false)
    expect(seen).toEqual([`/srv/fleet/evil/scripts/hooks/${SHELL}`])
  })

  it('one usable match among several is enough; none usable is not wired', () => {
    expect(hfs([{ hooks: { PreToolUse: [entry(nodeGateCmd(CHILD), 'Bash')] } }], check).childClaudeGuard).toBe(true)
    const other: ScriptFileCheck = { projectDir: '/srv/agent', usable: (p) => p.startsWith('/elsewhere/') }
    expect(hfs([{ hooks: { PreToolUse: [entry(nodeGateCmd(CHILD), 'Bash')] } }], other).childClaudeGuard).toBe(false)
  })
})
