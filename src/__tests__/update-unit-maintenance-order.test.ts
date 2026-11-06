import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// A repair that only runs when there is something to pull is a repair that
// never runs on the machines that need it.
//
// update.sh returns early ("already on the latest commit") long before the
// unit-maintenance block used to sit. Two consequences, both measured on a live
// host on 2026-08-04:
//   - a machine updated 1.28.2 -> 1.29.0 and its channels unit still carried
//     the old Restart=on-failure: the run that PULLS a new repair is still
//     executing the OLD copy of update.sh (bash reads a script incrementally,
//     there is no re-exec), so it runs the old code, which lacks the repair;
//   - re-running update.sh did not help either: with nothing to pull it exits
//     at the up-to-date branch, above the repairs.
// The repair would first have run one whole release later.
//
// The morning-timer repair had the identical defect for weeks before the
// channels migration was placed next to it, which is what makes this a class
// and not a one-off. These tests pin the ordering so it cannot come back.

const ROOT = join(__dirname, '..', '..')
const UPDATE = readFileSync(join(ROOT, 'update.sh'), 'utf-8')

/** Line number (1-based) of the first line matching `re`. */
function lineOf(src: string, re: RegExp): number {
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1
  throw new Error(`no line matches ${re}`)
}

function sliceShellFn(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`)
  if (start < 0) throw new Error(`function ${name}() not found`)
  const end = src.indexOf('\n}', start)
  if (end < 0) throw new Error(`unterminated ${name}()`)
  return src.slice(start, end + 2)
}

function runScript(body: string): { out: string; code: number } {
  const dir = mkdtempSync(join(tmpdir(), 'unitmaint-'))
  try {
    const p = join(dir, 'probe.sh')
    writeFileSync(p, body + '\n')
    try {
      return { out: execFileSync('bash', [p], { encoding: 'utf-8' }).trim(), code: 0 }
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number }
      return { out: `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`.trim(), code: err.status ?? -1 }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const OLD_CHANNELS_UNIT = ['[Service]', 'ExecStart=/root/marveen/scripts/channels.sh', 'Restart=on-failure', 'RestartSec=10', ''].join('\n')
const OLD_MORNING_TIMER = ['[Unit]', 'Description=Marveen Reggeli Napindito Timer', 'Requires=marveen-morning.service', '', '[Timer]', 'OnCalendar=*-*-* 07:27:00', ''].join('\n')

describe('unit maintenance runs before the up-to-date early exit', () => {
  it('the maintenance call precedes the early exit in file order', () => {
    const call = lineOf(UPDATE, /^run_unit_maintenance$/)
    const upToDateBranch = lineOf(UPDATE, /OLD_VERSION" = "\$NEW_VERSION/)
    expect(call).toBeLessThan(upToDateBranch)
  })

  it('no unit repair is left below the early exit', () => {
    const upToDateIdx = UPDATE.indexOf('if [ "$OLD_VERSION" = "$NEW_VERSION" ]')
    const below = UPDATE.slice(upToDateIdx)
    // definitions and calls must all be above; below there may only be the
    // breadcrumb comment that says so.
    expect(below).not.toMatch(/^migrate_channels_restart\b/m)
    expect(below).not.toMatch(/^repair_morning_timer\b/m)
    expect(below).not.toMatch(/^\s*sed -i\.marveen-bak .*-morning\.service/m)
  })

  it('every repair is wired into the single maintenance entry point', () => {
    const wrapper = sliceShellFn(UPDATE, 'run_unit_maintenance')
    expect(wrapper).toMatch(/repair_morning_timer "\$@"/)
    expect(wrapper).toMatch(/migrate_channels_restart "\$@"/)
    expect(wrapper).toMatch(/install_keepalive_probe_timer "\$@"/)
    expect(wrapper).toMatch(/strip_legacy_notifier_telegram_env "\$@"/)
    expect(wrapper).toMatch(/park_morning_timer "\$@"/)
    expect(UPDATE).toMatch(/^run_unit_maintenance$/m)
  })
})

// Only the two oldest repairs run for real here. Every other repair the wrapper calls is
// executed by its own hermetic suite, which slices it out of update.sh the same way:
//   install_keepalive_probe_timer      scripts/__tests__/keepalive-probe-install.test.sh, update-timer-start.test.sh
//   install_keepalive_probe_launchd    scripts/__tests__/keepalive-probe-install.test.sh, src/__tests__/helper-launchd-labels.test.ts
//   install_stuck_modal_guard_launchd  scripts/__tests__/stuck-modal-guard-install.test.sh, src/__tests__/helper-launchd-labels.test.ts
//   install_main_inbox_observer_unit   scripts/__tests__/main-inbox-observer-install.test.sh, update-timer-start.test.sh
//   strip_legacy_notifier_telegram_env scripts/__tests__/notifier-unit-telegram-env.test.sh
//   park_morning_timer                 scripts/__tests__/morning-timer-park.test.sh
//   scrub_rc_secrets                   src/__tests__/update-rc-secret-scrub.test.ts
// (A broken install_keepalive_probe_timer fails keepalive-probe-install.test.sh 9 times, measured
// 2026-11-06, Kevin 12191.) Here they are RECORDING stubs: the probe then proves the wrapper calls
// each of them, in order, with the unit dir, instead of 127-ing past them; and since the wrapper
// returns 0 whatever a repair does, "exit 0" alone proves nothing -- the case below that fails one
// repair is what gives it a meaning.
/** The repairs run_unit_maintenance calls, in its own order, read from update.sh. */
const WRAPPER_CALLS = sliceShellFn(UPDATE, 'run_unit_maintenance').split('\n').slice(1)
  .map((l) => l.match(/^\s+([a-z_]+)(?: "\$@")?$/)?.[1]).filter((n): n is string => !!n)
const REAL = ['repair_morning_timer', 'migrate_channels_restart']

describe('the morning-timer and channels repairs, executed for real; the other repairs recorded', () => {
  const stubs = (failing?: string) => WRAPPER_CALLS.filter((n) => !REAL.includes(n))
    .map((n) => n === failing
      ? `${n}() { echo "CALL ${n} $*"; echo "${n} failed" >&2; return 1; }`
      : `${n}() { echo "CALL ${n} $*"; }`)
    .join('\n')
  // stubs FIRST: a repair sliced for real later in the body overrides its stub
  const body = (failing?: string) => [
    stubs(failing),
    ...REAL.map((n) => sliceShellFn(UPDATE, n)),
    sliceShellFn(UPDATE, 'run_unit_maintenance'),
  ].join('\n')

  function run(dir: string, failing?: string) {
    return runScript(`${body(failing)}\nrun_unit_maintenance "${dir}"`)
  }
  const calls = (out: string) => out.split('\n').filter((l) => l.startsWith('CALL ')).map((l) => l.trimEnd())

  it('the wrapper list is the one this file knows: the two real repairs and the seven recorded ones', () => {
    expect(WRAPPER_CALLS).toEqual([
      'repair_morning_timer', 'migrate_channels_restart', 'install_keepalive_probe_timer',
      'install_keepalive_probe_launchd', 'install_stuck_modal_guard_launchd', 'install_main_inbox_observer_unit',
      'strip_legacy_notifier_telegram_env', 'park_morning_timer', 'scrub_rc_secrets',
    ])
  })

  it('calls every recorded repair once, in the wrapper order, with the unit dir (scrub_rc_secrets without it)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'units-'))
    try {
      const r = run(dir)
      expect(r.code).toBe(0)
      expect(calls(r.out)).toEqual([
        `CALL install_keepalive_probe_timer ${dir}`,
        `CALL install_keepalive_probe_launchd ${dir}`,
        `CALL install_stuck_modal_guard_launchd ${dir}`,
        `CALL install_main_inbox_observer_unit ${dir}`,
        `CALL strip_legacy_notifier_telegram_env ${dir}`,
        `CALL park_morning_timer ${dir}`,
        'CALL scrub_rc_secrets',
      ])
      expect(r.out).not.toContain('command not found')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a failing repair does not stop the rest: the later repairs still run and the wrapper returns 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'units-'))
    try {
      writeFileSync(join(dir, 'marveen-channels.service'), OLD_CHANNELS_UNIT)
      const r = run(dir, 'install_keepalive_probe_timer')
      expect(r.code).toBe(0)
      expect(calls(r.out).map((l) => l.split(' ')[1])).toEqual(WRAPPER_CALLS.filter((n) => !REAL.includes(n)))
      expect(readFileSync(join(dir, 'marveen-channels.service'), 'utf-8')).toMatch(/^Restart=always$/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('repairs BOTH unit kinds in one pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'units-'))
    try {
      writeFileSync(join(dir, 'marveen-channels.service'), OLD_CHANNELS_UNIT)
      writeFileSync(join(dir, 'marveen-morning.timer'), OLD_MORNING_TIMER)
      const r = run(dir)
      expect(r.code).toBe(0)
      expect(readFileSync(join(dir, 'marveen-channels.service'), 'utf-8')).toMatch(/^Restart=always$/m)
      expect(readFileSync(join(dir, 'marveen-morning.timer'), 'utf-8')).not.toMatch(/^Requires=/m)
      // the rest of the timer must survive
      expect(readFileSync(join(dir, 'marveen-morning.timer'), 'utf-8')).toContain('OnCalendar=*-*-* 07:27:00')
      expect(readdirSync(dir).filter((f) => f.includes('marveen-bak'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is idempotent: the second pass changes nothing and says nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'units-'))
    try {
      writeFileSync(join(dir, 'marveen-channels.service'), OLD_CHANNELS_UNIT)
      writeFileSync(join(dir, 'marveen-morning.timer'), OLD_MORNING_TIMER)
      run(dir)
      const after1 = [
        readFileSync(join(dir, 'marveen-channels.service'), 'utf-8'),
        readFileSync(join(dir, 'marveen-morning.timer'), 'utf-8'),
      ]
      const second = run(dir)
      expect(second.code).toBe(0)
      expect(second.out).not.toContain('javitva')
      expect(readFileSync(join(dir, 'marveen-channels.service'), 'utf-8')).toBe(after1[0])
      expect(readFileSync(join(dir, 'marveen-morning.timer'), 'utf-8')).toBe(after1[1])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives a machine with no unit directory at all (macOS)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'units-'))
    try {
      expect(run(join(dir, 'nope')).code).toBe(0)
      expect(run(dir).code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
