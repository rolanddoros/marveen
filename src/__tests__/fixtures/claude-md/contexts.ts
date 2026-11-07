// C1 PR 7b: fixture contexts for the golden files. Synthetic names only (the
// repository is public): no live agent, owner or chat id appears here.
import type { AgentDocContext } from '../../../web/claude-md/context.js'

const NO_HOOKS = { directiveVerify: false, childClaudeGuard: false, shellRescan: false }
const ALL_HOOKS = { directiveVerify: true, childClaudeGuard: true, shellRescan: true }
const FLEET = ['main', 'pm', 'dev-a', 'dev-b', 'reviewer']
const rosterWithout = (self: string) => FLEET.filter((n) => n !== self).map((name) => ({ name }))
// C1 PR 12b: federation off, or on without a peer, in the default mode.
const NO_FED: AgentDocContext['federation'] = { routingMode: 'catalog-first', peers: [] }
// two peers, one still pairing (synthetic ids)
const TWO_PEERS: AgentDocContext['federation'] = {
  routingMode: 'strong',
  peers: [{ id: 'north', paired: true }, { id: 'south-lab', paired: false }],
}
const CAPS = {
  kanbanWrite: false, scheduleWrite: false, emailSend: 'none' as const, browser: false, federation: false, thinChief: false,
  channel: true,
}

const base: AgentDocContext = {
  name: 'main',
  role: 'main',
  mainAgentId: 'main',
  botName: 'fleet-bot',
  owner: { name: 'Owner', chatId: '1000000001' },
  projectRoot: '/srv/fleet',
  tokenPath: '/srv/fleet/store/.dashboard-token',
  profile: { id: 'main', strict: false, helperAllowed: true },
  capabilities: { ...CAPS, kanbanWrite: true, scheduleWrite: true, emailSend: 'gated' },
  autonomy: { memory_maintenance: 3, kanban_archive_done: 1 },
  team: { reportsTo: null, directReports: ['pm'] },
  roster: rosterWithout('main'),
  hooks: ALL_HOOKS,
  federation: NO_FED,
}

const sub = (name: string, over: Partial<AgentDocContext> = {}): AgentDocContext => ({
  ...base,
  name,
  role: 'sub',
  profile: { id: 'developer', strict: false, helperAllowed: true },
  capabilities: CAPS,
  team: { reportsTo: 'pm', directReports: [] },
  roster: rosterWithout(name),
  hooks: { ...NO_HOOKS, childClaudeGuard: true },
  ...over,
})

export const FIXTURES: Readonly<Record<string, AgentDocContext>> = {
  // the target state: every hook wired
  'main': base,
  // today's main: no hook of the three wired, chat id not paired yet
  'main-no-hooks': { ...base, owner: { name: 'Owner', chatId: null }, hooks: NO_HOOKS },
  'main-with-federation': { ...base, capabilities: { ...base.capabilities, federation: true }, hooks: NO_HOOKS },
  // C1 PR 12b: the peer list and a routing mode other than the default
  'main-with-federation-peers': { ...base, capabilities: { ...base.capabilities, federation: true }, hooks: NO_HOOKS, federation: TWO_PEERS },
  // C1 PR 12b: a sub with federation on: the section for a task a peer sends in
  'sub-with-federation': sub('dev-a', { capabilities: { ...CAPS, federation: true }, federation: TWO_PEERS }),
  // today's sub shape: only the child-claude guard wired
  'sub-permissive': sub('dev-a'),
  'sub-strict': sub('reviewer', { profile: { id: 'developer-junior', strict: true, helperAllowed: true } }),
  'sub-all-hooks': sub('pm', {
    capabilities: { ...CAPS, kanbanWrite: true },
    team: { reportsTo: 'main', directReports: ['dev-a', 'dev-b'] },
    hooks: ALL_HOOKS,
  }),
  'sub-helper-denied': sub('dev-b', { profile: { id: 'researcher', strict: true, helperAllowed: false } }),
  // C1 PR 11a-2: a sub without any channel (today's developer and reviewer agents)
  'sub-headless': sub('dev-c', { capabilities: { ...CAPS, channel: false } }),
  'heartbeat': {
    ...base,
    name: 'heartbeat',
    role: 'heartbeat',
    profile: { id: 'heartbeat', strict: true, helperAllowed: true },
    // no channel, as live-context reads it; its region does not depend on it
    capabilities: { ...CAPS, channel: false },
    team: { reportsTo: null, directReports: [] },
    roster: rosterWithout('heartbeat'),
    hooks: NO_HOOKS,
  },
}
