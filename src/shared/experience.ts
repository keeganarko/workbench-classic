/**
 * The project-first shell's portable data and pure rules. Runtime bookkeeping
 * is separate from workbench.json so the experimental UI can be rolled back
 * without teaching the original app about task definitions or output history.
 */
import type { PreviewEntry, Session } from './types.js'
import type { FocusUpdate } from './focusUpdate.js'

export type ExperienceView = 'overview' | 'terminals' | 'focus' | 'inbox' | 'scheduled' | 'services' | 'outputs' | 'context'
export type TaskCadence = 'daily' | 'weekdays' | 'weekly'
export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  projectId: string
  agent: 'codex' | 'claude'
  cadence: TaskCadence
  time: string
  weekday: number
  enabled: boolean
  nextRunAt: number
  createdAt: number
}
export type TaskInput = Omit<ScheduledTask, 'id' | 'nextRunAt' | 'createdAt'> & { id?: string }
export interface TaskRun {
  id: string
  taskId: string
  taskName: string
  projectId: string
  sessionId: string | null
  startedAt: number
  status: 'starting' | 'launched' | 'working' | 'waiting' | 'review' | 'failed' | 'interrupted'
  error: string | null
}
export interface ProjectDetails { description: string; instructions: string }
export interface OutputRecord extends PreviewEntry {
  sessionId: string
  projectId: string | null
  seen: boolean
}

/**
 * Outputs has an explicit project scope, including unfiled documents (`null`).
 * Only the workspace-wide inbox passes `undefined` to include every project.
 * Use the recorded owner: moving or removing a terminal later must not rewrite
 * where its earlier documents came from.
 */
export function filterOutputs(outputs: OutputRecord[], projectId: string | null | undefined, unreadOnly = false): OutputRecord[] {
  return outputs.filter((output) =>
    (projectId === undefined || (output.projectId ?? null) === projectId) && (!unreadOnly || !output.seen))
}
export interface ExperienceState {
  tasks: ScheduledTask[]
  runs: TaskRun[]
  outputs: OutputRecord[]
  focusUpdates: FocusUpdate[]
  archivedIds: string[]
  projectDetails: Record<string, ProjectDetails>
  error: string | null
}
export const emptyExperience = (): ExperienceState => ({
  tasks: [], runs: [], outputs: [], focusUpdates: [], archivedIds: [], projectDetails: {}, error: null
})

/** Next local wall-clock occurrence, strictly after now, including DST changes. */
export function nextOccurrence(task: Pick<ScheduledTask, 'time' | 'cadence' | 'weekday'>, now: number): number {
  const [hour, minute] = task.time.split(':').map(Number)
  for (let offset = 0; offset <= 8; offset++) {
    const candidate = new Date(now)
    candidate.setDate(candidate.getDate() + offset)
    candidate.setHours(hour, minute, 0, 0)
    const day = candidate.getDay()
    if (candidate.getTime() <= now) continue
    if (task.cadence === 'weekdays' && (day === 0 || day === 6)) continue
    if (task.cadence === 'weekly' && day !== task.weekday) continue
    return candidate.getTime()
  }
  throw new Error('Could not calculate the next scheduled time')
}

/** IPC and disk use the same validation; a saved JSON object is not trusted. */
export function validateTask(input: unknown): TaskInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid scheduled task')
  const raw = input as Record<string, unknown>
  const str = (key: string, max: number): string => {
    const value = raw[key]
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid task ${key}`)
    return value.trim()
  }
  const name = str('name', 120), prompt = str('prompt', 12000), projectId = str('projectId', 200)
  if (raw.agent !== 'codex' && raw.agent !== 'claude') throw new Error('Choose Claude Code or Codex CLI')
  if (!['daily', 'weekdays', 'weekly'].includes(String(raw.cadence))) throw new Error('Invalid task cadence')
  if (typeof raw.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.time)) throw new Error('Choose a valid local time')
  if (!Number.isInteger(raw.weekday) || Number(raw.weekday) < 0 || Number(raw.weekday) > 6) throw new Error('Invalid weekday')
  if (typeof raw.enabled !== 'boolean') throw new Error('Invalid schedule enabled flag')
  return { name, prompt, projectId, agent: raw.agent, cadence: raw.cadence as TaskCadence,
    time: raw.time, weekday: Number(raw.weekday), enabled: raw.enabled,
    ...(raw.id === undefined ? {} : { id: str('id', 200) }) }
}

export function withProjectContext(prompt: string | undefined, details?: ProjectDetails): string | undefined {
  if (!details?.instructions.trim() || !prompt?.trim()) return prompt
  return `Project instructions:\n${details.instructions.trim()}\n\nTask:\n${prompt}`
}

export interface SessionFilter {
  projectId: string | null
  query: string
  agent: string
  status: string
  archived: boolean
}
export function filterSessions(sessions: Session[], archivedIds: string[], filter: SessionFilter): Session[] {
  const archived = new Set(archivedIds)
  const query = filter.query.trim().toLocaleLowerCase()
  return sessions.filter((s) =>
    (filter.projectId === null || s.sessionProjectId === filter.projectId) &&
    archived.has(s.id) === filter.archived &&
    (!filter.agent || s.agent === filter.agent) &&
    (!filter.status || (filter.status === 'attention' ? ['waiting', 'failed', 'review'].includes(s.status) : s.status === filter.status)) &&
    (!query || `${s.title} ${s.lastTask ?? ''}`.toLocaleLowerCase().includes(query))
  ).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivityAt - a.lastActivityAt)
}

export function folderLocation(folder: string): { label: string; hint: string; warning: boolean } {
  const p = folder.replaceAll('\\', '/')
  if (/^\/mnt\/[a-z]\//i.test(p) || /^[a-z]:\//i.test(p)) return {
    label: 'Windows files', warning: true,
    hint: 'For Linux agent code, prefer the Ubuntu Dev folder. Keep Windows-owned documents here.'
  }
  return {
    label: 'Ubuntu / Linux files', warning: /(?:^|\/)dev(?:\/|$)/.test(p),
    hint: /(?:^|\/)dev(?:\/|$)/.test(p)
      ? 'Lowercase dev and uppercase Dev are different folders in Ubuntu. Prefer ~/Dev for new code.'
      : 'On this Windows desktop, use ~/Dev inside Ubuntu for code. No files will be moved.'
  }
}
