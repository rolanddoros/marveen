import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  lstatSync,
  rmSync,
  symlinkSync,
  chmodSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { tmpdir, userInfo } from 'node:os'
import { join, relative } from 'node:path'
import {
  assertPlainBundleTree,
  importAgentBundle,
  importAllAgentsBundle,
  BUNDLE_SCHEMA_VERSION,
} from '../web/agent-bundle.js'

// Fork kanban ab15088d (Ron 17743, plan approve 17832): both bundle importers
// refuse an extracted tree holding a symlink, a special file or a
// setuid/setgid/sticky entry, BEFORE they read, delete or copy anything.
// Every bundle is built here (staging dir + host tar, or a hand-made tar for
// the hardlink case) and installed into a temp tree through resolveDest.

const IS_ROOT = userInfo().uid === 0

let tmp: string
let outside: string
let install: string
const resolveDest = (name: string): string => join(install, name)

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bundle-symlink-test-'))
  outside = join(tmp, 'outside')
  install = join(tmp, 'install')
  mkdirSync(outside, { recursive: true })
  mkdirSync(install, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET-4410')
})
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
}

function link(stage: string, rel: string, target: string): void {
  mkdirSync(join(stage, rel, '..'), { recursive: true })
  symlinkSync(target, join(stage, rel))
}

// A single-agent staging dir: manifest.json + agent/<files>.
function agentStage(name: string, files: Record<string, string> = { 'CLAUDE.md': '# Agent' }): string {
  const stage = mkdtempSync(join(tmp, 'stage-'))
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify({
    schemaVersion: BUNDLE_SCHEMA_VERSION, agentName: name, includesSecrets: false,
  }))
  writeFiles(join(stage, 'agent'), files)
  return stage
}

// A fleet staging dir: manifest.json (kind fleet) + agents/<name>/<files>.
function fleetStage(agents: Record<string, Record<string, string>>): string {
  const stage = mkdtempSync(join(tmp, 'stage-'))
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify({
    schemaVersion: BUNDLE_SCHEMA_VERSION, kind: 'fleet', agents: Object.keys(agents), includesSecrets: false,
  }))
  mkdirSync(join(stage, 'agents'), { recursive: true })
  for (const [name, files] of Object.entries(agents)) writeFiles(join(stage, 'agents', name), files)
  return stage
}

// Pack every top-level entry of the staging dir with the host tar (links stay links).
function pack(stage: string): Buffer {
  const out = join(tmp, `bundle-${Math.random().toString(36).slice(2)}.tar.gz`)
  execFileSync('tar', ['-czf', out, '-C', stage, ...readdirSync(stage)])
  return readFileSync(out)
}

function sha(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

// Every entry under <dir> with its type and, for files, its content hash.
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      const st = lstatSync(p)
      const rel = relative(dir, p)
      if (st.isSymbolicLink()) out[rel] = 'link'
      else if (st.isDirectory()) { out[rel] = 'dir'; walk(p) } else out[rel] = `file:${sha(p)}`
    }
  }
  walk(dir)
  return out
}

function installedEntries(): string[] {
  return readdirSync(install)
}

// An installed agent that a refused bundle with overwrite:true must leave byte-identical.
function existingAgent(name: string): Record<string, string> {
  writeFiles(join(install, name), {
    'CLAUDE.md': `# ${name} original`,
    'agent-config.json': '{"model":"claude-sonnet-5"}',
    '.claude/skills/keep/SKILL.md': 'keep me',
    'memory/MEMORY.md': 'original memory',
  })
  return snapshot(join(install, name))
}

function expectIntact(name: string, before: Record<string, string>): void {
  expect(lstatSync(join(install, name)).isDirectory()).toBe(true)
  expect(snapshot(join(install, name))).toEqual(before)
}

describe('agent bundle: symlink entries are refused before anything is read or installed', () => {
  it.each([
    ['absolute target', 'agent/evil', '/etc'],
    ['outward relative target', 'agent/skills/x', '../../../outside'],
    ['inward target (any link is refused)', 'agent/inward', 'CLAUDE.md'],
    ['dangling link', 'agent/dangling', '/nonexistent-ab15088d/none'],
    ['link deep in a hidden dir', 'agent/.claude/skills/x', '/etc'],
    ['deeply nested link', 'agent/a/b/c/evil', '/etc'],
  ])('%s', (_label, rel, target) => {
    const stage = agentStage('vera', { 'CLAUDE.md': '# Agent', '.claude/settings.json': '{}', 'a/b/c/keep.md': 'k' })
    link(stage, rel, target)
    expect(() => importAgentBundle(pack(stage), { resolveDest }))
      .toThrow(`Invalid bundle: symlink entry ${rel}`)
    expect(installedEntries()).toEqual([])
  })

  it('a linked agent-config.json (C3): refused before sanitize, the outside content lands nowhere', () => {
    // A machine key makes sanitize rewrite the file: run before the check, it
    // would replace the link with the outside content and the import would pass.
    const canary = join(outside, 'cfg.json')
    const canaryText = JSON.stringify({ remoteHost: 'canary-host', model: 'OUTSIDE-CANARY-7731' })
    writeFileSync(canary, canaryText)
    const stage = agentStage('vera')
    link(stage, 'agent/agent-config.json', canary)
    expect(() => importAgentBundle(pack(stage), { resolveDest }))
      .toThrow('Invalid bundle: symlink entry agent/agent-config.json')
    expect(installedEntries()).toEqual([])
    expect(readFileSync(canary, 'utf-8')).toBe(canaryText)
  })

  it('agent/ itself a link to an outside dir (C2): refused, dest not created', () => {
    writeFiles(join(outside, 'agentdir'), { 'CLAUDE.md': '# outside agent' })
    const stage = agentStage('vera')
    rmSync(join(stage, 'agent'), { recursive: true })
    link(stage, 'agent', join(outside, 'agentdir'))
    expect(() => importAgentBundle(pack(stage), { resolveDest })).toThrow('Invalid bundle: symlink entry agent')
    expect(installedEntries()).toEqual([])
  })

  it('agent/ a link to an outside FILE: the link error, not the agent/ directory check', () => {
    const stage = agentStage('vera')
    rmSync(join(stage, 'agent'), { recursive: true })
    link(stage, 'agent', join(outside, 'secret.txt'))
    expect(() => importAgentBundle(pack(stage), { resolveDest })).toThrow('Invalid bundle: symlink entry agent')
  })

  it('agent/ itself a link with overwrite (C2): the existing agent stays a real, byte-identical dir', () => {
    const before = existingAgent('vera')
    writeFiles(join(outside, 'agentdir'), { 'CLAUDE.md': '# outside agent' })
    const stage = agentStage('vera')
    rmSync(join(stage, 'agent'), { recursive: true })
    link(stage, 'agent', join(outside, 'agentdir'))
    expect(() => importAgentBundle(pack(stage), { resolveDest, overwrite: true }))
      .toThrow('Invalid bundle: symlink entry agent')
    expectIntact('vera', before)
  })

  it('a linked manifest.json (C7): refused, the name never comes from the outside file', () => {
    writeFileSync(join(outside, 'manifest.json'), JSON.stringify({
      schemaVersion: BUNDLE_SCHEMA_VERSION, agentName: 'outsider', includesSecrets: false,
    }))
    const stage = agentStage('vera')
    rmSync(join(stage, 'manifest.json'))
    link(stage, 'manifest.json', join(outside, 'manifest.json'))
    expect(() => importAgentBundle(pack(stage), { resolveDest })).toThrow('Invalid bundle: symlink entry manifest.json')
    expect(installedEntries()).toEqual([])
  })

  it('a linked manifest.json is refused before it is parsed (an outside non-JSON file)', () => {
    const stage = agentStage('vera')
    rmSync(join(stage, 'manifest.json'))
    link(stage, 'manifest.json', join(outside, 'secret.txt'))
    expect(() => importAgentBundle(pack(stage), { resolveDest })).toThrow('Invalid bundle: symlink entry manifest.json')
  })

  it('overwrite: a refused bundle leaves every file of the existing agent byte-identical', () => {
    const before = existingAgent('vera')
    const stage = agentStage('vera', { 'CLAUDE.md': '# new', 'memory/MEMORY.md': 'new memory' })
    link(stage, 'agent/a/b/c/evil', '/etc')
    expect(() => importAgentBundle(pack(stage), { resolveDest, overwrite: true }))
      .toThrow('Invalid bundle: symlink entry agent/a/b/c/evil')
    expectIntact('vera', before)
  })

  it('a FIFO entry: refused loudly instead of dropped by cpSync', () => {
    const stage = agentStage('vera')
    execFileSync('mkfifo', [join(stage, 'agent', 'pipe')])
    expect(() => importAgentBundle(pack(stage), { resolveDest })).toThrow('Invalid bundle: special file entry agent/pipe')
    expect(installedEntries()).toEqual([])
  })

  it.skipIf(!IS_ROOT)('a char device entry is refused (root only: a non-root tar cannot mknod, so a non-root run reports it as skipped)', () => {
    const stage = agentStage('vera')
    execFileSync('mknod', [join(stage, 'agent', 'null'), 'c', '1', '3'])
    expect(() => importAgentBundle(pack(stage), { resolveDest })).toThrow('Invalid bundle: special file entry agent/null')
    expect(installedEntries()).toEqual([])
  })

  it.skipIf(!IS_ROOT)('a setuid file survives root extraction and is refused (root only: a non-root tar strips the bit, so a non-root run reports it as skipped)', () => {
    const stage = agentStage('vera', { 'CLAUDE.md': '# Agent', 'bin/tool': '#!/bin/sh\n' })
    chmodSync(join(stage, 'agent', 'bin', 'tool'), 0o4755)
    expect(() => importAgentBundle(pack(stage), { resolveDest })).toThrow('Invalid bundle: setuid/setgid entry agent/bin/tool')
    expect(installedEntries()).toEqual([])
  })

  it('an outward hardlink entry stops at extraction (S3) and installs nothing', () => {
    // Hand-made archive: the host tar would rewrite the link name on create.
    for (const linkname of ['../../outside/secret.txt', join(outside, 'secret.txt')]) {
      const bundle = handTar([
        { name: 'manifest.json', type: '0', data: JSON.stringify({ schemaVersion: 1, agentName: 'vera', includesSecrets: false }) },
        { name: 'agent/', type: '5' },
        { name: 'agent/CLAUDE.md', type: '0', data: '# Agent' },
        { name: 'agent/evil', type: '1', linkname },
      ])
      expect(() => importAgentBundle(bundle, { resolveDest })).toThrow('Invalid bundle: could not extract')
      expect(installedEntries()).toEqual([])
    }
    expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).toBe('OUTSIDE-SECRET-4410')
  })

  it('a clean bundle (dot-files included) still imports', () => {
    const files = { 'CLAUDE.md': '# Agent', '.claude/settings.json': '{}', '.claude/skills/s/SKILL.md': 'skill', 'memory/MEMORY.md': 'm' }
    const stage = agentStage('vera', files)
    const res = importAgentBundle(pack(stage), { resolveDest })
    expect(res.name).toBe('vera')
    for (const [rel, content] of Object.entries(files)) {
      expect(readFileSync(join(install, 'vera', rel), 'utf-8')).toBe(content)
    }
  })
})

describe('fleet bundle: refused as a whole', () => {
  it('a link in one agent: the clean sibling is NOT installed either', () => {
    const stage = fleetStage({ vera: { 'CLAUDE.md': '# vera' }, zed: { 'CLAUDE.md': '# zed' } })
    link(stage, 'agents/vera/evil', '/etc')
    expect(() => importAllAgentsBundle(pack(stage), { resolveDest })).toThrow('Invalid bundle: symlink entry agents/vera/evil')
    expect(installedEntries()).toEqual([])
  })

  it('overwrite: every existing agent stays byte-identical after the refusal', () => {
    const beforeVera = existingAgent('vera')
    const beforeZed = existingAgent('zed')
    const stage = fleetStage({ vera: { 'CLAUDE.md': '# new vera' }, zed: { 'CLAUDE.md': '# new zed' } })
    link(stage, 'agents/vera/.claude/skills/x', '/etc')
    expect(() => importAllAgentsBundle(pack(stage), { resolveDest, overwrite: true }))
      .toThrow('Invalid bundle: symlink entry agents/vera/.claude/skills/x')
    expectIntact('vera', beforeVera)
    expectIntact('zed', beforeZed)
  })

  it('agents/<name> itself a link to an outside dir: refused, nothing installed', () => {
    writeFiles(join(outside, 'agentdir'), { 'CLAUDE.md': '# outside agent' })
    const stage = fleetStage({ zed: { 'CLAUDE.md': '# zed' } })
    link(stage, 'agents/vera', join(outside, 'agentdir'))
    expect(() => importAllAgentsBundle(pack(stage), { resolveDest })).toThrow('Invalid bundle: symlink entry agents/vera')
    expect(installedEntries()).toEqual([])
  })

  it('a linked agent-config.json in a fleet agent: refused before sanitize', () => {
    const canary = join(outside, 'cfg.json')
    const canaryText = JSON.stringify({ remoteHost: 'canary-host', model: 'OUTSIDE-CANARY-7731' })
    writeFileSync(canary, canaryText)
    const stage = fleetStage({ vera: { 'CLAUDE.md': '# vera' } })
    link(stage, 'agents/vera/agent-config.json', canary)
    expect(() => importAllAgentsBundle(pack(stage), { resolveDest }))
      .toThrow('Invalid bundle: symlink entry agents/vera/agent-config.json')
    expect(installedEntries()).toEqual([])
    expect(readFileSync(canary, 'utf-8')).toBe(canaryText)
  })

  it('a linked fleet manifest.json is refused before it is parsed', () => {
    const stage = fleetStage({ zed: { 'CLAUDE.md': '# zed' } })
    rmSync(join(stage, 'manifest.json'))
    link(stage, 'manifest.json', join(outside, 'secret.txt'))
    expect(() => importAllAgentsBundle(pack(stage), { resolveDest })).toThrow('Invalid bundle: symlink entry manifest.json')
  })

  it('a FIFO in a fleet agent: refused', () => {
    const stage = fleetStage({ vera: { 'CLAUDE.md': '# vera' }, zed: { 'CLAUDE.md': '# zed' } })
    execFileSync('mkfifo', [join(stage, 'agents', 'zed', 'pipe')])
    expect(() => importAllAgentsBundle(pack(stage), { resolveDest })).toThrow('Invalid bundle: special file entry agents/zed/pipe')
    expect(installedEntries()).toEqual([])
  })

  it('a clean fleet bundle still imports every agent', () => {
    const stage = fleetStage({ vera: { 'CLAUDE.md': '# vera', '.claude/settings.json': '{}' }, zed: { 'CLAUDE.md': '# zed' } })
    const res = importAllAgentsBundle(pack(stage), { resolveDest })
    expect(res.imported.map((i) => i.name).sort()).toEqual(['vera', 'zed'])
    expect(readFileSync(join(install, 'vera', '.claude', 'settings.json'), 'utf-8')).toBe('{}')
    expect(readFileSync(join(install, 'zed', 'CLAUDE.md'), 'utf-8')).toBe('# zed')
  })
})

describe('assertPlainBundleTree on a tree built in place (runs as any user)', () => {
  function tree(): string {
    const root = mkdtempSync(join(tmp, 'tree-'))
    writeFiles(root, { 'manifest.json': '{}', 'agent/CLAUDE.md': '# Agent', 'agent/.claude/settings.json': '{}' })
    return root
  }

  it('a plain tree passes', () => {
    expect(() => assertPlainBundleTree(tree())).not.toThrow()
  })

  it('a setuid file is refused', () => {
    const root = tree()
    writeFiles(root, { 'agent/bin/tool': '#!/bin/sh\n' })
    chmodSync(join(root, 'agent', 'bin', 'tool'), 0o4755)
    expect(() => assertPlainBundleTree(root)).toThrow('Invalid bundle: setuid/setgid entry agent/bin/tool')
  })

  it('a sticky directory is refused', () => {
    const root = tree()
    mkdirSync(join(root, 'agent', 'shared'))
    chmodSync(join(root, 'agent', 'shared'), 0o1777)
    expect(() => assertPlainBundleTree(root)).toThrow('Invalid bundle: setuid/setgid entry agent/shared')
  })

  it('a dangling link at the top level is refused', () => {
    const root = tree()
    symlinkSync('/nonexistent-ab15088d/none', join(root, 'agents'))
    expect(() => assertPlainBundleTree(root)).toThrow('Invalid bundle: symlink entry agents')
  })
})

// --- minimal ustar writer for the hardlink case ---------------------------
interface TarEntry { name: string; type: '0' | '1' | '5'; data?: string; linkname?: string }

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0'
}

function handTar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '')
    const h = Buffer.alloc(512)
    h.write(e.name, 0, 100)
    h.write(octal(e.type === '5' ? 0o755 : 0o644, 8), 100)
    h.write(octal(0, 8), 108)
    h.write(octal(0, 8), 116)
    h.write(octal(e.type === '0' ? data.length : 0, 12), 124)
    h.write(octal(0, 12), 136)
    h.write('        ', 148)
    h.write(e.type, 156)
    if (e.linkname) h.write(e.linkname, 157, 100)
    h.write('ustar\0', 257)
    h.write('00', 263)
    let sum = 0
    for (const b of h) sum += b
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(h)
    if (e.type === '0' && data.length) {
      blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}
