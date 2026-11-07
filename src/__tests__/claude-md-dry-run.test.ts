// C1 PR 8a: the dry-run CLI over a synthetic install tree (fixtures/claude-md/dry-run-tree.ts).
// The read-only proof is claude-md-dry-run-readonly.test.ts; the detectors' unit
// tests and source parity are claude-md-owner-zone.test.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeVersion, runCli } from '../web/claude-md/dry-run-cli.js'
import { DRY_RUN_TREE, writeDryRunTree } from './fixtures/claude-md/dry-run-tree.js'

let base: string
let root: string

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'claude-md-dry-run-'))
  root = join(base, 'install')
  mkdirSync(root)
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
    const { code, data } = json('--dry-run', '--root', root, '--all')
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
    const { data, out } = { ...json('--dry-run', '--root', root, '--all'), out: cli('--dry-run', '--root', root, '--all').out }
    const beta = agentOf(data, 'beta')
    expect(beta.error).toEqual({ message: 'unclosed code fence at EOF: the region would land inside it', line: 11 })
    expect(out).toContain('  refused: agents/beta/CLAUDE.md:11: unclosed code fence at EOF: the region would land inside it\n')
  })

  it('a refused file is still scanned, every line, and marked not segmented', () => {
    const beta = agentOf(json('--dry-run', '--root', root, '--all').data, 'beta')
    expect(beta.ownerZone.segmented).toBe(false)
    expect(beta.ownerZone.findings).toEqual([
      { line: 12, detector: 'curl-recipe', pattern: 'curl-api', flags: ['token-on-argv'] },
      { line: 12, detector: 'dashboard-token', pattern: 'dashboard-token', flags: ['in-curl-recipe'] },
    ])
  })

  it('names a file that is not UTF-8 with line and byte offset', () => {
    const { data, out } = { ...json('--dry-run', '--root', root, '--all'), out: cli('--dry-run', '--root', root, '--all').out }
    expect(agentOf(data, 'delta').error).toEqual({ message: 'not valid UTF-8', line: 3, byteOffset: 6 })
    expect(out).toContain('  refused: agents/delta/CLAUDE.md:3: not valid UTF-8 (byte 6)\n')
  })

  it('a sub-agent without CLAUDE.md is reported as missing, not skipped, and does not fail the run', () => {
    expect(agentOf(json('--dry-run', '--root', root, '--all').data, 'gamma').status).toBe('missing')
    const r = cli('--dry-run', '--root', root, '--agent', 'gamma')
    expect(r.code).toBe(0)
    expect(r.out).toContain('gamma (sub) agents/gamma/CLAUDE.md: missing\n')
  })

  it('an unreadable CLAUDE.md (a directory) is reported and gives exit 1', () => {
    const r2 = join(base, 'unreadable')
    mkdirSync(join(r2, 'agents', 'x', 'CLAUDE.md'), { recursive: true })
    writeFileSync(join(r2, 'CLAUDE.md'), '# main\n')
    const { code, data } = json('--dry-run', '--root', r2, '--all')
    expect(code).toBe(1)
    expect(data.mainAgentId).toBe('marveen') // no .env: the config.ts default
    expect(agentOf(data, 'x').status).toBe('unreadable')
    expect(agentOf(data, 'marveen').status).toBe('ok')
  })

  it('exit 0 when every requested file is accepted', () => {
    expect(cli('--dry-run', '--root', root, '--agent', 'chief').code).toBe(0)
    expect(cli('--dry-run', '--root', root, '--agent', 'alpha').code).toBe(0)
  })
})

describe('legacy inventory and chars', () => {
  it('lists the generated blocks with their BEGIN line and size; a decoy in a fence is owner text', () => {
    const alpha = agentOf(json('--dry-run', '--root', root, '--agent', 'alpha').data, 'alpha')
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
    const chief = agentOf(json('--dry-run', '--root', root, '--agent', 'chief').data, 'chief')
    expect(chief.blocks.map((b) => [b.id, b.line])).toEqual([['evidence-rule', 22], ['federation', 27]])
    const text = DRY_RUN_TREE['CLAUDE.md'].replaceAll('@ROOT@', root)
    expect(chief.chars?.file).toBe([...text].length)
    expect(chief.notes).toEqual([])
  })
})

describe('owner-zone findings', () => {
  it('reports the main fixture exactly; generated blocks are not owner text', () => {
    const chief = agentOf(json('--dry-run', '--root', root, '--agent', 'chief').data, 'chief')
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
    const alpha = agentOf(json('--dry-run', '--root', root, '--agent', 'alpha').data, 'alpha')
    expect(alpha.ownerZone.findings).toEqual([
      { line: 11, detector: 'curl-recipe', pattern: 'curl-api', flags: ['token-on-argv'] },
      { line: 28, detector: 'sniff-literal', pattern: 'auth-szabaly', flags: [] },
    ])
  })

  it('the text report lists findings as file:line, detector, pattern and flags', () => {
    const { out } = cli('--dry-run', '--root', root, '--agent', 'chief')
    expect(out).toContain('    CLAUDE.md:8 curl-recipe curl-api [token-on-argv, raw-q]\n')
    expect(out.split('\n')[0]).toBe(`claude-md dry-run (read-only), root ${root}, main agent chief, code unknown`)
    expect(out).toContain('    CLAUDE.md:14 stale-path /scripts/hooks/\n')
    expect(out).toContain('  block evidence-rule at line 22: ')
  })
})

describe('no owner-zone text in the default output (Kevin 12995)', () => {
  const FORBIDDEN = ['OZSENTINEL', 'amber kettle', 'envsentinel', '1234567890', 'olduser', 'example.com', '0612345678', 'Fixture Owner', 'Fixturebot']

  it.each([[[]], [['--json']]])('default --all output %j carries none of the fixture owner text or .env values', (extra) => {
    const { out } = cli('--dry-run', '--root', root, '--all', ...(extra as string[]))
    expect(out.length).toBeGreaterThan(500)
    for (const s of FORBIDDEN) expect(out, s).not.toContain(s)
  })

  it('--excerpts shows the finding lines, masked and flagged as not for a PR (the positive control)', () => {
    const { out } = cli('--dry-run', '--root', root, '--agent', 'chief', '--excerpts')
    expect(out).toContain('EXCERPTS ON: owner-zone text below, masked; not for a PR description')
    expect(out).toContain('      | Read the X-Memory-Search header. OZSENTINEL-chief-3 call <masked> or mail <masked>\n')
    // line 8 is longer than 160 code points: cut, so its trailing sentinel is not shown
    expect(out).toMatch(/\n      \| curl -s -H "Authorization: Bearer \$\(cat [^\n]*\.\.\.\n/)
    for (const s of ['0612345678', 'example.com', 'envsentinel', 'OZSENTINEL-chief-1', 'OZSENTINEL-chief-2']) expect(out).not.toContain(s)
    const j = JSON.parse(cli('--dry-run', '--root', root, '--agent', 'chief', '--excerpts', '--json').out)
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
    const r = cli('--dry-run', '--root', root, '--agent', name)
    expect(r.code).toBe(2)
    expect(r.err).toContain('unknown agent')
  })

  it('a relative --root is resolved against the working directory', () => {
    const rel = relative(process.cwd(), root)
    const j = JSON.parse(cli('--dry-run', '--root', rel, '--agent', 'alpha', '--json').out)
    expect(j.root).toBe(root)
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
    writeFileSync(join(r3, '.env'), 'MAIN_AGENT_ID=chiefsentinelxq\n')
    writeFileSync(join(r3, 'CLAUDE.md'), `# chief\n\nAsk zzsentinelagent \`curl -s ${r3}/x http://h/api/x\`\n`)
    writeFileSync(join(r3, 'agents', 'zzsentinelagent', 'CLAUDE.md'), '# zz\n```\nopen fence\n')
    writeFileSync(join(r3, 'agents', 'aasentinelagent', 'CLAUDE.md'), '# aa\n')
  })
  const SENT = ['zzsentinelagent', 'aasentinelagent', 'chiefsentinelxq', 'rootsentinelxq']

  it.each([[[]], [['--json']], [['--excerpts']], [['--json', '--excerpts']]])('%j: no agent name and no root path', (extra) => {
    const { out } = cli('--dry-run', '--root', r3, '--all', '--redact-names', ...(extra as string[]))
    for (const s of SENT) expect(out, s).not.toContain(s)
    expect(out).toContain('agent-03')
  })

  it('numbers the agents main first, then the subs in name order, the same with --agent', () => {
    const t = cli('--dry-run', '--root', r3, '--all', '--redact-names').out
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
    const t = cli('--dry-run', '--root', r3, '--agent', 'chiefsentinelxq', '--redact-names', '--excerpts').out
    expect(t).toContain('      | Ask agent-03 `curl -s <ROOT>/x http://h/api/x`\n')
  })

  it('without the flag the names are printed (the local report)', () => {
    const t = cli('--dry-run', '--root', r3, '--all').out
    for (const s of SENT) expect(t).toContain(s)
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
    expect(codeVersion(join(d, 'missing'))).toBe('unknown')
  })
})
