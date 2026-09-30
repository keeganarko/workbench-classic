import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { activeSessionId } from '../lib/actions'
import { preview } from '../lib/preview'
import { runFileAction } from '../lib/fileActions'
import { shortPath } from '../lib/ui'
import { Icon } from './Icon'
import { PanelEmpty } from './PanelEmpty'
import { treeMarks } from '../../../shared/files'
import { isPreviewable } from '../../../shared/preview'
import type { TreeMarks } from '../../../shared/files'
import type { FileEntry } from '../../../shared/types'

const api = window.term

/** Which mark gets which colour. Shared with the git panel's letters on purpose. */
const MARK_CLASS: Record<string, string> = {
  A: 'added',
  U: 'untracked',
  C: 'copied',
  M: 'modified',
  T: 'typechange',
  D: 'deleted',
  R: 'renamed',
  '!': 'conflicted'
}

interface Row {
  entry: FileEntry
  depth: number
}

/**
 * The focused agent's folder, as a tree.
 *
 * Follows the focused pane like the git panel does, and for the same reason:
 * the question worth answering is "what is *this* agent working on", not "what
 * is in some folder I chose an hour ago". Clicking a name previews the file or
 * expands the folder. A separate, visible Open button hands that item to the
 * system app without changing which document the user is already reading.
 *
 * Folders load when opened rather than up front, because a tree that reads a
 * whole project to draw its first row spends a second on folders nobody wanted.
 */
export function FileTree(): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const openDoc = useStore((s) => s.preview.doc?.path ?? null)

  const sessionId = activeSessionId()
  const session = sessions.find((s) => s.id === sessionId) ?? null

  const [kids, setKids] = useState<Map<string, FileEntry[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Refreshing has to re-read the folders that are open *now*, and the callback
  // that does it is memoised on the session. A ref is how it sees the present.
  const expandedRef = useRef<Set<string>>(expanded)
  const [marks, setMarks] = useState<TreeMarks | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  // Guards against a slow listing landing after focus has moved to another pane.
  const forSession = useRef<string | null>(null)

  const load = useCallback(
    async (rel: string): Promise<void> => {
      if (!sessionId) return
      try {
        const entries = await api.filesList(sessionId, rel)
        if (forSession.current !== sessionId) return
        setKids((prev) => new Map(prev).set(rel, entries))
        setError(null)
      } catch (err) {
        if (forSession.current !== sessionId) return
        // A folder that will not open is worth saying out loud; it is usually a
        // permission problem, and silence would read as "this folder is empty".
        setError((err as Error).message)
      }
    },
    [sessionId]
  )

  const refresh = useCallback(async (): Promise<void> => {
    if (!sessionId) {
      setKids(new Map())
      setMarks(null)
      setLoaded(true)
      return
    }
    forSession.current = sessionId
    // Re-read every folder that is currently open, not just the root: the point
    // of refreshing is to see what the agent wrote, and it wrote it somewhere.
    const open = ['', ...expandedRef.current]
    await Promise.all(open.map((rel) => load(rel)))
    if (forSession.current === sessionId) setLoaded(true)

    // Decoration is a bonus, not a requirement — a folder outside a repository
    // still has a perfectly good tree.
    try {
      const status = await api.gitStatus(sessionId)
      if (forSession.current !== sessionId) return
      const cwd = sessions.find((s) => s.id === sessionId)?.cwd ?? ''
      setMarks(status ? treeMarks(relativeTo(status.root, cwd), status.files) : null)
    } catch {
      setMarks(null)
    }
  }, [sessionId, load, sessions])

  // A new session is a new tree: nothing about the old one carries over.
  useEffect(() => {
    setKids(new Map())
    expandedRef.current = new Set()
    setExpanded(expandedRef.current)
    setMarks(null)
    setError(null)
    setLoaded(false)
    void refresh()
    // Deliberately keyed on the session alone: `refresh` closes over the session
    // list, which changes on every status tick, and re-collapsing the tree each
    // time an agent changed colour would make it unusable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const toggle = (entry: FileEntry): void => {
    const next = new Set(expandedRef.current)
    if (next.has(entry.rel)) next.delete(entry.rel)
    else {
      next.add(entry.rel)
      if (!kids.has(entry.rel)) void load(entry.rel)
    }
    expandedRef.current = next
    setExpanded(next)
  }

  if (!session) {
    return (
      <PanelEmpty title="No session focused" note="Focus a pane to browse the folder it runs in." />
    )
  }
  if (!loaded) return <PanelEmpty title="Reading the folder…" />
  if (error && kids.size === 0) return <PanelEmpty title="Could not read that folder" note={error} />

  const rows: Row[] = []
  const walk = (rel: string, depth: number): void => {
    for (const entry of kids.get(rel) ?? []) {
      rows.push({ entry, depth })
      if (entry.dir && expanded.has(entry.rel)) walk(entry.rel, depth + 1)
    }
  }
  walk('', 0)

  return (
    <div className="ftree">
      <div className="ftree__head">
        <Icon name="folder" size={13} />
        <span className="ftree__root" title={session.cwd}>
          {shortPath(session.cwd)}
        </span>
        <button className="ftree__open" title="Open the session folder"
          onClick={() => void runFileAction(() => api.filesOpen(session.id))}>Open</button>
        <button className="iconbtn ftree__refresh" title="Re-read the folder" onClick={() => void refresh()}>
          <Icon name="refresh" size={12} />
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="ftree__note">This folder is empty.</div>
      ) : (
        <div className="ftree__scroll">
          {rows.map(({ entry, depth }) => {
            const mark = entry.dir
              ? marks?.dirs.has(entry.rel)
                ? '•'
                : null
              : (marks?.files.get(entry.rel) ?? null)
            const open = entry.dir && expanded.has(entry.rel)
            // Dimmed rather than disabled: the pane's own refusal names the
            // file and says why, which is a better answer than a dead row.
            const shows = entry.dir || isPreviewable(entry.name)
            return (
              <div
                key={entry.rel}
                className={`ftree__row${entry.path === openDoc ? ' ftree__row--open' : ''}${
                  shows ? '' : ' ftree__row--plain'
                }`}
                style={{ paddingLeft: 8 + depth * 12 }}
                title={shows ? entry.rel : `${entry.rel} — the preview pane does not render this`}
              >
                <button className="ftree__entry" aria-expanded={entry.dir ? open : undefined}
                  onClick={() => entry.dir ? toggle(entry) : void preview.open(entry.path, { owner: sessionId })}>
                  <span className={`ftree__twisty${open ? ' ftree__twisty--open' : ''}`}>
                    {entry.dir ? <Icon name="chevron" size={10} strokeWidth={1.6} /> : null}
                  </span>
                  <span className="ftree__name">{entry.name}</span>
                  {mark && (
                    <span className={`ftree__mark git__letter--${MARK_CLASS[mark] ?? 'modified'}`}>
                      {mark}
                    </span>
                  )}
                </button>
                <button className="ftree__open" aria-label={`Open ${entry.name}${entry.dir ? ' folder' : ' with the system app'}`}
                  title={entry.dir ? 'Open folder' : 'Open with the system app'}
                  onClick={() => void runFileAction(() => api.filesOpen(session.id, entry.rel))}>Open</button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * How far the session's folder sits below the repository root.
 *
 * String arithmetic rather than a path join, because this runs in the renderer
 * where there is no `path` module — and both sides come from the same main
 * process, already absolute and already normalised.
 */
function relativeTo(root: string, cwd: string): string {
  const a = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const b = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (a === b) return ''
  const prefix = `${a}/`
  return b.startsWith(prefix) ? b.slice(prefix.length) : ''
}
