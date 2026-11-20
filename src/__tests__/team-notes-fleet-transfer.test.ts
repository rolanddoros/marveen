// Team notes travel with a fleet export/import (src/web/fleet-transfer.ts).
// The Notes page was removed (c3/remove-team-notes): export no longer writes
// teamNotes, and import accepts old bundles with the key but skips the rows.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: { sql: string; args: unknown[]; kind: 'all' | 'get' | 'run' }[] = []
let rowsFor: (sql: string) => unknown[] = () => []

vi.mock('../db.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: (...args: unknown[]) => { calls.push({ sql, args, kind: 'all' }); return rowsFor(sql) },
      get: (...args: unknown[]) => { calls.push({ sql, args, kind: 'get' }); return null },
      run: (...args: unknown[]) => { calls.push({ sql, args, kind: 'run' }); return { changes: 1 } },
    }),
    transaction: (fn: Function) => fn,
  }),
  backfillEmbeddings: () => Promise.resolve(),
  initDatabase: () => {},
}))
vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: '/mock/agents',
  listAgentNames: () => [],
  readJsonObjectForWrite: () => ({}),
}))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, existsSync: () => false, mkdirSync: () => undefined, unlinkSync: () => undefined, rmSync: () => undefined, readdirSync: () => [] }
})
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../web/scheduled-tasks-io.js', () => ({ SCHEDULED_TASKS_DIR: '/mock/tasks' }))
vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/mock/project', STORE_DIR: '/mock/store', MAIN_AGENT_ID: 'marveen', BOT_NAME: 'Marveen',
  BRAND_NAME: 'Marveen', OWNER_NAME: 'Owner', CHANNEL_PROVIDER: 'telegram',
}))
vi.mock('../web/vault-bindings.js', () => ({ getBindings: () => [] }))
vi.mock('../env.js', () => ({ updateEnvFile: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }))

const NOTE = { id: 'abc123', assignee: 'cody', content: 'check the build', due_date: '2026-10-20', created_at: 1791700000, created_by: 'margo', deleted_at: null, deleted_by: null, delete_reason: null }
const DELETED = { id: 'def456', assignee: 'mindenki', content: 'old line', due_date: null, created_at: 1791600000, created_by: 'cody', deleted_at: 1791650000, deleted_by: 'cody', delete_reason: 'done' }

function fleet(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z', sourceHost: 'test-host',
    agents: [], skills: [], scheduledTasks: [], memories: [], dailyLogs: [],
    kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
    ideaBox: { ideas: [], comments: [], statusLog: [] },
    dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
    ...extra,
  })
}

beforeEach(() => { calls.length = 0; rowsFor = () => [] })

describe('fleet transfer: team notes', () => {
  it('export no longer reads or writes teamNotes', async () => {
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const { data } = exportFleet()
    const parsed = JSON.parse(data)
    expect(parsed.teamNotes).toBeUndefined()
    expect(calls.some((c) => /team_notes/.test(c.sql))).toBe(false)
  })

  it('import with teamNotes from an older bundle succeeds and reports 0 imported', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const r = importFleet(fleet({ teamNotes: [NOTE, DELETED] }), { apply: true }) as { ok: boolean; imported: { teamNotes: number } }
    expect(r.ok).toBe(true)
    expect(r.imported.teamNotes).toBe(0)
    // No INSERTs to team_notes
    expect(calls.some((c) => c.kind === 'run' && /team_notes/.test(c.sql))).toBe(false)
  })

  it('dry run with teamNotes reports 0 wouldCreate', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const r = importFleet(fleet({ teamNotes: [NOTE, DELETED] }), { apply: false }) as { errors: string[]; wouldCreate: { teamNotes: number } }
    expect(r.errors).toEqual([])
    expect(r.wouldCreate.teamNotes).toBe(0)
  })

  it('an export made before the Notes page (no teamNotes key) imports as zero notes', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const dry = importFleet(fleet(), { apply: false }) as { errors: string[]; wouldCreate: { teamNotes: number } }
    expect(dry.errors).toEqual([])
    expect(dry.wouldCreate.teamNotes).toBe(0)
    const applied = importFleet(fleet(), { apply: true }) as { imported: { teamNotes: number } }
    expect(applied.imported.teamNotes).toBe(0)
  })

  it('an older bundle with teamNotes does not cause errors', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    // apply: true returns ImportResult on success, throws on error.
    const r = importFleet(fleet({ teamNotes: [NOTE, DELETED] }), { apply: true })
    expect(r.ok).toBe(true)
  })
})