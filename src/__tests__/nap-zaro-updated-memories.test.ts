import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeAll, listenOnLocalhost, localhostAddresses } from './setup/localhost-bind.js'

// NAPZAROFRISS918: the nap-zaro SKILL.md's step-2 Python block (heredoc `<<'PY'`)
// now reports updated memories separately from new ones (spec 17-18. döntés). This
// test cuts that exact block out of the shipped SKILL.md and runs it as a real
// python3 process against a local HTTP stub serving a fixture -- so the assertion
// is against the shipped skill text, not a hand-copied re-implementation of it.

const SKILL_PATH = join(__dirname, '..', '..', 'seed-scheduled-tasks', 'nap-zaro', 'SKILL.md')
const FIXTURE_PATH = join(__dirname, 'fixtures', 'nap-zaro-memories.json')
const TOKEN = 'test-token'

function extractPyBlock(): string {
  const text = readFileSync(SKILL_PATH, 'utf-8')
  const lines = text.split('\n')
  const startIdx = lines.findIndex((l) => l.trim() === "python3 - \"$PORT\" \"$TOKEN\" \"$SINCE\" <<'PY'")
  if (startIdx === -1) throw new Error('nap-zaro SKILL.md: step-2 PY heredoc start not found')
  const endIdx = lines.findIndex((l, i) => i > startIdx && l.trim() === 'PY')
  if (endIdx === -1) throw new Error('nap-zaro SKILL.md: step-2 PY heredoc end not found')
  return lines.slice(startIdx + 1, endIdx).join('\n')
}

function runScript(port: number, since: number): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))
  const script = extractPyBlock().split('{{MAIN_AGENT_ID}}').join(fixture.agent_id)
  const dir = mkdtempSync(join(tmpdir(), 'nap-zaro-py-'))
  const scriptPath = join(dir, 'napzaro.py')
  writeFileSync(scriptPath, script)
  return new Promise((resolve) => {
    // spawn, NOT spawnSync: the stub HTTP server lives in this same process/event
    // loop -- a sync spawn would block that loop and the server could never answer
    // the child's request, deadlocking until the timeout.
    const child = spawn('python3', [scriptPath, String(port), TOKEN, String(since)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

describe('nap-zaro SKILL.md step-2: uj + frissitett emlekek (NAPZAROFRISS918)', () => {
  let servers: Server[] = []
  let port: number

  beforeAll(async () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))
    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      res.setHeader('Content-Type', 'application/json')
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/api/memories') {
        const offset = Number(url.searchParams.get('offset') ?? '0')
        const limit = Number(url.searchParams.get('limit') ?? '200')
        res.end(JSON.stringify(fixture.memories.slice(offset, offset + limit)))
      } else if (url.pathname === '/api/kanban') {
        res.end(JSON.stringify(fixture.kanban))
      } else {
        res.statusCode = 404
        res.end('{}')
      }
    }
    // the shipped script connects to "localhost", and which address that is depends on the
    // host: ::1 first on one, 127.0.0.1 only on another (this one), no ::1 at all on an
    // IPv4-only host. Binding a single family made this suite red wherever it guessed wrong
    // (B2-1), so the stub listens on every address localhost resolves to, on one port.
    ;({ port, servers } = await listenOnLocalhost(() => createServer(handler)))
  })

  afterAll(async () => {
    await closeAll(servers)
  })

  it('lists new and updated memories separately, no duplication, tail shown for updated', async () => {
    const { status, stdout, stderr } = await runScript(port, 1000)
    if (status !== 0) console.error(stderr)
    expect(status).toBe(0)

    expect(stdout).toContain('-- uj emlekek: 2')
    expect(stdout).toContain('-- frissitett emlekek: 1')

    // m2 (new) and m4 (created+updated in window -> only among the new ones)
    expect(stdout).toContain('brand new memory created inside the window')
    expect(stdout).toContain('created and updated both inside the window')

    // m3 (old, updated in window) appears once, in the updated section, tail shown.
    // The line legitimately includes the first ~60 chars (short identifier prefix,
    // per spec) AND the last ~300 chars (the tail) -- only the middle is cut.
    const updatedSection = stdout.split('-- frissitett emlekek:')[1] ?? ''
    expect(updatedSection).toContain('TAIL-MARKER-XYZ-END-OF-CONTENT')
    expect(updatedSection).not.toContain('this old memory got updated inside the window and the summary')

    // m4 must not also appear in the updated section (no duplication)
    expect(updatedSection).not.toContain('created and updated both inside the window')

    // m1 (old, untouched), m5 (null updated_at), m7 (maintenance-only), m8 (other agent)
    // must not appear anywhere
    for (const marker of [
      'old memory, never touched',
      'updated_at is NULL',
      'only maintenance fields changed',
      'belongs to a different agent',
    ]) {
      expect(stdout).not.toContain(marker)
    }
  })

  it('null updated_at does not crash the script (m5)', async () => {
    const { status, stderr } = await runScript(port, 1000)
    expect(status).toBe(0)
    expect(stderr).not.toContain('TypeError')
  })

  it('a bad port (stub unreachable) fails loudly instead of reporting zero', async () => {
    // port 1 is a reserved, never-listening port
    const { status, stdout } = await runScript(1, 1000)
    expect(status).not.toBe(0)
    expect(stdout).not.toContain('-- uj emlekek: 0')
  })
})

describe('localhost stub binding follows the host resolver (B2-1)', () => {
  const fake = (...addrs: Array<[string, number]>) => async () => addrs.map(([address, family]) => ({ address, family }))

  it('an IPv4-only host: binds 127.0.0.1 only, never ::1', async () => {
    expect(await localhostAddresses(fake(['127.0.0.1', 4]))).toEqual(['127.0.0.1'])
  })

  it('a dual-stack host that answers ::1 first: binds both, IPv4 first, duplicates dropped', async () => {
    expect(await localhostAddresses(fake(['::1', 6], ['127.0.0.1', 4], ['::1', 6]))).toEqual(['127.0.0.1', '::1'])
  })

  it('an IPv6-only answer: binds ::1', async () => {
    expect(await localhostAddresses(fake(['::1', 6]))).toEqual(['::1'])
  })

  it('a dual-stack answer: the stub listens on BOTH addresses, on the one port (skipped where ::1 cannot bind)', async (ctx) => {
    const probe = createServer()
    const v6 = await new Promise<boolean>((resolve) => {
      probe.once('error', () => resolve(false))
      probe.listen(0, '::1', () => probe.close(() => resolve(true)))
    })
    if (!v6) ctx.skip('this host cannot bind ::1 (IPv4-only)')
    const { port: p, servers: ss, addresses } = await listenOnLocalhost(
      () => createServer((_req, res) => res.end('ok')),
      fake(['::1', 6], ['127.0.0.1', 4]),
    )
    try {
      expect(addresses).toEqual(['127.0.0.1', '::1'])
      expect(ss).toHaveLength(2)
      for (const host of ['127.0.0.1', '[::1]']) {
        expect(await (await fetch(`http://${host}:${p}/`)).text()).toBe('ok')
      }
    } finally {
      await closeAll(ss)
    }
  })

  it('every address localhost resolves to on THIS host answers on the one port', async () => {
    const { port: p, servers: ss, addresses } = await listenOnLocalhost(() =>
      createServer((_req, res) => res.end('ok')),
    )
    try {
      expect(addresses).toEqual(await localhostAddresses())
      for (const a of addresses) {
        const host = a.includes(':') ? `[${a}]` : a
        const body = await (await fetch(`http://${host}:${p}/`)).text()
        expect(body).toBe('ok')
      }
    } finally {
      await closeAll(ss)
    }
  })
})
