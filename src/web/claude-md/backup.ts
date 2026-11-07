// C1 PR 10b: the CLAUDE.md backup taken before every v2 transition (design 2.6/3).
//
// A transition is a file gaining its v2 region (legacy -> v2) or losing it (a
// rollback, v2 -> legacy). The bytes BEFORE the transition go to
//   <store>/claude-md-backup/<ts>/<agent>/CLAUDE.md
//   <store>/claude-md-backup/<ts>/<agent>/MANIFEST.sha256   ("<sha256>  CLAUDE.md", sha256sum -c format)
// <ts> is the install's local time (the caller passes config.ts APP_TZ:
// SCHEDULER_TZ, else the host zone; ISSUE1895, no zone literal in code),
// YYYYMMDD-HHMMSS, with a -1, -2 ... suffix when
// that directory already exists (claimed with a non-recursive mkdir, so two
// writers never share one). Directories 0700, files 0600: the owner zone can
// hold personal text. Both files are read back and checked before this
// returns; any failure throws BackupError, and the caller then does NOT write
// the CLAUDE.md. Nothing here deletes: no retention in this PR.

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const BACKUP_DIR_NAME = 'claude-md-backup'
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_SUFFIX = 99

export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

// sha256 of the exact bytes (a string is hashed as its UTF-8 bytes).
export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

// YYYYMMDD-HHMMSS in the given time zone.
export function backupStamp(now: Date, tz: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]))
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`
}

function mkdirPrivate(path: string, recursive: boolean): void {
  mkdirSync(path, { recursive, mode: 0o700 })
  chmodSync(path, 0o700)
}

// Writes the backup of `bytes` (the CLAUDE.md bytes before the transition, as read: never a decoded and
// re-encoded string, which would turn an invalid UTF-8 byte into U+FFFD; Ron 10b B1) and returns the
// directory that holds it. Throws BackupError on any failure.
export function backupClaudeMd(storeDir: string, agent: string, bytes: Uint8Array, now: Date, tz: string): string {
  if (!AGENT_RE.test(agent)) throw new BackupError(`not an agent name: ${JSON.stringify(agent)}`)
  try {
    const base = join(storeDir, BACKUP_DIR_NAME)
    mkdirPrivate(base, true)
    const stamp = backupStamp(now, tz)
    let dir = ''
    for (let i = 0; i <= MAX_SUFFIX && dir === ''; i++) {
      const candidate = join(base, i === 0 ? stamp : `${stamp}-${i}`)
      try {
        mkdirSync(candidate, { mode: 0o700 })
        chmodSync(candidate, 0o700)
        dir = candidate
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
      }
    }
    if (dir === '') throw new BackupError(`no free backup directory for ${stamp} after ${MAX_SUFFIX} suffixes`)
    const agentDir = join(dir, agent)
    mkdirPrivate(agentDir, false)
    const file = join(agentDir, 'CLAUDE.md')
    const manifest = join(agentDir, 'MANIFEST.sha256')
    const digest = sha256(bytes)
    const manifestText = `${digest}  CLAUDE.md\n`
    writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' })
    writeFileSync(manifest, manifestText, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    chmodSync(file, 0o600)
    chmodSync(manifest, 0o600)
    if (sha256(readFileSync(file)) !== digest || readFileSync(manifest, 'utf-8') !== manifestText) {
      throw new BackupError(`backup read-back does not match: ${agentDir}`)
    }
    return agentDir
  } catch (err) {
    if (err instanceof BackupError) throw err
    throw new BackupError(`CLAUDE.md backup failed for ${agent}: ${(err as Error).message}`)
  }
}
