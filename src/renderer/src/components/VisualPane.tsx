import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { paneOrder } from '../lib/layout'
import { actions } from '../lib/actions'
import { useAttachTarget } from '../lib/attachments'
import { shortPath } from '../lib/ui'
import { useLaunchableProfiles } from '../lib/agents'
import { isVisualPreviewKind, visualPrompt } from '../../../shared/visual'
import type { LayoutNode, PreviewDoc, Session, Tab } from '../../../shared/types'
import { Icon } from './Icon'
import { PaneHeader } from './TerminalPane'
import { PreviewViewer } from './PreviewViewer'

const api = window.term

type VisualLeaf = Extract<LayoutNode, { type: 'leaf' }>

interface Props {
  node: VisualLeaf
  tab: Tab
  zoomed?: boolean
}

/**
 * A conversation whose visible answer is a file, not a transcript.
 *
 * It deliberately shares the normal pane shell and the session behind it.
 * The agent still runs as an ordinary durable tmux session; this component
 * simply replaces xterm with the artifact that session most recently named.
 * That keeps every existing lifecycle, permission and recovery guarantee while
 * giving the interaction a completely different surface.
 */
export function VisualPane({ node, tab, zoomed }: Props): JSX.Element {
  const session = useStore((s) => s.sessions.find((item) => item.id === node.sessionId))
  const focused = (tab.activePaneId ?? tab.layout.id) === node.id

  return (
    <div
      className={`pane visual-pane${focused ? ' pane--focused' : ''}`}
      data-pane-id={node.id}
      onMouseDown={() => useStore.getState().focusPane(node.id)}
    >
      <PaneHeader
        session={session}
        paneId={node.id}
        index={paneOrder(tab.layout).indexOf(node.id) + 1}
        zoomed={!!zoomed}
        focused={focused}
        view="visual"
      />

      <VisualCanvas node={node} session={session} />

      {session?.status === 'waiting' && (
        <div className="visual-pane__attention">
          <span className="dot dot--waiting" />
          <span>The agent needs an interactive answer.</span>
          <button
            className="btn btn--ghost"
            onClick={() => useStore.getState().setPaneView(node.id, 'terminal')}
          >
            Show terminal
          </button>
        </div>
      )}

      {session?.status === 'failed' && (
        <div className="visual-pane__attention visual-pane__attention--failed">
          <span className="dot dot--failed" />
          <span>{session.statusReason ?? 'The visual session stopped with an error.'}</span>
          <button className="btn btn--ghost" onClick={() => void api.clearStatus(session.id)}>
            Dismiss
          </button>
        </div>
      )}

      <VisualComposer
        paneId={node.id}
        session={session}
        focused={focused}
        artifactPath={node.artifact?.path}
      />
    </div>
  )
}

function VisualCanvas({ node, session }: { node: VisualLeaf; session: Session | undefined }): JSX.Element {
  const [opened, setOpened] = useState<{ doc: PreviewDoc; url: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manualRevision, setManualRevision] = useState(0)

  useEffect(() => {
    const artifact = node.artifact
    if (!artifact?.path) {
      setOpened(null)
      setLoading(false)
      setError(null)
      return
    }

    let live = true
    setLoading(true)
    setError(null)
    void api.visualOpen(artifact.path).then(
      (doc) => {
        if (!live) return
        if (!isVisualPreviewKind(doc.kind)) {
          setOpened(null)
          setLoading(false)
          setError(`${doc.name} is a document, not a visual artifact.`)
          return
        }
        // A stable file path is the normal case. The changing query makes the
        // iframe or image perform a real navigation after every agent edit.
        const join = doc.url.includes('?') ? '&' : '?'
        setOpened({
          doc,
          url: `${doc.url}${join}visual=${Math.round(doc.mtimeMs)}-${artifact.revision}-${manualRevision}`
        })
        setLoading(false)
      },
      (err) => {
        if (!live) return
        setOpened(null)
        setLoading(false)
        setError((err as Error).message)
      }
    )
    return () => {
      live = false
    }
  }, [node.artifact?.path, node.artifact?.revision, manualRevision])

  return (
    <div className={`visual-pane__canvas${opened ? ' visual-pane__canvas--filled' : ''}`}>
      {opened ? (
        <PreviewViewer
          key={opened.url}
          url={opened.url}
          kind={opened.doc.kind}
          name={opened.doc.name}
          className="visual-pane__frame"
          imageClassName="visual-pane__image"
        />
      ) : (
        <VisualEmpty session={session} loading={loading} error={error} />
      )}

      {opened && (
        <div className="visual-pane__artifact" title={opened.doc.path}>
          <span>{opened.doc.name}</span>
          <button
            className="visual-pane__artifact-action"
            title="Reload visual"
            onClick={() => setManualRevision((value) => value + 1)}
          >
            <Icon name="refresh" size={12} />
          </button>
          <button
            className="visual-pane__artifact-action"
            title="Open with the system app"
            onClick={() => void api.previewOpenInDefaultApp(opened.doc.path)}
          >
            <Icon name="external" size={12} />
          </button>
        </div>
      )}
    </div>
  )
}

function VisualEmpty({
  session,
  loading,
  error
}: {
  session: Session | undefined
  loading: boolean
  error: string | null
}): JSX.Element {
  const starters = useLaunchableProfiles().filter((profile) => profile.id !== 'shell')

  return (
    <div className="visual-pane__empty">
      <div className="visual-pane__mesh" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="visual-pane__empty-copy">
        <span className="visual-pane__eyebrow">VISUAL MODE</span>
        <strong>
          {loading
            ? 'Opening the canvas…'
            : error
              ? 'The last visual could not be opened'
              : session
                ? 'Describe what you want to see'
                : 'Start an agent to make something'}
        </strong>
        <span>
          {error ??
            (session
              ? 'Each direction becomes the next version of one living artifact.'
              : 'The agent stays behind the canvas; only its visual work appears here.')}
        </span>
        {!session && (
          <div className="visual-pane__starters">
            {starters.map((profile) => (
              <button
                key={profile.id}
                className="btn"
                onClick={() => actions.openNewSession(profile.id)}
              >
                <span style={{ color: profile.color }}>●</span> Start {profile.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function VisualComposer({
  paneId,
  session,
  focused,
  artifactPath
}: {
  paneId: string
  session: Session | undefined
  focused: boolean
  artifactPath?: string
}): JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const busy = session?.status === 'working'
  const canSend = Boolean(
    text.trim() &&
      session?.alive &&
      session.agent !== 'shell' &&
      !busy &&
      session.status !== 'waiting'
  )

  const attach = useAttachTarget((chunk) => {
    const el = ref.current
    const start = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? start
    setText((current) => current.slice(0, start) + chunk + current.slice(end))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + chunk.length, start + chunk.length)
    })
  })

  // Creating a visual pane is an invitation to type. It should not require a
  // second click unless there is no session to receive the prompt yet.
  useEffect(() => {
    if (focused && session?.alive) ref.current?.focus()
  }, [focused, session?.id, session?.alive])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(130, el.scrollHeight)}px`
  }, [text])

  const send = async (): Promise<void> => {
    if (!canSend || !session || sending) return
    setSending(true)
    try {
      const [result] = await api.sendPrompt([session.id], visualPrompt(text, artifactPath))
      if (!result?.ok) throw new Error(result?.error ?? 'The agent did not accept the direction.')
      setText('')
    } catch (err) {
      useStore.getState().setToast(`Visual prompt not sent: ${(err as Error).message}`, 'error')
    } finally {
      setSending(false)
    }
  }

  const blocked = !session
    ? 'Start an agent above.'
    : session.agent === 'shell'
      ? 'Visual mode needs an agent session, not a shell.'
    : !session.alive
      ? 'Restart this session to keep creating.'
      : session.status === 'waiting'
        ? 'Answer the agent in terminal view.'
        : busy
          ? 'The agent is creating the next version.'
          : 'Describe a scene, diagram, composition, or change.'

  return (
    <div
      className={`visual-pane__composer${attach.active ? ' visual-pane__composer--dropping' : ''}`}
      onDragEnter={attach.onDragEnter}
      onDragOver={attach.onDragOver}
      onDragLeave={attach.onDragLeave}
      onDrop={attach.onDrop}
      onPasteCapture={attach.onPaste}
      onMouseDown={(event) => {
        useStore.getState().focusPane(paneId)
        if (!(event.target as HTMLElement).closest('button, textarea')) ref.current?.focus()
      }}
    >
      <div className="visual-pane__prompt-row">
        <span className="visual-pane__prompt-mark" aria-hidden="true">✦</span>
        <textarea
          ref={ref}
          value={text}
          rows={1}
          disabled={!session?.alive}
          aria-label="Visual direction"
          placeholder={blocked}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <button
          className="visual-pane__create"
          disabled={!canSend || sending}
          title={canSend ? 'Create the next visual' : blocked}
          onClick={() => void send()}
        >
          {sending || busy ? 'Creating…' : 'Create'}
        </button>
      </div>
      <div className="visual-pane__prompt-meta">
        <span>{session ? shortPath(session.cwd) : 'No session attached'}</span>
        <span>↵ create · ⇧↵ new line · paste or drop a reference</span>
      </div>
      {attach.active && <div className="visual-pane__drop">Drop to add this reference</div>}
    </div>
  )
}
