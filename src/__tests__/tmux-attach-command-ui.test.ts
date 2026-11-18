// kanban b15fe512 (Ron 17751 M1, Kevin 17777 point 5): the copyable attach command on a running agent card
// (web/app.js tmuxAttachCommand) is run by the owner's own ssh. It reads `ssh -t -- <host> '<tmux attach>'`:
// '--' so a host can never be read as an ssh option (the browser has no host validator of its own), and '-t'
// BEFORE '--', because after '--' ssh parses nothing as an option and a '-t' behind the host would be dropped
// (no tty; measured with ssh -G: requesttty auto instead of true). The function is the real one from app.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')

const START = 'function tmuxAttachCommand(agent) {'
const at = APP.indexOf(START)
const src = APP.slice(at, APP.indexOf('\n}\n', at) + 3)
const tmuxAttachCommand = new Function(`${src}\nreturn tmuxAttachCommand`)() as (agent: Record<string, unknown>) => string

describe('tmuxAttachCommand (web/app.js)', () => {
  it('is found once in app.js', () => {
    expect(at).toBeGreaterThan(0)
    expect(APP.indexOf(START, at + 1)).toBe(-1)
  })

  it("a remote agent: ssh -t -- <host> '<tmux attach>'", () => {
    expect(tmuxAttachCommand({ name: 'x', session: 'agent-x', remoteHost: 'devbox' }))
      .toBe("ssh -t -- devbox 'tmux attach -t agent-x'")
  })

  it("'-t' comes before '--' and the host comes right after it", () => {
    const words = tmuxAttachCommand({ name: 'x', remoteHost: 'user@laptop' }).split(' ')
    expect(words.slice(0, 4)).toEqual(['ssh', '-t', '--', 'user@laptop'])
  })

  it('a local agent: the bare tmux attach, no ssh (session defaults to agent-<name>)', () => {
    expect(tmuxAttachCommand({ name: 'x' })).toBe('tmux attach -t agent-x')
    expect(tmuxAttachCommand({ name: 'x', remoteHost: null })).toBe('tmux attach -t agent-x')
  })
})
