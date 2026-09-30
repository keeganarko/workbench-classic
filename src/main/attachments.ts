/**
 * Attachments — the bridge between "I can see it" and "the agent can read it".
 *
 * Claude and Codex both take images and files as filesystem paths, so anything
 * pasted or dropped onto a pane is resolved to a path first and then typed into
 * the agent's composer as ordinary text (see `shared/attach.ts` for that half).
 *
 * Two sources, deliberately handled differently:
 *   - A file that already exists on disk is referenced *where it is*. Copying a
 *     50 MB video into the app's storage so the agent can read a path it could
 *     already read is pure waste, and it makes the copy go stale the moment the
 *     original changes.
 *   - Bytes with no home — a screenshot on the clipboard, an image dragged out
 *     of a browser tab — are written into `<dataDir>/attachments`, owner-only,
 *     and pruned on a timer so the directory does not grow forever.
 *
 * No Electron import: the clipboard arrives as a narrow interface so this whole
 * module can be exercised from a plain Node test.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { AttachResult, DroppedFile } from '../shared/types.js'

/** Ceiling on a single clipboard/drag payload crossing the IPC bridge. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** Ceiling on one paste or drop. Selecting a whole folder in Finder is easy. */
export const MAX_ATTACHMENTS_PER_BATCH = 20

/** How long an app-written attachment survives before the next prune sweeps it. */
export const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** The slice of Electron's clipboard this module needs, and nothing more. */
export interface ClipboardLike {
  read(): Promise<{ types: string[]; getType(type: string): Promise<unknown> }[]>
}

/**
 * Reduces a suggested filename to something that can only ever land inside the
 * attachments directory.
 *
 * A dropped file is named by whoever created it. `../../.ssh/authorized_keys`
 * is a legal filename on a web page, so the name is stripped to its basename
 * and then to a known-safe alphabet — it is a label, not a routing instruction.
 */
export function safeAttachmentName(suggested: unknown): string {
  const raw = typeof suggested === 'string' ? suggested : ''
  const base = path
    .basename(raw)
    // Everything outside the allow-list collapses to a dash. One rule covers
    // path separators, shell metacharacters and invisible control bytes.
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    // A leading dot would hide the file; a leading dash reads as a flag.
    .replace(/^[-.]+/, '')
    .slice(0, 80)
  return base || 'attachment'
}

/** `file:///Users/me/a%20b.png` → `/Users/me/a b.png`, or null if it is not one. */
export function fileUrlToPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed.startsWith('file://')) return null
  try {
    return fileURLToPath(trimmed)
  } catch {
    return null
  }
}

export class AttachmentStore {
  readonly dir: string

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'attachments')
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }

  /**
   * Writes clipboard/drag bytes into the attachments directory and returns the
   * path. The name is timestamped and salted so two screenshots pasted in the
   * same second cannot overwrite each other.
   */
  saveBytes(bytes: Uint8Array, suggestedName: unknown, now = Date.now()): string {
    if (bytes.byteLength === 0) throw new Error('That attachment was empty')
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      const mb = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))
      throw new Error(`That attachment is larger than ${mb} MB`)
    }
    this.ensureDir()
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const salt = crypto.randomBytes(3).toString('hex')
    const file = path.join(this.dir, `${stamp}-${salt}-${safeAttachmentName(suggestedName)}`)
    fs.writeFileSync(file, bytes, { mode: 0o600 })
    return file
  }

  /** Resolves one pasted or dropped item to a path an agent can open. */
  adopt(item: DroppedFile, now = Date.now()): string {
    if (typeof item.path === 'string' && item.path !== '') {
      const abs = path.resolve(item.path)
      let st: fs.Stats
      try {
        st = fs.statSync(abs)
      } catch {
        throw new Error(`${path.basename(abs)}: no longer on disk`)
      }
      // A dropped folder is a legitimate thing to point an agent at; a socket
      // or a device node is not.
      if (!st.isFile() && !st.isDirectory()) {
        throw new Error(`${path.basename(abs)}: not a file or folder`)
      }
      return abs
    }

    if (typeof item.dataBase64 === 'string' && item.dataBase64 !== '') {
      const bytes = Buffer.from(item.dataBase64, 'base64')
      return this.saveBytes(bytes, item.name ?? 'attachment', now)
    }

    throw new Error('That item had no file behind it')
  }

  /**
   * Adopts a batch, reporting each failure by name instead of aborting.
   *
   * Pasting four screenshots and attaching three is a miss you only notice
   * after the agent has answered about the wrong picture, so the caller gets
   * both lists and can surface the gap.
   */
  adoptAll(items: DroppedFile[], now = Date.now()): AttachResult {
    const paths: string[] = []
    const errors: string[] = []
    for (const item of items.slice(0, MAX_ATTACHMENTS_PER_BATCH)) {
      try {
        paths.push(this.adopt(item, now))
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
      }
    }
    if (items.length > MAX_ATTACHMENTS_PER_BATCH) {
      errors.push(
        `Only the first ${MAX_ATTACHMENTS_PER_BATCH} of ${items.length} items were attached`
      )
    }
    return { paths, errors }
  }

  /**
   * Reads the system clipboard directly.
   *
   * The renderer's own `clipboardData` is the usual route, but it only sees
   * what the web platform exposes for a paste event. This is the fallback for
   * the context menu, where there is no event at all, and for a Finder copy
   * that arrives as a file URL rather than as bytes.
   */
  async fromClipboard(clipboard: ClipboardLike, now = Date.now()): Promise<AttachResult> {
    try {
      // Electron's asynchronous clipboard returns MIME-typed items. Prefer a
      // screenshot, then a copied file URL; ordinary text belongs in the
      // terminal's text-paste path. Check the Blob's size before allocating its
      // bytes, since clipboard contents are not controlled by Workbench.
      const items = await clipboard.read()
      for (const item of items.slice(0, MAX_ATTACHMENTS_PER_BATCH)) {
        if (!item.types.includes('image/png')) continue
        const blob = await item.getType('image/png') as Blob
        if (!blob.size) continue
        if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error('Clipboard image exceeds the 25 MB attachment limit')
        return { paths: [this.saveBytes(Buffer.from(await blob.arrayBuffer()), 'pasted-image.png', now)], errors: [] }
      }
      for (const item of items.slice(0, MAX_ATTACHMENTS_PER_BATCH)) {
        const format = item.types.find((type) => type === 'text/uri-list'
          || /^electron application\/osclipboard;format="public\.file-url"$/.test(type))
        if (!format) continue
        const blob = await item.getType(format) as Blob
        if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error('Clipboard file list is too large')
        const paths = (await blob.text()).split(/\r?\n/).map(fileUrlToPath).filter((file): file is string => file !== null)
        if (paths.length) return this.adoptAll(paths.map((file) => ({ path: file })), now)
      }
    } catch (err) {
      return { paths: [], errors: [err instanceof Error ? err.message : String(err)] }
    }

    return { paths: [], errors: [] }
  }

  /**
   * Deletes attachments older than `ttlMs` and returns how many went.
   *
   * Only ever touches the app's own directory — files adopted in place are
   * somebody else's, and are never candidates for deletion.
   */
  prune(now = Date.now(), ttlMs = ATTACHMENT_TTL_MS): number {
    let removed = 0
    let entries: string[]
    try {
      entries = fs.readdirSync(this.dir)
    } catch {
      return 0 // nothing has ever been attached
    }
    for (const name of entries) {
      const file = path.join(this.dir, name)
      try {
        const st = fs.statSync(file)
        if (!st.isFile() || now - st.mtimeMs < ttlMs) continue
        fs.rmSync(file)
        removed += 1
      } catch {
        /* raced with something else; the next sweep will get it */
      }
    }
    return removed
  }
}
