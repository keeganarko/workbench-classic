/**
 * The preview dock's file server.
 *
 * The renderer never reads a byte off disk itself — it asks for a path, and
 * everything that could be dangerous about that request is decided here:
 *
 *   1. Only files under a *root the user has actually opened* are served. An
 *      artifact is a page written by an agent, and a page that can name any
 *      path on the machine is a page that can read one and post it somewhere.
 *      Roots are realpath'd and compared by path segment, so neither `..` nor a
 *      symlink pointing out of the tree gets past the check.
 *   2. Only whole files, never directory listings.
 *   3. Size is capped twice: a low cap on text crossing the IPC bridge, and a
 *      high one on anything streamed to the frame.
 *
 * Documents the renderer generates (a rendered Markdown file, a CSV table) are
 * held in memory here and served by id, so they arrive at the frame as a real
 * response with a real Content-Security-Policy header instead of inheriting the
 * app's own — that header is what keeps a generated document inert.
 *
 * No Electron import beyond the protocol registration itself, so the rules can
 * be exercised from a plain Node test.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import {
  classifyPreview,
  docIdFromPreviewUrl,
  isPreviewable,
  mimeForPath,
  pathFromPreviewUrl,
  previewDirUrl,
  previewDocUrl,
  previewDocument,
  previewDocumentCsp,
  previewUrlFor
} from '../shared/preview.js'
import type { PreviewDocumentInput, PreviewKind } from '../shared/preview.js'
import type { PreviewDoc, PreviewEntry } from '../shared/types.js'

/** Text handed to the renderer for rendering. Beyond this it is truncated. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024

/** Ceiling on anything streamed into the preview frame. */
export const MAX_SERVE_BYTES = 128 * 1024 * 1024

/** How many opened directories stay servable. Bounded so the surface cannot grow all session. */
export const MAX_ROOTS = 12

/** Generated documents kept addressable, so a reload or a back step still resolves. */
const MAX_DOCS = 8

/**
 * Directories no sweep of a project has any business entering.
 *
 * Exported because the sidebar's file tree and search (`files.ts`) ask exactly
 * the same question and must answer it the same way. Missing one entry costs an
 * order of magnitude: `node_modules` alone is usually more files than the
 * project that depends on it.
 */
export const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.gradle',
  'dist',
  'build',
  'out',
  'release',
  'target',
  'vendor',
  'Pods',
  'DerivedData',
  '.DS_Store'
])

const MAX_SCAN_ENTRIES = 8000
const MAX_SCAN_DEPTH = 5

/**
 * Kinds worth opening the pane by themselves.
 *
 * `text` and `json` are excluded on purpose. They cover source files, logs,
 * lockfiles and configs — the bulk of what an agent writes on any turn — and
 * surfacing those automatically would make the feature noise rather than signal.
 */
const SURFACEABLE_KINDS: ReadonlySet<PreviewKind> = new Set<PreviewKind>([
  'markdown',
  'html',
  'svg',
  'image',
  'pdf',
  'csv'
])

interface RecentFilter {
  /** Only files modified strictly after this timestamp. */
  since?: number
  /** Exclude files written after the turn ended, even if the scan was deferred. */
  until?: number
  kinds?: ReadonlySet<PreviewKind>
}

export interface PreviewServerOptions {
  /**
   * The directory a file's preview is allowed to reach. Wired to the workspace
   * manager in `index.ts`: an artifact in a repository can load the repository's
   * own assets, and a loose file elsewhere gets only its own folder.
   */
  resolveRoot?: (filePath: string) => string | null
  /** Fired when the file currently on screen changes on disk. */
  onChange?: (filePath: string) => void
}

interface StoredDoc {
  html: string
  /** The exact policy this document is served with. Minted with its nonce. */
  csp: string
}

export class PreviewServer {
  private readonly roots: string[] = []
  private readonly docs = new Map<string, StoredDoc>()
  private readonly shownAt = new Map<string, number>()
  private readonly opts: PreviewServerOptions
  private watched: string | null = null
  private watchListener: ((curr: fs.Stats, prev: fs.Stats) => void) | null = null

  constructor(opts: PreviewServerOptions = {}) {
    this.opts = opts
  }

  // ── opening ───────────────────────────────────────────────────────────────

  /**
   * Resolves a path into everything the dock needs to show it.
   *
   * Text-ish kinds come back with their content attached: the renderer has to
   * turn them into HTML anyway, and a second round trip to fetch the bytes it
   * was always going to ask for is latency for nothing.
   */
  open(rawPath: string): PreviewDoc {
    const resolved = this.resolveFile(rawPath)
    const kind = classifyPreview(resolved)
    if (!kind) throw new Error(`Nothing here can preview ${path.basename(resolved)}`)

    const stat = fs.statSync(resolved)
    if (!stat.isFile()) throw new Error('That is a folder, not a document')

    this.addRoot(this.rootFor(resolved))

    const wantsText =
      kind === 'markdown' ||
      kind === 'text' ||
      kind === 'json' ||
      kind === 'csv' ||
      kind === 'diff'
    let text: string | null = null
    let truncated = false
    if (wantsText) {
      const read = this.readText(resolved, stat.size)
      text = read.text
      truncated = read.truncated
    }

    return {
      path: resolved,
      name: path.basename(resolved),
      kind,
      mime: mimeForPath(resolved),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      url: previewUrlFor(resolved),
      dirUrl: previewDirUrl(path.dirname(resolved)),
      text,
      truncated
    }
  }

  /** Re-reads an already open file. Used by the watcher's reload path. */
  private readText(file: string, size: number): { text: string; truncated: boolean } {
    if (size <= MAX_TEXT_BYTES) {
      return { text: fs.readFileSync(file, 'utf8'), truncated: false }
    }
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(MAX_TEXT_BYTES)
      const read = fs.readSync(fd, buf, 0, MAX_TEXT_BYTES, 0)
      // Cut back to the last newline so the render never starts mid-line.
      const slice = buf.subarray(0, read).toString('utf8')
      const cut = slice.lastIndexOf('\n')
      return { text: cut > 0 ? slice.slice(0, cut) : slice, truncated: true }
    } finally {
      fs.closeSync(fd)
    }
  }

  /**
   * Realpath, then reject anything that is not a plain readable file.
   *
   * Doing this before the root check matters: the root check compares real
   * paths, and a symlink is the obvious way to try to make a file look like it
   * lives somewhere it does not.
   */
  private resolveFile(rawPath: string): string {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new Error('No file given')
    if (rawPath.includes('\0')) throw new Error('Invalid path')
    const absolute = path.resolve(rawPath)
    let real: string
    try {
      real = fs.realpathSync.native(absolute)
    } catch {
      throw new Error(`${path.basename(absolute)} is not there any more`)
    }
    return real
  }

  private rootFor(file: string): string {
    const fromWorkspace = this.opts.resolveRoot?.(file)
    if (fromWorkspace) {
      try {
        const real = fs.realpathSync.native(fromWorkspace)
        if (isInsideRoot(real, file)) return real
      } catch {
        /* a workspace that has moved is no better than none */
      }
    }
    return path.dirname(file)
  }

  private addRoot(root: string): void {
    const existing = this.roots.indexOf(root)
    if (existing >= 0) {
      this.roots.splice(existing, 1)
    } else if (this.roots.some((r) => isInsideRoot(r, root))) {
      // Already covered by a broader root; nothing to add.
      return
    }
    this.roots.unshift(root)
    while (this.roots.length > MAX_ROOTS) this.roots.pop()
  }

  /** Whether a real path is inside one of the roots opened so far. */
  isServable(realPath: string): boolean {
    return this.roots.some((root) => isInsideRoot(root, realPath))
  }

  /** Exposed for tests and for the "why is this blank" case in the UI. */
  listRoots(): string[] {
    return [...this.roots]
  }

  // ── generated documents ───────────────────────────────────────────────────

  /**
   * Wraps a rendered body in a document and returns the id it is served under.
   *
   * The renderer supplies the body; the nonce, the wrapper and the policy are
   * minted here. That ordering is deliberate — the process that decides what a
   * document is allowed to do should not be the one that generated its content.
   */
  documentUrl(input: Omit<PreviewDocumentInput, 'nonce'>): string {
    const nonce = crypto.randomBytes(16).toString('base64url')
    const id = crypto.randomBytes(9).toString('base64url')
    this.docs.set(id, {
      html: previewDocument({ ...input, nonce }),
      csp: previewDocumentCsp(nonce)
    })
    while (this.docs.size > MAX_DOCS) {
      const oldest = this.docs.keys().next().value
      if (oldest === undefined) break
      this.docs.delete(oldest)
    }
    return previewDocUrl(id)
  }

  /**
   * The path behind a "reveal in Finder" or "open with the system app", proved
   * to be a real file the pane is already allowed to read.
   *
   * Handing a path to the OS is a different act from rendering it, and the one
   * rule worth holding is that it can only ever be something already on screen.
   */
  assertReadable(rawPath: string): string {
    const real = this.resolveFile(rawPath)
    if (!this.isServable(real)) throw new Error('That file is not open in the preview')
    if (!fs.statSync(real).isFile()) throw new Error('That is a folder, not a document')
    return real
  }

  // ── watching ──────────────────────────────────────────────────────────────

  /**
   * Watches one file — whichever is on screen.
   *
   * `watchFile` polls rather than subscribing, which is the point: agents
   * rewrite files by replacing them, and an inode-based watch goes deaf the
   * first time that happens. One poll a second for one file is nothing.
   */
  watch(filePath: string): void {
    const file = this.resolveFile(filePath)
    if (this.watched === file) return
    this.unwatch()
    const listener = (curr: fs.Stats, prev: fs.Stats): void => {
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return
      // A deleted file reports mtime 0; leave the last render on screen.
      if (curr.mtimeMs === 0) return
      this.opts.onChange?.(file)
    }
    fs.watchFile(file, { interval: 700 }, listener)
    this.watched = file
    this.watchListener = listener
  }

  unwatch(): void {
    if (this.watched && this.watchListener) fs.unwatchFile(this.watched, this.watchListener)
    this.watched = null
    this.watchListener = null
  }

  dispose(): void {
    this.unwatch()
    this.docs.clear()
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  /**
   * The most recently touched previewable files under a directory.
   *
   * This is the answer to "what did the agent just make", which is the question
   * you have when you open an empty preview pane. Bounded in every direction —
   * depth, entries scanned, results returned — because it runs against whatever
   * repository the session happens to be in.
   *
   * `since` and `kinds` narrow it for the other caller: deciding whether a
   * finished turn actually produced a document worth putting on screen.
   */
  recent(dir: string, limit = 40, filter: RecentFilter = {}): PreviewEntry[] {
    let root: string
    try {
      root = fs.realpathSync.native(path.resolve(dir))
    } catch {
      return []
    }

    const found: PreviewEntry[] = []
    let scanned = 0
    const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]

    while (queue.length) {
      const next = queue.shift()!
      if (next.depth > MAX_SCAN_DEPTH || scanned > MAX_SCAN_ENTRIES) break
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(next.dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        scanned++
        if (scanned > MAX_SCAN_ENTRIES) break
        if (entry.name.startsWith('.') && entry.name !== '.env') continue
        const full = path.join(next.dir, entry.name)
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) queue.push({ dir: full, depth: next.depth + 1 })
          continue
        }
        if (!entry.isFile() || !isPreviewable(entry.name)) continue
        const kind = classifyPreview(entry.name)!
        if (filter.kinds && !filter.kinds.has(kind)) continue
        try {
          const stat = fs.statSync(full)
          if (filter.since !== undefined && stat.mtimeMs <= filter.since) continue
          if (filter.until !== undefined && Math.floor(stat.mtimeMs) > filter.until) continue
          found.push({
            path: full,
            name: entry.name,
            kind,
            mtimeMs: stat.mtimeMs,
            size: stat.size
          })
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }

    return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
  }

  /**
   * The one document a finished turn produced, if it produced one.
   *
   * Deliberately narrower than `recent`: source files, logs and JSON are most
   * of what an agent writes, and a pane that opens itself for every `.ts` file
   * is a pane you turn off. Only things a person would want to *look* at count.
   */
  producedSince(dir: string, since: number, until = Date.now()): PreviewEntry | null {
    // A modification time cannot distinguish the intended deliverable from
    // a later handoff, or from another session writing in this same checkout.
    // Keep the convenient single-document fallback, but do not pick a winner
    // when several documents changed. An explicit show supplies that intent.
    const candidates = this.recent(dir, 2, { since, until, kinds: SURFACEABLE_KINDS })
    return candidates.length === 1 ? candidates[0] : null
  }

  /** Call only after an authenticated show request has passed the file checks. */
  noteShown(sessionId: string, at = Date.now()): void {
    this.shownAt.delete(sessionId)
    this.shownAt.set(sessionId, at)
    // This is a short-lived delivery preference, not durable project history.
    // Bound it even if a long-running app creates and removes many sessions.
    if (this.shownAt.size > 512) this.shownAt.delete(this.shownAt.keys().next().value!)
  }

  producedFor(sessionId: string, dir: string, since: number, until = Date.now()): PreviewEntry | null {
    // The named document was already delivered to the dock or visual canvas.
    // Do not send a second, guessed result at the end of that same turn. A
    // newer show also cancels an older turn's deferred scan before it runs.
    if ((this.shownAt.get(sessionId) ?? -Infinity) >= since) return null
    return this.producedSince(dir, since, until)
  }

  // ── serving ───────────────────────────────────────────────────────────────

  /**
   * Answers one `wb-preview://` request.
   *
   * Written against the Fetch types so it can be handed straight to
   * `protocol.handle`, and tested without one.
   */
  async serve(url: string): Promise<Response> {
    const docId = docIdFromPreviewUrl(url)
    if (docId) {
      const doc = this.docs.get(docId)
      if (!doc) return notFound('That preview has expired')
      return new Response(doc.html, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          // The document carries the same policy in a `<meta>`; a header is the
          // copy that applies before the first byte of body is parsed.
          'content-security-policy': doc.csp
        }
      })
    }

    const target = pathFromPreviewUrl(url)
    if (!target) return notFound('Not a preview URL')

    let real: string
    try {
      real = fs.realpathSync.native(target)
    } catch {
      return notFound('File not found')
    }
    if (!this.isServable(real)) return forbidden()

    let stat: fs.Stats
    try {
      stat = fs.statSync(real)
    } catch {
      return notFound('File not found')
    }
    if (!stat.isFile()) return forbidden()
    if (stat.size > MAX_SERVE_BYTES) return new Response('File is too large to preview', { status: 413 })

    const headers: Record<string, string> = {
      'content-type': mimeForPath(real),
      'content-length': String(stat.size),
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      // A preview is never something to save from inside the frame.
      'content-disposition': 'inline'
    }

    try {
      const stream = Readable.toWeb(fs.createReadStream(real)) as unknown as ReadableStream
      return new Response(stream, { status: 200, headers })
    } catch {
      return notFound('File could not be read')
    }
  }
}

/**
 * True when `child` is `root` or sits inside it.
 *
 * Compared as resolved paths with a separator boundary, so `/tmp/work-2` is not
 * accepted as being inside `/tmp/work`.
 */
export function isInsideRoot(root: string, child: string): boolean {
  const a = path.resolve(root)
  const b = path.resolve(child)
  if (a === b) return true
  const rel = path.relative(a, b)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function notFound(message: string): Response {
  return new Response(message, { status: 404, headers: { 'content-type': 'text/plain' } })
}

function forbidden(): Response {
  return new Response('Not inside an opened folder', {
    status: 403,
    headers: { 'content-type': 'text/plain' }
  })
}
