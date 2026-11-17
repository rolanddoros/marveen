// The agent-settings helper's exception in scripts/hooks/db-write-gate.mjs (Fork C settings-protect plan addendum 1
// K2/K5, plan v2 point 6): the deploy helper's rule for scripts/agent-settings/apply-local.mjs. Exactly one spelling
// per mode runs it, as the whole command, from the main agent only; every other command naming it is denied;
// scripts/agent-settings is a protected install path; the staging folder and the state file are not (the main agent
// writes the batch, the helper writes its state). A worktree's own copy stays free to develop in.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, settingsHelperForm, mentionsSettingsHelper, deployHelperForm, SETTINGS_HELPER_GATE_MSG, SETTINGS_HELPER_REL, INSTALL_FILE_GATE_MSG } from '../../scripts/hooks/db-write-gate.mjs'

let base: string
let root: string
let wt: string
let mainRoot: string
let helper: string
const flat = (dir: string) => dir.split('/').join('-')
const mainTranscript = () => join(mainRoot, 'projects', flat(root), 's.jsonl')
const subTranscript = () => join(root, 'agents', 'stuart', '.claude-config', 'projects', flat(join(root, 'agents', 'stuart')), 's.jsonl')

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'settings-helper-gate-')))
  root = join(base, 'Install')
  wt = join(base, 'install-wt')
  mainRoot = join(base, 'main-config')
  for (const d of [root, wt]) {
    mkdirSync(join(d, 'scripts', 'agent-settings'), { recursive: true })
    mkdirSync(join(d, 'scripts', 'hooks'), { recursive: true })
    mkdirSync(join(d, 'store', 'agent-settings-staging'), { recursive: true })
    writeFileSync(join(d, 'scripts', 'agent-settings', 'apply-local.mjs'), '')
  }
  mkdirSync(join(root, 'agents', 'stuart'), { recursive: true })
  mkdirSync(join(mainRoot, 'projects', flat(root)), { recursive: true })
  writeFileSync(join(root, '.env'), 'MAIN_AGENT_ID=johnny\n')
  writeFileSync(join(root, 'store', 'main-agent-config-root.json'), JSON.stringify({ mode: 'explicit', dir: mainRoot, writer: 'channels.sh', ts: '2026-11-17T00:00:00.000Z' }) + '\n')
  helper = join(root, SETTINGS_HELPER_REL)
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const fill = (s: string) => s.replaceAll('@ROOT@', root).replaceAll('@WT@', wt).replaceAll('@H@', helper).replaceAll('@BASE@', base)
const bash = (command: string, transcriptPath: string | null = mainTranscript(), cwd = base) =>
  gateDecision('Bash', { command: fill(command) }, { cwd, root, transcriptPath })

const ALLOWED = [
  'node @H@ request --batch new-agent-2026-11-17',
  'node @H@ baseline --isolated sally',
  'node @H@ baseline --isolated sally,kevin',
  'node @H@ baseline --isolated none',
  'node @H@ rebaseline --agent sally',
  'node @H@ apply --approval 0f3c-9a',
  'node @H@ resume',
  'node @H@ status',
]

describe('the one allowed spelling per mode, from the main agent', () => {
  it.each(ALLOWED)('allows %s', (command) => {
    const v = bash(command)
    expect(v.deny).toBe(false)
    expect(v.settingsHelper).toBe(true)
  })
  it.each(ALLOWED)('denies %s from a sub-agent, with no transcript, or with no MAIN_AGENT_ID', (command) => {
    expect(bash(command, subTranscript())).toMatchObject({ deny: true, reason: 'settings-helper' })
    expect(bash(command, null)).toMatchObject({ deny: true, reason: 'settings-helper' })
    writeFileSync(join(root, '.env'), 'OTHER=1\n')
    expect(bash(command)).toMatchObject({ deny: true, reason: 'settings-helper' })
  })
})

describe('every other spelling that names the helper, the main agent included', () => {
  it.each([
    'node @H@ status ',
    ' node @H@ status',
    'node  @H@ status',
    'node @H@ status; echo done',
    'node @H@ status && true',
    'true && node @H@ status',
    'node @H@ status | cat',
    'node @H@ status > @BASE@/out.txt',
    '(node @H@ status)',
    'env node @H@ status',
    'HOME=/x node @H@ status',
    'nice node @H@ status',
    '/usr/bin/node @H@ status',
    'node "@H@" status',
    'node @ROOT@/scripts/./agent-settings/apply-local.mjs status',
    'node @ROOT@/scripts/agent-settings/../agent-settings/apply-local.mjs status',
    'node @ROOT@/scripts/agent-settings/apply*.mjs status',
    'node $(echo @H@) status',
    'node $R/scripts/agent-settings/apply-local.mjs status',
    'cd @ROOT@ && node scripts/agent-settings/apply-local.mjs status',
    'bash -c "node @H@ status"',
    // the arguments
    'node @H@ request --batch ../x',
    'node @H@ request --batch a/b',
    'node @H@ request --batch a b',
    'node @H@ request',
    'node @H@ baseline',
    'node @H@ baseline --isolated',
    'node @H@ baseline --isolated a,,b',
    'node @H@ baseline --isolated ,a',
    'node @H@ baseline --isolated $X',
    'node @H@ rebaseline --agent ../x',
    'node @H@ rebaseline --agent a --agent b',
    'node @H@ apply --approval x_1',
    `node @H@ apply --approval ${'a'.repeat(65)}`,
    'node @H@ apply --approval x1 --force',
    'node @H@ resume now',
    'node @H@ STATUS',
    'node @H@',
    // reading or touching it in the install
    'cat @H@',
    'ls @ROOT@/scripts/agent-settings',
    'cp @BASE@/x @ROOT@/scripts/agent-settings/apply-local.mjs',
    'rm -f @H@',
  ])('denies %j', (command) => {
    expect(bash(command)).toMatchObject({ deny: true })
  })

  it('a relative name from inside the install and a symlinked spelling are the helper rule', () => {
    expect(bash('node apply-local.mjs status', mainTranscript(), join(root, 'scripts', 'agent-settings'))).toMatchObject({ deny: true, reason: 'settings-helper' })
    symlinkSync(root, join(base, 'link'))
    expect(bash('node @BASE@/link/scripts/agent-settings/apply-local.mjs status')).toMatchObject({ deny: true, reason: 'settings-helper' })
  })

  it('the two helpers do not accept each other\'s arguments', () => {
    expect(settingsHelperForm(`node ${helper} apply --approval x1 --sha ${'a'.repeat(40)}`, root)).toBe(false)
    expect(deployHelperForm(`node ${join(root, 'scripts', 'deploy', 'fork-deploy.mjs')} resume`, root)).toBe(false)
    expect(settingsHelperForm(`node ${join(root, 'scripts', 'deploy', 'fork-deploy.mjs')} status`, root)).toBe(false)
  })

  it('the deny text names every mode and says the identity check is a brake, not a boundary', () => {
    for (const m of ['request --batch <id>', 'baseline --isolated <nevek|none>', 'rebaseline --agent <nev>', 'apply --approval <id>', '"... resume"', '"... status"']) {
      expect(SETTINGS_HELPER_GATE_MSG).toContain(m)
    }
    expect(SETTINGS_HELPER_GATE_MSG).toMatch(/baleset- es injekcio-fek, NEM biztonsagi hatar/)
    expect(SETTINGS_HELPER_GATE_MSG).toContain('store/agent-settings-staging/<id>.json')
  })
})

describe('the protected and the free paths', () => {
  it.each([
    ['Write', '@H@'],
    ['Edit', '@ROOT@/scripts/agent-settings/new.mjs'],
    ['Write', '@ROOT@/store/agent-settings-baseline.json'],
    ['Edit', '@ROOT@/store/agent-settings-baseline.json'],
  ])('%s %s is denied', (tool, path) => {
    expect(gateDecision(tool, { file_path: fill(path), content: '{}' }, { cwd: base, root })).toEqual({ deny: true, reason: 'install-file' })
  })
  it.each([
    'echo {} > @ROOT@/store/agent-settings-baseline.json',
    'cp @BASE@/x @ROOT@/store/agent-settings-baseline.json',
    'python3 -c "open(\'@ROOT@/store/agent-settings-baseline.json\',\'w\')"',
  ])('Bash %j on the baseline is denied', (command) => {
    expect(bash(command)).toMatchObject({ deny: true })
  })
  it('the main agent writes the batch into the staging folder; the helper\'s state file is not a gate path', () => {
    expect(gateDecision('Write', { file_path: join(root, 'store', 'agent-settings-staging', 'b1.json'), content: '{}' }, { cwd: root, root }).deny).toBe(false)
    expect(gateDecision('Write', { file_path: join(root, 'store', 'agent-settings-state.json'), content: '{}' }, { cwd: root, root }).deny).toBe(false)
    expect(bash('cat @ROOT@/store/agent-settings-baseline.json').deny).toBe(false)
  })
  it('the install-file text names the helper folder', () => {
    expect(INSTALL_FILE_GATE_MSG).toContain('scripts/agent-settings/')
  })
})

describe('a worktree copy is free to develop in, for any caller', () => {
  it.each([
    'cd @WT@ && npx vitest run src/__tests__/agent-settings-apply-local.test.ts',
    'git -C @WT@ add scripts/agent-settings/apply-local.mjs',
    'cat @WT@/scripts/agent-settings/apply-local.mjs',
    'node @WT@/scripts/agent-settings/apply-local.mjs status',
  ])('allows %j (sub-agent caller)', (command) => {
    expect(bash(command, subTranscript()).deny).toBe(false)
  })
  it('mentionsSettingsHelper does not fire on a command that does not name it', () => {
    expect(mentionsSettingsHelper('ls -la', { cwd: root, root })).toBe(false)
    expect(mentionsSettingsHelper(`cat ${join(root, 'store', 'agent-settings-staging', 'b1.json')}`, { cwd: base, root })).toBe(false)
  })
})
