import { UpdateNotice } from './UpdatesPanel'
import { useEffect, useMemo, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { useStore } from '../state/store'
import { actions } from '../lib/actions'
import { relTime } from '../lib/ui'
import { sessionTaskSummary, sidebarSessionTitle } from '../../../shared/sessionTitle'
import { filterOutputs, filterSessions, type ExperienceView } from '../../../shared/experience'
import { STATUS_META, type Session } from '../../../shared/types'
import { Icon, type IconName } from './Icon'
import { ResizeHandle, usePanelWidth } from './ResizeHandle'
import { useContextMenu } from './ContextMenu'
import { WorkbenchMark } from './WorkbenchMark'
import { TitleBar } from './TitleBar'
import { PreviewDock } from './PreviewDock'
import { PrototypeContext, PrototypeOutputs, PrototypeSchedules } from './ExperienceViews'
import { ProjectArt, ProjectMark, projectDesignStyle } from './ProjectArtwork'
import { ProjectFilter, ProjectSelect } from './ProjectFilter'
import { FocusView } from './FocusView'
import { InboxView } from './InboxView'
import { ServicesView } from './ServicesView'
import { selectInboxSessions } from '../../../shared/inbox'
import { activeFocusProjects } from '../../../shared/focusProjects'

const api = window.term
const labels: Record<ExperienceView, string> = {
  overview: 'Overview', terminals: 'Terminals', focus: 'Focus', inbox: 'Inbox', scheduled: 'Scheduled', services: 'Services', outputs: 'Outputs', context: 'Context'
}
export function reportError(error: unknown): void {
  useStore.getState().setToast(error instanceof Error ? error.message : String(error), 'error')
}
function remembered(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}

/**
 * Navigation wraps, rather than replaces, the real terminal workspace. Keeping
 * children mounted is important: recreating xterm for each project-home visit
 * would detach the client and turn a simple navigation into a resize storm.
 */
export function ExperienceShell({ children }: { children: ReactNode }): JSX.Element {
  const menu = useContextMenu()
  const sidebar = usePanelWidth({ key: 'workbench.projectWidth', preferred: 218, min: 140, max: 440, reserve: 560 })
  const rail = usePanelWidth({ key: 'workbench.terminalListWidth', preferred: 250, min: 120, max: 480, reserve: 220 })
  const view = useStore((s) => s.experienceView)
  const projectId = useStore((s) => s.experienceProjectId)
  const navigate = useStore((s) => s.navigateExperience)
  const openProject = useStore((s) => s.openProject)
  const projects = useStore((s) => s.sessionProjects)
  const sessions = useStore((s) => s.sessions)
  const experience = useStore((s) => s.experience)
  const shownProjects = view === 'focus' ? activeFocusProjects(projects, sessions, experience.archivedIds) : projects
  const profiles = useStore((s) => s.profiles)
  const [query, setQuery] = useState('')
  const [agent, setAgent] = useState('')
  const [status, setStatus] = useState('')
  const [archived, setArchived] = useState(false)
  const [theme, setTheme] = useState(() => remembered('prototype.theme', 'dark'))
  const [density, setDensity] = useState(() => remembered('prototype.density', 'comfortable'))
  const project = projects.find((p) => p.id === projectId)
  const selectedId = project?.id ?? null
  // Archived conversations stay in the session snapshot so their history and
  // saved panes remain accessible. Navigation describes the current list, so
  // its totals must use the same archive boundary as the default terminal view.
  // Keep this independent of search/status filters and the Archived toggle:
  // inspecting old work should not make the retired team count as current again.
  const currentSessions = useMemo(() => {
    const archivedIds = new Set(experience.archivedIds)
    return sessions.filter((s) => !archivedIds.has(s.id))
  }, [sessions, experience.archivedIds])
  const scoped = currentSessions.filter((s) => !selectedId || s.sessionProjectId === selectedId)
  const projectCounts = new Map<string, number>()
  for (const session of currentSessions) {
    if (session.sessionProjectId) projectCounts.set(session.sessionProjectId, (projectCounts.get(session.sessionProjectId) ?? 0) + 1)
  }
  const inbox = selectInboxSessions(sessions, experience.archivedIds, selectedId)
  const attention = inbox.filter((s) => s.status === 'waiting' || s.status === 'failed')
  const inputCount = inbox.filter((s) => s.status === 'waiting').length
  const filtered = useMemo(() => filterSessions(sessions, experience.archivedIds,
    { projectId: selectedId, query, agent, status, archived }), [sessions, experience.archivedIds, selectedId, query, agent, status, archived])
  const starter = profiles.find((p) => p.available && p.id === 'codex')?.id
    ?? profiles.find((p) => p.available && p.id !== 'shell')?.id ?? 'shell'
  const newSession = (): void => actions.openNewSession(starter, selectedId ?? undefined)
  const newProject = (): void => useStore.getState().setOverlay({ kind: 'project' })
  const outputProjectId = view === 'outputs' ? selectedId : selectedId ?? projects[0]?.id ?? null
  const outputCount = filterOutputs(experience.outputs, outputProjectId, true).length

  useEffect(() => {
    document.documentElement.dataset.prototypeTheme = theme
    document.documentElement.dataset.prototypeDensity = density
    try { localStorage.setItem('prototype.theme', theme); localStorage.setItem('prototype.density', density) } catch { /* preferences are optional */ }
  }, [theme, density])
  useEffect(() => { if (projectId && !project) navigate('overview', null) }, [projectId, project, navigate])

  const navItem = (target: ExperienceView, icon: IconName, name: string, count?: number): JSX.Element => (
    <button className={`px-nav${view === target && !selectedId ? ' is-active' : ''}`}
      onClick={() => navigate(target, null)}><Icon name={icon} /><span>{name}</span>
      {!!count && <small>{count}</small>}</button>
  )
  return <>
    {menu.node}
    <TitleBar />
    <div className="px-shell" style={{ gridTemplateColumns: `${sidebar.width}px minmax(0, 1fr)` }}>
      <div className="px-sidebar-wrap" ref={sidebar.ref}>
      <aside className="px-sidebar">
        <button className="px-brand" onClick={() => navigate('overview', null)} aria-label="Workbench home">
          <span className="px-mark"><WorkbenchMark /></span><span>Workbench<small>BETA</small></span>
        </button>
        <button className="px-create" onClick={newSession}><Icon name="plus" /> New terminal</button>
        <nav className="px-navigation" aria-label="Workbench navigation">
          {navItem('overview', 'sessions', 'Home')}
          {navItem('focus', 'person', 'Focus')}
          {navItem('inbox', 'waiting', 'Inbox', selectInboxSessions(sessions, experience.archivedIds, null).length)}
          {navItem('terminals', 'terminal', 'All terminals', currentSessions.length)}
          {navItem('scheduled', 'running', 'Scheduled', experience.tasks.filter((t) => t.enabled).length)}
          {navItem('services', 'globe', 'Services')}
          <button className={`px-nav${view === 'outputs' ? ' is-active' : ''}`} onClick={() => navigate('outputs', outputProjectId)}>
            <Icon name="document" /><span>Outputs</span>
            {!!outputCount && <small>{outputCount}</small>}
          </button>
        </nav>
        <div className="px-sectionlabel"><span>Projects</span><button title="New project" aria-label="New project" onClick={newProject}><Icon name="plus" size={14} /></button></div>
        <nav className="px-projectnav" aria-label="Projects">
          {shownProjects.map((p) => <button key={p.id} className={`px-nav project-design${p.id === selectedId ? ' is-active' : ''}`}
            style={projectDesignStyle(p.appearance)}
            title={p.name} onClick={() => openProject(p.id)} onContextMenu={(e) => menu.open(e, [
              { label: 'Edit project…', onSelect: () => useStore.getState().setOverlay({ kind: 'project', projectId: p.id }) },
              { label: 'Share project…', onSelect: () => useStore.getState().setOverlay({ kind: 'project-share', projectId: p.id }) },
              { label: 'Delete project…', danger: true, onSelect: () => useStore.getState().setOverlay({ kind: 'project', projectId: p.id, confirmDelete: true }) }
            ])} onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-workbench-session')) e.preventDefault()
            }} onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('application/x-workbench-session');
              if (id) void api.assignSessionProject(id, p.id).catch(reportError) }}>
            <ProjectMark name={p.name} appearance={p.appearance} />
            <span>{p.name}</span>{!!projectCounts.get(p.id) && <small title="Unarchived terminals">{projectCounts.get(p.id)}</small>}
          </button>)}
          {!shownProjects.length && <p className="px-navhint">{view === 'focus' ? 'No active projects.' : 'Give related terminals a home.'}</p>}
          <button className="px-nav px-nav-new" onClick={newProject}><Icon name="plus" /> Create project</button>
        </nav>
        <div className="px-sidebottom">
          <UpdateNotice />
          <span><i className="px-online" /> Local terminal engine</span>
          <small>{sessions.filter((s) => s.alive).length} terminals connected · tmux</small>
          <button onClick={() => useStore.getState().setOverlay({ kind: 'settings' })}><Icon name="settings" size={15} /> Settings & agents</button>
        </div>
      </aside>
      <ResizeHandle label="Projects sidebar width" className="resize-handle--right" value={sidebar.width} min={140} max={sidebar.maximum} onDelta={sidebar.resize} onEnd={sidebar.finish} onReset={sidebar.reset} />
      </div>
      <div className={`px-content${project ? ' project-design' : ''}`} style={project ? projectDesignStyle(project.appearance) : undefined}>
        <header className="px-toolbar">
          <div className="px-breadcrumb"><button onClick={() => navigate('overview', null)}>Workbench</button><span>/</span><strong>{project?.name ?? 'Your workspace'}</strong></div>
          <div className="px-tools">
            <button title="Search sessions and commands" onClick={() => useStore.getState().setOverlay({ kind: 'palette' })}><Icon name="search" size={15} /> Search</button>
            <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Change shell theme; terminals stay dark">{theme === 'dark' ? 'Light' : 'Dark'} shell</button>
            <button onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}>{density === 'compact' ? 'Comfortable' : 'Compact'}</button>
          </div>
        </header>
        <div className={`px-heading${view === 'terminals' ? ' px-heading-small' : ''}`}>
          <div className="px-headingcopy">
            {project && <ProjectArt name={project.name} appearance={project.appearance} className="px-headingart" />}
            <div>
            <div className="px-eyebrow">{selectedId ? 'PROJECT WORKSPACE' : 'YOUR LOCAL WORKBENCH'}</div>
            <h1>{view === 'overview' ? project?.name ?? 'A little more room to think.' : labels[view]}</h1>
            <p>{view === 'overview' ? experience.projectDetails[selectedId ?? '']?.description || (selectedId ? 'One purpose. Your terminals, context, and outputs together.' : 'Your projects, agents, and next steps—all in one place.')
              : view === 'terminals' ? 'Real terminals. Keep your workflow; find the conversation you need.'
              : view === 'focus' ? 'Your agents, their progress, and the moments that matter.'
              : view === 'scheduled' ? 'Repeat the useful work. Every run opens a real agent terminal.'
              : view === 'services' ? 'Keep your background shells and local servers together while Workbench is open.'
              : view === 'inbox' ? 'Questions you can answer, problems to check, and replies ready to read.'
              : view === 'outputs' ? project ? `Documents from ${project.name}, with a path back to the source terminal.` : 'Browse documents by the project they came from.' : 'A shared starting point for new agent conversations.'}</p>
            </div>
          </div>
          <div className="px-headingactions">
            {project && <button className="px-button" onClick={() => useStore.getState().setOverlay({ kind: 'project-share', projectId: project.id })}>Share project</button>}
            {project && <button className="px-button px-designproject" onClick={() => useStore.getState().setOverlay({ kind: 'project', projectId: project.id })}><Icon name="pencil" size={14} /> Edit project</button>}
            <button className="px-button px-primary" onClick={selectedId ? newSession : newProject}><Icon name="plus" size={15} />{selectedId ? 'New terminal' : 'New project'}</button>
          </div>
        </div>
        <nav className="px-tabs services-navigation" aria-label="Workspace sections">
          {(['overview', 'terminals', 'focus', 'scheduled', 'services', 'outputs', ...(selectedId ? ['context'] : [])] as ExperienceView[]).map((tab) =>
            <button key={tab} className={view === tab ? 'is-active' : ''} onClick={() => navigate(tab, tab === 'outputs' ? outputProjectId : selectedId)}>{labels[tab]}{tab === 'terminals' && <small>{scoped.length}</small>}</button>)}
        </nav>
        <ProjectFilter projects={shownProjects} value={selectedId} emptyLabel={view === 'outputs' ? 'Unfiled' : 'All projects'}
          onChange={(id) => navigate(view === 'context' && !id ? 'overview' : view, id)} />
        {experience.error && <div className="px-error" role="alert">{experience.error}</div>}
        <div className="px-stage">
          <div className="px-stage-main">
            {view === 'overview' && <div className="px-page">
              <div className="px-stats">
                <Stat label="Needs your input" count={inputCount} detail="Current questions and approval requests" tone="amber" onClick={() => navigate('inbox')} />
                <Stat label="Working now" count={scoped.filter((s) => s.status === 'working').length} detail="Agents making progress" tone="blue" onClick={() => { setStatus('working'); navigate('terminals') }} />
                <Stat label="Scheduled" count={experience.tasks.filter((t) => (!selectedId || t.projectId === selectedId) && t.enabled).length} detail="Enabled on this computer" tone="sage" onClick={() => navigate('scheduled')} />
              </div>
              <div className="px-homecolumns">
                <section><SectionTitle title="Pick up where you left off" action="All terminals" onClick={() => navigate('terminals')} />
                  <div className="px-card">{scoped.slice().sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, 6).map((s) => <SessionCard key={s.id} session={s} />)}
                    {!scoped.length && <Empty title="Space for your next idea" text="Start a terminal here. Your agents and files stay on this computer." action="New terminal" onClick={newSession} />}</div>
                </section>
                <section><SectionTitle title="On your radar" />
                  <div className="px-card px-radar"><div className="px-eyebrow"><Icon name="waiting" size={14} /> NEXT STEPS</div>
                    {attention.length ? attention.slice(0, 3).map((s) => <button key={s.id} className="px-radaritem" onClick={() => useStore.getState().revealSession(s.id)}><strong>{purpose(s)}</strong><small>{STATUS_META[s.status].label}</small></button>)
                      : <p>No questions waiting for you. Your terminals remain available below.</p>}
                    <button className="px-button" onClick={() => navigate('inbox')}>Open inbox <span>→</span></button>
                  </div>
                  <div className="px-note"><Icon name="terminal" /><div><strong>Still your terminal workflow.</strong><p>Splits, forks, files, Git, sharing, and the composer remain in the Terminals workspace.</p></div></div>
                </section>
              </div>
              {!selectedId && <section className="px-projectsection"><SectionTitle title="Your projects" action="Create project" onClick={newProject} />
                <div className="px-projectgrid">{projects.map((p) => <article className="px-card px-projecttile project-design" key={p.id} style={projectDesignStyle(p.appearance)}>
                  <button className="px-projectcard" onClick={() => openProject(p.id)}>
                    <div className="px-projectcard-cover"><ProjectMark name={p.name} appearance={p.appearance} /><ProjectArt name={p.name} appearance={p.appearance} /></div>
                    <h3>{p.name}</h3><p>{experience.projectDetails[p.id]?.description || 'A home for related work.'}</p>
                    <small>{projectCounts.get(p.id) ?? 0} terminals <span>→</span></small>
                  </button>
                  <button className="px-projectedit" title={`Edit ${p.name}`} aria-label={`Edit ${p.name}`}
                    onClick={() => useStore.getState().setOverlay({ kind: 'project', projectId: p.id })}><Icon name="pencil" size={13} /></button>
                </article>)}
                  <button className="px-projectnew" onClick={newProject}><Icon name="plus" size={24} /><strong>Create a project</strong><small>Bring a goal and its conversations together.</small></button></div>
              </section>}
            </div>}
            {view === 'inbox' && <div className="px-page"><InboxView projectId={selectedId} /></div>}
            {view === 'scheduled' && <div className="px-page"><PrototypeSchedules projectId={selectedId} /></div>}
            {view === 'services' && <div className="px-page"><ServicesView projectId={selectedId} /></div>}
            {view === 'outputs' && <div className="px-page"><PrototypeOutputs projectId={selectedId} /></div>}
            {view === 'focus' && <FocusView key={selectedId ?? 'all-projects'} projectId={selectedId} showProjectFilter={false} />}
            {view === 'context' && project && <div className="px-page"><PrototypeContext key={project.id} project={project} /></div>}
            <div className="px-terminalview" hidden={view !== 'terminals'}>
              <div className="px-sessionrail" ref={rail.ref} style={{ width: rail.width }}>
                <label className="px-search"><Icon name="search" size={14} /><input aria-label={project ? `Search ${project.name} terminals` : 'Search terminal names'} placeholder={project ? `Search ${project.name}…` : 'Find a conversation…'} value={query} onChange={(e) => setQuery(e.target.value)} /></label>
                <div className="px-filters"><select aria-label="Filter agent" value={agent} onChange={(e) => setAgent(e.target.value)}><option value="">All agents</option>{profiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
                  <select aria-label="Filter status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All states</option><option value="attention">Needs attention</option>{Object.entries(STATUS_META).map(([id, meta]) => <option key={id} value={id}>{meta.label}</option>)}</select></div>
                <div className="px-filtercaption"><span>{filtered.length} conversations</span><button className={archived ? 'is-active' : ''} onClick={() => setArchived(!archived)}>{archived ? 'Show active' : 'Archived'}</button></div>
                <div className="px-sessionlist">{filtered.map((s) => <SessionCard key={s.id} session={s} compact archived={archived} />)}
                  {!filtered.length && <Empty title="No matching terminals" text="Try another filter or start a new conversation." action="Reset filters" onClick={() => { setQuery(''); setAgent(''); setStatus(''); setArchived(false) }} />}</div>
                <button className="px-button px-railnew" onClick={newSession}><Icon name="plus" /> New terminal</button>
              </div>
              <ResizeHandle label="Terminal list width" className="resize-handle--rail" value={rail.width} min={120} max={rail.maximum} onDelta={rail.resize} onEnd={rail.finish} onReset={rail.reset} />
              <div className="px-terminalhost">{children}</div>
            </div>
          </div>
          <PreviewDock />
        </div>
      </div>
    </div>
  </>
}

function purpose(session: Session): string {
  const profile = useStore.getState().profiles.find((p) => p.id === session.agent)
  return sidebarSessionTitle(session, profile?.label ?? session.agent)
}
export function SessionCard({ session, compact = false, archived = false }: { session: Session; compact?: boolean; archived?: boolean }): JSX.Element {
  const profiles = useStore((s) => s.profiles)
  const projects = useStore((s) => s.sessionProjects)
  const profile = profiles.find((p) => p.id === session.agent)
  const [menu, setMenu] = useState(false)
  const [removing, setRemoving] = useState(false)
  const open = (): void => useStore.getState().revealSession(session.id)
  const remove = async (): Promise<void> => {
    if (removing) return
    setRemoving(true)
    try {
      // Use the same removal path as the original sidebar: it stops the tmux
      // session and clears its panes. Archiving only changes list visibility,
      // so using it here would leave the terminal running after clicking ×.
      await actions.remove(session.id)
      useStore.getState().setToast(
        session.alive ? `Stopped and removed ${session.title}` : `Removed ${session.title}`, 'info'
      )
    } catch (error) {
      reportError(error)
    } finally {
      setRemoving(false)
    }
  }
  return <div className={`px-session${compact ? ' px-session-compact' : ''}`} draggable onDragStart={(e) => { e.dataTransfer.setData('application/x-workbench-session', session.id); e.dataTransfer.effectAllowed = 'move' }}>
    <button className="px-sessionopen" onClick={open}>
      <div className="px-sessionidentity"><strong>{purpose(session)}</strong></div>
      <p className="px-sessionabout">{sessionTaskSummary(session)}</p>
      <div className="px-sessionmeta"><span className={`px-state state-${session.status}`}><i />{STATUS_META[session.status].label}</span><span className="px-agent" style={{ color: profile?.color }}>{profile?.label ?? session.agent}</span><time>{relTime(session.lastActivityAt)}</time>{session.pinned && <Icon name="pinned" size={11} />}</div>
    </button>
    <button className="px-more" aria-label={`Options for ${purpose(session)}`} aria-expanded={menu} onClick={() => setMenu(!menu)}>···</button>
    <button className="px-sessionclose" disabled={removing} draggable={false}
      title={session.alive ? `Stop "${session.title}" and remove it from the list` : `Remove "${session.title}" from the list`}
      aria-label={`${session.alive ? 'Stop and remove terminal' : 'Remove terminal'}: ${purpose(session)}`}
      onClick={(e) => { e.stopPropagation(); void remove() }}>
      <Icon name="close" size={13} strokeWidth={1.6} />
    </button>
    {menu && <div className="px-sessionactions">
      <label>Project<ProjectSelect projects={projects} value={session.sessionProjectId ?? ''} emptyLabel="Unfiled" onChange={(id) => { void api.assignSessionProject(session.id, id || null).catch(reportError); setMenu(false) }} /></label>
      <button onClick={() => { useStore.getState().setOverlay({ kind: 'rename', target: 'session', id: session.id, current: session.title }); setMenu(false) }}>Set role</button>
      <button onClick={() => { void api.pinSession(session.id, !session.pinned).catch(reportError); setMenu(false) }}>{session.pinned ? 'Unpin' : 'Pin'}</button>
      <button onClick={() => { void api.archiveSession(session.id, !archived).catch(reportError); setMenu(false) }}>{archived ? 'Restore to list' : 'Archive from list'}</button>
      <small>Archiving keeps this terminal running.</small>
    </div>}
  </div>
}
function Stat({ label, count, detail, tone, onClick }: { label: string; count: number; detail: string; tone: string; onClick: () => void }): JSX.Element {
  return <button className={`px-stat tone-${tone}`} onClick={onClick}><span>{label}</span><strong>{count}</strong><small>{detail}</small></button>
}
export function SectionTitle({ title, action, onClick }: { title: string; action?: string; onClick?: () => void }): JSX.Element {
  return <div className="px-sectiontitle"><h2>{title}</h2>{action && <button onClick={onClick}>{action} →</button>}</div>
}
export function Empty({ title, text, action, onClick }: { title: string; text: string; action?: string; onClick?: () => void }): JSX.Element {
  return <div className="px-empty"><strong>{title}</strong><p>{text}</p>{action && <button className="px-button" onClick={onClick}>{action}</button>}</div>
}
