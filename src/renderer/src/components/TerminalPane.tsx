import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX, MutableRefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { useStore } from '../state/store'
import { subscribePty } from '../lib/ptyBus'
import { paneOrder, sessionIdsIn } from '../lib/layout'
import { actions } from '../lib/actions'
import { preview } from '../lib/preview'
import { clipboardAttachmentText, useAttachTarget } from '../lib/attachments'
import {
  accel,
  clipboardAccel,
  isTerminalCopyShortcut,
  isTerminalPasteShortcut,
  PERMISSION_LABEL,
  secondaryAccel,
  shortPath
} from '../lib/ui'
import { useAgentColor, useAgentLabel, useLaunchableProfiles } from '../lib/agents'
import { STATUS_META } from '../../../shared/types'
import {
  clickToCell,
  cursorMoveSequence,
  selectionDeleteSequence
} from '../../../shared/cursorMove'
import { serverLabel } from '../../../shared/localhost'
import { formatTokens, percentLeft } from '../../../shared/context'
import type { ContextUsage } from '../../../shared/context'
import type { PaneView, Prefs, Session, Tab } from '../../../shared/types'
import { Icon } from './Icon'
import { useContextMenu } from './ContextMenu'

const api = window.term

/**
 * Puts the clipboard into a session, preferring the terminal's own paste.
 *
 * `term.paste` is what wraps the text in bracketed-paste markers when the
 * program has asked for them. A raw pty write skips that framing, and both
 * Claude and Codex read an unframed multi-line paste as several *submitted*
 * lines — the paste runs itself. The raw write survives only as the fallback
 * for a pane whose terminal has not mounted, where the choice is between
 * unframed text and nothing at all.
 *
 * An empty text clipboard is not an empty clipboard: an image goes down the
 * attachment path instead, the same one a drop onto the pane uses.
 */
async function pasteInto(term: Terminal | null, sessionId: string): Promise<void> {
  const write = (text: string): void => {
    if (term) term.paste(text)
    else api.ptyWrite(sessionId, text)
  }
  const text = await api.readClipboard()
  if (text) {
    write(text)
    return
  }
  const attachment = await clipboardAttachmentText()
  if (attachment) write(attachment)
}

/**
 * Neutral text and selection match the shell. ANSI colours remain distinct
 * because terminal programs use them to convey diffs, warnings and syntax.
 */
const XTERM_THEME: ITheme = {
  background: '#1f1f1f',
  foreground: '#dedede',
  cursor: '#f5f5f5',
  cursorAccent: '#1f1f1f',
  selectionBackground: '#ffffff30',
  black: '#1f1f1f',
  red: '#f14c4c',
  green: '#23d18b',
  yellow: '#e2b93d',
  blue: '#3b8eea',
  magenta: '#d670d6',
  cyan: '#29b8db',
  white: '#cccccc',
  brightBlack: '#6e7681',
  brightRed: '#ff6b6b',
  brightGreen: '#3fb950',
  brightYellow: '#f5d76e',
  brightBlue: '#61afef',
  brightMagenta: '#e39ef7',
  brightCyan: '#56d4f0',
  brightWhite: '#ffffff'
}

interface Props {
  paneId: string
  sessionId: string | null
  tab: Tab
  zoomed?: boolean
}

export function TerminalPane({ paneId, sessionId, tab, zoomed }: Props): JSX.Element {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId))
  const prefs = useStore((s) => s.prefs)
  const focused = (tab.activePaneId ?? tab.layout.id) === paneId
  const ctx = useContextMenu()

  // The context menu is built here; the xterm instance lives in TerminalView,
  // one component down. Copy and Paste both need it — see `pasteInto`, and note
  // that with the WebGL renderer a terminal selection never reaches the DOM, so
  // `window.getSelection()` alone comes back empty.
  const termRef = useRef<Terminal | null>(null)

  // Attachments go to this pane's session only, never to the broadcast set —
  // "look at this screenshot" is aimed at one agent by construction.
  const live = sessionId && session?.alive ? sessionId : null
  const attach = useAttachTarget(live ? (text) => api.ptyWrite(live, text) : null)

  return (
    <div
      className={`pane${focused ? ' pane--focused' : ''}${attach.active ? ' pane--dropping' : ''}`}
      // Directional navigation measures panes off the DOM; this is the handle.
      data-pane-id={paneId}
      onMouseDown={() => useStore.getState().focusPane(paneId)}
      onDragEnter={attach.onDragEnter}
      onDragOver={attach.onDragOver}
      onDragLeave={attach.onDragLeave}
      onDrop={attach.onDrop}
      onPasteCapture={attach.onPaste}
      onContextMenu={(e) =>
        ctx.open(e, [
          {
            label: 'Copy',
            hint: clipboardAccel('copy'),
            onSelect: () => {
              const sel = termRef.current?.getSelection() || window.getSelection()?.toString()
              if (sel) void api.writeClipboard(sel)
            }
          },
          {
            label: 'Paste',
            hint: clipboardAccel('paste'),
            onSelect: () => {
              if (sessionId) void pasteInto(termRef.current, sessionId)
            }
          },
          {
            label: 'Paste as attachment',
            onSelect: () => {
              if (!live) return
              void clipboardAttachmentText().then((t) => t && api.ptyWrite(live, t))
            }
          },
          { separator: true },
          {
            label: 'New visual pane',
            hint: '⌘F',
            onSelect: () => void actions.openVisualPane()
          },
          { label: 'Split right', hint: '⌘D', onSelect: () => useStore.getState().split('h') },
          { label: 'Split down', hint: '⌘⇧D', onSelect: () => useStore.getState().split('v') },
          {
            label: zoomed ? 'Unzoom pane' : 'Zoom pane',
            hint: '⌘⇧↩',
            onSelect: () => useStore.getState().toggleZoom()
          },
          ...(sessionId
            ? [
                {
                  label: 'Minimize pane',
                  onSelect: () => useStore.getState().minimizePane(paneId)
                }
              ]
            : []),
          { separator: true },
          ...(sessionId
            ? [
                {
                  label: 'Fork child session',
                  hint: '⌘⇧F',
                  onSelect: () => actions.openFork('child')
                },
                {
                  label: 'Copy tmux attach command',
                  onSelect: () => void actions.attachInITerm(sessionId)
                },
                { separator: true as const }
              ]
            : []),
          {
            label: 'Close pane',
            hint: '⌘W',
            danger: true,
            onSelect: () => useStore.getState().closePane(paneId)
          }
        ])
      }
    >
      <PaneHeader
        session={session}
        paneId={paneId}
        index={paneOrder(tab.layout).indexOf(paneId) + 1}
        zoomed={!!zoomed}
        focused={focused}
        view="terminal"
      />

      {session?.status === 'waiting' && (
        <div className="pane__banner">
          <span className="dot dot--waiting" />
          <span style={{ flex: 1 }}>
            {session.statusReason ?? 'This session is waiting on your response.'}
          </span>
        </div>
      )}
      {/* A failure is not a question. It gets its own banner and its own words,
          plus the one control that actually helps: clear the state and move on. */}
      {session?.status === 'failed' && (
        <div className="pane__banner pane__banner--failed">
          <span className="dot dot--failed" />
          <span style={{ flex: 1 }}>
            {session.statusReason ?? 'This session stopped with an error.'}
          </span>
          <button className="btn btn--ghost" onClick={() => void api.clearStatus(session.id)}>
            Dismiss
          </button>
        </div>
      )}
      {session && !session.alive && (
        <div className="pane__banner pane__banner--exited">
          <span className="dot dot--exited" />
          <span style={{ flex: 1 }}>
            Session exited{session.exitCode !== null ? ` (code ${session.exitCode})` : ''}.
          </span>
          <button className="btn btn--ghost" onClick={() => void actions.restart(session.id)}>
            <Icon name="refresh" size={12} /> Restart
          </button>
        </div>
      )}

      {sessionId && session?.alive ? (
        <TerminalView
          key={sessionId}
          termRef={termRef}
          sessionId={sessionId}
          paneId={paneId}
          tab={tab}
          prefs={prefs}
          focused={focused}
        />
      ) : (
        <EmptyPane paneId={paneId} session={session} />
      )}

      {session?.alive && <PaneFooter session={session} />}

      {attach.active && (
        <div className="pane__drop">
          <Icon name="plus" size={16} />
          Drop to attach — the paths go into the prompt
        </div>
      )}
      {ctx.node}
    </div>
  )
}

/** The agent's short name in its own colour. Looked up, never hardcoded. */
function AgentChip({ agent }: { agent: string }): JSX.Element {
  const color = useAgentColor(agent)
  const label = useAgentLabel(agent)
  return (
    <span className="srow__agent" style={{ color, background: '#ffffff0f' }}>
      {label}
    </span>
  )
}

export function PaneHeader({
  session,
  paneId,
  index,
  zoomed,
  focused,
  view
}: {
  session: Session | undefined
  paneId: string
  index: number
  zoomed: boolean
  focused: boolean
  view: PaneView
}): JSX.Element {
  const meta = session ? STATUS_META[session.status] : null
  // A worktree lives under Application Support, and that path tells you nothing
  // useful. The branch does: it is how you know this agent is not editing your
  // checkout. The full path stays available on hover.
  const workspace = useStore((s) =>
    session?.workspaceId ? s.workspaces.find((w) => w.id === session.workspaceId) : undefined
  )
  const where =
    workspace?.kind === 'worktree' && workspace.branch
      ? `⎇ ${workspace.branch}`
      : session
        ? shortPath(session.cwd)
        : ''
  return (
    <div className="pane__header">
      {/* The number is the shortcut. Printing it is what turns ⌃4 from a thing
          you count out into a thing you read off the screen. On the *other*
          modifier since ⌘1…⌘9 went to the sidebar's sessions — the pane's
          position on screen is the thing you reach for less. */}
      {index > 0 && index < 10 && (
        <span
          className="pane__num"
          title={`Jump to this pane (${secondaryAccel(String(index))})`}
        >
          {index}
        </span>
      )}
      {session && <span className={`dot dot--${session.status}`} />}
      {session && <AgentChip agent={session.agent} />}
      <span className="pane__title" title={session ? `${where}\n${session.cwd}` : undefined}>
        {session ? <>{session.title}{workspace?.kind === 'worktree' && workspace.branch && <small style={{ display: 'block', fontSize: 10 }}>{where}</small>}</> : view === 'visual' ? 'Visual pane' : 'Empty pane'}
      </span>
      {view === 'visual' && <span className="pane__mode">visual</span>}
      {meta && (
        <span className="pane__status" style={{ color: meta.color }}>
          {meta.label}
        </span>
      )}
      {(view === 'visual' || session?.agent !== 'shell') && (
        <button
          className={`iconbtn${view === 'visual' ? ' iconbtn--on' : ''}`}
          title={view === 'visual' ? 'Show terminal transcript' : 'Show visual canvas'}
          onClick={(e) => {
            e.stopPropagation()
            useStore.getState().focusPane(paneId)
            useStore.getState().setPaneView(paneId, view === 'visual' ? 'terminal' : 'visual')
          }}
        >
          <Icon name={view === 'visual' ? 'terminal' : 'image'} size={13} />
        </button>
      )}
      {/* Forking with real conversation inheritance is the thing Workbench does
          that a pane-of-terminals cannot, and until now it only existed as a
          line in the command palette. It belongs next to the session it forks. */}
      {session && (
        <button
          className="iconbtn"
          title="Fork a child session with this one's context (⌘⇧F)"
          onClick={(e) => {
            e.stopPropagation()
            useStore.getState().focusPane(paneId)
            actions.openFork('child')
          }}
        >
          <Icon name="fork" size={13} />
        </button>
      )}
      {session?.alive && (
        <button
          className="iconbtn"
          title="Interrupt (⌘.)"
          onClick={(e) => {
            e.stopPropagation()
            void api.interruptSession(session.id)
          }}
        >
          <Icon name="stop" size={12} />
        </button>
      )}
      {session && (
        <button
          className="iconbtn"
          title="Minimize to a chip — the session keeps running"
          onClick={(e) => {
            e.stopPropagation()
            useStore.getState().minimizePane(paneId)
          }}
        >
          <Icon name="minimize" size={13} />
        </button>
      )}
      <button
        className={`iconbtn${zoomed ? ' iconbtn--on' : ''}`}
        title="Zoom pane (⌘⇧↩)"
        onClick={(e) => {
          e.stopPropagation()
          useStore.getState().focusPane(paneId)
          useStore.getState().toggleZoom()
        }}
      >
        <Icon name="zoom" size={13} />
      </button>
      <button
        className="iconbtn"
        title="Close pane (⌘W)"
        onClick={(e) => {
          e.stopPropagation()
          useStore.getState().closePane(paneId)
        }}
        style={{ opacity: focused ? 1 : 0.7 }}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  )
}

/**
 * The line under the terminal: what this agent actually *is*.
 *
 * The header answers "which session is this, and what is it doing". This
 * answers the three things chosen at launch and then invisible for the rest of
 * the session's life — which model, how much it is allowed to do unsupervised,
 * and where it is writing. Permission mode leads because it is the one that
 * costs you if you forget it, and `full access` is styled as a warning for the
 * same reason: an agent editing your checkout with no prompts should never be
 * indistinguishable from one that asks.
 */
function PaneFooter({ session }: { session: Session }): JSX.Element {
  const workspace = useStore((s) =>
    session.workspaceId ? s.workspaces.find((w) => w.id === session.workspaceId) : undefined
  )
  const full = session.permissionMode === 'full-access'

  return (
    <div className="pane__footer">
      <span
        className={`pane__footer-item${full ? ' pane__footer-item--warn' : ''}`}
        title={
          full
            ? 'This agent runs commands and edits files with no approval prompts.'
            : 'How much this agent may do without asking.'
        }
      >
        {PERMISSION_LABEL[session.permissionMode]}
      </span>

      {/* A pinned model is worth naming; an unpinned one is whatever the CLI
          defaults to today, and guessing at it here would be a lie. */}
      {session.model && (
        <span className="pane__footer-item" title="Model this session was launched with">
          {session.model}
          {session.effort ? ` · ${session.effort}` : ''}
        </span>
      )}

      {workspace?.branch && (
        <span className="pane__footer-item" title={workspace.path}>
          ⎇ {workspace.branch}
        </span>
      )}

      {session.context && <ContextChip context={session.context} />}

      {/* Read out of this session's own output. It stays until the pane dies,
          because "what port did it come up on" is a question you ask twenty
          minutes after the line that answered it has scrolled away. */}
      {session.serverUrl && (
        <button
          className="pane__footer-item pane__footer-item--link"
          title={`${session.serverUrl} — open it in the preview pane`}
          onClick={() => preview.openUrl(session.serverUrl as string, { owner: session.id })}
        >
          <Icon name="globe" size={10} strokeWidth={1.5} /> {serverLabel(session.serverUrl)}
        </button>
      )}

      <span className="pane__footer-spacer" />
      <span className="pane__footer-item pane__footer-item--dim" title={session.cwd}>
        {shortPath(session.cwd)}
      </span>
    </div>
  )
}

/**
 * How much room this conversation has left.
 *
 * Two shapes, because the two CLIs write down different amounts. When the
 * transcript names a ceiling this is a percentage, which is the number you
 * actually act on; when it does not, it is the token count, which is true. It
 * never becomes a percentage of a window we guessed — see `shared/context.ts`.
 */
function ContextChip({ context }: { context: ContextUsage }): JSX.Element {
  const left = percentLeft(context)
  const used = formatTokens(context.tokens)

  if (left === null) {
    return (
      <span
        className="pane__footer-item pane__footer-item--dim"
        title={`${context.tokens.toLocaleString()} tokens in this conversation. How much fits is not written down until the session compacts once, so this is a count rather than a percentage.`}
      >
        {used} ctx
      </span>
    )
  }

  return (
    <span
      className={`pane__footer-item${left <= 15 ? ' pane__footer-item--warn' : ''}`}
      title={`${context.tokens.toLocaleString()} of about ${(context.limit as number).toLocaleString()} tokens. Past that the conversation is compacted and the earliest part of it is summarised away.`}
    >
      {left}% left
    </span>
  )
}

function EmptyPane({
  paneId,
  session
}: {
  paneId: string
  session: Session | undefined
}): JSX.Element {
  // The shell is startable too, but it is not what an empty pane is offering:
  // the question here is "which assistant", and the shell has its own button.
  const starters = useLaunchableProfiles().filter((p) => p.id !== 'shell')
  return (
    <div className="pane__empty">
      {session ? (
        <span>This session is no longer running.</span>
      ) : (
        <>
          <span>No session in this pane</span>
          <div className="pane__empty-actions">
            {/* One button per agent this machine can actually start, so an
                agent added in Settings appears here without touching this file. */}
            {starters.map((p) => (
              <button
                key={p.id}
                className="btn"
                onClick={() => {
                  useStore.getState().focusPane(paneId)
                  actions.openNewSession(p.id)
                }}
              >
                <span style={{ color: p.color }}>●</span> Start {p.label}
              </button>
            ))}
            <button
              className="btn btn--ghost"
              onClick={() => useStore.getState().setOverlay({ kind: 'switcher' })}
            >
              Pick existing…
            </button>
          </div>
          {/* An empty pane is the only screen a new user is guaranteed to look
              at, so it is where the shortcuts that are otherwise buried in a
              menu belong. */}
          <div className="pane__empty-hints">
            <span>
              <kbd>{accel('CmdOrCtrl+K')}</kbd> commands
            </span>
            <span>
              <kbd>{accel('CmdOrCtrl+Shift+P')}</kbd> go to session
            </span>
            <span>
              <kbd>{accel('CmdOrCtrl+Shift+A')}</kbd> next needing you
            </span>
            <span>
              <kbd>{accel('CmdOrCtrl+Shift+F')}</kbd> fork with context
            </span>
          </div>
        </>
      )}
    </div>
  )
}

/** The xterm instance. Remounted (via key) whenever the pane changes session. */
function TerminalView({
  termRef,
  sessionId,
  paneId,
  tab,
  prefs,
  focused
}: {
  termRef: MutableRefObject<Terminal | null>
  sessionId: string
  paneId: string
  tab: Tab
  prefs: Prefs
  focused: boolean
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const findOpen = useStore((s) => s.findOpen)
  const [findResult, setFindResult] = useState('')

  // Live refs so the xterm callbacks always see current prefs/layout without
  // tearing down the terminal on every store update.
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const tabRef = useRef(tab)
  tabRef.current = tab

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      allowProposedApi: true,
      fontFamily:
        prefs.fontFamily || "'SF Mono', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
      fontSize: prefs.fontSize || 12,
      lineHeight: prefs.lineHeight || 1.2,
      cursorBlink: prefs.cursorBlink !== false,
      cursorStyle: 'block',
      scrollback: prefs.scrollback || 100000,
      screenReaderMode: prefs.terminalAccessibility !== false,
      macOptionIsMeta: true,
      // Workbench implements this itself below, on whichever gesture the user
      // picked. Leaving xterm's version on would send the arrows twice.
      altClickMovesCursor: false,
      theme: XTERM_THEME,
      // tmux repaints the whole screen, so let it own the alt-buffer semantics.
      windowsMode: false
    })

    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(
      new WebLinksAddon((_e, uri) => {
        void api.openExternal(uri)
      })
    )
    const unicode = new Unicode11Addon()
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'

    term.open(host)
    // Give native accessibility and dictation clients a stable editable target.
    // xterm still owns input, composition, and bracketed-paste handling; copying
    // a second invisible prompt here would let the two drafts drift apart.
    if (term.textarea) {
      term.textarea.setAttribute('aria-label', 'Workbench terminal input')
      term.textarea.setAttribute('aria-description', 'Terminal input. Use the prompt composer to review a long dictation before sending.')
    }
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      /* falls back to the canvas renderer */
    }

    // Clipboard chords have to be taken before xterm turns them into control
    // bytes and marks the event handled; `isTerminalPasteShortcut` explains why
    // the Edit menu cannot do it on Windows and Linux. `preventDefault` matters
    // as much as the `false` return: it is what stops Electron's own paste
    // accelerator from firing afterwards and pasting a second copy.
    term.attachCustomKeyEventHandler((event) => {
      if (
        event.type === 'keydown' &&
        (event.key === 'Backspace' || event.key === 'Delete') &&
        !event.metaKey && !event.ctrlKey && !event.altKey &&
        term.hasSelection()
      ) {
        event.preventDefault()
        event.stopPropagation()

        const selection = term.getSelectionPosition()
        const buffer = term.buffer.active
        const cursorRow = buffer.baseY + buffer.cursorY
        let editableStartRow = cursorRow
        let editableEndRow = cursorRow
        while (editableStartRow > 0 && buffer.getLine(editableStartRow)?.isWrapped) {
          editableStartRow -= 1
        }
        while (
          editableEndRow + 1 < buffer.length &&
          buffer.getLine(editableEndRow + 1)?.isWrapped
        ) {
          editableEndRow += 1
        }

        const deletion = selection
          ? selectionDeleteSequence({
              startRow: selection.start.y,
              startCol: selection.start.x,
              endRow: selection.end.y,
              endCol: selection.end.x,
              cursorRow,
              cursorCol: buffer.cursorX,
              editableStartRow,
              editableEndRow,
              cols: term.cols
            })
          : ''

        if (deletion) {
          term.clearSelection()
          // Like click-to-move, this edit belongs only to the pane selected in.
          api.ptyWrite(sessionId, deletion)
        } else {
          useStore.getState().setToast(
            'Terminal history is read-only. Select text in the current prompt to delete it.',
            'info'
          )
        }
        return false
      }
      if (isTerminalPasteShortcut(event)) {
        event.preventDefault()
        event.stopPropagation()
        void pasteInto(term, sessionId).catch((err: unknown) => {
          useStore.getState().setToast(`Could not paste: ${(err as Error).message}`, 'error')
        })
        return false
      }
      if (isTerminalCopyShortcut(event)) {
        // With nothing selected the chord is not ours to take; the program may
        // want it, and copying an empty string over the clipboard is worse than
        // doing nothing.
        if (!term.hasSelection()) return true
        event.preventDefault()
        event.stopPropagation()
        void api.writeClipboard(term.getSelection())
        return false
      }
      return true
    })

    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    fit.fit()
    api.ptyAttach(sessionId, term.cols, term.rows)

    const offData = subscribePty(sessionId, (data) => term.write(data))

    term.onData((data) => {
      // iTerm2's "send input to all panes", scoped to the current tab.
      if (prefsRef.current.broadcastInput) {
        for (const id of sessionIdsIn(tabRef.current.layout)) api.ptyWrite(id, data)
      } else {
        api.ptyWrite(sessionId, data)
      }
    })

    term.onSelectionChange(() => {
      if (prefsRef.current.copyOnSelect && term.hasSelection()) {
        void api.writeClipboard(term.getSelection())
      }
    })

    // ── click to move the text cursor ──────────────────────────────────────
    //
    // xterm ships this for ⌥-click, but only when the viewport is scrolled to
    // the bottom and only on that one modifier. Doing it here means it can also
    // be a plain click, which is what makes editing a long prompt bearable.
    const screen = host.querySelector('.xterm-screen') as HTMLElement | null
    let downAt = 0
    let downX = 0
    let downY = 0

    const onMouseDown = (e: MouseEvent): void => {
      downAt = e.timeStamp
      downX = e.clientX
      downY = e.clientY
    }

    const onMouseUp = (e: MouseEvent): void => {
      const mode = prefsRef.current.clickToMoveCursor ?? 'click'
      if (mode === 'off' || e.button !== 0) return
      if (mode === 'alt' && !e.altKey) return
      // A drag is a selection, and a long press is probably one too.
      if (e.timeStamp - downAt > 500) return
      if (Math.abs(e.clientX - downX) > 3 || Math.abs(e.clientY - downY) > 3) return
      if (term.hasSelection()) return
      // If the TUI asked for mouse events, it is placing its own cursor and
      // xterm is already forwarding the click. Injecting arrows too would
      // double the move.
      if (term.modes.mouseTrackingMode !== 'none') return
      if (!screen) return

      const cell = clickToCell({
        x: e.clientX,
        y: e.clientY,
        rect: screen.getBoundingClientRect(),
        cols: term.cols,
        rows: term.rows
      })
      if (!cell) return

      const buf = term.buffer.active
      const seq = cursorMoveSequence({
        targetRow: buf.viewportY + cell.row,
        targetCol: cell.col,
        cursorRow: buf.baseY + buf.cursorY,
        cursorCol: buf.cursorX,
        cols: term.cols
      })
      // Never broadcast a cursor move: it is aimed at one composer.
      if (seq) api.ptyWrite(sessionId, seq)
    }

    host.addEventListener('mousedown', onMouseDown)
    host.addEventListener('mouseup', onMouseUp)

    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        try {
          fit.fit()
          api.ptyResize(sessionId, term.cols, term.rows)
        } catch {
          /* pane is mid-teardown */
        }
      })
    })
    ro.observe(host)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      host.removeEventListener('mousedown', onMouseDown)
      host.removeEventListener('mouseup', onMouseUp)
      offData()
      api.ptyDetach(sessionId)
      term.dispose()
      termRef.current = null
    }
  }, [sessionId])

  // Live-apply appearance changes without dropping the tmux client.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = prefs.fontSize || 12
    term.options.lineHeight = prefs.lineHeight || 1.2
    term.options.cursorBlink = prefs.cursorBlink !== false
    term.options.scrollback = prefs.scrollback || 100000
    term.options.screenReaderMode = prefs.terminalAccessibility !== false
    if (prefs.fontFamily) term.options.fontFamily = prefs.fontFamily
    try {
      fitRef.current?.fit()
      api.ptyResize(sessionId, term.cols, term.rows)
    } catch {
      /* ignore */
    }
  }, [
    prefs.fontSize,
    prefs.lineHeight,
    prefs.cursorBlink,
    prefs.fontFamily,
    prefs.scrollback,
    prefs.terminalAccessibility,
    sessionId
  ])

  useEffect(() => {
    if (focused) termRef.current?.focus()
  }, [focused])

  const runSearch = (q: string, back = false): void => {
    const s = searchRef.current
    if (!s) return
    if (!q) {
      s.clearDecorations()
      setFindResult('')
      return
    }
    const opts = {
      decorations: {
        matchBackground: '#623315',
        activeMatchBackground: '#a86b28',
        matchOverviewRuler: '#e2b93d',
        activeMatchColorOverviewRuler: '#f5d76e'
      }
    }
    const hit = back ? s.findPrevious(q, opts) : s.findNext(q, opts)
    setFindResult(hit ? '' : 'no results')
  }

  return (
    <div className="pane__term" ref={hostRef} style={{ position: 'relative' }}>
      {findOpen && focused && (
        <FindBar
          result={findResult}
          onSearch={runSearch}
          onClose={() => {
            searchRef.current?.clearDecorations()
            useStore.getState().setFindOpen(false)
            termRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}

function FindBar({
  result,
  onSearch,
  onClose
}: {
  result: string
  onSearch: (q: string, back?: boolean) => void
  onClose: () => void
}): JSX.Element {
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])

  return (
    <div className="findbar" onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        value={q}
        placeholder="Find in scrollback"
        onChange={(e) => {
          setQ(e.target.value)
          onSearch(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSearch(q, e.shiftKey)
          if (e.key === 'Escape') onClose()
        }}
      />
      <span className="findbar__count">{result || (q ? 'match' : '')}</span>
      <button className="iconbtn" title="Previous (⇧⏎)" onClick={() => onSearch(q, true)}>
        <Icon name="chevron" size={12} />
      </button>
      <button
        className="iconbtn"
        title="Next (⏎)"
        onClick={() => onSearch(q)}
        style={{ transform: 'rotate(180deg)' }}
      >
        <Icon name="chevron" size={12} />
      </button>
      <button className="iconbtn" title="Close (Esc)" onClick={onClose}>
        <Icon name="close" size={12} />
      </button>
    </div>
  )
}
