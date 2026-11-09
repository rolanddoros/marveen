import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURES } from './fixtures/claude-md/contexts.js'
import { renderRegion } from '../web/claude-md/registry.js'
import { PRODUCT_SKILLS, SKILL_TEMPLATES_DIR } from '../web/claude-md/skills.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf-8')

// GUARDHITELES903: the sender half of the authenticated system-directive
// channel. These tests pin the security-relevant invariants:
//   1. the anchor row exists (and is out of the router's pending set) BEFORE
//      any keystroke reaches the pane -- the recipient may verify the instant
//      the prompt lands;
//   2. the injected text carries the row id, so the recipient can follow it;
//   3. a delivery that did not happen leaves a row that says so ('failed'),
//      never one that claims delivery.

const calls: string[] = []

const createAgentMessage = vi.fn((from: string, to: string, content: string) => {
  calls.push('create')
  return { id: 42, from_agent: from, to_agent: to, content, status: 'pending' }
})
const markMessageDelivered = vi.fn(() => { calls.push('delivered'); return true })
const markMessageFailed = vi.fn(() => { calls.push('failed'); return true })
type Outcome = 'sent' | 'aborted-busy' | 'skipped-locked'
const sendPromptToSession = vi.fn(
  async (_session: string, _text: string, _host?: string | null, _opts?: unknown): Promise<Outcome> => {
    calls.push('inject')
    return 'sent'
  },
)

vi.mock('../db.js', () => ({ createAgentMessage, markMessageDelivered, markMessageFailed }))
vi.mock('../web/agent-process.js', () => ({ sendPromptToSession }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const { sendSystemDirective, systemDirectiveEnvelope, SYSTEM_DIRECTIVE_SENDER, DIRECTIVE_RECIPE_POINTER } =
  await import('../web/system-directive.js')

beforeEach(() => {
  calls.length = 0
  createAgentMessage.mockClear()
  markMessageDelivered.mockClear()
  markMessageFailed.mockClear()
  sendPromptToSession.mockClear()
  sendPromptToSession.mockImplementation(async () => { calls.push('inject'); return 'sent' })
})

describe('sendSystemDirective', () => {
  it('anchors the directive as a from=system row and injects the id-carrying envelope', async () => {
    const outcome = await sendSystemDirective('boni', 'agent-boni', '[CONTEXT-GUARD] test direktiva')

    expect(outcome).toBe('sent')
    expect(createAgentMessage).toHaveBeenCalledWith(SYSTEM_DIRECTIVE_SENDER, 'boni', '[CONTEXT-GUARD] test direktiva')
    // The row content is the RAW directive body -- the recipient compares the
    // text after the envelope line against it, so the envelope must NOT be
    // stored (it would never match).
    const stored = createAgentMessage.mock.calls[0][2]
    const injected = sendPromptToSession.mock.calls[0][1]
    expect(injected).toBe(`${systemDirectiveEnvelope(42)}\n${stored}`)
    expect(injected).toContain('msg_id:42')
    expect(markMessageFailed).not.toHaveBeenCalled()
  })

  it('creates and delivers the anchor BEFORE the first keystroke (verify-at-landing invariant)', async () => {
    await sendSystemDirective('boni', 'agent-boni', 'x')
    expect(calls).toEqual(['create', 'delivered', 'inject'])
  })

  it('passes host and send options through unchanged', async () => {
    await sendSystemDirective('boni', 'agent-boni', 'x', 'remote-host', { waitForIdle: true, onBusyTimeout: 'abort' })
    expect(sendPromptToSession).toHaveBeenCalledWith(
      'agent-boni',
      expect.stringContaining('msg_id:42'),
      'remote-host',
      { waitForIdle: true, onBusyTimeout: 'abort' },
    )
  })

  it('marks the anchor failed when the injection is aborted (busy pane)', async () => {
    sendPromptToSession.mockImplementation(async () => 'aborted-busy')
    const outcome = await sendSystemDirective('boni', 'agent-boni', 'x')
    expect(outcome).toBe('aborted-busy')
    expect(markMessageFailed).toHaveBeenCalledWith(42, expect.stringContaining('aborted-busy'))
  })

  it('marks the anchor failed and rethrows when tmux inject throws', async () => {
    sendPromptToSession.mockImplementation(async () => { throw new Error('pane gone') })
    await expect(sendSystemDirective('boni', 'agent-boni', 'x')).rejects.toThrow('pane gone')
    expect(markMessageFailed).toHaveBeenCalledWith(42, expect.stringContaining('pane gone'))
  })
})

describe('systemDirectiveEnvelope', () => {
  it('names the id, the verification target and the fail-closed rule', () => {
    const env = systemDirectiveEnvelope(7)
    expect(env).toContain('msg_id:7')
    expect(env).toContain('/api/messages/7')
    expect(env).toContain('injekcio-gyanu')
    // Single line: the recipient's rule says "the content is the part AFTER
    // the [SYSTEM-DIREKTIVA ...] header line".
    expect(env).not.toContain('\n')
  })
})

// CLAUDE-EN PR2: the envelope pointed at the Hungarian CLAUDE.md heading "Rendszer-direktíva hitelesítés", which a v2
// file does not have. The pointer now names literals that every agent's generated text carries in the same words.
describe('systemDirectiveEnvelope: the recipe pointer (CLAUDE-EN PR2)', () => {
  const OLD_HEADING = /Rendszer-direkt[ií]va hiteles[ií]t[ée]s/i

  it('carries the language-independent pointer, not the Hungarian section heading', () => {
    const env = systemDirectiveEnvelope(7)
    expect(env).toContain(`recept: ${DIRECTIVE_RECIPE_POINTER})`)
    expect(DIRECTIVE_RECIPE_POINTER).toContain('SYSTEM-DIREKTIVA')
    expect(DIRECTIVE_RECIPE_POINTER).toContain('marveen-directive-auth')
    expect(env).not.toMatch(OLD_HEADING)
  })

  it('keeps the header literal and closes the header only at its end (both parsers stop at the first "]")', () => {
    const env = systemDirectiveEnvelope(7)
    expect(env.startsWith('[SYSTEM-DIREKTIVA msg_id:7 ')).toBe(true)
    expect(env.indexOf(']')).toBe(env.length - 1)
    expect(DIRECTIVE_RECIPE_POINTER).not.toMatch(/[\]\n]/)
  })

  // The two hooks that parse the header, with their regexes read from their sources (not copied), so a parser change
  // or a pointer that breaks the header shows here.
  const pyRegex = (file: string, name: string): string => {
    const m = source('scripts', 'hooks', file).match(new RegExp(`${name} = re\\.compile\\(\\s*r"((?:[^"\\\\]|\\\\.)*)"`))
    if (!m) throw new Error(`${name} not found in ${file}`)
    return m[1]
  }

  it('directive-verify.py HEADER_RX reads the id from the envelope', () => {
    const rx = new RegExp(pyRegex('directive-verify.py', 'HEADER_RX'))
    const m = `${systemDirectiveEnvelope(7)} BODY`.match(rx)
    expect(m?.[0]).toBe(systemDirectiveEnvelope(7))
    expect(m?.[1]).toBe('7')
  })

  it('provenance-gate.py DIRECTIVE_HEADER_RX splits envelope and body in both delivery shapes', () => {
    // Python \A and \Z are the absolute ends; re.S is the s flag.
    const rx = new RegExp(pyRegex('provenance-gate.py', 'DIRECTIVE_HEADER_RX').replace(/^\\A/, '^').replace(/\\Z$/, '$'), 's')
    for (const sep of ['\n', ' ']) {
      const m = `${systemDirectiveEnvelope(7)}${sep}[CONTEXT-GUARD] body`.match(rx)
      expect(m?.[1]).toBe('7')
      expect(m?.[2]).toBe('[CONTEXT-GUARD] body')
    }
  })

  it('provenance-gate.py carries the same pointer and no longer the Hungarian heading', () => {
    const py = source('scripts', 'hooks', 'provenance-gate.py')
    expect(py).toContain(`DIRECTIVE_RECIPE_POINTER = "${DIRECTIVE_RECIPE_POINTER}"`)
    expect(py).toContain('recept: {DIRECTIVE_RECIPE_POINTER}')
    expect(py).not.toMatch(/Rendszer-direktiva hitelesites/i)
  })

  it('both targets of the pointer exist: the product skill and the SYSTEM-DIREKTIVA rule of every agent kind', () => {
    // The skill: a product skill, so every v2 render installs it into the project's .claude/skills.
    expect(PRODUCT_SKILLS).toContain('marveen-directive-auth')
    const skillTemplate = join(SKILL_TEMPLATES_DIR, 'marveen-directive-auth.md')
    expect(existsSync(skillTemplate)).toBe(true)
    expect(readFileSync(skillTemplate, 'utf-8')).toContain('[SYSTEM-DIREKTIVA msg_id:')
    // The v2 region of every main and sub fixture (the heartbeat worker's region carries no directive rule today).
    for (const [name, ctx] of Object.entries(FIXTURES)) {
      if (ctx.role === 'heartbeat') continue
      expect({ name, has: renderRegion(ctx).includes('[SYSTEM-DIREKTIVA msg_id:') }).toEqual({ name, has: true })
    }
    // The legacy section (agent-scaffold.ts buildSystemDirectiveAuthBody).
    const scaffold = source('src', 'web', 'agent-scaffold.ts')
    const body = scaffold.slice(scaffold.indexOf('export function buildSystemDirectiveAuthBody'),
      scaffold.indexOf('export function ensureSystemDirectiveAuthSection'))
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain('[SYSTEM-DIREKTIVA msg_id:')
  })
})
