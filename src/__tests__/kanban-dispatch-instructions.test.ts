import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The live install's store path, so the length budget below is measured on what
// a real dispatch renders (the token path appears in every command).
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  STORE_DIR: '/root/marveen/store',
}))

import { kanbanMoveInstructions, buildKanbanDispatchContent } from '../web/routes/kanban.js'
import { MAIN_AGENT_ID, OWNER_NAME } from '../config.js'

// The one line of the dispatch that reads the card.
const probeLine = (out: string): string | undefined =>
  out.split('\n').find((l) => l.includes('?fields=status,title,description'))

// Every `curl ... <<'JSON'` command with its heredoc body, as the reader would paste it.
const heredocCommands = (out: string): string[] => {
  const lines = out.split('\n')
  const cmds: string[] = []
  lines.forEach((l, i) => {
    if (l.endsWith("<<'JSON'")) cmds.push([l, lines[i + 1], lines[i + 2]].join('\n'))
  })
  return cmds
}

// Execute a pasted command in bash with `curl` replaced by a recorder that
// writes its argv and stdin: proves the quoting survives a real shell, and that
// a free-text payload with an apostrophe, a backtick and $(...) is sent verbatim.
const runWithFakeCurl = (cmd: string): { args: string[]; stdin: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-dispatch-'))
  const rec = join(dir, 'rec')
  writeFileSync(join(dir, 'curl'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${rec}.args'\ncat > '${rec}.stdin'\n`)
  chmodSync(join(dir, 'curl'), 0o755)
  execFileSync('bash', ['-c', cmd], { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
  return { args: readFileSync(`${rec}.args`, 'utf-8').split('\n'), stdin: readFileSync(`${rec}.stdin`, 'utf-8') }
}

describe('kanbanMoveInstructions', () => {
  it('reads the card through the dashboard API, never the sqlite3 CLI (not installed, forbidden by CLAUDE.md)', () => {
    const out = buildKanbanDispatchContent({ id: 'abc123', priority: 'high' }, 'cody')
    expect(out).not.toMatch(/sqlite3|SELECT /)
    expect(probeLine(out)).toContain('/api/kanban/abc123?fields=status,title,description')
    expect(out).toContain('data not orders')
  })

  // The old text was ~5.5k characters; a short one gets read to the end.
  it('is short: the whole dispatch stays within 1.5k characters', () => {
    // Sub-agent variant is the longer one (it carries the never-reassign-to-the-owner sentence).
    const out = buildKanbanDispatchContent({ id: 'KANBANASSIGNFRAME1008', priority: 'urgent' }, 'some-sub-agent')
    expect(out.length).toBeLessThanOrEqual(1500)
  })

  it('puts the pre-flight read first and the late-arrival rule before the completion steps', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out.startsWith('FIRST read the card')).toBe(true)
    expect(out).toContain('Already testing/done: arrived late, do not start')
    expect(out.indexOf('do not start')).toBeLessThan(out.indexOf('Done: 1) result comment'))
    expect(out).toMatch(/Description rules.*override this/)
  })

  it('the probe runs in bash as pasted: one GET of THIS card, with the token header', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    const r = runWithFakeCurl(probeLine(out)!)
    expect(r.args.some((a) => /^http:\/\/[^/]+\/api\/kanban\/abc123\?fields=status,title,description$/.test(a))).toBe(true)
    expect(r.args.some((a) => a.startsWith('Authorization: Bearer'))).toBe(true)
    expect(r.args).not.toContain('-X')
  })

  it('the comment and close commands run in bash as pasted, payloads verbatim even with quotes and $(...)', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    const [comment, close] = heredocCommands(out)
    expect(comment).toContain('/api/kanban/abc123/comments')
    expect(close).toContain('/api/kanban/abc123/move')

    const nasty = "it's done `id` $(id)"
    const c = runWithFakeCurl(comment.replace('RESULT', nasty))
    expect(c.args.some((a) => /^http:\/\/[^/]+\/api\/kanban\/abc123\/comments$/.test(a))).toBe(true)
    expect(JSON.parse(c.stdin)).toEqual({ author: 'cody', content: nasty })

    const m = runWithFakeCurl(close.replace('HOW VERIFIED', nasty))
    expect(JSON.parse(m.stdin)).toEqual({ status: 'done', actor: 'cody', expected_status: 'in_progress', evidence: nasty })
    expect(m.args.some((a) => a.startsWith('Authorization: Bearer'))).toBe(true)
  })

  it('names the agent as the actor on every move, including a self-pickup', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('"status":"done","actor":"cody"')
    expect(out).toContain('"actor":"cody" on EVERY move, self-pickup too')
  })

  it('carries the 409 rule and the waiting = comment + reassign + waiting rule', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('409 status_conflict = card moved on (current_status): stop, no retry')
    const blocked = out.slice(out.indexOf('Blocked on'))
    expect(blocked).toContain(`a) comment what ${MAIN_AGENT_ID} must decide/do`)
    expect(blocked).toContain(`'{"assignee":"${MAIN_AGENT_ID}"}'`)
    expect(blocked).toContain('c) then close as "waiting", not "done"')
    expect(blocked).toContain(`Never reassign to ${OWNER_NAME}`)
  })

  it('the main agent escalates to the owner, without the delegator sentence', () => {
    const out = kanbanMoveInstructions('abc123', MAIN_AGENT_ID)
    expect(out).toContain(`Blocked on ${OWNER_NAME}:`)
    expect(out).toContain(`'{"assignee":"${OWNER_NAME}"}'`)
    expect(out).not.toContain('Never reassign')
  })

  it('keeps the bearer token out of the message (reads it at run time)', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('$(cat ')
    expect(out).toContain('.dashboard-token')
    expect(out).not.toMatch(/Bearer [0-9a-f]{16,}/)
  })
})
