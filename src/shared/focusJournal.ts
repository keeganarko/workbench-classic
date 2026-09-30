import type { Session, SessionStatus } from './types.js'
import type { OutputRecord } from './experience.js'

export const FOCUS_CARD_PAGE_SIZE = 12
export const FOCUS_EVENT_CAP = 8
export const FOCUS_TOTAL_CAP = 240
export type FocusEventKind = 'started' | 'turn' | 'waiting' | 'review' | 'failed' | 'stopped' | 'output'
export interface FocusEvent {
  id: string; sessionId: string
  /** Ownership is recorded at the boundary; moving a terminal cannot move its history. */
  projectId: string | null
  kind: FocusEventKind; at: number; label: string
}
export const FOCUS_STATUS: Record<SessionStatus, { label: string; detail: string }> = {
  working: { label: 'Working', detail: 'The agent is working' },
  waiting: { label: 'Needs you', detail: 'The session is waiting for input' },
  review: { label: 'Ready for review', detail: 'A turn is ready to inspect' },
  failed: { label: 'Failed', detail: 'The session reported a problem' },
  idle: { label: 'Available', detail: 'The session is available' },
  exited: { label: 'Stopped', detail: 'The process has stopped' }
}
export const focusStatus = (s: Pick<Session, 'alive' | 'status'>): SessionStatus =>
  !s.alive && s.status !== 'failed' ? 'exited' : s.status

/** A bounded plain-text excerpt, never a transcript renderer. Limit input before
 * parsing and remove incomplete fences too. React still escapes the result; this
 * is presentation, not an HTML sanitizer. Raw lifecycle reasons are not summaries. */
export function focusText(value: string | null | undefined, limit = 180): string {
  const text = (value ?? '').slice(0, 12000).replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/^\s*\$\s.*$/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`#]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…` : text
}
/** Stable seats make a board readable while agents work; attention has its own
 * filter. App-wide scope must be explicit. Archiving does not stop a process. */
export function focusSessions(sessions: Session[], projectId: string | null, archivedIds: string[], allProjects = false): Session[] {
  if (!projectId && !allProjects) return []
  const archived = new Set(archivedIds)
  return sessions.filter(s => (allProjects || s.sessionProjectId === projectId) && s.alive && s.status !== 'exited' && !archived.has(s.id))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}
const visual = (o: OutputRecord): boolean => ['markdown', 'html', 'image', 'svg', 'pdf', 'csv'].includes(o.kind)
export function focusOutputs(outputs: OutputRecord[], sessionId: string, projectId: string | null): OutputRecord[] {
  const seen = new Set<string>()
  return outputs.filter(o => o.sessionId === sessionId && o.projectId === projectId && visual(o))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .filter(o => { if (seen.has(o.path)) return false; seen.add(o.path); return true }).slice(0, 3)
}
const validTime = (at: unknown): at is number => typeof at === 'number' && Number.isFinite(at) && at > 0 && at <= 8640000000000000
function bounded(events: FocusEvent[]): FocusEvent[] {
  const counts = new Map<string, number>(), ids = new Set<string>()
  return events.slice().sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).filter(e => {
    const count = counts.get(e.sessionId) ?? 0
    if (!validTime(e.at) || ids.has(e.id) || count >= FOCUS_EVENT_CAP) return false
    counts.set(e.sessionId, count + 1); ids.add(e.id); return true
  }).slice(0, FOCUS_TOTAL_CAP)
}
const statusKind: Partial<Record<SessionStatus, FocusEventKind>> = {
  working: 'turn', waiting: 'waiting', review: 'review', failed: 'failed', exited: 'stopped'
}
const labels: Record<FocusEventKind, string> = {
  started: 'Session started', turn: 'Turn started', waiting: 'Waiting for input',
  review: 'Turn ready for review', failed: 'Session reported a problem', stopped: 'Process stopped', output: 'Output updated'
}
/** Observe boundaries on the existing state stream: no polling, inference or
 * terminal reads. Hydration is not evidence we witnessed earlier turns. The
 * renderer passes its ready flag to distinguish first load from a genuinely
 * empty workspace gaining its first session. Prompt timestamps keep repeated
 * real turns distinct; terminal chatter cannot invent a milestone. Unchanged
 * pulses return the same array so localStorage does not churn. */
export function updateFocusEvents(previous: FocusEvent[], before: Session[], after: Session[], outputs: OutputRecord[], hydrated = before.length > 0): FocusEvent[] {
  const live = new Map(after.map(s => [s.id, s])), prior = new Map(before.map(s => [s.id, s]))
  const events = previous.filter(e => live.has(e.sessionId)), known = new Set(events.map(e => e.id))
  const add = (e: FocusEvent): void => { if (!known.has(e.id)) { events.push(e); known.add(e.id) } }
  if (hydrated) {
    for (const s of after) {
      const old = prior.get(s.id), status = focusStatus(s), projectId = s.sessionProjectId ?? null
      let kind: FocusEventKind | undefined, at = s.lastStatusChangeAt || s.createdAt
      if (!old) { kind = 'started'; at = s.createdAt }
      else if (status === 'working' && s.lastPromptAt && s.lastPromptAt !== old.lastPromptAt) { kind = 'turn'; at = s.lastPromptAt }
      else if (status !== focusStatus(old) || s.lastStatusChangeAt !== old.lastStatusChangeAt) kind = statusKind[status]
      if (kind) add({ id: JSON.stringify([s.id, projectId, kind, at]), sessionId: s.id, projectId, kind, at, label: labels[kind] })
    }
    for (const o of outputs) {
      // A rescan must not announce old files as news. Existing output links still
      // show them with their real dates, without fabricating a fresh milestone.
      if (!live.has(o.sessionId) || !visual(o) || Date.now() - o.mtimeMs > 21600000) continue
      add({ id: JSON.stringify([o.sessionId, o.projectId, 'output', o.path, o.mtimeMs]), sessionId: o.sessionId,
        projectId: o.projectId, kind: 'output', at: o.mtimeMs, label: focusText(o.name, 100) || labels.output })
    }
  }
  const next = bounded(events)
  return next.length === previous.length && next.every((e, i) => e === previous[i]) ? previous : next
}
/** Journals survive upgrades and manual edits. Invalid data must never block
 * application startup or produce a timestamp that crashes ISO formatting. */
export function parseFocusEvents(raw: string | null): FocusEvent[] {
  if (!raw || raw.length > 500000) return []
  try {
    const items: unknown = JSON.parse(raw)
    if (!Array.isArray(items)) return []
    const events: FocusEvent[] = []
    for (const e of items.slice(0, FOCUS_TOTAL_CAP)) {
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || e.id.length > 5000 ||
          typeof e.sessionId !== 'string' || !e.sessionId || e.sessionId.length > 200 ||
          !(e.projectId === null || typeof e.projectId === 'string' && e.projectId.length <= 200) ||
          !Object.hasOwn(labels, e.kind) || !validTime(e.at) || typeof e.label !== 'string') continue
      events.push({ id: e.id, sessionId: e.sessionId, projectId: e.projectId, kind: e.kind, at: e.at, label: focusText(e.label, 100) })
    }
    return bounded(events)
  } catch { return [] }
}
