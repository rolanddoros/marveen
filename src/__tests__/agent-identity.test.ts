// scripts/hooks/agent-identity.mjs: the deploy helper's caller rule (fork deploy-gate plan v3, SEC-1 / V3-1,
// Ron 17068 and 17165). MAIN only on the EXACT flattened-install segment under the root the launcher recorded;
// every other shape is null, which the gate denies. The cases are shared with ledger_lib's Python test
// (scripts/__tests__/fixtures/agent-identity-cases.json): rows not marked gate_only must agree there too.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { identifyTranscript, callerIsMain, loadIdentityContext, readConfigRootRecord, readMainAgentId, isRecordDir, RECORD_REL, RECORD_MODES } from '../../scripts/hooks/agent-identity.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURE = JSON.parse(readFileSync(join(REPO, 'scripts', '__tests__', 'fixtures', 'agent-identity-cases.json'), 'utf8')) as {
  agents: string[]
  cases: { name: string; path: string; record: { mode: string; dir: string } | null; expect: string | null; gate_only?: boolean }[]
}
const MAIN = 'mainagent'

let base: string
let install: string
let home: string

function fill(s: string): string {
  return s.replaceAll('{INSTALL}', install).replaceAll('{FLAT}', install.split('/').join('-')).replaceAll('{HOME}', home)
}

function writeRecord(rec: unknown): void {
  writeFileSync(join(install, RECORD_REL), typeof rec === 'string' ? rec : JSON.stringify(rec))
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-identity-')))
  install = join(base, 'inst')
  home = join(base, 'home')
  mkdirSync(join(install, 'store'), { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  for (const a of FIXTURE.agents) mkdirSync(join(install, 'agents', a), { recursive: true })
  writeFileSync(join(install, '.env'), `OWNER_NAME=x\nMAIN_AGENT_ID=${MAIN}\n`)
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('the shared identity fixture, the gate side', () => {
  it.each(FIXTURE.cases)('$name', (c) => {
    if (c.record) writeRecord({ mode: c.record.mode, dir: fill(c.record.dir) })
    const ctx = loadIdentityContext(install)
    const got = identifyTranscript(fill(c.path), ctx).id
    expect({ case: c.name, got }).toEqual({ case: c.name, got: c.expect === '@MAIN' ? MAIN : c.expect })
  })

  it('has the five launcher modes and covers each of them as MAIN at least once', () => {
    expect(RECORD_MODES).toEqual(['explicit', 'rotated', 'isolated', 'token', 'shared'])
    const mainModes = new Set(FIXTURE.cases.filter((c) => c.expect === '@MAIN').map((c) => c.record?.mode))
    expect([...mainModes].sort()).toEqual([...RECORD_MODES].sort())
  })
})

describe('what the rule reads from the install', () => {
  it('reads MAIN_AGENT_ID from .env only, with no default', () => {
    expect(readMainAgentId(install)).toBe(MAIN)
    writeFileSync(join(install, '.env'), 'OWNER_NAME=x\n')
    expect(readMainAgentId(install)).toBeNull()
    writeFileSync(join(install, '.env'), 'MAIN_AGENT_ID=bad name\n')
    expect(readMainAgentId(install)).toBeNull()
    rmSync(join(install, '.env'))
    expect(readMainAgentId(install)).toBeNull()
  })

  it('without MAIN_AGENT_ID nothing is MAIN, even on the exact root and segment', () => {
    writeRecord({ mode: 'isolated', dir: join(install, '.channels-config') })
    writeFileSync(join(install, '.env'), 'OWNER_NAME=x\n')
    const r = callerIsMain({ transcript_path: fill('{INSTALL}/.channels-config/projects/{FLAT}/s.jsonl') }, install)
    expect(r).toEqual({ main: false, id: null, why: 'no MAIN_AGENT_ID in .env' })
  })

  it('refuses a record that is not JSON, not an object, or carries a bad dir', () => {
    for (const bad of ['', 'not json', '[]', 'null', '{"mode":"isolated"}', '{"mode":"isolated","dir":"/a/\\"b"}', '{"mode":"isolated","dir":"/a/b\\\\c"}', '{"mode":"isolated","dir":"/a/../b"}', `{"mode":"isolated","dir":"/a/b\\u0007"}`]) {
      writeRecord(bad)
      expect({ bad, rec: readConfigRootRecord(install) }).toEqual({ bad, rec: null })
    }
    writeRecord({ mode: 'isolated', dir: '/a/b/', writer: 'channels.sh' })
    expect(readConfigRootRecord(install)).toEqual({ mode: 'isolated', dir: '/a/b', writer: 'channels.sh' })
  })

  it('accepts as a record dir only an absolute, normalised path without quote, backslash or control character', () => {
    expect(['/a', '/a/b', '/a/b/', '/'].map(isRecordDir)).toEqual([true, true, true, true])
    expect(['', 'a/b', '/a/./b', '/a/../b', '/a"b', "/a'b", '/a\\b', '/a\nb', '/a\u0000b', 7, null].map(isRecordDir)).toEqual(
      [false, false, false, false, false, false, false, false, false, false, false],
    )
  })

  it('names the recorded root and its writer when the transcript sits elsewhere', () => {
    writeRecord({ mode: 'explicit', dir: '/srv/main-cfg', writer: 'channel-watchdog.sh' })
    const r = identifyTranscript(fill('{INSTALL}/.channels-config/projects/{FLAT}/s.jsonl'), loadIdentityContext(install))
    expect(r.id).toBeNull()
    expect(r.why).toContain('/srv/main-cfg')
    expect(r.why).toContain('channel-watchdog.sh')
  })

  it('reads the payload path lexically: a symlinked projects dir keeps the sub-agent a sub-agent', () => {
    writeRecord({ mode: 'isolated', dir: join(install, '.channels-config') })
    const shared = join(home, '.claude', 'projects')
    mkdirSync(join(shared, install.split('/').join('-')), { recursive: true })
    mkdirSync(join(install, 'agents', 'iris', '.claude-config'), { recursive: true })
    symlinkSync(shared, join(install, 'agents', 'iris', '.claude-config', 'projects'))
    const p = join(install, 'agents', 'iris', '.claude-config', 'projects', install.split('/').join('-'), 's.jsonl')
    expect(identifyTranscript(p, loadIdentityContext(install)).id).toBe('iris')
  })

  it('reaches the same answer through the install symlink and its real path', () => {
    const link = join(base, 'inst-link')
    symlinkSync(install, link)
    writeRecord({ mode: 'isolated', dir: join(install, '.channels-config') })
    const ctx = loadIdentityContext(link)
    expect(ctx.installs).toEqual([link, install])
    expect(identifyTranscript(join(link, 'agents', 'iris', 'x', 's.jsonl'), ctx).id).toBe('iris')
    expect(identifyTranscript(join(install, '.channels-config', 'projects', install.split('/').join('-'), 's.jsonl'), ctx).id).toBe(MAIN)
  })

  it('denies a payload without transcript_path and never falls back to cwd or MARVEEN_AGENT_ID', () => {
    writeRecord({ mode: 'isolated', dir: join(install, '.channels-config') })
    const prev = process.env.MARVEEN_AGENT_ID
    process.env.MARVEEN_AGENT_ID = MAIN
    try {
      expect(callerIsMain({ cwd: install }, install)).toEqual({ main: false, id: null, why: 'no transcript_path' })
    } finally {
      if (prev === undefined) delete process.env.MARVEEN_AGENT_ID
      else process.env.MARVEEN_AGENT_ID = prev
    }
  })
})
