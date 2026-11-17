// The code-deploy helper's exception in scripts/hooks/db-write-gate.mjs (plan-v3 7, Ron 17165): exactly one
// spelling runs the helper, as the whole command, from the main agent only (agent-identity.mjs, from the payload's
// transcript_path); every other command naming the helper is denied; scripts/deploy, the main-config-root record and
// its writer are protected install paths. A worktree's own copy stays free to develop in.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, deployHelperForm, mentionsDeployHelper, DEPLOY_HELPER_GATE_MSG, DEPLOY_HELPER_REL, INSTALL_FILE_GATE_MSG } from '../../scripts/hooks/db-write-gate.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK = join(REPO, 'scripts', 'hooks', 'db-write-gate.mjs')
const SHA = 'a'.repeat(40)

let base: string
let root: string // the "install"
let wt: string // a worktree of it
let mainRoot: string // the main agent's config root, as the launcher recorded it
let helper: string
const flat = (dir: string) => dir.split('/').join('-')
const mainTranscript = () => join(mainRoot, 'projects', flat(root), 's.jsonl')
const subTranscript = () => join(root, 'agents', 'stuart', '.claude-config', 'projects', flat(join(root, 'agents', 'stuart')), 's.jsonl')

function record(dir: string): void {
  writeFileSync(join(root, 'store', 'main-agent-config-root.json'), JSON.stringify({ mode: 'explicit', dir, writer: 'channels.sh', ts: '2026-11-17T00:00:00.000Z' }) + '\n')
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-helper-gate-')))
  root = join(base, 'Install')
  wt = join(base, 'install-wt')
  mainRoot = join(base, 'main-config')
  for (const d of [root, wt]) {
    mkdirSync(join(d, 'scripts', 'deploy'), { recursive: true })
    mkdirSync(join(d, 'scripts', 'hooks'), { recursive: true })
    mkdirSync(join(d, 'store'), { recursive: true })
    mkdirSync(join(d, '.claude'), { recursive: true })
    writeFileSync(join(d, 'scripts', 'deploy', 'fork-deploy.mjs'), '')
    writeFileSync(join(d, 'scripts', 'write-main-config-root.sh'), '')
  }
  mkdirSync(join(root, 'agents', 'stuart'), { recursive: true })
  mkdirSync(join(mainRoot, 'projects', flat(root)), { recursive: true })
  writeFileSync(join(root, '.env'), 'MAIN_AGENT_ID=johnny\n')
  record(mainRoot)
  helper = join(root, DEPLOY_HELPER_REL)
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const fill = (s: string) => s.replaceAll('@ROOT@', root).replaceAll('@WT@', wt).replaceAll('@H@', helper).replaceAll('@BASE@', base)
const bash = (command: string, transcriptPath: string | null = mainTranscript(), cwd = base) =>
  gateDecision('Bash', { command: fill(command) }, { cwd, root, transcriptPath })

describe('the one allowed spelling, from the main agent', () => {
  it.each([
    'node @H@ request',
    'node @H@ status',
    `node @H@ apply --approval 0f3c-9a --sha ${SHA}`,
    `node @H@ apply --approval ${'A'.repeat(64)} --sha ${SHA}`,
  ])('allows %s', (command) => {
    const v = bash(command)
    expect(v.deny).toBe(false)
    expect(v.deployHelper).toBe(true)
  })

  it('reads the identity from the install on disk (the .env MAIN_AGENT_ID and the launcher record)', () => {
    expect(bash('node @H@ status').deny).toBe(false)
    writeFileSync(join(root, '.env'), 'OTHER=1\n')
    expect(bash('node @H@ status')).toMatchObject({ deny: true, reason: 'deploy-helper' })
    writeFileSync(join(root, '.env'), 'MAIN_AGENT_ID=johnny\n')
    rmSync(join(root, 'store', 'main-agent-config-root.json'))
    expect(bash('node @H@ status')).toMatchObject({ deny: true, reason: 'deploy-helper' })
    record(join(base, 'another-root'))
    expect(bash('node @H@ status')).toMatchObject({ deny: true, reason: 'deploy-helper' })
  })
})

describe('the exact spelling from anyone but the main agent', () => {
  it.each([
    ['a sub-agent', () => subTranscript()],
    ['a sub-agent on the shared root', () => join(mainRoot, 'projects', flat(join(root, 'agents', 'stuart')), 's.jsonl')],
    ['no transcript_path', () => null],
    ['an empty transcript_path', () => ''],
    ['the -docs sibling segment', () => join(mainRoot, 'projects', flat(root) + '-docs', 's.jsonl')],
    ['a sibling worktree segment', () => join(mainRoot, 'projects', flat(root) + '-c-stuart-wt', 's.jsonl')],
    ['one level deeper', () => join(mainRoot, 'projects', flat(root), 'sub', 's.jsonl')],
    ['the right segment under another config root', () => join(base, 'other-config', 'projects', flat(root), 's.jsonl')],
  ])('denies %s', (_name, transcript) => {
    for (const c of ['node @H@ request', 'node @H@ status', `node @H@ apply --approval x1 --sha ${SHA}`]) {
      expect(bash(c, transcript()), c).toMatchObject({ deny: true, reason: 'deploy-helper' })
    }
  })
})

describe('every other spelling that names the helper, the main agent included', () => {
  it.each([
    // around the one segment
    'node @H@ status ',
    ' node @H@ status',
    'node  @H@ status',
    'node @H@ status\n',
    'node @H@ status; echo done',
    'node @H@ status && true',
    'true && node @H@ status',
    'node @H@ status || true',
    'node @H@ status | cat',
    'node @H@ status > @BASE@/out.txt',
    'node @H@ status 2>&1',
    '(node @H@ status)',
    // before it
    'env node @H@ status',
    'PATH=/usr/bin node @H@ status',
    'GIT_DIR=@BASE@/x node @H@ status',
    'nice node @H@ status',
    'nodejs @H@ status',
    '/usr/bin/node @H@ status',
    // the path spelled otherwise
    'node "@H@" status',
    "node '@H@' status",
    'node @ROOT@/scripts/./deploy/fork-deploy.mjs status',
    'node @ROOT@//scripts/deploy/fork-deploy.mjs status',
    'node @ROOT@/scripts/deploy/../deploy/fork-deploy.mjs status',
    'node @ROOT@/scripts/deploy/fork*.mjs status',
    'node @ROOT@/scripts/dep*/fork-deploy.mjs status',
    'node @ROOT@/scripts/deploy/fork-deploy.{mjs,js} status',
    'node $(echo @H@) status',
    'node `echo @H@` status',
    'node ${R}/scripts/deploy/fork-deploy.mjs status',
    'node $R/fork-deploy.mjs status',
    'cd @ROOT@; node scripts/deploy/fork-deploy.mjs status',
    'cd @ROOT@/scripts && node deploy/fork-deploy.mjs status',
    'cd @ROOT@ && cd scripts && node deploy/fork-deploy.mjs status',
    'cd Install; cd scripts; node deploy/fork-deploy.mjs status',
    'pushd @ROOT@/scripts/deploy && node fork-deploy.mjs status',
    // through another program
    'bash -c "node @H@ status"',
    "sh -c 'node @H@ status'",
    'echo @H@ | xargs -I{} node {} status',
    'find @ROOT@/scripts/deploy -name fork-deploy.mjs -exec node {} status \\;',
    // the arguments
    `node @H@ apply --approval x1 --sha ${'a'.repeat(39)}`,
    `node @H@ apply --approval x1 --sha ${'a'.repeat(41)}`,
    `node @H@ apply --approval x1 --sha ${'A'.repeat(40)}`,
    `node @H@ apply --sha ${SHA} --approval x1`,
    `node @H@ apply --approval ${'a'.repeat(65)} --sha ${SHA}`,
    `node @H@ apply --approval x_1 --sha ${SHA}`,
    `node @H@ apply --approval x1 --sha ${SHA} --force`,
    'node @H@ request extra',
    'node @H@ apply',
    'node @H@',
    'node @H@ STATUS',
    // reading or touching it in the install
    'cat @H@',
    'ls @ROOT@/scripts/deploy',
    'cp @BASE@/x @ROOT@/scripts/deploy/fork-deploy.mjs',
    'rm -f @ROOT@/scripts/deploy/fork-deploy.mjs',
  ])('denies %j', (command) => {
    expect(bash(command)).toMatchObject({ deny: true })
  })

  it('an unresolved expansion followed by the scripts/deploy tail is the helper rule, without the helper name too', () => {
    expect(bash('node $R/scripts/deploy/deploy-git.mjs status')).toMatchObject({ deny: true, reason: 'deploy-helper' })
    expect(bash('cat ${X}/scripts/deploy/gate-paths.json')).toMatchObject({ deny: true, reason: 'deploy-helper' })
  })

  it('denies a relative name from inside the install, and a symlinked spelling', () => {
    expect(bash('node fork-deploy.mjs status', mainTranscript(), join(root, 'scripts', 'deploy'))).toMatchObject({ deny: true, reason: 'deploy-helper' })
    expect(bash('node scripts/deploy/fork-deploy.mjs status', mainTranscript(), root)).toMatchObject({ deny: true, reason: 'deploy-helper' })
    symlinkSync(root, join(base, 'link'))
    expect(bash('node @BASE@/link/scripts/deploy/fork-deploy.mjs status')).toMatchObject({ deny: true, reason: 'deploy-helper' })
    expect(bash('node link/scripts/deploy/fork-deploy.mjs status', mainTranscript(), base)).toMatchObject({ deny: true, reason: 'deploy-helper' })
  })

  it('the deny text says what is allowed and that the identity check is a brake, not a boundary (SEC-2)', () => {
    expect(DEPLOY_HELPER_GATE_MSG).toMatch(/fork-deploy\.mjs request", "\.\.\. status" vagy "\.\.\. apply --approval <id> --sha <40 hex>"/)
    expect(DEPLOY_HELPER_GATE_MSG).toMatch(/baleset- es injekcio-fek, NEM biztonsagi hatar/)
    expect(DEPLOY_HELPER_GATE_MSG).toMatch(/fo ugynokre is/)
  })
})

describe('the protected deploy paths', () => {
  it.each([
    ['Write', '@ROOT@/scripts/deploy/fork-deploy.mjs'],
    ['Edit', '@ROOT@/scripts/deploy/new.mjs'],
    ['Write', '@ROOT@/store/main-agent-config-root.json'],
    ['Edit', '@ROOT@/scripts/write-main-config-root.sh'],
    ['Write', '@BASE@/link-later/../Install/store/main-agent-config-root.json'],
  ])('%s %s is denied', (tool, path) => {
    expect(gateDecision(tool, { file_path: fill(path), content: '{}' }, { cwd: base, root })).toEqual({ deny: true, reason: 'install-file' })
  })

  it.each([
    'echo {} > @ROOT@/store/main-agent-config-root.json',
    'tee @ROOT@/store/main-agent-config-root.json < @BASE@/x',
    'cp @BASE@/x @ROOT@/store/main-agent-config-root.json',
    'sed -i s/a/b/ @ROOT@/scripts/write-main-config-root.sh',
    'mv @BASE@/x @ROOT@/scripts/write-main-config-root.sh',
    'cp -r @BASE@/x @ROOT@/scripts/deploy',
  ])('Bash %j is denied', (command) => {
    expect(bash(command)).toMatchObject({ deny: true })
  })

  it('the record and its writer stay readable', () => {
    expect(bash('cat @ROOT@/store/main-agent-config-root.json').deny).toBe(false)
    expect(bash('jq . @ROOT@/store/main-agent-config-root.json').deny).toBe(false)
    expect(bash('cat @ROOT@/scripts/write-main-config-root.sh').deny).toBe(false)
  })

  it('the install-file text names the new paths', () => {
    expect(INSTALL_FILE_GATE_MSG).toContain('scripts/deploy/, scripts/write-main-config-root.sh, store/main-agent-config-root.json')
  })
})

describe('a worktree copy is free to develop in, for any caller', () => {
  it.each([
    'cd @WT@ && npx vitest run src/__tests__/fork-deploy.test.ts',
    'git -C @WT@ add scripts/deploy/fork-deploy.mjs',
    'cat @WT@/scripts/deploy/fork-deploy.mjs',
    'node @WT@/scripts/deploy/fork-deploy.mjs status',
    'cp @BASE@/x @WT@/scripts/deploy/fork-deploy.mjs',
    'grep -n apply @WT@/scripts/deploy/fork-deploy.mjs',
    'ls @ROOT@/scripts',
  ])('allows %j (sub-agent caller)', (command) => {
    expect(bash(command, subTranscript()).deny).toBe(false)
  })

  it('allows a relative name inside the worktree', () => {
    expect(bash('node scripts/deploy/fork-deploy.mjs status', subTranscript(), wt).deny).toBe(false)
    expect(bash('npx vitest run src/__tests__/fork-deploy.test.ts', subTranscript(), wt).deny).toBe(false)
  })

  it('Write to the worktree copy is allowed', () => {
    expect(gateDecision('Write', { file_path: join(wt, 'scripts', 'deploy', 'fork-deploy.mjs'), content: 'x' }, { cwd: wt, root }).deny).toBe(false)
  })
})

describe('the pieces', () => {
  it('deployHelperForm is exact and refuses a root a shell would split', () => {
    expect(deployHelperForm(`node ${helper} status`, root)).toBe(true)
    expect(deployHelperForm(`node ${helper} status`, join(base, 'other'))).toBe(false)
    expect(deployHelperForm('node /a b/scripts/deploy/fork-deploy.mjs status', '/a b')).toBe(false)
    expect(deployHelperForm(`node ${helper} status`, root + '/')).toBe(true)
  })
  it('mentionsDeployHelper does not fire on a command that does not name it', () => {
    expect(mentionsDeployHelper('ls -la', { cwd: root, root })).toBe(false)
    expect(mentionsDeployHelper('git -C @ROOT@ status'.replace('@ROOT@', root), { cwd: base, root })).toBe(false)
  })
  it('the docs carry the exception and the recovery the helper\'s STOP lines point to', () => {
    const doc = readFileSync(join(REPO, 'docs', 'db-write-gate.md'), 'utf-8')
    expect(doc).toMatch(/^## The code deploy \(`code_deploy`\)$/m)
    expect(doc).toMatch(/^### When a deploy stops$/m)
    expect(doc).toContain('not a security boundary')
    expect(doc).toContain('CODE_DEPLOY_OWNER_CHANNEL_ONLY')
    expect(doc).toContain('`scripts/deploy/`, `scripts/write-main-config-root.sh`,')
    expect(readFileSync(join(REPO, 'scripts', 'deploy', 'fork-deploy.mjs'), 'utf-8')).toContain('recovery: docs/db-write-gate.md')
  })
  it('the hook entry hands the transcript_path to the decision worker (pinned in source)', () => {
    expect(readFileSync(HOOK, 'utf-8')).toContain('{ cwd: payload?.cwd, transcriptPath: payload?.transcript_path }')
  })
})
