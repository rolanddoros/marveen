/**
 * The manifest's main sidecar text (C3-sch): each main group's purpose and the
 * id labels of the matcher-array groups, checked by validateSidecarText. The
 * proof that the text equals the committed sidecar is the generator byte check
 * since C3-4 (src/__tests__/hook-main-artifact.test.ts: the sidecar is
 * generated from this text). Kept apart from validateManifest (Ron, C3-sch N2),
 * so a prose defect cannot break the hook render.
 */
import { describe, it, expect } from 'vitest'
import {
  HOOK_MANIFEST,
  renderHooks,
  sidecarGroupText,
  validateManifest,
  validateSidecarText,
  type HookEvent,
  type HookManifest,
  type HookManifestEntry,
} from '../web/hooks/manifest.js'

const entries = HOOK_MANIFEST.entries
const withEntries = (es: readonly HookManifestEntry[]): HookManifest => ({ entries: es, layout: HOOK_MANIFEST.layout })
const byId = (id: string): HookManifestEntry => {
  const e = entries.find((x) => x.id === id)
  if (!e) throw new Error(`no manifest entry ${id}`)
  return e
}
const patch = (id: string, sidecar: HookManifestEntry['sidecar']): HookManifest =>
  withEntries(entries.map((e) => (e.id === id ? { ...e, sidecar } : e)))

describe('manifest sidecar text: the id and purpose of a group', () => {
  it('derives the id from the event, the script stem and the label, and picks the purpose by shape', () => {
    expect(sidecarGroupText(byId('ledger-capture'), 'UserPromptSubmit', 0).id).toBe('user-prompt-submit/ledger-capture')
    expect(sidecarGroupText(byId('marveen-commands-stop'), 'Stop', 0).id).toBe('stop/marveen-commands')
    expect(sidecarGroupText(byId('tool-log-capture'), 'PostToolUseFailure', 0).id).toBe('post-tool-use-failure/tool-log-capture')
    const copy = byId('outgoing-copy-gate')
    expect(sidecarGroupText(copy, 'PreToolUse', 0)).toEqual({ id: 'pre-tool-use/outgoing-copy-gate', purpose: 'Copy QA gate on outgoing email sent from Bash.' })
    expect(sidecarGroupText(copy, 'PreToolUse', 7)).toEqual({
      id: 'pre-tool-use/outgoing-copy-gate/discord-reply', purpose: 'Copy QA gate on outgoing Discord reply / edit_message text.',
    })
    expect(sidecarGroupText(byId('memory-frontmatter-bash-gate'), 'PreToolUse', 0).purpose)
      .toBe('Memory frontmatter check for memory files written from Bash (before the write).')
  })

  it('the provenance-gate purpose says what the script does: it flags, it never blocks (Ron, C3-sch N1)', () => {
    const { purpose } = sidecarGroupText(byId('provenance-gate'), 'UserPromptSubmit', 0)
    expect(purpose).toMatch(/^Flags, never blocks,/)
    expect(purpose).not.toMatch(/^Blocks/)
  })
})

describe('manifest sidecar text: validation', () => {
  const copyGate = byId('outgoing-copy-gate').sidecar!
  const purposes = copyGate.purpose as readonly string[]

  it('accepts the shipped manifest', () => {
    expect(() => validateSidecarText(HOOK_MANIFEST)).not.toThrow()
  })

  it('rejects a label removed from a matcher array', () => {
    expect(() => validateSidecarText(patch('outgoing-copy-gate', { ...copyGate, labels: copyGate.labels!.slice(0, -1) })))
      .toThrow(/outgoing-copy-gate: 7 sidecar labels for 8 matcher groups/)
    expect(() => validateSidecarText(patch('outgoing-copy-gate', { purpose: purposes }))).toThrow(/a matcher array needs sidecar labels/)
  })

  it('rejects a purpose array one short or one long', () => {
    expect(() => validateSidecarText(patch('outgoing-copy-gate', { ...copyGate, purpose: purposes.slice(0, -1) })))
      .toThrow(/outgoing-copy-gate: 7 sidecar purposes for 8 matcher groups/)
    expect(() => validateSidecarText(patch('outgoing-copy-gate', { ...copyGate, purpose: [...purposes, 'One more.'] })))
      .toThrow(/outgoing-copy-gate: 9 sidecar purposes for 8 matcher groups/)
  })

  it('rejects a main entry without sidecar text, and sidecar text on an entry the main agent does not render', () => {
    expect(() => validateSidecarText(patch('clear-capture', undefined))).toThrow(/clear-capture: needs sidecar text/)
    expect(() => validateSidecarText(patch('email-send-gate', { purpose: 'Sub-agent email gate.' })))
      .toThrow(/email-send-gate: sidecar text is for entries the main agent renders only/)
  })

  it('rejects purposes by event that do not name exactly the entry\'s events', () => {
    const twin = byId('memory-frontmatter-bash-gate').sidecar!.purpose as Partial<Record<HookEvent, string>>
    const { PostToolUseFailure: _dropped, ...two } = twin
    expect(() => validateSidecarText(patch('memory-frontmatter-bash-gate', { purpose: two }))).toThrow(/must name exactly its events/)
    expect(() => validateSidecarText(patch('memory-frontmatter-bash-gate', { purpose: { ...twin, Stop: 'x.' } }))).toThrow(/must name exactly its events/)
  })

  it('rejects a bad sentence or label', () => {
    for (const purpose of ['', ' padded.', 'two\nlines.']) {
      expect(() => validateSidecarText(patch('clear-capture', { purpose }))).toThrow(/one non-empty, trimmed line/)
    }
    expect(() => validateSidecarText(patch('clear-capture', { purpose: ['A.'] }))).toThrow(/purpose array needs a matcher array/)
    expect(() => validateSidecarText(patch('clear-capture', { purpose: 'A.', labels: [null] }))).toThrow(/labels are for a matcher array only/)
    const labels = copyGate.labels!
    expect(() => validateSidecarText(patch('outgoing-copy-gate', { ...copyGate, labels: ['bash', ...labels.slice(1)] }))).toThrow(/first sidecar label must be null/)
    expect(() => validateSidecarText(patch('outgoing-copy-gate', { ...copyGate, labels: [null, 'Send_Email', ...labels.slice(2)] }))).toThrow(/kebab-case/)
    expect(() => validateSidecarText(patch('outgoing-copy-gate', { ...copyGate, labels: [null, 'gmail', ...labels.slice(2)] }))).toThrow(/duplicate sidecar label/)
  })

  it('a prose defect does not break the hook render or the structural check (Ron, C3-sch N2)', () => {
    const padded = patch('ledger-capture', { purpose: 'Records every inbound channel message. ' })
    expect(() => validateSidecarText(padded)).toThrow(/one non-empty, trimmed line/)
    expect(() => validateManifest(padded, 'main')).not.toThrow()
    expect(renderHooks(padded, 'main')).toEqual(renderHooks(HOOK_MANIFEST, 'main'))
  })

  it('has no effect on the sub scope: a manifest without any sidecar text still validates and renders for sub-agents', () => {
    const bare = withEntries(entries.map(({ sidecar: _s, ...e }) => e))
    expect(() => validateManifest(bare, 'sub')).not.toThrow()
    expect(() => validateManifest(bare, 'main')).not.toThrow()
    expect(() => validateSidecarText(bare)).toThrow(/needs sidecar text/)
    const ctx = { root: '/opt/marveen', nodeBin: '/usr/bin/node', prompts: { precompact: 'p' } }
    expect(renderHooks(bare, 'sub', ctx)).toEqual(renderHooks(HOOK_MANIFEST, 'sub', ctx))
  })
})
