/**
 * C3-5a (Ron 14094): the known hook command spellings (src/web/hooks/spellings.ts) the settings dry-run pairs a
 * rewrap on. Tied to the manifest: every command it renders, in both scopes with every switch on, classifies as the
 * entry's own wrapper kind with its script path, arguments and deadline; and every command of the 12 live sub-agent
 * blocks (sanitised fixture) is a known spelling. Pure: nothing is read but the fixture, nothing is written.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HOOK_MANIFEST, gateDeadlineSec, matchersOf, nodeGateCommand, pythonGateCommand, renderHooks, specFor,
  type HookScope, type RenderContext,
} from '../web/hooks/manifest.js'
import { classifySpelling } from '../web/hooks/spellings.js'

const ROOT = '/r'
const NODE_BIN = '/usr/bin/node'
const POLICY = 'strict'
const ALL_ON: RenderContext = {
  root: ROOT, nodeBin: NODE_BIN, profile: { destructiveGate: true, credentialGate: true, secondReviewer: true },
  agent: { heartbeat: true, threadReply: true, senderRolePolicy: POLICY, browser: true }, prompts: { precompact: 'x' },
}
const WITH_DEADLINE = ['failOpenNodeProbe', 'failClosedRun', 'failClosedRunNodeProbe', 'failClosedPythonProbe', 'failClosedNodeBin']
const P = (script: string) => `${ROOT}/scripts/hooks/${script}`

describe('the known spellings are the manifest\'s', () => {
  for (const scope of ['main', 'sub'] as HookScope[]) {
    it(`every ${scope} command classifies as its entry's wrapper kind, fail mode, script, arguments and deadline`, () => {
      const rendered = renderHooks(HOOK_MANIFEST, scope, scope === 'sub' ? ALL_ON : {})
      const root = scope === 'sub' ? ROOT : '$CLAUDE_PROJECT_DIR'
      const seen = new Set<string>()
      let n = 0
      for (const [event, groups] of Object.entries(rendered)) {
        for (const g of groups!) {
          for (const h of g.hooks) {
            if (h.type !== 'command') continue
            n++
            const s = classifySpelling(h.command, h.timeout, event, scope)
            expect(s, `${event} ${h.command.slice(0, 80)}`).not.toBeNull()
            const e = HOOK_MANIFEST.entries.find((x) => (x.scope === scope || x.scope === 'both') && specFor(x, scope).events.includes(event as never)
              && matchersOf(specFor(x, scope)).includes(g.matcher) && `${root}/${x.script}` === s!.path)
            expect(e, `${event} ${s!.path}`).toBeDefined()
            const spec = specFor(e!, scope)
            const args = [...(spec.args ?? []), ...(scope === 'sub' ? e!.threadReplyArgs ?? [] : []), ...(scope === 'sub' && e!.agentFlag === 'senderRolePolicy' ? [POLICY] : [])]
            expect([e!.id, s!.kind, s!.args, s!.deadline]).toEqual([e!.id, spec.wrapper, args, WITH_DEADLINE.includes(spec.wrapper) ? gateDeadlineSec(spec.timeout!) : undefined])
            // The spelling's fail mode is the one the manifest records for the entry (C3-5a-3); the kill switch's
            // closed-while-frozen spelling is its own mode, recorded as closed.
            expect([e!.id, s!.failMode]).toEqual([e!.id, spec.wrapper === 'failOpenExecClosedWhenFrozen' ? 'closedWhileFrozen' : spec.failMode])
            seen.add(spec.wrapper)
          }
        }
      }
      expect(n).toBeGreaterThan(40)
      expect([...seen].sort()).toEqual(scope === 'main'
        ? ['failClosedRun', 'failClosedRunNodeProbe', 'failOpenExec', 'failOpenExecClosedWhenFrozen', 'failOpenNodeProbe']
        : ['bare', 'bareQuoted', 'failClosedNodeBin', 'failClosedPythonProbe', 'failOpenExecUnquoted'])
    })
  }

  it('every command of the 12 live sub-agent blocks is a known spelling (the window\'s before side)', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'hooks', '__fixtures__', 'live-sub-hooks.12.json')
    const fx = JSON.parse(readFileSync(file, 'utf-8').replaceAll('${ROOT}', ROOT).replaceAll('${NODE_BIN}', NODE_BIN)) as {
      hooks: Array<{ type: string; command?: string; timeout?: number }>
      agents: Record<string, { events: Record<string, Array<{ hooks: number[] }>> }>
    }
    const unknown: string[] = []
    let n = 0
    for (const [name, a] of Object.entries(fx.agents)) {
      for (const [event, groups] of Object.entries(a.events)) {
        for (const i of groups.flatMap((g) => g.hooks)) {
          const h = fx.hooks[i]
          if (h.type !== 'command') continue
          n++
          if (classifySpelling(h.command!, h.timeout, event, 'sub') === null) unknown.push(`${name} ${event} #${i}`)
        }
      }
    }
    expect(n).toBe(12 * 38 + 5)
    expect(unknown).toEqual([])
  })

  it('the planned C3-5b sub spelling (failOpenExec with the absolute root) is known already, so a revert of C3-5b classifies', () => {
    expect(classifySpelling(`bash -c '[ -f "${P('staleness-guard.py')}" ] && exec python3 "${P('staleness-guard.py')}"; exit 0'`, 10, 'UserPromptSubmit'))
      .toEqual({ kind: 'failOpenExec', failMode: 'open', interpreter: 'python3', path: P('staleness-guard.py'), args: [] })
  })
})

describe('classifySpelling: what is not a known spelling', () => {
  it('an interpreter that does not fit the script, or a node binary for a python script', () => {
    expect(classifySpelling(`bash -c '[ -f ${P('x.py')} ] && exec bash ${P('x.py')}; exit 0'`, 10, 'Stop')).toBeNull()
    expect(classifySpelling(`bash -c '[ -f ${P('x.mjs')} ] && exec node ${P('x.mjs')}; exit 0'`, 10, 'Stop')?.interpreter).toBe('node')
    const gate = nodeGateCommand(NODE_BIN, P('egress-gate.mjs'), [], 10)
    expect(classifySpelling(gate, 10, 'PreToolUse')).toMatchObject({ kind: 'failClosedNodeBin', interpreter: NODE_BIN, deadline: 8 })
    expect(classifySpelling(gate.replaceAll('egress-gate.mjs', 'egress-gate.py'), 10, 'PreToolUse')).toBeNull()
    // A probe for one interpreter in front of a run of another: the python probe running node, the node probe running python3.
    expect(classifySpelling(pythonGateCommand(P('x.mjs'), [], 10).replaceAll('python3 "', 'node "'), 10, 'PreToolUse')).toBeNull()
    const egress = renderHooks(HOOK_MANIFEST, 'main').PreToolUse!.flatMap((g) => g.hooks).find((h) => h.type === 'command' && h.command.includes('egress-gate.mjs'))!
    if (egress.type !== 'command') throw new Error('unreachable')
    expect(classifySpelling(egress.command, egress.timeout, 'PreToolUse', 'main')?.kind).toBe('failClosedRunNodeProbe')
    expect(classifySpelling(egress.command.replaceAll('egress-gate.mjs', 'egress-gate.py').replaceAll('node "', 'python3 "'), egress.timeout, 'PreToolUse', 'main')).toBeNull()
  })

  it('a gate whose label is not its script, or whose deadline is not its own timeout\'s', () => {
    const gate = pythonGateCommand(P('outgoing-copy-gate.py'), [], 15)
    expect(classifySpelling(gate, 15, 'PreToolUse')).toMatchObject({ kind: 'failClosedPythonProbe', deadline: 13 })
    expect(classifySpelling(gate.replace(': outgoing-copy-gate.py:', ': other-gate.py:'), 15, 'PreToolUse')).toBeNull()
    expect(classifySpelling(gate, 10, 'PreToolUse')).toBeNull()
    expect(classifySpelling(gate, undefined, 'PreToolUse')).toBeNull()
  })

  it('a bare spelling where a failure can block (UserPromptSubmit, PreToolUse, Stop); fine where it cannot', () => {
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'Stop']) expect(classifySpelling(`python3 "${P('x.py')}"`, 10, event)).toBeNull()
    for (const event of ['SessionStart', 'SessionEnd', 'PostToolUse', 'PostToolUseFailure']) expect(classifySpelling(`python3 ${P('x.py')}`, 10, event)?.kind).toBe('bare')
  })

  it('a main-only spelling in a sub-agent file, and the frozen spelling with a marker outside the script\'s root', () => {
    const run = `if command -v timeout >/dev/null 2>&1; then timeout -k 1 8 python3 "${P('g.py')}"; else python3 "${P('g.py')}"; fi; `
      + 'rc=$?; [ "$rc" = 0 ] || [ "$rc" = 2 ] || { echo "governance-kapu (fail-closed): g.py: a kapu nem 0-val vagy 2-vel lepett ki (rc=$rc: '
      + 'betoltesi hiba, hianyzo fajl, jel vagy idotullepes). A hivas ezert TILTVA. Javitas: a kapu fajlja vagy egy fuggosege hibas, a hibauzenet fent." >&2; exit 2; }; exit "$rc"'
    expect(classifySpelling(run, 10, 'PreToolUse', 'main')?.kind).toBe('failClosedRun')
    expect(classifySpelling(run, 10, 'PreToolUse', 'sub')).toBeNull()
    const frozen = renderHooks(HOOK_MANIFEST, 'main').PreToolUse!.flatMap((g) => g.hooks).find((h) => h.type === 'command' && h.command.includes('fleet-freeze.json'))!
    if (frozen.type !== 'command') throw new Error('unreachable')
    expect(classifySpelling(frozen.command, frozen.timeout, 'PreToolUse', 'main')?.kind).toBe('failOpenExecClosedWhenFrozen')
    expect(classifySpelling(frozen.command.replace('[ -e "$CLAUDE_PROJECT_DIR/store', '[ -e "/elsewhere/store'), frozen.timeout, 'PreToolUse', 'main')).toBeNull()
  })

  it('text around a known spelling, or no script at all', () => {
    const open = `bash -c '[ -f "${P('x.py')}" ] && exec python3 "${P('x.py')}"; exit 0'`
    expect(classifySpelling(open, 10, 'Stop')).not.toBeNull()
    for (const c of [` ${open}`, `${open} `, `${open}; true`, `X=1 ${open}`, 'echo no script here', '']) expect(classifySpelling(c, 10, 'Stop')).toBeNull()
  })

  // C3-5a-3, from Ron's probe2 (14109): a known spelling is template-shaped, and each slot only takes what the
  // manifest can render.
  const S = P('staleness-guard.py')
  const unquoted = (p: string, a = '') => `bash -c '[ -f ${p} ] && exec python3 ${p}${a}; exit 0'`
  const quoted = (p: string, a = '') => `bash -c '[ -f "${p}" ] && exec python3 "${p}"${a}; exit 0'`

  it('an unquoted path of other than PLAIN_ABS_PATH_RE characters: glob, brace, blank, quote, operator, control byte', () => {
    expect(classifySpelling(unquoted(S), 10, 'Stop')?.kind).toBe('failOpenExecUnquoted')
    expect(classifySpelling(unquoted(`${ROOT}/scripts/hooks/a+b_c-1.2.py`), 10, 'Stop')?.kind).toBe('failOpenExecUnquoted')
    for (const c of ['*', '{a,b}', '?', '[a]', '~', '@', '%', ';', '&', '|', '\\', "'", '"', '$x', '\x1b', '\x00', '\n', ' ']) {
      const p = `${ROOT}/scripts/hooks/a${c}b.py`
      expect(classifySpelling(unquoted(p), 10, 'Stop'), JSON.stringify(c)).toBeNull()
      expect(classifySpelling(`python3 ${p}`, 10, 'PostToolUse'), JSON.stringify(c)).toBeNull()
    }
    expect(classifySpelling(unquoted(`${ROOT}/scripts/*/x.py`), 10, 'Stop')).toBeNull()
  })

  it('no control character in a quoted path, the frozen root or an argument; no shell-live character in a quoted path', () => {
    for (const c of ['\x00', '\x01', '\x1b', '\x7f', '\n', '\t']) {
      expect(classifySpelling(quoted(`${ROOT}/scripts/hooks/a${c}b.py`), 10, 'Stop'), JSON.stringify(c)).toBeNull()
      expect(classifySpelling(quoted(S, ` --a${c}b`), 10, 'Stop'), JSON.stringify(c)).toBeNull()
    }
    for (const c of [';', '&', '|', '<', '>', '(', ')', '$', '`', '\\', '"', "'", ' ']) {
      expect(classifySpelling(quoted(`${ROOT}/scripts/hooks/a${c}b.py`), 10, 'Stop'), JSON.stringify(c)).toBeNull()
    }
    const frozen = renderHooks(HOOK_MANIFEST, 'main', { root: '/srv/m' }).PreToolUse!.flatMap((g) => g.hooks).find((h) => h.type === 'command' && h.command.includes('fleet-freeze.json'))!
    if (frozen.type !== 'command') throw new Error('unreachable')
    expect(classifySpelling(frozen.command, frozen.timeout, 'PreToolUse', 'main')?.kind).toBe('failOpenExecClosedWhenFrozen')
    // The script path must start with the marker's root, so a control byte has to sit in both to be the only change.
    for (const c of ['\x1b', '\x00']) {
      expect(classifySpelling(frozen.command.replaceAll('/srv/m', `/srv/m${c}`), frozen.timeout, 'PreToolUse', 'main'), JSON.stringify(c)).toBeNull()
    }
  })

  it('$CLAUDE_PROJECT_DIR only in the main file: in a sub-agent file it would resolve to the agent\'s own directory', () => {
    const d = '$CLAUDE_PROJECT_DIR/scripts/hooks/staleness-guard.py'
    expect(classifySpelling(quoted(d), 10, 'Stop', 'main')?.path).toBe(d)
    expect(classifySpelling(quoted(d), 10, 'Stop', 'sub')).toBeNull()
    expect(classifySpelling(unquoted(d), 10, 'Stop', 'sub')).toBeNull()
    expect(classifySpelling(`python3 "${d}"`, 10, 'PostToolUse', 'sub')).toBeNull()
    expect(classifySpelling(pythonGateCommand(d, [], 10), 10, 'PreToolUse', 'sub')).toBeNull()
    expect(classifySpelling(pythonGateCommand(d, [], 10), 10, 'PreToolUse', 'main')?.kind).toBe('failClosedPythonProbe')
  })

  // Arguments: each word in the manifest's ARG_RE set ([A-Za-z0-9_=.:-]+): validateManifest and gateInvocation throw
  // on any other, so no rendered command carries one. Not a fixed word list, because the sender-role policy is an
  // agent's config value and a retired argument must still classify on a rollback.
  it('an argument word outside the manifest\'s ARG_RE set, or an empty word', () => {
    expect(classifySpelling(quoted(S, ' --a=b:c.d_1 -x'), 10, 'Stop')?.args).toEqual(['--a=b:c.d_1', '-x'])
    const gate = pythonGateCommand(P('g.py'), [], 10)
    for (const a of [' --x=$(id)', ' a;b', ' a&b', ' a|b', ' "q"', " 'q'", ' /etc/passwd', ' *', ' a,b', ' ~', ' a+b', ' a@b', '  a', ' a ', ' ']) {
      expect(classifySpelling(quoted(S, a), 10, 'Stop'), JSON.stringify(a)).toBeNull()
      expect(classifySpelling(unquoted(S, a), 10, 'Stop'), JSON.stringify(a)).toBeNull()
      expect(classifySpelling(gate.replaceAll(`"${P('g.py')}";`, `"${P('g.py')}"${a};`), 10, 'PreToolUse'), JSON.stringify(a)).toBeNull()
    }
  })

  it('a gate deadline of 0 or with a leading zero, on either side; a fractional timeout floors like gateDeadlineSec', () => {
    const node = nodeGateCommand(NODE_BIN, P('egress-gate.mjs'), [], 10)
    const python = pythonGateCommand(P('outgoing-copy-gate.py'), [], 10)
    for (const gate of [node, python]) {
      expect(classifySpelling(gate, 10, 'PreToolUse')?.deadline).toBe(8)
      for (const d of ['0', '00', '08', '008', '000008']) {
        expect(classifySpelling(gate.replaceAll(/timeout -k 1 \d+/g, `timeout -k 1 ${d}`), 10, 'PreToolUse'), d).toBeNull()
      }
      // A timeout of 2 derives deadline 1 (at least one), never 0.
      expect(classifySpelling(gate.replaceAll(/timeout -k 1 \d+/g, 'timeout -k 1 1'), 2, 'PreToolUse')?.deadline).toBe(1)
      expect(classifySpelling(gate.replaceAll(/timeout -k 1 \d+/g, 'timeout -k 1 0'), 2, 'PreToolUse')).toBeNull()
      expect(classifySpelling(gate, 10.9, 'PreToolUse')?.deadline).toBe(8)
      expect(classifySpelling(gate.replaceAll(/timeout -k 1 \d+/g, 'timeout -k 1 9'), 10.9, 'PreToolUse')).toBeNull()
    }
  })

  it('every template has one fail mode: failOpen* and bare* open, failClosed* closed, the kill switch closed while frozen', () => {
    const open = [quoted(S), unquoted(S)].map((c) => classifySpelling(c, 10, 'Stop')?.failMode)
    const bare = [`python3 ${S}`, `python3 "${S}"`].map((c) => classifySpelling(c, 10, 'PostToolUse')?.failMode)
    const closed = [pythonGateCommand(P('g.py'), [], 10), nodeGateCommand(NODE_BIN, P('g.mjs'), [], 10)].map((c) => classifySpelling(c, 10, 'PreToolUse')?.failMode)
    const frozen = renderHooks(HOOK_MANIFEST, 'main').PreToolUse!.flatMap((g) => g.hooks).find((h) => h.type === 'command' && h.command.includes('fleet-freeze.json'))!
    if (frozen.type !== 'command') throw new Error('unreachable')
    const killSwitch = classifySpelling(frozen.command, frozen.timeout, 'PreToolUse', 'main')?.failMode
    expect([open, bare, closed, killSwitch]).toEqual([['open', 'open'], ['open', 'open'], ['closed', 'closed'], 'closedWhileFrozen'])
  })

  it('a path of 100000 characters or a long argument list classifies in well under a second (no catastrophic backtracking)', () => {
    const long = `/${'a'.repeat(100_000)}`
    const t0 = performance.now()
    for (const c of [quoted(long), unquoted(long), unquoted(`${long}.py`, ' a'.repeat(50_000)), `python3 ${'/a'.repeat(50_000)}!`, `test -x "${long}" || { echo`]) {
      classifySpelling(c, 10, 'PostToolUse')
      classifySpelling(c, 10, 'Stop')
    }
    expect(performance.now() - t0).toBeLessThan(1000)
  })
})
