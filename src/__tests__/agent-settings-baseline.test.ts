// scripts/hooks/agent-settings-baseline.mjs: the protected baseline's switch tuple (Fork C settings-protect, Ron 17451
// N1 direction, N2-1, N2-4). Its copies of src constants are pinned here, its sender-role policy equals the
// dashboard's, a tuple that names no lock combination is refused, and the node binary rules hold.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, realpathSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
// @ts-expect-error -- plain .mjs hook module, no types
import { parseBaseline, tupleErrors, senderRolePolicyFromGates, policySha256, nodeBinErrors, BASELINE_FORMAT, TUPLE_KEYS, HEARTBEAT_AGENT_ID, UNREADABLE_GATES_POLICY, TMP_ROOT_PREFIXES } from '../../scripts/hooks/agent-settings-baseline.mjs'
// @ts-expect-error -- plain .mjs hook module, no types
import { localRecord, localDifferences, agentDirRows, ownerCredentialRows, isolationObligations, isolationViolations } from '../../scripts/hooks/agent-settings-baseline.mjs'
import { HEARTBEAT_AGENT_ID as SRC_HEARTBEAT, senderRolePolicyOf } from '../web/hooks/sub-inputs.js'
import { UNREADABLE_GATES_POLICY as SRC_UNREADABLE } from '../web/sender-role-gate-store.js'
import { TMP_ROOT_PREFIXES as SRC_TMP } from '../web/tmp-root-prefixes.js'

const tuple = (over: Record<string, unknown> = {}) => ({
  profileId: 'default', profile: { destructiveGate: false, credentialGate: false, secondReviewer: false },
  threadReply: false, browser: false, heartbeat: false, senderRolePolicySha256: null, nodeBin: '/usr/local/bin/node', ...over,
})

let base: string
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-settings-baseline-'))) })
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('copies of src constants', () => {
  it('heartbeat id, the unreadable-gates policy and the tmp roots equal the dashboard\'s', () => {
    expect(HEARTBEAT_AGENT_ID).toBe(SRC_HEARTBEAT)
    expect(UNREADABLE_GATES_POLICY).toBe(SRC_UNREADABLE)
    expect([...TMP_ROOT_PREFIXES]).toEqual([...SRC_TMP])
  })
})

describe('parseBaseline', () => {
  it('accepts the format, refuses anything else without echoing it', () => {
    expect(parseBaseline(JSON.stringify({ format: BASELINE_FORMAT, isolated: [], agents: {} })).agents).toEqual({})
    expect(() => parseBaseline('{')).toThrow('baseline: not JSON')
    expect(() => parseBaseline(JSON.stringify({ format: 'x', isolated: [], agents: {} }))).toThrow('baseline: unknown format')
    expect(() => parseBaseline(JSON.stringify({ format: BASELINE_FORMAT, isolated: [], agents: [] }))).toThrow('baseline: unknown format')
  })
  it('K4: a missing or malformed isolated list is refused, never read as "nobody is isolated"', () => {
    expect(() => parseBaseline(JSON.stringify({ format: BASELINE_FORMAT, agents: {} }))).toThrow('baseline: no valid isolated list')
    for (const isolated of [{}, 'sally', [1], ['../x'], [''], null]) {
      expect(() => parseBaseline(JSON.stringify({ format: BASELINE_FORMAT, isolated, agents: {} }))).toThrow('baseline: no valid isolated list')
    }
    expect(parseBaseline(JSON.stringify({ format: BASELINE_FORMAT, isolated: ['sally'], agents: {} })).isolated).toEqual(['sally'])
  })
})

describe('tupleErrors (N2-4: no lock combination, no default fallback)', () => {
  it('a full tuple is usable', () => {
    expect(tupleErrors(tuple(), 'stuart')).toEqual([])
    expect(tupleErrors(tuple({ heartbeat: true }), 'heartbeat')).toEqual([])
    expect(tupleErrors(tuple({ senderRolePolicySha256: 'a'.repeat(64) }), 'stuart')).toEqual([])
    expect([...TUPLE_KEYS].sort()).toEqual(Object.keys(tuple()).sort())
  })
  it('a missing key, an extra key, a non-boolean, an unknown profile switch, a bad id, a heartbeat off its name', () => {
    const { browser: _b, ...missing } = tuple()
    const cases: Array<[unknown, string]> = [
      [missing, 'the switch tuple does not have exactly the known keys'],
      [tuple({ extra: 1 }), 'the switch tuple does not have exactly the known keys'],
      [tuple({ threadReply: 'yes' }), 'threadReply: not a boolean'],
      [tuple({ profile: { destructiveGate: false, credentialGate: false } }), 'profile: not exactly the three gate switches'],
      [tuple({ profile: { destructiveGate: 1, credentialGate: false, secondReviewer: false } }), 'profile.destructiveGate: not a boolean'],
      [tuple({ profileId: '../x' }), 'profileId: not a plain profile id'],
      [tuple({ heartbeat: true }), 'heartbeat: does not follow the agent name'],
      [tuple({ senderRolePolicySha256: 'abc' }), 'senderRolePolicySha256: not a sha256 or null'],
      [tuple({ nodeBin: 1 }), 'nodeBin: not a string'],
      [null, 'the switch tuple is not an object'],
    ]
    for (const [t, why] of cases) expect(tupleErrors(t, 'stuart'), why).toContain(why)
    expect(tupleErrors(tuple({ heartbeat: false }), 'heartbeat')).toEqual(['heartbeat: does not follow the agent name'])
  })
})

describe('senderRolePolicyFromGates equals the dashboard\'s senderRolePolicyOf', () => {
  const cases: Array<[string, string | null]> = [
    ['no file', null],
    ['not JSON', '{'],
    ['not an object', '[1]'],
    ['agent absent', '{"other":{"allowTools":["x"]}}'],
    ['gate off (riskyTools [])', '{"stuart":{"riskyTools":[]}}'],
    ['gate off (no keys)', '{"stuart":{}}'],
    ['gate on (allowTools)', '{"stuart":{"allowTools":["Bash"],"note":"ü"}}'],
    ['gate on (riskyTools)', '{"stuart":{"riskyTools":["Bash"]}}'],
    ['gate on (not an object)', '{"stuart":true}'],
  ]
  for (const [label, text] of cases) {
    it(label, () => {
      const root = join(base, label.replace(/\W+/g, '-'))
      mkdirSync(join(root, 'store'), { recursive: true })
      if (text !== null) writeFileSync(join(root, 'store', 'agent-sender-role-gates.json'), text)
      expect(senderRolePolicyFromGates(text, 'stuart')).toBe(senderRolePolicyOf(root, 'stuart'))
    })
  }
  it('policySha256: null for no policy, a sha256 otherwise', () => {
    expect(policySha256(null)).toBeNull()
    expect(policySha256('abc')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('nodeBinErrors (N2-1)', () => {
  type St = { mode: number }
  const fakeFs = (modes: Record<string, number>, real: Record<string, string> = {}) => ({
    realpathSync: (p: string) => { if (p in real) return real[p]; if (p in modes) return p; throw new Error('ENOENT') },
    lstatSync: (p: string): St => { if (p in modes) return { mode: modes[p] }; throw new Error('ENOENT') },
  })
  const okTree = { '/': 0o40755, '/usr': 0o40755, '/usr/local': 0o40755, '/usr/local/bin': 0o40755, '/usr/local/bin/node': 0o100755 }
  it('a root-owned, non-writable path is fine', () => {
    expect(nodeBinErrors('/usr/local/bin/node', '/srv/inst', fakeFs(okTree))).toEqual([])
  })
  it('relative, not normalised, under agents/, under a tmp root, resolving into one, missing', () => {
    expect(nodeBinErrors('node', '/srv/inst', fakeFs(okTree))).toEqual(['nodeBin: not an absolute normalised path'])
    expect(nodeBinErrors('/usr/local/../local/bin/node', '/srv/inst', fakeFs(okTree))).toEqual(['nodeBin: not an absolute normalised path'])
    expect(nodeBinErrors('/srv/inst/agents/x/node', '/srv/inst', fakeFs(okTree))).toEqual(['nodeBin: under the install\'s agents/'])
    for (const t of TMP_ROOT_PREFIXES) expect(nodeBinErrors(`${t}x/node`, '/srv/inst', fakeFs(okTree))).toEqual(['nodeBin: under a tmp root'])
    expect(nodeBinErrors('/usr/local/bin/node', '/srv/inst', fakeFs(okTree, { '/usr/local/bin/node': '/tmp/evil/node' }))).toEqual(['nodeBin: resolves under a tmp root'])
    expect(nodeBinErrors('/opt/none/node', '/srv/inst', fakeFs(okTree))).toEqual(['nodeBin: does not resolve'])
  })
  it('a group- or world-writable file or directory on the real path', () => {
    expect(nodeBinErrors('/usr/local/bin/node', '/srv/inst', fakeFs({ ...okTree, '/usr/local/bin/node': 0o100775 }))).toEqual(['nodeBin: the file is group- or world-writable'])
    expect(nodeBinErrors('/usr/local/bin/node', '/srv/inst', fakeFs({ ...okTree, '/usr/local': 0o40777 }))).toEqual(['nodeBin: a directory on its path is group- or world-writable'])
    expect(nodeBinErrors('/usr/local/bin/node', '/srv/inst', fakeFs({ ...okTree, '/': 0o41777 }))).toEqual(['nodeBin: a directory on its path is group- or world-writable'])
  })
})

describe('localRecord / localDifferences (K3 (e): name the change, never a value)', () => {
  const text = `${JSON.stringify({ env: { GH_CONFIG_DIR: '/srv/i/agents/a/.config/gh' }, claudeMdExcludes: ['x'], permissions: { deny: ['Read(//srv/i/agents/sally/**)', 'Bash(*agents/sally*)'] } })}\n`
  it('records the hash of the exact bytes, the deny rows, the top keys and env key NAMES only', () => {
    const r = localRecord(text)
    expect(r.sha256).toBe(createHash('sha256').update(text).digest('hex'))
    expect(r).toEqual({ sha256: r.sha256, denyRows: ['Read(//srv/i/agents/sally/**)', 'Bash(*agents/sally*)'], envKeys: ['GH_CONFIG_DIR'], topKeys: ['claudeMdExcludes', 'env', 'permissions'] })
    expect(JSON.stringify(r)).not.toContain('.config/gh')
    expect(localRecord(null)).toEqual({ sha256: null })
    expect(localRecord('not json')).toMatchObject({ denyRows: [], envKeys: [], topKeys: [] })
  })
  it('a removed deny row comes first, then added rows, keys and env key names; a value change names nothing', () => {
    const rec = localRecord(text)
    const now = { claudeMdExcludes: ['x'], permissions: { deny: ['Bash(*agents/sally*)', 'Read(//etc/**)'] }, statusLine: {} }
    expect(localDifferences(rec, now)).toEqual([
      'deny row removed: Read(//srv/i/agents/sally/**)',
      'deny row added: Read(//etc/**)',
      'key added: statusLine',
      'key removed: env',
      'env key removed: GH_CONFIG_DIR',
    ])
    expect(localDifferences(rec, { ...JSON.parse(text), env: { GH_CONFIG_DIR: '/elsewhere' } })).toEqual([])
    expect(localDifferences({ sha256: rec.sha256 }, now)).toEqual([])
  })
})

describe('K4 isolation rows', () => {
  const AGENTS = ['andras', 'bella', 'dennis', 'hanry', 'kevin', 'lilla', 'margot', 'mily', 'neo', 'ron', 'sally', 'stuart', 'tom']
  const set = { installDir: '/root/marveen', home: '/root', agents: AGENTS, isolated: ['sally'] }
  it("rebuilds the isolated agent's 76 measured rows exactly (Johnny 17513: count + sha256 of the sorted rows)", () => {
    const rows = isolationObligations('sally', set).map((o: { row: string }) => o.row)
    expect(rows).toHaveLength(76)
    expect(new Set(rows).size).toBe(76)
    const sorted = [...rows].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    expect(createHash('sha256').update(`${sorted.join('\n')}\n`).digest('hex')).toBe('97498d942b7205ea537e13ae8472c8915bd3b824e12b3511d4f1124f33235706')
  })
  it("a not-isolated agent owes exactly the four rows measured in kevin's file (Kevin 17512)", () => {
    expect(isolationObligations('kevin', set).map((o: { row: string }) => o.row)).toEqual([
      'Read(//root/marveen/agents/sally/**)', 'Edit(//root/marveen/agents/sally/**)', 'Write(//root/marveen/agents/sally/**)', 'Bash(*agents/sally*)',
    ])
  })
  it('the rows follow the install dir and home, not a hardcoded /root/marveen', () => {
    expect(agentDirRows('/srv/inst/', 'x')).toEqual(['Read(//srv/inst/agents/x/**)', 'Edit(//srv/inst/agents/x/**)', 'Write(//srv/inst/agents/x/**)', 'Bash(*agents/x*)'])
    const cred = ownerCredentialRows('/srv/inst', '/home/o')
    expect(cred).toContain('Read(//home/o/.gmail-mcp/**)')
    expect(cred).toContain('Bash(*/srv/inst/store/browser*)')
    expect(cred.join('\n')).not.toContain('/root')
  })
  it('violations name the agent, the row and why; nobody isolated means nothing owed', () => {
    expect(isolationViolations('kevin', ['Read(//root/marveen/agents/sally/**)'], set)).toEqual([
      'kevin: missing deny row Edit(//root/marveen/agents/sally/**) (sally is isolated)',
      'kevin: missing deny row Write(//root/marveen/agents/sally/**) (sally is isolated)',
      'kevin: missing deny row Bash(*agents/sally*) (sally is isolated)',
    ])
    expect(isolationViolations('sally', [], set)).toHaveLength(76)
    expect(isolationViolations('kevin', [], { ...set, isolated: [] })).toEqual([])
    expect(isolationViolations('kevin', 'not a list', set)).toHaveLength(4)
  })
})
