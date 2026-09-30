/**
 * Sessions, arranged by the repository they belong to.
 *
 * A session knows a `cwd` and a `workspaceId`; a workspace knows a `projectId`;
 * a project knows the repository. This module walks that chain and nothing
 * else — no React, no Electron, no filesystem — so the grouping rules can be
 * tested directly instead of through a rendered sidebar.
 */

import type { Project, Session, SessionProject, Workspace } from './types.js'

/** The bucket for sessions that belong to no repository. Not a project id. */
export const UNGROUPED = ''

export interface SessionGroup {
  /** A project id, or {@link UNGROUPED}. */
  key: string
  label: string
  project: Project | null
  sessions: Session[]
}

export interface WorkbenchProjectGroup {
  /** A user-created project id, or {@link UNGROUPED}. */
  key: string
  label: string
  project: SessionProject | null
  sessions: Session[]
}

/**
 * Sessions bucketed by the user's Workbench projects.
 *
 * Empty projects remain visible because their header is also the affordance
 * for starting a new terminal there. This is unlike repository grouping,
 * where a repository with no session has nothing useful to show.
 */
export function groupSessionsByWorkbenchProject(
  sessions: Session[],
  projects: SessionProject[]
): WorkbenchProjectGroup[] {
  const known = new Map(projects.map((project) => [project.id, project]))
  const groups = new Map<string, WorkbenchProjectGroup>()

  for (const project of projects) {
    groups.set(project.id, { key: project.id, label: project.name, project, sessions: [] })
  }

  for (const session of sessions) {
    const project = session.sessionProjectId ? (known.get(session.sessionProjectId) ?? null) : null
    const key = project?.id ?? UNGROUPED
    let group = groups.get(key)
    if (!group) {
      group = { key, label: 'No project', project: null, sessions: [] }
      groups.set(key, group)
    }
    group.sessions.push(session)
  }

  const lastTouched = (group: WorkbenchProjectGroup): number =>
    group.sessions.reduce((max, session) => Math.max(max, session.lastActivityAt), 0)

  return [...groups.values()].sort((a, b) => {
    if (a.key === UNGROUPED) return 1
    if (b.key === UNGROUPED) return -1
    return lastTouched(b) - lastTouched(a) || a.label.localeCompare(b.label)
  })
}

/**
 * What to call a repository in a list.
 *
 * `owner/name` whenever the remote is known, because two checkouts both called
 * `web` in different orgs are not the same project, and the folder name alone
 * hides exactly that. Falls back to the folder name for a repo with no remote.
 */
export function projectLabel(project: Project): string {
  if (project.origin) {
    // `normalizeRemote` yields `host/owner/name`; the host is noise here.
    const parts = project.origin.split('/').filter(Boolean)
    if (parts.length >= 3) return parts.slice(-2).join('/')
  }
  return project.name
}

/** The project a session belongs to, or null if it is not in a repository. */
export function projectIdOf(session: Session, workspaces: Workspace[]): string | null {
  if (!session.workspaceId) return null
  return workspaces.find((w) => w.id === session.workspaceId)?.projectId ?? null
}

/**
 * Sessions bucketed by repository, most recently active repository first.
 *
 * Recency rather than alphabetical: the sidebar is a triage surface, and the
 * repo you touched a minute ago is the one you are looking for. Sessions with
 * no repository always sort last — they are the leftovers, not the headline.
 */
export function groupSessionsByProject(
  sessions: Session[],
  workspaces: Workspace[],
  projects: Project[]
): SessionGroup[] {
  const byKey = new Map<string, SessionGroup>()

  for (const session of sessions) {
    const projectId = projectIdOf(session, workspaces)
    const project = projectId ? (projects.find((p) => p.id === projectId) ?? null) : null
    // A project id we cannot resolve is treated as no project at all. The row
    // still has to appear somewhere: dropping it would make sessions vanish
    // from the sidebar because of a bookkeeping gap.
    const key = project ? project.id : UNGROUPED

    let group = byKey.get(key)
    if (!group) {
      group = {
        key,
        label: project ? projectLabel(project) : 'No repository',
        project,
        sessions: []
      }
      byKey.set(key, group)
    }
    group.sessions.push(session)
  }

  const lastTouched = (g: SessionGroup): number =>
    g.sessions.reduce((max, s) => Math.max(max, s.lastActivityAt), 0)

  return [...byKey.values()].sort((a, b) => {
    if (a.key === UNGROUPED) return 1
    if (b.key === UNGROUPED) return -1
    return lastTouched(b) - lastTouched(a) || a.label.localeCompare(b.label)
  })
}

/**
 * The projects that currently have at least one live session.
 *
 * This is what the composer offers as broadcast targets: a repo whose agents
 * have all exited is not something you can send a prompt to, and listing it
 * would only invite a send that reaches nobody.
 */
export function projectsWithLiveSessions(
  sessions: Session[],
  workspaces: Workspace[],
  projects: Project[]
): { id: string; label: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const session of sessions) {
    if (!session.alive) continue
    const id = projectIdOf(session, workspaces)
    if (!id) continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([id, count]) => {
      const project = projects.find((p) => p.id === id)
      return { id, label: project ? projectLabel(project) : id, count }
    })
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
}
