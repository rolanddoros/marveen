// C1 PR 10b: the CLAUDE.md backup before a v2 transition (src/web/claude-md/backup.ts).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { backupClaudeMd, BackupError, backupStamp } from '../web/claude-md/backup.js'

let store: string
beforeEach(() => { store = mkdtempSync(join(tmpdir(), 'cmd-backup-')) })
afterEach(() => { rmSync(store, { recursive: true, force: true }) })

const TEXT = '# Kevin\n\nOwner zone with $& and ékezet, CRLF line\r\n'
const NOW = new Date('2026-11-06T22:43:00Z') // 23:43:00 in Budapest (CET)
// The zone is the caller's (wire.ts passes config.ts APP_TZ, ISSUE1895); these cases pin Budapest explicitly.
const TZ = 'Europe/Budapest'
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8)

describe('backupStamp', () => {
  it('Budapest local time, YYYYMMDD-HHMMSS, across the DST switch', () => {
    expect(backupStamp(NOW, TZ)).toBe('20261106-234300')
    expect(backupStamp(new Date('2026-07-01T10:00:05Z'), TZ)).toBe('20260701-120005')
    expect(backupStamp(new Date('2026-12-31T23:30:00Z'), TZ)).toBe('20270101-003000')
  })

  it('the zone is the one passed in, no built-in default (the install zone, not a literal)', () => {
    expect(backupStamp(NOW, 'UTC')).toBe('20261106-224300')
    expect(backupStamp(NOW, 'America/New_York')).toBe('20261106-174300')
  })
})

describe('backupClaudeMd', () => {
  it('writes the bytes and a sha256sum manifest under <store>/claude-md-backup/<ts>/<agent>, 0700 / 0600', () => {
    const dir = backupClaudeMd(store, 'kevin', TEXT, NOW, TZ)
    expect(dir).toBe(join(store, 'claude-md-backup', '20261106-234300', 'kevin'))
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe(TEXT)
    const digest = createHash('sha256').update(Buffer.from(TEXT, 'utf-8')).digest('hex')
    expect(readFileSync(join(dir, 'MANIFEST.sha256'), 'utf-8')).toBe(`${digest}  CLAUDE.md\n`)
    expect(readdirSync(dir).sort()).toEqual(['CLAUDE.md', 'MANIFEST.sha256'])
    for (const d of [join(store, 'claude-md-backup'), join(store, 'claude-md-backup', '20261106-234300'), dir]) expect(mode(d), d).toBe('700')
    for (const f of ['CLAUDE.md', 'MANIFEST.sha256']) expect(mode(join(dir, f)), f).toBe('600')
  })

  it('the same second twice: the second gets a -1 directory, the first is untouched', () => {
    const a = backupClaudeMd(store, 'kevin', TEXT, NOW, TZ)
    const b = backupClaudeMd(store, 'kevin', 'other\n', NOW, TZ)
    const c = backupClaudeMd(store, 'ron', 'third\n', NOW, TZ)
    expect(b).toBe(join(store, 'claude-md-backup', '20261106-234300-1', 'kevin'))
    expect(c).toBe(join(store, 'claude-md-backup', '20261106-234300-2', 'ron'))
    expect(readFileSync(join(a, 'CLAUDE.md'), 'utf-8')).toBe(TEXT)
  })

  it('an empty file is backed up too', () => {
    const dir = backupClaudeMd(store, 'kevin', '', NOW, TZ)
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe('')
  })

  it('a store that cannot hold the backup throws BackupError', () => {
    const blocked = join(store, 'blocked')
    writeFileSync(blocked, 'a file where the store directory should be')
    expect(() => backupClaudeMd(blocked, 'kevin', TEXT, NOW, TZ)).toThrow(BackupError)
    writeFileSync(join(store, 'claude-md-backup'), 'a file where the backup directory should be')
    expect(() => backupClaudeMd(store, 'kevin', TEXT, NOW, TZ)).toThrow(BackupError)
  })

  it('an agent name with a separator throws before anything is written', () => {
    for (const bad of ['../x', 'a/b', '', '.']) expect(() => backupClaudeMd(store, bad, TEXT, NOW, TZ), bad).toThrow(/not an agent name/)
    expect(existsSync(join(store, 'claude-md-backup'))).toBe(false)
  })
})
