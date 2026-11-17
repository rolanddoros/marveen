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
const LAUNCHERS = [
  { file: 'channels.sh', nodeVar: '_node_bin' },
  { file: 'channel-watchdog.sh', nodeVar: 'NODE_BIN' },
  { file: 'stuck-modal-guard.sh', nodeVar: 'NODE_BIN' },
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
    `_cfg_mode=${JSON.stringify(vars.mode ?? '')}`,
    `_cfg_dir=${JSON.stringify(vars.dir ?? '')}`,
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
