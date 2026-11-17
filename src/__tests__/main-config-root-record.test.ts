// The main agent's config-root record (fork deploy-gate plan v3 addendum A1-1, Ron 17165 C2 and C3).
// scripts/write-main-config-root.sh runs INSIDE the pane command each launcher hands tmux, right before
// claude: channels.sh, channel-watchdog.sh, stuck-modal-guard.sh. A pane that starts writes the root it
// exported; a spawn that fails never runs it, so the old record stays; a refused argument or a failed
// write leaves NO record (never a stale one). The writer validates with the reader's own rule and builds
// the JSON with JSON.stringify.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { readConfigRootRecord, writeConfigRootRecord, RECORD_REL, RECORD_WRITERS } from '../../scripts/hooks/agent-identity.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, copyFileSync, readdirSync, realpathSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// The variables each launcher's RECORD_ENV block reads (channels.sh and channel-watchdog.sh keep their own _rec_*
// copies, because the _cfg_* working variables are unset before the block runs: Ron's code review REL-1).
const LAUNCHERS = [
  { file: 'channels.sh', nodeVar: '_rec_node', modeVar: '_rec_mode', dirVar: '_rec_dir' },
  { file: 'channel-watchdog.sh', nodeVar: 'NODE_BIN', modeVar: '_rec_mode', dirVar: '_rec_dir' },
  { file: 'stuck-modal-guard.sh', nodeVar: 'NODE_BIN', modeVar: '_cfg_mode', dirVar: '_cfg_dir' },
] as const

let base: string
let inst: string
let home: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-root-record-')))
  inst = join(base, 'inst')
  home = join(base, 'home')
  mkdirSync(join(inst, 'scripts', 'hooks'), { recursive: true })
  mkdirSync(join(inst, 'store'), { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  copyFileSync(join(REPO, 'scripts', 'write-main-config-root.sh'), join(inst, 'scripts', 'write-main-config-root.sh'))
  chmodSync(join(inst, 'scripts', 'write-main-config-root.sh'), 0o755)
  copyFileSync(join(REPO, 'scripts', 'hooks', 'agent-identity.mjs'), join(inst, 'scripts', 'hooks', 'agent-identity.mjs'))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

const recordPath = () => join(inst, RECORD_REL)
const plantOld = () => writeFileSync(recordPath(), JSON.stringify({ mode: 'isolated', dir: '/old/root', writer: 'channels.sh' }))
const writerSh = (...args: string[]) =>
  spawnSync('sh', [join(inst, 'scripts', 'write-main-config-root.sh'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home } })

describe('the writer (C3): validated arguments, safe JSON, no record on refusal', () => {
  it('writes each launcher mode with its dir and writer, read back by the gate rule', () => {
    for (const mode of ['explicit', 'rotated', 'isolated', 'token', 'shared']) {
      const r = writerSh(mode, `/srv/${mode} root/ü$x`, 'channel-watchdog.sh')
      expect({ mode, status: r.status, stderr: r.stderr }).toEqual({ mode, status: 0, stderr: '' })
      expect(readConfigRootRecord(inst)).toEqual({ mode, dir: `/srv/${mode} root/ü$x`, writer: 'channel-watchdog.sh' })
    }
  })

  it.each([
    ['a quote', '/a"b'],
    ['a single quote', "/a'b"],
    ['a backslash', '/a\\b'],
    ['a newline', '/a\nb'],
    ['a relative dir', 'a/b'],
    ['a dot-dot', '/a/../b'],
    ['an empty dir', ''],
    ['a JSON-breaking dir', '/x","mode":"explicit'],
  ])('refuses %s and leaves NO record, not the old one', (_label, dir) => {
    plantOld()
    const r = writerSh('isolated', dir, 'channels.sh')
    expect(r.status).toBe(1)
    expect(existsSync(recordPath())).toBe(false)
    expect(readFileSync(join(inst, 'store', 'channels-failures.log'), 'utf8')).toContain('NO record (refused dir')
  })

  it('refuses an unknown mode or writer the same way', () => {
    for (const args of [['whatever', '/a', 'channels.sh'], ['isolated', '/a', 'rogue.sh'], ['isolated', '/a', '']]) {
      plantOld()
      expect(writerSh(...args).status).toBe(1)
      expect(existsSync(recordPath())).toBe(false)
    }
    expect(RECORD_WRITERS).toEqual(LAUNCHERS.map((l) => l.file))
  })

  it('without a node binary still removes the old record and says why', () => {
    plantOld()
    const r = writerSh('isolated', '/a', 'channels.sh', join(base, 'no-such-node'))
    expect(r.status).not.toBe(0)
    expect(existsSync(recordPath())).toBe(false)
  })

  it('leaves no temp file behind and writes the record 0600', () => {
    writeConfigRootRecord(inst, 'token', '/srv/t', 'stuck-modal-guard.sh', Date.UTC(2026, 10, 17))
    expect(readdirSync(join(inst, 'store')).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(JSON.parse(readFileSync(recordPath(), 'utf8'))).toEqual({ mode: 'token', dir: '/srv/t', writer: 'stuck-modal-guard.sh', ts: '2026-11-17T00:00:00.000Z' })
    expect(spawnSync('stat', ['-c', '%a', recordPath()], { encoding: 'utf8' }).stdout.trim()).toBe('600')
  })
})

// The launchers' own quoting helper, taken from the guard's source rather than retyped here.
const SH_SINGLE_QUOTE = readFileSync(join(REPO, 'scripts', 'stuck-modal-guard.sh'), 'utf8').split('\n').find((line) => line.startsWith('sh_single_quote() {')) as string

/** The RECORD_ENV block of a launcher, cut from the real script: from its marker comment to the closing fi. */
function recordBlock(file: string): string {
  const src = readFileSync(join(REPO, 'scripts', file), 'utf8')
  const start = src.indexOf('# DEPLOYGATE A1-1')
  expect(start).toBeGreaterThan(0)
  const closer = file === 'stuck-modal-guard.sh' ? '\n  fi\n' : '\nfi\n'
  const end = src.indexOf(closer, start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end + closer.length)
}

/**
 * Build RECORD_ENV with a launcher's own block, then hand "<RECORD_ENV>echo started" to a spawn stub:
 * ok=true runs it in a fresh sh (the pane starts), ok=false returns 1 without running it (respawn-pane FAILED).
 */
function spawnWithBlock(l: (typeof LAUNCHERS)[number], vars: { cfgEnv: string; mode?: string; dir?: string }, ok: boolean) {
  const script = [
    SH_SINGLE_QUOTE,
    `INSTALL_DIR=${JSON.stringify(inst)}`,
    `${l.nodeVar}=${JSON.stringify(process.execPath)}`,
    `CFG_ENV=${JSON.stringify(vars.cfgEnv)}`,
    `${l.modeVar}=${JSON.stringify(vars.mode ?? '')}`,
    `${l.dirVar}=${JSON.stringify(vars.dir ?? '')}`,
    l.file === 'stuck-modal-guard.sh' ? `f() {\n${recordBlock(l.file)}\nprintf '%s' "$RECORD_ENV"\n}; f` : `${recordBlock(l.file)}\nprintf '%s' "$RECORD_ENV"`,
  ].join('\n')
  const built = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  expect(built.status).toBe(0)
  const paneCmd = `${built.stdout}echo started`
  if (!ok) return { started: false, paneCmd }
  const run = spawnSync('sh', ['-c', paneCmd], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home } })
  return { started: run.stdout.trim() === 'started', paneCmd }
}

describe('each launcher writes the record from inside the pane it starts (C2)', () => {
  for (const l of LAUNCHERS) {
    describe(l.file, () => {
      it('a started pane records the exported mode and dir', () => {
        plantOld()
        const r = spawnWithBlock(l, { cfgEnv: 'export CLAUDE_CONFIG_DIR=x && ', mode: 'rotated', dir: '/srv/rot cfg' }, true)
        expect(r.started).toBe(true)
        expect(readConfigRootRecord(inst)).toEqual({ mode: 'rotated', dir: '/srv/rot cfg', writer: l.file })
      })

      it('nothing exported (no CFG_ENV) records the shared ~/.claude of the pane', () => {
        const r = spawnWithBlock(l, { cfgEnv: '' }, true)
        expect(r.started).toBe(true)
        expect(readConfigRootRecord(inst)).toEqual({ mode: 'shared', dir: join(home, '.claude'), writer: l.file })
      })

      it('a respawn after a mode change records the new root', () => {
        spawnWithBlock(l, { cfgEnv: 'x && ', mode: 'isolated', dir: '/srv/iso' }, true)
        expect(readConfigRootRecord(inst)?.dir).toBe('/srv/iso')
        spawnWithBlock(l, { cfgEnv: 'x && ', mode: 'token', dir: '/srv/tok' }, true)
        expect(readConfigRootRecord(inst)).toEqual({ mode: 'token', dir: '/srv/tok', writer: l.file })
      })

      it('a failed spawn leaves the old record untouched', () => {
        plantOld()
        const before = readFileSync(recordPath(), 'utf8')
        const r = spawnWithBlock(l, { cfgEnv: 'x && ', mode: 'token', dir: '/srv/tok' }, false)
        expect(r.started).toBe(false)
        expect(readFileSync(recordPath(), 'utf8')).toBe(before)
      })

      it('a refused dir still starts the pane, with no record', () => {
        plantOld()
        const r = spawnWithBlock(l, { cfgEnv: 'x && ', mode: 'isolated', dir: '/bad"dir' }, true)
        expect(r.started).toBe(true)
        expect(existsSync(recordPath())).toBe(false)
      })

      it('the pane command that reaches claude carries ${RECORD_ENV}, before claude', () => {
        const src = readFileSync(join(REPO, 'scripts', l.file), 'utf8')
        const launches = src.split('\n').filter((line) => /\$\{CFG_ENV\}/.test(line) && /\$CLAUDE/.test(line))
        expect(launches.length).toBeGreaterThan(0)
        for (const line of launches) {
          expect(line).toContain('${RECORD_ENV}')
          expect(line.indexOf('${RECORD_ENV}')).toBeLessThan(line.indexOf('$CLAUDE'))
        }
      })
    })
  }
})

// Ron's code review REL-1: the block above is fed by the test, so it could not see that the launcher itself had
// unset the mode and dir before the block ran. Here each launcher's REAL configuration section runs first (from its
// `CFG_ENV=""` to the end of the section, unsets included) with a stubbed main-agent-isolated-config.mjs, then the
// real block, then the pane command: the record must name the mode and dir that section exported.
const SECTION_END: Record<string, string> = {
  'channels.sh': '\nunset _node_bin\n',
  'channel-watchdog.sh': '\n  unset _cfg_raw _cfg_line _cfg_mode _cfg_rest _cfg_dir _cfg_token_secret\nfi\n',
}
function configSection(file: string): string {
  const src = readFileSync(join(REPO, 'scripts', file), 'utf8')
  const start = src.indexOf('\nCFG_ENV=""\n')
  const endMark = SECTION_END[file]
  const end = src.indexOf(endMark, start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end + endMark.length)
}
function launchThroughSection(file: string, cfgLine: string) {
  const stubDir = join(base, 'stub-bin')
  mkdirSync(stubDir, { recursive: true })
  // node: answers the config helper on fd 3 (the launchers read its contract line there), stays silent for the
  // custom-provider helper, and runs the real node for everything else (the record writer).
  writeFileSync(join(stubDir, 'node'), [
    '#!/bin/sh',
    'case "$1" in',
    '  *main-agent-isolated-config.mjs) printf \'%s\\n\' "$STUB_CFG_LINE" >&3; exit 0 ;;',
    '  *main-agent-custom-provider.mjs) exit 0 ;;',
    'esac',
    `exec ${JSON.stringify(process.execPath)} "$@"`,
  ].join('\n') + '\n')
  chmodSync(join(stubDir, 'node'), 0o755)
  writeFileSync(join(stubDir, 'curl'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(stubDir, 'curl'), 0o755)
  mkdirSync(join(inst, 'dist', 'web'), { recursive: true })
  writeFileSync(join(inst, 'dist', 'web', 'agent-process.js'), '')
  const script = [
    SH_SINGLE_QUOTE,
    'log() { :; }',
    `INSTALL_DIR=${JSON.stringify(inst)}`,
    `STORE=${JSON.stringify(join(inst, 'store'))}`,
    'CHANNEL_PROVIDER=telegram',
    `NODE_BIN=${JSON.stringify(join(stubDir, 'node'))}`,
    configSection(file),
    recordBlock(file),
    'printf \'%s\' "$CFG_ENV" >&2',
    'printf \'%s\' "$RECORD_ENV"',
  ].join('\n')
  const env = { PATH: `${stubDir}:/usr/bin:/bin`, HOME: home, STUB_CFG_LINE: cfgLine }
  const built = spawnSync('bash', ['-c', script], { encoding: 'utf8', env })
  expect(built.status, built.stderr).toBe(0)
  const run = spawnSync('sh', ['-c', `${built.stdout}echo started`], { encoding: 'utf8', env })
  return { started: run.stdout.trim() === 'started', paneCmd: built.stdout, cfgEnv: built.stderr }
}

describe('the launcher\'s own configuration section feeds the record (REL-1)', () => {
  for (const file of Object.keys(SECTION_END)) {
    describe(file, () => {
      for (const mode of ['explicit', 'rotated', 'isolated', 'token'] as const) {
        it(`${mode}: the record names the mode and dir the section exported`, () => {
          plantOld()
          const dir = join(base, `cfg ${mode}`)
          mkdirSync(dir, { recursive: true })
          const line = mode === 'token' ? `token\t${dir}\tfleet-secret-name` : `${mode}\t${dir}`
          const r = launchThroughSection(file, line)
          expect(r.started).toBe(true)
          expect(r.cfgEnv).toContain('export CLAUDE_CONFIG_DIR=')
          expect(readConfigRootRecord(inst)).toEqual({ mode, dir, writer: file })
        })
      }
      it('no contract line: the shared ~/.claude of the pane', () => {
        plantOld()
        const r = launchThroughSection(file, '')
        expect(r.started).toBe(true)
        expect(readConfigRootRecord(inst)).toEqual({ mode: 'shared', dir: join(home, '.claude'), writer: file })
      })
    })
  }
})

// Ron's code review REL-1, static side: nothing before a launcher's RECORD_ENV block may unset a variable the block
// reads, and the block must read exactly the variables named in LAUNCHERS (so the guard checks the right names).
describe('no launcher unsets what its RECORD_ENV block reads (REL-1 guard)', () => {
  for (const l of LAUNCHERS) {
    it(l.file, () => {
      const src = readFileSync(join(REPO, 'scripts', l.file), 'utf8')
      const block = recordBlock(l.file)
      for (const v of [l.modeVar, l.dirVar]) expect(block).toContain(`$(sh_single_quote "$${v}")`)
      expect(block).toMatch(new RegExp(`\\$\\(sh_single_quote "\\$\\{?${l.nodeVar}[:}"]`))
      const before = src.slice(0, src.indexOf(block))
      const unsets = before
        .split('\n')
        .map((line) => line.replace(/#.*$/, ''))
        .filter((line) => /(^|[;&|{(\s])unset\s/.test(line))
      const reads = [l.modeVar, l.dirVar, l.nodeVar]
      const offending = unsets.filter((line) => reads.some((v) => new RegExp(`\\s${v}(\\s|;|$)`).test(line)))
      expect(offending).toEqual([])
    })
  }
})
