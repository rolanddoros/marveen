/**
 * Generate the sub-agent hook lock from the hook manifest (Fork C settings-protect addendum 1 D2-SEC-1 (b), K1):
 *
 *   npm run hooks:lock                  # write scripts/hooks/sub-hooks.lock.json into this checkout
 *   npm run hooks:lock -- --check       # write nothing; exit 1 when the lock differs from the manifest
 *   npm run hooks:lock -- --root <dir>  # another checkout (tests); never the live install
 *
 * The lock is the manifest's sub render with ${ROOT}, ${NODE_BIN}, ${SENDER_ROLE_POLICY} and ${PRECOMPACT_PROMPT}
 * unexpanded, per entry with its switch, so the standalone verifier (scripts/hooks/verify-gate-wiring.mjs) can
 * assemble the expected block for any agent without importing src/ or dist/ (scripts/hooks/sub-hooks-lock.mjs).
 * It refuses the live install (/root/marveen, also through a symlink), like hooks:generate: a lock change reaches
 * the install only by a merged PR. Exit codes: 0 done / matches, 1 --check found a difference, 2 usage or I/O
 * error, or the live install refused.
 */
import { existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HOOK_MANIFEST, matchersOf, renderHooks, specFor, type HookEvent, type HookManifest, type RenderedHook } from '../src/web/hooks/manifest.js'
// @ts-expect-error -- plain .mjs hook module, no types
import { LOCK_FORMAT, PLACEHOLDERS, lockSha256 } from './hooks/sub-hooks-lock.mjs'

export const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const LIVE_INSTALL_ROOT = '/root/marveen'
export const LOCK_REL = join('scripts', 'hooks', 'sub-hooks.lock.json')

const USAGE = 'usage: npm run hooks:lock [-- --check] [-- --root <checkout>]'
// Render-time stand-ins that pass the manifest's own path checks; replaced by the placeholders afterwards.
const SENTINEL = {
  root: '/marveen-lock-root',
  nodeBin: '/marveen-lock-node-bin/node',
  senderRolePolicy: 'MARVEENLOCKSENDERROLEPOLICY',
  precompact: 'MARVEEN-LOCK-PRECOMPACT-PROMPT',
} as const

type Print = (line: string) => void
type LockEntry = { profileFlag?: string; agentFlag?: string; matchers: Array<string | null>; hook: RenderedHook; hookThreadReply?: RenderedHook }

function toPlaceholders<T>(v: T): T {
  const text = JSON.stringify(v)
    .replaceAll(SENTINEL.nodeBin, PLACEHOLDERS.nodeBin)
    .replaceAll(SENTINEL.root, PLACEHOLDERS.root)
    .replaceAll(SENTINEL.senderRolePolicy, PLACEHOLDERS.senderRolePolicy)
    .replaceAll(SENTINEL.precompact, PLACEHOLDERS.precompact)
  for (const s of Object.values(SENTINEL)) if (text.includes(s)) throw new Error(`a render-time stand-in survived: ${s}`)
  return JSON.parse(text) as T
}

/** The lock body for a manifest, sha256 included: every sub entry rendered with all switches on, once per variant. */
export function buildLock(m: HookManifest = HOOK_MANIFEST): Record<string, unknown> {
  const allOn = (threadReply: boolean) => renderHooks(m, 'sub', {
    root: SENTINEL.root,
    nodeBin: SENTINEL.nodeBin,
    profile: { destructiveGate: true, credentialGate: true, secondReviewer: true },
    agent: { heartbeat: true, browser: true, threadReply, senderRolePolicy: SENTINEL.senderRolePolicy },
    prompts: { precompact: SENTINEL.precompact },
  })
  const plain = allOn(false)
  const reply = allOn(true)
  const byId = new Map(m.entries.map((e) => [e.id, e] as const))
  const entries: Record<string, LockEntry> = {}
  const layout: Array<[string, string[][]]> = []
  for (const [event, slots] of Object.entries(m.layout.sub ?? {}) as Array<[HookEvent, ReadonlyArray<string | readonly string[]>]>) {
    const rows: string[][] = []
    let g = 0
    for (const slot of slots) {
      const ids = typeof slot === 'string' ? [slot] : [...slot]
      rows.push(ids)
      const groupCount = matchersOf(specFor(byId.get(ids[0])!, 'sub')).length
      ids.forEach((id, i) => {
        const e = byId.get(id)!
        const hook = plain[event]![g].hooks[i]
        const hookReply = reply[event]![g].hooks[i]
        entries[id] = {
          ...(e.profileFlag ? { profileFlag: e.profileFlag } : {}),
          ...(e.agentFlag ? { agentFlag: e.agentFlag } : {}),
          matchers: matchersOf(specFor(e, 'sub')).map((x) => x ?? null),
          hook,
          ...(JSON.stringify(hookReply) !== JSON.stringify(hook) ? { hookThreadReply: hookReply } : {}),
        }
      })
      g += groupCount
    }
    if (g !== (plain[event]?.length ?? 0)) throw new Error(`hooks:lock: ${event}: ${g} groups walked, ${plain[event]?.length ?? 0} rendered`)
    layout.push([event, rows])
  }
  const body = toPlaceholders({ format: LOCK_FORMAT, layout, entries })
  return { ...body, sha256: lockSha256(body) }
}

export function renderLockText(m: HookManifest = HOOK_MANIFEST): string {
  return `${JSON.stringify(buildLock(m), null, 2)}\n`
}

function real(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path)
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, text, { encoding: 'utf-8', mode: 0o644 })
    renameSync(tmp, path)
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp)
    throw err
  }
}

/** The command, as a function (the test calls it in-process). Returns the exit code. */
export function runGenerateSubHooksLock(argv: readonly string[], out: Print = console.log, err: Print = console.error): number {
  let check = false
  let rootArg: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') check = true
    else if (argv[i] === '--root' && argv[i + 1] !== undefined) rootArg = argv[++i]
    else {
      err(`hooks:lock: unknown argument ${argv[i]}\n${USAGE}`)
      return 2
    }
  }
  const root = resolve(rootArg ?? CODE_ROOT)
  const hooksDir = join(root, 'scripts', 'hooks')
  if (real(hooksDir) === real(join(LIVE_INSTALL_ROOT, 'scripts', 'hooks'))) {
    err(`hooks:lock: refusing ${root}: it is the live install. Generate in a checkout, merge by PR.`)
    return 2
  }
  const lockPath = join(root, LOCK_REL)
  try {
    const text = renderLockText()
    const same = existsSync(lockPath) && readFileSync(lockPath, 'utf-8') === text
    if (check) {
      if (!same) {
        err(`hooks:lock --check: ${lockPath} ${existsSync(lockPath) ? 'differs from the manifest' : 'is missing'}; run npm run hooks:lock and commit it (edit the manifest, not the lock).`)
        return 1
      }
      out('hooks:lock --check: the lock matches the manifest')
      return 0
    }
    if (same) {
      out('hooks:lock: no change, the lock matches the manifest')
      return 0
    }
    writeAtomic(lockPath, text)
    out(`hooks:lock: wrote ${lockPath}`)
    return 0
  } catch (e) {
    err(`hooks:lock: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runGenerateSubHooksLock(process.argv.slice(2))
}
