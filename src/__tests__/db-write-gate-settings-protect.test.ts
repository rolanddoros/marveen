// scripts/hooks/db-write-gate.mjs, the Fork C settings-protect paths (plan v1/v2 point 2, plan v2 point 5, addendum 1
// D2-SEC-1 (a) / D2-SEC-3, Ron 17402 K2, Ron 17451 add-on): what decides a sub-agent's hooks at its next start is
// refused to every agent's tool call, the main agent's too; what the agents keep writing (skills, memory, gh's own
// files) stays allowed. The K2 probes are here with their expected outcome written down.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, installTargets, PROTECTED_PER_AGENT_PATHS, DEPLOY_HELPER_REL } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
let mainRoot: string
const flat = (dir: string) => dir.split('/').join('-')
const mainTranscript = () => join(mainRoot, 'projects', flat(root), 's.jsonl')
const subTranscript = () => join(root, 'agents', 'alpha', '.claude-config', 'projects', flat(join(root, 'agents', 'alpha')), 's.jsonl')
const touch = (rel: string, text = '{}') => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'settings-protect-gate-')))
  root = join(base, 'Install')
  mainRoot = join(base, 'main-config')
  for (const n of ['alpha', 'beta']) {
    for (const p of ['.claude/settings.json', '.claude/settings.local.json', '.claude-config/settings.json', '.config/gh/hosts.yml']) touch(`agents/${n}/${p}`)
    mkdirSync(join(root, 'agents', n, '.claude', 'skills', 's'), { recursive: true })
  }
  for (const rel of ['scripts/watchdog.sh', 'scripts/lib/owner-chat.sh', 'scripts/hooks/sub-hooks.lock.json', 'store/agent-settings-baseline.json',
    'templates/profiles/default.json', 'src/web/agent-process.ts', 'src/web/hooks/manifest.ts', 'dist/web/agent-scaffold.js',
    'dist/web/hooks/manifest.js', 'dist/index.js', DEPLOY_HELPER_REL, 'scripts/update.sh']) touch(rel)
  mkdirSync(join(mainRoot, 'projects', flat(root)), { recursive: true })
  writeFileSync(join(root, '.env'), 'MAIN_AGENT_ID=johnny\n')
  writeFileSync(join(root, 'store', 'main-agent-config-root.json'), JSON.stringify({ mode: 'explicit', dir: mainRoot, writer: 'channels.sh', ts: '2026-11-17T00:00:00.000Z' }) + '\n')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const fill = (s: string) => s.replaceAll('@ROOT@', root)
const bash = (command: string, cwd = root, transcriptPath: string | null = subTranscript()) =>
  gateDecision('Bash', { command: fill(command) }, { cwd, root, transcriptPath })
const file = (tool: string, rel: string, transcriptPath: string | null = subTranscript()) =>
  gateDecision(tool, { file_path: join(root, rel), content: '{}' }, { cwd: root, root, transcriptPath })
const DENY_FILE = { deny: true, reason: 'install-file' }
const ALLOW = { deny: false }

describe('the per-agent list and its enumeration', () => {
  it('the eight exact paths under every agents/<name>/', () => {
    expect([...PROTECTED_PER_AGENT_PATHS]).toEqual(['.claude', '.claude/settings.json', '.claude/settings.local.json',
      '.claude-config', '.claude-config/settings.json', '.claude-config/settings.local.json', '.config', '.config/gh'])
  })
  it('a new agent directory is covered at the next decision, without a restart', () => {
    expect(file('Write', 'agents/gamma/.claude/settings.json')).toEqual(ALLOW)
    mkdirSync(join(root, 'agents', 'gamma'))
    expect(file('Write', 'agents/gamma/.claude/settings.json')).toEqual(DENY_FILE)
    expect(installTargets(root).list.filter((t: { perAgent?: boolean }) => t.perAgent)).toHaveLength(3 * 8)
  })
})

describe('refused: the settings files, by every writing spelling, own agent and another', () => {
  for (const rel of ['agents/alpha/.claude/settings.json', 'agents/alpha/.claude/settings.local.json', 'agents/alpha/.claude-config/settings.json',
    'agents/alpha/.claude-config/settings.local.json', 'agents/beta/.claude/settings.local.json']) {
    it.each(['Write', 'Edit', 'MultiEdit'])(`%s ${rel}`, (tool) => { expect(file(tool, rel)).toEqual(DENY_FILE) })
  }
  it.each<[string, string, string?]>([
    ['a redirect', 'echo {} > @ROOT@/agents/alpha/.claude/settings.json'],
    ['sed -i, relative from the agent\'s cwd', 'sed -i s/a/b/ .claude/settings.local.json', 'agents/alpha'],
    ['tee', 'echo {} | tee agents/alpha/.claude-config/settings.json'],
    ['cp over it', 'cp /tmp/x.json @ROOT@/agents/alpha/.claude/settings.json'],
    ['python', 'python3 -c "open(\'agents/beta/.claude/settings.json\',\'w\').write(\'{}\')"'],
    ['through ..', 'echo {} > agents/alpha/.claude/skills/../settings.json'],
    ['a glob', 'cp /tmp/x agents/*/.claude/settings.json'],
    ['an unresolved variable before the tail', 'echo {} > $D/agents/alpha/.claude/settings.json'],
  ])('%s', (_label, command, cwd) => { expect(bash(command, cwd ? join(root, cwd) : root)).toEqual(DENY_FILE) })
})

describe('refused: the directories themselves (rename, delete, symlink swap), not their contents', () => {
  it.each([
    ['mv .claude', 'mv agents/alpha/.claude agents/alpha/.claude.old'],
    ['rm -r .claude-config', 'rm -r agents/alpha/.claude-config'],
    ['ln over .config/gh', 'ln -sfn /root/.config/gh agents/alpha/.config/gh'],
    ['rm .config', 'rm -rf agents/beta/.config'],
  ])('%s', (_label, command) => { expect(bash(command)).toEqual(DENY_FILE) })
  it.each([
    ['a skill', 'Write', 'agents/alpha/.claude/skills/s/SKILL.md'],
    ['memory', 'Write', 'agents/alpha/.claude-config/projects/p/memory/m.md'],
    ['gh\'s own file', 'Edit', 'agents/alpha/.config/gh/hosts.yml'],
  ])('allowed: %s', (_label, tool, rel) => { expect(file(tool, rel)).toEqual(ALLOW) })
  it.each<[string, string, string?]>([
    ['gh writes its config', 'echo x > agents/alpha/.config/gh/hosts.yml'],
    ['a skill folder removed', 'rm -rf agents/alpha/.claude/skills/s'],
    ['reading the settings', 'cat agents/alpha/.claude/settings.json'],
    ['an archive unpacked inside skills', 'tar xf /tmp/s.tar', 'agents/alpha/.claude/skills'],
  ])('allowed: %s', (_label, command, cwd) => { expect(bash(command, cwd ? join(root, cwd) : root)).toEqual(ALLOW) })
})

describe('plan v2 point 5: the agent-folder operations that are refused now (alternatives in docs/db-write-gate.md)', () => {
  it.each<[string, string, string?]>([
    ['backup tar (agens-torles step 2)', 'tar czf store/agent-backups/alpha-2026-11-17.tar.gz -C agents alpha'],
    ['restore tar (agens-torles step 7)', 'tar xzf store/agent-backups/alpha.tar.gz -C agents'],
    ['an ad hoc copy', 'cp -r agents/alpha /var/backups/alpha'],
    ['a rename', 'mv agents/alpha agents/alpha2'],
    ['a delete', 'rm -rf agents/alpha'],
    ['an archive unpacked in the agent folder', 'tar xf /tmp/x.tar', 'agents/alpha'],
  ])('%s', (_label, command, cwd) => { expect(bash(command, cwd ? join(root, cwd) : root)).toEqual(DENY_FILE) })
})

describe('a symlinked agent directory is enumerated like a real one', () => {
  it('its settings file and .claude directory are refused', () => {
    const real = join(base, 'elsewhere', 'gamma')
    mkdirSync(join(real, '.claude'), { recursive: true })
    writeFileSync(join(real, '.claude', 'settings.json'), '{}')
    symlinkSync(real, join(root, 'agents', 'gamma'))
    expect(file('Write', 'agents/gamma/.claude/settings.json')).toEqual(DENY_FILE)
    expect(bash('rm -rf agents/gamma/.claude')).toEqual(DENY_FILE)
  })
})

describe('Ron 17505 1a: the install-root .env (GATE_WIRING_ENFORCE) is protected, exactly that file', () => {
  it.each(['Write', 'Edit'])('%s .env refused', (tool) => { expect(file(tool, '.env')).toEqual(DENY_FILE) })
  it.each([
    ['append from the root', 'echo GATE_WIRING_ENFORCE=0 >> .env', ''],
    ['sed -i by absolute path', 'sed -i s/=1/=0/ @ROOT@/.env', 'agents/alpha'],
    ['python rewrite (the self-rename skill step)', 'python3 -c "open(\'@ROOT@/.env\',\'a\').write(\'X=1\')"', ''],
    ['through .. from an agent dir', 'tee -a ../../.env', 'agents/alpha'],
  ])('%s: refused', (_label, command, cwd) => { expect(bash(command, cwd ? join(root, cwd) : root)).toEqual(DENY_FILE) })
  it('globs follow bash\'s dot rule for it: a dot pattern hits, a bare * does not, unless dotglob / GLOBIGNORE is on', () => {
    expect(bash('echo GATE_WIRING_ENFORCE=0 >> .e*')).toEqual(DENY_FILE)
    expect(bash('echo X >> .[e]nv')).toEqual(DENY_FILE)
    expect(bash('sqlite3 store/x.db "SELECT * FROM t"')).toEqual(ALLOW)
    expect(bash('shopt -s dotglob; echo GATE_WIRING_ENFORCE=0 | tee -a *')).toEqual(DENY_FILE)
    expect(bash('GLOBIGNORE=x; echo GATE_WIRING_ENFORCE=0 | tee -a *')).toEqual(DENY_FILE)
  })
  it('reading it, and an agent\'s own channel .env, stay allowed', () => {
    expect(bash('grep -E "^WEB_PORT=" .env')).toEqual(ALLOW)
    touch('agents/alpha/.claude/channels/telegram/.env', 'X=1\n')
    expect(file('Write', 'agents/alpha/.claude/channels/telegram/.env')).toEqual(ALLOW)
    expect(bash('echo X=1 > .claude/channels/telegram/.env', join(root, 'agents', 'alpha'))).toEqual(ALLOW)
  })
})

describe('refused: the other new install paths', () => {
  it.each([
    'scripts/watchdog.sh', 'scripts/lib/owner-chat.sh', 'scripts/hooks/sub-hooks.lock.json', 'store/agent-settings-baseline.json',
    'store/gate-wiring-state.json', 'templates/profiles/default.json', 'templates/profiles/new.json',
    'src/web/agent-process.ts', 'src/web/hooks/manifest.ts', 'dist/web/agent-scaffold.js', 'dist/web/hooks/manifest.js',
    'scripts/statusline-ratelimit.sh',
  ])('Write %s', (rel) => { expect(file('Write', rel)).toEqual(DENY_FILE) })
  it('a bare * glob word is no hit (no one-segment protected directory), so sqlite3 SELECT * still passes', () => {
    expect(bash('sqlite3 store/x.db "SELECT * FROM t; SELECT count(*) FROM t"')).toEqual(ALLOW)
    expect(file('Write', 'personas/alpha.md')).toEqual(ALLOW)
  })
  it('the statusLine script (Ron 17563, suggestion 3): refused by Bash spellings too, a sibling script is not', () => {
    touch('scripts/statusline-ratelimit.sh', '#!/bin/bash\n')
    expect(bash('echo x > scripts/statusline-ratelimit.sh')).toMatchObject({ deny: true })
    expect(bash('cp /x/y @ROOT@/scripts/statusline-ratelimit.sh')).toMatchObject({ deny: true })
    expect(bash('sed -i s/a/b/ statusline-ratelimit.sh', join(root, 'scripts'))).toMatchObject({ deny: true })
    expect(file('Write', 'scripts/other-statusline.sh')).toEqual(ALLOW)
    expect(bash('cat scripts/statusline-ratelimit.sh')).toEqual(ALLOW)
  })
  it('the rest of src/ and dist/ is not protected (stated residual)', () => {
    expect(file('Write', 'src/web/other.ts')).toEqual(ALLOW)
    expect(file('Write', 'dist/web/other.js')).toEqual(ALLOW)
  })
})

describe('K2 probes (Ron 17402): the expected outcome, the same for the main agent and a sub-agent', () => {
  const callers: Array<[string, () => string | null]> = [['main agent', () => mainTranscript()], ['sub-agent', () => subTranscript()]]
  for (const [who, t] of callers) {
    it(`${who}: a typed npm run build is allowed (it names no protected path; the build is a child process)`, () => {
      expect(bash('npm run build', root, t())).toEqual(ALLOW)
    })
    it(`${who}: a hand-written .built-commit is allowed (dist/.built-commit is not a protected path)`, () => {
      expect(bash('echo deadbeef > dist/.built-commit', root, t())).toEqual(ALLOW)
    })
    it(`${who}: rm -rf dist and mv dist dist.prev are refused (dist contains the protected dist/web/hooks: an owner-terminal step)`, () => {
      expect(bash('rm -rf dist', root, t())).toEqual(DENY_FILE)
      expect(bash('mv dist dist.prev', root, t())).toEqual(DENY_FILE)
    })
    it(`${who}: the update flow, started as a script, is allowed (its children write dist, the gate does not see them)`, () => {
      expect(bash('bash scripts/update.sh', root, t())).toEqual(ALLOW)
      expect(bash('setsid nohup bash scripts/update.sh > /dev/null 2>&1 &', root, t())).toEqual(ALLOW)
    })
  }
  it('the fork deploy helper keeps its one allowed spelling for the main agent (its dist.next swap runs in its own process)', () => {
    const v = bash(`node ${join(root, DEPLOY_HELPER_REL)} status`, base, mainTranscript())
    expect(v.deny).toBe(false)
    expect(v.deployHelper).toBe(true)
  })
})
