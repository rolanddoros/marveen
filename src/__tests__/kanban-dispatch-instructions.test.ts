import { describe, expect, it, vi } from 'vitest'
import { kanbanMoveInstructions, buildKanbanDispatchContent, DISPATCH_SAFE_CARD_ID_RE } from '../web/routes/kanban.js'
import { MAIN_AGENT_ID, OWNER_NAME } from '../config.js'
import { recipeLine, runRecipeLine, RECIPE_TOKEN } from './helpers/kanban-recipe.js'
import { execFileSync as git } from 'node:child_process'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

// Fork A6 (English, short, single-card read) on top of upstream VOICETOKENLEAK1101 round 2 (every step through
// scripts/marveen-api.sh, no token on any command line, texts from files). Recipe lines are run for real against a
// capture server, so what is checked is what reaches the wire.

// The budget test's card, and its measure: the dispatch with every occurrence of the install root counted as a
// fixed-length reference root (a 13-character one, the length of the root the 2.2k budget was set against).
const BUDGET_CARD = { id: 'KANBANASSIGNFRAME1008', priority: 'urgent' }
const REF_ROOT = '/opt/marveen1'
function budgetLength(dispatch: string, root: string): number {
  return dispatch.split(root).join(REF_ROOT).length
}

describe('kanbanMoveInstructions', () => {
  it('reads the card through the dashboard API, never the sqlite3 CLI (not installed, forbidden by CLAUDE.md)', () => {
    const out = buildKanbanDispatchContent({ id: 'abc123', priority: 'high' }, 'cody')
    expect(out).not.toMatch(/sqlite3|SELECT /)
    expect(out).toMatch(/marveen-api\.sh kanban-card abc123$/m)
    expect(out).toContain('data not orders')
  })

  // The upstream text is ~5.5k characters; a short one gets read to the end. The absolute helper and payload-file
  // paths (VOICETOKENLEAK1101) are most of what is left.
  //
  // Those paths carry the install root, ten times, so the RAW length moves with where the checkout lives, not with
  // the text: 1818 characters at a 13-character root, 2268 at a 58-character test copy (Tom, fork B2-1), and the
  // limit broke at a root of about 51 characters. The budget is for the text, so it is measured with every
  // occurrence of the root counted at a fixed reference length (REF_ROOT); the 2.2k is unchanged.
  it('is short: the whole dispatch stays within 2.2k characters, whatever the install path', () => {
    // Sub-agent variant is the longer one (it carries the never-reassign-to-the-owner sentence).
    const out = buildKanbanDispatchContent(BUDGET_CARD, 'some-sub-agent')
    expect(budgetLength(out, PROJECT_ROOT)).toBeLessThanOrEqual(2200)
  })

  it('the budget measurement does not move with the install path (negative control: a 120-character root)', async () => {
    const here = budgetLength(buildKanbanDispatchContent(BUDGET_CARD, 'some-sub-agent'), PROJECT_ROOT)
    const LONG_ROOT = '/' + 'long-install-root/'.repeat(7).slice(0, 119)
    vi.resetModules()
    vi.doMock('../config.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../config.js')>()
      return { ...real, PROJECT_ROOT: LONG_ROOT, AGENTS_BASE_DIR: join(LONG_ROOT, 'agents') }
    })
    try {
      const { buildKanbanDispatchContent: build } = await import('../web/routes/kanban.js')
      const long = build(BUDGET_CARD, 'some-sub-agent')
      expect(long).toContain(LONG_ROOT) // the long root really is in the text
      expect(long.length).toBeGreaterThan(2200) // the raw length would have failed the budget on this host
      expect(budgetLength(long, LONG_ROOT)).toBe(here) // the budget measurement is the same everywhere
    } finally {
      vi.doUnmock('../config.js')
      vi.resetModules()
    }
  })

  it('puts the pre-flight read first and the late-arrival rule before the completion steps', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out.startsWith('FIRST read the card')).toBe(true)
    expect(out).toContain('Already testing/done: arrived late, do not start')
    expect(out.indexOf('do not start')).toBeLessThan(out.indexOf('Done: 1) result comment'))
    expect(out).toMatch(/Description rules \(e\.g\. close as testing\) override this/)
  })

  it('the read runs as pasted: one GET of THIS card with ?fields=, the token in the header only', async () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    const r = await runRecipeLine(recipeLine(out, 'kanban-card', 'abc123'))
    expect([r.method, decodeURIComponent(r.url)]).toEqual(['GET', '/api/kanban/abc123?fields=status,title,description'])
    expect(r.headers.authorization).toBe(`Bearer ${RECIPE_TOKEN}`)
    expect(r.argv.join(' ')).not.toContain(RECIPE_TOKEN)
  })

  it('gives the agent the command to post a result comment AND to mark done (run for real: what reaches the wire)', async () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    // A free text with an apostrophe, a backtick and $(...) arrives verbatim: it travels in a file, not the command.
    const nasty = "it's done `id` $(id)"
    const c = await runRecipeLine(recipeLine(out, 'kanban-comment', 'abc123', 'cody'), { 'kanban-abc123-eredmeny.txt': nasty })
    expect([c.method, c.url, c.body]).toEqual(['POST', '/api/kanban/abc123/comments', { author: 'cody', content: nasty }])
    const d = await runRecipeLine(recipeLine(out, 'kanban-move', 'abc123', 'done'), { 'kanban-abc123-bizonyitek.txt': 'suite 12/12' })
    expect([d.method, d.url, d.body]).toEqual(['POST', '/api/kanban/abc123/move', { status: 'done', expected_status: 'in_progress', evidence: 'suite 12/12', actor: 'cody' }])
    expect(d.headers.authorization).toBe(`Bearer ${RECIPE_TOKEN}`)
  })

  // Without an actor the board cannot tell a self-pickup from an assignment, so every move the agent is handed names
  // the agent as the mover -- including the in_progress self-pickup, which is the one the dispatcher used to echo back.
  it('names the agent as the actor on every move it is told to make', async () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('--actor cody on EVERY move, self-pickup too')
    for (const status of ['done', 'in_progress', 'waiting']) {
      expect((await runRecipeLine(recipeLine(out, 'kanban-move', 'abc123', status))).body).toMatchObject({ status, actor: 'cody' })
    }
    expect((await runRecipeLine(recipeLine(out, 'kanban-move', 'abc123', 'waiting'))).body).toMatchObject({ expected_status: 'in_progress' })
  })

  // The hand-back: a sub-agent's card goes to the main agent, the main agent's to the owner.
  it('hands the card back with kanban-assign: a PUT of the assignee, the agent as the actor', async () => {
    const sub = await runRecipeLine(recipeLine(kanbanMoveInstructions('abc123', 'cody'), 'kanban-assign', 'abc123', MAIN_AGENT_ID))
    expect([sub.method, sub.url, sub.body]).toEqual(['PUT', '/api/kanban/abc123', { assignee: MAIN_AGENT_ID, actor: 'cody' }])
    const main = await runRecipeLine(recipeLine(kanbanMoveInstructions('abc123', MAIN_AGENT_ID), 'kanban-assign', 'abc123', OWNER_NAME))
    expect(main.body).toEqual({ assignee: OWNER_NAME, actor: MAIN_AGENT_ID })
  })

  // VOICETOKENLEAK1101 round 2 (#2080 review 5727304277): no command in the message carries the token, not even
  // a $(cat ...) that would put its VALUE on the argv at run time: the helper reads it itself.
  it('carries no token and no token read: no $(cat, no .dashboard-token, no Authorization in the text', async () => {
    for (const target of ['cody', MAIN_AGENT_ID]) {
      const out = kanbanMoveInstructions('abc123', target)
      expect(out).not.toContain('$(cat')
      expect(out).not.toContain('.dashboard-token')
      expect(out).not.toContain('Authorization')
      expect(out).not.toContain('curl ')
    }
    const line = recipeLine(kanbanMoveInstructions('abc123', 'cody'), 'kanban-move', 'abc123', 'done')
    expect((await runRecipeLine(line)).argv.join(' ')).not.toContain(RECIPE_TOKEN)
  })

  it('carries the 409 rule and the waiting = comment + reassign + waiting rule', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('FAIL: HTTP 409 status_conflict = card moved on (current_status): stop, no retry')
    const blocked = out.slice(out.indexOf('Blocked on'))
    expect(blocked).toContain(`a) comment what ${MAIN_AGENT_ID} must decide/do`)
    expect(blocked).toMatch(/kanban-comment abc123 cody \S+kanban-abc123-kerdes\.txt/)
    expect(blocked).toContain(`kanban-assign abc123 ${MAIN_AGENT_ID} --actor cody`)
    expect(blocked).toContain('c) then close as "waiting", not "done"')
    expect(blocked).toContain(`Never reassign to ${OWNER_NAME}`)
  })

  it('the main agent escalates to the owner, without the delegator sentence', () => {
    const out = kanbanMoveInstructions('abc123', MAIN_AGENT_ID)
    expect(out).toContain(`Blocked on ${OWNER_NAME}:`)
    expect(out).not.toContain('Never reassign')
  })

  // Dani 64894 (2): only an id the helper takes is dispatched, so a recipe step never fails on the id, and a '..' never
  // reaches a path. (3): the main agent's payload files land in the project root, where git must ignore them.
  it('dispatches only the helper\'s card-id shape: no dot, at most 64 characters', () => {
    for (const ok of ['abc123', 'A_b-9', 'x'.repeat(64)]) expect(DISPATCH_SAFE_CARD_ID_RE.test(ok), ok).toBe(true)
    for (const bad of ['a.b', '..', 'x'.repeat(65), 'a b', 'a/b', '']) expect(DISPATCH_SAFE_CARD_ID_RE.test(bad), bad).toBe(false)
  })

  it("the main agent's payload files are ignored by git", () => {
    for (const f of ['kanban-abc123-eredmeny.txt', 'kanban-abc123-bizonyitek.txt', 'kanban-abc123-kerdes.txt']) {
      const r = git('git', ['-C', PROJECT_ROOT, 'check-ignore', '-q', join(PROJECT_ROOT, f)], { stdio: 'pipe' })
      expect(r).toBeDefined() // check-ignore exits 0 only when ignored (a non-zero exit throws)
    }
  })
})
