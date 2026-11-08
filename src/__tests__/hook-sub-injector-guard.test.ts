// C3-3a-1: the registration guard of the one sub-agent injector (injectSubHook in agent-scaffold.ts).
// Before C3-3a each inject*Gate carried its own `if (isUnsafeHookCommand(command)) return`; now one line in
// injectSubHook guards all 13 delegating injectors, and no existing test removed it (mutant: the injector
// set stays green without it). The 14th, injectWebSearchEnvelope, keeps its own guard line, equally
// uncovered before (Ron's mutant on 3a-1). Here every injector runs against a project root the guard must refuse --
// one under a tmp prefix, one whose scripts do not exist -- and must leave the settings exactly as they
// were: nothing added, and the copy already there not removed. A positive control with the checkout's own
// root shows each injector does change the same settings when the guard lets it through.
import { afterEach, describe, expect, it, vi } from 'vitest'

type Scaffold = typeof import('../web/agent-scaffold.js')

async function scaffoldWithRoot(root: string | null): Promise<Scaffold> {
  vi.resetModules()
  if (root !== null) {
    vi.doMock('../config.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), PROJECT_ROOT: root }))
  }
  return import('../web/agent-scaffold.js')
}

afterEach(() => {
  vi.doUnmock('../config.js')
  vi.resetModules()
})

const INJECTORS: Array<[string, (s: Scaffold, settings: Record<string, unknown>) => unknown]> = [
  ['injectEmailSendGate', (s, x) => s.injectEmailSendGate(x)],
  ['injectSelfPaceGate', (s, x) => s.injectSelfPaceGate(x)],
  ['injectDbWriteGate', (s, x) => s.injectDbWriteGate(x)],
  ['injectKanbanWriteGate', (s, x) => s.injectKanbanWriteGate(x)],
  ['injectDigestProvenanceGate', (s, x) => s.injectDigestProvenanceGate(x)],
  ['injectEgressGate', (s, x) => s.injectEgressGate(x)],
  ['injectBashEgressParser', (s, x) => s.injectBashEgressParser(x)],
  ['injectTelegramCopyGate', (s, x) => s.injectTelegramCopyGate(x)],
  ['injectSenderRoleGate', (s, x) => s.injectSenderRoleGate(x, 'owner-only')],
  ['injectChildClaudeGuard', (s, x) => s.injectChildClaudeGuard(x)],
  ['injectDestructiveGate', (s, x) => s.injectDestructiveGate(x)],
  ['injectCredentialGate', (s, x) => s.injectCredentialGate(x)],
  ['injectSecondReviewerGate', (s, x) => s.injectSecondReviewerGate(x)],
  // The 14th injector keeps its own guard line (it merges into PostToolUse instead of delegating).
  ['injectWebSearchEnvelope', (s, x) => s.injectWebSearchEnvelope(x)],
]

// One old copy of every gate, as an earlier install left it, plus an operator's own hook.
const SCRIPTS = [
  'email-send-gate.mjs', 'self-pace-gate.mjs', 'db-write-gate.mjs', 'kanban-write-gate.mjs', 'digest-provenance-gate.mjs',
  'egress-gate.mjs', 'bash-egress-parser.mjs', 'outgoing-copy-gate.py', 'sender-role-gate.py', 'child-claude-channel-guard.mjs',
  'destructive-gate.py', 'credential-gate.py', 'second-reviewer-gate.py',
]
function settingsWithOldCopies(): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [
        ...SCRIPTS.map((f) => ({
          matcher: f === 'outgoing-copy-gate.py' ? 'mcp__plugin_telegram_telegram__reply|mcp__plugin_telegram_telegram__edit_message' : 'Bash',
          hooks: [{ type: 'command', command: `python3 /opt/old-install/scripts/hooks/${f} --policy owner-only`, timeout: 10 }],
        })),
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 /opt/operator/own-hook.py' }] },
      ],
      PostToolUse: [
        { matcher: 'WebSearch', hooks: [{ type: 'command', command: 'python3 /opt/old-install/scripts/hooks/browser-content-notice.py', timeout: 10 }] },
      ],
    },
  }
}

describe('injectSubHook registration guard: a refused root changes nothing', () => {
  for (const [why, root] of [
    ['a tmp-prefixed root', '/tmp/c3-3a-injector-guard-probe'],
    ['a root whose scripts do not exist', '/nonexistent/c3-3a-injector-guard-probe'],
  ] as const) {
    it.each(INJECTORS)(`%s, ${why}`, async (_name, inject) => {
      const s = await scaffoldWithRoot(root)
      const settings = settingsWithOldCopies()
      const before = JSON.stringify(settings)
      inject(s, settings)
      expect(JSON.stringify(settings)).toBe(before)
    })
  }
})

describe('positive control: the checkout root lets every injector through', () => {
  it.each(INJECTORS)('%s changes the same settings', async (_name, inject) => {
    const s = await scaffoldWithRoot(null)
    const settings = settingsWithOldCopies()
    const before = JSON.stringify(settings)
    inject(s, settings)
    expect(JSON.stringify(settings)).not.toBe(before)
  })
})
