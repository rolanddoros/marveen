// C1 PR 11c-2 (Roland TG 3151 = C): the agent-creation wizard asks "will it have its own
// Telegram bot" (default checked = today's behaviour), sends the answer as `telegram` on
// POST /api/agents, and for an agent created without Telegram hides the SOUL.md editor
// on step 3 and does not send soulMd (the PUT writes SOUL.md whenever soulMd is sent).
// Wording: Johnny's decision (Kevin 13413), pinned verbatim in both languages; nothing
// may promise that a persona "can be added later" (no re-render path exists).
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HTML = readFileSync(join(ROOT, 'web', 'index.html'), 'utf-8')
const APP = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')

let hu: Record<string, string>
let en: Record<string, string>

beforeAll(async () => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window ||= {} as Record<string, unknown>
  await import(/* @vite-ignore */ '../../web/lang/hu.js' as string)
  await import(/* @vite-ignore */ '../../web/lang/en.js' as string)
  const i18n = (globalThis as unknown as { window: { _i18n: Record<string, Record<string, string>> } }).window._i18n
  hu = i18n.hu
  en = i18n.en
})

const step = (id: string) => {
  const start = HTML.indexOf(`id="${id}"`)
  expect(start, id).toBeGreaterThan(0)
  const end = HTML.indexOf('class="wizard-panel"', start + 1)
  return HTML.slice(start, end > 0 ? end : undefined)
}

describe('creation wizard: the Telegram question (C1 PR 11c-2)', () => {
  it('step 1 has the checkbox, CHECKED by default, with its label and helper line', () => {
    const s1 = step('wizardStep1')
    expect(s1).toContain('<input type="checkbox" id="agentTelegram" checked>')
    expect(s1).toContain('data-i18n="agents.wizard.telegram_label">Lesz saját Telegram-botja</span>')
    expect(s1).toContain('data-i18n="agents.wizard.telegram_hint">Ha nem, személyiség nélkül, kisebb CLAUDE.md-vel jön létre.</small>')
    // before the Next button, so it is part of what the first step submits
    expect(s1.indexOf('id="agentTelegram"')).toBeLessThan(s1.indexOf('id="wizardNextBtn"'))
  })

  it('the wording is Johnny\'s, verbatim, in both languages', () => {
    expect(hu['agents.wizard.telegram_label']).toBe('Lesz saját Telegram-botja')
    expect(hu['agents.wizard.telegram_hint']).toBe('Ha nem, személyiség nélkül, kisebb CLAUDE.md-vel jön létre.')
    expect(en['agents.wizard.telegram_label']).toBe('Will have its own Telegram bot')
    expect(en['agents.wizard.telegram_hint']).toBe('If not, it is created without a persona, with a smaller CLAUDE.md.')
  })

  it('no copy promises adding the persona later', () => {
    const copy = [hu['agents.wizard.telegram_label'], hu['agents.wizard.telegram_hint'],
      en['agents.wizard.telegram_label'], en['agents.wizard.telegram_hint']].join('\n')
    expect(copy).not.toMatch(/később|utólag|later|afterwards/i)
  })

  it('the POST body carries the checkbox state as telegram', () => {
    expect(APP).toContain("const telegram = document.getElementById('agentTelegram').checked")
    const post = APP.slice(APP.indexOf("fetch('/api/agents', {"))
    const body = post.slice(0, post.indexOf('}),'))
    expect(body).toMatch(/profile: document\.getElementById\('agentProfile'\)\.value,\s*telegram,/)
  })

  it('step 3 hides the SOUL.md editor and does not send soulMd for an agent created without Telegram', () => {
    expect(step('wizardStep3')).toContain('<div class="form-group" id="wizardSoulGroup">')
    expect(APP).toContain('wizardTelegram = telegram')
    expect(APP).toContain("document.getElementById('wizardSoulGroup').hidden = !wizardTelegram")
    expect(APP).toContain('body: JSON.stringify(wizardTelegram ? { claudeMd, soulMd } : { claudeMd }),')
    expect(APP).not.toContain('body: JSON.stringify({ claudeMd, soulMd }),')
  })

  it('opening the wizard resets the answer to checked and the SOUL.md editor to visible', () => {
    const reset = APP.slice(APP.indexOf("wizardCreatedName = ''\n  wizardPersonalityPending = null"))
    const head = reset.slice(0, reset.indexOf('updateWizardUI()'))
    expect(head).toContain('wizardTelegram = true')
    expect(head).toContain("document.getElementById('agentTelegram').checked = true")
    expect(head).toContain("document.getElementById('wizardSoulGroup').hidden = false")
  })

  // Kevin 13421: the two follow-ons of the new option, in this PR.
  const createHandler = () => {
    const start = APP.indexOf("document.getElementById('wizardCreateBtn').addEventListener('click'")
    expect(start).toBeGreaterThan(0)
    return APP.slice(start, APP.indexOf('\n})\n', start))
  }
  const nextHandler = () => {
    const start = APP.indexOf("document.getElementById('wizardNextBtn').addEventListener('click'")
    expect(start).toBeGreaterThan(0)
    return APP.slice(start, APP.indexOf('\n})\n', start))
  }

  it('without Telegram: no "connect the channel" toast and no jump to the channel tab; with it, both as before', () => {
    const h = createHandler()
    expect(h).toContain("if (wizardTelegram) showToast('Ugynok letrehozva. Kosd be a csatornat a parosatashoz.')")
    expect(h).toContain("if (wizardTelegram) switchAgentTab('channel')")
    // nothing outside the condition shows the toast or switches the tab
    expect(h.split("showToast('Ugynok letrehozva").length - 1).toBe(1)
    expect(h.split("switchAgentTab('channel')").length - 1).toBe(1)
    // the new agent's detail still opens for both answers
    expect(h).toMatch(/\n {6}await openAgentDetail\(name\)\n/)
  })

  it('without Telegram the step-2 status does not mention SOUL.md (existing key, both languages); with it, as before', () => {
    const h = nextHandler()
    const m = h.match(/statusEl\.textContent = t\(telegram \? '([^']+)' : '([^']+)'\)/)
    expect(m, 'the status after the POST depends on the answer').not.toBeNull()
    const [, withKey, withoutKey] = m!
    expect(withKey).toBe('agents.soul_md_generating')
    expect(withoutKey).toBe('agents.claude_md_generating')
    for (const lang of [hu, en]) {
      expect(lang[withoutKey]).toBeTypeOf('string')
      expect(lang[withoutKey]).not.toMatch(/SOUL/i)
    }
    // no unconditional SOUL.md status left in the step-1 handler
    expect(h.split("'agents.soul_md_generating'").length - 1).toBe(1)
  })
})
