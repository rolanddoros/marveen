// Federation peer configuration (round 2: per-peer inbound tokens).
//
// Source of truth is store/federation.json (NOT the settings registry: a
// registry entry would create a second, conflicting switch via the generic
// /api/settings route writing config-overrides.json -- the terminal-input
// toggle precedent applies: own store file + own endpoints).
//
// FAIL-CLOSED: any read/parse/validation error yields a disabled config with
// no peers. A partially valid file does NOT enable a subset -- one bad peer
// disables the whole feature, with a single warn log. An unknown `trust`
// value is likewise a validation error: a half-deployed future trust feature
// must fail closed, not open.
//
// LOSSLESS DISABLE (round 2): enabled:false configs still parse and retain
// their peers, so flipping the switch back on needs no re-pairing. This
// deliberately amends the v1 doctrine "a disabled install never carries an
// authenticating secret": per-peer inboundTokens stay in the 0600 file while
// disabled (dashboard-only visibility; the full-removal endpoint purges
// everything). The GATE still refuses all federation auth while disabled.
//
// Tokens per peer:
//   inboundToken  -- REQUIRED, unique, >=32 chars. We mint it when the peer
//                    is added; the peer presents it to us. It identifies the
//                    caller (from-prefix must match).
//   outboundToken -- what WE present to the peer. MAY BE EMPTY: the pairing
//                    dance necessarily has a window where the other side has
//                    not minted ours yet ("pairing pending"). An empty
//                    outbound token never authenticates anything and the
//                    bridge refuses to send to such a peer.
import { existsSync, mkdirSync, readFileSync, unlinkSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { STORE_DIR, MAIN_AGENT_ID } from '../../config.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { logger } from '../../logger.js'
import {
  DEFAULT_ABANDON_WINDOW_MINUTES,
  DEFAULT_ROUTING_MODE,
  FEDERATION_MIN_TOKEN_LENGTH,
  validateFederationConfigWith,
  type FederationConfig,
  type FederationRoutingMode,
} from './validate.js'
// The pure part (types, limits, validator) lives in validate.ts (C1 PR 12b); every name stays importable from here.
export {
  DEFAULT_ABANDON_WINDOW_MINUTES,
  DEFAULT_ROUTING_MODE,
  FEDERATION_MIN_TOKEN_LENGTH,
  FEDERATION_ROUTING_MODES,
  MAX_ABANDON_WINDOW_MINUTES,
  MIN_ABANDON_WINDOW_MINUTES,
  isAcceptablePeerBaseUrl,
  type FederationConfig,
  type FederationPeer,
  type FederationRoutingMode,
} from './validate.js'

const CONFIG_FILENAME = 'federation.json'
// Legacy round-1 shared-token file: no longer written or read for auth, but
// the removal path still deletes it if a pre-round-2 store carries one.
const LEGACY_TOKEN_FILENAME = '.federation-token'

const DISABLED: FederationConfig = Object.freeze({ enabled: false, systemId: '', routingMode: DEFAULT_ROUTING_MODE, peers: [] })

// Test seam: the store dir is swappable so tests never touch the real
// checkout's store/ (initDatabase(':memory:') precedent -- explicit override,
// not NODE_ENV magic).
let storeDir = STORE_DIR

function configPath(): string { return join(storeDir, CONFIG_FILENAME) }
function legacyTokenPath(): string { return join(storeDir, LEGACY_TOKEN_FILENAME) }

export function generatePeerInboundToken(): string {
  return randomBytes(32).toString('hex')
}

/** Pure validator: parsed JSON -> config, or a string describing why it is
 *  invalid (the caller logs once and fails closed). A file without a systemId
 *  gets MAIN_AGENT_ID. Exported for tests. */
export function validateFederationConfig(parsed: unknown): FederationConfig | string {
  return validateFederationConfigWith(parsed, MAIN_AGENT_ID)
}

/** Wall-clock patience for a peer's pending outbound messages. The system
 *  segment may come from a stored to_agent, so match case-insensitively
 *  (stored peer ids are lowercase; pre-normalization rows may not be). */
export function abandonWindowMsForPeer(cfg: FederationConfig, system: string): number {
  const wanted = system.toLowerCase()
  const peer = cfg.peers.find((p) => p.id === wanted)
  const minutes = peer?.abandonWindowMinutes ?? DEFAULT_ABANDON_WINDOW_MINUTES
  return minutes * 60_000
}

// ---- cached, watch-refreshed readers ---------------------------------------
//
// settings-store pattern: lazy watch on the store DIRECTORY ({persistent:
// false} so vitest workers are not held open; mkdir first because fs.watch
// throws on a missing dir), filename-filtered, and our OWN writes refresh the
// cache synchronously instead of waiting for a (possibly coalesced) event --
// otherwise the auth gate could serve one more request against the pre-write
// enabled/token state.
let cachedConfig: FederationConfig | null = null
let lastConfigWarning = ''
let watcher: FSWatcher | undefined

function loadConfigFromDisk(): FederationConfig {
  try {
    if (!existsSync(configPath())) return DISABLED
    const result = validateFederationConfig(JSON.parse(readFileSync(configPath(), 'utf-8')))
    if (typeof result === 'string') {
      if (result !== lastConfigWarning) {
        lastConfigWarning = result
        logger.warn({ reason: result }, 'federation: invalid federation.json -- federation disabled (fail-closed)')
      }
      return DISABLED
    }
    lastConfigWarning = ''
    return result
  } catch (err) {
    if (lastConfigWarning !== 'unreadable') {
      lastConfigWarning = 'unreadable'
      logger.warn({ err }, 'federation: cannot read federation.json -- federation disabled (fail-closed)')
    }
    return DISABLED
  }
}

function ensureWatching(): void {
  if (watcher) return
  try {
    mkdirSync(storeDir, { recursive: true })
    watcher = watch(storeDir, { persistent: false }, (_event, filename) => {
      if (filename === CONFIG_FILENAME) cachedConfig = loadConfigFromDisk()
    })
  } catch {
    // Best-effort: without a watch the cache reflects this process's own
    // reads/writes, which is still correct for the single-process case.
  }
}

export function getFederationConfig(): FederationConfig {
  ensureWatching()
  if (cachedConfig === null) cachedConfig = loadConfigFromDisk()
  return cachedConfig
}

/** Health of the stored file, for config-MUTATING handlers. When the file
 *  exists but fails validation, getFederationConfig() fail-closes to
 *  peers:[] -- a mutation that reads that cache and writes it back would
 *  DESTROY the (hand-recoverable) peers in the file. Such handlers must
 *  refuse instead. 'absent' is healthy (a fresh add creates the file). */
export function federationFileHealth(): 'ok' | 'absent' | 'invalid' {
  try {
    if (!existsSync(configPath())) return 'absent'
    const result = validateFederationConfig(JSON.parse(readFileSync(configPath(), 'utf-8')))
    return typeof result === 'string' ? 'invalid' : 'ok'
  } catch {
    return 'invalid'
  }
}

/** Identify the calling peer from an Authorization header by trying each
 *  configured peer's inboundToken. Returns the peer id, or null. NEVER
 *  throws and does NO auth work while disabled (fail-closed): the gate runs
 *  outside the dispatcher try{} -- a throw there leaves the socket hanging.
 *  The comparator is injected (checkBearerToken) to avoid an import cycle
 *  with dashboard-auth consumers. */
export function identifyFederationCaller(
  authHeader: string | undefined,
  check: (header: string | undefined, expected: string) => boolean,
): string | null {
  try {
    const cfg = getFederationConfig()
    if (!cfg.enabled) return null
    for (const peer of cfg.peers) {
      // Per-candidate guard: an empty/short expected token must never reach
      // the comparator ('Bearer ' + whitespace would authenticate against '').
      if (typeof peer.inboundToken !== 'string' || peer.inboundToken.length < FEDERATION_MIN_TOKEN_LENGTH) continue
      if (check(authHeader, peer.inboundToken)) return peer.id
    }
    return null
  } catch {
    return null
  }
}

/** Persist a validated config. Caller must pass an object that
 *  validateFederationConfig accepts. Synchronous write + synchronous cache
 *  refresh (no await window for concurrent writers). */
export function writeFederationConfig(cfg: FederationConfig): void {
  mkdirSync(storeDir, { recursive: true })
  atomicWriteFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 })
  cachedConfig = loadConfigFromDisk()
}

/** Master-switch flip that never loses peer data (lossless disable/enable).
 *  Works from the RAW file, not the validated cache: an invalid stored peer
 *  fail-closes the VIEW to peers:[], and writing that back would turn a
 *  view-loss into real data loss. Returns false when the file is unreadable
 *  garbage (nothing to flip -- the validator already fail-closes it). */
export function setFederationEnabledPreservingFile(enabled: boolean): boolean {
  try {
    let raw: Record<string, unknown> = {}
    if (existsSync(configPath())) {
      const parsed = JSON.parse(readFileSync(configPath(), 'utf-8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
      raw = parsed as Record<string, unknown>
    }
    raw.enabled = enabled === true
    if (raw.systemId === undefined) raw.systemId = MAIN_AGENT_ID
    mkdirSync(storeDir, { recursive: true })
    atomicWriteFileSync(configPath(), JSON.stringify(raw, null, 2), { mode: 0o600 })
    cachedConfig = loadConfigFromDisk()
    // Report whether the request actually took effect: enabling an
    // invalid-but-parseable file writes enabled:true but loadConfigFromDisk
    // fail-closes to DISABLED, so the caller must NOT report success.
    // Disabling always matches (DISABLED.enabled === false).
    return cachedConfig.enabled === (enabled === true)
  } catch {
    return false
  }
}

/** Set the main-agent delegation routing mode, preserving the rest of the file
 *  (peers, tokens, enabled) even when a stored peer is invalid -- same
 *  raw-file discipline as setFederationEnabledPreservingFile. Returns false on
 *  unreadable garbage. */
export function setFederationRoutingModePreservingFile(mode: FederationRoutingMode): boolean {
  try {
    let raw: Record<string, unknown> = {}
    if (existsSync(configPath())) {
      const parsed = JSON.parse(readFileSync(configPath(), 'utf-8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
      raw = parsed as Record<string, unknown>
    }
    raw.routingMode = mode
    if (raw.systemId === undefined) raw.systemId = MAIN_AGENT_ID
    mkdirSync(storeDir, { recursive: true })
    atomicWriteFileSync(configPath(), JSON.stringify(raw, null, 2), { mode: 0o600 })
    cachedConfig = loadConfigFromDisk()
    // The mode is now persisted to the file. Unlike the enabled flip, routing
    // mode is orthogonal to peer validity: an invalid stored peer fail-closes
    // the VIEW to DISABLED, but the mode is still written and applies once the
    // config is valid again -- so a successful write is a success. Only
    // unreadable garbage (caught below) is a failure.
    return true
  } catch {
    return false
  }
}

/** Full removal: delete the store files and reset the cache SYNCHRONOUSLY
 *  (never trust the async fs.watch -- macOS may deliver filename=null).
 *  ENOENT-tolerant so removal is idempotent. */
export function removeFederationStore(): void {
  for (const p of [configPath(), legacyTokenPath()]) {
    try {
      unlinkSync(p)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err, path: p }, 'federation: store file unlink failed')
      }
    }
  }
  cachedConfig = DISABLED
  lastConfigWarning = ''
}

// ---- test seams -------------------------------------------------------------

export function _setFederationStoreDirForTest(dir: string): void {
  storeDir = dir
  if (watcher) { try { watcher.close() } catch { /* ignore */ } watcher = undefined }
  reloadFederationForTest()
}

export function reloadFederationForTest(): void {
  cachedConfig = null
  lastConfigWarning = ''
}
