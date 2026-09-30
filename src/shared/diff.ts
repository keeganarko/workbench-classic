/**
 * Unified diffs: parsed once, rendered as HTML.
 *
 * This lives in `shared` for the same reason the rest of the preview vocabulary
 * does — main decides a `.patch` file is a diff, the renderer turns it into a
 * document — but it exists at all because a patch is the one thing an agent
 * produces that plain `<pre>` actively makes harder to read. Colour on the sign
 * column, per-file headers you can scan, and line numbers on both sides are the
 * difference between reading a review and squinting at one.
 *
 * The parser is deliberately forgiving. A patch reaching this function may have
 * come from `git diff`, from `diff -u`, or from a file someone was handed, and
 * anything it does not recognise is passed through as context rather than
 * dropped — a renderer that silently eats lines of a diff is worse than one
 * that shows a line it did not understand.
 */

import { escapeHtml } from './preview.js'

export type DiffLineKind = 'add' | 'del' | 'context' | 'meta'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** Line number on the left (old) side, or null for an addition. */
  oldNo: number | null
  /** Line number on the right (new) side, or null for a deletion. */
  newNo: number | null
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  /** Best display name: the new path, or the old one for a deletion. */
  path: string
  oldPath: string | null
  newPath: string | null
  hunks: DiffHunk[]
  /** `new`, `deleted`, `renamed`, `binary`, or null for an ordinary edit. */
  status: 'new' | 'deleted' | 'renamed' | 'binary' | null
  additions: number
  deletions: number
  /** `old mode`/`new mode` lines, kept because a permission change is a change. */
  notes: string[]
}

const HUNK_RE = /^@@+ (.*?) @@/
const RANGE_RE = /^-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/

/**
 * Splits a patch into files and hunks.
 *
 * Anything before the first `diff --git` (or `---`) is discarded: `git
 * format-patch` output and mail-formatted patches carry a commit message there,
 * and it is not part of the change.
 */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  /** True between a `diff --git` header and the `---` that belongs to it. */
  let awaitingPaths = false
  let oldNo = 0
  let newNo = 0

  const startFile = (): DiffFile => {
    const fresh: DiffFile = {
      path: '',
      oldPath: null,
      newPath: null,
      hunks: [],
      status: null,
      additions: 0,
      deletions: 0,
      notes: []
    }
    files.push(fresh)
    file = fresh
    hunk = null
    return fresh
  }

  for (const raw of patch.split('\n')) {
    const line = raw.replace(/\r$/, '')

    // Inside a hunk, the body is read first and unconditionally. This is not a
    // shortcut: deleting a line that itself began with `-- ` produces the text
    // `--- `, and a parser that checked for file headers first would treat that
    // deletion as the start of a new file.
    if (hunk) {
      if (line.startsWith('+')) {
        hunk.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo })
        newNo += 1
        continue
      }
      if (line.startsWith('-')) {
        hunk.lines.push({ kind: 'del', text: line.slice(1), oldNo, newNo: null })
        oldNo += 1
        continue
      }
      if (line.startsWith('\\')) {
        // "\ No newline at end of file" — real information, not a diff line.
        hunk.lines.push({ kind: 'meta', text: line, oldNo: null, newNo: null })
        continue
      }
      if (line === '' || line.startsWith(' ')) {
        hunk.lines.push({ kind: 'context', text: line.slice(1), oldNo, newNo })
        oldNo += 1
        newNo += 1
        continue
      }
      // Anything else is not part of this hunk; fall through as a header.
      hunk = null
    }

    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ')) {
      const cur = startFile()
      awaitingPaths = true
      // The header repeats both paths. The `---`/`+++` lines are authoritative,
      // so this only fills in a patch that has a header and no file lines —
      // a pure mode change, or a rename with no edits.
      const pair = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
      if (pair) {
        cur.oldPath = pair[1]
        cur.newPath = pair[2]
        cur.path = pair[2]
      }
      continue
    }

    if (line.startsWith('--- ')) {
      // A `---` with no `diff --git` above it starts a plain `diff -u` file.
      const cur = file && awaitingPaths ? file : startFile()
      awaitingPaths = false
      cur.oldPath = stripPrefix(line.slice(4))
      if (cur.oldPath === null) cur.status = 'new'
      if (!cur.path && cur.oldPath) cur.path = cur.oldPath
      continue
    }

    if (!file) continue
    const cur: DiffFile = file

    if (line.startsWith('+++ ')) {
      cur.newPath = stripPrefix(line.slice(4))
      if (cur.newPath === null) cur.status = 'deleted'
      cur.path = cur.newPath ?? cur.oldPath ?? ''
      continue
    }

    if (line.startsWith('@@')) {
      const head = HUNK_RE.exec(line)
      const range = RANGE_RE.exec(head?.[1] ?? '')
      oldNo = range ? Number(range[1]) : 1
      newNo = range ? Number(range[3]) : 1
      hunk = { header: line, lines: [] }
      cur.hunks.push(hunk)
      continue
    }

    // Between a file header and its first hunk: git's extended headers.
    if (line.startsWith('new file')) cur.status = 'new'
    else if (line.startsWith('deleted file')) cur.status = 'deleted'
    else if (line.startsWith('rename from ')) cur.oldPath = line.slice('rename from '.length)
    else if (line.startsWith('rename to ')) {
      cur.status = 'renamed'
      cur.newPath = line.slice('rename to '.length)
      cur.path = cur.newPath
    } else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      cur.status = 'binary'
      cur.notes.push(line)
    } else if (line.startsWith('old mode ') || line.startsWith('new mode ')) {
      cur.notes.push(line)
    }
  }

  // Counted afterwards rather than as we go, so the tally is a plain function
  // of the lines that survived parsing and cannot drift from them.
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.kind === 'add') f.additions += 1
        else if (l.kind === 'del') f.deletions += 1
      }
    }
  }

  // A patch that ends in a newline leaves one empty record behind.
  return files.filter((f) => f.path || f.hunks.length || f.notes.length)
}

/** `a/src/app.ts` → `src/app.ts`; `/dev/null` → null. */
function stripPrefix(raw: string): string | null {
  // The path runs to the first tab: `git diff` appends a timestamp after one.
  const value = raw.split('\t')[0].trim()
  if (value === '/dev/null') return null
  return value.replace(/^[abciwo]\//, '')
}

/** `+12 −3`, and the file count, for a one-line summary above the patch. */
export function diffStats(files: DiffFile[]): {
  files: number
  additions: number
  deletions: number
} {
  return {
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0)
  }
}

const STATUS_LABEL: Record<NonNullable<DiffFile['status']>, string> = {
  new: 'new file',
  deleted: 'deleted',
  renamed: 'renamed',
  binary: 'binary'
}

export interface DiffHtmlOptions {
  /** Shown above the patch — what this is a diff of. */
  title?: string
  /** Appended to the summary line, e.g. a truncation warning. */
  note?: string
}

/**
 * Renders parsed files as the body of a preview document.
 *
 * Two columns of line numbers and a sign column, all `user-select: none`, so
 * selecting a region of the diff and pasting it into a session copies the code
 * and not the gutter — the thing that makes every web diff viewer annoying to
 * quote from.
 */
export function diffHtml(files: DiffFile[], opts: DiffHtmlOptions = {}): string {
  const stats = diffStats(files)
  const parts: string[] = []

  if (opts.title || opts.note || files.length) {
    const counts = files.length
      ? `<span class="diff-sum">${stats.files} file${stats.files === 1 ? '' : 's'}` +
        `<span class="diff-add-count">+${stats.additions}</span>` +
        `<span class="diff-del-count">−${stats.deletions}</span></span>`
      : ''
    parts.push(
      `<div class="diff-head">${escapeHtml(opts.title ?? '')}${counts}</div>`
    )
  }
  if (opts.note) parts.push(`<p class="doc-note">${escapeHtml(opts.note)}</p>`)

  if (files.length === 0) {
    parts.push('<p class="doc-note">No changes here.</p>')
    return parts.join('\n')
  }

  for (const file of files) {
    const tag = file.status
      ? `<span class="diff-file-tag diff-file-tag--${file.status}">${STATUS_LABEL[file.status]}</span>`
      : ''
    const renamedFrom =
      file.status === 'renamed' && file.oldPath
        ? `<span class="diff-file-from">from ${escapeHtml(file.oldPath)}</span>`
        : ''
    parts.push(
      `<section class="diff-file">
<header class="diff-file-head"><span class="diff-file-path">${escapeHtml(file.path)}</span>${tag}${renamedFrom}` +
        `<span class="diff-file-stat"><span class="diff-add-count">+${file.additions}</span>` +
        `<span class="diff-del-count">−${file.deletions}</span></span></header>`
    )

    for (const note of file.notes) {
      parts.push(`<div class="diff-note">${escapeHtml(note)}</div>`)
    }

    if (file.hunks.length === 0) {
      parts.push('</section>')
      continue
    }

    parts.push('<table class="diff-table">')
    for (const h of file.hunks) {
      parts.push(
        `<tr class="diff-row diff-row--hunk"><td class="diff-no" colspan="2"></td>` +
          `<td class="diff-sign"></td><td class="diff-code">${escapeHtml(h.header)}</td></tr>`
      )
      for (const line of h.lines) {
        const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '
        parts.push(
          `<tr class="diff-row diff-row--${line.kind}">` +
            `<td class="diff-no">${line.oldNo ?? ''}</td>` +
            `<td class="diff-no">${line.newNo ?? ''}</td>` +
            `<td class="diff-sign">${sign}</td>` +
            `<td class="diff-code">${escapeHtml(line.text) || '&nbsp;'}</td></tr>`
        )
      }
    }
    parts.push('</table></section>')
  }

  return parts.join('\n')
}

/** Parse and render in one step — what every caller actually wants. */
export function renderDiff(patch: string, opts: DiffHtmlOptions = {}): string {
  return diffHtml(parseUnifiedDiff(patch), opts)
}
