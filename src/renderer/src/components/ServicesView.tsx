import { useEffect, useRef, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import { MAX_SERVICE_LOG_CHARS, type ServiceInput, type ServiceRecord, type ServicesState } from '../../../shared/services'
import { useStore } from '../state/store'
import { Icon } from './Icon'
import { ProjectSelect } from './ProjectFilter'
import '../styles/services.css'

const api = window.term
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)
const live = (service: ServiceRecord): boolean => service.pid !== null || ['starting', 'running', 'stopping'].includes(service.status)
const statusLabel: Record<ServiceRecord['status'], string> = {
  stopped: 'Stopped', starting: 'Starting', running: 'Running', stopping: 'Stopping', exited: 'Exited', failed: 'Failed'
}

/**
 * This view observes the main process's service manager. Mounting or changing
 * projects must never launch a shell: services have their own lifecycle and
 * keep running when the user moves to a terminal or another workspace tab.
 * Subscribe before fetching the first snapshot, and prefer any pushed state
 * over a slower initial response so a stopped process cannot appear running.
 */
export function ServicesView({ projectId }: { projectId: string | null }): JSX.Element {
  const projects = useStore((state) => state.sessionProjects)
  const [state, setState] = useState<ServicesState>({ services: [], error: null })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [editing, setEditing] = useState<ServiceRecord | 'new' | null>(null)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let active = true
    let pushed = false
    setLoading(true); setLoadError('')
    const unsubscribe = api.onServices((next) => {
      pushed = true
      if (active) { setState(next); setLoading(false); setLoadError('') }
    })
    void api.serviceState().then((next) => {
      if (active && !pushed) setState(next)
    }).catch((error: unknown) => {
      if (active && !pushed) setLoadError(errorMessage(error))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; unsubscribe() }
  }, [attempt])

  const services = state.services.filter((service) => !projectId || service.projectId === projectId)
  const running = services.filter((service) => service.status === 'running').length
  const failed = services.filter((service) => service.status === 'failed').length
  const create = (): void => { setEditing('new'); setNotice('') }

  return <section className="services-view" aria-label="Background services">
    <div className="services-summary">
      <span className="services-summary__icon"><Icon name="terminal" size={23} /></span>
      <div><strong>Background work, in one place</strong><p>Saved commands run locally while Workbench is open. Choose which services start when the app opens; quitting Workbench stops them.</p></div>
      <span className="services-summary__count">{loading ? 'Loading…' : `${running} running`}</span>
    </div>
    <div className="services-heading"><div><h2>{projectId ? 'Project services' : 'All services'}</h2><p>{loading ? 'Reading saved services…' : `${services.length} saved${failed ? ` · ${failed} failed` : ''}`}</p></div>
      <button className="px-button px-primary" disabled={!!editing || loading || !!loadError || !!state.error || !projects.length} onClick={create}><Icon name="plus" size={14} />New service</button>
    </div>
    {(loadError || state.error) && <div className="px-error services-loaderror" role="alert"><span>{loadError || state.error}</span>
      <button className="px-button" disabled={loading} onClick={() => setAttempt((value) => value + 1)}>Try again</button></div>}
    {notice && <p className="services-notice" role="status">{notice}</p>}
    {editing && <ServiceEditor key={editing === 'new' ? 'new' : editing.id} service={editing === 'new' ? undefined : editing}
      projectId={projectId} close={() => setEditing(null)} onSaved={(name, started) => {
        setEditing(null); setNotice(`${name} ${started ? 'started' : 'saved'}.`)
      }} />}
    {!loading && !loadError && !state.error && !services.length && !editing && <div className="services-empty">
      <span><Icon name="globe" size={28} /></span><h3>A home for your running servers</h3>
      <p>Save a shell command for a local server, connection monitor, or recurring background process. Its status and recent output stay here.</p>
      <button className="px-button" onClick={() => projects.length ? create() : useStore.getState().setOverlay({ kind: 'project' })}>
        <Icon name="plus" size={14} />{projects.length ? 'Add your first service' : 'Create a project first'}</button>
    </div>}
    <div className="services-list">{services.map((service) => <ServiceCard key={service.id} service={service}
      projectName={projects.find((project) => project.id === service.projectId)?.name ?? 'Removed project'}
      editing={editing !== null && editing !== 'new' && editing.id === service.id}
      canEdit={!editing} onAction={() => setNotice('')} onEdit={() => { setEditing(service); setNotice('') }} />)}</div>
    <p className="services-footnote">Running means the shell process is alive. Check its output and the application’s connection status to confirm it is ready.</p>
  </section>
}

function ServiceCard({ service, projectName, editing, canEdit, onEdit, onAction }: {
  service: ServiceRecord; projectName: string; editing: boolean; canEdit: boolean; onEdit: () => void; onAction: () => void
}): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [expanded, setExpanded] = useState(service.status === 'failed')
  const [follow, setFollow] = useState(true)
  const output = useRef<HTMLPreElement>(null)
  const active = live(service)
  const transitioning = service.status === 'starting' || service.status === 'stopping'
  // Keep output bounded in the DOM as well as in the backend. Scrolling away
  // from the tail pauses following so fresh logs do not steal the line being
  // read; the user can resume following explicitly at any time.
  const log = service.log.slice(-MAX_SERVICE_LOG_CHARS)
  useEffect(() => {
    if (expanded && follow && output.current) output.current.scrollTop = output.current.scrollHeight
  }, [expanded, follow, log])
  const run = async (action: 'start' | 'stop' | 'restart' | 'remove'): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(action); setError('')
    onAction()
    try {
      if (action === 'remove') await api.removeService(service.id)
      else {
        const next = action === 'start' ? await api.startService(service.id)
          : action === 'stop' ? await api.stopService(service.id) : await api.restartService(service.id)
        if (next.status === 'failed' && next.error) throw new Error(next.error)
      }
      setConfirmRemove(false)
    } catch (cause) { setError(errorMessage(cause)); setExpanded(true) }
    finally { busyRef.current = false; setBusy(null) }
  }

  return <article className={`services-card services-card--${service.status}`} aria-label={service.name}>
    <div className="services-card__head"><span className="services-card__icon"><Icon name="terminal" size={20} /></span>
      <div className="services-card__identity"><h3>{service.name}</h3><div><span>{projectName}</span><span>{service.shell === 'powershell' ? 'PowerShell' : 'Bash'}</span><span>{service.autoStart ? 'Starts with Workbench' : 'Manual start'}</span></div></div>
      <span className="services-status" role="status"><i />{statusLabel[service.status]}</span>
    </div>
    <div className="services-command"><div><span>Working folder</span><code>{service.cwd}</code></div><div><span>Command</span><pre>{service.command}</pre></div></div>
    <div className="services-card__process">
      {service.pid !== null && <span>PID {service.pid}</span>}
      {service.startedAt !== null && <span>Started <time dateTime={new Date(service.startedAt).toISOString()}>{new Date(service.startedAt).toLocaleString()}</time></span>}
      {service.exitCode !== null && <span>Exit code {service.exitCode}</span>}
      {service.startedAt === null && <span>Not started in this app session</span>}
    </div>
    {service.error && <p className="px-error" role="alert">{service.error}</p>}
    {error && error !== service.error && <p className="px-error" role="alert">{error}</p>}
    <div className="services-card__actions">
      {active ? <><button className="px-button" disabled={!!busy || (transitioning && !service.error) || editing} onClick={() => void run('stop')}><Icon name="stop" size={13} />{busy === 'stop' ? 'Stopping…' : service.status === 'stopping' ? service.error ? 'Retry stop' : 'Stopping…' : 'Stop'}</button>
        <button className="px-button" disabled={!!busy || transitioning || editing} onClick={() => void run('restart')}><Icon name="refresh" size={13} />{busy === 'restart' ? 'Restarting…' : 'Restart'}</button></>
        : <button className="px-button" disabled={!!busy || editing} onClick={() => void run('start')}><Icon name="terminal" size={13} />{busy === 'start' ? 'Starting…' : 'Start'}</button>}
      <button className="services-textbutton" disabled={!!busy || active || !canEdit} title={active ? 'Stop the service to edit its command' : 'Edit saved service'} onClick={onEdit}>Edit</button>
      <button className="services-textbutton" disabled={!!busy || active || editing} title={active ? 'Stop the service before removing it' : 'Remove saved service'} onClick={() => setConfirmRemove(!confirmRemove)}>Remove</button>
    </div>
    {confirmRemove && <div className="services-remove"><span>Remove this saved service?</span><button className="px-button" disabled={!!busy} onClick={() => setConfirmRemove(false)}>Keep service</button>
      <button className="px-button services-danger" disabled={!!busy || active || editing} onClick={() => void run('remove')}>{busy === 'remove' ? 'Removing…' : 'Remove service'}</button></div>}
    <div className="services-log">
      <button className="services-log__toggle" aria-expanded={expanded} aria-controls={`service-output-${service.id}`} onClick={() => setExpanded(!expanded)}>
        <Icon name="chevron" size={13} /><span>{expanded ? 'Hide output' : 'Show output'}</span><small>Recent output · live while open</small></button>
      {expanded && <div id={`service-output-${service.id}`}><div className="services-log__toolbar"><span>Recent output is kept for this app session.</span>
        <label><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />Follow output</label></div>
        <pre ref={output} tabIndex={0} aria-label={`${service.name} output`} onScroll={(event) => {
          const element = event.currentTarget
          if (element.scrollHeight - element.scrollTop - element.clientHeight > 30) setFollow(false)
        }}>{log || 'No output yet.'}</pre></div>}
    </div>
  </article>
}

function ServiceEditor({ service, projectId, close, onSaved }: {
  service?: ServiceRecord; projectId: string | null; close: () => void; onSaved: (name: string, started: boolean) => void
}): JSX.Element {
  const projects = useStore((state) => state.sessionProjects)
  const initialProject = projects.find((project) => project.id === projectId) ?? projects[0]
  const [form, setForm] = useState<ServiceInput>(() => service ? {
    id: service.id, name: service.name, projectId: service.projectId, cwd: service.cwd,
    command: service.command, shell: service.shell, autoStart: service.autoStart
  } : { name: '', projectId: initialProject?.id ?? '', cwd: initialProject?.defaultCwd ?? '',
    command: '', shell: api.platform === 'win32' ? 'powershell' : 'bash', autoStart: false })
  const [busy, setBusy] = useState<'save' | 'start' | null>(null)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const editor = useRef<HTMLFormElement>(null)
  useEffect(() => { editor.current?.scrollIntoView({ block: 'nearest' }) }, [])
  const change = <K extends keyof ServiceInput>(key: K, value: ServiceInput[K]): void => setForm((current) => ({ ...current, [key]: value }))
  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busyRef.current) return
    const submitter = (event.nativeEvent as SubmitEvent).submitter
    const start = submitter instanceof HTMLButtonElement && submitter.value === 'start'
    busyRef.current = true; setBusy(start ? 'start' : 'save'); setError('')
    let saved: ServiceRecord | null = null
    try {
      saved = await api.saveService(form)
      // A successful save followed by a failed launch is still one service.
      // Retain its assigned ID so retrying never creates a duplicate definition.
      setForm((current) => ({ ...current, id: saved!.id }))
      if (start) {
        const started = await api.startService(saved.id)
        if (started.status === 'failed' && started.error) throw new Error(started.error)
      }
      onSaved(saved.name, start)
    } catch (cause) { setError(`${saved ? 'Service saved, but it could not start. ' : ''}${errorMessage(cause)}`) }
    finally { busyRef.current = false; setBusy(null) }
  }
  return <form className="services-editor" ref={editor} aria-labelledby="service-editor-title" onSubmit={(event) => void save(event)}>
    <div className="services-editor__heading"><div><h3 id="service-editor-title">{form.id ? 'Edit service' : 'New service'}</h3><p>Review the shell, folder, and command that Workbench will run.</p></div>
      <button type="button" className="services-textbutton" disabled={!!busy} aria-label="Close service editor" onClick={close}><Icon name="close" size={17} /></button></div>
    <fieldset disabled={!!busy} className="px-form"><label>Service name<input autoFocus required maxLength={120} value={form.name} onChange={(event) => change('name', event.target.value)} placeholder="Project server" /></label>
      <div className="px-formrow"><label>Project<ProjectSelect projects={projects} required value={form.projectId} emptyLabel="Choose a project" onChange={(id) => {
        const previous = projects.find((project) => project.id === form.projectId)
        const next = projects.find((project) => project.id === id)
        setForm((current) => ({ ...current, projectId: id, cwd: !current.cwd || current.cwd === previous?.defaultCwd ? next?.defaultCwd ?? '' : current.cwd }))
      }} /></label>
        <label>Shell<select value={form.shell} onChange={(event) => change('shell', event.target.value as ServiceInput['shell'])}><option value="powershell">PowerShell</option><option value="bash">Bash</option></select></label></div>
      <label>Working folder<input required maxLength={4096} value={form.cwd} onChange={(event) => change('cwd', event.target.value)} placeholder="Absolute path to the project folder" spellCheck={false} /></label>
      <label>Command<textarea className="services-editor__command" required rows={4} maxLength={32000} value={form.command} onChange={(event) => change('command', event.target.value)} placeholder={form.shell === 'powershell' ? '.\\scripts\\Start-Server.ps1' : './scripts/start-server.sh'} spellCheck={false} /></label>
      <label className="px-checkbox"><input type="checkbox" checked={form.autoStart} onChange={(event) => change('autoStart', event.target.checked)} />Start when Workbench opens</label>
      <p className="services-editor__hint">Use a command that keeps its process running in the foreground. Workbench keeps it in the background and captures its output.</p>
    </fieldset>
    {error && <p className="px-error" role="alert">{error}</p>}
    <div className="services-editor__footer"><p>Saving applies to the next start. Start now with “Save and start.”</p><div><button type="button" className="px-button" disabled={!!busy} onClick={close}>Cancel</button>
      <button type="submit" className="px-button" value="save" disabled={!!busy || !projects.length}>{busy === 'save' ? 'Saving…' : 'Save service'}</button>
      <button type="submit" className="px-button px-primary" value="start" disabled={!!busy || !projects.length}>{busy === 'start' ? 'Starting…' : 'Save and start'}</button></div></div>
  </form>
}
