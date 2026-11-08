/**
 * C3-sch: the manifest carries the main sidecar's own text (each group's
 * purpose, and the id labels of the matcher-array groups), copied verbatim
 * from the tracked .claude/hooks.metadata.json. This test proves the copy: for
 * every main matcher group, in written order, the id and purpose the manifest
 * derives (sidecarGroupText) equal the committed sidecar entry at the same
 * event and index, and the group's fingerprint (the hook-metadata.py rule)
 * equals that entry's fingerprint, so each slot is tied to the right group.
 * C3-4 replaces this test with the generator check (the sidecar generated
 * from the manifest, byte for byte).
 *
 * Read only. The sidecar is the one of THIS checkout, located from this
 * file's own path, never the live install (same guard as hook-manifest-main).
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HOOK_MANIFEST,
  renderHooks,
  sidecarGroupText,
  specFor,
  validateManifest,
  type HookEvent,
  type HookManifest,
  type HookManifestEntry,
  type RenderedGroup,
} from '../web/hooks/manifest.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LIVE_INSTALL_ROOT = '/root/marveen'
const SIDECAR_PATH = join(REPO_ROOT, '.claude', 'hooks.metadata.json')

interface SidecarEntry { index: number; id: string; hook: string; gate: boolean; purpose: string; fingerprint: string }
type Sidecar = Record<string, SidecarEntry[]>

function committedSidecar(): Sidecar {
  return (JSON.parse(readFileSync(SIDECAR_PATH, 'utf-8')) as { hooks: Sidecar }).hooks
}

const entries = HOOK_MANIFEST.entries
const withEntries = (es: readonly HookManifestEntry[]): HookManifest => ({ entries: es, layout: HOOK_MANIFEST.layout })
const byId = (id: string): HookManifestEntry => {
  const e = entries.find((x) => x.id === id)
  if (!e) throw new Error(`no manifest entry ${id}`)
  return e
}
const patch = (id: string, sidecar: HookManifestEntry['sidecar']): HookManifest =>
  withEntries(entries.map((e) => (e.id === id ? { ...e, sidecar } : e)))

/** hook-metadata.py fingerprint(): sha256 over compact JSON [event, matcher or "", [command / prompt of each handler]]. */
function fingerprint(event: string, group: RenderedGroup): string {
  const body = [event, group.matcher ?? '', group.hooks.map((h) => (h.type === 'command' ? h.command : h.prompt))]
  return createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex')
}

/**
 * Every main matcher group in written order, with the entry and matcher index
 * it comes from, next to the rendered group (renderHooks walks the layout the
 * same way: one slot per entry on the main agent, one group per matcher).
 */
function mainGroups(m: HookManifest): Array<{ event: HookEvent; entry: HookManifestEntry; matcherIndex: number; group: RenderedGroup }> {
  const rendered = renderHooks(m, 'main')
  const out = []
  for (const [event, slots] of Object.entries(m.layout.main ?? {}) as Array<[HookEvent, ReadonlyArray<string | readonly string[]>]>) {
    let i = 0
    for (const slot of slots) {
      if (typeof slot !== 'string') throw new Error(`main layout ${event}: a shared group is not expected on the main agent`)
      const entry = m.entries.find((e) => e.id === slot)!
      const matcher = specFor(entry, 'main').matcher
      const count = Array.isArray(matcher) ? matcher.length : 1
      for (let matcherIndex = 0; matcherIndex < count; matcherIndex++) {
        out.push({ event, entry, matcherIndex, group: rendered[event]![i++] })
      }
    }
    if (i !== rendered[event]!.length) throw new Error(`main layout ${event}: ${i} groups walked, ${rendered[event]!.length} rendered`)
  }
  return out
}

/** Every difference between the manifest's sidecar text and a sidecar, as one line each; [] = the same. */
function sidecarTextFindings(m: HookManifest, sidecar: Sidecar): string[] {
  const out: string[] = []
  const groups = mainGroups(m)
  const events = [...new Set(groups.map((g) => g.event))]
  if (JSON.stringify(events) !== JSON.stringify(Object.keys(sidecar))) {
    out.push(`events: manifest ${events.join(',')} vs sidecar ${Object.keys(sidecar).join(',')}`)
  }
  for (const event of events) {
    const mine = groups.filter((g) => g.event === event)
    const theirs = sidecar[event] ?? []
    if (mine.length !== theirs.length) out.push(`${event}: ${mine.length} groups in the manifest, ${theirs.length} in the sidecar`)
    mine.forEach((g, index) => {
      const s = theirs[index]
      if (!s) return
      const { id, purpose } = sidecarGroupText(g.entry, event, g.matcherIndex)
      const where = `${event}[${index}] (${g.entry.id})`
      if (fingerprint(event, g.group) !== s.fingerprint) out.push(`${where}: fingerprint differs, not the sidecar's group at this slot`)
      if (id !== s.id) out.push(`${where}: id ${id} vs sidecar ${s.id}`)
      if (purpose !== s.purpose) out.push(`${where}: purpose ${JSON.stringify(purpose)} vs sidecar ${JSON.stringify(s.purpose)}`)
    })
  }
  return out
}

describe('manifest sidecar text, main scope (C3-sch)', () => {
  it('reads the sidecar of its own checkout, never the live install', () => {
    expect(REPO_ROOT).not.toBe(LIVE_INSTALL_ROOT)
    expect(realpathSync(REPO_ROOT)).not.toBe(LIVE_INSTALL_ROOT)
    const live = `${LIVE_INSTALL_ROOT}/.claude/hooks.metadata.json`
    expect(realpathSync(SIDECAR_PATH)).not.toBe(existsSync(live) ? realpathSync(live) : live)
  })

  it('every main group: the derived id and purpose equal the committed sidecar entry at the same event and index', () => {
    expect(sidecarTextFindings(HOOK_MANIFEST, committedSidecar())).toEqual([])
    const total = Object.values(committedSidecar()).reduce((n, es) => n + es.length, 0)
    expect(mainGroups(HOOK_MANIFEST)).toHaveLength(total)
    expect(total).toBe(56)
  })

  it('a changed sentence is reported, in each of the three purpose shapes', () => {
    const sentence = patch('ledger-capture', { purpose: 'Records every inbound channel message.' })
    expect(sidecarTextFindings(sentence, committedSidecar())).toEqual([
      'UserPromptSubmit[0] (ledger-capture): purpose "Records every inbound channel message." vs sidecar '
        + '"Records every inbound channel message into the conversation ledger before the agent processes it."',
    ])
    const gate = byId('outgoing-copy-gate').sidecar!
    const arr = [...(gate.purpose as readonly string[])]
    arr[6] = arr[6].replace('Telegram', 'Discord')
    expect(sidecarTextFindings(patch('outgoing-copy-gate', { ...gate, purpose: arr }), committedSidecar())).toEqual([
      'PreToolUse[7] (outgoing-copy-gate): purpose "Copy QA gate on outgoing Discord reply / edit_message text." vs sidecar '
        + '"Copy QA gate on outgoing Telegram reply / edit_message text."',
    ])
    const twin = byId('memory-frontmatter-bash-gate').sidecar!
    const byEvent = { ...(twin.purpose as Partial<Record<HookEvent, string>>), PreToolUse: 'Memory frontmatter check.' }
    expect(sidecarTextFindings(patch('memory-frontmatter-bash-gate', { purpose: byEvent }), committedSidecar())).toHaveLength(1)
  })

  it('a changed label is reported as an id difference', () => {
    const gate = byId('email-approval-gate').sidecar!
    const labels = [...gate.labels!]
    labels[5] = 'mail-family'
    expect(sidecarTextFindings(patch('email-approval-gate', { ...gate, labels }), committedSidecar())).toEqual([
      'PreToolUse[14] (email-approval-gate): id pre-tool-use/email-approval-gate/mail-family vs sidecar pre-tool-use/email-approval-gate/mail-tool-family',
    ])
  })

  it('a sidecar group the manifest lacks, or a reordered sidecar, is reported', () => {
    const short = committedSidecar()
    short.Stop = short.Stop.slice(0, 3)
    expect(sidecarTextFindings(HOOK_MANIFEST, short)).toEqual(['Stop: 4 groups in the manifest, 3 in the sidecar'])
    const swapped = committedSidecar()
    swapped.SessionStart = [swapped.SessionStart[1], swapped.SessionStart[0], ...swapped.SessionStart.slice(2)]
    expect(sidecarTextFindings(HOOK_MANIFEST, swapped)).toHaveLength(6)
  })
})

describe('manifest sidecar text, validation', () => {
  const copyGate = byId('outgoing-copy-gate').sidecar!
  const purposes = copyGate.purpose as readonly string[]

  it('accepts the shipped manifest in both scopes', () => {
    expect(() => validateManifest(HOOK_MANIFEST, 'main')).not.toThrow()
    expect(() => validateManifest(HOOK_MANIFEST, 'sub')).not.toThrow()
  })

  it('rejects a label removed from a matcher array', () => {
    expect(() => validateManifest(patch('outgoing-copy-gate', { ...copyGate, labels: copyGate.labels!.slice(0, -1) }), 'main'))
      .toThrow(/outgoing-copy-gate: 7 sidecar labels for 8 matcher groups/)
    expect(() => validateManifest(patch('outgoing-copy-gate', { purpose: purposes }), 'main')).toThrow(/a matcher array needs sidecar labels/)
  })

  it('rejects a purpose array one short or one long', () => {
    expect(() => validateManifest(patch('outgoing-copy-gate', { ...copyGate, purpose: purposes.slice(0, -1) }), 'main'))
      .toThrow(/outgoing-copy-gate: 7 sidecar purposes for 8 matcher groups/)
    expect(() => validateManifest(patch('outgoing-copy-gate', { ...copyGate, purpose: [...purposes, 'One more.'] }), 'main'))
      .toThrow(/outgoing-copy-gate: 9 sidecar purposes for 8 matcher groups/)
  })

  it('rejects a main entry without sidecar text, and sidecar text on an entry the main agent does not render', () => {
    expect(() => validateManifest(patch('clear-capture', undefined), 'main')).toThrow(/clear-capture: needs sidecar text/)
    expect(() => validateManifest(patch('email-send-gate', { purpose: 'Sub-agent email gate.' }), 'main'))
      .toThrow(/email-send-gate: sidecar text is for entries the main agent renders only/)
  })

  it('rejects purposes by event that do not name exactly the entry\'s events', () => {
    const twin = byId('memory-frontmatter-bash-gate').sidecar!.purpose as Partial<Record<HookEvent, string>>
    const { PostToolUseFailure: _dropped, ...two } = twin
    expect(() => validateManifest(patch('memory-frontmatter-bash-gate', { purpose: two }), 'main')).toThrow(/must name exactly its events/)
    expect(() => validateManifest(patch('memory-frontmatter-bash-gate', { purpose: { ...twin, Stop: 'x.' } }), 'main')).toThrow(/must name exactly its events/)
  })

  it('rejects a bad sentence or label', () => {
    for (const purpose of ['', ' padded.', 'two\nlines.']) {
      expect(() => validateManifest(patch('clear-capture', { purpose }), 'main')).toThrow(/one non-empty, trimmed line/)
    }
    expect(() => validateManifest(patch('clear-capture', { purpose: ['A.'] }), 'main')).toThrow(/purpose array needs a matcher array/)
    expect(() => validateManifest(patch('clear-capture', { purpose: 'A.', labels: [null] }), 'main')).toThrow(/labels are for a matcher array only/)
    const labels = copyGate.labels!
    expect(() => validateManifest(patch('outgoing-copy-gate', { ...copyGate, labels: ['bash', ...labels.slice(1)] }), 'main')).toThrow(/first sidecar label must be null/)
    expect(() => validateManifest(patch('outgoing-copy-gate', { ...copyGate, labels: [null, 'Send_Email', ...labels.slice(2)] }), 'main')).toThrow(/kebab-case/)
    expect(() => validateManifest(patch('outgoing-copy-gate', { ...copyGate, labels: [null, 'gmail', ...labels.slice(2)] }), 'main')).toThrow(/duplicate sidecar label/)
  })

  it('has no effect on the sub scope: a manifest without any sidecar text still validates and renders for sub-agents', () => {
    const bare = withEntries(entries.map(({ sidecar: _s, ...e }) => e))
    expect(() => validateManifest(bare, 'sub')).not.toThrow()
    expect(() => validateManifest(bare, 'main')).toThrow(/needs sidecar text/)
    const ctx = { root: '/opt/marveen', nodeBin: '/usr/bin/node', prompts: { precompact: 'p' } }
    expect(renderHooks(bare, 'sub', ctx)).toEqual(renderHooks(HOOK_MANIFEST, 'sub', ctx))
  })
})
