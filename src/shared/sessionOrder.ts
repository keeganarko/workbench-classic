/**
 * The order the sidebar puts sessions in, as a flat list.
 *
 * The sidebar draws sessions in buckets — by triage status, or by repository —
 * and ⌘1…⌘9 jump into that list. Both the badge drawn on a row and the
 * shortcut that lands on it read this one function, because a number printed
 * next to a row that jumps somewhere else is worse than no number at all.
 *
 * The digits do not start at the sidebar, though. They start at the panes:
 * see {@link numberKeyOrder}.
 *
 * Only rows that are actually on screen are counted. A collapsed section
 * contributes nothing, and neither does a section the activity bar has
 * filtered away — "third from the top" has to mean the third thing you can
 * see, or the digits stop matching the list the moment you fold a section.
 */

import { groupSessionsByProject, groupSessionsByWorkbenchProject } from './grouping.js'
import type {
  LayoutNode,
  Project,
  Session,
  SessionProject,
  SessionStatus,
  Workspace
} from './types.js'

export interface SectionDef {
  key: string
  label: string
  /** null = sessions with no outstanding action (`idle` or `exited`). */
  status: SessionStatus | null
  /**
   * Pinned sessions only, whatever their status. Pinning is a promotion: the
   * session you are actually steering should keep one address in the sidebar
   * rather than hopping between Working and Ready-for-review every time a hook
   * fires, which is exactly when you are least able to find it again.
   */
  pinned?: true
}

/**
 * Triage order, most urgent first. `failed` sits directly under `waiting`
 * because both mean "this session is not going to move without you" — and it is
 * deliberately its own section: a crash and a permission prompt need opposite
 * responses, so folding them together would make the list lie.
 */
export const SECTIONS: SectionDef[] = [
  { key: 'pinned', label: 'Pinned', status: null, pinned: true },
  { key: 'waiting', label: 'Waiting on you', status: 'waiting' },
  { key: 'failed', label: 'Failed', status: 'failed' },
  { key: 'working', label: 'Working', status: 'working' },
  { key: 'review', label: 'Ready for review', status: 'review' },
  { key: 'recent', label: 'Recent', status: null }
]

/** How many rows the Recent catch-all will draw before it stops. */
export const RECENT_LIMIT = 30

/** Sessions with no outstanding action belong in Recent, and nowhere else. */
export function isRecentStatus(status: SessionStatus): boolean {
  return status === 'idle' || status === 'exited'
}

/** Sort used by every list: newest activity first, pins on top. */
export function byActivity(a: Session, b: Session): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  return b.lastActivityAt - a.lastActivityAt
}

/**
 * The rows one triage section draws, in order.
 *
 * A pinned session appears in the Pinned section and nowhere else. Listing it
 * twice would double every count in the sidebar and make "3 waiting" wrong,
 * which is the number the whole triage view is built on.
 */
export function sectionRows(def: SectionDef, sessions: Session[]): Session[] {
  if (def.pinned) return sessions.filter((s) => s.pinned).sort(byActivity)
  if (def.status === null) {
    return sessions
      .filter((s) => !s.pinned && isRecentStatus(s.status))
      .sort(byActivity)
      .slice(0, RECENT_LIMIT)
  }
  return sessions.filter((s) => !s.pinned && s.status === def.status).sort(byActivity)
}

/** The collapse key a repository section is stored under. */
export function repoSectionKey(groupKey: string): string {
  return `repo:${groupKey}`
}

/** The collapse key for a user-created Workbench project. */
export function projectSectionKey(groupKey: string): string {
  return `project:${groupKey}`
}

export interface SidebarOrderInput {
  sessions: Session[]
  workspaces: Workspace[]
  projects: Project[]
  sessionProjects: SessionProject[]
  groupBy: 'status' | 'repo' | 'project'
  /** The activity-bar filter. `recent` is the catch-all showing every section. */
  activeSection: string
  /** Section collapse state, keyed the way the sidebar keys it. */
  collapsed: Record<string, boolean>
}

/**
 * Every session id the sidebar is currently showing, top to bottom.
 *
 * Ids rather than sessions: the caller is going to look one up in the store
 * anyway, and an id survives the twice-a-second state push that replaces every
 * session object.
 */
export function sidebarSessionOrder(input: SidebarOrderInput): string[] {
  const { sessions, workspaces, projects, sessionProjects, groupBy, activeSection, collapsed } = input
  const out: string[] = []

  if (groupBy === 'repo') {
    for (const group of groupSessionsByProject(sessions, workspaces, projects)) {
      if (collapsed[repoSectionKey(group.key)]) continue
      for (const s of [...group.sessions].sort(byActivity)) out.push(s.id)
    }
    return out
  }

  if (groupBy === 'project') {
    for (const group of groupSessionsByWorkbenchProject(sessions, sessionProjects)) {
      if (collapsed[projectSectionKey(group.key)]) continue
      for (const s of [...group.sessions].sort(byActivity)) out.push(s.id)
    }
    return out
  }

  // The activity bar filters rather than scrolls: `recent` is the catch-all
  // view carrying every section, the others narrow to one.
  const visible =
    activeSection === 'recent' ? SECTIONS : SECTIONS.filter((s) => s.key === activeSection)

  for (const def of visible) {
    if (collapsed[def.key]) continue
    for (const s of sectionRows(def, sessions)) out.push(s.id)
  }
  return out
}

/**
 * Row number for each session, 1-based, for the first `limit` rows.
 *
 * Capped because the badge is a shortcut label and there are only nine digits;
 * numbering row 14 would advertise a key that does nothing.
 */
export function sidebarSessionNumbers(order: string[], limit = 9): Map<string, number> {
  const map = new Map<string, number>()
  order.slice(0, limit).forEach((id, i) => map.set(id, i + 1))
  return map
}

/**
 * The panes on screen, left to right, as session ids.
 *
 * Array order in a split *is* visual order — children[0] is the left (or top)
 * child, and the renderer lays them out in that order — so a depth-first walk
 * reads the screen the way you do. A zoomed pane hides its siblings, so when
 * one is zoomed it is the only thing on screen and the only thing counted.
 *
 * The leaf walk is re-implemented here rather than imported from the
 * renderer's `lib/layout`: this module is deliberately React-free so the
 * sidebar, the shortcut and the tests can all import it, and shared code
 * cannot reach into the renderer.
 */
export function paneSessionOrder(
  layout: LayoutNode,
  zoomedPaneId: string | null,
  sessions: Session[]
): string[] {
  const known = new Set(sessions.map((s) => s.id))
  const out: string[] = []

  const walk = (node: LayoutNode): void => {
    if (node.type === 'leaf') {
      if (zoomedPaneId && node.id !== zoomedPaneId) return
      // An empty pane is not a target, and counting it would spend a digit on
      // something no key could land on.
      if (node.sessionId && known.has(node.sessionId)) out.push(node.sessionId)
      return
    }
    for (const child of node.children) walk(child)
  }
  walk(layout)

  // The same session can be open in two panes. The first one wins; a digit has
  // to mean one place.
  return [...new Set(out)]
}

/**
 * What ⌘1…⌘9 actually walk: the screen first, then the sidebar.
 *
 * Panes come first because that is where you are looking — with three panes
 * open, ⌘1/⌘2/⌘3 are the leftmost, middle and rightmost, which is the mapping
 * you can read off the screen without thinking. The digits then keep counting
 * into the sidebar for everything not already on screen, so a session already
 * in a pane never takes two numbers and no digit is wasted re-selecting a pane
 * you are already in.
 *
 * The consequence worth stating: these numbers move when the layout changes.
 * Opening a second pane pushes every sidebar session down one. That is the
 * right trade — the alternative is a stable number that points somewhere you
 * cannot see — and it is why the badge is drawn on the row rather than left to
 * memory.
 */
export function numberKeyOrder(
  input: SidebarOrderInput & { layout: LayoutNode | null; zoomedPaneId: string | null }
): string[] {
  const panes = input.layout
    ? paneSessionOrder(input.layout, input.zoomedPaneId, input.sessions)
    : []
  const seen = new Set(panes)
  return [...panes, ...sidebarSessionOrder(input).filter((id) => !seen.has(id))]
}
