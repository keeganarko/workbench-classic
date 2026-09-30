import { ResizeHandle, usePanelWidth } from './ResizeHandle'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, JSX } from 'react'
import { useStore } from '../state/store'
import { preview, previewHomeDir } from '../lib/preview'
import { actions, activeSessionId } from '../lib/actions'
import { relTime, shortPath } from '../lib/ui'
import { Icon } from './Icon'
import type { IconName } from './Icon'
import type { PreviewKind } from '../../../shared/preview'
import type { PreviewDoc } from '../../../shared/types'
import { PreviewViewer } from './PreviewViewer'
import { dragPreviewFile, runFileAction, saveFileCopy } from '../lib/fileActions'

const api = window.term

const KIND_LABEL: Record<PreviewKind, string> = {
  markdown: 'Markdown',
  html: 'Artifact',
  image: 'Image',
  svg: 'Vector',
  pdf: 'PDF',
  csv: 'Table',
  json: 'JSON',
  diff: 'Diff',
  text: 'Text',
  url: 'Live'
}

const KIND_ICON: Record<PreviewKind, IconName> = {
  markdown: 'document',
  html: 'preview',
  image: 'image',
  svg: 'image',
  pdf: 'document',
  csv: 'sessions',
  json: 'document',
  diff: 'diff',
  text: 'document',
  url: 'globe'
}

/**
 * The document pane, to the right of the terminals.
 *
 * It exists because half of what an agent produces is not terminal output: a
 * report, a chart, a generated page, a diagram. Those were previously things
 * you left the app to look at, which meant leaving the app in the middle of the
 * loop the app is for.
 *
 * Nothing here reads a file. The pane asks main for a path, gets back either a
 * URL to load or text to render, and shows the result inside an iframe that has
 * no access to this window — see `main/preview.ts` for what that buys.
 */
export function PreviewDock(): JSX.Element | null {
  const prefs = useStore((s) => s.prefs)
  const experienceView = useStore((s) => s.experienceView)
  const pv = useStore((s) => s.preview)
  const sessions = useStore((s) => s.sessions)
  // The recents list follows the focused pane, so it answers "what did *this*
  // session just write" rather than whatever was open first — which means it
  // has to recompute when pane focus moves, not only when a session appears.
  const tabs = useStore((s) => s.tabs)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const sizing = usePanelWidth({ preferred: prefs.previewWidth ?? 460, resetValue: 460, min: 160, max: 1400, reserve: 400, commit: (width) => { void api.setPrefs({ previewWidth: width }) } })
  const [dropping, setDropping] = useState(false)
  // A saved "preview visible" preference should not open an empty file pane
  // over the new home on startup. An actual document still opens from any view.
  const visible = prefs.previewVisible === true &&
    (experienceView === 'terminals' || !!pv.doc || pv.loading || !!pv.error)
  const home = useMemo(() => previewHomeDir(), [sessions, tabs, pv.doc])
  // Recomputed on every store change and compared by value, so this fires when
  // pane focus moves and not when something unrelated happens.
  const focusedSession = useStore(() => activeSessionId())

  // The generated document talks back: where it is scrolled, and where a link
  // it just swallowed a click for was pointing.
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return
      const data = event.data as { wb?: string; y?: number; href?: string }
      if (!data || typeof data.wb !== 'string') return
      const path = useStore.getState().preview.doc?.path
      if (data.wb === 'scroll' && path && typeof data.y === 'number') {
        useStore.getState().rememberPreviewScroll(path, data.y)
      } else if (data.wb === 'open' && typeof data.href === 'string') {
        void preview.followLink(data.href)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Follow the open file only while it is actually on screen and following is
  // on. Stated as a plain function of UI state, so hiding the pane stops the
  // poll and showing it again resumes it without anyone having to remember.
  useEffect(() => {
    // A virtual document has no file to follow, and asking main to watch the
    // repository root it is named after would fail on every diff.
    const path = pv.doc?.virtual ? null : (pv.doc?.path ?? null)
    const wanted = visible && prefs.previewFollowFile !== false ? path : null
    void api.previewWatch(wanted)
  }, [visible, pv.doc?.path, pv.doc?.virtual, prefs.previewFollowFile])

  // The dock belongs to the focused chat. Moving between panes swaps the
  // document for that chat's own — already rendered, because it was built when
  // the agent produced it rather than when you got round to looking.
  useEffect(() => {
    preview.followFocus(focusedSession)
  }, [focusedSession])

  // An empty pane is a prompt, not a void: show what changed here recently.
  useEffect(() => {
    if (!visible || pv.doc || !home) return
    void preview.loadRecents(home)
  }, [visible, pv.doc, home])

  if (!visible) return null

  const width = sizing.width

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDropping(false)
    const file = e.dataTransfer?.files?.[0]
    if (!file) return
    const path = api.pathForFile(file)
    if (path) void preview.open(path)
    else useStore.getState().setToast('Drop a file that lives on disk.', 'error')
  }

  return (
    <div className="preview" ref={sizing.ref} style={{ width }}>
      <ResizeHandle label="Preview width" className="resize-handle--left" value={width} min={160} max={sizing.maximum} onDelta={(delta) => sizing.resize(-delta)} onEnd={sizing.finish} onReset={sizing.reset} />

      <Header doc={pv.doc} following={prefs.previewFollowFile !== false} />

      {pv.doc && !pv.doc.virtual && pv.doc.kind !== 'url' && (
        <div className="preview__file-actions" role="group" aria-label="File actions">
          <button className="btn" title="Open with the system app"
            onClick={() => void runFileAction(() => api.previewOpenInDefaultApp(pv.doc!.path))}>
            <Icon name="external" size={13} /> Open
          </button>
          <button className="btn" onClick={() => void saveFileCopy(pv.doc!.path)}>
            <Icon name="download" size={13} /> Save a copy
          </button>
          <button className="btn" title="Show this file in its folder"
            onClick={() => void runFileAction(() => api.previewRevealInFolder(pv.doc!.path))}>
            <Icon name="folder" size={13} /> Show in folder
          </button>
          <span className="preview__drag-file" draggable
            title="Drag the original file into another app or an upload area"
            onDragStart={(event) => dragPreviewFile(event, pv.doc!.path)}>
            Drag file ↗
          </span>
        </div>
      )}

      <div
        className={`preview__body${dropping ? ' preview__body--dropping' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDropping(true)
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={onDrop}
      >
        {pv.error ? (
          <div className="preview__empty">
            <div className="preview__empty-title">Could not open that</div>
            <div className="preview__empty-note">{pv.error}</div>
            <button className="btn" onClick={() => void preview.openDialog()}>
              Choose another file…
            </button>
          </div>
        ) : pv.loading && !pv.doc ? (
          <div className="preview__empty">
            <div className="preview__empty-note">Opening…</div>
          </div>
        ) : pv.doc && pv.url ? (
          <PreviewViewer
            key={pv.doc.kind === 'url' ? `${pv.url}#${pv.frameNonce}` : pv.url}
            url={pv.url}
            kind={pv.doc.kind}
            name={pv.doc.name}
            frameRef={frameRef}
            onImageDragStart={!pv.doc.virtual ? (event) => dragPreviewFile(event, pv.doc!.path) : undefined}
          />
        ) : (
          <EmptyState home={home} />
        )}
      </div>

      {pv.doc && (
        <div className="preview__footer" title={pv.doc.path}>
          {/* A URL is already short and every part of it matters — shortening
              it the way a file path is shortened would hide the port. */}
          <span className="preview__footer-path">
            {pv.doc.kind === 'url' ? pv.doc.path : shortPath(pv.doc.path)}
          </span>
          <span className="preview__footer-meta">
            {pv.doc.kind === 'url' ? (
              <>
                served live
                <button
                  className="preview__footer-action"
                  title="Open this address in your browser"
                  onClick={() => void api.openExternal(pv.doc?.path ?? '')}
                >
                  Open in browser
                </button>
              </>
            ) : pv.doc.virtual ? (
              <>
                {formatSize(pv.doc.size)} of patch
                <button
                  className="preview__footer-action"
                  title="Fork a child session and ask it to review this diff"
                  onClick={() => void actions.reviewOpenDiff()}
                >
                  Review this diff
                </button>
              </>
            ) : (
              <>
                {formatSize(pv.doc.size)} · {relTime(pv.doc.mtimeMs)}
              </>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

function Header({ doc, following }: { doc: PreviewDoc | null; following: boolean }): JSX.Element {
  return (
    <div className="preview__header">
      <Icon name={doc ? KIND_ICON[doc.kind] : 'preview'} size={14} />
      <div className="preview__title" title={doc?.path ?? 'Preview'}>
        {doc?.name ?? 'Preview'}
      </div>
      {doc && <span className="preview__kind">{KIND_LABEL[doc.kind]}</span>}

      <div className="preview__spacer" />

      {doc && (
        <>
          {/* Following, attaching and opening externally are all about a file
              on disk. A generated diff has none, so those buttons would be
              lies; refresh survives because for a diff it means "ask git
              again", which is exactly what you want after staging. */}
          {!doc.virtual && (
            <button
              className={`iconbtn${following ? ' iconbtn--on' : ''}`}
              title={
                following
                  ? 'Following the file — it re-renders when it changes'
                  : 'Not following the file'
              }
              onClick={() => void api.setPrefs({ previewFollowFile: !following })}
            >
              <Icon name="eye" />
            </button>
          )}
          <button
            className="iconbtn"
            title={
              doc.kind === 'url'
                ? 'Reload the page'
                : doc.virtual
                  ? 'Ask git again'
                  : 'Re-read from disk'
            }
            onClick={() => void preview.refresh()}
          >
            <Icon name="refresh" />
          </button>
          {!doc.virtual && (
            <>
              <button
                className="iconbtn"
                title="Type this path into the focused session"
                onClick={() => void preview.attachToSession()}
              >
                <Icon name="terminal" />
              </button>
            </>
          )}
        </>
      )}

      <button className="iconbtn" title="Open a file… (⌘⌥O)" onClick={() => void preview.openDialog()}>
        <Icon name="folder" />
      </button>
      <button
        className="iconbtn"
        title="Hide the preview (⌘P)"
        onClick={() => void api.setPrefs({ previewVisible: false })}
      >
        <Icon name="close" />
      </button>
    </div>
  )
}

/** What the pane says when nothing is open: whatever changed here most recently. */
function EmptyState({ home }: { home: string | null }): JSX.Element {
  const recents = useStore((s) => s.preview.recents)

  return (
    <div className="preview__empty">
      <div className="preview__empty-title">Nothing open</div>
      <div className="preview__empty-note">
        Drop a file here, pick one, or open something an agent just wrote.
        {' '}Markdown, HTML artifacts, images, PDFs, CSV and JSON all render.
      </div>
      <div className="preview__empty-actions">
        <button className="btn btn--primary" onClick={() => void preview.openDialog()}>
          Open a file…
        </button>
        {home && (
          <button
            className="btn btn--ghost"
            onClick={() => {
              useStore.getState().setPreview({ recentsDir: null })
              void preview.loadRecents(home)
            }}
          >
            <Icon name="refresh" size={13} /> Rescan
          </button>
        )}
      </div>

      {home && (
        <div className="preview__recents">
          <div className="preview__recents-head">
            Recently changed in {shortPath(home)}
          </div>
          {recents.length === 0 ? (
            <div className="preview__empty-note">Nothing here that this pane can render yet.</div>
          ) : (
            recents.map((entry) => (
              <button
                key={entry.path}
                className="preview__recent"
                title={entry.path}
                onClick={() => void preview.open(entry.path)}
              >
                <Icon name={KIND_ICON[entry.kind]} size={13} />
                <span className="preview__recent-name">{entry.name}</span>
                <span className="preview__recent-time">{relTime(entry.mtimeMs)}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
