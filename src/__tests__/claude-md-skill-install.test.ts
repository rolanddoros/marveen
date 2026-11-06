// C1 PR 10b: the guarded product-skill installer (src/web/claude-md/skill-install.ts), Kevin 12987 + 12988.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import {
  defaultSkillInstallPaths, installProductSkills, productSkillsInstalled, readSkillManifest, removeProductSkills,
  SkillInstallError, type SkillInstallPaths,
} from '../web/claude-md/skill-install.js'
import { PRODUCT_SKILLS, renderProductSkill, type SkillContext } from '../web/claude-md/skills.js'

let work: string
let paths: SkillInstallPaths
let ctx: SkillContext

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'cmd-skinst-'))
  mkdirSync(join(work, 'root', '.claude', 'skills'), { recursive: true })
  mkdirSync(join(work, 'home', '.claude', 'skills'), { recursive: true })
  paths = defaultSkillInstallPaths(join(work, 'root'), join(work, 'root', 'store'), join(work, 'home'))
  ctx = { projectRoot: join(work, 'root'), mainAgentId: 'boss', dashboardOrigin: 'http://localhost:3420' }
})
afterEach(() => { rmSync(work, { recursive: true, force: true }) })

const sha = (t: string) => createHash('sha256').update(t, 'utf-8').digest('hex')
function snap(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) out.push(`L ${relative(dir, p)} ${readlinkSync(p)}`)
      else if (st.isDirectory()) { out.push(`D ${relative(dir, p)}`); walk(p) }
      else out.push(`F ${relative(dir, p)} ${sha(readFileSync(p, 'utf-8'))}`)
    }
  }
  walk(dir)
  return out
}
const foreign = (dir: string, name: string, text = '---\nname: x\n---\nforeign\n') => {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), text)
}

describe('install', () => {
  it('writes the six rendered skills and a manifest of their sha256; the paths are the design ones', () => {
    expect(paths.manifestPath).toBe(join(work, 'root', 'store', 'claude-md-backup', 'product-skills', 'MANIFEST.json'))
    const r = installProductSkills(paths, ctx)
    expect(r.written.sort()).toEqual([...PRODUCT_SKILLS].sort())
    const manifest = readSkillManifest(paths.manifestPath)!
    expect(Object.keys(manifest).sort()).toEqual(PRODUCT_SKILLS.map((n) => `${n}/SKILL.md`).sort())
    for (const n of PRODUCT_SKILLS) {
      const text = readFileSync(join(paths.projectSkillsDir, n, 'SKILL.md'), 'utf-8')
      expect(text).toBe(renderProductSkill(n, ctx))
      expect(manifest[`${n}/SKILL.md`]).toBe(sha(text))
    }
    expect(productSkillsInstalled(paths, PRODUCT_SKILLS)).toBe(true)
  })

  it('a second run writes nothing (same bytes, manifest untouched)', () => {
    installProductSkills(paths, ctx)
    const before = snap(work)
    const r = installProductSkills(paths, ctx)
    expect(r.written).toEqual([])
    expect(snap(work)).toEqual(before)
  })

  it('a changed render (another dashboard origin) rewrites the renderer-owned files and the manifest', () => {
    installProductSkills(paths, ctx)
    const r = installProductSkills(paths, { ...ctx, dashboardOrigin: 'http://127.0.0.1:4000' })
    expect(r.written.length).toBeGreaterThan(0)
    expect(productSkillsInstalled(paths, PRODUCT_SKILLS)).toBe(true)
  })

  it('a foreign marveen-<x> skill next to the six survives install, re-install and removal byte-identical', () => {
    foreign(paths.projectSkillsDir, 'marveen-frissites')
    foreign(paths.userSkillsDir, 'marveen-mentes')
    const keep = (d: string, n: string) => snap(join(d, n))
    const before = [keep(paths.projectSkillsDir, 'marveen-frissites'), keep(paths.userSkillsDir, 'marveen-mentes')]
    installProductSkills(paths, ctx)
    installProductSkills(paths, { ...ctx, mainAgentId: 'other' })
    removeProductSkills(paths)
    expect([keep(paths.projectSkillsDir, 'marveen-frissites'), keep(paths.userSkillsDir, 'marveen-mentes')]).toEqual(before)
  })
})

describe('collision: stop, write nothing', () => {
  const stops = (msg: RegExp) => {
    const before = snap(work)
    expect(() => installProductSkills(paths, ctx)).toThrow(SkillInstallError)
    expect(() => installProductSkills(paths, ctx)).toThrow(msg)
    expect(snap(work)).toEqual(before)
  }

  it('a skill of one of the six names in the project folder that the manifest does not know', () => {
    foreign(paths.projectSkillsDir, 'marveen-messaging')
    stops(/not the renderer's own/)
  })

  it('the renderer\'s own text but no manifest entry still counts as foreign', () => {
    foreign(paths.projectSkillsDir, 'marveen-approvals', renderProductSkill('marveen-approvals', ctx))
    stops(/not the renderer's own/)
  })

  it('a renderer-owned skill folder that got another file, or a changed SKILL.md', () => {
    installProductSkills(paths, ctx)
    writeFileSync(join(paths.projectSkillsDir, 'marveen-approvals', 'notes.md'), 'x')
    stops(/not the renderer's own/)
    rmSync(join(paths.projectSkillsDir, 'marveen-approvals', 'notes.md'))
    writeFileSync(join(paths.projectSkillsDir, 'marveen-messaging', 'SKILL.md'), 'edited by hand\n')
    stops(/not the renderer's own/)
  })

  it('a symlink or a plain file of one of the six names in the project folder', () => {
    symlinkSync(join(work, 'home'), join(paths.projectSkillsDir, 'marveen-fleet-auth'))
    stops(/not the renderer's own/)
    rmSync(join(paths.projectSkillsDir, 'marveen-fleet-auth'))
    writeFileSync(join(paths.projectSkillsDir, 'marveen-fleet-auth'), 'x')
    stops(/not the renderer's own/)
  })

  it('any entry of one of the six names under ~/.claude/skills, followed through a symlinked skills folder', () => {
    foreign(paths.userSkillsDir, 'marveen-background-work')
    stops(/did not write/)
    rmSync(join(paths.userSkillsDir, 'marveen-background-work'), { recursive: true })
    const realUser = join(work, 'elsewhere')
    mkdirSync(join(realUser, 'marveen-directive-auth'), { recursive: true })
    rmSync(paths.userSkillsDir, { recursive: true })
    symlinkSync(realUser, paths.userSkillsDir)
    stops(/did not write/)
  })

  it('an unusable manifest, or the same folder twice', () => {
    mkdirSync(join(paths.manifestPath, '..'), { recursive: true })
    writeFileSync(paths.manifestPath, '{broken')
    stops(/not valid JSON/)
    writeFileSync(paths.manifestPath, JSON.stringify({ version: 2, files: {} }))
    stops(/not a version 1/)
    rmSync(paths.manifestPath)
    const same = { ...paths, userSkillsDir: paths.projectSkillsDir }
    expect(() => installProductSkills(same, ctx)).toThrow(/is the user skills folder/)
  })
})

describe('productSkillsInstalled: the v2 region may point only at these', () => {
  it('false without a manifest, for a missing or changed skill, and for a name the manifest does not hold', () => {
    expect(productSkillsInstalled(paths, ['marveen-messaging'])).toBe(false)
    installProductSkills(paths, ctx)
    expect(productSkillsInstalled(paths, ['marveen-messaging', 'marveen-approvals'])).toBe(true)
    expect(productSkillsInstalled(paths, ['marveen-unknown'])).toBe(false)
    writeFileSync(join(paths.projectSkillsDir, 'marveen-messaging', 'SKILL.md'), 'changed\n')
    expect(productSkillsInstalled(paths, ['marveen-messaging'])).toBe(false)
    rmSync(join(paths.projectSkillsDir, 'marveen-approvals'), { recursive: true })
    expect(productSkillsInstalled(paths, ['marveen-approvals'])).toBe(false)
  })
})

describe('removal when the last flag goes off', () => {
  it('deletes exactly the manifest files with a matching sha, their now-empty folders and the manifest', () => {
    const before = snap(work)
    installProductSkills(paths, ctx)
    const r = removeProductSkills(paths)
    expect(r.removed.sort()).toEqual(PRODUCT_SKILLS.map((n) => `${n}/SKILL.md`).sort())
    expect(r.kept).toEqual([])
    expect(existsSync(paths.manifestPath)).toBe(false)
    // The folders it created stay only as the empty store/claude-md-backup/product-skills parent.
    expect(snap(work).filter((l) => !l.includes('store'))).toEqual(before)
  })

  it('a hand-edited renderer file stays, and so does its folder; a folder with an extra file stays', () => {
    installProductSkills(paths, ctx)
    writeFileSync(join(paths.projectSkillsDir, 'marveen-messaging', 'SKILL.md'), 'mine now\n')
    writeFileSync(join(paths.projectSkillsDir, 'marveen-approvals', 'extra.md'), 'x')
    const r = removeProductSkills(paths)
    expect(r.kept).toEqual(['marveen-messaging/SKILL.md'])
    expect(readFileSync(join(paths.projectSkillsDir, 'marveen-messaging', 'SKILL.md'), 'utf-8')).toBe('mine now\n')
    expect(readdirSync(join(paths.projectSkillsDir, 'marveen-approvals'))).toEqual(['extra.md'])
    expect(existsSync(join(paths.projectSkillsDir, 'marveen-fleet-auth'))).toBe(false)
  })

  it('no manifest: nothing happens; a manifest key outside the six is never acted on', () => {
    foreign(paths.projectSkillsDir, 'marveen-frissites')
    const before = snap(work)
    expect(removeProductSkills(paths)).toEqual({ removed: [], kept: [] })
    expect(snap(work)).toEqual(before)
    mkdirSync(join(paths.manifestPath, '..'), { recursive: true })
    const f = readFileSync(join(paths.projectSkillsDir, 'marveen-frissites', 'SKILL.md'), 'utf-8')
    writeFileSync(paths.manifestPath, JSON.stringify({ version: 1, files: { 'marveen-frissites/SKILL.md': sha(f), '../../x/SKILL.md': sha(f) } }))
    const r = removeProductSkills(paths)
    expect(r.removed).toEqual([])
    expect(r.kept.sort()).toEqual(['../../x/SKILL.md', 'marveen-frissites/SKILL.md'])
    expect(readFileSync(join(paths.projectSkillsDir, 'marveen-frissites', 'SKILL.md'), 'utf-8')).toBe(f)
  })
})
