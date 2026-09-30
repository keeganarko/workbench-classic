import { useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { actions } from '../lib/actions'
import { preview } from '../lib/preview'
import { relTime } from '../lib/ui'
import { FOCUS_CARD_PAGE_SIZE, FOCUS_STATUS, focusOutputs, focusSessions, focusStatus, focusText } from '../../../shared/focusJournal'
import { activeFocusProjects } from '../../../shared/focusProjects'
import type { OutputRecord } from '../../../shared/experience'
import type { Session, SessionStatus } from '../../../shared/types'
import { taskText } from '../../../shared/sessionTitle'
import { Icon, type IconName } from './Icon'
import { FocusReportImage } from './FocusReportImage'
import { CentralAgentPanel } from './CentralAgentPanel'
import { FocusProjectOverview } from './FocusProjectOverview'

import type { FocusUpdate } from '../../../shared/focusUpdate'

const ICONS: Record<SessionStatus, IconName> = {
  working: 'running', waiting: 'waiting', review: 'check', failed: 'failed', idle: 'person', exited: 'stop'
}
const timeLabel = (at: number): string => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** One board, fed by the same pushed snapshots as the sidebar. Hidden boards
 * unmount; terminal clients stay mounted in ExperienceShell. Twelve lightweight
 * cards per page cap DOM work without creating a terminal, timer, model call or
 * arbitrary document frame per agent. Original artifact content opens on demand
 * in the existing Preview service, which owns its filesystem/CSP boundary. */
export function FocusView({ projectId, showProjectFilter = true }: { projectId: string | null; showProjectFilter?: boolean }): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const projects = useStore((s) => s.sessionProjects)
  const profiles = useStore((s) => s.profiles)
  const experience = useStore((s) => s.experience)
  const reports = experience.focusUpdates
  const activeProjects = activeFocusProjects(projects, sessions, experience.archivedIds)
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [compact, setCompact] = useState(false)
  const [page, setPage] = useState(0)
  const [overview, setOverview] = useState(true)
  const project = projects.find((p) => p.id === projectId)
  const appWide = projectId === null
  const all = focusSessions(sessions, projectId, experience.archivedIds, appWide)
  const attention = all.filter((s) => focusStatus(s) === 'waiting' || focusStatus(s) === 'failed')
  const shown = attentionOnly ? attention : all
  const pages = Math.max(1, Math.ceil(shown.length / FOCUS_CARD_PAGE_SIZE))
  const activePage = Math.min(page, pages - 1)
  const visible = shown.slice(activePage * FOCUS_CARD_PAGE_SIZE, (activePage + 1) * FOCUS_CARD_PAGE_SIZE)
  const newTerminal = (): void => {
    const agent = profiles.find((p) => p.available && p.id === 'codex')?.id
      ?? profiles.find((p) => p.available && p.id !== 'shell')?.id ?? 'shell'
    actions.openNewSession(agent, projectId ?? undefined)
  }

  if (!appWide && !project) return <section className="focus-board focus-empty" aria-labelledby="focus-choose">
    <Icon name="sessions" size={30} /><h2 id="focus-choose">A shared view of one project</h2>
    <p>Choose a project to see its agents, progress, and latest results together.</p>
    <div className="focus-projects">{activeProjects.map((p) => <button className="px-button" key={p.id}
      onClick={() => useStore.getState().navigateExperience('focus', p.id)}><Icon name="folder" />{p.name}</button>)}</div>
    {!projects.length && <button className="px-button px-primary" onClick={() => useStore.getState().setOverlay({ kind: 'project' })}>Create project</button>}
  </section>

  return <section className={`focus-board${compact ? ' focus-board--compact' : ''}`} aria-label={`${project?.name ?? 'All projects'} agent focus`}>
    {appWide && <CentralAgentPanel onOverview={() => {
      setOverview(true)
      // The overview can sit below the fold in a short desktop window. Make
      // clicking the central agent reveal the drawings, even if already chosen.
      requestAnimationFrame(() => document.getElementById('focus-project-overview')?.scrollIntoView({
        block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
      }))
    }} />}
    <div className="focus-topline">
      <div><span className="focus-kicker"><i /> {appWide ? 'ACROSS YOUR WORKBENCH' : 'PROJECT PULSE'}</span><h2>Everyone’s work, in view.</h2>
        <p>{appWide ? 'Active projects and their latest progress.' : `Short updates from ${project!.name}’s running sessions.`}</p></div>
      <div className="focus-controls">
        {appWide && <><button className="px-button" aria-pressed={overview} onClick={() => setOverview(true)}>Projects</button><button className="px-button" aria-pressed={!overview} onClick={() => setOverview(false)}>Agents</button></>}
        {(!appWide || !overview) && <>
        <button className="px-button" aria-pressed={attentionOnly} onClick={() => { setAttentionOnly(!attentionOnly); setPage(0) }}>Needs you{attention.length ? ` · ${attention.length}` : ''}</button>
        <button className="px-button" aria-pressed={compact} onClick={() => setCompact(!compact)}>{compact ? 'Show milestones' : 'Compact view'}</button>
        </>}
      </div>
    </div>
    {showProjectFilter && <nav className="focus-project-filter" aria-label="Focus project filter">
      <button className="px-button" aria-current={appWide ? 'page' : undefined} onClick={() => useStore.getState().navigateExperience('focus', null)}>All projects</button>
      {activeProjects.map(p => <button className="px-button" key={p.id} aria-current={projectId === p.id ? 'page' : undefined}
        onClick={() => useStore.getState().navigateExperience('focus', p.id)}><Icon name="folder" size={12} />{p.name}</button>)}
    </nav>}
    {appWide && overview ? <FocusProjectOverview /> : <>
    <div className="focus-counts" aria-label="Project status counts">
      <span><b>{all.length}</b> sessions</span>
      <span className="focus-count-working"><i /><b>{all.filter((s) => focusStatus(s) === 'working').length}</b> working</span>
      <span className="focus-count-review"><i /><b>{all.filter((s) => focusStatus(s) === 'review').length}</b> ready for review</span>
      <span className="focus-count-waiting"><i /><b>{attention.length}</b> need you</span>
    </div>
    {!!visible.length && <div className="focus-grid">{visible.map((session) => {
      // An app-wide board broadens the roster, never an individual card's
      // provenance. A moved session still must not adopt another project's
      // older reports or artifacts, even when both projects are on screen.
      const ownerProject = session.sessionProjectId ?? null
      const ownReports = reports.filter((r) => r.sessionId === session.id && r.projectId === ownerProject).sort((a, b) => b.at - a.at)
      return <AgentCard key={session.id} session={session}
        projectName={appWide ? projects.find(p => p.id === ownerProject)?.name ?? 'No project' : undefined}
        provider={profiles.find((p) => p.id === session.agent)?.label ?? session.agent}
        reports={ownReports} outputs={focusOutputs(experience.outputs, session.id, ownerProject)}
        report={ownReports[0]} compact={compact} />
    })}</div>}
    {!shown.length && <div className="focus-empty">
      <Icon name={attentionOnly ? 'check' : 'sessions'} size={30} />
      <h3>{attentionOnly ? 'No agents need you right now' : 'Your team will appear here'}</h3>
      <p>{attentionOnly ? 'Keep an eye on the whole project while work continues.'
        : 'Start a terminal to bring this project into Focus.'}</p>
      <button className="px-button px-primary" onClick={() => attentionOnly ? setAttentionOnly(false) : newTerminal()}>{attentionOnly ? 'Show all agents' : 'New terminal'}</button>
    </div>}
    {pages > 1 && <nav className="focus-pagination" aria-label="Agent pages"><button className="px-button" disabled={activePage === 0} onClick={() => setPage(activePage - 1)}>Previous</button>
      <span>{activePage + 1} of {pages}</span><button className="px-button" disabled={activePage + 1 >= pages} onClick={() => setPage(activePage + 1)}>Next</button></nav>}
    </>}
    <p className="focus-footnote">Updates follow real session events. Ready for review means a turn finished; it doesn’t verify the whole task.</p>
  </section>
}

function AgentCard({ session, provider, reports, outputs, report, compact, projectName }: {
  session: Session; provider: string; reports: FocusUpdate[]; outputs: OutputRecord[]; report?: FocusUpdate; compact: boolean; projectName?: string
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [opening, setOpening] = useState(false)
  const status = focusStatus(session)
  const meta = FOCUS_STATUS[status]
  const manager = session.bus === 'manager' && session.busProjectId === session.sessionProjectId
  const appManager = session.bus === 'app-manager'
  const summary = focusText(report?.summary ?? taskText(session.lastTask ?? '')) || 'No task update yet.'
  const updatedAt = report?.at ?? Math.max(session.lastPromptAt ?? 0, session.lastStatusChangeAt)
  const latestOutput = outputs[0]
  const openOutput = async (output: OutputRecord): Promise<void> => {
    setOpening(true)
    try { await preview.open(output.path, { owner: session.id }) }
    catch (error) { useStore.getState().setToast(String(error), 'error') }
    finally { setOpening(false) }
  }
  return <article className={`focus-card focus-card--${status}`} data-session-id={session.id} aria-labelledby={`focus-agent-${session.id}`}>
    <header className="focus-card-head"><span className="focus-avatar" aria-hidden="true">{session.agent === 'claude' ? '✳' : session.agent === 'codex' ? '◈' : '›_'}</span>
      <div className="focus-identity"><h3 id={`focus-agent-${session.id}`}>{session.title}</h3><span>{provider} · {session.id.slice(0, 5)}{(manager || appManager) && <small title={appManager ? 'User-granted App Manager' : 'User-granted project Manager'}>{appManager ? 'App Manager' : 'Manager'}</small>}</span>{projectName && <span className="focus-project-name">{projectName}</span>}</div>
      <span className="focus-state"><Icon name={ICONS[status]} size={12} />{meta.label}</span>
    </header>
    {report?.visual && <div className="focus-visual">
      <FocusReportImage report={report} />
      {report?.visual?.kind === 'metrics' ? <div className="focus-metrics">{report.visual.items.slice(0, 4).map((item, i) => <div key={i}><strong>{focusText(String(item.value), 32)}</strong><span>{focusText(item.label, 45)}</span></div>)}</div>
        : report?.visual?.kind === 'steps' ? <ol className="focus-steps">{report.visual.items.slice(0, 4).map((item, i) => <li className={`focus-step--${item.state}`} key={i}><span>{item.state === 'done' ? <Icon name="check" size={12} /> : i + 1}</span><strong>{focusText(item.label, 55)}</strong><small>{item.state === 'done' ? 'Done' : item.state === 'active' ? 'In progress' : 'Next'}</small></li>)}</ol>
        : null}
    </div>}
    <div className="focus-card-body">
      <div className="focus-update-label"><span>{report ? report.kind === 'milestone' ? 'MILESTONE' : report.kind === 'blocked' ? 'REPORTED BLOCKER' : report.kind === 'decision' ? 'DECISION' : 'AGENT UPDATE' : 'CURRENT TASK'}</span>
        <time dateTime={new Date(updatedAt).toISOString()} title={timeLabel(updatedAt)}>{relTime(updatedAt)}</time></div>
      <p className={`focus-summary${expanded ? ' is-expanded' : ''}`}>{summary}</p>
      {summary.length > 95 && <button className="focus-textbutton" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Less' : 'Read update'}</button>}
      {report?.next && <p className="focus-next"><span>Next</span>{focusText(report.next, 140)}</p>}
      {!report && <p className="focus-source">{meta.detail}. No progress report yet.</p>}
      {!compact && reports.length > 1 && <div className="focus-milestones"><h4>Earlier updates</h4>
        <ol>{reports.slice(1, 4).map((update) => <li key={update.id}><span className="focus-event-dot" /><div><span>{update.summary}</span>
          <time dateTime={new Date(update.at).toISOString()} title={timeLabel(update.at)}>{relTime(update.at)}</time></div></li>)}</ol>
      </div>}
      {latestOutput && <button className="focus-output" disabled={opening} onClick={() => void openOutput(latestOutput)} title={latestOutput.name}>
        <Icon name={latestOutput.kind === 'image' || latestOutput.kind === 'svg' ? 'image' : 'document'} size={18} /><span><small>Latest output</small><strong>{latestOutput.name}</strong></span><Icon name="chevron" size={14} />
      </button>}
    </div>
    <footer className="focus-card-foot"><span>{report ? 'Agent report + live status' : 'Live session status'}</span><button className="px-button" aria-label={`Open terminal for ${session.title} ${session.id.slice(0, 5)}`}
      onClick={() => useStore.getState().revealSession(session.id)}>Open terminal <Icon name="external" size={12} /></button></footer>
  </article>
}
