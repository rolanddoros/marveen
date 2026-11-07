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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

// The child-claude guard (C1 PR 13a, Kevin 13549 B1) blocks through a deny decision on stdout with exit 0;
// any other failure of its own (crash, non-0/2 exit, timeout) lets Bash run, so it exits 0.
const CHILD_GUARD = 'child-claude-channel-guard.mjs'
const expectedRc = (h: Handler, code: number) => (scriptOf(h.command) === CHILD_GUARD && code !== 2 ? 0 : code)

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
            expect({ rc: r.rc, stdout: r.stdout }, label(h)).toEqual({ rc: expectedRc(h, code), stdout: `args=${args} stdin={"x":1}` })
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

// Kevin 13549 B1 (AC: the guard on the main agent is FAIL-OPEN): a missing script, a missing node, a crash,
// an exit other than 0/2 and a timeout all give rc 0, so the Bash call still runs.
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
        ['the script is missing', null],
        ['the script crashes', `throw new Error('boom')\n`],
        ['the script exits 3', `process.exit(3)\n`],
        ['the script is not valid JavaScript', `this is not javascript (\n`],
      ])('rc 0 when %s', (_name, body) => {
        const proj = project()
        if (body !== null) writeGuard(proj, body)
        expect(run(shell, guard.command, proj).rc).toBe(0)
      })

      it('rc 0 when node is not on PATH', () => {
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
        expect(r.status).toBe(0)
      })
    })
  }

  it('rc 0 when the script hangs past its 8 s limit (inside the 10 s registration)', () => {
    const proj = project()
    writeGuard(proj, `setTimeout(() => {}, 60_000)\n`)
    const started = Date.now()
    expect(run('/bin/sh', guard.command, proj).rc).toBe(0)
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 20_000)

  it('a deny decision on stdout still reaches Claude Code (the guard blocks through stdout, exit 0)', () => {
    const proj = project()
    const deny = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}'
    writeGuard(proj, `process.stdout.write(${JSON.stringify(deny)})\n`)
    expect(run('/bin/sh', guard.command, proj)).toMatchObject({ rc: 0, stdout: deny })
  })
})
