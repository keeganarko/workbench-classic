/**
 * Sessions parked out of the active tab's layout.
 *
 * A minimized agent is still running — this strip exists so that giving a pane
 * its screen space back does not mean losing track of what is in it.
 */

import type { JSX } from 'react'
import { useStore } from '../state/store'
import { profileOf, useProfiles } from '../lib/agents'
import { STATUS_META } from '../../../shared/types'
import { Icon } from './Icon'

export function MinimizedBar(): JSX.Element | null {
  const tab = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0] ?? null)
  const sessions = useStore((s) => s.sessions)

  // Parked ids outlive the sessions they name; only render the ones still here.
  const chips = (tab?.minimized ?? [])
    .map((id) => sessions.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => !!s)

  const profiles = useProfiles()

  if (chips.length === 0) return null

  return (
    <div className="minbar">
      <span className="minbar__label">Minimized</span>
      {chips.map((s) => (
        <button
          key={s.id}
          className="minbar__chip"
          title={`${s.title} — ${STATUS_META[s.status].label}. Click to bring back.`}
          onClick={() => useStore.getState().restoreMinimized(s.id)}
        >
          <span className={`dot dot--${s.status}`} />
          <span className="minbar__agent" style={{ color: profileOf(s.agent, profiles).color }}>
            {profileOf(s.agent, profiles).label}
          </span>
          <span className="minbar__title">{s.title}</span>
          <Icon name="zoom" size={10} strokeWidth={1.4} />
        </button>
      ))}
    </div>
  )
}
