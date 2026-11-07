// The pure part of the federation config (C1 PR 12b): the types, the limits
// and the validator, moved here unchanged from config.ts so that a reader that
// must stay import-light (claude-md/live-context.ts, in the read-only dry-run
// graph) validates store/federation.json exactly as the bridge does. No
// config.js, logger, fs or watcher here; config.ts re-exports every name and
// keeps validateFederationConfig(parsed) with MAIN_AGENT_ID as the default.
import { isValidIdSegment } from './address.js'

export const FEDERATION_MIN_TOKEN_LENGTH = 32
// Per-peer patience window before a pending outbound message is abandoned.
// Default mirrors the local queue's 60min; a laptop peer that sleeps for
// hours can be given a longer window (e.g. 1440 = a day).
export const DEFAULT_ABANDON_WINDOW_MINUTES = 60
export const MIN_ABANDON_WINDOW_MINUTES = 5
export const MAX_ABANDON_WINDOW_MINUTES = 7 * 24 * 60

// How eagerly the MAIN agent routes a domain request to a fitting specialist
// (local or federated), rendered into the CLAUDE.md delegation directive:
//   'strong'        -- always delegate a domain task to the fitting specialist
//   'catalog-first' -- fetch the catalog first, delegate when one fits (DEFAULT)
//   'advisory'      -- self-handle mostly, delegate only when clearly better
export type FederationRoutingMode = 'strong' | 'catalog-first' | 'advisory'
export const FEDERATION_ROUTING_MODES: readonly FederationRoutingMode[] = ['strong', 'catalog-first', 'advisory']
export const DEFAULT_ROUTING_MODE: FederationRoutingMode = 'catalog-first'

export interface FederationPeer {
  id: string
  baseUrl: string
  outboundToken: string // '' = pairing pending
  inboundToken: string
  trust: 'untrusted'
  abandonWindowMinutes?: number
  // Opt-in, per peer (default false, fail-closed): whether THIS peer's
  // manifest fetches see our agents' LLM-generated capability summaries.
  // Summaries are derived from persona files and may carry personal color --
  // the owner grants them peer by peer, not globally.
  shareCapabilitySummaries?: boolean
}

export interface FederationConfig {
  enabled: boolean
  systemId: string
  // Main-agent delegation eagerness. Absent in legacy configs -> the validator
  // fills DEFAULT_ROUTING_MODE, so a persisted config always carries it.
  routingMode?: FederationRoutingMode
  peers: FederationPeer[]
}

// https is mandatory except on loopback, which the local two-instance smoke
// test needs (http://127.0.0.1:<port> peers).
export function isAcceptablePeerBaseUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  let url: URL
  try { url = new URL(raw) } catch { return false }
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
}

function isValidToken(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.trim().length >= FEDERATION_MIN_TOKEN_LENGTH
}

/** Pure validator: parsed JSON -> config, or a string describing why it is
 *  invalid (the caller logs once and fails closed). Peers are parsed for
 *  DISABLED configs too (lossless disable). `defaultSystemId` is the systemId of a
 *  file without one (config.ts passes MAIN_AGENT_ID). */
export function validateFederationConfigWith(parsed: unknown, defaultSystemId: string): FederationConfig | string {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'root is not an object'
  const obj = parsed as Record<string, unknown>
  const enabled = obj.enabled === true // strict; anything else is off
  const rawSystemId = obj.systemId === undefined ? defaultSystemId : obj.systemId
  if (!isValidIdSegment(rawSystemId)) return 'invalid systemId'
  // Ids are CASE-INSENSITIVE and stored lowercase. Operators keep typing the
  // display name ('Teodor', the BOT_NAME) where the machine slug ('teodor',
  // the MAIN_AGENT_ID) is meant, and a case-sensitive match then fails as a
  // silent "system mismatch". Normalizing here (the single write path) makes
  // every downstream === comparison case-insensitive for free.
  const systemId = (rawSystemId as string).toLowerCase()
  // A missing peers key is tolerated for the minimal off state {"enabled":false}.
  const rawPeers = obj.peers === undefined ? [] : obj.peers
  if (!Array.isArray(rawPeers)) return 'peers is not an array'
  const peers: FederationPeer[] = []
  const seenIds = new Set<string>()
  const seenInbound = new Set<string>()
  for (const raw of rawPeers) {
    if (raw === null || typeof raw !== 'object') return 'peer entry is not an object'
    const p = raw as Record<string, unknown>
    if (!isValidIdSegment(p.id)) return 'invalid peer id'
    const id = (p.id as string).toLowerCase() // case-insensitive ids, stored lowercase
    if (id === systemId) return `peer id equals own systemId (${id})`
    if (seenIds.has(id)) return `duplicate peer id (${id})`
    seenIds.add(id)
    if (!isAcceptablePeerBaseUrl(p.baseUrl)) return `invalid peer baseUrl for ${id} (https required; http only on loopback)`
    // inboundToken is what identifies the caller at the gate; a duplicate
    // would make the first-match loop misattribute peer B as peer A --
    // cross-peer impersonation. Hard requirement.
    if (!isValidToken(p.inboundToken)) return `invalid inbound token for ${id} (min ${FEDERATION_MIN_TOKEN_LENGTH} chars)`
    const inbound = (p.inboundToken as string).trim()
    if (seenInbound.has(inbound)) return `duplicate inbound token (${id})`
    seenInbound.add(inbound)
    // outboundToken may be empty ("pairing pending") but a PRESENT value must
    // be well-formed -- a short junk token would just burn 401s at the peer.
    let outbound = ''
    if (p.outboundToken !== undefined && p.outboundToken !== null && p.outboundToken !== '') {
      if (!isValidToken(p.outboundToken)) return `invalid outbound token for ${id} (min ${FEDERATION_MIN_TOKEN_LENGTH} chars, or empty while pairing)`
      outbound = (p.outboundToken as string).trim()
    }
    const trust = p.trust === undefined ? 'untrusted' : p.trust
    if (trust !== 'untrusted') return `unsupported trust value for ${id}`
    let abandonWindowMinutes: number | undefined
    if (p.abandonWindowMinutes !== undefined) {
      const w = p.abandonWindowMinutes
      if (typeof w !== 'number' || !Number.isInteger(w) || w < MIN_ABANDON_WINDOW_MINUTES || w > MAX_ABANDON_WINDOW_MINUTES) {
        return `invalid abandonWindowMinutes for ${id} (${MIN_ABANDON_WINDOW_MINUTES}..${MAX_ABANDON_WINDOW_MINUTES})`
      }
      abandonWindowMinutes = w
    }
    // Strict boolean; a present non-boolean is a config error (fail-closed),
    // and the parsed value MUST round-trip through the return object -- every
    // mutating endpoint persists this validator's output, so a dropped field
    // here would silently reset the owner's grant on the next peer edit.
    let shareCapabilitySummaries = false
    if (p.shareCapabilitySummaries !== undefined) {
      if (typeof p.shareCapabilitySummaries !== 'boolean') return `invalid shareCapabilitySummaries for ${id} (boolean)`
      shareCapabilitySummaries = p.shareCapabilitySummaries
    }
    peers.push({
      id,
      baseUrl: (p.baseUrl as string).replace(/\/+$/, ''),
      outboundToken: outbound,
      inboundToken: inbound,
      trust: 'untrusted',
      ...(abandonWindowMinutes !== undefined ? { abandonWindowMinutes } : {}),
      ...(shareCapabilitySummaries ? { shareCapabilitySummaries: true } : {}),
    })
  }
  // Main-agent delegation eagerness (global, not per-peer). Absent -> default;
  // a present-but-unknown value is a config error (fail-closed). MUST round-trip
  // through the return: every mutating endpoint persists this validator output.
  let routingMode: FederationRoutingMode = DEFAULT_ROUTING_MODE
  if (obj.routingMode !== undefined) {
    if (typeof obj.routingMode !== 'string' || !FEDERATION_ROUTING_MODES.includes(obj.routingMode as FederationRoutingMode)) {
      return `invalid routingMode (${FEDERATION_ROUTING_MODES.join('|')})`
    }
    routingMode = obj.routingMode as FederationRoutingMode
  }
  return { enabled, systemId, routingMode, peers }
}
