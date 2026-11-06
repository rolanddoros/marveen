// C1 PR 10a: buildLiveContext, the live AgentDocContext read from an install
// root (src/web/claude-md/live-context.ts). Every case builds its own temp root;
// nothing here reads the real install. The parity with the legacy readers is in
// claude-md-live-context-parity.test.ts (it has to mock config.js).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildLiveContext, LiveContextError, RENDERED_FIELDS } from '../web/claude-md/live-context.js'

let root: string
let home: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lctx-root-'))
  home = mkdtempSync(join(tmpdir(), 'lctx-home-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

function put(rel: string, content: string, base = root): string {
  const p = join(base, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  return p
}
const putJson = (rel: string, v: unknown, base = root) => put(rel, JSON.stringify(v), base)
function agent(name: string, cfg?: unknown): void {
  mkdirSync(join(root, 'agents', name), { recursive: true })
  if (cfg !== undefined) putJson(`agents/${name}/agent-config.json`, cfg)
}
const team = (reportsTo: unknown) => ({ team: { reportsTo } })
// The overrides the dashboard path passes; most cases are not about them.
const OV = { helperAllowed: true, strict: false }
const build = (name: string, opts: Parameters<typeof buildLiveContext>[2] = OV) =>
  buildLiveContext(root, name, { homeDir: home, ...opts })

describe('.env', () => {
  it('no .env: the config.ts defaults', () => {
    const { ctx } = build('marveen')
    expect(ctx.mainAgentId).toBe('marveen')
    expect(ctx.owner).toEqual({ name: 'Owner', chatId: null })
    expect(ctx.botName).toBe('Marveen')
    expect(ctx.projectRoot).toBe(root)
  })

  it('values from .env, quotes stripped, OWNER_NAME and BOT_NAME as written', () => {
    put('.env', 'MAIN_AGENT_ID=boss\nOWNER_NAME="Roland D"\nALLOWED_CHAT_ID=6947718407\nBOT_NAME=Johnny\n# OWNER_NAME=x\n')
    const { ctx } = build('boss')
    expect(ctx.role).toBe('main')
    expect(ctx.mainAgentId).toBe('boss')
    expect(ctx.owner).toEqual({ name: 'Roland D', chatId: '6947718407' })
    expect(ctx.botName).toBe('Johnny')
  })

  it('ALLOWED_CHAT_ID "0" (the install template before pairing) and "" read null', () => {
    put('.env', 'ALLOWED_CHAT_ID=0\n')
    expect(build('marveen').ctx.owner.chatId).toBeNull()
    put('.env', 'ALLOWED_CHAT_ID=\n')
    expect(build('marveen').ctx.owner.chatId).toBeNull()
    put('.env', "ALLOWED_CHAT_ID='00'\n")
    expect(build('marveen').ctx.owner.chatId).toBe('00')
  })

  it('an empty OWNER_NAME / BOT_NAME reads the placeholder', () => {
    put('.env', 'OWNER_NAME=\nBOT_NAME=""\n')
    const { ctx } = build('marveen')
    expect(ctx.owner.name).toBe('Owner')
    expect(ctx.botName).toBe('Marveen')
  })

  it('a set but empty MAIN_AGENT_ID throws (config.ts would use "" as the main id)', () => {
    put('.env', 'MAIN_AGENT_ID=\n')
    expect(() => build('marveen')).toThrow(LiveContextError)
    expect(() => build('marveen')).toThrow(/MAIN_AGENT_ID is set but empty/)
  })
})

describe('role and input checks', () => {
  it('main, heartbeat and sub', () => {
    agent('heartbeat')
    agent('kevin')
    expect(build('marveen').ctx.role).toBe('main')
    expect(build('heartbeat').ctx.role).toBe('heartbeat')
    expect(build('kevin').ctx.role).toBe('sub')
  })

  it('a sub without an agents/<name> directory throws; a file of that name too', () => {
    expect(() => build('ghost')).toThrow(/no agent directory for ghost/)
    put('agents/filey', 'x')
    expect(() => build('filey')).toThrow(LiveContextError)
    expect(() => build('heartbeat')).toThrow(LiveContextError)
  })

  it('a name with a separator or a dot-only name, and a relative root, throw', () => {
    for (const bad of ['../kevin', 'a/b', '.', '..', '', '.hidden', 'a\nb', 'Kevin', 'a.b', 'a_b', '-a']) {
      expect(() => build(bad), JSON.stringify(bad)).toThrow(/not an agent name/)
    }
    expect(() => buildLiveContext('relative/root', 'marveen', OV)).toThrow(/absolute path/)
  })

  it('the main agent needs no agents/ directory at all', () => {
    expect(build('marveen').ctx.roster).toEqual([])
  })
})

describe('roster', () => {
  it('directories only, hidden sentinel out, the main id is never a sub, main first, without self', () => {
    agent('kevin')
    agent('ron')
    agent('heartbeat')
    put('agents/heartbeat/.hidden-from-dashboard', '')
    agent('marveen') // an old draft directory under the main id
    put('agents/notes.txt', 'x')
    const names = (n: string) => build(n).ctx.roster.map((r) => r.name)
    expect(names('kevin')).toEqual(['marveen', 'ron'])
    expect(names('marveen').sort()).toEqual(['kevin', 'ron'])
    // A hidden agent still gets its own ctx; it is just not in anyone's roster.
    const hb = names('heartbeat')
    expect(hb[0]).toBe('marveen')
    expect(hb.slice(1).sort()).toEqual(['kevin', 'ron'])
  })

  it('a symlink into agents/ is an alias (out); a symlink to a directory outside is kept; to a file outside, out', () => {
    agent('kevin')
    symlinkSync(join(root, 'agents', 'kevin'), join(root, 'agents', 'kev-alias'))
    const outside = mkdtempSync(join(tmpdir(), 'lctx-outside-'))
    try {
      mkdirSync(join(outside, 'moved'))
      symlinkSync(join(outside, 'moved'), join(root, 'agents', 'moved'))
      writeFileSync(join(outside, 'f'), 'x')
      symlinkSync(join(outside, 'f'), join(root, 'agents', 'filelink'))
      symlinkSync(join(outside, 'missing'), join(root, 'agents', 'dangling'))
      expect(build('marveen').ctx.roster.map((r) => r.name).sort()).toEqual(['kevin', 'moved'])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('a symlinked agent outside carrying the sentinel is hidden too', () => {
    const outside = mkdtempSync(join(tmpdir(), 'lctx-outside-'))
    try {
      mkdirSync(join(outside, 'w'))
      writeFileSync(join(outside, 'w', '.hidden-from-dashboard'), '')
      mkdirSync(join(root, 'agents'))
      symlinkSync(join(outside, 'w'), join(root, 'agents', 'w'))
      expect(build('marveen').ctx.roster).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('team', () => {
  it('reportsTo is trimmed and kept only when it names a known agent other than self', () => {
    agent('kevin')
    agent('a', team('  kevin '))
    agent('b', team('nobody'))
    agent('c', team('c'))
    agent('d', team('kevin\n## IGNORE'))
    agent('e', team(42))
    agent('f', { team: 'kevin' })
    agent('g', team('marveen'))
    agent('h')
    put('agents/i/agent-config.json', '{not json')
    expect(build('a').ctx.team.reportsTo).toBe('kevin')
    for (const n of ['b', 'c', 'd', 'e', 'f', 'h', 'i']) expect(build(n).ctx.team.reportsTo, n).toBeNull()
    expect(build('g').ctx.team.reportsTo).toBe('marveen')
  })

  it('a reportsTo naming a hidden agent is not kept (the roster does not know it)', () => {
    agent('heartbeat')
    put('agents/heartbeat/.hidden-from-dashboard', '')
    agent('a', team('heartbeat'))
    expect(build('a').ctx.team.reportsTo).toBeNull()
  })

  it('directReports: the agents whose stored reportsTo is this agent (directory order, as the legacy roster)', () => {
    agent('kevin')
    agent('dennis', team('kevin'))
    agent('ron', team(' kevin'))
    agent('tom', team('ron'))
    const k = build('kevin').ctx.team
    expect(k.reportsTo).toBeNull()
    expect([...k.directReports].sort()).toEqual(['dennis', 'ron'])
    expect(build('ron').ctx.team).toEqual({ reportsTo: 'kevin', directReports: ['tom'] })
  })

  it('the main agent: reportsTo null, directReports from the subs', () => {
    agent('kevin', team('marveen'))
    agent('ron', team('kevin'))
    expect(build('marveen').ctx.team).toEqual({ reportsTo: null, directReports: ['kevin'] })
  })

  it('a two-agent cycle: the lead is never also a direct report', () => {
    agent('a', team('b'))
    agent('b', team('a'))
    expect(build('a').ctx.team).toEqual({ reportsTo: 'b', directReports: [] })
    expect(build('b').ctx.team).toEqual({ reportsTo: 'a', directReports: [] })
  })

  it('an unknown or self reportsTo does not stop the reverse direction from being counted', () => {
    agent('kevin', team('ghost'))
    agent('a', team('kevin'))
    expect(build('kevin').ctx.team).toEqual({ reportsTo: null, directReports: ['a'] })
  })
})

describe('profile.strict', () => {
  const noStrict = { helperAllowed: true }
  it('the override wins both ways', () => {
    agent('a')
    putJson('agents/a/.claude/settings.json', { permissions: { defaultMode: 'dontAsk' } })
    expect(build('a', { helperAllowed: true, strict: false }).ctx.profile.strict).toBe(false)
    agent('b')
    expect(build('b', { helperAllowed: true, strict: true }).ctx.profile.strict).toBe(true)
  })

  it('without the override: the written project dontAsk reads strict, no mode reads not strict', () => {
    agent('a')
    putJson('agents/a/.claude/settings.json', { permissions: { allow: [], deny: [], defaultMode: 'dontAsk' } })
    expect(build('a', noStrict)).toMatchObject({ ctx: { profile: { strict: true } } })
    agent('b')
    putJson('agents/b/.claude/settings.json', { permissions: { allow: [] } })
    expect(build('b', noStrict).ctx.profile.strict).toBe(false)
    expect(build('b', noStrict).assumptions).not.toContain('profile.strict')
  })

  it('the highest layer that sets a mode decides (local > project > user scope)', () => {
    agent('a')
    putJson('agents/a/.claude/settings.json', { permissions: { defaultMode: 'dontAsk' } })
    putJson('agents/a/.claude/settings.local.json', { permissions: { defaultMode: 'default' } })
    expect(build('a', noStrict).ctx.profile.strict).toBe(false)
    agent('b')
    putJson('agents/b/.claude/settings.json', { permissions: { allow: [] } })
    putJson('agents/b/.claude-config/settings.json', { permissions: { defaultMode: 'dontAsk' } })
    expect(build('b', noStrict).ctx.profile.strict).toBe(true)
    agent('c')
    putJson('agents/c/.claude/settings.json', { permissions: { defaultMode: 'plan' } })
    putJson('agents/c/.claude-config/settings.json', { permissions: { defaultMode: 'dontAsk' } })
    expect(build('c', noStrict).ctx.profile.strict).toBe(false)
  })

  it('a layer that does not parse above the deciding one: read false, listed as assumed', () => {
    agent('a')
    put('agents/a/.claude/settings.local.json', '{broken')
    putJson('agents/a/.claude/settings.json', { permissions: { defaultMode: 'dontAsk' } })
    const r = build('a', noStrict)
    expect(r.ctx.profile.strict).toBe(false)
    expect(r.assumptions).toContain('profile.strict')
    // Below the deciding layer it does not matter.
    agent('b')
    putJson('agents/b/.claude/settings.json', { permissions: { defaultMode: 'dontAsk' } })
    put('agents/b/.claude-config/settings.json', '[]')
    expect(build('b', noStrict).ctx.profile.strict).toBe(true)
    expect(build('b', noStrict).assumptions).not.toContain('profile.strict')
  })

  it('the main agent is never strict, override or not', () => {
    putJson('.claude/settings.json', { permissions: { defaultMode: 'dontAsk' } })
    expect(build('marveen', { helperAllowed: true }).ctx.profile.strict).toBe(false)
    expect(build('marveen', { helperAllowed: true, strict: true }).ctx.profile.strict).toBe(false)
  })
})

describe('profile.helperAllowed', () => {
  it('the override is taken as is and is not an assumption', () => {
    agent('a')
    putJson('agents/a/.claude/settings.json', { permissions: { deny: ['Bash'] } })
    for (const v of [true, false]) {
      const r = build('a', { strict: false, helperAllowed: v })
      expect(r.ctx.profile.helperAllowed).toBe(v)
      expect(r.assumptions).not.toContain('profile.helperAllowed')
    }
  })

  it('without the override: the simplified reading, always listed as assumed', () => {
    agent('a')
    const cases: [unknown, boolean][] = [
      [{ permissions: { deny: ['Read(/etc/**)', 'Bash(rm:*)'] } }, true],
      [{ permissions: { deny: ['Bash'] } }, false],
      [{ permissions: { deny: ['Bash(*)'] } }, false],
      [{ permissions: { deny: ['Bash(:*)'] } }, false],
      [{ permissions: { deny: [`Bash(bash ${root}/scripts/marveen-api.sh:*)`] } }, false],
      [{ permissions: { deny: ['Bash(bash:*)'] } }, false],
      [{}, true],
    ]
    for (const [settings, want] of cases) {
      putJson('agents/a/.claude/settings.json', settings)
      const r = build('a', { strict: false })
      expect(r.ctx.profile.helperAllowed, JSON.stringify(settings)).toBe(want)
      expect(r.assumptions).toContain('profile.helperAllowed')
    }
    put('agents/a/.claude/settings.json', 'nope')
    expect(build('a', { strict: false }).ctx.profile.helperAllowed).toBe(false)
  })
})

describe('capabilities', () => {
  it('kanbanWrite is false only for the heartbeat worker; scheduleWrite only for the main agent', () => {
    agent('heartbeat')
    agent('kevin')
    const caps = (n: string) => build(n).ctx.capabilities
    expect(caps('heartbeat')).toMatchObject({ kanbanWrite: false, scheduleWrite: false })
    expect(caps('kevin')).toMatchObject({ kanbanWrite: true, scheduleWrite: false })
    expect(caps('marveen')).toMatchObject({ kanbanWrite: true, scheduleWrite: true })
  })

  it('federation: store/federation.json enabled === true, everything else off', () => {
    expect(build('marveen').ctx.capabilities.federation).toBe(false)
    const cases: [string, boolean][] = [
      ['{"enabled": true}', true],
      ['{"enabled": true, "peers": "not-a-list"}', true],
      ['{"enabled": false}', false],
      ['{"enabled": "true"}', false],
      ['{"enabled": 1}', false],
      ['{broken', false],
      ['[true]', false],
      ['null', false],
    ]
    for (const [text, want] of cases) {
      put('store/federation.json', text)
      expect(build('marveen').ctx.capabilities.federation, text).toBe(want)
    }
  })

  it('the assumed capabilities carry their fixed values', () => {
    expect(build('marveen').ctx.capabilities).toMatchObject({ emailSend: 'none', browser: false, thinChief: false })
  })
})

describe('autonomy', () => {
  const autonomy = (cats: unknown) => {
    putJson('store/autonomy-config.json', { categories: cats })
    return build('marveen').ctx.autonomy
  }

  it('a missing file, or no categories key, is no categories', () => {
    expect(build('marveen').ctx.autonomy).toEqual({})
    putJson('store/autonomy-config.json', { other: 1 })
    expect(build('marveen').ctx.autonomy).toEqual({})
  })

  it('each level clamped as readAutonomyLevel does', () => {
    expect(autonomy([
      { key: 'a', level: 2 },
      { key: 'b', level: 5 },
      { key: 'c', level: 0 },
      { key: 'd', level: 3, maxLevel: 2 },
      { key: 'e', level: 2.5 },
      { key: 'f', level: 'x' },
      { key: 'g', level: '2' },
      { key: 'h', level: null },
      { key: 'i', level: 3, maxLevel: 1.5 },
      { key: 'j', level: -4 },
    ])).toEqual({ a: 2, b: 3, c: 1, d: 2, e: 1, f: 1, g: 2, h: 1, i: 3, j: 1 })
  })

  it('the first entry of a key wins; entries without a string key are skipped', () => {
    expect(autonomy([{ key: 'a', level: 3 }, { key: 'a', level: 1 }, { level: 2 }, null, 'x', { key: 7, level: 2 }]))
      .toEqual({ a: 3 })
  })

  it('a file that does not parse, or a categories that is not a list, throws', () => {
    put('store/autonomy-config.json', '{broken')
    expect(() => build('marveen')).toThrow(/not valid JSON/)
    putJson('store/autonomy-config.json', { categories: { a: 1 } })
    expect(() => build('marveen')).toThrow(/not a list/)
  })
})

describe('hooks (J4: the script file must be there)', () => {
  const rescan = (path: string) => `bash -c '[ -f ${path} ] && exec python3 ${path}; exit 0'`
  const settings = (cmd: string) => ({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: cmd }] }] } })

  it('a sub: wired and the file is there -> true; the file missing -> false', () => {
    agent('a')
    const script = join(root, 'scripts', 'hooks', 'shell-rescan-guard.py')
    putJson('agents/a/.claude/settings.json', settings(rescan(script)))
    expect(build('a').ctx.hooks.shellRescan).toBe(false)
    put('scripts/hooks/shell-rescan-guard.py', '#!/usr/bin/env python3\n')
    expect(build('a').ctx.hooks).toEqual({ directiveVerify: false, childClaudeGuard: false, shellRescan: true })
  })

  it('$CLAUDE_PROJECT_DIR resolves to the agent directory (a sub) or the root (main)', () => {
    agent('a')
    const cmd = `bash -c '[ -f "$CLAUDE_PROJECT_DIR/scripts/hooks/shell-rescan-guard.py" ] && exec python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/shell-rescan-guard.py"; exit 0'`
    putJson('agents/a/.claude/settings.json', settings(cmd))
    putJson('.claude/settings.json', settings(cmd))
    put('scripts/hooks/shell-rescan-guard.py', 'x')
    expect(build('marveen').ctx.hooks.shellRescan).toBe(true)
    expect(build('a').ctx.hooks.shellRescan).toBe(false)
    put('agents/a/scripts/hooks/shell-rescan-guard.py', 'x')
    expect(build('a').ctx.hooks.shellRescan).toBe(true)
  })

  it('a directory or an unreadable file at the path is not a script', () => {
    agent('a')
    const script = join(root, 'scripts', 'hooks', 'shell-rescan-guard.py')
    putJson('agents/a/.claude/settings.json', settings(rescan(script)))
    mkdirSync(script, { recursive: true })
    expect(build('a').ctx.hooks.shellRescan).toBe(false)
    rmSync(script, { recursive: true })
    put('scripts/hooks/shell-rescan-guard.py', 'x')
    chmodSync(script, 0o000)
    // root ignores the mode bits, so the unreadable case only bites for a non-root user.
    const runsAsRoot = process.getuid?.() === 0
    expect(build('a').ctx.hooks.shellRescan).toBe(runsAsRoot)
  })

  it('a settings layer that does not parse makes every hook false', () => {
    agent('a')
    put('scripts/hooks/shell-rescan-guard.py', 'x')
    putJson('agents/a/.claude/settings.json', settings(rescan(join(root, 'scripts', 'hooks', 'shell-rescan-guard.py'))))
    put('agents/a/.claude-config/settings.json', '{broken')
    expect(build('a').ctx.hooks).toEqual({ directiveVerify: false, childClaudeGuard: false, shellRescan: false })
  })

  it('the main agent reads its user-scope layer from homeDir, a sub never does', () => {
    agent('a')
    put('scripts/hooks/shell-rescan-guard.py', 'x')
    putJson('.claude/settings.json', settings(rescan(join(root, 'scripts', 'hooks', 'shell-rescan-guard.py'))), home)
    expect(build('marveen').ctx.hooks.shellRescan).toBe(true)
    expect(build('a').ctx.hooks.shellRescan).toBe(false)
  })
})

describe('assumptions', () => {
  const FIXED = ['capabilities.browser', 'capabilities.emailSend', 'capabilities.thinChief', 'profile.id', 'tokenPath']

  it('with both overrides: exactly the fixed list, sorted, none of them rendered', () => {
    agent('a')
    for (const n of ['marveen', 'a']) expect(build(n).assumptions).toEqual(FIXED)
    for (const a of FIXED) expect(RENDERED_FIELDS as readonly string[]).not.toContain(a)
  })

  it('without the helper override, profile.helperAllowed joins the list (a rendered field: no write in 10b)', () => {
    agent('a')
    const r = build('a', {})
    expect(r.assumptions).toEqual([...FIXED, 'profile.helperAllowed'].sort())
    expect(RENDERED_FIELDS as readonly string[]).toContain('profile.helperAllowed')
  })

  it('the stored securityProfile is what profile.id carries (still assumed: not the resolved profile)', () => {
    agent('a', { securityProfile: 'developer-junior' })
    agent('b')
    expect(build('a').ctx.profile.id).toBe('developer-junior')
    expect(build('b').ctx.profile.id).toBe('default')
    expect(build('marveen').ctx.profile.id).toBe('default')
  })

  it('tokenPath is the store token file', () => {
    expect(build('marveen').ctx.tokenPath).toBe(join(root, 'store', '.dashboard-token'))
  })
})

describe('RENDERED_FIELDS equals the ctx fields the render reads', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'claude-md')
  const NESTED = new Set(['owner', 'profile', 'capabilities'])

  // skills.ts renders from its own SkillContext (projectRoot, mainAgentId, dashboardOrigin), which 10b builds;
  // its AgentDocContext-derived fields are rendered by sections.ts as well.
  it('sections.ts, registry.ts and render.ts', () => {
    const used = new Set<string>()
    for (const f of ['sections.ts', 'registry.ts', 'render.ts']) {
      const text = readFileSync(join(SRC, f), 'utf-8')
      // A ctx is named `ctx` or `c` in these files; anything else would hide a read from this test.
      for (const m of text.matchAll(/\b(?:ctx|c)\.([A-Za-z]+)(?:\.([A-Za-z]+))?/g)) {
        used.add(NESTED.has(m[1]) && m[2] ? `${m[1]}.${m[2]}` : m[1])
      }
      expect(text, `${f}: a destructured ctx`).not.toMatch(/\{[^}]*\}\s*:\s*AgentDocContext|=\s*ctx\s*[;\n]/)
    }
    expect([...used].sort()).toEqual([...RENDERED_FIELDS].sort())
  })
})

// Stuart's condition for the read-only dry-run CLI (C1 PR 8b builds on this module) and Kevin 12997: no config.js
// (code-location root, reads .env at import), logger.js, atomic-write.js, agent-scaffold.ts or federation/config.ts
// anywhere in the import tree, and nothing in the tree that writes.
describe('import tree', () => {
  const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const FORBIDDEN = ['config.ts', 'logger.ts', 'web/atomic-write.ts', 'web/agent-scaffold.ts', 'web/federation/config.ts']

  function tree(entry: string): { files: string[]; builtins: string[] } {
    const files: string[] = []
    const builtins = new Set<string>()
    const queue = [entry]
    while (queue.length > 0) {
      const rel = queue.shift()!
      if (files.includes(rel)) continue
      files.push(rel)
      const text = readFileSync(join(SRC_ROOT, rel), 'utf-8')
      expect(text, `${rel}: a dynamic import or require hides an edge from this walk`).not.toMatch(/\bimport\s*\(|\brequire\s*\(/)
      // `import ... from 'x'`, `export ... from 'x'`, and the side-effect form `import 'x'` (no from).
      for (const m of text.matchAll(/^\s*(?:(?:import|export)\b[^'"]*?\bfrom\s+|import\s+)['"]([^'"]+)['"]/gm)) {
        const spec = m[1]
        if (spec.startsWith('node:')) { builtins.add(spec); continue }
        expect(spec.startsWith('.'), `${rel}: bare import ${spec}`).toBe(true)
        queue.push(join(dirname(rel), spec).replace(/\.js$/, '.ts'))
      }
    }
    return { files: files.sort(), builtins: [...builtins].sort() }
  }

  it('reaches exactly five source files, none of the forbidden ones, and only fs, os and path', () => {
    const { files, builtins } = tree('web/claude-md/live-context.ts')
    expect(files).toEqual(['env-parse.ts', 'web/claude-md/agent-name.ts', 'web/claude-md/context.ts', 'web/claude-md/hooks-from-settings.ts', 'web/claude-md/live-context.ts'])
    for (const f of FORBIDDEN) expect(files).not.toContain(f)
    expect(builtins).toEqual(['node:fs', 'node:os', 'node:path'])
  })

  // Ron S2: a name regex alone misses `import { writeFileSync as w }` and `fsx['writeFile' + 'Sync']`. So the
  // tree may import from node:fs only these read-only names, each by its own name (no alias, no namespace or
  // default import), and may not reach a module another way (require, dynamic import, process, globalThis).
  const FS_ALLOWED = ['accessSync', 'constants', 'existsSync', 'lstatSync', 'readFileSync', 'readdirSync', 'realpathSync', 'statSync']

  it('node:fs is imported only by an exact allowlist of read-only names, never aliased or as a namespace', () => {
    const seen = new Set<string>()
    for (const f of tree('web/claude-md/live-context.ts').files) {
      const text = readFileSync(join(SRC_ROOT, f), 'utf-8')
      expect(text, `${f}: process or globalThis reaches modules around the import list`).not.toMatch(/\b(?:process|globalThis)\b/)
      for (const m of text.matchAll(/^\s*import\s+([^'"]*?)\s+from\s+['"](node:fs(?:\/[a-z]+)?|fs(?:\/[a-z]+)?)['"]/gm)) {
        expect(m[2], `${f}: ${m[2]}`).toBe('node:fs')
        const clause = m[1].trim()
        const named = /^\{([^}]*)\}$/.exec(clause)
        expect(named, `${f}: only a named import of node:fs (no default, no namespace): ${clause}`).not.toBeNull()
        for (const part of named![1].split(',').map((x) => x.trim()).filter(Boolean)) {
          expect(part, `${f}: no alias in a node:fs import`).toMatch(/^[A-Za-z]+$/)
          expect(FS_ALLOWED, `${f}: ${part}`).toContain(part)
          seen.add(part)
        }
      }
      expect(text, `${f}: export-from node:fs`).not.toMatch(/^\s*export\b[^'"]*from\s+['"](?:node:)?fs/m)
    }
    expect([...seen].sort()).toEqual(FS_ALLOWED)
  })

  it('no file in the tree names a writing fs call (the cheap second net)', () => {
    for (const f of tree('web/claude-md/live-context.ts').files) {
      const text = readFileSync(join(SRC_ROOT, f), 'utf-8')
      expect(text, f).not.toMatch(/\b(?:writeFile|appendFile|mkdir|rm|rmdir|unlink|rename|copyFile|symlink|chmod|chown|truncate|open|utimes|cp)(?:Sync)?\s*\(/)
    }
  })
})
