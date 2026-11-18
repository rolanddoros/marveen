import { describe, it, expect, vi, beforeEach } from 'vitest'

// cleanStaleSshSockets spawns ssh through execFileSync: record the argv instead of running it.
const spawned = vi.hoisted(() => ({ calls: [] as Array<{ file: string; args: string[] }> }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: (file: string, args: string[]) => { spawned.calls.push({ file, args: [...args] }); return Buffer.from('') },
}))

const {
  shQuote,
  buildTmuxInvocation,
  buildSshExec,
  cleanStaleSshSockets,
  sessionInList,
  SSH_OPTS,
  CONTROL_PATH,
  controlDir,
} = await import('../web/ssh-tmux.js')

describe('shQuote', () => {
  it('wraps a plain string in single quotes', () => {
    expect(shQuote('hello')).toBe("'hello'")
  })

  it('escapes an embedded single quote with the POSIX dance', () => {
    expect(shQuote("a'b")).toBe("'a'\\''b'")
  })

  it('keeps glob/bracket characters literal (inside single quotes)', () => {
    expect(shQuote('claude-opus-4-8[1m]')).toBe("'claude-opus-4-8[1m]'")
  })

  it('keeps shell metacharacters literal', () => {
    expect(shQuote('a; rm -rf / && echo $HOME')).toBe("'a; rm -rf / && echo $HOME'")
  })
})

describe('buildTmuxInvocation', () => {
  it('host=null returns the bare local binary + args (byte-identical to a direct local call)', () => {
    expect(buildTmuxInvocation(null, '/usr/bin/tmux', ['list-sessions'])).toEqual({
      file: '/usr/bin/tmux',
      args: ['list-sessions'],
    })
  })

  it('runAsUser on a local agent runs tmux AS that user via sudo -n, args untouched', () => {
    // The whole point: tmux refuses a cross-user socket connection, so reaching an
    // agent that owns its uid means BECOMING that user. -n so a missing sudoers
    // rule fails loudly instead of hanging on a password prompt nobody can type.
    expect(buildTmuxInvocation(null, '/usr/bin/tmux', ['send-keys', '-t', 'agent-korall', '-l', "a'b c"], 'tmux', 'agent-korall')).toEqual({
      file: 'sudo',
      args: ['-n', '-u', 'agent-korall', '/usr/bin/tmux', 'send-keys', '-t', 'agent-korall', '-l', "a'b c"],
    })
  })

  it('runAsUser does NOT shell-quote: sudo takes an argv, so metacharacters stay literal without quoting', () => {
    const inv = buildTmuxInvocation(null, '/usr/bin/tmux', ['send-keys', '-t', 'x', '-l', 'a; rm -rf / && echo $HOME'], 'tmux', 'agent-korall')
    expect(inv.args[inv.args.length - 1]).toBe('a; rm -rf / && echo $HOME')
  })

  it('a remote host wins over runAsUser (ssh already logs in as someone; they are alternatives)', () => {
    const inv = buildTmuxInvocation('devbox', '/usr/bin/tmux', ['list-sessions'], 'tmux', 'agent-korall')
    expect(inv.file).toBe('ssh')
    expect(inv.args.join(' ')).not.toContain('sudo')
  })

  it('runAsUser null is byte-identical to the old two-arg call', () => {
    expect(buildTmuxInvocation(null, '/usr/bin/tmux', ['list-sessions'], 'tmux', null))
      .toEqual(buildTmuxInvocation(null, '/usr/bin/tmux', ['list-sessions']))
  })

  it('host set wraps every tmux arg in one shell-quoted ssh command string', () => {
    const inv = buildTmuxInvocation('devbox', '/usr/bin/tmux', ['send-keys', '-t', 'agent-x', '-l', "a'b c"])
    expect(inv.file).toBe('ssh')
    // SSH_OPTS, then '--', then the host, then exactly ONE remote command string.
    expect(inv.args.length).toBe(SSH_OPTS.length + 3)
    expect(inv.args.slice(0, SSH_OPTS.length)).toEqual([...SSH_OPTS])
    expect(inv.args[SSH_OPTS.length]).toBe('--')
    expect(inv.args[SSH_OPTS.length + 1]).toBe('devbox')
    expect(inv.args[SSH_OPTS.length + 2]).toBe(
      "tmux 'send-keys' '-t' 'agent-x' '-l' 'a'\\''b c'",
    )
  })

  it('a full new-session launch command rides as a SINGLE argv element with brackets kept literal', () => {
    const cmd = "cd '/home/user/p' && claude --continue --model 'claude-opus-4-8[1m]'"
    const inv = buildTmuxInvocation('devbox', '/usr/bin/tmux', ['new-session', '-d', '-s', 'agent-x', cmd])
    expect(inv.file).toBe('ssh')
    // '--' + host + ONE command string => no splitting of cmd across argv elements.
    expect(inv.args.length).toBe(SSH_OPTS.length + 3)
    const remote = inv.args[SSH_OPTS.length + 2]
    expect(remote.startsWith("tmux 'new-session' '-d' '-s' 'agent-x' ")).toBe(true)
    // The bracketed model token survives intact inside the quoting.
    expect(remote).toContain('claude-opus-4-8[1m]')
  })

  it('preserves a slid leading-dash chunk (Hungarian suffix) verbatim', () => {
    const inv = buildTmuxInvocation('devbox', '/usr/bin/tmux', ['send-keys', '-t', 'agent-x', '-l', ' -szal'])
    const remote = inv.args[SSH_OPTS.length + 2]
    expect(remote.endsWith("' -szal'")).toBe(true)
  })
})

describe('buildSshExec', () => {
  it('builds an ssh invocation with SSH_OPTS + -- + host + the raw remote command', () => {
    const inv = buildSshExec('devbox', 'which claude')
    expect(inv.file).toBe('ssh')
    expect(inv.args).toEqual([...SSH_OPTS, '--', 'devbox', 'which claude'])
  })
})

// kanban b15fe512 (Ron 17751 M1, 17776 K1): '--' stands AFTER every option and directly BEFORE the host at all three
// ssh sites, so neither a '-' host nor a '-' remote argument is read as an ssh option; the local branches never get it.
describe("'--' before the host, at every ssh site and nowhere else", () => {
  beforeEach(() => { spawned.calls = [] })
  const dashAt = (args: string[]) => args.indexOf('--')

  it('buildTmuxInvocation and buildSshExec: -- once, right after the last ssh option, host right after it', () => {
    for (const inv of [
      buildTmuxInvocation('devbox', '/usr/bin/tmux', ['list-sessions']),
      buildTmuxInvocation('devbox', '/usr/bin/tmux', ['list-sessions'], 'tmux', 'agent-korall'),
      buildSshExec('devbox', 'which claude'),
    ]) {
      expect(inv.args.filter(a => a === '--')).toHaveLength(1)
      expect(dashAt(inv.args)).toBe(SSH_OPTS.length)
      expect(inv.args[dashAt(inv.args) + 1]).toBe('devbox')
    }
  })

  it('cleanStaleSshSockets: ssh -O exit -o ControlPath=... -- host', () => {
    cleanStaleSshSockets('devbox')
    expect(spawned.calls).toEqual([{ file: 'ssh', args: ['-O', 'exit', '-o', `ControlPath=${CONTROL_PATH}`, '--', 'devbox'] }])
  })

  it('the local and the sudo branch are unchanged: the tmux args exactly, no -- added', () => {
    const args = ['list-sessions', '-F', '#{session_name}']
    expect(buildTmuxInvocation(null, '/usr/bin/tmux', args)).toEqual({ file: '/usr/bin/tmux', args })
    expect(buildTmuxInvocation(null, '/usr/bin/tmux', args, 'tmux', 'agent-korall'))
      .toEqual({ file: 'sudo', args: ['-n', '-u', 'agent-korall', '/usr/bin/tmux', ...args] })
  })
})

describe('SSH_OPTS', () => {
  it('bounds an alive-but-unresponsive remote (ServerAlive), not just TCP connect', () => {
    expect(SSH_OPTS).toContain('ServerAliveInterval=2')
    expect(SSH_OPTS).toContain('ServerAliveCountMax=2')
    expect(SSH_OPTS).toContain('ConnectTimeout=5')
    expect(SSH_OPTS).toContain('BatchMode=yes')
  })

  it('uses a private ControlMaster socket dir, not a bare world-writable /tmp path', () => {
    const cpIdx = SSH_OPTS.indexOf('ControlMaster=auto')
    expect(cpIdx).toBeGreaterThanOrEqual(0)
    const controlPathOpt = SSH_OPTS.find(o => o.startsWith('ControlPath='))
    expect(controlPathOpt).toBeDefined()
    expect(controlPathOpt).toContain(controlDir())
    expect(controlDir()).toMatch(/marveen-ssh/)
    // Not the bare `/tmp/<file>` form flagged as world-writable.
    expect(controlPathOpt).not.toMatch(/ControlPath=\/tmp\/[^/]+%/)
  })
})

describe('sessionInList', () => {
  it('matches an exact session line', () => {
    expect(sessionInList('agent-a\nagent-b\n', 'agent-b')).toBe(true)
  })

  it('is false when the session is absent', () => {
    expect(sessionInList('agent-a\n', 'agent-x')).toBe(false)
  })

  it('does not match on a substring of a longer session name', () => {
    expect(sessionInList('agent-bbb\n', 'agent-b')).toBe(false)
  })
})
