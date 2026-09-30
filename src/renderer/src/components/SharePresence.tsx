import type { JSX } from 'react'
import { useStore } from '../state/store'
import { activeSessionId } from '../lib/actions'
import { guestColor, guestInitials, MAX_GUESTS } from '../../../shared/share'
import { Icon } from './Icon'

/**
 * Who else is looking at this session, in the title bar.
 *
 * Presence belongs next to the status chips rather than inside the pane: the
 * question "is someone else watching me type" has to be answerable by glance
 * from across the room, and a badge that lives inside the terminal is hidden
 * the moment the pane is not focused.
 *
 * Names are shown in full rather than as initials-only avatars. There are at
 * most five of them, and the whole point of the feature is knowing *who* —
 * an anonymous coloured circle answers "someone" and stops there.
 */
export function SharePresence(): JSX.Element | null {
  const shares = useStore((s) => s.shares)
  const tunnel = useStore((s) => s.tunnel)
  // Recompute per render off the tab list so this tracks pane focus.
  useStore((s) => s.tabs)
  const sessionId = activeSessionId()
  if (!sessionId) return null

  const share = shares.find((s) => s.sessionId === sessionId)
  const open = (): void => useStore.getState().setOverlay({ kind: 'share', sessionId })

  // Not shared: one affordance, no presence to report.
  if (!share) {
    return (
      <button className="iconbtn" title="Share this session with someone" onClick={open}>
        <Icon name="share" />
      </button>
    )
  }

  // Shared with nobody yet: the link is live and the host needs to know that
  // much, but there is no one to name.
  const guests = share.guests

  return (
    <button
      className="presence"
      onClick={open}
      title={
        guests.length === 0
          ? 'Shared — waiting for someone to join. Click for the link.'
          : `${guests.length} of ${MAX_GUESTS} watching. Click to manage.`
      }
    >
      <span
        className={`presence__live${tunnel.status === 'up' ? ' presence__live--public' : ''}`}
      />
      {guests.length === 0 ? (
        <span className="presence__empty">Shared</span>
      ) : (
        guests.map((g) => (
          <span
            key={g.id}
            className={`presence__guest${g.canType ? ' presence__guest--typing' : ''}`}
          >
            <span
              className="presence__mark"
              style={{ background: guestColor(g.id) }}
              aria-hidden="true"
            >
              {guestInitials(g.name)}
            </span>
            {g.name}
          </span>
        ))
      )}
    </button>
  )
}
