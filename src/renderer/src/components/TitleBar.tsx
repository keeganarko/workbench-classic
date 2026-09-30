import type { JSX } from 'react'
import { useStore } from '../state/store'
import { activeSessionId, actions } from '../lib/actions'
import { preview } from '../lib/preview'
import { accel } from '../lib/ui'
import { byActivity } from '../../../shared/sessionOrder'
import { Icon } from './Icon'
import { SharePresence } from './SharePresence'
import type { SessionStatus } from '../../../shared/types'

const api = window.term

/**
 * The chips mirror the menu-bar icon: red first, it's the one that needs you.
 * `failed` is `alwaysShow: false` — it appears only when something has actually
 * failed, so a chip lighting up carries information.
 */
const CHIPS: { status: SessionStatus; title: string; alwaysShow: boolean }[] = [
  { status: 'waiting', title: 'Waiting on you', alwaysShow: true },
  { status: 'failed', title: 'Failed', alwaysShow: false },
  { status: 'working', title: 'Working', alwaysShow: true },
  { status: 'review', title: 'Ready for review', alwaysShow: true }
]

export function TitleBar(): JSX.Element {
  const counts = useStore((s) => s.counts)
  const sessions = useStore((s) => s.sessions)
  const broadcast = useStore((s) => s.prefs.broadcastInput)
  const previewOn = useStore((s) => s.prefs.previewVisible === true)
  const permissionsOpen = useStore((s) => s.overlay.kind === 'bus')
  // Recompute per render off the tab list so the title tracks pane focus.
  useStore((s) => s.tabs)
  const active = sessions.find((x) => x.id === activeSessionId())

  // Only the two states that mean "this is not moving without you" raise the
  // alarm. A finished turn can wait, and folding it in here would leave the
  // strip permanently lit.
  const blocked = counts.waiting + counts.failed

  const jumpTo = (status: SessionStatus): void => {
    const next = sessions.filter((s) => s.status === status).sort(byActivity)[0]
    if (next) useStore.getState().revealSession(next.id)
    else useStore.getState().setToast(`No ${status} sessions.`)
  }

  return (
    <div className={`titlebar${api.platform === 'darwin' ? '' : ' titlebar--own-chrome'}`}>
      <div className="titlebar__actions">
        <button
          className="iconbtn"
          title="Toggle sidebar (⌘B)"
          onClick={() => actions.toggleSidebar()}
        >
          <Icon name="sidebar" />
        </button>
        <button
          className={`iconbtn${broadcast ? ' iconbtn--on' : ''}`}
          title="Broadcast keystrokes to all panes (⌘⌥I)"
          onClick={() => actions.toggleBroadcast()}
        >
          <Icon name="broadcast" />
        </button>
        <button
          className={`iconbtn${permissionsOpen ? ' iconbtn--on' : ''}`}
          title="Permissions — manage access for every agent"
          aria-label="Permissions"
          aria-haspopup="dialog"
          aria-expanded={permissionsOpen}
          aria-controls={permissionsOpen ? 'agent-permissions' : undefined}
          onClick={() => useStore.getState().setOverlay({ kind: 'bus' })}
        >
          <Icon name="permissions" />
        </button>
      </div>

      <div className="titlebar__title">
        {active ? active.title : 'Workbench'}
      </div>

      {/* Blocked sessions light the whole strip, not just their own chip. A row
          of equally-weighted numbers reads as decoration; a strip that changes
          state is the thing you notice from the far side of the screen. */}
      <div className={`titlebar__counts${blocked > 0 ? ' titlebar__counts--alert' : ''}`}>
        {CHIPS.filter((c) => c.alwaysShow || counts[c.status] > 0).map(({ status, title }) => (
          <button
            key={status}
            className={`count-chip${counts[status] > 0 ? ' count-chip--active' : ''}`}
            title={`${title} — click to jump`}
            onClick={() => jumpTo(status)}
          >
            <span className={`dot dot--${status}`} />
            {counts[status]}
          </button>
        ))}
        {/* The per-status chips answer "jump to a red one". This answers the
            question you actually have — "what is next?" — and walks the queue
            across all three states in priority order. */}
        <button
          className="count-chip count-chip--go"
          title={`Go to the next session needing you (${accel('CmdOrCtrl+Shift+A')})`}
          onClick={() => actions.gotoAttention()}
        >
          Next <span className="count-chip__key">{accel('CmdOrCtrl+Shift+A')}</span>
        </button>
      </div>

      <div className="titlebar__actions">
        {/* Who else is in here comes before the app's own controls: it is the
            only thing in this bar that can change without you doing anything. */}
        <SharePresence />
        <button
          className="iconbtn"
          title="Command palette (⌘K)"
          onClick={() => useStore.getState().setOverlay({ kind: 'palette' })}
        >
          <Icon name="search" />
        </button>
        <button
          className="iconbtn"
          title="Settings"
          onClick={() => useStore.getState().setOverlay({ kind: 'settings' })}
        >
          <Icon name="settings" />
        </button>
        <button
          className="iconbtn"
          title="Open Workbench data folder"
          onClick={() => void api.openDataDir()}
        >
          <Icon name="external" />
        </button>
        {/* Last, so it sits against the edge the pane itself slides in from —
            the button and the thing it opens are in the same corner. */}
        <button
          className={`iconbtn${previewOn ? ' iconbtn--on' : ''}`}
          title={`${previewOn ? 'Hide' : 'Show'} the preview pane (⌘P)`}
          onClick={() => preview.toggle()}
        >
          <Icon name="preview" />
        </button>
        {/* Every platform except macOS gets a frameless window, so the
            controls have to be drawn here. Gating this on "is Linux" left
            Windows with no way to minimise, maximise or close. */}
        {api.platform !== 'darwin' && (
          <div className="window-controls">
            <button
              className="window-control"
              title="Minimize"
              onClick={() => void api.minimizeWindow()}
            >
              <Icon name="minimize" />
            </button>
            <button
              className="window-control"
              title="Maximize or restore"
              onClick={() => void api.toggleMaximizeWindow()}
            >
              <Icon name="zoom" />
            </button>
            <button
              className="window-control window-control--close"
              title="Close"
              onClick={() => void api.closeWindow()}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
