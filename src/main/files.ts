/**
 * Two read-only views of the folder a session is working in: what is in it,
 * and where a piece of text appears in it.
 *
 * Addressed by session, exactly like `review.ts`. The renderer never names a
 * directory for this module to read; it names a session it can already see, and
 * the folder comes off the session record in `ipc.ts`. A relative path from the
 * renderer only ever selects a *subfolder* of that, and is checked to be one.
 *
 * **No ripgrep.** The obvious implementation shells out to `rg`, and the plan
 * said so, but `rg` is not on a normal macOS or Ubuntu machine and this project
 * cannot add a dependency to put it there. A search that works for the people
 * who happen to have installed a Rust CLI is worse than one that works for
 * everyone, and the difference on a project-sized tree is tens of milliseconds.
 * So this walks the tree itself, with the same bounds the preview pane's scan
 * already uses.
 *
 * What that costs, stated rather than hidden: `.gitignore` is not read. The
 * skip list below removes the folders that account for nearly all of what a
 * repository ignores, but a `coverage/` or a stray `.env.local` will turn up in
 * results. Reading the ignore rules properly means either a parser or a
 * `git ls-files` subprocess, and neither is worth it until this list is
 * demonstrably not enough.
 *
 * Everything here is async, and that is load-bearing rather than stylistic:
 * this runs on the main process, which is also forwarding terminal output. A
 * synchronous sweep of a few thousand files would stall every pane in the
 * window for as long as it took.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'

import { MAX_TEXT_BYTES, SKIP_DIRS, isInsideRoot } from './preview.js'
import { compareEntries, excerpt } from '../shared/files.js'
import type { FileEntry, SearchHit, SearchResult } from '../shared/types.js'

/** One folder's worth of rows. A directory past this is generated, not written. */
const MAX_ENTRIES = 1000

/**
 * Read ceiling per file, borrowed from the preview pane's own text limit.
 *
 * The rule it encodes: if the pane would not render the file as text, the
 * search does not read it as text either. Above this a "file" is data, and
 * finding a string inside it would not help you do anything.
 */
const MAX_FILE_BYTES = MAX_TEXT_BYTES

/** Bounds on the sweep, mirroring `preview.recent`'s. */
const MAX_FILES = 6000
const MAX_DEPTH = 12

const MAX_HITS = 300
/** Per file, so one minified bundle cannot fill the whole result. */
const MAX_HITS_PER_FILE = 20

/** Files read at once. Enough to keep the disk busy, few enough to yield often. */
const CONCURRENCY = 12

/**
 * Resolves a renderer-supplied relative path inside the session's folder.
 *
 * Three separate ways out are closed here: an absolute path, a `..` that climbs
 * past the root, and a symlink that resolves outside it. The first two are
 * caught before touching the disk; the third needs a `realpath`, because
 * `path.resolve` is string arithmetic and knows nothing about links.
 */
export async function resolveInside(root: string, rel: string): Promise<string> {
  if (rel.includes('\0')) throw new Error('Invalid path')
  if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel)) {
    throw new Error('A folder in the tree is relative to the session folder')
  }
  const realRoot = await fs.realpath(root)
  const full = path.resolve(realRoot, rel)
  if (!isInsideRoot(realRoot, full)) throw new Error('That folder is outside the session')
  const real = await fs.realpath(full)
  if (!isInsideRoot(realRoot, real)) throw new Error('That folder is outside the session')
  return real
}

/**
 * One level of the tree.
 *
 * Lazy by design — a tree that reads the whole project to draw its first row
 * spends a second on folders nobody opened. Symlinks are dropped rather than
 * followed: a link is either a cycle waiting to happen or a way out of the
 * session's folder, and the tree is not the place to litigate which.
 */
export async function listDir(root: string, rel: string): Promise<FileEntry[]> {
  const dir = await resolveInside(root, rel)
  const dirents = await fs.readdir(dir, { withFileTypes: true })

  const out: FileEntry[] = []
  for (const entry of dirents) {
    if (out.length >= MAX_ENTRIES) break
    const isDir = entry.isDirectory()
    if (isDir && SKIP_DIRS.has(entry.name)) continue
    if (!isDir && !entry.isFile()) continue
    out.push({
      name: entry.name,
      rel: rel ? `${rel}/${entry.name}` : entry.name,
      path: path.join(dir, entry.name),
      dir: isDir
    })
  }
  return out.sort(compareEntries)
}

/**
 * Which search is the current one.
 *
 * Typing produces a search per keystroke even with a debounce in front of it,
 * and the main process has no way to abandon work it has already started
 * unless the work asks. Each sweep checks whether a newer one has begun and
 * stops at the next file boundary if so — the renderer was going to throw the
 * answer away regardless, and this stops the pile-up from being paid for.
 */
let generation = 0

export async function searchFiles(
  root: string,
  query: string,
  opts: { caseSensitive?: boolean } = {}
): Promise<SearchResult> {
  const mine = ++generation
  const needle = opts.caseSensitive ? query : query.toLowerCase()
  const empty: SearchResult = { hits: [], truncated: false, scanned: 0 }
  if (!needle) return empty

  const realRoot = await fs.realpath(root)
  const { files, truncated: overflowed } = await collect(realRoot)

  const hits: SearchHit[] = []
  let scanned = 0
  let cut = overflowed

  let next = 0
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      if (hits.length >= MAX_HITS || generation !== mine) {
        cut = true
        return
      }
      const file = files[next++]
      scanned++
      await scan(file, needle, opts.caseSensitive === true, hits)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker())
  )

  hits.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line)
  return { hits: hits.slice(0, MAX_HITS), truncated: cut || hits.length > MAX_HITS, scanned }
}

/** Breadth-first, so a wide shallow project is fully covered before a deep one is. */
async function collect(root: string): Promise<{ files: { path: string; rel: string }[]; truncated: boolean }> {
  const files: { path: string; rel: string }[] = []
  const queue: { dir: string; rel: string; depth: number }[] = [{ dir: root, rel: '', depth: 0 }]
  let truncated = false

  while (queue.length) {
    const node = queue.shift()!
    if (node.depth > MAX_DEPTH) {
      truncated = true
      continue
    }
    let dirents: Dirent[]
    try {
      dirents = await fs.readdir(node.dir, { withFileTypes: true })
    } catch {
      continue // a folder that vanished or that we may not read is not an error
    }
    for (const entry of dirents) {
      if (files.length >= MAX_FILES) return { files, truncated: true }
      const rel = node.rel ? `${node.rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          queue.push({ dir: path.join(node.dir, entry.name), rel, depth: node.depth + 1 })
        }
        continue
      }
      if (!entry.isFile()) continue // symlinks, sockets, devices
      files.push({ path: path.join(node.dir, entry.name), rel })
    }
  }
  return { files, truncated }
}

/**
 * One file, read once.
 *
 * Opened rather than `stat`-ed then read, so the size check and the read share
 * a handle and a file swapped underneath us cannot smuggle in something larger
 * than the ceiling. A NUL byte early in the file means binary, which no text
 * search wants and which would otherwise be split into a million "lines".
 */
async function scan(
  file: { path: string; rel: string },
  needle: string,
  caseSensitive: boolean,
  hits: SearchHit[]
): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(file.path, 'r')
  } catch {
    return
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return
    const buf = Buffer.allocUnsafe(stat.size)
    const { bytesRead } = await handle.read(buf, 0, stat.size, 0)
    const body = buf.subarray(0, bytesRead)
    if (body.subarray(0, 4096).includes(0)) return

    const lines = body.toString('utf8').split('\n')
    let found = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const index = (caseSensitive ? line : line.toLowerCase()).indexOf(needle)
      if (index < 0) continue
      const { text, offset } = excerpt(line, index)
      hits.push({ rel: file.rel, path: file.path, line: i + 1, offset, text })
      if (++found >= MAX_HITS_PER_FILE) return
    }
  } catch {
    /* unreadable mid-read; a search is not the place to report it */
  } finally {
    await handle.close().catch(() => {})
  }
}
