import type { JSX } from 'react'
import { actions } from '../lib/actions'

/**
 * What a sidebar panel shows instead of itself.
 *
 * All three panels — files, search, source control — follow the focused pane,
 * so all three spend their first moments with nothing to show and can all fail
 * the same two ways: no session focused, or the folder would not answer. The
 * "New session" button is here because "no session focused" is the one of those
 * the user can fix from this spot.
 */
export function PanelEmpty({ title, note }: { title: string; note?: string }): JSX.Element {
  return (
    <div className="panel__empty">
      <div className="panel__empty-title">{title}</div>
      {note && <div className="panel__empty-note">{note}</div>}
      <button className="btn btn--ghost" onClick={() => actions.openNewSession('claude')}>
        New session
      </button>
    </div>
  )
}
