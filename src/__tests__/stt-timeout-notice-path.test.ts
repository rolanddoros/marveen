// Ron 18424 item 3: the STT timeout notice's retry command is an ABSOLUTE path under the install root (a sub-agent's
// cwd is agents/<name>, where a relative scripts/voice/stt.sh does not exist). An install root outside the
// shell-safe character set is single-quoted, so the line still works when pasted.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const root = vi.hoisted(() => ({ value: '' }))
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  get PROJECT_ROOT() { return root.value },
}))

async function notice(projectRoot: string) {
  root.value = projectRoot
  vi.resetModules()
  const { sttTimeoutNotice, STT_RETRY_SCRIPT } = await import('../web/voice-directive.js')
  return { line: sttTimeoutNotice(900, 'AwACAgIAAxkBAAIBc2'), script: STT_RETRY_SCRIPT }
}

describe('sttTimeoutNotice retry path', () => {
  beforeEach(() => { root.value = '' })

  it('is absolute under the install root', async () => {
    const { line, script } = await notice('/opt/marveen')
    expect(script).toBe('/opt/marveen/scripts/voice/stt.sh')
    expect(line).toBe('[Hang átirat]: időtúllépés, 900 s alatt nem készült el az átirat (transcription timed out). ' +
      'Kézi újrapróbálás: /opt/marveen/scripts/voice/stt.sh AwACAgIAAxkBAAIBc2')
  })

  it('single-quotes a root with a space or a quote', async () => {
    expect((await notice('/Users/r/My Marveen')).line.endsWith(`Kézi újrapróbálás: '/Users/r/My Marveen/scripts/voice/stt.sh' AwACAgIAAxkBAAIBc2`)).toBe(true)
    expect((await notice(`/srv/rol's`)).line.endsWith(`Kézi újrapróbálás: '/srv/rol'\\''s/scripts/voice/stt.sh' AwACAgIAAxkBAAIBc2`)).toBe(true)
  })
})
