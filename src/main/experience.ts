import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { snapshotFocusImage, pruneFocusImages } from './focusImages.js'
import type { CreateSessionOptions, PreviewEntry, Session, SessionProject } from '../shared/types.js'
import { boundFocusUpdates, parseFocusUpdates, validateFocusUpdateInput, type FocusUpdate } from '../shared/focusUpdate.js'
import {
  emptyExperience, nextOccurrence, validateTask, withProjectContext,
  type ExperienceState, type ProjectDetails, type ScheduledTask, type TaskRun
} from '../shared/experience.js'

interface Dependencies {
  directory: string
  project: (id: string) => SessionProject | undefined
  session: (id: string) => Session | undefined
  launch: (options: CreateSessionOptions) => Promise<Session>
  changed: () => void
  now?: () => number
}
const busy = (run: TaskRun): boolean => ['starting', 'launched', 'working', 'waiting'].includes(run.status)

/**
 * A local, app-open scheduler, not an OS daemon. Before starting an agent we
 * durably reserve its run and advance the next occurrence. A crash can leave
 * an interrupted run, but cannot replay an entire backlog on the next launch.
 * All launched agents use ordinary approval mode, even if interactive sessions
 * on this machine default to full access. Scheduling is not extra authority.
 */
export class Experience {
  private state = emptyExperience()
  private readonly file: string
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private readOnly = false
  private launching = new Set<string>()
  private readonly deps: Dependencies

  constructor(deps: Dependencies) {
    this.deps = deps
    this.file = path.join(deps.directory, 'experience.json')
    this.now = deps.now ?? Date.now
    if (!fs.existsSync(this.file)) return
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (raw.version !== 1 || !Array.isArray(raw.tasks) || !Array.isArray(raw.runs)) throw new Error('Unsupported project data')
      this.state.tasks = raw.tasks.slice(0, 100).map((t: ScheduledTask) => {
        const valid = validateTask(t)
        if (!valid.id || !Number.isFinite(t.nextRunAt) || !Number.isFinite(t.createdAt)) throw new Error('Invalid saved task')
        return { ...valid, id: valid.id, nextRunAt: t.nextRunAt, createdAt: t.createdAt }
      })
      this.state.runs = raw.runs.slice(0, 300).map((r: TaskRun) => {
        if (!r || typeof r.id !== 'string' || typeof r.taskId !== 'string' || typeof r.taskName !== 'string' ||
            typeof r.projectId !== 'string' || !Number.isFinite(r.startedAt) ||
            (r.sessionId !== null && typeof r.sessionId !== 'string') ||
            !['starting', 'launched', 'working', 'waiting', 'review', 'failed', 'interrupted'].includes(r.status)) throw new Error('Invalid saved run')
        return { ...r, error: typeof r.error === 'string' ? r.error : null }
      })
      this.state.outputs = (Array.isArray(raw.outputs) ? raw.outputs : []).filter((r: Record<string, unknown>) =>
        r && typeof r.path === 'string' && typeof r.name === 'string' && typeof r.sessionId === 'string' &&
        Number.isFinite(r.mtimeMs) && Number.isFinite(r.size) &&
        ['markdown', 'html', 'image', 'svg', 'pdf', 'csv', 'json', 'text', 'diff'].includes(String(r.kind))
      ).slice(0, 500)
      this.state.archivedIds = (Array.isArray(raw.archivedIds) ? raw.archivedIds : []).filter((id: unknown) => typeof id === 'string').slice(0, 10000)
      this.state.focusUpdates = parseFocusUpdates(raw.focusUpdates)
      this.state.projectDetails = Object.fromEntries(Object.entries(raw.projectDetails ?? {}).filter(([, value]) => {
        const d = value as ProjectDetails
        return d && typeof d.description === 'string' && typeof d.instructions === 'string'
      })) as Record<string, ProjectDetails>
    } catch (error) {
      // Never replace an unreadable history with an apparently empty one. The
      // terminal app still opens, but mutations must wait until data is repaired.
      this.state = emptyExperience()
      this.state.error = `Project data could not be loaded; preserved at ${this.file}: ${String(error)}`
      this.readOnly = true
    }
  }

  snapshot(): ExperienceState { return structuredClone(this.state) }

  private commit(change: (next: ExperienceState) => void): void {
    if (this.readOnly) throw new Error(this.state.error ?? 'Project data is read-only')
    const next = structuredClone(this.state)
    change(next)
    next.error = null
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, ...next }, null, 2), { mode: 0o600 })
      fs.renameSync(`${this.file}.tmp`, this.file)
    } catch (error) {
      this.state.error = `Project changes were not saved: ${String(error)}`
      this.deps.changed()
      throw new Error(this.state.error)
    }
    this.state = next
    this.deps.changed()
  }

  saveTask(raw: unknown): ScheduledTask {
    const input = validateTask(raw)
    if (!this.deps.project(input.projectId)) throw new Error('Choose an existing project')
    const previous = this.state.tasks.find((t) => t.id === input.id)
    if (input.id && !previous) throw new Error('That scheduled task no longer exists')
    if (!previous && this.state.tasks.length >= 100) throw new Error('Limit of 100 scheduled tasks reached')
    const task: ScheduledTask = { ...input, id: previous?.id ?? crypto.randomUUID(),
      createdAt: previous?.createdAt ?? this.now(), nextRunAt: nextOccurrence(input, this.now()) }
    this.commit((s) => { s.tasks = [task, ...s.tasks.filter((t) => t.id !== task.id)] })
    return task
  }

  toggleTask(id: string, enabled: boolean): void {
    const task = this.state.tasks.find((t) => t.id === id)
    if (!task) throw new Error('That scheduled task no longer exists')
    this.saveTask({ ...task, enabled })
  }

  removeTask(id: string): void {
    if (this.state.runs.some((r) => r.taskId === id && busy(r))) throw new Error('A run is active; pause the schedule instead')
    this.commit((s) => { s.tasks = s.tasks.filter((t) => t.id !== id) })
  }

  setProjectDetails(id: string, raw: unknown): void {
    if (!this.deps.project(id)) throw new Error('That project no longer exists')
    const data = raw as ProjectDetails
    if (!data || typeof data.description !== 'string' || data.description.length > 2000 ||
        typeof data.instructions !== 'string' || data.instructions.length > 12000) throw new Error('Invalid project context')
    this.commit((s) => { s.projectDetails[id] = { description: data.description, instructions: data.instructions } })
  }

  removeProject(id: string): void {
    this.commit((s) => {
      s.tasks = s.tasks.map((t) => t.projectId === id ? { ...t, enabled: false } : t)
      s.focusUpdates = s.focusUpdates.filter((report) => report.projectId !== id)
      delete s.projectDetails[id]
    })
  }

  archive(id: string, archived: boolean): void {
    if (!this.deps.session(id)) throw new Error('That session no longer exists')
    this.commit((s) => { s.archivedIds = [...s.archivedIds.filter((x) => x !== id), ...(archived ? [id] : [])] })
  }

  recordOutput(sessionId: string, entry: PreviewEntry): void {
    const session = this.deps.session(sessionId)
    if (!session) return
    this.commit((s) => {
      s.outputs = [{ ...entry, sessionId, projectId: session.sessionProjectId, seen: false },
        ...s.outputs.filter((o) => o.path !== entry.path || o.sessionId !== sessionId)].slice(0, 500)
    })
  }

  acknowledgeOutput(sessionId: string, file: string): void {
    this.commit((s) => { s.outputs.forEach((o) => { if (o.sessionId === sessionId && o.path === file) o.seen = true }) })
  }

  /** The bus supplies its authenticated caller, never an agent-selected owner.
   * Resolve project membership here again so a stale grant or folder name can
   * never redirect a durable report. This mutation touches no live status,
   * notification, run lifecycle or bus/CLI permission; "blocked" is a claim
   * on the card, not an actionable request to the user. */
  publishFocusUpdate(sessionId: string, raw: unknown): FocusUpdate {
    const input = validateFocusUpdateInput(raw)
    const session = this.deps.session(sessionId)
    if (!session?.alive) throw new Error('The reporting session is no longer running')
    const projectId = session.sessionProjectId
    if (!projectId || !this.deps.project(projectId)) throw new Error('Focus reports require an existing Workbench project')
    const update: FocusUpdate = { ...input, id: crypto.randomUUID(), sessionId, projectId, at: this.now() }
    if (update.visual?.kind === 'image') {
      update.visual.path = snapshotFocusImage(this.deps.directory, update.id, session.cwd, update.visual.path)
    }
    try {
      this.commit((s) => {
        s.focusUpdates = boundFocusUpdates([update, ...s.focusUpdates], (report) =>
          !!this.deps.session(report.sessionId) && !!this.deps.project(report.projectId))
      })
    } catch (error) {
      if (update.visual?.kind === 'image') {
        try { fs.rmSync(update.visual.path, { force: true }) } catch { /* preserve the original save error */ }
      }
      throw error
    }
    pruneFocusImages(this.deps.directory, new Set(this.state.focusUpdates.flatMap(report =>
      report.visual?.kind === 'image' ? [report.visual.path] : [])))
    return structuredClone(update)
  }

  /** No new reservation until initialization has reconciled surviving sessions. */
  start(): void {
    if (this.timer || this.readOnly) return
    this.stopped = false
    this.syncRuns(true)
    this.timer = setInterval(() => { void this.tick().catch(() => { /* state.error is visible in the shell */ }) }, 15000)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  syncRuns(restarting = false): void {
    const updates = new Map<string, TaskRun>()
    for (const run of this.state.runs.filter(busy)) {
      if (this.launching.has(run.taskId)) continue
      const session = run.sessionId ? this.deps.session(run.sessionId) : undefined
      let status = run.status
      if (!session && restarting) status = 'interrupted'
      else if (!session && run.sessionId) status = 'interrupted'
      else if (session?.status === 'failed' || session?.status === 'exited') status = 'failed'
      else if (session && ['working', 'waiting', 'review'].includes(session.status)) status = session.status as TaskRun['status']
      // Only an actual review signal means review. Clearing a stuck status or
      // cancelling input may also yield idle; do not advertise those as success.
      else if (session?.status === 'idle' && ['working', 'waiting'].includes(run.status)) status = 'interrupted'
      if (status !== run.status) updates.set(run.id, { ...run, status,
        error: status === 'interrupted' ? 'Run ended without a recoverable completion signal. Schedule paused; inspect its terminal.' : run.error })
    }
    // Session changes already enter here, so removed-report cleanup needs no
    // new polling or per-card subscriptions. Historical project IDs remain
    // unchanged after a move; renderers must filter by the recorded owner.
    const focusUpdates = boundFocusUpdates(this.state.focusUpdates, (report) =>
      !!this.deps.session(report.sessionId) && !!this.deps.project(report.projectId))
    if (!updates.size && focusUpdates.length === this.state.focusUpdates.length) return
    this.commit((s) => {
      s.focusUpdates = focusUpdates
      s.runs = s.runs.map((r) => updates.get(r.id) ?? r)
      for (const r of updates.values()) if (r.status === 'failed' || r.status === 'interrupted') {
        const task = s.tasks.find((t) => t.id === r.taskId)
        if (task) task.enabled = false
      }
    })
  }

  async tick(): Promise<void> {
    if (this.stopped || this.readOnly) return
    this.syncRuns()
    // Re-check each task inside runTask: a user may pause it while another
    // launch is awaiting tmux. Only one catch-up per task, never every miss.
    for (const task of this.state.tasks.filter((t) => t.enabled && t.nextRunAt <= this.now())) {
      if (this.stopped) break
      await this.runTask(task.id, true)
    }
  }

  async runTask(id: string, scheduled = false): Promise<TaskRun | null> {
    if (this.stopped) throw new Error('Workbench is shutting down')
    const task = this.state.tasks.find((t) => t.id === id)
    if (!task) throw new Error('That scheduled task no longer exists')
    if (scheduled && (!task.enabled || task.nextRunAt > this.now())) return null
    if (this.launching.has(id) || this.state.runs.some((r) => r.taskId === id && busy(r))) {
      if (scheduled) return null
      throw new Error('This task already has an active run. Open its terminal to review it.')
    }
    const run: TaskRun = { id: crypto.randomUUID(), taskId: id, taskName: task.name,
      projectId: task.projectId, sessionId: null, startedAt: this.now(), status: 'starting', error: null }
    this.launching.add(id)
    try {
      this.commit((s) => {
        s.runs = [run, ...s.runs].filter((r, i) => i < 200 || busy(r))
        const saved = s.tasks.find((t) => t.id === id)!
        saved.nextRunAt = nextOccurrence(saved, this.now())
      })
      try {
        const project = this.deps.project(task.projectId)
        if (!project) throw new Error('Project was removed. Choose another project before resuming.')
        const session = await this.deps.launch({ agent: task.agent, cwd: project.defaultCwd,
          sessionProjectId: project.id, title: task.name, permissionMode: 'default',
          initialPrompt: withProjectContext(task.prompt, this.state.projectDetails[project.id]) })
        run.sessionId = session.id
        run.status = 'launched'
      } catch (error) {
        run.status = 'failed'
        run.error = error instanceof Error ? error.message : String(error)
      }
      this.commit((s) => {
        s.runs = s.runs.map((r) => r.id === run.id ? run : r)
        if (run.status === 'failed') s.tasks.forEach((t) => { if (t.id === id) t.enabled = false })
      })
      return run
    } finally { this.launching.delete(id) }
  }
}
