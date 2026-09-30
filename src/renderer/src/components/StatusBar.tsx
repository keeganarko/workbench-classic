import type { JSX } from 'react'
import { useStore } from '../state/store'
import { actions, activeSessionId } from '../lib/actions'
import { shortPath } from '../lib/ui'
import { useProfiles } from '../lib/agents'
import { UsageMeter } from './UsageMeter'
import { SCREEN_READER_INDICATOR } from '../../../shared/flowContext'

const api = window.term

export function StatusBar(): JSX.Element {
  const counts = useStore((s) => s.counts)
  const env = useStore((s) => s.env)
  const prefs = useStore((s) => s.prefs)
  const sessions = useStore((s) => s.sessions)
  useStore((s) => s.tabs)

  const active = sessions.find((s) => s.id === activeSessionId())
  // Every profile whose command is not on PATH, plus tmux, which is not an
  // agent but is the one dependency without which nothing starts at all. The
  // list comes from the registry so an agent the user added and then uninstalled
  // is reported the same way a built-in is.
  const missing = [
    ...useProfiles()
      .filter((p) => p.id !== 'shell' && !p.available)
      .map((p) => p.command || p.id),
    ...(env && !env.tmux.available ? ['tmux'] : [])
  ]

  return (<>
    <UsageMeter />
    <div className="statusbar">
      <button
        className="statusbar__item statusbar__item--button"
        title="Command palette (⌘K)"
        onClick={() => useStore.getState().setOverlay({ kind: 'palette' })}
      >
        ⌘K
      </button>

      <span className="statusbar__item" title="Waiting on you">
        <span className="dot dot--waiting" /> {counts.waiting}
      </span>
      {/* Only shown when it is true — a permanent "0 failed" teaches you to skip it. */}
      {counts.failed > 0 && (
        <span className="statusbar__item statusbar__warn" title="Failed">
          <span className="dot dot--failed" /> {counts.failed}
        </span>
      )}
      <span className="statusbar__item" title="Working">
        <span className="dot dot--working" /> {counts.working}
      </span>
      <span className="statusbar__item" title="Ready for review">
        <span className="dot dot--review" /> {counts.review}
      </span>

      {active && (
        <button
          className="statusbar__item statusbar__item--button"
          title="Copy the tmux attach command for this session"
          onClick={() => void actions.attachInITerm(active.id)}
        >
          tmux: {active.tmuxName}
        </button>
      )}
      {active && <span className="statusbar__item">{shortPath(active.cwd)}</span>}

      <div className="statusbar__spacer" />
      {prefs.terminalAccessibility !== false && (
        <button
          className="statusbar__item statusbar__item--button"
          title="Terminal text is exposed to accessibility tools and Wispr Flow. Click to turn screen reader mode off."
          onClick={() => actions.toggleScreenReaderMode()}
        >
          {SCREEN_READER_INDICATOR}
        </button>
      )}

      {prefs.broadcastInput && (
        <button
          className="statusbar__item statusbar__item--button statusbar__warn"
          title="Keystrokes are going to every pane — click to stop"
          onClick={() => actions.toggleBroadcast()}
        >
          ⌥ broadcast input ON
        </button>
      )}
      {missing.length > 0 && (
        <span className="statusbar__item statusbar__warn" title="Not found on PATH">
          missing: {missing.join(', ')}
        </span>
      )}
      {env && (
        <span className="statusbar__item" title={`socket: ${env.tmux.socket}`}>
          tmux {env.tmux.version ?? '—'}
        </span>
      )}
      <button
        className="statusbar__item statusbar__item--button"
        onClick={() => useStore.getState().setOverlay({ kind: 'settings' })}
      >
        {prefs.sidebarPinned ? 'pinned' : 'unpinned'} · {prefs.fontSize}px
      </button>
      <button
        className="statusbar__item statusbar__item--button"
        title="Open the handoff folder"
        onClick={() => void api.openHandoffDir()}
      >
        handoffs
      </button>
    </div></>
  )
}
