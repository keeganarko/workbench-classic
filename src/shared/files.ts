/**
 * The decisions behind the file tree and project search that do not need a disk.
 *
 * Sorting, excerpting and mapping git's paths onto the tree are all pure
 * functions of their inputs, and all three are where the off-by-ones live. They
 * sit here rather than inside `main/files.ts` or the components so a test can
 * reach them without a filesystem or a browser.
 */

import type { FileEntry, GitFileChange } from './types.js'

/** How much of a matching line survives into a result row. */
export const MAX_EXCERPT = 240

/**
 * Folders first, then names, the way every file tree since the 1980s has done
 * it. `numeric` so `item2` sorts before `item10`, and `base` sensitivity so a
 * capitalised name does not get exiled to the top.
 */
export function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.dir !== b.dir) return a.dir ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * A matching line, trimmed to something a 260px sidebar can show.
 *
 * The window follows the match rather than the start of the line: a hit 4000
 * characters into a minified bundle is the exact case where clipping from the
 * left shows you nothing at all. `index` is a character offset into `line`, and
 * the returned `offset` is the same match measured against the returned `text`.
 */
export function excerpt(
  line: string,
  index: number,
  max = MAX_EXCERPT
): { text: string; offset: number } {
  // Files written on Windows arrive with the CR still attached.
  const clean = line.replace(/\r$/, '')
  if (clean.length <= max) return { text: clean, offset: index }

  // Leave a quarter of the window before the match, so there is some context
  // to read leftwards and the match itself is never at the very edge.
  const lead = Math.floor(max / 4)
  const start = Math.max(0, Math.min(index - lead, clean.length - max))
  const head = start > 0 ? '…' : ''
  const body = clean.slice(start, start + max)
  const tail = start + max < clean.length ? '…' : ''
  return { text: head + body + tail, offset: index - start + head.length }
}

/** What a changed file is marked with in the tree. Unstaged wins: it is the newer fact. */
const MARK: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  untracked: 'U',
  conflicted: '!'
}

export interface TreeMarks {
  /** Tree-relative path → single-letter mark. */
  files: Map<string, string>
  /** Every folder on the way to a changed file, so a collapsed folder can say so. */
  dirs: Set<string>
}

/**
 * Git's paths, restated in the tree's terms.
 *
 * Git counts from the repository root and the tree counts from the session's
 * folder, and those are the same directory only when the agent happens to have
 * been started at the top of the repo. `prefix` is the distance between them,
 * measured by the caller with a real path join; a change above the session's
 * folder is not in the tree at all and is dropped.
 */
export function treeMarks(prefix: string, files: GitFileChange[]): TreeMarks {
  const marks: TreeMarks = { files: new Map(), dirs: new Set() }
  const head = prefix ? `${prefix}/` : ''

  for (const file of files) {
    if (head && !file.path.startsWith(head)) continue
    const rel = file.path.slice(head.length)
    if (!rel) continue
    const change = file.unstaged ?? file.staged
    marks.files.set(rel, change ? (MARK[change] ?? 'M') : 'M')
    // Ancestors, so a folder that is closed still shows that something inside
    // it moved. Walking up is cheaper than asking every folder to scan the map.
    let cut = rel.lastIndexOf('/')
    while (cut > 0) {
      marks.dirs.add(rel.slice(0, cut))
      cut = rel.lastIndexOf('/', cut - 1)
    }
  }
  return marks
}
