import { describe, it, expect, afterAll } from 'vitest'
import { gateDecision as selfPaceDecision } from '../../scripts/self-pace-gate.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// C2 PR5: scripts/marveen-admin.sh is the MAIN agent's schedule-write tool. Every sub-agent's self-pace gate must
// deny it by name, and the module behind it (lib/marveen_admin.py) too, because python can run that directly. It
// has no read-only verbs, so only the gate's shared exemptions apply: a read-only file command on it, git on its
// source, a mention inside message data, and its test files (the name lookahead).

const REPO = join(__dirname, '..', '..')
const GATE_ROOT = mkdtempSync(join(tmpdir(), 'admin-gate-'))
mkdirSync(join(GATE_ROOT, 'store'), { recursive: true })
mkdirSync(join(GATE_ROOT, 'agents', 'agent-a'), { recursive: true })
writeFileSync(join(GATE_ROOT, 'store', '.dashboard-token'), 'example-token\n')
afterAll(() => rmSync(GATE_ROOT, { recursive: true, force: true }))
const GATE_OPTS = { projectRoot: GATE_ROOT, selfAgent: 'agent-a' }
const deny = (command: string) => selfPaceDecision('Bash', { command }, GATE_OPTS).deny

// The admin tool's verbs, read from its own dispatcher, so a verb added later is covered without editing this test.
const ADMIN_SRC = readFileSync(join(REPO, 'scripts', 'lib', 'marveen_admin.py'), 'utf-8')
const ADMIN_VERBS = [...ADMIN_SRC.matchAll(/verb == '([a-z][a-z-]+)'/g)].map((m) => m[1])

describe('self-pace-gate: the main agent\'s schedule-write tool (marveen-admin.sh, C2 PR5)', () => {
  it('the dispatcher has the verbs the usage text names (parity source for the next test)', () => {
    expect(ADMIN_VERBS.sort()).toEqual(['schedule-create', 'schedule-update'])
    for (const v of ADMIN_VERBS) expect(ADMIN_SRC, v).toContain(`  ${v} `)
  })

  it('denies every admin verb, through both names and every runner form', () => {
    for (const v of ADMIN_VERBS) {
      for (const c of [
        `bash ${REPO}/scripts/marveen-admin.sh ${v} x`,
        `bash scripts/marveen-admin.sh ${v} x`,
        `./scripts/marveen-admin.sh ${v} x`,
        `cd ${REPO} && bash scripts/marveen-admin.sh ${v} x`,
        `python3 scripts/lib/marveen_admin.py ${v} x`,
        `python3 -I ${REPO}/scripts/lib/marveen_admin.py ${v} x`,
        `MARVEEN_AGENT_ID=johnny bash scripts/marveen-admin.sh ${v} x`,
      ]) expect(deny(c), c).toBe(true)
    }
  })

  it('denies the obfuscated spellings the registry tool is also guarded against', () => {
    for (const c of [
      'bash scripts/marveen-adm*.sh schedule-create x',
      'bash scripts/marveen-{admin,x}.sh schedule-create x',
      `bash "scripts/marveen-admin.sh" schedule-create x`,
      `bash 'scripts/marveen-'admin.sh schedule-create x`,
      'A=scripts/marveen-admin.sh; bash $A schedule-create x',
      'cd scripts && bash marveen-admin.sh schedule-update x --enabled false',
      'python3 scripts/lib/marveen_adm?n.py schedule-create x',
      `python3 -c "import runpy; runpy.run_path('scripts/lib/marveen_admin.py')"`,
      'bash scripts/marveen-admin.sh',
    ]) expect(deny(c), c).toBe(true)
  })

  it('keeps the shared exemptions: reading the file, git on its source, its tests, a mention in message data', () => {
    for (const c of [
      'cat scripts/marveen-admin.sh',
      'grep -n schedule-create scripts/lib/marveen_admin.py',
      'git add scripts/marveen-admin.sh scripts/lib/marveen_admin.py',
      'git diff -- scripts/lib/marveen_admin.py',
      'python3 scripts/__tests__/marveen-admin.test.py',
      'bash scripts/marveen-api.sh schedules-list',
    ]) expect(deny(c), c).toBe(false)
  })

  it('a bare *.py / *.sh glob is every such file, not evidence of the tool; a glob with its name still is', () => {
    for (const c of [
      'sed -i s/a/b/ scripts/hooks/*.py',
      'chmod +x scripts/*.sh',
      'python3 -m py_compile scripts/lib/*.py',
      'shellcheck scripts/?.sh',
    ]) expect(deny(c), c).toBe(false)
    for (const c of [
      'bash scripts/marveen-*.sh schedule-create x',
      'python3 scripts/lib/*admin.py schedule-update x --enabled false',
      'bash scripts/*-admin.sh schedule-create x',
    ]) expect(deny(c), c).toBe(true)
  })

  // gateDecision returns only the verdict; the text is chosen in the hook's main path, so this runs the hook itself.
  it('the deny message names the tool, so the agent knows to ask the main agent (hook end to end)', () => {
    const hook = join(REPO, 'scripts', 'self-pace-gate.mjs')
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'bash scripts/marveen-admin.sh schedule-create x' }, cwd: GATE_ROOT }),
      encoding: 'utf-8',
    })
    const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason
    expect(reason).toContain('marveen-admin.sh')
    expect(reason).toContain('marveen_admin.py')
  })
})
