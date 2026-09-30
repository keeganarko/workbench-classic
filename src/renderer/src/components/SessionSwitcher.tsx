import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { relTime, shortPath } from '../lib/ui'
import { byActivity } from '../../../shared/sessionOrder'
import { profileOf, useProfiles } from '../lib/agents'
import { STATUS_META } from '../../../shared/types'
import { sessionTaskSummary } from '../../../shared/sessionTitle'

/** ⌘P — jump straight to a session, ordered by what needs you first. */
export function SessionSwitcher(): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const profiles = useProfiles()
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return [...sessions]
      .sort((a, b) => {
        const o = STATUS_META[a.status].order - STATUS_META[b.status].order
        return o !== 0 ? o : byActivity(a, b)
      })
      .filter(
        (s) =>
          !needle ||
          s.title.toLowerCase().includes(needle) ||
          s.lastTask?.toLowerCase().includes(needle) ||
          s.cwd.toLowerCase().includes(needle) ||
          s.agent.includes(needle)
      )
  }, [sessions, q])

  useEffect(() => setIdx(0), [q])

  const choose = (id: string): void => {
    const st = useStore.getState()
    st.setOverlay({ kind: 'none' })
    st.revealSession(id)
  }

  return (
    <div className="overlay" onMouseDown={() => useStore.getState().setOverlay({ kind: 'none' })}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder="Go to session…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIdx((i) => Math.min(rows.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIdx((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const row = rows[idx]
              if (row) choose(row.id)
            }
          }}
        />
        <div className="palette__list">
          {rows.length === 0 && <div className="palette__empty">No sessions yet</div>}
          {rows.map((s, i) => (
            <button
              key={s.id}
              className={`palette__item palette__session${i === idx ? ' palette__item--active' : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => choose(s.id)}
            >
              <span className={`dot dot--${s.status}`} />
              <span className="palette__session-copy"><strong>{s.title}</strong>
                <span>{sessionTaskSummary(s)}</span>
                <span className="palette__item-sub">{STATUS_META[s.status].label} · {profileOf(s.agent, profiles).label} · {shortPath(s.cwd)} · {relTime(s.lastActivityAt)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
