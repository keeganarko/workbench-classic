import type { JSX } from 'react'
import { useStore } from '../state/store'
import { actions } from '../lib/actions'
import { Icon } from './Icon'
import { WorkbenchMark } from './WorkbenchMark'

/**
 * Top-left header, sitting directly above the session list.
 * The pin button lives here because pinning is a property of this panel.
 */
export function Logo(): JSX.Element {
  const pinned = useStore((s) => s.prefs.sidebarPinned)
  const counts = useStore((s) => s.counts)

  return (
    <div className="logo">
      <div className="logo__mark" aria-hidden="true">
        <WorkbenchMark size={24} />
      </div>
      <div className="logo__text">
        <span className="logo__name">Workbench</span>
        <span className="logo__sub">
          {counts.total === 0
            ? 'Claude + Codex, side by side'
            : `${counts.total} session${counts.total === 1 ? '' : 's'} · ${counts.waiting} need you`}
        </span>
      </div>
      <div className="logo__spacer" />
      <button
        className={`iconbtn${pinned ? ' iconbtn--on' : ''}`}
        title={pinned ? 'Unpin sidebar (⌘⇧B)' : 'Pin sidebar (⌘⇧B)'}
        onClick={() => actions.togglePin()}
      >
        <Icon name={pinned ? 'pinned' : 'pin'} size={14} strokeWidth={1.3} />
      </button>
    </div>
  )
}
