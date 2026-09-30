import type { Session, SessionProject } from './types.js'
import type { FocusUpdate } from './focusUpdate.js'
import { focusSessions, focusStatus } from './focusJournal.js'

/** Filter before rendering cards or requesting their images. Live idle/review
 * sessions still belong to ongoing work; closed processes and archived chats
 * do not keep an otherwise inactive project on the Focus board. */
export function activeFocusProjects(projects: SessionProject[], sessions: Session[], archivedIds: string[]): SessionProject[] {
  const activeIds = new Set(focusSessions(sessions, null, archivedIds, true).map(s => s.sessionProjectId))
  return projects.filter(project => activeIds.has(project.id))
}

/** A project's history survives archiving workers. A report is still evidence
 * only for its recorded author and project: a moved or removed session must
 * never transfer its old claims into another project's overview. UI and the
 * central agent use this same selection, with literal reports kept distinct
 * from a current task or a live status. */
export function projectFocus(projectId: string, sessions: Session[], reports: FocusUpdate[], archivedIds: string[]): {
  workers: Session[]; reports: FocusUpdate[]; latest?: FocusUpdate; current?: Session; lastKnown?: Session; needsAttention: number
} {
  const owners = sessions.filter(s => s.sessionProjectId === projectId)
  const ids = new Set(owners.map(s => s.id)), archived = new Set(archivedIds)
  const workers = owners.filter(s => s.alive && s.status !== 'exited' && !archived.has(s.id)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const history = reports.filter(r => r.projectId === projectId && ids.has(r.sessionId))
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, 6)
  const current = workers.slice().sort((a, b) => (b.lastPromptAt ?? b.createdAt) - (a.lastPromptAt ?? a.createdAt))[0]
  const lastKnown = owners.slice().sort((a, b) => (b.lastPromptAt ?? b.createdAt) - (a.lastPromptAt ?? a.createdAt))[0]
  return { workers, reports: history, latest: history[0], current, lastKnown,
    needsAttention: workers.filter(s => ['waiting', 'failed'].includes(focusStatus(s))).length }
}
