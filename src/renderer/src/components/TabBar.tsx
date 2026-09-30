import type { JSX } from 'react'
import { useStore } from '../state/store'
import { sessionIdsIn } from '../lib/layout'
import { accel } from '../lib/ui'
import { Icon } from './Icon'
import { useContextMenu } from './ContextMenu'
import type { SessionStatus } from '../../../shared/types'
import { projectTabs, tabSession } from '../lib/projectTerminals'

/** Worst status wins, so a tab with one red pane reads red. */
const RANK: SessionStatus[] = ['waiting', 'failed', 'working', 'review', 'idle', 'exited']

export function TabBar(): JSX.Element {
  const allTabs = useStore((s) => s.tabs)
  const projectId = useStore((s) => s.experienceProjectId)
  const tabs = projectTabs(allTabs, projectId)
  const activeTabId = useStore((s) => s.activeTabId)
  const sessions = useStore((s) => s.sessions)
  const ctx = useContextMenu()


  return (
    <div className="tabbar">
      {tabs.map((tab, i) => {
        const session = tabSession(tab, sessions)
        const title = session?.title ?? 'New Session'
        const ids = sessionIdsIn(tab.layout)
        const statuses = ids
          .map((id) => sessions.find((s) => s.id === id)?.status)
          .filter((s): s is SessionStatus => !!s)
        const worst = RANK.find((r) => statuses.includes(r))
        return (
          <div
            key={tab.id}
            className={`tab${tab.id === activeTabId ? ' tab--active' : ''}`}
            onClick={() => useStore.getState().setActiveTab(tab.id)}
            onAuxClick={(e) => e.button === 1 && useStore.getState().closeTab(tab.id)}
            onContextMenu={(e) =>
              ctx.open(e, [
                ...(session ? [{
                  label: 'Set role…',
                  onSelect: () =>
                    session && useStore.getState().setOverlay({
                      kind: 'rename',
                      target: 'session',
                      id: session.id,
                      current: session.title
                    })
                }] : []),
                { separator: true },
                { label: 'Close tab', onSelect: () => useStore.getState().closeTab(tab.id) },
                {
                  label: 'Close other tabs',
                  onSelect: () => {
                    const st = useStore.getState()
                    st.commitTabs(
                      st.tabs.filter((t) => t.id === tab.id || !tabs.some((visible) => visible.id === t.id)),
                      tab.id
                    )
                  }
                }
              ])
            }
            title={`${title}${session?.lastTask ? ` — ${session.lastTask}` : ''} (${accel(`CmdOrCtrl+Shift+${i + 1}`)})`}
          >
            {worst && <span className={`dot dot--${worst}`} />}
            <span className="tab__title">{title}</span>
            <button
              className="tab__close"
              onClick={(e) => {
                e.stopPropagation()
                useStore.getState().closeTab(tab.id)
              }}
            >
              <Icon name="close" size={11} strokeWidth={1.4} />
            </button>
          </div>
        )
      })}
      <button
        className="tabbar__new"
        title="New workspace tab"
        onClick={() => useStore.getState().addTab()}
      >
        <Icon name="plus" size={14} />
      </button>
      <span className="tabbar__spacer" />
      {/* The project board is the primary glance view. Existing layout presets
          remain available in the native Arrange Panes menu and saved layouts. */}
      <div className="presets">
        <button className="presets__btn" title="Focus — see this project's agents and milestones"
          onClick={() => useStore.getState().navigateExperience('focus', projectId)}>Focus</button>
      </div>
      {ctx.node}
    </div>
  )
}
