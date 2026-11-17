// One validator for the settings files that decide a sub-agent's hooks and environment (Fork C settings-protect,
// plan v2 point 1 + addendum 1 D2-REL-1, Ron 17402 K3). Pure apart from the realpath of GH_CONFIG_DIR, which the
// caller may replace. Callers, all with the same function: the K2 helper's `request` (a batch outside the rules is
// refused before any approval exists), the standalone verifier before an agent starts, and the isolated-config
// provisioning before it copies the shared file. So a batch the owner approved cannot be refused at start later.
//
// Four kinds of file:
//   agent-project  agents/<n>/.claude/settings.json          strict key list (the scaffold writes it every start)
//   agent-local    agents/<n>/.claude/settings.local.json    strict key list (only hand steps and the K2 helper)
//   agent-user     agents/<n>/.claude-config/settings.json   the isolated copy of the shared file
//   shared-user    ~/.claude/settings.json (and .local)      the host's shared user settings
// The two strict kinds: a key that is not listed is an ERROR. The two user kinds are also written by the owner and
// the CLI, so an unknown KEY NAME there is only an ALERT until Roland decides otherwise (D2-REL-1). The VALUE rules
// stay fail-closed in every kind (K3 ii): no `env` name but GH_CONFIG_DIR in agent-local, no hooks and no hook
// switch outside agent-project, no permissions in the shared file and in the isolated copy only the strict-profile
// pin, statusLine only as one fixed command, and no key whose value is a command the CLI runs outside the PreToolUse
// gate chain (apiKeyHelper and its kin, HELPER_COMMAND_KEYS) in either user kind.
//
// This is part of a text brake, NOT an OS boundary (docs/db-write-gate.md): the agent's Unix user can write these
// files with a script. The point is that a hook-disabling or env-injecting edit never reaches a start unnoticed.
import { realpathSync } from 'node:fs'
import { isAbsolute, normalize, sep } from 'node:path'

export const KINDS = Object.freeze(['agent-project', 'agent-local', 'agent-user', 'shared-user'])

/** The CLI's effort levels as this install's /model knows them (src/web/main-model.ts EFFORT_LEVELS, pinned by a test). */
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'max'])

/** The only env name any settings file may carry, and only agent-local (plan v2 point 1). */
export const ENV_NAMES = Object.freeze(['GH_CONFIG_DIR'])

/** Keys that switch hooks off or narrow them to another source: never outside the scaffold's own `hooks`. */
export const HOOK_SWITCH_KEYS = Object.freeze(['hooks', 'disableAllHooks', 'allowManagedHooksOnly'])

/**
 * Keys whose value is a command the CLI runs itself, outside the PreToolUse gate chain (Ron 17563, blocker 2).
 * An error in both user kinds, never only an alert. apiKeyHelper: the CLI's documented key-helper command. All four
 * names occur in the installed CLI binary (2.1.318, `grep -a -c`: 58 / 17 / 9 / 17, Ron 17591 and re-measured); that
 * the other three are commands the CLI runs is per Ron, not verified here. Live, measured 2026-11-17 (key names only):
 * none of them in the 13 isolated copies or the shared file.
 */
export const HELPER_COMMAND_KEYS = Object.freeze(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'])

const STRICT_KEYS = {
  'agent-project': ['hooks', 'permissions', 'enabledPlugins', 'effortLevel', 'claudeMdExcludes'],
  'agent-local': ['env', 'claudeMdExcludes', 'permissions'],
}
/** Keys the user kinds are known to carry (addendum 1 D2-REL-1 inventory); any other key name is an alert there. */
const KNOWN_USER_KEYS = {
  'agent-user': ['enabledPlugins', 'extraKnownMarketplaces', 'skipDangerousModePermissionPrompt', 'statusLine', 'model', 'allowedChannelPlugins', 'permissions'],
  'shared-user': ['enabledPlugins', 'extraKnownMarketplaces', 'skipDangerousModePermissionPrompt', 'model'],
}
const PROJECT_PERMISSION_KEYS = ['allow', 'deny', 'additionalDirectories', 'defaultMode']
/** What enforceStrictPermissionMode writes (src/web/agent-scaffold.ts); nothing that loosens the mode. */
const DEFAULT_MODES = ['dontAsk']
/** The only permissions object the isolated copy may carry (enforceStrictPermissionMode's write). */
const STRICT_PIN = Object.freeze({ defaultMode: 'dontAsk' })
const MAX_RULE = 500
const MAX_LIST = 2000
const CONTROL_RX = /[\u0000-\u001f\u007f]/

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** A canonical JSON text (sorted keys), for "equal to" checks that must not depend on key order. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (isPlainObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

function stringList(errors, where, v, { absolute = false } = {}) {
  if (!Array.isArray(v)) return errors.push(`${where}: not a list`)
  if (v.length > MAX_LIST) errors.push(`${where}: ${v.length} entries, at most ${MAX_LIST}`)
  v.forEach((s, i) => {
    if (typeof s !== 'string' || s.length === 0) errors.push(`${where}[${i}]: not a non-empty string`)
    else if (s.length > MAX_RULE) errors.push(`${where}[${i}]: ${s.length} characters, at most ${MAX_RULE}`)
    else if (CONTROL_RX.test(s)) errors.push(`${where}[${i}]: a control character`)
    else if (absolute && (!isAbsolute(s) || normalize(s) !== s || s.split(sep).includes('..'))) errors.push(`${where}[${i}]: not an absolute normalised path`)
  })
}

function pluginMap(errors, where, v, expected) {
  if (!isPlainObject(v)) return errors.push(`${where}: not an object`)
  for (const [id, on] of Object.entries(v)) {
    if (typeof on !== 'boolean') errors.push(`${where}.${JSON.stringify(id)}: not a boolean`)
    if (id.length === 0 || id.length > 200 || CONTROL_RX.test(id)) errors.push(`${where}: a malformed plugin id`)
  }
  if (expected !== undefined && canonicalJson(v) !== canonicalJson(expected)) errors.push(`${where}: differs from what the provisioning sets for this agent`)
}

/** GH_CONFIG_DIR: absolute, normalised, no "..", under <install>/agents/<agent>/, and its realpath too. */
function ghConfigDir(errors, v, ctx) {
  const where = 'env.GH_CONFIG_DIR'
  if (typeof v !== 'string' || v.length === 0 || v.length > 4096 || CONTROL_RX.test(v)) return errors.push(`${where}: not a path`)
  if (!isAbsolute(v) || normalize(v) !== v || v.split(sep).includes('..')) return errors.push(`${where}: not an absolute normalised path`)
  if (typeof ctx.installDir !== 'string' || typeof ctx.agent !== 'string' || ctx.agent.length === 0) return errors.push(`${where}: no install dir or agent to check it against`)
  const own = `${normalize(`${ctx.installDir}${sep}agents${sep}${ctx.agent}`)}${sep}`
  if (!v.startsWith(own)) return errors.push(`${where}: outside agents/${ctx.agent}/`)
  let real
  try {
    real = (ctx.realpath ?? realpathSync)(v)
  } catch {
    return errors.push(`${where}: does not resolve`)
  }
  let realOwn
  try {
    realOwn = `${(ctx.realpath ?? realpathSync)(own.slice(0, -1))}${sep}`
  } catch {
    return errors.push(`${where}: agents/${ctx.agent} does not resolve`)
  }
  if (!`${real}${sep}`.startsWith(realOwn)) errors.push(`${where}: resolves outside agents/${ctx.agent}/`)
}

/**
 * Check one parsed settings file. `ctx`:
 *   installDir, agent        for GH_CONFIG_DIR (agent-local)
 *   realpath                 optional replacement for fs.realpathSync
 *   enabledPlugins           optional: the exact map the provisioning sets (agent-user), or the allowed ids' map
 *   sharedMarketplaces       optional: the shared file's extraKnownMarketplaces (agent-user must equal it)
 *   statusLineCommands       the fixed commands a statusLine may run (agent-user); absent = none allowed
 * Returns { ok, errors, alerts }: ok is errors.length === 0; alerts are unknown key names in a user kind.
 * Messages name keys and reasons, never a value.
 */
export function validateSettings(kind, obj, ctx = {}) {
  const errors = []
  const alerts = []
  if (!KINDS.includes(kind)) return { ok: false, errors: [`unknown settings kind ${JSON.stringify(kind)}`], alerts }
  if (!isPlainObject(obj)) return { ok: false, errors: ['the file is not a JSON object'], alerts }
  const strict = STRICT_KEYS[kind]
  for (const key of Object.keys(obj)) {
    if (strict) {
      if (!strict.includes(key)) errors.push(`${key}: not allowed in ${kind}`)
    } else if (HOOK_SWITCH_KEYS.includes(key) || HELPER_COMMAND_KEYS.includes(key) || key === 'env' || (key === 'permissions' && kind === 'shared-user')) {
      errors.push(`${key}: not allowed in ${kind}`)
    } else if (key === 'statusLine' && kind === 'shared-user') {
      errors.push(`${key}: not allowed in ${kind}`)
    } else if (!KNOWN_USER_KEYS[kind].includes(key)) {
      alerts.push(key)
    }
  }
  if (kind === 'agent-project') {
    if ('hooks' in obj && !isPlainObject(obj.hooks)) errors.push('hooks: not an object')
    if ('permissions' in obj) {
      const p = obj.permissions
      if (!isPlainObject(p)) errors.push('permissions: not an object')
      else {
        for (const k of Object.keys(p)) if (!PROJECT_PERMISSION_KEYS.includes(k)) errors.push(`permissions.${k}: not allowed`)
        if ('allow' in p) stringList(errors, 'permissions.allow', p.allow)
        if ('deny' in p) stringList(errors, 'permissions.deny', p.deny)
        if ('additionalDirectories' in p) stringList(errors, 'permissions.additionalDirectories', p.additionalDirectories, { absolute: true })
        if ('defaultMode' in p && !DEFAULT_MODES.includes(p.defaultMode)) errors.push('permissions.defaultMode: not one the scaffold writes')
      }
    }
    if ('enabledPlugins' in obj) pluginMap(errors, 'enabledPlugins', obj.enabledPlugins, undefined)
    if ('effortLevel' in obj && !EFFORT_LEVELS.includes(obj.effortLevel)) errors.push('effortLevel: not a known level')
  }
  if (kind === 'agent-local') {
    if ('env' in obj) {
      if (!isPlainObject(obj.env)) errors.push('env: not an object')
      else {
        for (const name of Object.keys(obj.env)) if (!ENV_NAMES.includes(name)) errors.push(`env.${name}: not an allowed name`)
        if ('GH_CONFIG_DIR' in obj.env) ghConfigDir(errors, obj.env.GH_CONFIG_DIR, ctx)
      }
    }
    if ('permissions' in obj) {
      const p = obj.permissions
      if (!isPlainObject(p)) errors.push('permissions: not an object')
      else {
        for (const k of Object.keys(p)) if (k !== 'deny') errors.push(`permissions.${k}: not allowed in agent-local`)
        if ('deny' in p) stringList(errors, 'permissions.deny', p.deny)
      }
    }
  }
  if ('claudeMdExcludes' in obj) stringList(errors, 'claudeMdExcludes', obj.claudeMdExcludes)
  if (kind === 'agent-user' || kind === 'shared-user') {
    if ('enabledPlugins' in obj) pluginMap(errors, 'enabledPlugins', obj.enabledPlugins, kind === 'agent-user' ? ctx.enabledPlugins : undefined)
    if ('skipDangerousModePermissionPrompt' in obj && typeof obj.skipDangerousModePermissionPrompt !== 'boolean') errors.push('skipDangerousModePermissionPrompt: not a boolean')
    if ('extraKnownMarketplaces' in obj) {
      if (!isPlainObject(obj.extraKnownMarketplaces)) errors.push('extraKnownMarketplaces: not an object')
      else if (kind === 'agent-user' && ctx.sharedMarketplaces !== undefined && canonicalJson(obj.extraKnownMarketplaces) !== canonicalJson(ctx.sharedMarketplaces)) {
        errors.push('extraKnownMarketplaces: differs from the shared file')
      }
    }
  }
  // The isolated provisioning pins a strict profile's mode here (agent-process.ts provisionIsolatedConfigDir ->
  // agent-scaffold.ts enforceStrictPermissionMode, profile developer-junior): exactly that object and nothing else.
  if (kind === 'agent-user' && 'permissions' in obj && canonicalJson(obj.permissions) !== canonicalJson(STRICT_PIN)) {
    errors.push('permissions: only the strict-profile pin { defaultMode: "dontAsk" } in agent-user')
  }
  if (kind === 'agent-user' && 'statusLine' in obj) {
    const s = obj.statusLine
    const allowed = Array.isArray(ctx.statusLineCommands) ? ctx.statusLineCommands : []
    if (!isPlainObject(s) || s.type !== 'command' || typeof s.command !== 'string' || !allowed.includes(s.command)) {
      errors.push('statusLine: not one of the fixed commands')
    } else {
      for (const k of Object.keys(s)) if (!['type', 'command', 'padding'].includes(k)) errors.push(`statusLine.${k}: not allowed`)
    }
  }
  return { ok: errors.length === 0, errors, alerts: [...new Set(alerts)].sort() }
}
