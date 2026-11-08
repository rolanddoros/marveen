import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { scriptRunSends } from '../../scripts/email-send-gate.mjs'

// JSCD1108: the JS side of the shared cd-target cases. The sub-agent hard gate
// (email-send-gate.mjs) did not follow a cd at all: a sending script reached by
// `cd sub && python3 job.py` was read under cwd only and passed. It now follows a
// literal cd by the python twin's rules (CDGATE1108); a target that cannot be
// known is not followed (cwd only, the documented accident gate). The list is
// shared with scripts/__tests__/cd-target-cases.test.py, so the twins cannot
// drift apart on it: each side answers its own column, py != js needs a reason,
// and js true -> py true always.

type Case = { name: string; cmd: string; files: Record<string, 'send' | 'harmless'>; py: boolean; js: boolean; reason?: string }
const { cases } = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'scripts', 'hooks', 'cd-target-cases.json'), 'utf-8'),
) as { cases: Case[] }

const BODY: Record<string, string> = {
  '.py:send': "import smtplib\ns = smtplib.SMTP('localhost')\n",
  '.py:harmless': "print('x')\n",
  '.mjs:send': "import nodemailer from 'nodemailer'\n",
  '.mjs:harmless': "console.log('x')\n",
}

const root = mkdtempSync(join(tmpdir(), 'cd-target-cases-'))
const oldHome = process.env.HOME
afterAll(() => {
  if (oldHome === undefined) delete process.env.HOME
  else process.env.HOME = oldHome
  rmSync(root, { recursive: true, force: true })
})

function layout(n: number, files: Case['files']): { cwd: string; home: string } {
  const cwd = join(root, String(n), 'cwd')
  const home = join(root, String(n), 'home')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(home, { recursive: true })
  for (const [rel, what] of Object.entries(files)) {
    const path = rel.startsWith('~/') ? join(home, rel.slice(2)) : join(cwd, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, BODY[`${extname(rel)}:${what}`])
  }
  return { cwd, home }
}

describe('shared cd-target cases, JS side (JSCD1108)', () => {
  it('the shared list has cases on both sides of the py/js split', () => {
    expect(cases.some((c) => c.py !== c.js)).toBe(true)
    expect(cases.some((c) => c.py === c.js)).toBe(true)
  })

  it.each(cases)('invariant js -> py, and a reason when they differ: $name', (c) => {
    expect(c.py || !c.js).toBe(true)
    if (c.py !== c.js) expect((c.reason ?? '').trim()).not.toBe('')
  })

  it.each(cases.map((c, n) => ({ ...c, n })))('js: $name', (c) => {
    const { cwd, home } = layout(c.n, c.files)
    process.env.HOME = home
    expect(scriptRunSends(c.cmd.replaceAll('{CWD}', cwd), cwd)).toBe(c.js)
  })

  it('the hook denies a sender behind a literal cd, and the substitution placeholder never reaches its output', () => {
    const { cwd, home } = layout(cases.length + 1, { 'sub/job.py': 'send', 'job.py': 'harmless' })
    const hook = join(__dirname, '..', '..', 'scripts', 'email-send-gate.mjs')
    const run = (command: string) => spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
      encoding: 'utf-8', timeout: 15_000, env: { ...process.env, HOME: home },
    })
    for (const command of ['cd sub && python3 job.py $(date)', 'cd sub && cd `pwd` ; python3 job.py']) {
      const r = run(command)
      expect(r.status).toBe(0)
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
      expect(r.stdout + r.stderr).not.toContain('__SUBST__')
    }
    const harmless = run('cd sub && python3 other.py $(date)')
    expect(harmless.stdout + harmless.stderr).not.toContain('__SUBST__')
  })
})
