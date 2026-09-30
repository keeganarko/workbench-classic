import type { JSX } from 'react'
import { useStore } from '../state/store'
import { activeFocusProjects, projectFocus } from '../../../shared/focusProjects'
import { focusStatus, focusText } from '../../../shared/focusJournal'
import { taskText } from '../../../shared/sessionTitle'
import { FocusReportImage } from './FocusReportImage'
import { Icon } from './Icon'
import { relTime } from '../lib/ui'

/** Only projects with live sessions mount cards or load report images. A new
 * pushed report changes its own picture immediately; time passing does not
 * invent progress or run background image-generation calls. */
export function FocusProjectOverview(): JSX.Element {
  const projects = useStore(s => s.sessionProjects)
  const sessions = useStore(s => s.sessions)
  const { focusUpdates, archivedIds } = useStore(s => s.experience)
  const active = activeFocusProjects(projects, sessions, archivedIds)
  return <div className="focus-portfolio" id="focus-project-overview" aria-label="Project overview">
    <div className="focus-portfolio-heading"><div><span className="focus-kicker">IN FOCUS</span><h3>What’s happening now.</h3></div><span>{active.length} active {active.length === 1 ? 'project' : 'projects'}</span></div>
    <div className="focus-project-grid">{active.map(project => {
      const pulse = projectFocus(project.id, sessions, focusUpdates, archivedIds)
      const lastTask = pulse.current?.lastTask ?? pulse.lastKnown?.lastTask
      const summary = pulse.latest?.summary ?? focusText(taskText(lastTask ?? ''))
      const open = (): void => useStore.getState().navigateExperience('focus', project.id)
      return <article className="focus-project-card" key={project.id} data-project-id={project.id}>
        <header><button onClick={open}><Icon name="folder" size={15} /><h4>{project.name}</h4><Icon name="chevron" size={13} /></button>
          <span>{pulse.workers.filter(s => focusStatus(s) === 'working').length} working · {pulse.workers.length} sessions</span></header>
        <FocusReportImage report={pulse.latest} />
        <div className="focus-project-story"><div className="focus-update-label"><span>{pulse.latest ? pulse.latest.kind === 'milestone' ? 'LATEST MILESTONE' : pulse.latest.kind === 'blocked' ? 'REPORTED BLOCKER' : 'LATEST REPORT' : summary ? pulse.current ? 'CURRENT TASK' : 'LAST SAVED TASK' : 'READY FOR A NEW CHAPTER'}</span>
          {pulse.latest && <time dateTime={new Date(pulse.latest.at).toISOString()} title={new Date(pulse.latest.at).toLocaleString()}>{relTime(pulse.latest.at)}</time>}</div>
          <p>{summary || 'No saved milestone yet.'}</p>
          {pulse.latest?.visual?.kind === 'metrics' && <div className="focus-project-metrics">{pulse.latest.visual.items.map((item, i) => <span key={i}><strong>{item.value}</strong><small>{item.label}</small></span>)}</div>}
          {pulse.latest?.visual?.kind === 'steps' && <ol className="focus-project-steps">{pulse.latest.visual.items.map((item, i) => <li key={i} data-step-state={item.state}><span>{item.state === 'done' ? '✓' : item.state === 'active' ? '◉' : '○'}</span>{item.label}<small>{item.state === 'done' ? 'Done' : item.state === 'active' ? 'Now' : 'Next'}</small></li>)}</ol>}
          {pulse.latest?.next && <p className="focus-next"><span>Next</span>{pulse.latest.next}</p>}
          {pulse.reports.length > 1 && <details className="focus-project-history"><summary>Earlier updates</summary><ol>{pulse.reports.slice(1, 4).map(report => <li key={report.id}><span>{report.summary}</span><small>{sessions.find(s => s.id === report.sessionId)?.title} · {relTime(report.at)}{archivedIds.includes(report.sessionId) ? ' · Archived session' : ''}</small></li>)}</ol></details>}
          {!pulse.latest && <span className="focus-source">The first progress update will appear here.</span>}
        </div>
        <footer><span>{pulse.needsAttention ? `${pulse.needsAttention} need you` : pulse.latest ? 'Agent-reported progress' : 'Awaiting a report'}</span><button className="focus-textbutton" onClick={open}>See project <Icon name="chevron" size={12} /></button></footer>
      </article>
    })}</div>
    {!active.length && <p className="focus-source">No active projects. A project appears here when it has a running session.</p>}
  </div>
}
