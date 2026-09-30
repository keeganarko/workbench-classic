import { useEffect, useRef, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import { useStore } from '../state/store'
import { preview } from '../lib/preview'
import { filterOutputs, folderLocation, type ScheduledTask, type TaskInput, type OutputRecord } from '../../../shared/experience'
import type { PreviewEntry, SessionProject } from '../../../shared/types'
import { Icon } from './Icon'
import { ProjectSelect } from './ProjectFilter'
import { Empty, SectionTitle, reportError } from './ExperienceShell'

const api = window.term
const date = (time: number): string => new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function FolderHint({ folder }: { folder: string }): JSX.Element {
  const location = folderLocation(folder)
  return <div className={`px-folderhint${location.warning ? ' is-warning' : ''}`}><Icon name="folder" /><div><strong>{api.platform === 'darwin' ? 'Mac folder' : location.label}</strong><p>{api.platform === 'darwin' ? 'Use ~/Dev for code. This project binds to a folder; it never moves your files.' : location.hint}</p></div></div>
}

export function PrototypeContext({ project }: { project: SessionProject }): JSX.Element {
  const saved = useStore((s) => s.experience.projectDetails[project.id])
  const [description, setDescription] = useState(saved?.description ?? '')
  const [instructions, setInstructions] = useState(saved?.instructions ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    try { await api.setProjectDetails(project.id, { description, instructions }); setMessage('Project context saved.') }
    catch (err) { setError(String(err)) } finally { setBusy(false) }
  }
  return <div className="px-contextgrid">
    <form className="px-card px-form" onSubmit={(event) => void save(event)}>
      <div><h2>A shared starting point</h2><p className="px-muted">Keep the purpose and working conventions with the project.</p></div>
      <label>Project purpose<textarea rows={2} maxLength={2000} value={description} onChange={(e) => { setDescription(e.target.value); setMessage('') }} placeholder="What are we trying to accomplish?" /></label>
      <label>Agent instructions<textarea rows={9} maxLength={12000} value={instructions} onChange={(e) => { setInstructions(e.target.value); setMessage('') }} placeholder="Goals, constraints, preferred workflow, and what an agent should know…" /></label>
      <p className="px-muted">Included with the initial prompt in New terminal and in every scheduled task. Existing conversations are not rewritten. These instructions do not grant extra permissions.</p>
      {error && <p className="px-error" role="alert">{error}</p>}
      <div className="px-inline"><button className="px-button px-primary" disabled={busy}>{busy ? 'Saving…' : 'Save context'}</button><span role="status">{message}</span></div>
    </form>
    <section className="px-card px-contextaside"><Icon name="folder" size={28} /><h2>Where the work lives</h2><p>New project terminals and scheduled tasks start in this existing folder.</p><code>{project.defaultCwd}</code><FolderHint folder={project.defaultCwd} />
      <button className="px-button" onClick={() => useStore.getState().setOverlay({ kind: 'project', projectId: project.id })}>Change project folder</button>
      <div className="px-divider" /><h3>Project ≠ folder</h3><p>You can file conversations from different folders under the same goal. This never copies or consolidates those folders.</p>
      <p>Only enter context you want sent to the chosen agent provider. Credentials and private notes should stay out of shared instructions.</p>
    </section>
  </div>
}

export function PrototypeSchedules({ projectId }: { projectId: string | null }): JSX.Element {
  const experience = useStore((s) => s.experience)
  const projects = useStore((s) => s.sessionProjects)
  const [editing, setEditing] = useState<ScheduledTask | 'new' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const tasks = experience.tasks.filter((t) => !projectId || t.projectId === projectId)
  const runs = experience.runs.filter((r) => !projectId || r.projectId === projectId)
  const runNow = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      const run = await api.runTask(id)
      if (run?.error) throw new Error(run.error)
      if (run?.sessionId) useStore.getState().revealSession(run.sessionId)
    } catch (err) { reportError(err) } finally { setBusy(null) }
  }
  return <>
    <div className="px-hostnotice"><span className="px-hosticon"><Icon name="running" size={21} /></span><div><strong>This computer · Workbench must be open</strong><p>Local time: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Missed times run once when the app is available; sleeping or closed computers do not run tasks. Agent approvals may need you.</p></div><span className="px-tag">LOCAL ONLY</span></div>
    <SectionTitle title="Your scheduled work" action="New task" onClick={() => setEditing('new')} />
    <div className="px-card">
      {tasks.map((task) => <article className="px-task" key={task.id}>
        <div><div className="px-inline"><span className={`px-togglemark${task.enabled ? ' enabled' : ''}`} /><h3>{task.name}</h3><span className="px-tag">{task.enabled ? 'Enabled' : 'Paused'}</span></div>
          <p>{task.prompt}</p><div className="px-taskmeta"><span>{task.agent === 'codex' ? 'Codex CLI' : 'Claude Code'}</span><span>{projects.find((p) => p.id === task.projectId)?.name ?? 'Project removed'}</span><span>{task.cadence === 'weekly' ? dayNames[task.weekday] : task.cadence === 'weekdays' ? 'Weekdays' : 'Every day'} · {task.time}</span><span>Normal approvals</span></div>
          <div className="px-inline px-taskbuttons"><button className="px-button" disabled={busy === task.id} onClick={() => void runNow(task.id)}>{busy === task.id ? 'Starting…' : 'Run now'}</button>
            <button onClick={() => void api.toggleTask(task.id, !task.enabled).catch(reportError)}>{task.enabled ? 'Pause' : 'Enable'}</button>
            <button onClick={() => setEditing(task)}>Edit</button>
            <button onClick={() => { if (confirm !== task.id) setConfirm(task.id); else void api.removeTask(task.id).then(() => setConfirm(null)).catch(reportError) }}>{confirm === task.id ? 'Confirm remove' : 'Remove'}</button>
          </div>
        </div><div className="px-tasknext"><small>{task.enabled ? 'Next run' : 'Schedule paused'}</small><strong>{task.enabled ? date(task.nextRunAt) : 'Run manually anytime'}</strong></div>
      </article>)}
      {!tasks.length && <Empty title="Make room for repeatable work" text="Schedule a briefing, recurring review, or project check-in. Each run gets its own terminal and history." action={projects.length ? 'Create a task' : 'Create a project first'} onClick={() => projects.length ? setEditing('new') : useStore.getState().setOverlay({ kind: 'project' })} />}
    </div>
    <section className="px-runsection"><SectionTitle title="Run history" /><div className="px-card">{runs.slice(0, 30).map((run) => <div className="px-run" key={run.id}><span className={`px-state state-${run.status}`}><i />{run.status === 'review' ? 'Ready for review' : run.status}</span><div><strong>{run.taskName}</strong><small>{date(run.startedAt)}</small>{run.error && <p className="px-error">{run.error}</p>}</div>
      {run.sessionId && <button className="px-button" onClick={() => {
        if (useStore.getState().sessions.some((s) => s.id === run.sessionId)) useStore.getState().revealSession(run.sessionId!)
        else reportError(new Error('This terminal was removed. The run record is retained.'))
      }}>Open terminal →</button>}</div>)}
      {!runs.length && <Empty title="No runs yet" text="A saved task is not a completed task. Real launches and their lifecycle states will appear here." />}</div></section>
    {editing && <TaskDialog task={editing === 'new' ? undefined : editing} projectId={projectId} close={() => setEditing(null)} />}
  </>
}

function TaskDialog({ task, projectId, close }: { task?: ScheduledTask; projectId: string | null; close: () => void }): JSX.Element {
  const projects = useStore((s) => s.sessionProjects)
  const profiles = useStore((s) => s.profiles)
  const [form, setForm] = useState<TaskInput>(() => task ?? { name: '', prompt: '', projectId: projectId ?? projects[0]?.id ?? '', agent: 'codex', cadence: 'weekdays', time: '09:00', weekday: 1, enabled: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const change = <K extends keyof TaskInput>(key: K, value: TaskInput[K]): void => setForm((f) => ({ ...f, [key]: value }))
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError('')
    try { await api.saveTask(form); close() } catch (err) { setError(String(err)); setBusy(false) }
  }
  return <div className="overlay" onMouseDown={close}><form role="dialog" aria-modal="true" aria-labelledby="px-task-title" className="modal px-taskdialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => void save(e)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}>
    <div className="modal__head" id="px-task-title">{task ? 'Edit scheduled task' : 'New scheduled task'}<button type="button" aria-label="Close scheduled task" onClick={close}><Icon name="close" /></button></div>
    <div className="modal__body px-form">
      <label>Task name<input autoFocus required maxLength={120} value={form.name} onChange={(e) => change('name', e.target.value)} placeholder="Friday project briefing" /></label>
      <label>What should the agent do?<textarea required rows={4} maxLength={12000} value={form.prompt} onChange={(e) => change('prompt', e.target.value)} placeholder="Review recent changes and write a concise briefing in the project folder. Do not make code changes." /></label>
      <div className="px-formrow"><label>Project<ProjectSelect projects={projects} required value={form.projectId} emptyLabel="Choose a project" onChange={(id) => change('projectId', id)} /></label>
        <label>Agent<select value={form.agent} onChange={(e) => change('agent', e.target.value as 'codex' | 'claude')}><option value="codex">Codex CLI{profiles.find((p) => p.id === 'codex')?.available ? '' : ' (not installed)'}</option><option value="claude">Claude Code{profiles.find((p) => p.id === 'claude')?.available ? '' : ' (not installed)'}</option></select></label></div>
      <div className="px-formrow"><label>Repeat<select value={form.cadence} onChange={(e) => change('cadence', e.target.value as TaskInput['cadence'])}><option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option></select></label>
        {form.cadence === 'weekly' && <label>Day<select value={form.weekday} onChange={(e) => change('weekday', Number(e.target.value))}>{dayNames.map((day, i) => <option key={day} value={i}>{day}</option>)}</select></label>}
        <label>Local time<input type="time" required value={form.time} onChange={(e) => change('time', e.target.value)} /></label></div>
      <label className="px-checkbox"><input type="checkbox" checked={form.enabled} onChange={(e) => change('enabled', e.target.checked)} />Enable this recurring schedule</label>
      <p className="px-muted">Runs only while Workbench is open on this computer. A fresh terminal uses normal approval permissions; saving never enables full access. No run starts just because you save this form.</p>
      {error && <div className="px-error" role="alert">{error}</div>}
    </div><div className="modal__foot"><button type="button" className="px-button" onClick={close}>Cancel</button><button className="px-button px-primary" disabled={busy || !projects.length}>{busy ? 'Saving…' : 'Save task'}</button></div>
  </form></div>
}

export function PrototypeOutputs({ projectId, unreadOnly = false }: { projectId: string | null; unreadOnly?: boolean }): JSX.Element {
  const outputs = useStore((s) => s.experience.outputs)
  const sessions = useStore((s) => s.sessions)
  const projects = useStore((s) => s.sessionProjects)
  const [recent, setRecent] = useState<{ projectId: string | null; entries: PreviewEntry[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const scan = useRef(0)
  const project = projects.find((p) => p.id === projectId)
  const scopeName = project?.name ?? 'Unfiled'
  const scoped = filterOutputs(outputs, unreadOnly && !projectId ? undefined : projectId, unreadOnly)
  const recentEntries = recent?.projectId === projectId ? recent.entries : []
  const refresh = async (): Promise<void> => {
    const request = ++scan.current
    setBusy(true); setError('')
    const dirs = [...new Set([...(project ? [project.defaultCwd] : []), ...sessions.filter((s) => (s.sessionProjectId ?? null) === projectId).map((s) => s.cwd)])].slice(0, 12)
    try {
      const results = await Promise.all(dirs.map((dir) => api.previewRecent(dir, 20)))
      if (request === scan.current) setRecent({ projectId, entries: [...new Map(results.flat().map((entry) => [entry.path, entry])).values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 60) })
    } catch (err) { if (request === scan.current) setError(String(err)) }
    finally { if (request === scan.current) setBusy(false) }
  }
  // A scan can finish after the user changes projects. Invalidate that request
  // and tag its results with their scope so they cannot appear under the new
  // project, even during the render before this effect clears the old state.
  useEffect(() => {
    setRecent(null); setError(''); setBusy(false)
    return () => { scan.current++ }
  }, [projectId])
  const open = async (entry: PreviewEntry, owner?: string): Promise<void> => {
    await preview.open(entry.path, { owner: owner ?? null })
    if (!useStore.getState().preview.error && owner) await api.acknowledgeOutput(owner, entry.path).catch(reportError)
  }
  const card = (entry: PreviewEntry, record?: OutputRecord): JSX.Element => <article className="px-outputcard px-card" key={`${record?.sessionId ?? 'file'}:${entry.path}`}>
    <button className="px-outputopen" onClick={() => void open(entry, record?.sessionId)}><div className="px-fileart"><Icon name={entry.kind === 'image' || entry.kind === 'svg' ? 'image' : 'document'} size={35} /><span>{entry.kind.toUpperCase()}</span></div><strong>{entry.name}</strong><small>{date(entry.mtimeMs)} · {record ? record.seen ? 'Viewed' : 'New output' : 'Recent file · unattributed'}</small></button>
    <div className="px-outputfooter"><span title={entry.path}>{record ? projects.find((p) => p.id === record.projectId)?.name ?? (record.projectId ? 'Removed project' : 'Unfiled') : `${scopeName} · folder scan`}</span>
      {record && <button onClick={() => {
        if (sessions.some((s) => s.id === record.sessionId)) useStore.getState().revealSession(record.sessionId)
        else reportError(new Error('The source terminal was removed; the file is still available.'))
      }}>Source terminal →</button>}</div>
  </article>
  return <section className={unreadOnly ? 'px-runsection' : ''}>
    {!unreadOnly && <p className="px-outputfilter">{scoped.length} {scoped.length === 1 ? 'output' : 'outputs'} in {scopeName}</p>}
    <SectionTitle title={unreadOnly ? 'Unreviewed outputs' : `${scopeName} outputs`} action={!unreadOnly ? busy ? 'Scanning…' : 'Find recent files' : undefined} onClick={() => { if (!busy) void refresh() }} />
    {!!scoped.length && <div className="px-outputgrid">{scoped.map((o) => card(o, o))}</div>}
    {!scoped.length && <div className="px-card"><Empty title={unreadOnly ? 'No unread documents' : `No outputs in ${scopeName} yet`} text={unreadOnly ? 'New session documents will be collected here.' : 'Documents from these terminals appear automatically. Find recent files to browse the folders in this project.'} /></div>}
    {error && <p className="px-error" role="alert">{error}</p>}
    {!!recentEntries.length && <><SectionTitle title={`Recently changed in ${scopeName}`} /><div className="px-outputgrid">{recentEntries.filter((entry) => !outputs.some((o) => o.path === entry.path)).map((entry) => card(entry))}</div></>}
  </section>
}
