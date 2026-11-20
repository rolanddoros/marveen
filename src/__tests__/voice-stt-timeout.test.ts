// Card 58b9aa06: the voice STT budget (whisper large-v3 is minutes, not seconds). Pinned here:
// - MARVEEN_STT_TIMEOUT_MS: default 900 s, whole ms within [30 s, 1 h], anything else -> the default;
// - one whisper process at a time, and the wait for the slot counts against the caller's budget (a caller whose
//   budget runs out while queued gets 'timeout' without running, and does not block the next one);
// - the hook chain 900 s < urlopen 910 s < hook timeout 920 s, read from the three files themselves;
// - a timeout is never silent: /api/voice/directive answers stt_notice (a real fake-whisper run killed at the
//   budget), /api/voice/stt answers 504 with it, and the hook prints it.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { writeWhisperPidfile, defaultWhisperReapDeps } from '../web/whisper-orphan.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

// The toolkit is found under homedir() when voice.ts loads: a scratch HOME with a fake whisper, set in beforeAll
// BEFORE voice.ts is imported (dynamically, below), so no real toolkit is ever touched.
const home = mkdtempSync(join(tmpdir(), 'voice-stt-home-'))
const fake = { home, stateDir: join(home, '.claude', 'channels', 'telegram') }

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  readAgentVoiceConfig: () => ({ responseMode: 'text', voiceModel: 'hu_HU-imre-medium' }),
}))
vi.mock('../web/voice-directive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/voice-directive.js')>()),
  resolveAgentChannelStateDir: () => fake.stateDir,
}))

type VoiceModule = typeof import('../web/routes/voice.js')
let V: VoiceModule
import { sttTimeoutNotice } from '../web/voice-directive.js'
import { HOOK_MANIFEST } from '../web/hooks/manifest.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VOICE_DIR = join(fake.home, '.local', 'share', 'marveen-voice')
const FAKE_PY = join(VOICE_DIR, 'venv', 'bin', 'python')
const PIDFILE = join(fake.home, 'whisper.pid')

const STORE_PIDFILE = join(fake.home, 'store', 'whisper.pid')

beforeAll(async () => {
  process.env.HOME = fake.home
  V = await import('../web/routes/voice.js')
  mkdirSync(dirname(STORE_PIDFILE), { recursive: true })
  V._setWhisperPidfileForTest(STORE_PIDFILE)
  mkdirSync(join(VOICE_DIR, 'venv', 'bin'), { recursive: true })
  writeFileSync(join(VOICE_DIR, '_vtools.py'), '# fake\n')
  mkdirSync(fake.stateDir, { recursive: true })
  writeFileSync(join(fake.stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=x\n')
})
afterAll(() => rmSync(fake.home, { recursive: true, force: true }))
beforeEach(() => V._resetWhisperQueueForTest())

/** The fake whisper. `text`: prints it. 'slow': like _vtools.py, downloads into a temp .ogg, works, and deletes the
 *  file in a finally (records pid + temp path). 'stubborn': the same, but ignores SIGINT (only SIGKILL stops it). */
const TMPD = join(home, 'whisper-tmp')
const MARK = join(home, 'whisper.tmpfile')
function fakeWhisper(mode: { text: string } | 'slow' | 'stubborn') {
  rmSync(PIDFILE, { force: true }); rmSync(MARK, { force: true }); mkdirSync(TMPD, { recursive: true })
  const body = mode === 'slow' || mode === 'stubborn'
    ? ['#!/usr/bin/env python3', 'import os, signal, tempfile, time',
       ...(mode === 'stubborn' ? ['signal.signal(signal.SIGINT, signal.SIG_IGN)'] : []),
       `fd, out = tempfile.mkstemp(suffix='.ogg', dir=${JSON.stringify(TMPD)}); os.close(fd)`,
       `open(${JSON.stringify(MARK)}, 'w').write(out)`,
       `open(${JSON.stringify(PIDFILE)}, 'w').write(str(os.getpid()))`,
       'try:', '    time.sleep(60)', 'finally:', '    os.unlink(out)', ''].join('\n')
    : `#!/bin/sh\necho '${(mode as { text: string }).text}'\n`
  writeFileSync(FAKE_PY, body)
  chmodSync(FAKE_PY, 0o755)
}

async function call(method: string, path: string, body?: unknown) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { setHeader() {}, writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const str = body === undefined ? '' : JSON.stringify(body)
  const req: any = { method, headers: {}, on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data' && str) cb(Buffer.from(str)); if (ev === 'end') cb() } }
  const url = new URL(`http://localhost${path}`)
  const p = V.tryHandleVoice({ req, res, path: url.pathname, method, url, auth: { kind: 'token' } } as any)
  return { done: p.then(() => out), out }
}
const FILE_ID = 'AwACAgIAAxkBAAIBc2'
const directivePath = `/api/voice/directive?agent=dex&chat=12345&file=${FILE_ID}&kind=voice`

describe('resolveSttTimeoutMs', () => {
  it.each([
    [undefined, 900_000], ['', 900_000], ['  ', 900_000],
    ['30000', 30_000], ['3600000', 3_600_000], ['1200000', 1_200_000], [' 600000 ', 600_000],
    ['29999', 900_000], ['3600001', 900_000], ['15m', 900_000], ['1e6', 900_000], ['-60000', 900_000], ['600000.5', 900_000],
  ])('MARVEEN_STT_TIMEOUT_MS=%j -> %d ms', (raw, want) => {
    expect(V.resolveSttTimeoutMs(raw === undefined ? {} : { MARVEEN_STT_TIMEOUT_MS: raw })).toBe(want)
  })
  it('the default is 900 s and is what this process runs with (no override in the test env)', () => {
    expect(V.STT_TIMEOUT_DEFAULT_MS).toBe(900_000)
    expect(V.STT_TIMEOUT_MS).toBe(900_000)
  })
})

describe('runWhisperExclusive: one whisper at a time, the wait inside the budget', () => {
  it('a second caller starts only after the first finished', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const first = V.runWhisperExclusive(5_000, async () => { order.push('first:start'); await new Promise<void>((r) => { releaseFirst = r }); order.push('first:end'); return 1 }, () => -1)
    const second = V.runWhisperExclusive(5_000, async () => { order.push('second:start'); return 2 }, () => -1)
    await new Promise((r) => setTimeout(r, 30))
    expect(order).toEqual(['first:start'])
    releaseFirst()
    expect(await Promise.all([first, second])).toEqual([1, 2])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('a caller whose budget runs out in the queue times out without running, and the next caller is not blocked by it', async () => {
    let releaseFirst!: () => void
    const ran: string[] = []
    const first = V.runWhisperExclusive(5_000, async () => { await new Promise<void>((r) => { releaseFirst = r }); return 'first' }, () => 'first-timeout')
    const starved = V.runWhisperExclusive(40, async () => { ran.push('starved'); return 'starved' }, () => 'starved-timeout')
    expect(await starved).toBe('starved-timeout')
    const third = V.runWhisperExclusive(5_000, async (remaining) => { ran.push('third'); return remaining > 0 ? 'third' : 'bad' }, () => 'third-timeout')
    releaseFirst()
    expect(await first).toBe('first')
    expect(await third).toBe('third')
    expect(ran).toEqual(['third'])
  })

  it('run gets only what is left of the budget after the wait', async () => {
    let releaseFirst!: () => void
    const first = V.runWhisperExclusive(5_000, async () => { await new Promise<void>((r) => { releaseFirst = r }) }, () => undefined)
    let got = -1
    const second = V.runWhisperExclusive(1_000, async (remaining) => { got = remaining }, () => undefined)
    await new Promise((r) => setTimeout(r, 200))
    releaseFirst()
    await first; await second
    expect(got).toBeGreaterThan(0)
    expect(got).toBeLessThanOrEqual(820)
  })
})

describe('the hook chain: 900 s < urlopen 910 s < hook timeout 920 s', () => {
  it('read from the three places that set them', () => {
    const hook = readFileSync(join(REPO, 'scripts', 'hooks', 'voice-reply-directive.py'), 'utf-8')
    const urlopen = [...hook.matchAll(/urlopen\(req, timeout=(\d+)\)/g)].map((m) => Number(m[1]))
    expect(urlopen).toEqual([910])
    const spec = HOOK_MANIFEST.entries.find((h) => h.id === 'voice-reply-directive') as { timeout?: number } | undefined
    expect(spec?.timeout).toBe(920)
    const lock = JSON.parse(readFileSync(join(REPO, 'scripts', 'hooks', 'sub-hooks.lock.json'), 'utf-8'))
    expect(lock.entries['voice-reply-directive'].hook.timeout).toBe(920)
    expect(V.STT_DIRECTIVE_CEILING_MS).toBe(900_000)
    expect(V.STT_DIRECTIVE_CEILING_MS + V.STT_KILL_GRACE_MS).toBeLessThan(urlopen[0]! * 1000)
    expect(urlopen[0]! * 1000).toBeLessThan(spec!.timeout! * 1000)
  })
})

describe('a timeout is never silent', () => {
  afterEach(() => { vi.useRealTimers() })

  it('POSITIVE CONTROL: a whisper that answers gives the transcript and no notice', async () => {
    fakeWhisper({ text: 'szia, ez egy hangüzenet' })
    const r = await (await call('GET', directivePath)).done
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ directive: null, transcript: 'szia, ez egy hangüzenet', stt_notice: null })
  })

  it('/api/voice/directive: whisper killed at the 900 s budget -> transcript null + the visible notice', async () => {
    fakeWhisper('slow')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const c = await call('GET', directivePath)
    // wait for the fake whisper to be running (real time: the spawn is real)
    for (let i = 0; i < 200 && !existsPid(); i++) await realSleep(10)
    expect(existsPid()).toBe(true)
    await vi.advanceTimersByTimeAsync(V.STT_DIRECTIVE_CEILING_MS - 1_000)
    expect(c.out.status).toBe(0) // still waiting at 899 s
    await vi.advanceTimersByTimeAsync(1_001)
    vi.useRealTimers()
    const r = await c.done
    expect(r.status).toBe(200)
    expect(r.body.transcript).toBeNull()
    expect(r.body.stt_notice).toBe(sttTimeoutNotice(900, FILE_ID))
    expect(r.body.stt_notice).toContain('(transcription timed out)')
    // Ron 18424 item 3: the retry command is absolute (an agent's cwd is agents/<name>) and names the real script
    const retry = join(REPO, 'scripts', 'voice', 'stt.sh')
    expect(r.body.stt_notice.endsWith(`Kézi újrapróbálás: ${retry} ${FILE_ID}`)).toBe(true)
    expect(isAbsolute(retry) && existsSync(retry)).toBe(true)
    expect(pidAlive(Number(readFileSync(PIDFILE, 'utf-8')))).toBe(false)
    // SIGINT first: the whisper's own finally ran and deleted its temp .ogg (SIGKILL alone left it behind)
    expect(existsSync(readFileSync(MARK, 'utf-8'))).toBe(false)
  })

  it('a whisper that ignores SIGINT is SIGKILLed after the 5 s grace, and the answer is the same notice', async () => {
    fakeWhisper('stubborn')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const c = await call('GET', directivePath)
    for (let i = 0; i < 300 && !existsPid(); i++) await realSleep(10)
    expect(existsPid()).toBe(true)
    const pid = Number(readFileSync(PIDFILE, 'utf-8'))
    await vi.advanceTimersByTimeAsync(V.STT_DIRECTIVE_CEILING_MS + 1)
    await realSleep(200)
    expect(pidAlive(pid)).toBe(true) // SIGINT ignored, still inside the grace
    expect(c.out.status).toBe(0)
    await vi.advanceTimersByTimeAsync(V.STT_KILL_GRACE_MS)
    vi.useRealTimers()
    const r = await c.done
    expect(r.body.stt_notice).toBe(sttTimeoutNotice(900, FILE_ID))
    expect(pidAlive(pid)).toBe(false)
  })

  it('/api/voice/stt: the same timeout is a 504 carrying the notice', async () => {
    fakeWhisper('slow')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const c = await call('POST', '/api/voice/stt', { file_id: FILE_ID, state_dir: fake.stateDir })
    for (let i = 0; i < 200 && !existsPid(); i++) await realSleep(10)
    await vi.advanceTimersByTimeAsync(V.STT_TIMEOUT_MS + 1)
    vi.useRealTimers()
    const r = await c.done
    expect(r.status).toBe(504)
    expect(r.body.stt_notice).toBe(sttTimeoutNotice(900, FILE_ID))
  })

  it('the hook prints the server\'s notice when there is no transcript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'voice-hook-root-'))
    try {
      mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true })
      mkdirSync(join(root, 'store'), { recursive: true })
      mkdirSync(join(root, 'agents', 'dex'), { recursive: true })
      copyFileSync(join(REPO, 'scripts', 'hooks', 'voice-reply-directive.py'), join(root, 'scripts', 'hooks', 'voice-reply-directive.py'))
      writeFileSync(join(root, 'store', '.dashboard-token'), 'test-token-short')
      const notice = sttTimeoutNotice(900, FILE_ID)
      const seen: string[] = []
      const server = http.createServer((req, res) => {
        seen.push(req.url ?? '')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ directive: null, transcript: null, stt_notice: notice }))
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
      const port = (server.address() as { port: number }).port
      try {
        const payload = { prompt: `<channel source="telegram" chat_id="12345" attachment_kind="voice" attachment_file_id="${FILE_ID}">(voice)</channel>`, cwd: join(root, 'agents', 'dex') }
        const out = await runHook(join(root, 'scripts', 'hooks', 'voice-reply-directive.py'), payload, { WEB_PORT: String(port) })
        expect(out.code).toBe(0)
        expect(seen).toHaveLength(1)
        expect(out.stdout).toBe(`\n${notice}\n`)
      } finally {
        await new Promise<void>((r) => server.close(() => r()))
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// Ron 18424 item 2: the whisper pidfile (pid + argv) exists exactly while a whisper runs, and on startup an
// orphan a previous dashboard left running is stopped while the whisper slot is held, so no new whisper runs
// next to it.
describe('the whisper pidfile and the startup reap of an orphan', () => {
  afterEach(() => { vi.useRealTimers() })
  const tail = () => [join(VOICE_DIR, '_vtools.py'), 'transcribe', FILE_ID, fake.stateDir]

  it('the running whisper is recorded with its pid and argv, and the record goes when it ends', async () => {
    fakeWhisper('slow')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const c = await call('GET', directivePath)
    for (let i = 0; i < 200 && !existsPid(); i++) await realSleep(10)
    const rec = JSON.parse(readFileSync(STORE_PIDFILE, 'utf-8'))
    expect(rec).toEqual({ pid: Number(readFileSync(PIDFILE, 'utf-8')), argv: [FAKE_PY, ...tail()] })
    await vi.advanceTimersByTimeAsync(V.STT_DIRECTIVE_CEILING_MS + 1)
    vi.useRealTimers()
    await c.done
    expect(existsSync(STORE_PIDFILE)).toBe(false)
    fakeWhisper({ text: 'kész' })
    expect((await (await call('GET', directivePath)).done).body.transcript).toBe('kész')
    expect(existsSync(STORE_PIDFILE)).toBe(false)
  })

  it('startup: the orphan is stopped (SIGINT, its finally ran) before the next whisper caller runs', async () => {
    fakeWhisper('slow')
    const orphan = spawn(FAKE_PY, tail(), { stdio: 'ignore' })
    for (let i = 0; i < 300 && !existsPid(); i++) await realSleep(10)
    const pid = orphan.pid!
    expect(Number(readFileSync(PIDFILE, 'utf-8'))).toBe(pid)
    const tmpOgg = readFileSync(MARK, 'utf-8')
    writeWhisperPidfile(STORE_PIDFILE, pid, [FAKE_PY, ...tail()]) // what the dead dashboard had recorded
    expect(defaultWhisperReapDeps.readArgv(pid)).not.toBeNull() // positive control: it runs as a whisper now
    try {
      const reap = V.reapOrphanWhisperOnStartup()
      const seen = await V.runWhisperExclusive(20_000, async () => ({ argv: defaultWhisperReapDeps.readArgv(pid), ogg: existsSync(tmpOgg) }), () => null)
      expect(await reap).toBe('killed')
      expect(seen).toEqual({ argv: null, ogg: false })
      expect(existsSync(STORE_PIDFILE)).toBe(false)
    } finally {
      orphan.kill('SIGKILL')
    }
  })

  it('web.ts queues the reap before the router starts, on the live instance only', () => {
    const web = readFileSync(join(REPO, 'src', 'web.ts'), 'utf-8')
    const reapAt = web.indexOf('if (!servicesOff) void reapOrphanWhisperOnStartup()')
    expect(reapAt).toBeGreaterThan(0)
    expect(reapAt).toBeLessThan(web.indexOf('startMessageRouter()'))
  })
})

function existsPid(): boolean {
  try { return readFileSync(PIDFILE, 'utf-8').trim().length > 0 } catch { return false }
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
async function realSleep(ms: number) {
  const end = performance.now() + ms
  while (performance.now() < end) await new Promise((r) => setImmediate(r))
}
function runHook(script: string, payload: unknown, env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn('python3', [script], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } })
    let stdout = ''
    p.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    p.on('close', (code) => resolve({ code, stdout }))
    p.stdin.end(JSON.stringify(payload))
  })
}
