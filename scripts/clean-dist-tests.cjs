#!/usr/bin/env node
// Remove a stale dist/__tests__ before the build (B2-2b).
//
// WHY. Until B2-2b `npm run build` compiled src/__tests__ into dist/__tests__
// (967 files, 8.3 MB on the live install, measured 2026-11-05). The build now uses
// tsconfig.build.json, which leaves the tests out, but tsc never wipes its
// outDir: an install built before this change keeps the old copies forever.
// vitest already excludes dist/** (vitest-excludes-build-output.test.ts), so
// they are dead weight, not a correctness problem -- this removes them once.
//
// LIMITS (Kevin 11980), each one pinned in dist-no-tests.test.ts:
//   - The path comes from this script's own location (<root>/scripts/..),
//     never from env or cwd.
//   - Only exactly <root>/dist/__tests__, and only when dist and
//     dist/__tests__ are both REAL directories (lstat, no symlink follow):
//     a symlinked dist or dist/__tests__ is left alone, with one line on stderr.
//   - Nothing else is touched. Missing dist or dist/__tests__: nothing to do.
//   - Never fails the build: any error is reported on stderr and exit is 0
//     (the leftovers are harmless; a build must not stop over them).
'use strict'
const { lstatSync, rmSync } = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const distDir = path.join(root, 'dist')
const target = path.join(distDir, '__tests__')

function kind(p) {
  try {
    const st = lstatSync(p)
    if (st.isSymbolicLink()) return 'symlink'
    return st.isDirectory() ? 'dir' : 'other'
  } catch {
    return 'missing'
  }
}

try {
  const d = kind(distDir)
  const t = d === 'dir' ? kind(target) : 'missing'
  if (d === 'symlink' || t === 'symlink' || t === 'other') {
    process.stderr.write(`clean-dist-tests: left alone, not a real directory: ${d === 'symlink' ? distDir : target}\n`)
  } else if (t === 'dir') {
    rmSync(target, { recursive: true, force: true })
  }
} catch (e) {
  process.stderr.write(`clean-dist-tests: not removed (${e && e.code ? e.code : e}): ${target}\n`)
}
