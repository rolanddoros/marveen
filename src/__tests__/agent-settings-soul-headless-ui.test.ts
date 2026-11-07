// C1 PR 11c-4 (Kevin 13596, Johnny 13593): the agent Settings tab for an agent created
// WITHOUT Telegram (personaAtCreation=false, 11c-2). It has no persona and no SOUL.md, so
// the SOUL.md editor and its Save are hidden; Telegram agents, agents created before the
// field and the main agent keep them. If an empty save still reaches the server (an old
// client), the 11c-3 guard skips it and answers soulMdWritten:false, and the client shows
// no "saved" toast for that no-op. No new copy.
// C1 PR 11c-5 (Johnny 13617): hidden ONLY while SOUL.md is missing or blank; a SOUL.md
// with content keeps the editor visible whatever personaAtCreation says.
//
// The functions under test are the real ones from web/app.js, run against a stub DOM.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HTML = readFileSync(join(ROOT, 'web', 'index.html'), 'utf-8')
const APP = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')

const sliceFrom = (src: string, start: string, end = '\n}\n') => {
  const i = src.indexOf(start)
  expect(i, start).toBeGreaterThan(0)
  return src.slice(i, src.indexOf(end, i) + end.length)
}

type El = { hidden: boolean; value: string }
const stubDom = () => {
  const els: Record<string, El> = {
    editSoulGroup: { hidden: false, value: '' },
    editSoulMd: { hidden: false, value: '' },
  }
  return { els, document: { getElementById: (id: string) => els[id] ?? null } }
}

const visibilitySrc = () => sliceFrom(APP, 'function applySoulEditorVisibility(agent) {')
const applyVisibility = (document: unknown, agent: unknown) =>
  new Function('document', 'agent', `${visibilitySrc()}\napplySoulEditorVisibility(agent)`)(document, agent)

describe('Settings tab: the SOUL.md editor for an agent created without Telegram (C1 PR 11c-4)', () => {
  it('the editor and its Save sit in one group, so hiding the group hides both', () => {
    const i = HTML.indexOf('<div class="form-group" id="editSoulGroup">')
    expect(i).toBeGreaterThan(0)
    const group = HTML.slice(i, HTML.indexOf('</div>', i))
    expect(group).toContain('<textarea id="editSoulMd"')
    expect(group).toContain('id="saveSoulMdBtn"')
    expect(HTML.split('id="editSoulGroup"').length - 1).toBe(1)
  })

  it('personaAtCreation false: hidden', () => {
    const { els, document } = stubDom()
    applyVisibility(document, { name: 'x', personaAtCreation: false })
    expect(els.editSoulGroup.hidden).toBe(true)
  })

  it('personaAtCreation true (a Telegram agent): shown', () => {
    const { els, document } = stubDom()
    els.editSoulGroup.hidden = true
    applyVisibility(document, { name: 'x', personaAtCreation: true })
    expect(els.editSoulGroup.hidden).toBe(false)
  })

  it('no field (created before it, or the main agent): shown', () => {
    const { els, document } = stubDom()
    els.editSoulGroup.hidden = true
    applyVisibility(document, { name: 'x' })
    expect(els.editSoulGroup.hidden).toBe(false)
  })

  // C1 PR 11c-5: content wins over personaAtCreation.
  it('personaAtCreation false WITH SOUL.md content: shown (content is never unreachable)', () => {
    const { els, document } = stubDom()
    els.editSoulGroup.hidden = true
    applyVisibility(document, { name: 'x', personaAtCreation: false, soulMd: '# by hand\n' })
    expect(els.editSoulGroup.hidden).toBe(false)
  })

  for (const blank of ['', '  \n\t ']) {
    it(`personaAtCreation false, SOUL.md ${JSON.stringify(blank)}: hidden`, () => {
      const { els, document } = stubDom()
      applyVisibility(document, { name: 'x', personaAtCreation: false, soulMd: blank })
      expect(els.editSoulGroup.hidden).toBe(true)
    })
  }

  it('personaAtCreation true with an empty SOUL.md (a Telegram agent): shown', () => {
    const { els, document } = stubDom()
    els.editSoulGroup.hidden = true
    applyVisibility(document, { name: 'x', personaAtCreation: true, soulMd: '' })
    expect(els.editSoulGroup.hidden).toBe(false)
  })

  it('the rule reads the detail\'s own soulMd text, no other field', () => {
    expect(visibilitySrc()).toContain("const hasSoulContent = typeof agent?.soulMd === 'string' && agent.soulMd.trim() !== ''")
    expect(visibilitySrc()).toContain('group.hidden = agent?.personaAtCreation === false && !hasSoulContent')
  })

  it('a persona-less agent opened first does not leave the editor hidden for the next one', () => {
    const { els, document } = stubDom()
    applyVisibility(document, { name: 'a', personaAtCreation: false })
    applyVisibility(document, { name: 'b', personaAtCreation: true })
    expect(els.editSoulGroup.hidden).toBe(false)
  })

  it('its doc comment sits above it, and the readOnly comment stays above applyMarveenReadonlyMode (Ron Low, 11c-4)', () => {
    const fn = APP.indexOf('function applySoulEditorVisibility(agent) {')
    const before = APP.slice(APP.lastIndexOf('\n}\n', fn), fn)
    expect(before).toContain('// C1 PR 11c-4: an agent created without Telegram has no persona and no SOUL.md,')
    expect(before).not.toContain('`readOnly` is really')
    const ro = APP.indexOf('function applyMarveenReadonlyMode(readOnly) {')
    const roBefore = APP.slice(APP.lastIndexOf('\n}\n', ro), ro)
    expect(roBefore).toContain('// `readOnly` is really "this modal is showing the MAIN agent" -- it is called')
    // the comment ends on the line right above the function
    expect(roBefore).toMatch(/whose panel never runs that function\.\n$/)
  })

  it('both detail paths apply it on every open: the sub-agent and the main agent', () => {
    const sub = sliceFrom(APP, 'async function openAgentDetail(agentName) {')
    expect(sub).toContain('  applyMarveenReadonlyMode(false)\n  applySoulEditorVisibility(currentAgent)\n')
    const main = sliceFrom(APP, 'async function openMarveenDetail() {')
    expect(main).toContain('  applyMarveenReadonlyMode(true)\n  applySoulEditorVisibility(currentAgent)\n')
    // the main agent's detail object has no personaAtCreation, so it keeps the editor
    expect(main).toContain("currentAgent = { ...m, name: mainAgentId(), claudeMd: '', soulMd: '', mcpJson: '', skills: [] }")
  })
})

describe('Settings tab: no "saved" toast for a skipped SOUL.md save (C1 PR 11c-4)', () => {
  // The real click handler of saveSoulMdBtn, with fetch, showToast and t stubbed.
  const handlerSrc = () => {
    const start = "document.getElementById('saveSoulMdBtn').addEventListener('click', "
    const body = sliceFrom(APP, start, '\n})\n')
    return body.slice(start.length, body.length - '\n})\n'.length + 2).replace(/\)\s*$/, '')
  }
  const save = async (response: { ok: boolean; json: () => Promise<unknown> }) => {
    const { document, els } = stubDom()
    els.editSoulMd.value = ''
    const toasts: string[] = []
    const sent: unknown[] = []
    const fetchStub = async (url: string, init: { body: string }) => { sent.push([url, JSON.parse(init.body)]); return response }
    const handler = new Function('document', 'fetch', 'showToast', 't', 'currentAgent', `return (${handlerSrc()})`)(
      document, fetchStub, (m: string) => toasts.push(m), (k: string) => `T:${k}`, { name: 'headless' })
    await handler()
    return { toasts, sent }
  }

  it('the server answers soulMdWritten:false: no toast at all', async () => {
    const { toasts, sent } = await save({ ok: true, json: async () => ({ ok: true, soulMdWritten: false }) })
    expect(sent).toEqual([['/api/agents/headless', { soulMd: '' }]])
    expect(toasts).toEqual([])
  })

  it('a written save: the "saved" toast as before', async () => {
    const { toasts } = await save({ ok: true, json: async () => ({ ok: true }) })
    expect(toasts).toEqual(['T:agents.soul_md_saved'])
  })

  it('a body that is not JSON: still the "saved" toast (the save succeeded)', async () => {
    const { toasts } = await save({ ok: true, json: async () => { throw new Error('not json') } })
    expect(toasts).toEqual(['T:agents.soul_md_saved'])
  })

  it('a failed save: the existing error toast', async () => {
    const { toasts } = await save({ ok: false, json: async () => ({ error: 'x' }) })
    expect(toasts).toEqual(['T:common.error_save'])
  })

  it('no new copy: the handler uses only the two existing keys', () => {
    const keys = [...handlerSrc().matchAll(/t\('([^']+)'\)/g)].map(m => m[1]).sort()
    expect(keys).toEqual(['agents.soul_md_saved', 'common.error_save'])
  })
})
