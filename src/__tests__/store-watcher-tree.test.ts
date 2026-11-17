// WHY THIS FILE EXISTS: the store watcher was ONE recursive fs.watch on store/.
// On Linux Node builds a recursive watch in JavaScript, folder by folder, so its
// cost follows the whole tree. On 2026-11-17 store/ held ~53 700 inodes (Chrome
// profiles under browser/, test scratch trees under fork-audit/), the dashboard
// held 53 359 inotify watches, and its event loop stalled for up to 60 s, at boot
// and twice within an hour (CPU profile: 46% watchFolder, 23% path.join, 22%
// readdir). The watcher now puts one NON-recursive watch on each directory it
// walks, never below the top level of a machine-written tree (browser/,
// fork-audit/, ci-runner/), never more than MAX_WATCHED_DIRS, and it watches a
// directory created later with a bounded number of audit rows for what is in it.
// The watch is mocked and every call recorded per directory; the tree is real.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface WatchCall {
  dir: string
  opts: unknown
  cb: (eventType: string, filename: string | null) => void
  w: { close: ReturnType<typeof vi.fn>; emit: (event: string, ...args: unknown[]) => boolean }
}

const h = vi.hoisted(() => ({
  dir: `${process.env.TMPDIR || '/tmp'}/marveen-store-watcher-tree-test-${process.pid}`,
  calls: [] as WatchCall[],
  /** Absolute directory -> the error its watch() call throws synchronously. */
  throwFor: new Map<string, Error>(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { EventEmitter } = await import('node:events')
  const { vi: v } = await import('vitest')
  const watch = ((dir: string, opts: unknown, cb: WatchCall['cb']) => {
    const err = h.throwFor.get(dir)
    if (err) throw err
    const w = Object.assign(new EventEmitter(), { close: v.fn() })
    h.calls.push({ dir, opts, cb, w })
    return w
  }) as unknown as typeof actual.watch
  return { ...actual, watch, default: { ...actual, watch } }
})

vi.mock('../config.js', () => ({ STORE_DIR: h.dir }))
vi.mock('../db.js', () => ({ logStoreFileEvent: vi.fn() }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { setStoreWriteActor, startStoreWatcher, stopStoreWatcher } from '../store-watcher.js'
import { logStoreFileEvent } from '../db.js'
import { logger } from '../logger.js'

const at = (...parts: string[]): string => join(h.dir, ...parts)
const file = (rel: string, body = 'x'): void => {
  mkdirSync(join(h.dir, rel, '..'), { recursive: true })
  writeFileSync(at(rel), body)
}
/** The store-relative directories that got a watch, '' for store/ itself. */
const watched = (): string[] =>
  h.calls.map(c => (c.dir === h.dir ? '' : c.dir.slice(h.dir.length + 1))).sort()
/** The callback of the watch on one store-relative directory. */
const cbOf = (rel: string): WatchCall['cb'] => {
  const call = h.calls.find(c => c.dir === (rel === '' ? h.dir : at(rel)))
  if (!call) throw new Error(`no watch on ${rel || 'store/'}`)
  return call.cb
}
const loggedPaths = (): string[] => vi.mocked(logStoreFileEvent).mock.calls.map(c => c[0]).sort()
const warned = (message: string) => vi.mocked(logger.warn).mock.calls.filter(c => c[1] === message)

/** The fixture: three machine-written trees, deep, beside two ordinary folders. */
function buildStore(): void {
  rmSync(h.dir, { recursive: true, force: true })
  mkdirSync(h.dir, { recursive: true })
  for (let p = 0; p < 4; p++) {
    for (let c = 0; c < 50; c++) file(`browser/profile-${p}/Default/Cache/c${c}/f`)
  }
  file('browser/bella.vncpass')
  for (let s = 0; s < 100; s++) file(`fork-audit/scratch-${s}/node_modules/pkg/index.js`)
  file('fork-audit/PLAN.md')
  file('ci-runner/notes/run.md')
  file('agent-taskstate/stuart/state.json')
  file('notes/todo.md')
  file('top.json')
}

beforeEach(() => {
  buildStore()
  h.calls.length = 0
  h.throwFor.clear()
  vi.mocked(logStoreFileEvent).mockClear()
  vi.mocked(logger.warn).mockClear()
  vi.mocked(logger.info).mockClear()
})

afterEach(() => {
  stopStoreWatcher()
})

afterAll(() => {
  rmSync(h.dir, { recursive: true, force: true })
})

describe('store-watcher: one non-recursive watch per directory, never inside a machine-written tree', () => {
  it('watches store/, the ordinary folders and only the top level of browser/, fork-audit/ and ci-runner/', () => {
    startStoreWatcher()

    expect(watched()).toEqual([
      '',
      'agent-taskstate',
      'agent-taskstate/stuart',
      'browser',
      'ci-runner',
      'fork-audit',
      'notes',
    ])
    // 400 directories under browser/ and 400 under fork-audit/ in the fixture, none watched.
    expect(h.calls.every(c => (c.opts as { recursive?: boolean }).recursive === false)).toBe(true)
    expect(vi.mocked(logger.info).mock.calls.at(-1)?.[0]).toMatchObject({ watchedDirs: 7 })
  })

  it('knows the files at the top of a machine-written tree, and nothing below it', () => {
    startStoreWatcher()

    // Known at start: an event for them logs nothing.
    cbOf('browser')('rename', 'bella.vncpass')
    cbOf('fork-audit')('rename', 'PLAN.md')
    cbOf('')('rename', 'top.json')
    expect(logStoreFileEvent).not.toHaveBeenCalled()
    // Counted as known: the top-level files and the ordinary folders' files only.
    expect(vi.mocked(logger.info).mock.calls.at(-1)?.[0]).toMatchObject({ knownCount: 5 })
  })

  it('still logs a file an agent creates at the top of fork-audit/ (an audit row nobody loses)', () => {
    startStoreWatcher()
    file('fork-audit/NEW-NOTE.md', 'hello')

    cbOf('fork-audit')('rename', 'NEW-NOTE.md')

    expect(loggedPaths()).toEqual(['fork-audit/NEW-NOTE.md'])
  })

  it('adds no watch and logs nothing for Chrome-cache churn under browser/<profile>/, even with the events in hand (2026-11-17)', () => {
    // Measured on 2026-11-17 (Johnny): every page load in the agent browser
    // (store/browser/johnny-profile) froze the dashboard for 10-30 s. A watch
    // on browser/ alone never hears these paths; the events are fed in anyway,
    // through store/'s watch and browser/'s, as a recursive watch delivered them.
    startStoreWatcher()
    const before = h.calls.length
    for (let i = 0; i < 300; i++) {
      const dir = `browser/johnny-profile/Default/Cache/Cache_Data/d${i % 10}`
      file(`${dir}/f${i}`)
      for (const [cb, name] of [
        [cbOf(''), `${dir}/f${i}`],
        [cbOf('browser'), `${dir.slice('browser/'.length)}/f${i}`],
        [cbOf(''), dir],
      ] as const) cb('rename', name)
      rmSync(at(dir, `f${i}`))
      cbOf('')('rename', `${dir}/f${i}`)
    }
    cbOf('browser')('rename', 'johnny-profile')

    expect(h.calls.length).toBe(before)
    expect(logStoreFileEvent).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
    // Positive control: browser/'s own watch still hears a new file at its top.
    file('browser/margot.vncpass')
    cbOf('browser')('rename', 'margot.vncpass')
    expect(loggedPaths()).toEqual(['browser/margot.vncpass'])
  })

  it('does not watch a directory created later inside a machine-written tree', () => {
    startStoreWatcher()
    const before = h.calls.length
    file('browser/profile-9/Default/Cache/f')

    cbOf('browser')('rename', 'profile-9')

    expect(h.calls.length).toBe(before)
    expect(logStoreFileEvent).not.toHaveBeenCalled()
  })
})

describe('store-watcher: the watch ceiling', () => {
  it('stops at MAX_WATCHED_DIRS for a big tree nobody listed, warns once, and still starts', () => {
    for (let d = 0; d < 2100; d++) mkdirSync(at('bulk', `d${String(d).padStart(4, '0')}`), { recursive: true })

    startStoreWatcher()

    expect(h.calls.length).toBe(2000)
    const ceiling = warned('store-watcher: watch ceiling reached, further directories not watched')
    expect(ceiling).toHaveLength(1)
    expect(ceiling[0][0]).toMatchObject({ max: 2000 })
    expect(vi.mocked(logger.info).mock.calls.at(-1)?.[1]).toBe('Store file watcher started')
  })
})

describe('store-watcher: a directory created after start', () => {
  it('is watched with what is below it, and its files are logged under the actor who wrote them', () => {
    startStoreWatcher()
    file('notes/new/a.txt', 'aa')
    file('notes/new/inner/b.txt', 'bbb')

    setStoreWriteActor('kevin')
    cbOf('notes')('rename', 'new')

    expect(watched()).toEqual(expect.arrayContaining(['notes/new', 'notes/new/inner']))
    expect(loggedPaths()).toEqual(['notes/new/a.txt', 'notes/new/inner/b.txt'])
    for (const call of vi.mocked(logStoreFileEvent).mock.calls) expect(call[4]).toBe('kevin')
    // A later file in the new folder comes through its own watch.
    file('notes/new/inner/c.txt')
    cbOf('notes/new/inner')('rename', 'c.txt')
    expect(loggedPaths()).toContain('notes/new/inner/c.txt')
  })

  it('logs at most 200 of the files a new directory brings, warns once, and knows the rest', () => {
    startStoreWatcher()
    for (let f = 0; f < 250; f++) file(`notes/copied/f${String(f).padStart(3, '0')}.txt`)

    cbOf('notes')('rename', 'copied')

    expect(logStoreFileEvent).toHaveBeenCalledTimes(200)
    const bounded = warned('store-watcher: new directory holds more files than are logged per directory')
    expect(bounded).toHaveLength(1)
    expect(bounded[0][0]).toMatchObject({ dir: 'notes/copied', logged: 200, notLogged: 50, max: 200 })
    // One the bound did not log is known, so its own late event logs nothing.
    cbOf('notes/copied')('rename', 'f249.txt')
    expect(logStoreFileEvent).toHaveBeenCalledTimes(200)
  })

  it('closes the watches of a directory that went away, and watches it again when it comes back', () => {
    startStoreWatcher()
    file('notes/gone/inner/x.txt')
    cbOf('notes')('rename', 'gone')
    const gone = h.calls.filter(c => c.dir === at('notes/gone') || c.dir === at('notes/gone/inner'))
    expect(gone).toHaveLength(2)

    rmSync(at('notes/gone'), { recursive: true, force: true })
    cbOf('notes')('rename', 'gone')
    for (const call of gone) expect(call.w.close).toHaveBeenCalledTimes(1)

    file('notes/gone/again.txt')
    cbOf('notes')('rename', 'gone')
    expect(h.calls.filter(c => c.dir === at('notes/gone'))).toHaveLength(2)
    expect(loggedPaths()).toContain('notes/gone/again.txt')
  })

  it('closes only the gone directory, not a sibling whose name starts with it', () => {
    startStoreWatcher()
    file('notes/gone/x.txt')
    file('notes/gone-2/inner/y.txt')
    cbOf('notes')('rename', 'gone')
    cbOf('notes')('rename', 'gone-2')
    const sibling = h.calls.filter(c => c.dir === at('notes/gone-2') || c.dir === at('notes/gone-2/inner'))
    expect(sibling).toHaveLength(2)

    rmSync(at('notes/gone'), { recursive: true, force: true })
    cbOf('notes')('rename', 'gone')

    expect(h.calls.find(c => c.dir === at('notes/gone'))?.w.close).toHaveBeenCalledTimes(1)
    for (const call of sibling) expect(call.w.close).not.toHaveBeenCalled()
    // Still watched: a new file in the sibling's subfolder is logged.
    file('notes/gone-2/inner/z.txt')
    cbOf('notes/gone-2/inner')('rename', 'z.txt')
    expect(loggedPaths()).toContain('notes/gone-2/inner/z.txt')
  })

  it('stopStoreWatcher closes every watch it opened', () => {
    startStoreWatcher()
    const opened = [...h.calls]

    stopStoreWatcher()

    for (const call of opened) expect(call.w.close).toHaveBeenCalledTimes(1)
  })
})

describe('store-watcher: a watch() call that throws', () => {
  const watchErr = (code: string, path: string) => Object.assign(new Error('watch failed'), { code, path })
  const skipped = () => warned('store-watcher: subdirectory not watchable, skipped')

  it('skips that directory and everything below it, warns once per (code, path), and starts with the rest', () => {
    file('notes/sub/deep.txt')
    h.throwFor.set(at('notes'), watchErr('ENOSPC', at('notes')))
    h.throwFor.set(at('agent-taskstate'), watchErr('EACCES', at('agent-taskstate')))

    expect(() => startStoreWatcher()).not.toThrow()

    // Neither directory nor anything below it is watched or walked.
    expect(watched()).toEqual(['', 'browser', 'ci-runner', 'fork-audit'])
    expect(vi.mocked(logger.info).mock.calls.at(-1)).toEqual([
      expect.objectContaining({ watchedDirs: 4, knownCount: 3 }),
      'Store file watcher started',
    ])
    // readdir order is not fixed: compare sorted by path.
    expect(skipped().map(c => c[0] as { path?: string }).sort((a, b) => String(a.path).localeCompare(String(b.path)))).toEqual([
      { code: 'EACCES', path: at('agent-taskstate') },
      { code: 'ENOSPC', path: at('notes') },
    ])
    // The same (code, path) again, now as a watch 'error' event: not logged twice.
    h.calls[0].w.emit('error', watchErr('ENOSPC', at('notes')))
    expect(skipped()).toHaveLength(2)
    // A later event for the skipped directory tries its watch again: the same throw, no second warning.
    cbOf('')('rename', 'notes')
    expect(watched()).not.toContain('notes')
    expect(skipped()).toHaveLength(2)
    // A directory created later whose watch() throws: no watch, nothing logged, one more warning.
    file('fresh/a.txt')
    h.throwFor.set(at('fresh'), watchErr('ENOSPC', at('fresh')))
    cbOf('')('rename', 'fresh')
    expect(watched()).not.toContain('fresh')
    expect(logStoreFileEvent).not.toHaveBeenCalled()
    expect(skipped()).toHaveLength(3)
  })

  it('reports a failed start when the watch on store/ itself throws', () => {
    h.throwFor.set(h.dir, watchErr('EMFILE', h.dir))

    expect(() => startStoreWatcher()).not.toThrow()

    expect(h.calls).toHaveLength(0)
    expect(warned('Store file watcher failed to start')).toHaveLength(1)
    expect(logger.info).not.toHaveBeenCalled()
  })
})
