// Fork C settings-protect (plan v2 point 3): the dashboard's start path asks the protected standalone verifier
// (scripts/hooks/verify-gate-wiring.mjs) before a sub-agent's tmux session starts, exactly as scripts/watchdog.sh
// does. The module is loaded from the install's scripts/hooks/ at call time, never from src/ or dist/: the point of
// the verifier (Ron 17402 K1) is that a changed src/dist manifest shows up as a mismatch against a protected file,
// so the dashboard's own copy cannot be the judge.
//
// Only a verifier that answers start=true lets the agent start; a verifier that cannot be loaded or throws means no
// start (Ron D2-REL-2: any other outcome than a clean "start" does not start). A NEW problem set goes to the owner
// once through notifyChannel; the verifier's state file keeps it from repeating on every start.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import { notifyChannel } from '../notify.js'

export interface GateWiringDecision {
  start: boolean
  line: string | null
}

type CheckBeforeStart = (agent: string, opts: { installDir: string; configDir: string | null }) => {
  start: boolean
  line: string | null
  changed: boolean
}

export interface GateWiringDeps {
  installDir: string
  load: (path: string) => Promise<{ checkBeforeStart?: unknown; checkSharedBeforeCopy?: unknown }>
  notify: (text: string) => Promise<unknown>
}

const defaultDeps = (): GateWiringDeps => ({
  installDir: PROJECT_ROOT,
  load: (path) => import(pathToFileURL(path).href) as Promise<{ checkBeforeStart?: unknown; checkSharedBeforeCopy?: unknown }>,
  notify: (text) => notifyChannel(text),
})

/** The verifier's path inside an install (a protected path of db-write-gate.mjs's scripts/hooks entry). */
export function gateWiringVerifierPath(installDir: string): string {
  return join(installDir, 'scripts', 'hooks', 'verify-gate-wiring.mjs')
}

type CheckSharedBeforeCopy = (agent: string, opts: { installDir: string }) => { copy: boolean; line: string | null }

/**
 * Plan v2 point 4: before the isolated provisioning copies the shared ~/.claude/settings.json into the agent's own
 * config dir. { copy: false } (enforce and a finding, or a verifier that cannot run) means: no copy, no start.
 */
export async function gateWiringSharedBeforeCopy(name: string, deps: GateWiringDeps = defaultDeps()): Promise<{ copy: boolean; line: string | null }> {
  try {
    const mod = await deps.load(gateWiringVerifierPath(deps.installDir)) as { checkSharedBeforeCopy?: unknown }
    if (typeof mod.checkSharedBeforeCopy !== 'function') throw new Error('checkSharedBeforeCopy is missing')
    const r = (mod.checkSharedBeforeCopy as CheckSharedBeforeCopy)(name, { installDir: deps.installDir })
    if (r.line !== null) {
      if (r.copy) logger.warn({ agent: name }, r.line)
      else logger.error({ agent: name }, r.line)
    }
    return r
  } catch (err) {
    const line = `[GATE-WIRING] ${name} NOT STARTED: the verifier could not run (${err instanceof Error ? err.message : 'error'})`
    logger.error({ agent: name }, line)
    return { copy: false, line }
  }
}

/**
 * Ask the protected verifier whether `name` may start now. `configDir` is the CLAUDE_CONFIG_DIR the launch line will
 * export (the isolated .claude-config or a configured dir), or null when the agent runs on the shared ~/.claude.
 */
export async function gateWiringBeforeStart(name: string, configDir: string | null, deps: GateWiringDeps = defaultDeps()): Promise<GateWiringDecision> {
  let decision: { start: boolean; line: string | null; changed: boolean }
  try {
    const mod = await deps.load(gateWiringVerifierPath(deps.installDir))
    if (typeof mod.checkBeforeStart !== 'function') throw new Error('checkBeforeStart is missing')
    decision = (mod.checkBeforeStart as CheckBeforeStart)(name, { installDir: deps.installDir, configDir })
  } catch (err) {
    // The error CLASS and message of a load failure carry no settings value (the verifier never puts one in a
    // message); the agent does not start.
    const line = `[GATE-WIRING] ${name} NOT STARTED: the verifier could not run (${err instanceof Error ? err.message : 'error'})`
    logger.error({ agent: name }, line)
    return { start: false, line }
  }
  if (decision.line !== null) {
    if (decision.start) logger.warn({ agent: name }, decision.line)
    else logger.error({ agent: name }, decision.line)
    if (decision.changed) {
      await deps.notify(`⚠️ ${decision.line}`).catch(() => { /* notifyChannel logs internally */ })
    }
  }
  return { start: decision.start, line: decision.line }
}
