import { watch, statSync, lstatSync, readdirSync, type Dirent, type FSWatcher } from 'node:fs'
import { basename, join } from 'node:path'
import { STORE_DIR } from './config.js'
import { logStoreFileEvent } from './db.js'
import { logger } from './logger.js'

// --- System file denylist ---
// Only files NOT on this list (and not matching SYSTEM_RE) are logged.
// Everything else = Marveen-managed state that would produce noise.
// "Agent-created" files are those that remain after filtering.
const SYSTEM_FILES = new Set([
  // SQLite database
  'claudeclaw.db', 'claudeclaw.db-wal', 'claudeclaw.db-shm',
  // Marveen runtime / scheduler state
  'schedule-last-run.json', 'external-ops-last-run',
  'kanban-audit-state.json',
  // Settings and config overrides written by dashboard routes
  'config-overrides.json', 'dashboard-settings.json',
  // Fleet and agent management
  'agents-desired.json', 'auto-restart.json', 'autonomy-config.json',
  // Auth and secrets
  '.dashboard-token', '.vault-key', 'vault.json', '.claude-oauth-token',
  // Federation config + inbound peer token (written by /api/federation/peers)
  'federation.json', '.federation-token',
  // Capability-summary cache (written by the capability-summary runner);
  // capability text, not a secret -- deliberately NOT in SENSITIVE_NAMES.
  'capability-summaries.json',
  // Usage and keepalive
  'claude-usage.json', '.channel-keepalive', '.channel-last-respawn',
  // Known Marveen-written log files
  'channels.log', 'channels.error.log',
  'dashboard.log', 'dashboard.error.log',
  'update.log',
])

// Regex for system-generated filename patterns.
// Also covers atomic-write temp files (keep in sync with settings-store.ts).
const SYSTEM_RE = /\.pid$|\.tmp$|\.tmp\.[a-f0-9]+$|\.migrated$|\.bak$|^\.DS_Store$/

// Filenames whose presence is sensitive; the audit row is flagged so the UI
// can show a sanitised label instead of hinting at secret values.
const SENSITIVE_NAMES = new Set(['.dashboard-token', 'vault.json', '.vault-key', '.claude-oauth-token', '.federation-token', 'federation.json'])

// --- Agent attribution slot ---
// Node.js is single-threaded; a route handler sets this before writing,
// the watch callback reads and clears it in the next event-loop tick.
// For direct writes (Bash/Write tool from outside the process), this stays
// null -- stored as null, shown as "ismeretlen" in the UI. There is no
// OS-level mechanism to identify the writer without a process audit daemon,
// so null is the honest and correct value.
let currentWriteActor: string | null = null

export function setStoreWriteActor(actor: string): void {
  currentWriteActor = actor
}

export function clearStoreWriteActor(): void {
  currentWriteActor = null
}

// --- Known-files tracking for creation detection ---
// Populated at watcher startup by walking store/. A rename event for a path
// NOT in this set where the file NOW EXISTS means a new file was created.
let knownFiles = new Set<string>()

// --- Dedup ---
// fs.watch fires the same (eventType, filename) multiple times for a single
// logical operation. Collapse repeats within a short window.
const DEDUP_MS = 1000
const recentEvents = new Map<string, number>()

// Whole-directory denylist prefixes, for trees whose filenames vary (so a
// fixed-name SYSTEM_FILES entry can't cover them). scheduled-runs/ is the
// SCHEDPROMPTREF917 snapshot dir: ~100 new files/day by design (one per
// large-task fire), which would otherwise drown every real agent-created-file
// audit row in scheduler noise.
const SYSTEM_DIR_PREFIXES = ['scheduled-runs/']

function isSystemFile(rel: string): boolean {
  const name = basename(rel)
  if (SYSTEM_FILES.has(name) || SYSTEM_RE.test(name)) return true
  return SYSTEM_DIR_PREFIXES.some(prefix => rel.startsWith(prefix))
}

// --- Which directories are walked and watched ---
// The watcher used to be ONE recursive fs.watch on store/. On Linux Node builds
// a recursive watch in JavaScript, folder by folder, so its cost follows the
// whole tree: with ~53 700 inodes under store/ (Chrome profiles in browser/,
// test scratch trees in fork-audit/) the dashboard held 53 359 inotify watches
// and its event loop stalled for up to 60 s at boot and twice in one hour
// (2026-11-17, CPU profile: 46% watchFolder, 23% path.join, 22% readdir).
// Now every directory gets its own NON-recursive watch (on Linux a directory
// watch reports the files created in it, so no per-file watch is needed), and
// two limits keep the count small whatever lands in store/:
//   - SHALLOW_DIRS: machine-written trees; only their own top level is walked
//     and watched (a new store/fork-audit/PLAN.md is still an audit row), never
//     anything below it;
//   - MAX_WATCHED_DIRS: a ceiling on watches for a big tree nobody listed yet;
//     past it no further directory is watched, and one warning names the first
//     one skipped.
// The stall is Linux-specific: on macOS a recursive watch is native (FSEvents)
// and cheap. The per-directory form and both limits still apply on every
// platform, so there is one code path and one set of tests.
const SHALLOW_DIRS = new Set(['browser', 'fork-audit', 'ci-runner'])
const MAX_WATCHED_DIRS = 2000
// A directory created after start (mkdir, mv, cp -r) is walked and its files
// are logged as created, since they appeared after the start. Each INSERT is
// synchronous, so a big tree copied into a watched folder is bounded: at most
// this many rows per new directory, the rest only become known, and one
// warning says how many were not logged.
const MAX_FILES_PER_NEW_DIR = 200

/** Whether a store directory (relative path, '' = store/ itself) is walked and watched. */
function isWatchable(relDir: string): boolean {
  if (relDir === '') return true
  const parts = relDir.split('/')
  return parts.length === 1 || !SHALLOW_DIRS.has(parts[0])
}

let watchers = new Map<string, FSWatcher>()
let capWarned = false
let reportedWatchErrors = new Set<string>()

function absPath(rel: string): string {
  return rel === '' ? STORE_DIR : join(STORE_DIR, rel)
}

/**
 * Watches `relDir` and every watchable directory below it, and hands each file
 * found to `onFile`. The watch comes before the readdir, so a file created in
 * between is not missed: the walk hands it to `onFile` and its event comes too.
 * What that means depends on `onFile`: at start a file only becomes known (no
 * audit row, even one created during the boot walk); in a directory created
 * later it is logged.
 */
function addTree(relDir: string, onFile: (rel: string) => void): void {
  if (!isWatchable(relDir) || watchers.has(relDir)) return
  if (watchers.size >= MAX_WATCHED_DIRS) {
    if (!capWarned) {
      capWarned = true
      logger.warn({ skipped: relDir, max: MAX_WATCHED_DIRS }, 'store-watcher: watch ceiling reached, further directories not watched')
    }
    return
  }
  try {
    const w = watch(absPath(relDir), { recursive: false }, (eventType, filename) => {
      onEvent(relDir, eventType, filename)
    })
    // An unreadable subdirectory (another user's sandbox dir) makes a watch
    // emit 'error'; without a listener that is an uncaughtException and the
    // dashboard exits. Log once per (code, path), keep going.
    w.on('error', (err: NodeJS.ErrnoException) => {
      const key = JSON.stringify([err?.code ?? null, err?.path ?? null])
      if (reportedWatchErrors.has(key)) return
      reportedWatchErrors.add(key)
      logger.warn({ code: err?.code, path: err?.path }, 'store-watcher: subdirectory not watchable, skipped')
    })
    watchers.set(relDir, w)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    const key = JSON.stringify([e?.code ?? null, e?.path ?? null])
    if (!reportedWatchErrors.has(key)) {
      reportedWatchErrors.add(key)
      logger.warn({ code: e?.code, path: e?.path }, 'store-watcher: subdirectory not watchable, skipped')
    }
    return
  }
  let entries: Dirent[]
  try {
    entries = readdirSync(absPath(relDir), { withFileTypes: true })
  } catch {
    return // non-fatal; store may not exist yet, or the directory went away
  }
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    // A symlink, even to a directory, is not followed: it counts as a file.
    if (entry.isDirectory()) addTree(rel, onFile)
    else onFile(rel)
  }
}

/** Closes the watches of a directory that went away, and of everything below it. */
function dropTree(relDir: string): void {
  for (const [rel, w] of watchers) {
    if (rel === relDir || rel.startsWith(`${relDir}/`)) {
      try { w.close() } catch { /* best-effort */ }
      watchers.delete(rel)
    }
  }
}

/** Logs `rel` as an agent-created file, unless it is a system file, known, or a repeat. */
function recordCreated(rel: string, fileSize: number | null, agent: string | null): boolean {
  if (isSystemFile(rel) || knownFiles.has(rel)) return false
  const now = Date.now()
  const last = recentEvents.get(rel)
  if (last !== undefined && now - last < DEDUP_MS) return false
  recentEvents.set(rel, now)
  if (recentEvents.size > 200) {
    for (const [k, t] of recentEvents) if (now - t >= DEDUP_MS) recentEvents.delete(k)
  }
  knownFiles.add(rel)
  const isSensitive = SENSITIVE_NAMES.has(basename(rel)) ? 1 : 0
  try {
    logStoreFileEvent(rel, 'create', isSensitive, fileSize, agent)
  } catch (err) {
    logger.warn({ err, rel }, 'store-watcher: failed to log new file event')
  }
  return true
}

/** A directory created after start: watch it, and log the files already in it, bounded. */
function addNewTree(relDir: string, agent: string | null): void {
  let logged = 0
  let notLogged = 0
  addTree(relDir, rel => {
    if (isSystemFile(rel) || knownFiles.has(rel)) return
    if (logged >= MAX_FILES_PER_NEW_DIR) {
      knownFiles.add(rel)
      notLogged += 1
      return
    }
    let size: number | null = null
    try { size = statSync(absPath(rel)).size } catch { return }
    if (recordCreated(rel, size, agent)) logged += 1
  })
  if (notLogged > 0) {
    logger.warn({ dir: relDir, logged, notLogged, max: MAX_FILES_PER_NEW_DIR }, 'store-watcher: new directory holds more files than are logged per directory')
  }
}

function onEvent(relDir: string, eventType: string, filename: string | Buffer | null): void {
  if (!filename) return
  const name = String(filename).replace(/\\/g, '/')
  const rel = relDir ? `${relDir}/${name}` : name

  // Consume (clear) the actor slot for ALL events, including system-file
  // events, so a slot set before a denylist-ed write cannot leak to the
  // next unrelated event.
  const agent = currentWriteActor
  currentWriteActor = null

  // Only rename events can indicate a new file. change = modification.
  if (eventType !== 'rename') return

  // A path inside a machine-written tree is never watched and never an audit
  // row, whichever watch reported it: a page load in an agent's Chrome under
  // browser/<profile>/ creates and deletes cache files by the hundred
  // (2026-11-17, each load stalled the dashboard 10-30 s).
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  if (!isWatchable(parent)) return

  let fileSize: number | null = null
  try {
    // A directory is not a created file (the old recursive watcher emitted a
    // 'rename' for every directory it walked: 26 527 rows in one boot). A new
    // directory is watched instead, with what is already in it. lstat, not
    // stat: a symlink to a directory counts as a file, so a new one is still
    // logged. The delete covers a known file replaced by a directory.
    if (lstatSync(absPath(rel)).isDirectory()) {
      knownFiles.delete(rel)
      if (isWatchable(rel) && !watchers.has(rel)) addNewTree(rel, agent)
      return
    }
    // Skip system and temp files -- Marveen's own runtime writes.
    if (isSystemFile(rel)) return
    fileSize = statSync(absPath(rel)).size
  } catch {
    // Gone: deletion or rename-away. Update knownFiles, drop its watches, skip.
    knownFiles.delete(rel)
    dropTree(rel)
    return
  }

  // Already known -> not a new creation (could be a rename-to-same or
  // replace; ignore to avoid false positives).
  recordCreated(rel, fileSize, agent)
}

export function startStoreWatcher(): void {
  if (watchers.size > 0) return

  knownFiles = new Set<string>()
  watchers = new Map<string, FSWatcher>()
  capWarned = false
  reportedWatchErrors = new Set<string>()
  const started = Date.now()
  addTree('', rel => knownFiles.add(rel))
  if (watchers.size === 0) {
    logger.warn({ dir: STORE_DIR }, 'Store file watcher failed to start')
    return
  }
  logger.info(
    { dir: STORE_DIR, knownCount: knownFiles.size, watchedDirs: watchers.size, ms: Date.now() - started },
    'Store file watcher started',
  )
}

export function stopStoreWatcher(): void {
  for (const w of watchers.values()) {
    try { w.close() } catch { /* best-effort */ }
  }
  watchers = new Map<string, FSWatcher>()
}
