// A real `claude --channels` stand-in for the reaper tests, shared by channel-poller-reap-guards and
// channel-poller-reap-own-uid (B2-1, Kevin 11811).
//
// WHY UNDER A FAKE TMUX. Tests that spawn a real `claude --channels` process on a host with a live dashboard can be
// reaped by its periodic detached-orphan reap. Measured 2026-11-05: the live channel-monitor (every 10 min, no needle,
// the same uid) killed a guards-test claude at 13:16:35.011 (store/dashboard.log, "periodic reap removed detached
// channel-claude orphans"), 0.6 s after the test's own reaper had correctly spared it; the test then read
// "expected false to be true". A fixed wait or a condition-wait cannot fix that: the process is gone.
//
// So the fake claude runs under a process whose argv0 is `tmux`, and the test's fake tmux binary reports THAT pid as
// its server (display-message) while list-panes answers the pane list the case names. The test's reaper sees its own
// server above the claude and judges it exactly as before. The live reaper sees a tmux server that is not its own
// above it, and spares it under the existing #2078 rule (another install's session). No product code is involved.
//
// The tree: outer bash (exits at once, so nothing hangs under the test runner, whose ancestry may hold a real tmux)
// -> fake tmux -> fake claude (`claude -c ... --channels <needle>`) -> `sleep 300` (the child, a pane leader when a
// case says so). Every pid file is written to a temp name and renamed, so a reader never sees an empty file.
import { spawn, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcRow } from '../../web/channel-poller-reap.js'

const SPAWN_SCRIPT = `#!/bin/bash
# $1 = pid-file prefix, $2 = the channel needle
( exec -a tmux /bin/bash -c '
    ( exec -a claude /bin/bash -c "sleep 300 & echo \\$! > \\"\\$0.child.tmp\\" && mv \\"\\$0.child.tmp\\" \\"\\$0.child\\"; wait" "$0" --channels "$1" ) &
    echo $! > "$0.claude.tmp" && mv "$0.claude.tmp" "$0.claude"
    wait' "$1" "$2" ) &
echo $! > "$1.tmux.tmp" && mv "$1.tmux.tmp" "$1.tmux"
`

export interface FakeChannelClaude { tmux: number; claude: number; child: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Starts the tree under `dir` and resolves once all three pids are written and alive. `track` gets every pid, for
 * the caller's afterAll cleanup. `env` is the environment of the outer bash (the caller strips the channel markers).
 */
export async function spawnFakeChannelClaude(
  dir: string, tag: string, needle: string, env: NodeJS.ProcessEnv, track: (pid: number) => void,
): Promise<FakeChannelClaude> {
  const script = join(dir, 'fake-channel-claude.sh')
  if (!existsSync(script)) { writeFileSync(script, SPAWN_SCRIPT); chmodSync(script, 0o755) }
  const prefix = join(dir, `fcc-${tag}`)
  const outer = spawn('/bin/bash', [script, prefix, needle], { detached: true, stdio: 'ignore', env })
  outer.unref()
  const files = ['tmux', 'claude', 'child'].map((k) => `${prefix}.${k}`)
  const deadline = Date.now() + 10_000
  while (!files.every((f) => existsSync(f))) {
    if (Date.now() > deadline) throw new Error(`fake channel claude ${tag}: pid files not written in 10 s`)
    await sleep(25)
  }
  const [tmux, claude, child] = files.map((f) => parseInt(readFileSync(f, 'utf-8').trim(), 10))
  for (const pid of [tmux, claude, child]) {
    if (!Number.isInteger(pid) || pid <= 1) throw new Error(`fake channel claude ${tag}: bad pid in ${files.join(', ')}`)
    track(pid)
  }
  return { tmux, claude, child }
}

/** A fake tmux binary: display-message answers `server`, every other query (list-panes) answers the `panes`. */
export function writeFakeTmux(path: string, panes: number[], server: number): void {
  const list = panes.map((p) => `echo ${p}`).join('; ') || 'true'
  writeFileSync(path, `#!/bin/sh\ncase "$*" in\n  *display-message*) echo ${server} ;;\n  *) ${list} ;;\nesac\n`)
  chmodSync(path, 0o755)
}

/** The host's process table, as the reapers read it (ps -axww -o pid=,ppid=,command=). */
export function processTable(): ProcRow[] {
  const out = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
  const rows: ProcRow[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (m) rows.push({ pid: parseInt(m[1]!, 10), ppid: parseInt(m[2]!, 10), command: m[3]! })
  }
  return rows
}
