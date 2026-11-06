// C1 PR 10b: the guarded installer of the rendered product skills (Kevin 12987 + 12988, delta 1 part A).
//
// Target: <project>/.claude/skills/marveen-<name>/SKILL.md for the six
// PRODUCT_SKILLS. Every agent sees that folder, so the renderer may only ever
// touch what it wrote itself, and it proves that with a manifest:
//   store/claude-md-backup/product-skills/MANIFEST.json
//   { "version": 1, "files": { "marveen-<name>/SKILL.md": "<sha256>" } }
// The "marveen-" prefix is NOT the renderer's own namespace: other marveen-*
// skills live in both folders today, and nothing here works on a pattern.
//
// installProductSkills stops (SkillInstallError, nothing written) when:
// - ~/.claude/skills (the dashboard process's home, symlinks resolved) holds
//   any entry named like one of the six: the renderer never writes there, so
//   whatever sits there is not its own;
// - the project folder holds an entry named like one of the six that is not a
//   plain directory with exactly one regular SKILL.md whose sha is the
//   manifest's;
// - the manifest exists but does not parse, or the two folders are the same.
// Everything is rendered and checked before the first write; a file is
// written only when its bytes change, then the manifest is rewritten. A crash
// between the two leaves a SKILL.md the manifest does not know: the next run
// stops on it (fail-closed) and names the file.
//
// removeProductSkills (the last flag off) deletes exactly the manifest's
// files whose sha still matches, then each skill directory only if it is now
// empty, then the manifest. A file someone changed is no longer the
// renderer's and stays (listed in `kept`).

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { atomicWriteFileSync } from '../atomic-write.js'
import { BACKUP_DIR_NAME } from './backup.js'
import { PRODUCT_SKILLS, renderProductSkill, SKILL_TEMPLATES_DIR, type SkillContext } from './skills.js'

export interface SkillInstallPaths {
  projectSkillsDir: string
  userSkillsDir: string
  manifestPath: string
}

export function defaultSkillInstallPaths(projectRoot: string, storeDir: string, home: string = homedir()): SkillInstallPaths {
  return {
    projectSkillsDir: join(projectRoot, '.claude', 'skills'),
    userSkillsDir: join(home, '.claude', 'skills'),
    manifestPath: join(storeDir, BACKUP_DIR_NAME, 'product-skills', 'MANIFEST.json'),
  }
}

export class SkillInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillInstallError'
  }
}

const sha = (text: string) => createHash('sha256').update(text, 'utf-8').digest('hex')
const key = (name: string) => `${name}/SKILL.md`

// The manifest's files map; null when there is no manifest. Throws when it is there but unusable.
export function readSkillManifest(path: string): Record<string, string> | null {
  if (!existsSync(path)) return null
  let v: unknown
  try {
    v = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    throw new SkillInstallError(`${path}: not valid JSON; ownership of the product skills cannot be told, nothing is touched`)
  }
  const files = (v as { files?: unknown })?.files
  if ((v as { version?: unknown })?.version !== 1 || typeof files !== 'object' || files === null || Array.isArray(files)
    || !Object.values(files).every((s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s))) {
    throw new SkillInstallError(`${path}: not a version 1 product-skill manifest; nothing is touched`)
  }
  return files as Record<string, string>
}

function writeManifest(path: string, files: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
  atomicWriteFileSync(path, `${JSON.stringify({ version: 1, files: sorted }, null, 2)}\n`)
}

function real(path: string): string {
  try { return realpathSync(path) } catch { return resolve(path) }
}

// The entry `name` in `dir`, by lstat (a symlink is an entry, never followed); null when absent.
function entry(dir: string, name: string): import('node:fs').Stats | null {
  try { return lstatSync(join(dir, name)) } catch { return null }
}

// Whether the project folder's `name` is exactly the renderer's own output as the manifest records it.
function ownedByRenderer(paths: SkillInstallPaths, name: string, manifest: Record<string, string>): boolean {
  const dir = join(paths.projectSkillsDir, name)
  const st = entry(paths.projectSkillsDir, name)
  if (st === null || !st.isDirectory()) return false
  const names = readdirSync(dir)
  if (names.length !== 1 || names[0] !== 'SKILL.md') return false
  const f = lstatSync(join(dir, 'SKILL.md'))
  return f.isFile() && manifest[key(name)] === sha(readFileSync(join(dir, 'SKILL.md'), 'utf-8'))
}

export interface InstallResult { written: string[]; unchanged: string[] }

export function installProductSkills(paths: SkillInstallPaths, ctx: SkillContext, templatesDir: string = SKILL_TEMPLATES_DIR): InstallResult {
  for (const p of [paths.projectSkillsDir, paths.userSkillsDir, paths.manifestPath]) {
    if (!isAbsolute(p)) throw new SkillInstallError(`not an absolute path: ${p}`)
  }
  if (real(paths.projectSkillsDir) === real(paths.userSkillsDir)) {
    throw new SkillInstallError(`the project skills folder is the user skills folder (${real(paths.userSkillsDir)}); refusing to install`)
  }
  const rendered = PRODUCT_SKILLS.map((name) => ({ name, text: renderProductSkill(name, ctx, templatesDir) }))
  const manifest = readSkillManifest(paths.manifestPath) ?? {}
  const userDir = real(paths.userSkillsDir)
  for (const { name } of rendered) {
    if (entry(userDir, name) !== null) {
      throw new SkillInstallError(`${join(userDir, name)} exists: a ${name} skill the renderer did not write; nothing installed`)
    }
    if (entry(paths.projectSkillsDir, name) !== null && !ownedByRenderer(paths, name, manifest)) {
      throw new SkillInstallError(`${join(paths.projectSkillsDir, name)} is not the renderer's own (not in the manifest, changed, or holds other files); nothing installed`)
    }
  }
  const result: InstallResult = { written: [], unchanged: [] }
  const next = { ...manifest }
  for (const { name, text } of rendered) {
    const file = join(paths.projectSkillsDir, name, 'SKILL.md')
    next[key(name)] = sha(text)
    if (existsSync(file) && readFileSync(file, 'utf-8') === text) {
      result.unchanged.push(name)
      continue
    }
    mkdirSync(dirname(file), { recursive: true })
    atomicWriteFileSync(file, text)
    result.written.push(name)
  }
  if (result.written.length > 0 || JSON.stringify(next) !== JSON.stringify(manifest)) writeManifest(paths.manifestPath, next)
  return result
}

// Whether every named skill is installed exactly as the manifest records it (the v2 region may only point at those).
export function productSkillsInstalled(paths: SkillInstallPaths, names: readonly string[]): boolean {
  let manifest: Record<string, string> | null
  try { manifest = readSkillManifest(paths.manifestPath) } catch { return false }
  if (manifest === null) return false
  return names.every((n) => manifest![key(n)] !== undefined && ownedByRenderer(paths, n, manifest!))
}

export interface RemoveResult { removed: string[]; kept: string[] }

export function removeProductSkills(paths: SkillInstallPaths): RemoveResult {
  const manifest = readSkillManifest(paths.manifestPath)
  const result: RemoveResult = { removed: [], kept: [] }
  if (manifest === null) return result
  for (const [rel, digest] of Object.entries(manifest)) {
    const file = join(paths.projectSkillsDir, rel)
    // Only a manifest key of the expected shape is ever acted on: never a path outside the folder.
    if (!/^marveen-[a-z-]+\/SKILL\.md$/.test(rel) || !(PRODUCT_SKILLS as readonly string[]).includes(dirname(rel))) {
      result.kept.push(rel)
      continue
    }
    let st: import('node:fs').Stats | null = null
    try { st = lstatSync(file) } catch { /* absent */ }
    if (st === null) continue
    if (!st.isFile() || sha(readFileSync(file, 'utf-8')) !== digest) {
      result.kept.push(rel)
      continue
    }
    unlinkSync(file)
    result.removed.push(rel)
    try { rmdirSync(dirname(file)) } catch { /* not empty: something else lives there, it stays */ }
  }
  unlinkSync(paths.manifestPath)
  return result
}
