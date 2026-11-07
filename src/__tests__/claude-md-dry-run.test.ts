// C1 PR 8a: the dry-run CLI over a synthetic install tree (fixtures/claude-md/dry-run-tree.ts).
// The read-only proof is claude-md-dry-run-readonly.test.ts; the detectors' unit
// tests and source parity are claude-md-owner-zone.test.ts.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeVersion, formatJson, formatText, runCli } from '../web/claude-md/dry-run-cli.js'
import { composeClaudeMd } from '../web/claude-md/compose.js'
import { dryRun } from '../web/claude-md/dry-run.js'
import { buildLiveContext } from '../web/claude-md/live-context.js'
import { renderRegion } from '../web/claude-md/registry.js'
import { DRY_RUN_TREE, writeDryRunTree } from './fixtures/claude-md/dry-run-tree.js'

let base: string
let root: string
// The main agent's user-scope settings layer: an empty home inside the test tree,
// so the runner's own ~/.claude never shapes the result.
const HOME_FIX = () => join(base, 'home')

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'claude-md-dry-run-'))
  root = join(base, 'install')
  mkdirSync(root)
  mkdirSync(HOME_FIX())
  writeDryRunTree(root)
})
afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

function cli(...argv: string[]): { code: number; out: string; err: string } {
  let out = ''
  let err = ''
  const code = runCli(argv, (s) => { out += s }, (s) => { err += s })
  return { code, out, err }
}

function json(...argv: string[]) {
  const r = cli(...argv, '--json')
  return { ...r, data: JSON.parse(r.out) }
}

type F = { line: number; detector: string; pattern: string; flags: string[] }
const agentOf = (data: { agents: { name: string }[] }, name: string) =>
  data.agents.find((a) => a.name === name) as unknown as {
    status: string; role: string; file: string; notes: string[]; error?: { message: string; line?: number; byteOffset?: number }
    chars?: { file: number; generated: number }; blocks: { id: string; line: number; chars: number }[]
    ownerZone: { segmented: boolean; findings: F[] }
  }

describe('agents and status', () => {
  it('lists main first, then the subs in name order; no hidden agent, no alias, no agents/<main id>', () => {
    const { code, data } = json('--dry-run', '--root', root, '--home', HOME_FIX(), '--all')
    expect(code).toBe(1)
    expect(data.exit).toBe(1)
    expect(data.mainAgentId).toBe('chief')
    expect(data.agents.map((a: { name: string; role: string; status: string }) => [a.name, a.role, a.status])).toEqual([
      ['chief', 'main', 'ok'],
      ['alpha', 'sub', 'ok'],
      ['beta', 'sub', 'refused'],
      ['delta', 'sub', 'refused'],
      ['gamma', 'sub', 'missing'],
    ])
  })

  it('names a refused file with file and line: the unclosed fence by its opening line (Ron, 7a)', () => {
    const { data, out } = { ...json('--dry-run', '--root', root, '--home', HOME_FIX(), '--all'), out: cli('--dry-run', '--root', root, '--home', HOME_FIX(), '--all').out }
    const beta = agentOf(data, 'beta')
    expect(beta.error).toEqual({ message: 'unclosed code fence at EOF: the region would land inside it', line: 11 })
    expect(out).toContain('  refused: agents/beta/CLAUDE.md:11: unclosed code fence at EOF: the region would land inside it\n')
  })

  it('a refused file is still scanned, every line, and marked not segmented', () => {
    const beta = agentOf(json('--dry-run', '--root', root, '--home', HOME_FIX(), '--all').data, 'beta')
    expect(beta.ownerZone.segmented).toBe(false)
    expect(beta.ownerZone.findings).toEqual([
      { line: 12, detector: 'curl-recipe', pattern: 'curl-api', flags: ['token-on-argv'] },
      { line: 12, detector: 'dashboard-token', pattern: 'dashboard-token', flags: ['in-curl-recipe'] },
    ])
  })

  it('names a file that is not UTF-8 with line and byte offset', () => {
    const { data, out } = { ...json('--dry-run', '--root', root, '--home', HOME_FIX(), '--all'), out: cli('--dry-run', '--root', root, '--home', HOME_FIX(), '--all').out }
    expect(agentOf(data, 'delta').error).toEqual({ message: 'not valid UTF-8', line: 3, byteOffset: 6 })
    expect(out).toContain('  refused: agents/delta/CLAUDE.md:3: not valid UTF-8 (byte 6)\n')
  })

  it('a sub-agent without CLAUDE.md is reported as missing, not skipped, and does not fail the run', () => {
    expect(agentOf(json('--dry-run', '--root', root, '--home', HOME_FIX(), '--all').data, 'gamma').status).toBe('missing')
    const r = cli('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', 'gamma')
    expect(r.code).toBe(0)
    expect(r.out).toContain('gamma (sub) agents/gamma/CLAUDE.md: missing\n')
  })

  it('an unreadable CLAUDE.md (a directory) is reported and gives exit 1', () => {
    const r2 = join(base, 'unreadable')
    mkdirSync(join(r2, 'agents', 'x', 'CLAUDE.md'), { recursive: true })
    writeFileSync(join(r2, 'CLAUDE.md'), '# main\n')
    const { code, data } = json('--dry-run', '--root', r2, '--home', HOME_FIX(), '--all')
    expect(code).toBe(1)
    expect(data.mainAgentId).toBe('marveen') // no .env: the config.ts default
    expect(agentOf(data, 'x').status).toBe('unreadable')
    expect(agentOf(data, 'marveen').status).toBe('ok')
  })

  it('exit 0 when every requested file is accepted', () => {
    expect(cli('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', 'chief').code).toBe(0)
    expect(cli('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', 'alpha').code).toBe(0)
  })
})

describe('legacy inventory and chars', () => {
  it('lists the generated blocks with their BEGIN line and size; a decoy in a fence is owner text', () => {
    const alpha = agentOf(json('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', 'alpha').data, 'alpha')
    const text = DRY_RUN_TREE['agents/alpha/CLAUDE.md']
    const lines = text.slice(1).match(/[^\n]*\n/g) as string[]
    const span = (a: number, b: number) => [...lines.slice(a - 1, b).join('')].length
    expect(alpha.blocks).toEqual([
      { id: 'fleet-roster', line: 19, chars: span(19, 22) },
      { id: 'autonomy-wiring', line: 24, chars: span(24, 26) },
    ])
    expect(alpha.chars).toEqual({ file: [...text].length, generated: span(19, 22) + span(24, 26) })
    expect(alpha.notes).toEqual(['bom', 'crlf'])
  })

  it('counts code points, the federation block included', () => {
    const chief = agentOf(json('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', 'chief').data, 'chief')
    expect(chief.blocks.map((b) => [b.id, b.line])).toEqual([['evidence-rule', 22], ['federation', 27]])
    const text = DRY_RUN_TREE['CLAUDE.md'].replaceAll('@ROOT@', root)
    expect(chief.chars?.file).toBe([...text].length)
    expect(chief.notes).toEqual([])
  })
})

describe('owner-zone findings', () => {
  it('reports the main fixture exactly; generated blocks are not owner text', () => {
    const chief = agentOf(json('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', 'chief').data, 'chief')
    expect(chief.ownerZone.segmented).toBe(true)
    expect(chief.ownerZone.findings).toEqual([
      { line: 5, detector: 'sniff-literal', pattern: 'interagent-heading', flags: [] },
      { line: 8, detector: 'curl-recipe', pattern: 'curl-api', flags: ['token-on-argv', 'raw-q'] },
      { line: 8, detector: 'dashboard-token', pattern: 'dashboard-token', flags: ['in-curl-recipe'] },
      { line: 9, detector: 'curl-recipe', pattern: 'curl-api', flags: ['double-quoted-payload'] },
      { line: 10, detector: 'curl-recipe', pattern: 'curl-api', flags: [] },
      { line: 10, detector: 'dashboard-token', pattern: 'dashboard-token', flags: ['in-curl-recipe'] },
      { line: 13, detector: 'curl-recipe', pattern: 'curl-api', flags: ['token-on-argv'] },
      { line: 13, detector: 'dashboard-token', pattern: 'dashboard-token', flags: ['in-curl-recipe', 'foreign-root'] },
      { line: 13, detector: 'stale-path', pattern: '/store/.dashboard-token', flags: [] },
      { line: 14, detector: 'stale-path', pattern: '/scripts/hooks/', flags: [] },
      { line: 15, detector: 'sniff-literal', pattern: 'x-memory-search', flags: [] },
      { line: 18, detector: 'sniff-literal', pattern: 'retired-skill-section-0', flags: [] },
    ])
  })

  it('a continued curl is one recipe at its first line; the CRLF copy of a retired section is not byte-equal', () => {
    const alpha = agentOf(json('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', 'alpha').data, 'alpha')
    expect(alpha.ownerZone.findings).toEqual([
      { line: 11, detector: 'curl-recipe', pattern: 'curl-api', flags: ['token-on-argv'] },
      { line: 28, detector: 'sniff-literal', pattern: 'auth-szabaly', flags: [] },
    ])
  })

  it('the text report lists findings as file:line, detector, pattern and flags', () => {
    const { out } = cli('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', 'chief')
    expect(out).toContain('    CLAUDE.md:8 curl-recipe curl-api [token-on-argv, raw-q]\n')
    expect(out.split('\n')[0]).toBe(`claude-md dry-run (read-only), root ${root}, main agent chief, code unknown`)
    expect(out).toContain('    CLAUDE.md:14 stale-path /scripts/hooks/\n')
    expect(out).toContain('  block evidence-rule at line 22: ')
  })
})

describe('no owner-zone text in the default output (Kevin 12995)', () => {
  // OWNER_NAME is not in the list: the v2 identity line renders it (sections.ts),
  // so it is in the region diff by design. The chat_id next to it is masked.
  const FORBIDDEN = ['OZSENTINEL', 'amber kettle', 'envsentinel', '1234567890', 'olduser', 'example.com', '0612345678', 'Fixturebot']

  it.each([[[]], [['--json']]])('default --all output %j carries none of the fixture owner text or .env values', (extra) => {
    const { out } = cli('--dry-run', '--root', root, '--home', HOME_FIX(), '--all', ...(extra as string[]))
    expect(out.length).toBeGreaterThan(500)
    for (const s of FORBIDDEN) expect(out, s).not.toContain(s)
  })

  it('--excerpts shows the finding lines, masked and flagged as not for a PR (the positive control)', () => {
    const { out } = cli('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', 'chief', '--excerpts')
    expect(out).toContain('EXCERPTS ON: owner-zone text below (findings masked, diff context verbatim); not for a PR description')
    expect(out).toContain('      | Read the X-Memory-Search header. OZSENTINEL-chief-3 call <masked> or mail <masked>\n')
    // line 8 is longer than 160 code points: cut, so its trailing sentinel is not shown
    expect(out).toMatch(/\n      \| curl -s -H "Authorization: Bearer \$\(cat [^\n]*\.\.\.\n/)
    for (const s of ['0612345678', 'example.com', 'envsentinel', 'OZSENTINEL-chief-1', 'OZSENTINEL-chief-2']) expect(out).not.toContain(s)
    const j = JSON.parse(cli('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', 'chief', '--excerpts', '--json').out)
    expect(j.excerpts).toBe(true)
    const xms = j.agents[0].ownerZone.findings.find((f: { pattern: string }) => f.pattern === 'x-memory-search')
    expect(xms.excerpt).toBe('Read the X-Memory-Search header. OZSENTINEL-chief-3 call <masked> or mail <masked>')
  })
})

describe('usage', () => {
  it.each([
    [[], '--dry-run is required'],
    [['--root', '/'], '--dry-run is required'],
    [['--dry-run', '--all'], '--root is required'],
    [['--dry-run', '--root'], '--root needs a value'],
    [['--dry-run', '--root', '/', '--all', '--agent', 'x'], 'exactly one of'],
    [['--dry-run', '--root', '/'], 'exactly one of'],
    [['--dry-run', '--root', '/', '--all', '--write'], 'unknown argument: "--write"'],
    [['--dry-run', '--root', '/nonexistent-dry-run-root', '--all'], '--root is not a directory'],
  ])('%j -> exit 2', (argv, msg) => {
    const r = cli(...(argv as string[]))
    expect(r.code).toBe(2)
    expect(r.err).toContain(msg as string)
    expect(r.err).toContain('usage: cli.js --dry-run --root <dir>')
    expect(r.out).toBe('')
  })

  it.each(['nobody', 'hidden-one', 'alias', 'chief/../alpha', 'Alpha'])('unknown agent %s -> exit 2', (name) => {
    const r = cli('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', name)
    expect(r.code).toBe(2)
    expect(r.err).toContain('unknown agent')
  })

  it('a relative --root is resolved against the working directory', () => {
    const rel = relative(process.cwd(), root)
    const j = JSON.parse(cli('--dry-run', '--root', rel, '--home', HOME_FIX(), '--agent', 'alpha', '--json').out)
    expect(j.root).toBe(root)
  })
})

// ---- C1 PR 8b: context, region, diff -------------------------------------

type Report = ReturnType<typeof agentOf> & {
  context?: { assumptions: string[]; assumedRendered: Record<string, unknown> }
  after?: { file: number; region: number; regionLength: number; overBudget: boolean; removedBlocks: string[] }
  diff?: string
}
const report = (data: { agents: { name: string }[] }, name: string) => agentOf(data, name) as Report

// What composeClaudeMd would write, computed here from the same public pieces.
function expected(r: string, name: string, file: string): string {
  const region = renderRegion(buildLiveContext(r, name, { homeDir: HOME_FIX() }).ctx)
  return composeClaudeMd(readFileSync(join(r, file), 'utf-8'), region).text
}

let applySeq = 0
// The full diff (--excerpts --show-chat-id), applied by git in a scratch dir that
// is no repository, must give exactly what composeClaudeMd writes.
function applied(r: string, file: string, diff: string): string {
  const dir = join(base, `apply-${applySeq++}`)
  mkdirSync(dirname(join(dir, file)), { recursive: true })
  writeFileSync(join(dir, file), readFileSync(join(r, file)))
  writeFileSync(join(dir, 'p.diff'), diff)
  const g = spawnSync('git', ['apply', '--whitespace=nowarn', 'p.diff'], {
    cwd: dir, encoding: 'utf-8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CEILING_DIRECTORIES: dirname(dir), HOME: dir },
  })
  if (g.status !== 0) throw new Error(`git apply: ${g.stderr}`)
  return readFileSync(join(dir, file), 'utf-8')
}

describe('PR 8b: the region diff', () => {
  it.each([['chief', 'CLAUDE.md'], ['alpha', 'agents/alpha/CLAUDE.md']])('%s: the full diff applies and gives what composeClaudeMd writes', (name, file) => {
    const { data } = json('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', name, '--excerpts', '--show-chat-id')
    const r = report(data, name)
    expect(r.diff?.startsWith(`--- a/${file}\n+++ b/${file}\n@@ `)).toBe(true)
    expect(applied(root, file, r.diff as string)).toBe(expected(root, name, file))
  })

  it('after: chars of the composed file and the region, the budget unit of the goldens, the removed blocks', () => {
    const r = report(json('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', 'alpha').data, 'alpha')
    const region = renderRegion(buildLiveContext(root, 'alpha', { homeDir: HOME_FIX() }).ctx)
    const text = expected(root, 'alpha', 'agents/alpha/CLAUDE.md')
    expect(r.after).toEqual({
      file: [...text].length, region: [...region].length, regionLength: region.length, overBudget: false,
      removedBlocks: ['fleet-roster', 'autonomy-wiring'],
    })
    const chief = report(json('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', 'chief').data, 'chief')
    expect(chief.after?.removedBlocks).toEqual(['evidence-rule', 'federation'])
  })

  it('the default diff has no owner line and no context; old blocks removed, the region added', () => {
    const r = report(json('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', 'alpha').data, 'alpha')
    const lines = (r.diff as string).split('\n')
    expect(lines.filter((l) => l.startsWith(' '))).toEqual([])
    const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1).replace(/\r$/, ''))
    expect(removed.filter((l) => l.trim() !== '')).toEqual([
      '<!-- BEGIN GENERATED: fleet-roster (auto-generated, do not edit by hand) -->', '- chief', '- beta',
      '<!-- END GENERATED: fleet-roster -->',
      '<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->',
      'Generated autonomy text with curl -s http://localhost:3420/api/approvals inside a block.',
      '<!-- END GENERATED: autonomy-wiring -->',
    ])
    expect(lines).toContain('+<!-- BEGIN MARVEEN GENERATED v2 (do not edit; source: src/web/claude-md) -->')
    expect(lines).toContain('+<!-- END MARVEEN GENERATED v2 -->')
  })

  it('chat_id is masked by default and shown with --show-chat-id', () => {
    const masked = cli('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', 'chief').out
    expect(masked).toContain('(chat_id <chat_id masked>)')
    expect(masked).not.toContain('1234567890')
    expect(cli('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', 'chief', '--show-chat-id').out).toContain('(chat_id 1234567890)')
  })

  it('a changed owner line (the final newline added) is a placeholder by default, verbatim with --excerpts', () => {
    const r2 = join(base, 'no-eol')
    mkdirSync(join(r2, 'agents', 'zed'), { recursive: true })
    writeFileSync(join(r2, '.env'), 'MAIN_AGENT_ID=chief\n')
    writeFileSync(join(r2, 'CLAUDE.md'), '# chief\n')
    writeFileSync(join(r2, 'agents', 'zed', 'CLAUDE.md'), '# Zed\nlast owner line OZSENTINEL-zed')
    const d = report(json('--dry-run', '--root', r2, '--home', HOME_FIX(), '--agent', 'zed').data, 'zed').diff as string
    expect(d).toContain('\n-<owner line 2, text not shown>\n\\ No newline at end of file\n+<owner line 2, text not shown>\n+\n+<!-- BEGIN MARVEEN')
    expect(d).not.toContain('OZSENTINEL')
    const full = report(json('--dry-run', '--root', r2, '--home', HOME_FIX(), '--agent', 'zed', '--excerpts').data, 'zed').diff as string
    expect(full).toContain('-last owner line OZSENTINEL-zed\n\\ No newline at end of file\n+last owner line OZSENTINEL-zed\n')
    expect(applied(r2, 'agents/zed/CLAUDE.md', full)).toBe(expected(r2, 'zed', 'agents/zed/CLAUDE.md'))
  })

  it('a BOM rides on line 1 of both sides, so a hunk that reaches line 1 still applies', () => {
    const r2 = join(base, 'bom')
    mkdirSync(join(r2, 'agents', 'bo'), { recursive: true })
    writeFileSync(join(r2, '.env'), 'MAIN_AGENT_ID=chief\n')
    writeFileSync(join(r2, 'CLAUDE.md'), '# chief\n')
    writeFileSync(join(r2, 'agents', 'bo', 'CLAUDE.md'), '\ufeff# Bo\n')
    const full = report(json('--dry-run', '--root', r2, '--home', HOME_FIX(), '--agent', 'bo', '--excerpts').data, 'bo').diff as string
    expect(full).toContain('\n \ufeff# Bo\n+\n+<!-- BEGIN MARVEEN')
    expect(applied(r2, 'agents/bo/CLAUDE.md', full)).toBe(expected(r2, 'bo', 'agents/bo/CLAUDE.md'))
  })
})

describe('PR 8b: assumptions, per agent, never silent (Kevin 12995)', () => {
  it('lists every assumption; the rendered ones with the value used', () => {
    const { data } = json('--dry-run', '--root', root, '--home', HOME_FIX(), '--all')
    for (const name of ['chief', 'alpha']) {
      const r = report(data, name)
      expect(r.context?.assumedRendered).toEqual({ 'profile.helperAllowed': true })
      expect(r.context?.assumptions).toEqual(buildLiveContext(root, name, { homeDir: HOME_FIX() }).assumptions)
      expect(r.context?.assumptions).toContain('profile.helperAllowed')
    }
    for (const name of ['beta', 'delta', 'gamma']) expect(report(data, name).context).toBeUndefined()
    const out = cli('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', 'alpha').out
    expect(out).toContain('  assumed, rendered: profile.helperAllowed=true (simplified deny-rule reading; the dashboard passes agentUsesApiHelper)\n')
    expect(out).toContain('  assumed, not rendered: capabilities.browser, capabilities.emailSend, capabilities.thinChief, profile.id, tokenPath\n')
  })

  it('a settings layer that does not parse makes profile.strict an assumption too, shown with its value', () => {
    const r2 = join(base, 'bad-settings')
    mkdirSync(join(r2, 'agents', 'kay', '.claude'), { recursive: true })
    writeFileSync(join(r2, '.env'), 'MAIN_AGENT_ID=chief\n')
    writeFileSync(join(r2, 'CLAUDE.md'), '# chief\n')
    writeFileSync(join(r2, 'agents', 'kay', 'CLAUDE.md'), '# Kay\n')
    writeFileSync(join(r2, 'agents', 'kay', '.claude', 'settings.local.json'), '{ not json')
    const r = report(json('--dry-run', '--root', r2, '--home', HOME_FIX(), '--agent', 'kay').data, 'kay')
    expect(r.context?.assumedRendered).toEqual({ 'profile.helperAllowed': false, 'profile.strict': false })
    expect(cli('--dry-run', '--root', r2, '--home', HOME_FIX(), '--agent', 'kay').out)
      .toContain('profile.strict=false (a settings layer above the deciding one does not parse)')
  })

  it('a context that cannot be built is status error with the reason, exit 1; the other files still report', () => {
    const r2 = join(base, 'bad-autonomy')
    mkdirSync(join(r2, 'store'), { recursive: true })
    mkdirSync(join(r2, 'agents', 'kay'), { recursive: true })
    writeFileSync(join(r2, '.env'), 'MAIN_AGENT_ID=chief\n')
    writeFileSync(join(r2, 'CLAUDE.md'), '# chief\n')
    writeFileSync(join(r2, 'agents', 'kay', 'CLAUDE.md'), '```\nopen fence\n')
    writeFileSync(join(r2, 'store', 'autonomy-config.json'), '{ broken')
    const { code, data } = json('--dry-run', '--root', r2, '--home', HOME_FIX(), '--all')
    expect(code).toBe(1)
    const chief = report(data, 'chief')
    expect(chief.status).toBe('error')
    expect(chief.error?.message).toBe(`LiveContextError: ${join(r2, 'store', 'autonomy-config.json')}: not valid JSON`)
    expect(report(data, 'kay').status).toBe('refused')
    // an error alone (no refused file in the run) gives exit 1 too
    const only = cli('--dry-run', '--root', r2, '--home', HOME_FIX(), '--agent', 'chief')
    expect(only.code).toBe(1)
    expect(only.out).toContain('  error: CLAUDE.md: LiveContextError: ')
    expect(cli('--dry-run', '--root', r2, '--home', HOME_FIX(), '--all').out)
      .toContain('summary: 2 agent(s): 0 ok, 1 refused, 0 unreadable, 1 error, 0 missing; exit 1\n')
  })

  it('an over-budget region is flagged in the text report', () => {
    const r = report(json('--dry-run', '--root', root, '--home', HOME_FIX(), '--agent', 'alpha').data, 'alpha')
    const fake = { root, mainAgentId: 'chief', agents: [{ ...r, after: { ...r.after, regionLength: 5501, overBudget: true } }] }
    expect(formatText(fake as never)).toContain('(5501 of the 5500 budget, OVER BUDGET)')
  })

  it('--home must be absolute', () => {
    const r = cli('--dry-run', '--root', root, '--home', 'rel/home', '--all')
    expect(r.code).toBe(2)
    expect(r.err).toContain('--home must be an absolute path')
  })
})

// Ron S2 / Kevin 13030: the fork is public; the PR text is made with --redact-names.
describe('--redact-names', () => {
  let r3: string
  beforeAll(() => {
    // Sentinel names, and a sentinel directory in the root path.
    r3 = join(base, 'rootsentinelxq', 'install')
    mkdirSync(join(r3, 'agents', 'zzsentinelagent'), { recursive: true })
    mkdirSync(join(r3, 'agents', 'aasentinelagent'), { recursive: true })
    // Kevin 13039: the configured owner and bot names are masked too, also
    // with a Hungarian suffix glued on. The quotes keep the spaces (env-parse.ts);
    // live-context.ts trims them, so the redactor must too.
    writeFileSync(join(r3, '.env'), 'MAIN_AGENT_ID=chiefsentinelxq\nOWNER_NAME=" ownersentinelxq "\nBOT_NAME=botsentinelxq\n')
    // ...and in any letter case (Ron 13073); the diff context shows this line.
    writeFileSync(join(r3, 'CLAUDE.md'), `# chief\n\nAsk zzsentinelagent or botsentinelxq for ownersentinelxqnak \`curl -s ${r3}/x http://h/api/x\`\n`
      + 'Also ZZSENTINELAGENT, Botsentinelxq, OWNERSENTINELXQ and ChiefSentinelXQ.\n')
    writeFileSync(join(r3, 'agents', 'zzsentinelagent', 'CLAUDE.md'), '# zz\n```\nopen fence\n')
    writeFileSync(join(r3, 'agents', 'aasentinelagent', 'CLAUDE.md'), '# aa\n')
  })
  const SENT = ['zzsentinelagent', 'aasentinelagent', 'chiefsentinelxq', 'rootsentinelxq', 'ownersentinelxq', 'botsentinelxq']

  it.each([[[]], [['--json']], [['--excerpts']], [['--json', '--excerpts']]])('%j: no agent name and no root path', (extra) => {
    const { out } = cli('--dry-run', '--root', r3, '--home', HOME_FIX(), '--all', '--redact-names', ...(extra as string[]))
    for (const s of SENT) expect(out.toLowerCase(), s).not.toContain(s)
    expect(out).toContain('agent-03')
    // the region diff was there to leak from: its identity line
    expect(out).toContain('Owner: <OWNER>.')
  })

  it('numbers the agents main first, then the subs in name order, the same with --agent', () => {
    const t = cli('--dry-run', '--root', r3, '--home', HOME_FIX(), '--all', '--redact-names').out
    expect(t.split('\n')[0]).toBe('claude-md dry-run (read-only), root <ROOT>, main agent agent-01, code unknown')
    expect(t).toContain('\nagent-01 (main) CLAUDE.md: ok\n')
    expect(t).toContain('\nagent-02 (sub) agents/agent-02/CLAUDE.md: ok\n')
    expect(t).toContain('\nagent-03 (sub) agents/agent-03/CLAUDE.md: refused\n')
    expect(t).toContain('  refused: agents/agent-03/CLAUDE.md:2: unclosed code fence')
    const one = JSON.parse(cli('--dry-run', '--root', r3, '--agent', 'zzsentinelagent', '--redact-names', '--json').out)
    expect(one.agents.map((a: { name: string; file: string }) => [a.name, a.file])).toEqual([['agent-03', 'agents/agent-03/CLAUDE.md']])
    expect(one.root).toBe('<ROOT>')
    expect(one.redactNames).toBe(true)
  })

  it('excerpts: a name and the root inside owner text are replaced too', () => {
    const t = cli('--dry-run', '--root', r3, '--home', HOME_FIX(), '--agent', 'chiefsentinelxq', '--redact-names', '--excerpts').out
    expect(t).toContain('      | Ask agent-03 or <BOT> for <OWNER>nak `curl -s <ROOT>/x http://h/api/x`\n')
    // the verbatim diff context carries the same owner line, redacted the same way
    expect(t).toContain('\n Ask agent-03 or <BOT> for <OWNER>nak `curl -s <ROOT>/x http://h/api/x`\n')
    expect(t).toContain('\n Also agent-03, <BOT>, <OWNER> and agent-01.\n')
  })

  it('without the flag the names are printed (the local report)', () => {
    const t = cli('--dry-run', '--root', r3, '--home', HOME_FIX(), '--all', '--excerpts').out
    for (const s of SENT) expect(t).toContain(s)
    expect(t).toContain('Owner: ownersentinelxq.')
  })

  // Today only booleans can be assumed and rendered (profile.strict,
  // profile.helperAllowed); a later string or list value goes through the
  // same redaction, which this pins.
  it('an assumed value that carries a name or the root is redacted too', () => {
    const result = dryRun(r3, 'aasentinelagent', { homeDir: HOME_FIX() })
    const a = result.agents[0]
    expect(a.context).toBeDefined()
    a.context!.assumedRendered = { projectRoot: r3, roster: ['zzsentinelagent', 'botsentinelxq'], 'owner.name': 'ownersentinelxq' }
    const j = formatJson(result, { redactNames: true })
    const t = formatText(result, { redactNames: true })
    for (const s of SENT) {
      expect(j.toLowerCase(), s).not.toContain(s)
      expect(t.toLowerCase(), s).not.toContain(s)
    }
    expect(JSON.parse(j).agents[0].context.assumedRendered).toEqual({ projectRoot: '<ROOT>', roster: ['agent-03', '<BOT>'], 'owner.name': '<OWNER>' })
  })
})

describe('code version (Ron S3)', () => {
  it('reads a 40-hex stamp; anything else or no file is unknown', () => {
    const d = join(base, 'stamp')
    mkdirSync(d)
    writeFileSync(join(d, 'ok'), `${'ab'.repeat(20)}\n`)
    writeFileSync(join(d, 'bad'), 'not a sha\n')
    expect(codeVersion(join(d, 'ok'))).toBe('ab'.repeat(20))
    expect(codeVersion(join(d, 'bad'))).toBe('unknown')
    // hex, but not 40 lowercase digits (Ron 13073: a {4,} mutant survived)
    for (const [f, v] of [['short', 'abcd'], ['h39', 'a'.repeat(39)], ['h41', 'a'.repeat(41)], ['upper', 'AB'.repeat(20)]]) {
      writeFileSync(join(d, f), `${v}\n`)
      expect(codeVersion(join(d, f)), f).toBe('unknown')
    }
    expect(codeVersion(join(d, 'missing'))).toBe('unknown')
  })
})
