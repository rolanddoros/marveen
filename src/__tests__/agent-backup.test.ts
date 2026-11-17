// src/web/agent-backup.ts + DELETE /api/agents/<n> (Fork C settings-protect plan v2 point 5, V2-REL-1): the backup
// the agens-torles skill took with tar (now refused by the gate) is taken by the route before the removal, 0600,
// restorable, and a failed backup removes nothing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { agentBackupPath, backupAgentDir } from '../web/agent-backup.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let base: string
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-backup-'))) })
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('backupAgentDir', () => {
  const now = new Date('2026-11-17T21:00:00.123Z')
  it('names the archive after the agent and the UTC time', () => {
    expect(agentBackupPath('/s', 'alpha', now)).toBe('/s/agent-backups/alpha-2026-11-17T21-00-00-123Z.tar.gz')
  })
  it('writes a 0600 archive that restores the directory as it was', async () => {
    const dir = join(base, 'inst', 'agents', 'alpha')
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, 'CLAUDE.md'), 'persona')
    writeFileSync(join(dir, '.claude', 'settings.json'), '{"hooks":{}}')
    const out = await backupAgentDir(dir, join(base, 'inst', 'store'), now)
    expect(out).toBe(agentBackupPath(join(base, 'inst', 'store'), 'alpha', now))
    expect(statSync(out).mode & 0o777).toBe(0o600)
    const restore = join(base, 'restore')
    mkdirSync(restore)
    execFileSync('tar', ['xzf', out, '-C', restore])
    expect(readFileSync(join(restore, 'alpha', 'CLAUDE.md'), 'utf-8')).toBe('persona')
    expect(readFileSync(join(restore, 'alpha', '.claude', 'settings.json'), 'utf-8')).toBe('{"hooks":{}}')
  })
  it('a failing tar throws and leaves no file; an existing target is never overwritten', async () => {
    const store = join(base, 'store')
    await expect(backupAgentDir(join(base, 'agents', 'missing'), store, now)).rejects.toThrow('agent backup: tar failed')
    expect(readdirSync(join(store, 'agent-backups'))).toEqual([])
    const dir = join(base, 'agents', 'beta')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'x'), 'x')
    const out = await backupAgentDir(dir, store, now)
    writeFileSync(out, 'keep')
    await expect(backupAgentDir(dir, store, now)).rejects.toThrow('agent backup: the target file already exists')
    expect(readFileSync(out, 'utf-8')).toBe('keep')
  })
})

describe('DELETE /api/agents/<n> takes the backup before the removal', () => {
  const SRC = readFileSync(join(REPO, 'src', 'web', 'routes', 'agents.ts'), 'utf-8')
  const start = SRC.indexOf("if (agentMatch && method === 'DELETE') {")
  const BLOCK = SRC.slice(start, SRC.indexOf('\n  }\n', start))
  it('backup first, rmSync only after it succeeded, the path in the answer, nothing removed on failure', () => {
    const b = BLOCK.indexOf('backup = await backupAgentDir(dir, STORE_DIR)')
    const rm = BLOCK.indexOf('rmSync(dir, { recursive: true, force: true })')
    expect(b).toBeGreaterThan(0)
    expect(rm).toBeGreaterThan(b)
    expect(BLOCK.slice(b, rm)).toContain('return\n')
    expect(BLOCK.split('rmSync(').length - 1).toBe(1)
    expect(BLOCK).toContain("json(res, { error: `${backupError ?? 'agent backup: failed'}; the agent directory was NOT removed` }, 500)")
    expect(BLOCK).toContain('json(res, { ok: true, backup })')
    expect(BLOCK.indexOf('cleanupTeamReferences(name)')).toBeGreaterThan(BLOCK.indexOf('if (backup === null) {'))
  })
})
