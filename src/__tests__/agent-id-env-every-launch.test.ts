import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMainSessionRespawnCmd } from '../web/channel-monitor.js'
import { mainConfigDecisionForTest } from '../web/main-config-decision.js'
import { buildRemoteLaunchCommand } from '../web/ssh-tmux.js'
import { shSingleQuote } from '../web/agent-process.js'
import { agentIdEnvExport, AGENT_ID_ENV_VAR } from '../web/agent-id-env.js'
import { MAIN_AGENT_ID } from '../config.js'

// C2 PR6: every Claude Code session the fleet launches carries its agent's canonical name as
// MARVEEN_AGENT_ID, so scripts/marveen-api.sh can default <agent>/<updated-by>/<from>. Attribution only,
// not a security boundary (self-asserted, one shared token). Each launch path is pinned here; the
// enumeration at the bottom fails first when a new launch path ships without it.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')
const HOSTILE = `a'b; touch /tmp/pwned-$(id) \`x\``

/** Run `<export piece> && printf %s "$MARVEEN_AGENT_ID"` in a clean bash: what the pane would see. */
function paneValue(exportPiece: string): string {
  return execFileSync('bash', ['-c', `${exportPiece} && printf %s "$MARVEEN_AGENT_ID"`], {
    encoding: 'utf-8', env: { PATH: '/usr/bin:/bin' },
  })
}

describe('agentIdEnvExport', () => {
  it('names the variable and makes any value one inert shell word', () => {
    expect(AGENT_ID_ENV_VAR).toBe('MARVEEN_AGENT_ID')
    expect(agentIdEnvExport('tom', shSingleQuote)).toBe(`export MARVEEN_AGENT_ID='tom'`)
    expect(paneValue(agentIdEnvExport(HOSTILE, shSingleQuote))).toBe(HOSTILE)
  })
})

describe('every fleet launch path exports MARVEEN_AGENT_ID', () => {
  it('channel-monitor main respawn (resume, fresh, hard-restart share this builder): MAIN_AGENT_ID, quoted, before claude', () => {
    const cmd = buildMainSessionRespawnCmd({
      claudePath: '/usr/local/bin/claude',
      pluginId: 'telegram@claude-plugins-official',
      model: 'claude-opus-4-8[1m]',
      config: mainConfigDecisionForTest(),
      channelStateEnv: { name: 'TELEGRAM_STATE_DIR', dir: '/opt/marveen/.claude/channels/telegram' },
      continueSession: true,
    })
    const piece = `export MARVEEN_AGENT_ID=${shSingleQuote(MAIN_AGENT_ID)}`
    expect(cmd).toContain(`&& ${piece} `)
    expect(cmd.indexOf(piece)).toBeLessThan(cmd.indexOf('/usr/local/bin/claude'))
  })

  it('ssh-tmux remote launch: the agent name, quoted, before claude; no export without a name', () => {
    const cmd = buildRemoteLaunchCommand({ workdir: '/home/x/agents/a', model: 'm', continue: false, agentId: HOSTILE })
    expect(cmd).toContain(`&& ${agentIdEnvExport(HOSTILE, shSingleQuote)} && cd `)
    expect(cmd.indexOf('MARVEEN_AGENT_ID')).toBeLessThan(cmd.indexOf(' claude '))
    expect(buildRemoteLaunchCommand({ workdir: '/p', model: 'm', continue: false })).not.toContain('MARVEEN_AGENT_ID')
  })

  it('agent-process.ts: the sub-agent launch carries the agent name, shSingleQuote-d, and the remote call passes it', () => {
    const s = read('src/web/agent-process.ts')
    expect(s).toMatch(/const agentIdEnv = `\$\{agentIdEnvExport\(name, shSingleQuote\)\} && `/)
    const launch = s.match(/const buildLaunchCmd = \(launchCwd: string\) => `([^\n]*)`/)
    expect(launch).not.toBeNull()
    expect(launch![1]).toContain('${agentIdEnv}')
    expect(launch![1].indexOf('${agentIdEnv}')).toBeLessThan(launch![1].indexOf('${claudeBin()}'))
    expect(s).toMatch(/buildRemoteLaunchCommand\(\{ workdir, model, continue: hasPriorSession, agentId: name \}\)/)
  })

  it('background-tasks.ts: the requesting agent id (caller input) is shSingleQuote-d into the claude -p command', () => {
    const s = read('src/web/routes/background-tasks.ts')
    expect(s).toMatch(/agentIdEnvExport\(agentId, shSingleQuote\),\n\s*`\$\{CLAUDE\} -p /)
  })

  it('agent-worker.ts: the shared worker deliberately carries NO identity (unset, never inherited)', () => {
    expect(read('src/web/agent-worker.ts')).toMatch(/`unset MARVEEN_AGENT_ID; ` \+/)
  })

  it('channels.sh: quoted export, in both launch strings (boot and relaunch)', () => {
    const s = read('scripts/channels.sh')
    // Sanitised to the same class as channel-watchdog.sh / stuck-modal-guard.sh (Ron review, PR6).
    expect(s).toMatch(/^_agent_id="\$\{MAIN_AGENT_ID:-marveen\}"; _agent_id="\$\{_agent_id\/\/\[\^a-zA-Z0-9_-\]\/\}"$/m)
    expect(s).toMatch(/^\[ -z "\$_agent_id" \] \|\| AGENT_ID_ENV="export MARVEEN_AGENT_ID=\$\(sh_single_quote "\$_agent_id"\) && "$/m)
    expect(s.match(/\$\{STATE_DIR_ENV\}\$\{AGENT_ID_ENV\}\$\{MCP_BATCH_ENV\}[^\n]*\$CLAUDE --dangerously-skip-permissions/g)?.length).toBe(2)
  })

  it('channel-watchdog.sh respawn command', () => {
    const s = read('scripts/channel-watchdog.sh')
    expect(s).toMatch(/^AGENT_ID_ENV="export MARVEEN_AGENT_ID=\$\(sh_single_quote "\$MAIN_AGENT_ID"\) && "$/m)
    expect(s).toMatch(/^RESPAWN_CMD="[^\n]*\$\{AGENT_ID_ENV\}\$\{CFG_ENV\}\$CLAUDE --dangerously-skip-permissions/m)
  })

  it('stuck-modal-guard.sh respawn command (no export when no id can be read)', () => {
    const s = read('scripts/stuck-modal-guard.sh')
    expect(s).toMatch(/\[ -z "\$_agent_id" \] \|\| AGENT_ID_ENV="export MARVEEN_AGENT_ID=\$\(sh_single_quote "\$_agent_id"\) && "/)
    expect(s).toMatch(/local RESPAWN_CMD="[^\n]*\$\{AGENT_ID_ENV\}\$\{CFG_ENV\}\$CLAUDE_Q --dangerously-skip-permissions/)
  })

  it('watchdog.sh sub-agent relaunch: quoted with its own sh_single_quote, which round-trips a hostile name', () => {
    const s = read('scripts/watchdog.sh')
    expect(s).toMatch(/CMD="\$\{ISO_ENV\}[^\n]*export MARVEEN_AGENT_ID=\$\(sh_single_quote "\$AGENT_ID"\) && cd [^\n]*--dangerously-skip-permissions/)
    const fn = s.split('\n').find((l) => l.startsWith('sh_single_quote() {'))
    expect(fn).toBeDefined()
    const quoted = execFileSync('bash', ['-c', `${fn}\nsh_single_quote "$1"`, 'x', HOSTILE], { encoding: 'utf-8', env: { PATH: '/usr/bin:/bin' } })
    expect(paneValue(`export MARVEEN_AGENT_ID=${quoted}`)).toBe(HOSTILE)
  })
})

// Same discovery as agent-view-disabled-every-launch.test.ts: every code line (not a comment) in
// scripts/*.sh and src/**/*.ts that launches claude with --dangerously-skip-permissions must sit in a
// file that handles MARVEEN_AGENT_ID. The two exceptions are one-shot `claude -p` runs that are not an
// agent session: the operator's API-key morning briefing (its prompt makes no helper call) and the
// bash-sandbox e2e harness.
const NOT_AGENT_SESSIONS = ['scripts/bash-sandbox-e2e.sh', 'scripts/morning-briefing.sh']

function* walk(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') yield* walk(p) } else yield p
  }
}

describe('no launch path is missing MARVEEN_AGENT_ID (enumeration)', () => {
  it('each file with a --dangerously-skip-permissions launch line handles MARVEEN_AGENT_ID', () => {
    const files = [
      ...readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('.sh')).map((f) => join(ROOT, 'scripts', f)),
      ...[...walk(join(ROOT, 'src'))].filter((f) => f.endsWith('.ts')),
    ]
    const launchers: string[] = []
    const missing: string[] = []
    for (const f of files) {
      const rel = relative(ROOT, f)
      const code = readFileSync(f, 'utf-8').split('\n')
        .filter((l) => { const t = l.trim(); return !t.startsWith('#') && !t.startsWith('//') && !t.startsWith('*') })
      if (!code.some((l) => l.includes('--dangerously-skip-permissions'))) continue
      launchers.push(rel)
      if (NOT_AGENT_SESSIONS.includes(rel)) continue
      if (!code.some((l) => l.includes('MARVEEN_AGENT_ID') || l.includes('agentIdEnvExport') || l.includes('agentIdEnv}'))) missing.push(rel)
    }
    expect(launchers.length).toBeGreaterThanOrEqual(8)
    expect(launchers).toEqual(expect.arrayContaining(NOT_AGENT_SESSIONS))
    expect(missing).toEqual([])
  })
})
