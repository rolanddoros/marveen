// C1 PR 10b, Ron 10b review J4/B2: backupClaudeMd reads both files back and compares them before it returns, so a
// backup that did not land as written (a full disk that truncates, a filesystem that rewrites) throws BackupError
// and the CLAUDE.md is not written. No real filesystem misbehaves on demand, so this file swaps node:fs's
// readFileSync for one that returns other bytes for the backup copy while `corrupt` is set.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { backupClaudeMd, BackupError } from '../web/claude-md/backup.js'

const state = vi.hoisted(() => ({ corrupt: '' as '' | 'copy' | 'manifest' }))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    const real = (fs.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)
    const p = String(path)
    if (state.corrupt === 'copy' && p.includes('claude-md-backup') && p.endsWith('/CLAUDE.md')) {
      return typeof real === 'string' ? `${real}x` : Buffer.concat([real as Buffer, Buffer.from('x')])
    }
    if (state.corrupt === 'manifest' && p.endsWith('/MANIFEST.sha256')) return typeof real === 'string' ? `0${real}` : real
    return real
  }) as typeof fs.readFileSync
  return { ...fs, default: { ...fs, readFileSync }, readFileSync }
})

let store: string
beforeEach(() => { store = mkdtempSync(join(tmpdir(), 'cmd-backup-rb-')) })
afterEach(() => {
  state.corrupt = ''
  rmSync(store, { recursive: true, force: true })
})

const BYTES = Buffer.from('# Kevin\nowner text\n')
const NOW = new Date('2026-11-06T22:43:00Z')

describe('backupClaudeMd reads its files back before it returns', () => {
  it('control: the mock passes the real bytes through when nothing is corrupted', () => {
    const dir = backupClaudeMd(store, 'kevin', BYTES, NOW, 'Europe/Budapest')
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true)
  })

  it('the backup copy reads back with other bytes: BackupError (the caller then writes no CLAUDE.md)', () => {
    state.corrupt = 'copy'
    expect(() => backupClaudeMd(store, 'kevin', BYTES, NOW, 'Europe/Budapest')).toThrow(BackupError)
    expect(() => backupClaudeMd(store, 'kevin', BYTES, NOW, 'Europe/Budapest')).toThrow(/read-back does not match/)
  })

  it('the manifest reads back with other text: BackupError', () => {
    state.corrupt = 'manifest'
    expect(() => backupClaudeMd(store, 'kevin', BYTES, NOW, 'Europe/Budapest')).toThrow(/read-back does not match/)
  })
})
