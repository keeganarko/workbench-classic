import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { SESSION_ROLES } from '../../../shared/sessionTitle'

const api = window.term

/**
 * Electron replaces window.prompt() with a throwing stub, so every rename has
 * to go through an in-app dialog.
 */
export function RenameDialog({
  target,
  id,
  current
}: {
  target: 'session' | 'tab'
  id: string
  current: string
}): JSX.Element {
  const [value, setValue] = useState(current)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const close = (): void => useStore.getState().setOverlay({ kind: 'none' })

  const commit = async (): Promise<void> => {
    if (saving) return
    const next = value.trim()
    if (!next || next === current) return close()
    if (target === 'session') {
      setSaving(true)
      try { await api.renameSession(id, next) }
      catch (error) { setError(String(error)); setSaving(false); return }
    } else {
      const st = useStore.getState()
      st.commitTabs(
        st.tabs.map((t) => (t.id === id ? { ...t, title: next } : t)),
        st.activeTabId
      )
    }
    close()
  }

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="modal" style={{ width: 420 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__head">{target === 'session' ? 'Set session role' : 'Rename tab'}</div>
        <div className="modal__body">
          <div className="field">
            {target === 'session' ? <><select aria-label="Session role" autoFocus value={value} onChange={(e) => setValue(e.target.value)}>
              {SESSION_ROLES.map((role) => <option key={role}>{role}</option>)}
            </select><span className="field__hint">The role stays steady. The recent-work description updates automatically.</span></> : <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') close()
              }}
            />}
            {error && <span className="field__hint field__hint--error">{error}</span>}
          </div>
        </div>
        <div className="modal__foot">
          <button className="btn btn--ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={saving} onClick={() => void commit()}>
            {target === 'session' ? 'Save role' : 'Rename'}
          </button>
        </div>
      </div>
    </div>
  )
}
