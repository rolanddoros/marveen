/**
 * Generate the main agent's hook wiring from the hook manifest (C3-4):
 *
 *   npm run hooks:generate                  # write both files into this checkout
 *   npm run hooks:generate -- --check       # write nothing; exit 1 when a file differs
 *   npm run hooks:generate -- --root <dir>  # another checkout (tests); never the live install
 *
 * The two files: the `hooks` block of .claude/settings.json (the rest of the
 * file is kept) and the sidecar .claude/hooks.metadata.json. The content comes
 * from THIS checkout's manifest and hook lock list (src/web/hooks/main-artifact.ts);
 * --root only says where to write. A file is replaced atomically (temp file in
 * the same directory, then rename), and only when its text changes.
 *
 * It refuses the live install (/root/marveen, also through a symlink): the
 * main agent reads the tracked file there, and a change reaches it only by a
 * merged PR and a pull. Exit codes: 0 done / both match, 1 --check found a
 * difference, 2 usage or I/O error, or the live install refused.
 */
import { existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HOOK_MANIFEST } from '../src/web/hooks/manifest.js'
import { readHookSwitchLocks, renderMainSettingsText, renderMainSidecarText } from '../src/web/hooks/main-artifact.js'

/** The checkout this script belongs to: its manifest and lock list are the source. */
export const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const LIVE_INSTALL_ROOT = '/root/marveen'

const USAGE = 'usage: npm run hooks:generate [-- --check] [-- --root <checkout>]'

type Print = (line: string) => void

function real(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path)
}

function firstDifferentLine(a: string, b: string): number {
  const x = a.split('\n')
  const y = b.split('\n')
  let i = 0
  while (i < x.length && i < y.length && x[i] === y[i]) i++
  return i + 1
}

function writeAtomic(path: string, text: string): void {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, text, { encoding: 'utf-8', mode })
    renameSync(tmp, path)
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp)
    throw err
  }
}

/** The command, as a function (the test calls it in-process). Returns the exit code. */
export function runGenerateMainHooks(argv: readonly string[], out: Print = console.log, err: Print = console.error): number {
  let check = false
  let rootArg: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') check = true
    else if (argv[i] === '--root' && argv[i + 1] !== undefined) rootArg = argv[++i]
    else {
      err(`hooks:generate: unknown argument ${argv[i]}\n${USAGE}`)
      return 2
    }
  }
  const root = resolve(rootArg ?? CODE_ROOT)
  const claudeDir = join(root, '.claude')
  // Before anything is read or written: the .claude directory may not be (or
  // resolve to) the live install's, whether the root is the live install, a
  // symlink to it, or a checkout whose .claude links there.
  if (real(claudeDir) === real(join(LIVE_INSTALL_ROOT, '.claude'))) {
    err(`hooks:generate: refusing ${root}: it is the live install. Generate in a checkout, merge by PR.`)
    return 2
  }
  const settingsPath = join(claudeDir, 'settings.json')
  const sidecarPath = join(claudeDir, 'hooks.metadata.json')
  try {
    if (!existsSync(settingsPath)) {
      err(`hooks:generate: ${settingsPath} does not exist (its non-hook keys are kept, so it must be there)`)
      return 2
    }
    const wanted: Array<[string, string]> = [
      [settingsPath, renderMainSettingsText(HOOK_MANIFEST, readFileSync(settingsPath, 'utf-8'))],
      [sidecarPath, renderMainSidecarText(HOOK_MANIFEST, readHookSwitchLocks(CODE_ROOT))],
    ]
    const stale = wanted.filter(([path, text]) => !existsSync(path) || readFileSync(path, 'utf-8') !== text)
    if (check) {
      for (const [path, text] of stale) {
        const where = existsSync(path) ? `differs from the manifest at line ${firstDifferentLine(readFileSync(path, 'utf-8'), text)}` : 'is missing'
        err(`hooks:generate --check: ${path} ${where}`)
      }
      if (stale.length > 0) {
        err('hooks:generate --check: run npm run hooks:generate and commit both files (edit the manifest, not the generated files).')
        return 1
      }
      out('hooks:generate --check: both files match the manifest')
      return 0
    }
    for (const [path, text] of stale) {
      writeAtomic(path, text)
      out(`hooks:generate: wrote ${path}`)
    }
    if (stale.length === 0) out('hooks:generate: no change, both files match the manifest')
    return 0
  } catch (e) {
    err(`hooks:generate: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runGenerateMainHooks(process.argv.slice(2))
}
