import type { JSX } from 'react'
import { useStore } from '../state/store'
import type { SidebarView } from '../state/store'
import { actions } from '../lib/actions'
import { Icon } from './Icon'
import type { IconName } from './Icon'

/**
 * Cursor's 48px rail, in two groups.
 *
 * The top group picks the **view** — what the sidebar is for right now. The
 * group below it filters *within* the sessions view, and doubles as the
 * at-a-glance status readout when the sidebar is hidden. Mixing the two, which
 * is what this rail used to do, made "Failed" and "Git" look like the same kind
 * of choice when one narrows a list and the other replaces it.
 */
const VIEWS: { key: SidebarView; icon: IconName; label: string }[] = [
  { key: 'sessions', icon: 'sessions', label: 'Sessions — click again to clear the filter' },
  { key: 'files', icon: 'folder', label: "Files — the focused agent's folder" },
  { key: 'search', icon: 'search', label: 'Search — find text in that folder' },
  { key: 'git', icon: 'git', label: 'Source control — what the focused agent changed' },
  { key: 'shelf', icon: 'shelf', label: 'Context shelf — saved conversations you can branch from' }
]

const ITEMS: { key: SectionKey; icon: IconName; label: string }[] = [
  { key: 'waiting', icon: 'waiting', label: 'Waiting on you' },
  { key: 'failed', icon: 'failed', label: 'Failed' },
  { key: 'working', icon: 'running', label: 'Working' },
  { key: 'review', icon: 'done', label: 'Ready for review' }
]

type SectionKey = 'recent' | 'waiting' | 'failed' | 'working' | 'review'

/** Only the states that mean "do something" carry a badge on the rail. */
const BADGE_STYLE: Partial<Record<SectionKey, { background: string; color: string }>> = {
  working: { background: 'var(--status-working)', color: '#1f1f1f' },
  failed: { background: 'var(--status-failed)', color: '#ffffff' }
}

export function ActivityBar(): JSX.Element {
  const counts = useStore((s) => s.counts)
  const prefs = useStore((s) => s.prefs)
  const focusSection = useStore((s) => s.focusSection)
  const activeSection = useStore((s) => s.activeSection)
  const view = useStore((s) => s.sidebarView)

  const reveal = (): void => {
    if (!prefs.sidebarVisible) void window.term.setPrefs({ sidebarVisible: true })
  }

  const click = (key: string): void => {
    reveal()
    // A status filter is a statement about the sessions list, so choosing one
    // implies you want to be looking at that list.
    useStore.getState().setSidebarView('sessions')
    focusSection(key)
  }

  return (
    <div
      className="activitybar"
      onMouseEnter={() => !prefs.sidebarPinned && useStore.getState().setSidebarHovered(true)}
    >
      {VIEWS.map((item) => (
        <button
          key={item.key}
          className={`activitybar__item${view === item.key ? ' activitybar__item--active' : ''}`}
          title={item.label}
          onClick={() => {
            reveal()
            // Clicking Sessions when already there clears the status filter —
            // the rail lost its "Recent" entry when the filters moved into
            // their own group, and this is where "show me all of them" went.
            if (item.key === 'sessions' && view === 'sessions') focusSection('recent')
            useStore.getState().setSidebarView(item.key)
          }}
        >
          <Icon name={item.icon} size={22} strokeWidth={1.1} />
        </button>
      ))}

      <div className="activitybar__rule" />

      {ITEMS.map((item) => {
        const badge = item.key === 'recent' || item.key === 'review' ? 0 : counts[item.key]
        return (
          <button
            key={item.key}
            className={`activitybar__item${
              view === 'sessions' && activeSection === item.key
                ? ' activitybar__item--active'
                : ''
            }`}
            title={item.label}
            onClick={() => click(item.key)}
          >
            <Icon name={item.icon} size={22} strokeWidth={1.1} />
            {badge > 0 && (
              <span className="activitybar__badge" style={BADGE_STYLE[item.key]}>
                {badge}
              </span>
            )}
          </button>
        )
      })}

      <div className="activitybar__spacer" />

      <button
        className="activitybar__item"
        title="New Claude session (⌘N)"
        onClick={() => actions.openNewSession('claude')}
      >
        <Icon name="plus" size={22} strokeWidth={1.1} />
      </button>
      <button
        className="activitybar__item"
        title="Settings"
        onClick={() => useStore.getState().setOverlay({ kind: 'settings' })}
      >
        <Icon name="settings" size={22} strokeWidth={1.1} />
      </button>
    </div>
  )
}
