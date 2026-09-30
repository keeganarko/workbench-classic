import type { Session, SessionProject, Tab } from '../../../shared/types'
import { allLeaves, firstEmptyPane, newTab, paneShowing, sessionIdsIn, sessionInPane, setPaneSession } from './layout'

/** A tab follows its focused conversation's role, including after a rename or
 * restore. Deriving this avoids stale "Workspace 3" labels saved in layouts. */
export function tabSession(tab: Tab, sessions: Session[]): Session | undefined {
  const focused = sessionInPane(tab.layout, tab.activePaneId ?? tab.layout.id)
  const ids = [...sessionIdsIn(tab.layout), ...(tab.minimized ?? [])]
  return sessions.find((session) => session.id === focused)
    ?? ids.map((id) => sessions.find((session) => session.id === id)).find(Boolean)
}

/**
 * New conversations follow the place the user is working, even when the rail
 * says All terminals. The selected project wins, then a project-owned tab,
 * then the focused conversation. An empty split can inherit from its siblings
 * only when they all belong to the same project; guessing in a mixed workspace
 * would silently file a conversation under unrelated work. Folder paths are
 * deliberately not project identities: two purposes can share one checkout.
 */
export function newSessionProject(
  projects: SessionProject[], selectedId: string | null, tab: Tab | null, sessions: Session[]
): SessionProject | undefined {
  const known = (id: string | null | undefined): SessionProject | undefined =>
    projects.find((project) => project.id === id)
  const scoped = known(selectedId) ?? known(tab?.sessionProjectId)
  if (scoped || !tab) return scoped
  const focusedId = sessionInPane(tab.layout, tab.activePaneId ?? tab.layout.id)
  const focused = sessions.find((session) => session.id === focusedId)
  if (focused) return known(focused.sessionProjectId)
  const members = sessionIdsIn(tab.layout).map((id) => sessions.find((session) => session.id === id))
  const projectId = members[0]?.sessionProjectId
  return projectId && members.every((session) => session?.sessionProjectId === projectId)
    ? known(projectId) : undefined
}

/** All terminals is the shared view; a project sees only its own workspace tabs. */
export function projectTabs(tabs: Tab[], projectId: string | null): Tab[] {
  return projectId ? tabs.filter((tab) => tab.sessionProjectId === projectId) : tabs
}

/**
 * Project entry is a triage decision, not a restoration of the last click.
 * Questions and approvals come first, then failures, then completed work to
 * review. Otherwise the latest submitted prompt wins among live terminals;
 * background output must not displace the conversation the user last steered.
 * Old sessions without a prompt timestamp fall back to activity, and archived
 * sessions stay out of automatic selection even if their old status is urgent.
 */
export function priorityProjectSession(sessions: Session[], projectId: string, archivedIds: string[]): Session | undefined {
  const archived = new Set(archivedIds)
  const priority = (session: Session): number => {
    if (session.status === 'waiting') return 0
    if (session.status === 'failed') return 1
    if (session.status === 'review') return 2
    return session.alive ? 3 : 4
  }
  return sessions.filter((session) => session.sessionProjectId === projectId && !archived.has(session.id))
    .sort((a, b) => priority(a) - priority(b)
      || (b.lastPromptAt ?? 0) - (a.lastPromptAt ?? 0)
      || b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id))[0]
}

/**
 * Focus the chosen conversation without rebuilding the project's splits or
 * touching another project's tabs. An existing pane wins, including a pane
 * hidden by zoom. Otherwise reuse an empty or focused pane and restore a
 * minimized conversation so it is actually visible when the project opens.
 */
export function focusProjectTerminal(tabs: Tab[], activeTabId: string | null, projectId: string, sessionId: string): { tabs: Tab[]; activeTabId: string | null } {
  const visible = projectTabs(tabs, projectId)
  const ordered = [...visible].sort((a, b) => Number(b.id === activeTabId) - Number(a.id === activeTabId))
  const tab = ordered.find((item) => paneShowing(item.layout, sessionId))
    ?? ordered.find((item) => item.minimized?.includes(sessionId)) ?? ordered[0]
  if (!tab) return { tabs, activeTabId }
  const shown = paneShowing(tab.layout, sessionId)
  const paneId = shown ?? firstEmptyPane(tab.layout) ?? tab.activePaneId ?? allLeaves(tab.layout)[0].id
  const layout = shown ? tab.layout : setPaneSession(tab.layout, paneId, sessionId)
  return {
    activeTabId: tab.id,
    tabs: tabs.map((item) => item.id === tab.id ? {
      ...item, layout, activePaneId: paneId, zoomedPaneId: item.zoomedPaneId ? paneId : null,
      minimized: item.minimized?.filter((id) => id !== sessionId)
    } : item)
  }
}

/**
 * Filing a conversation can change while its workspace is hidden. Clear those
 * panes, including their visual artifacts and minimized chips, before showing
 * the workspace again. The sessions themselves still run in tmux; this changes
 * only which project is allowed to present them.
 */
export function reconcileProjectTabs(tabs: Tab[], sessions: Session[]): Tab[] {
  const owners = new Map(sessions.map((session) => [session.id, session.sessionProjectId]))
  let changed = false
  const next = tabs.map((tab) => {
    if (!tab.sessionProjectId) return tab
    let layout = tab.layout
    for (const pane of allLeaves(layout)) {
      if (pane.sessionId && owners.get(pane.sessionId) !== tab.sessionProjectId) {
        layout = setPaneSession(layout, pane.id, null)
      }
    }
    const minimized = tab.minimized?.filter((id) => owners.get(id) === tab.sessionProjectId)
    if (layout === tab.layout && minimized?.length === tab.minimized?.length) return tab
    changed = true
    return { ...tab, layout, ...(minimized ? { minimized } : {}) }
  })
  return changed ? next : tabs
}

/**
 * Adopt an existing workspace when all of its sessions belong to this project.
 * Mixed-project layouts remain available in All terminals. A project's first
 * visit otherwise opens its highest-priority conversation, without launching a
 * process or changing the layout the user left in another project.
 */
export function ensureProjectTabs(
  tabs: Tab[], sessions: Session[], project: SessionProject, archivedIds: string[]
): Tab[] {
  const clean = reconcileProjectTabs(tabs, sessions)
  if (projectTabs(clean, project.id).length) return clean
  const members = sessions.filter((session) => session.sessionProjectId === project.id)
  const ids = new Set(members.map((session) => session.id))
  const adopted = clean.map((tab) => {
    const shown = [...sessionIdsIn(tab.layout), ...(tab.minimized ?? [])]
    return !tab.sessionProjectId && shown.length && shown.every((id) => ids.has(id))
      ? { ...tab, sessionProjectId: project.id }
      : tab
  })
  if (projectTabs(adopted, project.id).length) return adopted
  const priority = priorityProjectSession(sessions, project.id, archivedIds)
  return [...clean, { ...newTab(project.name, priority?.id ?? null), sessionProjectId: project.id }]
}
