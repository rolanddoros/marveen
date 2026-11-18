// Fork C settings-protect (plan v2 point 5, V2-REL-1): once the per-agent settings files and their directories are
// protected paths, the agens-torles skill's `tar czf store/agent-backups/<n>-<date>.tar.gz -C agents <n>` step is
// refused by the gate (a changer pointed at a directory that holds a protected path). DELETE /api/agents/<n> takes
// that backup itself, from Node (the gate sees tool calls, not the dashboard), BEFORE it removes the directory, and
// does not remove anything when the backup fails. The archive is 0600: an agent directory holds its channel .env.
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** store/agent-backups/<name>-<UTC timestamp>.tar.gz under the given store dir. */
export function agentBackupPath(storeDir: string, name: string, now: Date = new Date()): string {
  return join(storeDir, 'agent-backups', `${name}-${now.toISOString().replace(/[:.]/g, '-')}.tar.gz`)
}

/**
 * Archive `dir` (agents/<name>) into a fresh 0600 file under storeDir/agent-backups. Throws, leaving no partial
 * archive behind, when tar fails or the archive is empty; never overwrites an existing file.
 */
export async function backupAgentDir(dir: string, storeDir: string, now: Date = new Date()): Promise<string> {
  const name = basename(dir)
  const out = agentBackupPath(storeDir, name, now)
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 })
  if (existsSync(out)) throw new Error('agent backup: the target file already exists')
  try {
    await execFileAsync('tar', ['czf', out, '-C', dirname(dir), name], { timeout: 120_000 })
    chmodSync(out, 0o600)
    if (statSync(out).size === 0) throw new Error('agent backup: the archive is empty')
  } catch (err) {
    rmSync(out, { force: true })
    throw err instanceof Error && err.message.startsWith('agent backup:') ? err : new Error('agent backup: tar failed')
  }
  return out
}
