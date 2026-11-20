// Card df560c9f (SOUL A1): the new-agent Telegram welcome no longer quotes a
// SOUL.md line. SOUL.md is not generated any more, and an existing one (every
// agent created before this change has one) must not leak into the greeting
// either: the greeting is built from the agent name only.
//
// Drives the REAL sendWelcomeMessage with an outgoing-fetch stub, like
// owner-chat-fresh-install.test.ts, and points agentDir at a temp root that
// holds a SOUL.md with a canary first line. The old code read exactly that
// line into the greeting, so the canary assertion fails on the reverted
// telegram.ts (checked with a mutant before commit).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEST_RUN_PREFIX } from '../test-run-marker.js'

const REAL = '1268077055'
const CANARY = 'CANARY-soul-first-line-df560c9f'

const h = vi.hoisted(() => ({ agentsRoot: '' }))

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...orig,
    agentDir: (name: string) => join(h.agentsRoot, name),
    findAvatarForAgent: () => null,
  }
})

let home: string
let sent: Array<{ url: string; text: unknown }>
let originalHome: string | undefined
let originalStateDir: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'welcome-nosoul-'))
  const stateDir = join(home, '.claude', 'channels', 'telegram')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(
    join(stateDir, 'access.json'),
    JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [REAL], groups: {}, pending: {} }),
  )
  h.agentsRoot = join(home, 'agents')
  mkdirSync(join(h.agentsRoot, 'probe-agent'), { recursive: true })
  writeFileSync(join(h.agentsRoot, 'probe-agent', 'SOUL.md'), `# Probe\n\n${CANARY}\n`)

  originalHome = process.env['HOME']
  originalStateDir = process.env['TELEGRAM_STATE_DIR']
  process.env['HOME'] = home
  process.env['TELEGRAM_STATE_DIR'] = stateDir

  sent = []
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    let text: unknown
    try {
      text = JSON.parse(init?.body ?? '{}').text
    } catch {
      text = '<multipart>'
    }
    sent.push({ url: String(url), text })
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = originalHome
  if (originalStateDir === undefined) delete process.env['TELEGRAM_STATE_DIR']
  else process.env['TELEGRAM_STATE_DIR'] = originalStateDir
  rmSync(home, { recursive: true, force: true })
})

describe('new-agent welcome message (card df560c9f)', () => {
  it('is built from the name only and never quotes an existing SOUL.md line', async () => {
    vi.resetModules()
    const { sendWelcomeMessage } = await import('../web/telegram.js')

    await sendWelcomeMessage('probe-agent', 'fake-token')

    const messages = sent.filter((s) => s.url.includes('/sendMessage'))
    expect(messages, 'exactly one greeting goes out').toHaveLength(1)
    // The sender prefixes '[TESZT] ' inside a test runner (test-run-marker.ts); strip it before comparing.
    expect(String(messages[0].text).replace(TEST_RUN_PREFIX, '')).toBe(
      'Szia! Probe-agent vagyok, most jöttem létre. Írj ha segíthetek!',
    )
    expect(String(messages[0].text)).not.toContain(CANARY)
  })
})
