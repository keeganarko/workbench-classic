import { useEffect, useRef, useState } from 'react'
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  hint?: string
  danger?: boolean
  separator?: false
  onSelect: () => void
}

export type MenuEntry = MenuItem | { separator: true }

interface Props {
  x: number
  y: number
  items: MenuEntry[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // Keep the menu on screen — right-clicking near an edge is the common case.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.min(x, window.innerWidth - r.width - 8),
      top: Math.min(y, window.innerHeight - r.height - 8)
    })
  }, [x, y])

  useEffect(() => {
    // Capture-phase, so a mousedown anywhere else closes the menu before that
    // element handles it. The containment bail-out is load-bearing: a React
    // onMouseDown on the menu itself runs at the portal root, downstream of
    // this listener, so it cannot stop us unmounting the button out from under
    // its own pending click.
    const dismiss = (e: Event): void => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  return createPortal(
    <div className="ctxmenu" ref={ref} style={pos} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((item, i) =>
        'separator' in item && item.separator ? (
          <div className="ctxmenu__sep" key={`sep${i}`} />
        ) : (
          <button
            key={(item as MenuItem).label}
            className={`ctxmenu__item${(item as MenuItem).danger ? ' ctxmenu__item--danger' : ''}`}
            onClick={() => {
              onClose()
              ;(item as MenuItem).onSelect()
            }}
          >
            {(item as MenuItem).label}
            {(item as MenuItem).hint && (
              <span className="ctxmenu__hint">{(item as MenuItem).hint}</span>
            )}
          </button>
        )
      )}
    </div>,
    document.body
  )
}

/** Hook that wires `onContextMenu` to a rendered <ContextMenu>. */
export function useContextMenu(): {
  open: (e: ReactMouseEvent, items: MenuEntry[]) => void
  node: ReactNode
} {
  const [state, setState] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)
  return {
    open: (e, items) => {
      e.preventDefault()
      e.stopPropagation()
      setState({ x: e.clientX, y: e.clientY, items })
    },
    node: state ? (
      <ContextMenu x={state.x} y={state.y} items={state.items} onClose={() => setState(null)} />
    ) : null
  }
}
