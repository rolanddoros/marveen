// C1 PR 7a: the legacy marker list (src/web/claude-md/legacy-markers.ts) must
// match the marker constants the legacy writers actually use, so a block added
// upstream cannot slip past composeClaudeMd's legacy removal. The writers are
// read as SOURCE text, not imported (agent-scaffold.ts has import-time side
// effects).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FEDERATION_MARKERS, LEGACY_GENERATED_IDS, LEGACY_MARKERS } from '../web/claude-md/legacy-markers.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8')

function literals(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1])
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('legacy marker parity', () => {
  it('the generated pairs equal the BEGIN/END GENERATED constants of agent-scaffold.ts', () => {
    const src = read('web/agent-scaffold.ts')
    const begins = literals(src, /'(<!-- BEGIN GENERATED: [^']*)'/g)
    const ends = literals(src, /'(<!-- END GENERATED: [^']*)'/g)
    const generated = LEGACY_MARKERS.filter((p) => p.id !== FEDERATION_MARKERS.id)
    expect(new Set(begins)).toEqual(new Set(generated.map((p) => p.begin)))
    expect(new Set(ends)).toEqual(new Set(generated.map((p) => p.end)))
    expect(begins.length).toBe(LEGACY_GENERATED_IDS.length)
    expect(LEGACY_GENERATED_IDS.length).toBe(14)
  })

  it('the federation pair equals FEDERATION_BLOCK_BEGIN / _END of federation/onboarding.ts', () => {
    const src = read('web/federation/onboarding.ts')
    const begin = literals(src, /export const FEDERATION_BLOCK_BEGIN = '([^']*)'/g)
    const end = literals(src, /export const FEDERATION_BLOCK_END = '([^']*)'/g)
    expect(begin).toEqual([FEDERATION_MARKERS.begin])
    expect(end).toEqual([FEDERATION_MARKERS.end])
    expect(LEGACY_MARKERS).toContainEqual(FEDERATION_MARKERS)
  })

  it('no other product file defines a generated-block or federation marker', () => {
    const owners = new Set(['web/agent-scaffold.ts', 'web/federation/onboarding.ts'])
    const offenders = walk(SRC)
      .map((p) => relative(SRC, p).split('\\').join('/'))
      .filter((rel) => !rel.startsWith('__tests__/') && !rel.startsWith('web/claude-md/') && !owners.has(rel))
      .filter((rel) => /['"`]<!-- (BEGIN|END) GENERATED: |MARVEEN-FEDERATION:(BEGIN|END)/.test(read(rel)))
    expect(offenders).toEqual([])
  })

  it('ids are unique and every pair is distinct', () => {
    const ids = LEGACY_MARKERS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    const lines = LEGACY_MARKERS.flatMap((p) => [p.begin, p.end])
    expect(new Set(lines).size).toBe(lines.length)
  })
})
