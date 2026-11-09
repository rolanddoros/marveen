// A5-main-hooks-failsafe: the main agent's tracked .claude/settings.json used to run its hooks as bare
// `python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/<x>.py"`. A missing script (mid `git checkout` during an
// update, a rename) makes python3 exit 2, and exit 2 on UserPromptSubmit BLOCKS the prompt: the deaf-agent
// incident hook-registration-guard.ts describes. On PreToolUse the same exit 2 blocks every matching tool
// call, on Stop it refuses to let the turn end.
//
// Every hook now carries an explicit fail mode, mirroring the sub-agent wrapper
// (`bash -c '[ -f X ] && exec python3 X; exit 0'`):
//   - fail OPEN: a missing script exits 0; a present script's status and stdout pass through unchanged,
//     so an intentional block (marveen-commands.py exit 2, the Stop guard) still works;
//   - fail CLOSED (unchanged): the governance-kapu security gates, covered by hook-fail-closed.test.ts;
//   - fleet-freeze-gate.sh: fail closed only while the fleet is frozen (missing script + freeze file -> 2).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HOOK_MANIFEST, fleetFreezeGateHook, renderHooks } from '../web/hooks/manifest.js'

const ROOT = join(__dirname, '..', '..')
const SETTINGS_PATH = process.env.MAIN_SETTINGS_UNDER_TEST ?? join(ROOT, '.claude', 'settings.json')
const FAIL_CLOSED_TAG = 'governance-kapu (fail-closed)'
const SHELLS = ['/bin/sh', '/bin/bash']

interface Handler { event: string; matcher?: string; command: string }
const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
}
const handlers: Handler[] = Object.entries(settings.hooks).flatMap(([event, groups]) =>
  groups.flatMap((g) => g.hooks.map((h) => ({ event, matcher: g.matcher, command: h.command }))))

const scriptOf = (c: string) => c.match(/scripts\/hooks\/([^/\s'"]+?\.(?:py|sh|mjs))/)?.[1] ?? ''
const isSecurityGate = (h: Handler) => h.command.includes(FAIL_CLOSED_TAG)
const isFreezeGate = (h: Handler) => scriptOf(h.command) === 'fleet-freeze-gate.sh'
const failOpen = handlers.filter((h) => !isSecurityGate(h) && !isFreezeGate(h))
const label = (h: Handler) => `${h.event} ${scriptOf(h.command)}${h.matcher ? ` @ ${h.matcher}` : ''}`

let tmp: string
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'main-hooks-failsafe-')) })
afterAll(() => { rmSync(tmp, { recursive: true, force: true }) })

// A fresh project dir: CLAUDE_PROJECT_DIR points here, scripts/hooks/ starts empty.
function project(): string {
  const p = mkdtempSync(join(tmp, 'proj-'))
  mkdirSync(join(p, 'scripts', 'hooks'), { recursive: true })
  mkdirSync(join(p, 'store'), { recursive: true })
  return p
}

// A stand-in hook that echoes its argv and stdin to stdout, then exits with `code`.
function stub(proj: string, name: string, code: number): void {
  const body = name.endsWith('.sh')
    ? `#!/bin/bash\nprintf 'args=%s stdin=%s' "$*" "$(cat)"\nexit ${code}\n`
    : name.endsWith('.mjs')
      ? `import { readFileSync } from 'node:fs'\nprocess.stdout.write('args=' + process.argv.slice(2).join(' ') + ' stdin=' + readFileSync(0, 'utf8'))\nprocess.exit(${code})\n`
      : `import sys\nsys.stdout.write("args=" + " ".join(sys.argv[1:]) + " stdin=" + sys.stdin.read())\nsys.exit(${code})\n`
  writeFileSync(join(proj, 'scripts', 'hooks', name), body)
}

// The child-claude guard (C1 PR 13a, Kevin 13549 B1) blocks through a deny decision on stdout with exit 0. Since
// C3-5b it has the one open spelling (failOpenExec) like every other fail-open hook: a status passes through.
const CHILD_GUARD = 'child-claude-channel-guard.mjs'

function run(shell: string, command: string, proj: string) {
  const r = spawnSync(shell, ['-c', command], {
    input: '{"x":1}', cwd: proj, encoding: 'utf-8', timeout: 30_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: proj, CLAUDE_PROJECT_DIR: proj },
  })
  return { rc: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('main agent hooks: explicit fail mode (A5-main-hooks-failsafe)', () => {
  it('classifies every handler: 16 security gates, 1 freeze gate, the rest fail-open', () => {
    // 16 = 8 outgoing-copy-gate + 6 email-approval-gate + egress-gate + db-write-gate (upstream APPROVALDBGATE1030)
    // The child-claude-channel-guard (C1 PR 13a) is fail-open on the main agent (Kevin 13549 B1): it guards
    // against an accident, and a broken guard must not stop every Bash call.
    expect(handlers.filter(isSecurityGate)).toHaveLength(16)
    expect(handlers.filter(isFreezeGate)).toHaveLength(1)
    expect(failOpen.length).toBe(handlers.length - 17)
    // All 13 UserPromptSubmit hooks are fail-open (directive-verify, C1 PR 13a, is the 13th): a broken UPS
    // hook must never deafen the agent.
    expect(failOpen.filter((h) => h.event === 'UserPromptSubmit')).toHaveLength(13)
  })

  it('the bare form this replaces does block on a missing script (the defect)', () => {
    const proj = project()
    expect(run('/bin/sh', 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/ledger-capture.py"', proj).rc).toBe(2)
  })

  for (const shell of SHELLS) {
    describe(shell, () => {
      it('fail-open hooks exit 0 when their script is missing', () => {
        const proj = project()
        for (const h of failOpen) expect(run(shell, h.command, proj).rc, label(h)).toBe(0)
      })

      it('fail-open hooks pass a present script\'s status, argv and stdout through (0, 1 and an intentional 2)', () => {
        for (const code of [0, 1, 2]) {
          const proj = project()
          for (const h of failOpen) stub(proj, scriptOf(h.command), code)
          for (const h of failOpen) {
            const r = run(shell, h.command, proj)
            const args = h.command.match(/\.(?:py|sh)" ((?:--?[a-z-]+ ?)+);/)?.[1]?.trim() ?? ''
            expect({ rc: r.rc, stdout: r.stdout }, label(h)).toEqual({ rc: code, stdout: `args=${args} stdin={"x":1}` })
          }
        }
      })

      it('fleet-freeze-gate: missing script blocks only while frozen; a present script decides', () => {
        const h = handlers.find(isFreezeGate)!
        const proj = project()
        expect(run(shell, h.command, proj).rc).toBe(0)
        writeFileSync(join(proj, 'store', 'fleet-freeze.json'), '{}')
        const frozen = run(shell, h.command, proj)
        expect(frozen.rc).toBe(2)
        expect(frozen.stderr).toContain('fail-closed while frozen')
        // With the real gate in place it is the gate that answers (frozen -> 2, unfrozen -> 0).
        writeFileSync(join(proj, 'scripts', 'hooks', 'fleet-freeze-gate.sh'),
          readFileSync(join(ROOT, 'scripts', 'hooks', 'fleet-freeze-gate.sh'), 'utf-8'))
        const real = run(shell, h.command, proj)
        expect(real.rc).toBe(2)
        expect(real.stderr).toContain('KILLSWITCH1022')
        rmSync(join(proj, 'store', 'fleet-freeze.json'))
        expect(run(shell, h.command, proj).rc).toBe(0)
      })
    })
  }
})

// Kevin 13549 B1 (AC: the guard on the main agent is FAIL-OPEN). Since C3-5b (plan-c3-5.md 3c item 5) it has the
// one open spelling, failOpenExec: a missing script gives rc 0; a missing node (127), a crash (1) or an exit other
// than 0/2 is a non-blocking error; a hang is ended by Claude Code's own hook timeout (10 s). Only exit 2 blocks, so
// the Bash call still runs. Claude Code docs (code.claude.com/docs/en/hooks, Kevin 14080): "On most events, when a
// hook fails or times out, Claude Code still carries out the action."
describe('child-claude-channel-guard on the main agent: fail-open (C1 PR 13a B1)', () => {
  const guard = handlers.find((h) => scriptOf(h.command) === CHILD_GUARD)!
  const writeGuard = (proj: string, body: string) => writeFileSync(join(proj, 'scripts', 'hooks', CHILD_GUARD), body)

  it('is wired once, PreToolUse on Bash, without the fail-closed wrapper', () => {
    expect(handlers.filter((h) => scriptOf(h.command) === CHILD_GUARD)).toHaveLength(1)
    expect({ event: guard.event, matcher: guard.matcher }).toEqual({ event: 'PreToolUse', matcher: 'Bash' })
    expect(isSecurityGate(guard)).toBe(false)
  })

  for (const shell of SHELLS) {
    describe(shell, () => {
      it.each([
        ['the script is missing', null, 0],
        ['the script crashes', `throw new Error('boom')\n`, 1],
        ['the script exits 3', `process.exit(3)\n`, 3],
        ['the script is not valid JavaScript', `this is not javascript (\n`, 1],
      ])('never 2 when %s (rc %i)', (_name, body, rc) => {
        const proj = project()
        if (body !== null) writeGuard(proj, body)
        expect(run(shell, guard.command, proj).rc).toBe(rc)
      })

      it('rc 127, never 2, when node is not on PATH (a non-blocking error)', () => {
        const proj = project()
        writeGuard(proj, `process.exit(2)\n`)
        const bin = mkdtempSync(join(tmp, 'bin-'))
        for (const tool of ['bash', 'timeout']) {
          const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).stdout.trim()
          symlinkSync(found, join(bin, tool))
        }
        const r = spawnSync(shell, ['-c', guard.command], {
          input: '{"x":1}', cwd: proj, encoding: 'utf-8', timeout: 30_000,
          env: { PATH: bin, HOME: proj, CLAUDE_PROJECT_DIR: proj },
        })
        expect(r.status).toBe(127)
      })
    })
  }

  it('a hang is ended by Claude Code\'s own 10 s hook timeout: no timeout prefix of its own, registered with 10', () => {
    const entry = settings.hooks.PreToolUse.flatMap((g) => g.hooks).find((h) => h.command.includes(CHILD_GUARD)) as { command: string; timeout?: number }
    expect(entry.timeout).toBe(10)
    expect(entry.command).not.toMatch(/\btimeout\b/)
  })

  it('a deny decision on stdout still reaches Claude Code (the guard blocks through stdout, exit 0)', () => {
    const proj = project()
    const deny = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}'
    writeGuard(proj, `process.stdout.write(${JSON.stringify(deny)})\n`)
    expect(run('/bin/sh', guard.command, proj)).toMatchObject({ rc: 0, stdout: deny })
  })
})

// Owner decision 3 (Roland, 2026-11-08): the kill switch is closed while frozen on the sub-agents too. The sub
// command is the manifest's own render for a project root (absolute, burnt in), run as Claude Code runs it.
describe('fleet-freeze-gate on a sub-agent: closed while frozen, like the main agent (owner decision 3)', () => {
  const subGate = (root: string): string => {
    const hooks = renderHooks(HOOK_MANIFEST, 'sub', { root, nodeBin: process.execPath, profile: {}, agent: {}, prompts: { precompact: 'x' } })
    const h = hooks.PreToolUse!.flatMap((g) => g.hooks).find((x) => x.type === 'command' && x.command.includes('fleet-freeze-gate.sh'))
    if (h?.type !== 'command') throw new Error('no sub fleet-freeze-gate')
    return h.command
  }
  const freeze = (proj: string) => writeFileSync(join(proj, 'store', 'fleet-freeze.json'), '{}')
  const realGate = (proj: string) => writeFileSync(join(proj, 'scripts', 'hooks', 'fleet-freeze-gate.sh'),
    readFileSync(join(ROOT, 'scripts', 'hooks', 'fleet-freeze-gate.sh'), 'utf-8'))

  it('renders the closed-while-frozen spelling with the project root burnt in', () => {
    const proj = project()
    const cmd = subGate(proj)
    expect(cmd).toContain(`[ -e "${proj}/store/fleet-freeze.json" ] && { echo "fleet-freeze-gate (fail-closed while frozen)`)
    expect(cmd).not.toContain('$CLAUDE_PROJECT_DIR')
  })

  for (const shell of SHELLS) {
    describe(shell, () => {
      it('frozen, the gate script missing: rc 2, and the message names the cause and the fix', () => {
        const proj = project()
        freeze(proj)
        const r = run(shell, subGate(proj), proj)
        expect(r.rc).toBe(2)
        expect(r.stderr).toContain('fail-closed while frozen')
        expect(r.stderr).toContain('missing or failed (rc=missing)')
        expect(r.stderr).toContain('or unfreeze from the dashboard')
      })

      it('not frozen, the gate script missing: rc 0 (a broken gate never stops the fleet)', () => {
        const proj = project()
        expect(run(shell, subGate(proj), proj).rc).toBe(0)
      })

      it('frozen, the gate script present: the gate itself denies (rc 2)', () => {
        const proj = project()
        realGate(proj)
        freeze(proj)
        const r = run(shell, subGate(proj), proj)
        expect(r.rc).toBe(2)
        expect(r.stderr).toContain('KILLSWITCH1022')
      })

      it('not frozen, the gate script present: rc 0', () => {
        const proj = project()
        realGate(proj)
        expect(run(shell, subGate(proj), proj).rc).toBe(0)
      })

      it('an unreadable flag file counts as frozen: with the gate script missing, rc 2', () => {
        const proj = project()
        freeze(proj)
        chmodSync(join(proj, 'store', 'fleet-freeze.json'), 0o000)
        expect(run(shell, subGate(proj), proj).rc).toBe(2)
      })
    })
  }

  it('the main agent\'s spelling is the same wrapper, only the root differs ($CLAUDE_PROJECT_DIR)', () => {
    const main = handlers.find(isFreezeGate)!.command
    expect(subGate('/srv/m').replaceAll('/srv/m', '$CLAUDE_PROJECT_DIR')).toBe(main)
  })
})

// Johnny 14265 (Ron 14259): while frozen, ANY gate failure blocks, not only a missing script; unfrozen, every case
// keeps today's outcome. One spelling, so the matrix runs on all three renders: the main agent's tracked file, a
// sub-agent's render and the dashboard worker's hook (fleetFreezeGateHook, the worker's own settings).
describe('the kill switch while frozen: any gate failure blocks, unfrozen as before (Johnny 14265)', () => {
  type State = 'missing' | 'gate' | 'exit1' | 'garbage' | 'unreadable' | 'empty' | 'shebang' | 'hang'
  // empty / shebang: a half-written gate exits 0, which while frozen means it did not deny (Ron 14290).
  const STATES: State[] = ['missing', 'gate', 'exit1', 'garbage', 'unreadable', 'empty', 'shebang', 'hang']
  const GATE = join(ROOT, 'scripts', 'hooks', 'fleet-freeze-gate.sh')
  const isRoot = process.getuid?.() === 0
  // The pre-14265 spelling (owner decision 3, exec, a missing script only): "today" for the unfrozen comparison.
  const oldFrozen = (root: string) => `bash -c '[ -f "${root}/scripts/hooks/fleet-freeze-gate.sh" ] && exec bash "${root}/scripts/hooks/fleet-freeze-gate.sh"; `
    + `[ -e "${root}/store/fleet-freeze.json" ] && { echo "old" >&2; exit 2; }; exit 0'`
  const subRender = (root: string): string => {
    const h = renderHooks(HOOK_MANIFEST, 'sub', { root, nodeBin: process.execPath, profile: {}, agent: {}, prompts: { precompact: 'x' } })
      .PreToolUse!.flatMap((g) => g.hooks).find((x) => x.type === 'command' && x.command.includes('fleet-freeze-gate.sh'))
    if (h?.type !== 'command') throw new Error('no sub fleet-freeze-gate')
    return h.command
  }
  const workerHook = (root: string): string => { const h = fleetFreezeGateHook(root); if (h.type !== 'command') throw new Error('agent hook'); return h.command }
  const RENDERS: Array<[string, (root: string) => string]> = [
    ['main', () => handlers.find(isFreezeGate)!.command],
    ['sub', subRender],
    ['worker', workerHook],
  ]
  // As root a mode-000 file is still readable, so the hook runs as nobody there (setpriv); the project is opened up
  // for that user, and the readable states are the positive control that it reaches the files.
  const proj = (): string => {
    const p = project()
    if (isRoot) for (const d of [tmp, p, join(p, 'scripts'), join(p, 'scripts', 'hooks'), join(p, 'store')]) chmodSync(d, 0o755)
    return p
  }
  const BODY: Record<Exclude<State, 'missing'>, string | (() => string)> = {
    gate: () => readFileSync(GATE, 'utf-8'), exit1: '#!/bin/bash\necho broken >&2\nexit 1\n', garbage: '\x7fELF\x00\x00\x00\x01\x02',
    unreadable: '#!/bin/bash\nexit 0\n', empty: '', shebang: '#!/bin/bash\n', hang: '#!/bin/bash\nsleep 10\n',
  }
  const setState = (p: string, st: State) => {
    const f = join(p, 'scripts', 'hooks', 'fleet-freeze-gate.sh')
    rmSync(f, { force: true })
    if (st === 'missing') return
    const b = BODY[st]
    // The mode is set with chmod, not writeFileSync's mode option: that one is masked by the umask (077 -> 0700),
    // and the setpriv user could then not run a gate meant to be runnable.
    writeFileSync(f, typeof b === 'function' ? b() : b)
    chmodSync(f, st === 'unreadable' ? 0o000 : 0o755)
  }
  const setFrozen = (p: string, on: boolean) => {
    const f = join(p, 'store', 'fleet-freeze.json')
    if (on) { writeFileSync(f, '{}'); chmodSync(f, 0o644) } else rmSync(f, { force: true })
  }
  const hookRun = (shell: string, command: string, p: string, path = process.env.PATH ?? '/usr/bin:/bin') => {
    const env = { PATH: path, HOME: p, CLAUDE_PROJECT_DIR: p }
    const [cmd, args]: [string, string[]] = isRoot
      ? ['/usr/bin/setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', shell, '-c', command]]
      : [shell, ['-c', command]]
    const r = spawnSync(cmd, args, { input: '{"tool_name":"Bash"}', cwd: p, encoding: 'utf-8', timeout: 30_000, env })
    return { rc: r.status, stderr: r.stderr }
  }
  // Unfrozen, today: missing 0, the gate 0, exit 1 -> 1, garbage 126, unreadable 126; a hang ran into Claude Code's
  // own 5 s timeout (non-blocking); now the inner deadline ends it first with 124, non-blocking too.
  const UNFROZEN: Record<State, number> = { missing: 0, gate: 0, exit1: 1, garbage: 126, unreadable: 126, empty: 0, shebang: 0, hang: 124 }

  for (const [name, render] of RENDERS) {
    for (const shell of SHELLS) {
      it(`${name}, ${shell}: frozen, every state blocks (rc 2); unfrozen, today's outcome`, () => {
        const p = proj()
        const cmd = render(p)
        const rows: string[] = []
        for (const st of STATES) {
          setState(p, st)
          setFrozen(p, true)
          const t0 = Date.now()
          const f = hookRun(shell, cmd, p)
          // The gate's own deny (2) passes through as it is: its message only, no wrapper reason next to it.
          const reason = st === 'gate' ? f.stderr.includes('KILLSWITCH1022') && !f.stderr.includes('missing or failed') : f.stderr.includes(st === 'missing' ? 'missing or failed (rc=missing)' : 'missing or failed (rc=')
          rows.push(`${st} frozen rc=${f.rc} reason=${reason}${st === 'hang' ? ` fast=${Date.now() - t0 < 6000}` : ''}`)
          setFrozen(p, false)
          const u = hookRun(shell, cmd, p)
          rows.push(`${st} unfrozen rc=${u.rc}`)
          if (st !== 'hang') expect(u.rc, `${st}: unfrozen equals the old spelling`).toBe(hookRun(shell, oldFrozen(p), p).rc)
        }
        expect(rows).toEqual(STATES.flatMap((st) => [`${st} frozen rc=2 reason=true${st === 'hang' ? ' fast=true' : ''}`, `${st} unfrozen rc=${UNFROZEN[st]}`]))
      }, 60_000)
    }
  }

  // No `timeout` on PATH: the fallback runs the gate without an inner deadline; every failure that ends still blocks
  // while frozen (a hang then falls to Claude Code's own timeout, which does not block).
  it('without timeout on PATH: frozen, every ending failure blocks; unfrozen, today\'s outcome', () => {
    const bin = mkdtempSync(join(tmp, 'bin-'))
    for (const tool of ['bash', 'dirname']) symlinkSync(spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).stdout.trim(), join(bin, tool))
    if (isRoot) chmodSync(bin, 0o755)
    expect(spawnSync('/bin/sh', ['-c', 'command -v timeout'], { env: { PATH: bin } }).status).not.toBe(0)
    const rows: string[] = []
    for (const [name, render] of RENDERS) {
      for (const shell of SHELLS) {
        const p = proj()
        const cmd = render(p)
        for (const st of STATES.filter((x) => x !== 'hang')) {
          setState(p, st)
          setFrozen(p, true)
          rows.push(`${name} ${shell} ${st} frozen rc=${hookRun(shell, cmd, p, bin).rc}`)
          setFrozen(p, false)
          rows.push(`${name} ${shell} ${st} unfrozen rc=${hookRun(shell, cmd, p, bin).rc}`)
        }
      }
    }
    expect(rows).toEqual(RENDERS.flatMap(([name]) => SHELLS.flatMap((shell) => STATES.filter((x) => x !== 'hang')
      .flatMap((st) => [`${name} ${shell} ${st} frozen rc=2`, `${name} ${shell} ${st} unfrozen rc=${UNFROZEN[st]}`]))))
  }, 60_000)

  it('the reason names only the gate script and the flag file, no command text', () => {
    const cmd = workerHook('/srv/m')
    const reason = /echo "([^"]*)" >&2; exit 2/.exec(cmd)![1]
    expect(reason).not.toContain('/srv/m')
    expect(reason.match(/[\w.-]+\/[\w./-]+/g)).toEqual(['store/fleet-freeze.json', 'scripts/hooks/fleet-freeze-gate.sh'])
  })
})
