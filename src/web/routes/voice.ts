// /api/voice/* -- central STT and TTS service for the agent fleet.
//
// All endpoints require Bearer auth (enforced by src/web.ts before routing).
// STT: POST /api/voice/stt     -- transcribe a Telegram voice file_id
// TTS: POST /api/voice/tts     -- synthesize text to ogg/opus, send via Telegram sendVoice
// Config: GET/PUT /api/agents/:id/voice-config  (handled in agents.ts; see there)
// Modality: GET /api/voice/modality?agent=X&chat=Y
//           POST /api/voice/modality/set -- set last inbound modality (future plugin hook use)
// Directive: GET /api/voice/directive?agent=X&chat=Y  -- TTS curl string for UserPromptSubmit hook
//
// Security:
//   - voiceModel is whitelisted against KNOWN_VOICE_MODELS (no path traversal)
//   - spawn uses arg-array, shell:false (no shell injection)
//   - file_id validated to Telegram's safe character set before use
//   - state_dir resolved only to known agent channel dirs, never raw user paths

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { KNOWN_VOICE_MODELS, AGENTS_BASE_DIR, readAgentVoiceConfig } from '../agent-config.js'
import { getLastInboundModality, setLastInboundModality } from '../voice-modality.js'
import { buildTtsDirective, resolveAgentChannelStateDir, inboundIsAudio, sttTimeoutNotice } from '../voice-directive.js'
import { PROJECT_ROOT, MARVEEN_STT_TIMEOUT_MS_RAW } from '../../config.js'
import type { RouteContext } from './types.js'

const VOICE_DIR = join(homedir(), '.local', 'share', 'marveen-voice')
const VTOOLS_PY = join(VOICE_DIR, '_vtools.py')
const VENV_PY = join(VOICE_DIR, 'venv', 'bin', 'python')

// STT wall-clock budget (card 58b9aa06). History: 60 s silently dropped every note over ~2 min (2026-09-18,
// faster-whisper "small"); 160 s covered ~3.5 min of audio on that model. Whisper large-v3 (the owner's choice,
// Roland TG 3875) is far slower on this CPU box: measured 2026-11-20 (Johnny, 10 threads, 47 s of audio) load 11 s
// warm / 43 s cold, transcribe 85 s, wall 97 s, peak RSS 4.1 GB -- about 1.8x the audio length plus the load. The
// default 900 s therefore covers 45 s + 1.8 x ~475 s: a voice note of about 7-8 minutes, cold.
// MARVEEN_STT_TIMEOUT_MS overrides it (whole milliseconds, 30 s .. 1 h); anything else keeps the default and says so.
//
// The budget counts from the moment a caller ASKS for a transcription, so the wait for the single whisper slot
// (runWhisperExclusive, below) is part of it: a caller is never kept longer than its budget in total.
//
// THE HOOK PATH HAS A STRICTLY INCREASING CHAIN OF BOUNDS, innermost first:
//   STT_DIRECTIVE_CEILING_MS 900 s (+ STT_KILL_GRACE_MS 5 s)  <  voice-reply-directive.py urlopen 910 s
//                                   <  hook `timeout` 920 s (src/web/hooks/manifest.ts, voice-reply-directive)
// The shortest wins, so if an outer bound were the smallest it would fire first and the agent would see a bare
// socket/hook timeout instead of the server's own timeout notice -- the "vanished with no reason" failure. The
// directive path therefore uses min(STT_TIMEOUT_MS, STT_DIRECTIVE_CEILING_MS): the env can lower it, never push it
// past the chain (the hook process does not see the dashboard's env). Raising one of the three alone changes nothing.
// The router path (message-router.ts) has no outer bound and uses STT_TIMEOUT_MS as is.
export const STT_TIMEOUT_DEFAULT_MS = 900_000
export const STT_TIMEOUT_MIN_MS = 30_000
export const STT_TIMEOUT_MAX_MS = 3_600_000
export const STT_DIRECTIVE_CEILING_MS = 900_000

/** The STT budget from MARVEEN_STT_TIMEOUT_MS: whole milliseconds within [30 s, 1 h], else the 900 s default. */
export function resolveSttTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MARVEEN_STT_TIMEOUT_MS
  if (raw === undefined || raw.trim() === '') return STT_TIMEOUT_DEFAULT_MS
  const v = /^\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : NaN
  if (!Number.isInteger(v) || v < STT_TIMEOUT_MIN_MS || v > STT_TIMEOUT_MAX_MS) {
    logger.warn({ value: raw.slice(0, 40), defaultMs: STT_TIMEOUT_DEFAULT_MS }, `MARVEEN_STT_TIMEOUT_MS must be whole milliseconds between ${STT_TIMEOUT_MIN_MS} and ${STT_TIMEOUT_MAX_MS}; using the default`)
    return STT_TIMEOUT_DEFAULT_MS
  }
  return v
}
export const STT_TIMEOUT_MS = resolveSttTimeoutMs({ MARVEEN_STT_TIMEOUT_MS: MARVEEN_STT_TIMEOUT_MS_RAW })

// Telegram file_ids are base64url + some punctuation; reject anything else.
const SAFE_FILE_ID_RE = /^[A-Za-z0-9_\-]{10,200}$/

// Known agent channel dirs -- only these are accepted as state_dir.
// The channel plugin stores its .env (bot token) here.
const CHANNELS_BASE = join(homedir(), '.claude', 'channels')
// Install-scoped main-agent base (#915): <install>/.claude/channels/<provider>.
const INSTALL_CHANNELS_BASE = join(PROJECT_ROOT, '.claude', 'channels')

// Safe paths: ~/.claude/channels/<provider>/, <install>/.claude/channels/<provider>/
// OR <AGENTS_BASE_DIR>/<name>/.claude/channels/<provider>/
// All must contain a .env file. '..' traversal always rejected.
function isSafeStateDir(dir: string): boolean {
  const resolved = dir.replace(/\/$/, '')
  if (resolved.includes('..')) return false
  if (!existsSync(join(resolved, '.env'))) return false
  if (resolved.startsWith(CHANNELS_BASE + '/') || resolved === CHANNELS_BASE) return true
  if (resolved.startsWith(INSTALL_CHANNELS_BASE + '/') || resolved === INSTALL_CHANNELS_BASE) return true
  if (resolved.startsWith(AGENTS_BASE_DIR + '/')) {
    // Must match: <AGENTS_BASE_DIR>/<agentName>/.claude/channels/<provider>
    const rel = resolved.slice(AGENTS_BASE_DIR.length + 1)
    return /^[a-zA-Z0-9_-]+\/\.claude\/channels\/[a-zA-Z0-9_-]+$/.test(rel)
  }
  return false
}

function voiceOnnxPath(model: string): string | null {
  if (!KNOWN_VOICE_MODELS.has(model)) return null
  const p = join(VOICE_DIR, 'voices', `${model}.onnx`)
  return existsSync(p) ? p : null
}

function isVoiceInstalled(): boolean {
  return existsSync(VENV_PY) && existsSync(VTOOLS_PY)
}

// Grace between SIGINT and SIGKILL for a timed-out whisper (card 58b9aa06, Johnny 18334). Python runs its finally
// blocks on SIGINT (KeyboardInterrupt) but NOT on SIGTERM (measured 2026-11-20: SIGTERM rc 143, finally skipped;
// SIGINT rc 130, finally ran), and _vtools.py deletes its downloaded temp .ogg in a finally. SIGKILL alone left an
// orphan file in /tmp per timeout. The grace keeps the hook chain: 900 s + 5 s < urlopen 910 s.
export const STT_KILL_GRACE_MS = 5_000

function runProc(
  cmd: string,
  args: string[],
  opts: { stdinData?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; interruptGraceMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { shell: false, ...(opts.env ? { env: opts.env } : {}) })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let graceTimer: NodeJS.Timeout | null = null
    const onTimeout = () => {
      timedOut = true
      if (opts.interruptGraceMs === undefined) { proc.kill('SIGKILL'); return }
      proc.kill('SIGINT')
      graceTimer = setTimeout(() => { proc.kill('SIGKILL') }, opts.interruptGraceMs)
    }
    const timer = opts.timeoutMs ? setTimeout(onTimeout, opts.timeoutMs) : null
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    if (opts.stdinData != null) { proc.stdin.write(opts.stdinData, 'utf-8'); proc.stdin.end() }
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      resolve({ stdout, stderr, code: code ?? 1, timedOut })
    })
  })
}

// Concurrency guard: prevents parallel installs racing on the same venv/DEST.
let _installInProgress = false

// ONE whisper process at a time, process-wide (card 58b9aa06). large-v3 peaks at 4.1 GB RSS (measured 2026-11-20),
// and the router and the directive route could otherwise start one each. Callers queue in arrival order. The wait
// counts against the caller's budget: a caller whose budget runs out while queued gets 'timeout' without running,
// and its place in the queue is released as soon as it is reached, so it never holds the next caller.
let whisperTail: Promise<void> = Promise.resolve()
export async function runWhisperExclusive<T>(budgetMs: number, run: (remainingMs: number) => Promise<T>, onTimeout: () => T): Promise<T> {
  const deadline = Date.now() + budgetMs
  let release!: () => void
  const mine = new Promise<void>((r) => { release = r })
  const turn = whisperTail
  whisperTail = turn.then(() => mine)
  let timer: NodeJS.Timeout | undefined
  const waited = await Promise.race([
    turn.then(() => true),
    new Promise<false>((r) => { timer = setTimeout(() => r(false), Math.max(0, budgetMs)) }),
  ])
  if (timer) clearTimeout(timer)
  if (!waited) {
    void turn.then(release)
    return onTimeout()
  }
  try {
    const remaining = deadline - Date.now()
    return remaining > 0 ? await run(remaining) : onTimeout()
  } finally {
    release()
  }
}

/** For tests only: forget the queue (a test that leaves a slot held would block the next file's callers). */
export function _resetWhisperQueueForTest(): void { whisperTail = Promise.resolve() }

export type SttOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: 'timeout'; budgetS: number }
  | { ok: false; reason: 'failed' | 'unavailable' }

async function transcribeWithin(fileParam: string, stateDir: string, budgetMs: number): Promise<SttOutcome> {
  const budgetS = Math.round(budgetMs / 1000)
  return runWhisperExclusive<SttOutcome>(budgetMs, async (remainingMs) => {
    const result = await runProc(VENV_PY, [VTOOLS_PY, 'transcribe', fileParam, stateDir], { timeoutMs: remainingMs, interruptGraceMs: STT_KILL_GRACE_MS })
    if (result.timedOut) {
      logger.warn({ fileParam, budgetS }, 'STT timed out: whisper killed at the budget')
      return { ok: false, reason: 'timeout', budgetS }
    }
    if (result.code !== 0) {
      logger.warn({ fileParam, stderr: result.stderr.slice(0, 200) }, 'STT failed: whisper exited non-zero')
      return { ok: false, reason: 'failed' }
    }
    // An empty transcript stays ok:true with '' (unchanged: the callers treat '' as "no transcript").
    return { ok: true, text: result.stdout.trim() }
  }, () => {
    logger.warn({ fileParam, budgetS }, 'STT timed out: the budget ran out while waiting for the whisper slot')
    return { ok: false, reason: 'timeout', budgetS }
  })
}

// Transcribe a Telegram voice file via the local whisper toolkit. This is the
// single in-process entry point for STT -- both the /api/voice/stt route AND
// the message-router call it DIRECTLY. The router must never self-HTTP to
// /api/voice/stt: a process HTTP-calling its own dashboard from the 5s tick
// coupled message delivery to the HTTP server and, under sustained voice
// traffic, threw the event loop (progressive /api/agents latency 73ms -> 12s ->
// timeout). The router no longer awaits this on its tick either (card 58b9aa06):
// it starts the call and delivers the row on a later tick. The whisper
// subprocess keeps its STT_TIMEOUT_MS budget (slot wait included).
export async function transcribeVoiceFileOutcome(fileId: string, stateDir: string): Promise<SttOutcome> {
  if (!isVoiceInstalled()) return { ok: false, reason: 'unavailable' }
  if (!SAFE_FILE_ID_RE.test(fileId)) return { ok: false, reason: 'unavailable' }
  if (!isSafeStateDir(stateDir)) return { ok: false, reason: 'unavailable' }
  return transcribeWithin(fileId, stateDir, STT_TIMEOUT_MS)
}

/** The transcript, or null on any failure (kept for callers that need no reason). */
export async function transcribeVoiceFile(fileId: string, stateDir: string): Promise<string | null> {
  const o = await transcribeVoiceFileOutcome(fileId, stateDir)
  return o.ok ? o.text : null
}

/**
 * Package-manager command for the missing system dependencies, per host
 * platform. The command has to match the host: apt-get does not exist on macOS,
 * where the dashboard also runs, and a command the user cannot run is worse
 * than no suggestion -- it reads as authoritative. Homebrew ships venv inside
 * its `python` formula, so there is no python3-venv counterpart to name there.
 */
export function systemDepsInstallCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin'
    ? 'brew install ffmpeg python'
    : 'sudo apt-get install -y --no-install-recommends ffmpeg python3-venv python3'
}

export async function tryHandleVoice(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // GET /api/voice/directive?agent=X&chat=Y[&file=FILE_ID]
  // Returns { directive: string|null, transcript: string|null }.
  // directive semantics by responseMode:
  //   text  -> null (never speaks)
  //   voice -> always buildTtsDirective (speaks even for plain-text input)
  //   auto  -> buildTtsDirective only when the inbound attachment kind is audio
  //            (voice/audio/video_note). A document or photo attachment does NOT speak.
  // transcript: STT result when the attachment is audio and the id is valid (mode-independent --
  //   even text-mode agents benefit from knowing what a voice message said). Non-audio
  //   attachments are never pushed through speech-to-text.
  // fail-safe: STT errors set transcript=null; directive is always attempted independently.
  if (path === '/api/voice/directive' && method === 'GET') {
    const agentId = ctx.url.searchParams.get('agent') ?? ''
    const chatId = ctx.url.searchParams.get('chat') ?? ''
    const fileParam = ctx.url.searchParams.get('file') ?? ''
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) { json(res, { error: 'Invalid agent' }, 400); return true }
    if (!chatId || !/^\d+$/.test(chatId)) { json(res, { error: 'Invalid chat_id' }, 400); return true }
    const voiceCfg = readAgentVoiceConfig(agentId)
    const stateDir = resolveAgentChannelStateDir(agentId, 'telegram')
    const kindParam = ctx.url.searchParams.get('kind') ?? ''
    const fileIdOk = !!fileParam && SAFE_FILE_ID_RE.test(fileParam)
    // Audio is decided by the declared attachment kind, never by the mere
    // presence of a file id -- a document attachment is not a voice message.
    const inboundWasAudio = fileIdOk && inboundIsAudio(kindParam, fileParam)
    const ttsParams = { chatId, stateDir, voiceModel: voiceCfg.voiceModel ?? 'hu_HU-imre-medium' }
    const directive = voiceCfg.responseMode === 'text' ? null
      : voiceCfg.responseMode === 'voice' ? buildTtsDirective(ttsParams)
      : inboundWasAudio ? buildTtsDirective(ttsParams)  // auto: only when inbound was audio
      : null

    // stt_notice: a line the hook prints as is when the transcription timed out (never silent, card 58b9aa06).
    let transcript: string | null = null
    let sttNotice: string | null = null
    if (inboundWasAudio && isVoiceInstalled()) {
      const outcome = await transcribeWithin(fileParam, stateDir, Math.min(STT_TIMEOUT_MS, STT_DIRECTIVE_CEILING_MS))
      if (outcome.ok) {
        transcript = outcome.text || null
      } else if (outcome.reason === 'timeout') {
        sttNotice = sttTimeoutNotice(outcome.budgetS, fileParam)
      } else {
        logger.warn({ fileParam }, '/api/voice/directive: STT failed (non-fatal)')
      }
    }

    json(res, { directive, transcript, stt_notice: sttNotice })
    return true
  }

  // GET /api/voice/modality?agent=X&chat=Y
  // Returns the last inbound modality for this agent+chat (for the channel plugin).
  if (path === '/api/voice/modality' && method === 'GET') {
    const agentId = ctx.url.searchParams.get('agent') ?? ''
    const chatId = ctx.url.searchParams.get('chat') ?? ''
    if (!agentId || !chatId) { json(res, { error: 'agent and chat required' }, 400); return true }
    const modality = getLastInboundModality(agentId, chatId)
    json(res, { modality })
    return true
  }

  // POST /api/voice/modality/set
  // Body: { agent_id: string, chat_id: string, modality: 'voice'|'text' }
  // TODO: currently unused -- message-router sets modality in-process via setLastInboundModality().
  // Kept for future use if a channel plugin fork needs to set modality over HTTP.
  if (path === '/api/voice/modality/set' && method === 'POST') {
    const body = await readBody(req)
    let data: { agent_id?: string; chat_id?: string; modality?: string }
    try { data = JSON.parse(body.toString()) as typeof data } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const agentId = data.agent_id?.trim() ?? ''
    const chatId = data.chat_id?.trim() ?? ''
    const modality = data.modality?.trim() ?? ''
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) { json(res, { error: 'Invalid agent_id' }, 400); return true }
    if (!chatId || !/^\d+$/.test(chatId)) { json(res, { error: 'Invalid chat_id' }, 400); return true }
    if (modality !== 'voice' && modality !== 'text') { json(res, { error: 'modality must be voice or text' }, 400); return true }
    setLastInboundModality(agentId, chatId, modality as 'voice' | 'text')
    json(res, { ok: true })
    return true
  }

  // GET /api/voice/status -- is the voice toolkit installed?
  if (path === '/api/voice/status' && method === 'GET') {
    const installed = isVoiceInstalled()
    const voices = installed
      ? Array.from(KNOWN_VOICE_MODELS).filter((m) => existsSync(join(VOICE_DIR, 'voices', `${m}.onnx`)))
      : []
    json(res, { installed, voices, voiceDir: VOICE_DIR })
    return true
  }

  // POST /api/voice/stt
  // Body: { file_id: string, state_dir: string }
  // Returns: { transcript: string }
  if (path === '/api/voice/stt' && method === 'POST') {
    if (!isVoiceInstalled()) { json(res, { error: 'Voice toolkit not installed' }, 503); return true }
    const body = await readBody(req)
    let data: { file_id?: string; state_dir?: string }
    try { data = JSON.parse(body.toString()) as typeof data } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const fileId = data.file_id?.trim() ?? ''
    const stateDir = data.state_dir?.trim() ?? ''
    if (!SAFE_FILE_ID_RE.test(fileId)) { json(res, { error: 'Invalid file_id' }, 400); return true }
    if (!isSafeStateDir(stateDir)) { json(res, { error: 'Invalid state_dir' }, 400); return true }

    const outcome = await transcribeVoiceFileOutcome(fileId, stateDir)
    if (!outcome.ok && outcome.reason === 'timeout') {
      json(res, { error: 'STT timed out', stt_notice: sttTimeoutNotice(outcome.budgetS, fileId) }, 504)
      return true
    }
    if (!outcome.ok) {
      logger.warn({ fileId }, '/api/voice/stt: whisper failed')
      json(res, { error: 'STT failed' }, 500)
      return true
    }
    json(res, { transcript: outcome.text })
    return true
  }

  // POST /api/voice/tts
  // Body: { text: string, voice_model: string, chat_id: string, state_dir: string }
  // Returns: { ok: boolean, message_id?: number }
  if (path === '/api/voice/tts' && method === 'POST') {
    if (!isVoiceInstalled()) { json(res, { error: 'Voice toolkit not installed' }, 503); return true }
    const body = await readBody(req)
    let data: { text?: string; voice_model?: string; chat_id?: string | number; state_dir?: string }
    try { data = JSON.parse(body.toString()) as typeof data } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const text = data.text?.trim() ?? ''
    const voiceModel = data.voice_model?.trim() ?? 'hu_HU-imre-medium'
    const chatId = String(data.chat_id ?? '').trim()
    const stateDir = data.state_dir?.trim() ?? ''

    if (!text) { json(res, { error: 'text required' }, 400); return true }
    if (!/^\d+$/.test(chatId)) { json(res, { error: 'Invalid chat_id' }, 400); return true }
    if (!isSafeStateDir(stateDir)) { json(res, { error: 'Invalid state_dir' }, 400); return true }

    const onnxPath = voiceOnnxPath(voiceModel)
    if (!onnxPath) {
      json(res, { error: `Unknown or missing voice model: ${voiceModel}` }, 400)
      return true
    }

    const result = await runProc(
      VENV_PY,
      [VTOOLS_PY, 'speak', onnxPath, stateDir, chatId, text],
      // The installed toolkit lives outside the install tree; tell it which
      // install it serves so it can find the conversation ledger.
      { timeoutMs: 90_000, env: { ...process.env, MARVEEN_INSTALL_DIR: PROJECT_ROOT } },
    )
    if (result.code !== 0) {
      logger.warn({ voiceModel, chatId, stderr: result.stderr }, '/api/voice/tts: piper/sendVoice failed')
      json(res, { error: 'TTS failed', detail: result.stderr.slice(0, 200) }, 500)
      return true
    }
    // _vtools.py prints "ok=True id=12345" or "ok=False id=None"
    const okMatch = result.stdout.match(/ok=(\w+)/)
    const idMatch = result.stdout.match(/id=(\d+)/)
    json(res, {
      ok: okMatch?.[1]?.toLowerCase() === 'true',
      message_id: idMatch ? parseInt(idMatch[1], 10) : null,
    })
    return true
  }

  // POST /api/voice/install
  // Checks system dependencies (ffmpeg + python3-venv). If missing: returns
  // { needsSudo: true, sudoCommand } so the user can run it manually. If deps
  // are present, spawns install-voice.sh with SKIP_SYSTEM_DEPS=1 (no root
  // needed) and returns immediately; the client polls /api/voice/status.
  if (path === '/api/voice/install' && method === 'POST') {
    if (isVoiceInstalled()) {
      json(res, { ok: true, alreadyInstalled: true })
      return true
    }

    // Check system deps without root
    const depCheck = await runProc('bash', ['-c',
      'command -v ffmpeg >/dev/null 2>&1' +
      ' && ffmpeg -encoders 2>&1 | grep -q libopus' +
      ' && python3 -m venv --help >/dev/null 2>&1' +
      ' && echo OK || echo MISSING',
    ], { timeoutMs: 8000 })
    const depsMissing = !depCheck.stdout.trim().endsWith('OK')

    if (depsMissing) {
      json(res, { needsSudo: true, sudoCommand: systemDepsInstallCommand() })
      return true
    }

    if (_installInProgress) {
      json(res, { ok: true, started: true, alreadyRunning: true })
      return true
    }

    // Deps present -- fire-and-forget the install (no root needed from here).
    // detached:true + unref() keeps the child alive even if the dashboard
    // restarts mid-install (pip + ~126 MB download can take several minutes).
    _installInProgress = true
    const scriptPath = join(PROJECT_ROOT, 'scripts', 'install-voice.sh')
    const child = spawn('bash', [scriptPath], {
      shell: false,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, SKIP_SYSTEM_DEPS: '1' },
    })
    child.unref()
    child.on('error', (err) => { _installInProgress = false; logger.warn({ err }, '/api/voice/install: spawn error') })
    child.on('close', (code) => {
      _installInProgress = false
      if (code !== 0) logger.warn({ code }, '/api/voice/install: install-voice.sh exited non-zero')
      else logger.info('/api/voice/install: install-voice.sh completed successfully')
    })

    json(res, { ok: true, started: true })
    return true
  }

  return false
}
