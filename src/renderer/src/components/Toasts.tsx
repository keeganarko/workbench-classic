import type { JSX } from 'react'
import { useStore } from '../state/store'

export function Toasts(): JSX.Element {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast${t.tone === 'error' ? ' toast--error' : t.tone === 'success' ? ' toast--success' : ''}`}
          onClick={() => useStore.getState().dismissToast(t.id)}
        >
          {t.text}
          {t.action && (
            <button
              className="toast__action"
              onClick={(e) => {
                e.stopPropagation()
                useStore.getState().dismissToast(t.id)
                t.action?.run()
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
