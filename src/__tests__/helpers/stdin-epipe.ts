import type { Writable } from 'node:stream'

/**
 * Write `input` to a child's stdin and close it, for a child that may exit
 * before it reads its stdin (an early-exit path of the script under test).
 *
 * Writing into a pipe whose reader has gone fails with EPIPE. Without an
 * 'error' listener that is an unhandled stream error: the test itself passes,
 * but vitest counts an unhandled error and the run exits 1 (fork PR #13, CI
 * run 42094896572: 17829 tests passed, exit 1, from token-off-argv-scripts'
 * migrate.sh "no token file" case). The child's exit code and output are what
 * the test asserts on, so the lost input is not a failure in itself.
 *
 * Only EPIPE is swallowed. Any other stdin error is rethrown, so a real fault
 * (EBADF, a bug in the stream) still fails the run loudly.
 */
export function endStdin(child: { stdin?: Writable | null }, input?: string): void {
  const stdin = child.stdin
  if (!stdin) return
  stdin.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err
  })
  if (input === undefined) stdin.end()
  else stdin.end(input)
}
