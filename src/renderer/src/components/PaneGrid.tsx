import { ResizeHandle } from './ResizeHandle'
import { Fragment, useRef } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { findLeaf, setSizes } from '../lib/layout'
import { TerminalPane } from './TerminalPane'
import { VisualPane } from './VisualPane'
import type { LayoutNode, Tab } from '../../../shared/types'

const MIN_FRACTION = 0.08

export function PaneGrid(): JSX.Element {
  const tab = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0] ?? null)

  if (!tab) return <div className="grid" />

  if (tab.zoomedPaneId) {
    const node = findLeaf(tab.layout, tab.zoomedPaneId)
    if (node && node.type === 'leaf') {
      return (
        <div className="grid">
          {node.view === 'visual' ? (
            <VisualPane node={node} tab={tab} zoomed />
          ) : (
            <TerminalPane paneId={node.id} sessionId={node.sessionId} tab={tab} zoomed />
          )}
        </div>
      )
    }
  }

  return (
    <div className="grid">
      <Node node={tab.layout} tab={tab} />
    </div>
  )
}

function Node({ node, tab }: { node: LayoutNode; tab: Tab }): JSX.Element {
  if (node.type === 'leaf') {
    if (node.view === 'visual') return <VisualPane node={node} tab={tab} />
    return <TerminalPane paneId={node.id} sessionId={node.sessionId} tab={tab} />
  }
  return <Split node={node} tab={tab} />
}

function Split({
  node,
  tab
}: {
  node: Extract<LayoutNode, { type: 'split' }>
  tab: Tab
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const resize = (i: number, pixels: number): void => {
    const box = ref.current?.getBoundingClientRect()
    const st = useStore.getState(), currentTab = st.tabs.find((t) => t.id === tab.id)
    if (!box || !currentTab) return
    const find = (candidate: LayoutNode): LayoutNode | undefined => candidate.id === node.id ? candidate
      : candidate.type === 'split' ? candidate.children.map(find).find(Boolean) : undefined
    const current = find(currentTab.layout)
    if (!current || current.type !== 'split') return
    const total = node.dir === 'h' ? box.width : box.height
    const delta = Math.max(MIN_FRACTION - current.sizes[i], Math.min(current.sizes[i + 1] - MIN_FRACTION, pixels / Math.max(1, total)))
    const next = [...current.sizes]
    next[i] += delta; next[i + 1] -= delta
    st.updateSizes(tab.id, setSizes(currentTab.layout, node.id, next))
  }
  const finish = (): void => {
    const st = useStore.getState()
    st.commitTabs(st.tabs, st.activeTabId)
  }

  return (
    <div className={`split split--${node.dir}`} ref={ref}>
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          <div
            className="split__child"
            style={{ flexGrow: node.sizes[i] ?? 1, flexShrink: 1, flexBasis: 0 }}
          >
            <Node node={child} tab={tab} />
          </div>
          {i < node.children.length - 1 && (
            <ResizeHandle label={node.dir === 'h' ? 'Terminal pane width' : 'Terminal pane height'} axis={node.dir === 'h' ? 'x' : 'y'}
              className={`splitter splitter--${node.dir}`} value={node.sizes[i] * 100} min={8}
              onDelta={(delta) => resize(i, delta)} onEnd={finish} onReset={() => {
                const box = ref.current?.getBoundingClientRect()
                if (!box) return
                resize(i, ((node.sizes[i] + node.sizes[i + 1]) / 2 - node.sizes[i]) * (node.dir === 'h' ? box.width : box.height)); finish()
              }} />
          )}
        </Fragment>
      ))}
    </div>
  )
}
