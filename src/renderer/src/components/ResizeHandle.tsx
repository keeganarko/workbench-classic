import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX, PointerEvent } from 'react'

/** Pointer capture keeps a resize alive over terminals and embedded previews.
 * The temporary iframe shield also covers platforms that send pointer events
 * to a child surface before delivering them to the captured parent. */
export function ResizeHandle({ label, axis = 'x', value, min = 0, max = 100, onDelta, onEnd, onReset, className = '' }: {
  label: string; axis?: 'x' | 'y'; value?: number; min?: number; max?: number
  onDelta(delta: number): void; onEnd?(): void; onReset?(): void; className?: string
}): JSX.Element {
  const drag = useRef<{ coordinate: number; id: number } | null>(null)
  const [active, setActive] = useState(false)
  const end = (): void => {
    if (!drag.current) return
    drag.current = null; setActive(false)
    delete document.body.dataset.resizing
    onEnd?.()
  }
  useEffect(() => () => { delete document.body.dataset.resizing }, [])
  const coordinate = (e: PointerEvent): number => axis === 'x' ? e.clientX : e.clientY
  return <div role="separator" aria-label={label} aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
    aria-valuenow={value === undefined ? undefined : Math.round(value)} aria-valuemin={min} aria-valuemax={Math.round(max)}
    tabIndex={0} title={`${label} · drag or use arrow keys · double-click to reset`}
    className={`resize-handle resize-handle--${axis}${active ? ' is-dragging' : ''} ${className}`}
    onPointerDown={(e) => {
      if (e.button !== 0) return
      e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { coordinate: coordinate(e), id: e.pointerId }; setActive(true)
      document.body.dataset.resizing = axis
    }} onPointerMove={(e) => {
      if (!drag.current || drag.current.id !== e.pointerId) return
      const next = coordinate(e), delta = next - drag.current.coordinate
      drag.current.coordinate = next; onDelta(delta)
    }} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    onDoubleClick={() => onReset?.()} onKeyDown={(e) => {
      const negative = axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
      const positive = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
      if (e.key !== negative && e.key !== positive) return
      e.preventDefault(); onDelta((e.key === negative ? -1 : 1) * (e.shiftKey ? 40 : 10)); onEnd?.()
    }} />
}

/** Remember the requested width, but fit its rendered width to its parent.
 * A narrow window must not permanently replace a size chosen on a big screen.
 * Observing the parent also handles other panel drags, not just OS resizing. */
export function usePanelWidth({ key, preferred, min, max, reserve, commit, resetValue = preferred, axis = 'x' }: {
  axis?: 'x' | 'y'; resetValue?: number; key?: string; preferred: number; min: number; max: number; reserve: number; commit?(width: number): void
}): { ref: React.RefObject<HTMLDivElement>; width: number; maximum: number; resize(delta: number): void; finish(): void; reset(): void } {
  const ref = useRef<HTMLDivElement>(null)
  const [wanted, setWanted] = useState(() => {
    try { const saved = key ? Number(localStorage.getItem(key)) : 0; return saved > 0 && Number.isFinite(saved) ? saved : preferred } catch { return preferred }
  })
  const [available, setAvailable] = useState(window.innerWidth)
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return
    const observer = new ResizeObserver(() => setAvailable(axis === 'x' ? parent.clientWidth : parent.clientHeight))
    setAvailable(axis === 'x' ? parent.clientWidth : parent.clientHeight); observer.observe(parent)
    return () => observer.disconnect()
  })
  useEffect(() => { if (!key) setWanted(preferred) }, [key, preferred])
  const maximum = Math.max(min, Math.min(max, available - reserve))
  const width = Math.max(min, Math.min(maximum, wanted))
  const current = useRef(width); current.current = width
  const finish = (): void => {
    try { if (key) localStorage.setItem(key, String(current.current)) } catch { /* layout preferences remain usable without storage */ }
    commit?.(Math.round(current.current))
  }
  return { ref, width, maximum, resize: (delta) => {
    current.current = Math.max(min, Math.min(maximum, current.current + delta)); setWanted(current.current)
  }, finish, reset: () => { current.current = Math.max(min, Math.min(maximum, resetValue)); setWanted(current.current); finish() } }
}
