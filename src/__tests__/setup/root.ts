// ROOT-ONLY TEST CASES (B2-1). Root ignores file modes: after chmod 0555 / 0444 / 000 / a-w, root still writes, moves
// and reads. A case whose point is that a permission denial is handled (EACCES, "cannot write", an unreadable file)
// therefore cannot fail the way it means to when the suite runs as root, as it does on this host's sealed runs. It
// failed there with a confusing message ("expected [Function] to throw"), every run.
//
// itUnlessRoot SKIPS such a case under root: a counted skip in the report, never a silent pass (an early `return` in
// the test body would show as passed and measure nothing). Use it ONLY for the permission-denial case itself; keep
// the rest of the test (what is written, the modes, the cleanup) in a plain `it`, so it still runs as root.
//
// Not a setupFile: imported where needed, like node-abi.ts.
import { it } from 'vitest'

export const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

export const itUnlessRoot = it.skipIf(IS_ROOT)
