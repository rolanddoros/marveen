// kanban b15fe512 (Ron 17751 M1, 17776 K2): the '--' before the host is proved by ssh itself, not only by the argv
// shape. `ssh -G` parses the options and prints the resolved config WITHOUT connecting; `-O exit` on a control
// socket that does not exist fails before any network step. Each case runs the argv the builders really produce
// next to the old shape (no '--') as a positive control, so a green run means ssh saw the difference.
// `-F /dev/null` and an own HOME keep the machine's ssh config (LogLevel, ProxyJump, Host blocks) out of it.
// On CI ssh MUST be present (a missing ssh fails there); only a local run without ssh skips, loudly.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// cleanStaleSshSockets runs ssh through execFileSync with stdio ignored: record its argv, replay it below.
const spawned = vi.hoisted(() => ({ calls: [] as string[][] }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: (_file: string, args: string[]) => { spawned.calls.push([...args]); return Buffer.from('') },
}))

const SCRATCH = mkdtempSync(join(tmpdir(), 'ssh-dash-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME)
const prevXdg = process.env.XDG_RUNTIME_DIR
// CONTROL_PATH is computed at import: keep it inside the scratch dir, never the host's runtime dir.
process.env.XDG_RUNTIME_DIR = join(SCRATCH, 'run')
const { buildSshExec, buildTmuxInvocation, cleanStaleSshSockets, SSH_OPTS } = await import('../web/ssh-tmux.js')
afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR
  else process.env.XDG_RUNTIME_DIR = prevXdg
  rmSync(SCRATCH, { recursive: true, force: true })
})

const EVIL = '-Jattacker.example'
function ssh(args: string[]) {
  const r = spawnSync('ssh', args, { env: { HOME, PATH: process.env.PATH ?? '/usr/bin:/bin' }, encoding: 'utf-8', timeout: 10_000 })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
// -G (print config, no connection) and -F /dev/null go in front of the builder's own argv.
const G = (args: string[]) => ssh(['-G', '-F', '/dev/null', ...args])
const withoutDash = (args: string[]) => args.filter(a => a !== '--')

const sshOnPath = spawnSync('ssh', ['-V'], { encoding: 'utf-8' }).status === 0
const onCi = !!process.env.CI
if (!sshOnPath && !onCi) console.warn('[ssh-double-dash-behaviour] SKIPPED: no ssh on PATH (local run only; CI requires ssh)')

describe.runIf(onCi)('CI precondition', () => {
  it('ssh is on PATH in CI (the behaviour tests below must not skip there)', () => {
    expect(sshOnPath).toBe(true)
  })
})

describe.skipIf(!sshOnPath)("ssh itself honours the '--' the builders put before the host", () => {
  it('buildSshExec: a -J host is refused as a hostname, not read as ProxyJump (old shape: ProxyJump taken)', () => {
    const args = buildSshExec(EVIL, 'true').args
    const now = G(args)
    expect(now.status, now.out).not.toBe(0)
    expect(now.out).toContain('hostname contains invalid characters')
    expect(now.out).not.toMatch(/^proxyjump /m)
    const old = G(withoutDash(args))
    expect(old.status, old.out).toBe(0)
    expect(old.out).toMatch(/^proxyjump attacker\.example$/m)
  })

  it('buildSshExec: a remote argument starting with - is not an ssh option (old shape: -v raises the log level)', () => {
    const args = buildSshExec('devbox', '-v').args
    expect(G(args).out).toMatch(/^loglevel INFO$/m)
    expect(G(withoutDash(args)).out).toMatch(/^loglevel DEBUG$/m)
  })

  it('buildTmuxInvocation: a -J host is refused as a hostname, no ProxyJump', () => {
    const now = G(buildTmuxInvocation(EVIL, '/usr/bin/tmux', ['list-sessions']).args)
    expect(now.status, now.out).not.toBe(0)
    expect(now.out).toContain('hostname contains invalid characters')
    expect(now.out).not.toMatch(/^proxyjump /m)
  })

  it('cleanStaleSshSockets: -O exit with a -J host is refused as a hostname (old shape: the option eats the host, usage error)', () => {
    spawned.calls = []
    cleanStaleSshSockets(EVIL)
    expect(spawned.calls).toHaveLength(1)
    const args = spawned.calls[0]
    expect(args).toContain('--')
    const now = ssh(['-F', '/dev/null', ...args])
    expect(now.status).toBe(255)
    expect(now.out).toContain('hostname contains invalid characters')
    const old = ssh(['-F', '/dev/null', ...withoutDash(args)])
    expect(old.status).toBe(255)
    expect(old.out).toMatch(/^usage: ssh /m)
  })

  it('the shared options still apply with -- in place (BatchMode, ConnectTimeout)', () => {
    const out = G(buildSshExec('devbox', 'true').args).out
    expect(SSH_OPTS).toContain('BatchMode=yes')
    expect(out).toMatch(/^batchmode yes$/m)
    expect(out).toMatch(/^connecttimeout 5$/m)
    expect(out).toMatch(/^hostname devbox$/m)
  })
})
