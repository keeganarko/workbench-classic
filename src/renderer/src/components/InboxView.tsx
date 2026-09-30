import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { inboxMessage, selectInboxSessions, type InboxKind } from '../../../shared/inbox'
import { sidebarSessionTitle } from '../../../shared/sessionTitle'
import type { Session } from '../../../shared/types'
import { useStore } from '../state/store'
import { Icon, type IconName } from './Icon'
import '../styles/inbox.css'

const groups: { kind: InboxKind; title: string; description: string; icon: IconName }[] = [
  { kind: 'waiting', title: 'Needs input', description: 'Open the source terminal to answer a question or review an approval.', icon: 'waiting' },
  { kind: 'failed', title: 'Problems', description: 'Sessions that reported an error. A problem is separate from an input request.', icon: 'failed' },
  { kind: 'review', title: 'Updates', description: 'Completed turns to read when you are ready. These do not require a reply.', icon: 'document' }
]

function age(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return 'Just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** The inbox is a reading and acknowledgment surface. It deliberately has no
 * terminal-remove control: the × on an ordinary SessionCard stops its process,
 * whereas dismissing an update must leave that conversation intact.
 */
export function InboxView({ projectId }: { projectId: string | null }): JSX.Element {
  const sessions = useStore((state) => state.sessions)
  const archived = useStore((state) => state.experience.archivedIds)
  const [now, setNow] = useState(Date.now)
  const queue = useMemo(() => selectInboxSessions(sessions, archived, projectId), [sessions, archived, projectId])
  const waiting = queue.filter((session) => session.status === 'waiting').length
  const failed = queue.filter((session) => session.status === 'failed').length
  const review = queue.filter((session) => session.status === 'review').length

  // Store snapshots update the actual events. This clock only keeps their age
  // truthful while the inbox is visible, without polling the terminal backend.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  return <section className="inbox-view" aria-label="Session inbox">
    <div className="inbox-summary">
      <div className="inbox-summary__copy"><Icon name={waiting || failed ? 'waiting' : 'check'} size={19} />
        <div><strong>{waiting ? `${waiting} ${waiting === 1 ? 'session needs' : 'sessions need'} your input` : 'No input requests waiting'}</strong>
          <p>{failed ? `${failed} ${failed === 1 ? 'problem' : 'problems'} to inspect. ` : ''}{review ? `${review} ${review === 1 ? 'update' : 'updates'} ready to read.` : 'New requests and responses will appear below.'}</p>
        </div>
      </div>
      <span className="inbox-summary__count">{queue.length} {queue.length === 1 ? 'item' : 'items'}</span>
    </div>
    {!queue.length && <div className="inbox-empty"><span><Icon name="check" size={26} /></span><h2>You are caught up</h2>
      <p>There are no input requests, reported problems, or unread turn updates in this view. Your terminals keep running.</p>
      <button className="px-button" onClick={() => useStore.getState().navigateExperience('terminals', projectId)}>Open terminals <Icon name="terminal" size={14} /></button>
    </div>}
    {groups.map((group) => {
      const items = queue.filter((session) => session.status === group.kind)
      if (!items.length) return null
      return <section className={`inbox-group inbox-group--${group.kind}`} key={group.kind} aria-labelledby={`inbox-${group.kind}-title`}>
        <div className="inbox-group__heading"><h2 id={`inbox-${group.kind}-title`}><Icon name={group.icon} size={16} />{group.title}<span>{items.length}</span></h2><p>{group.description}</p></div>
        <div className="inbox-group__items">{items.map((session) => <InboxCard session={session} now={now} key={session.id} />)}</div>
      </section>
    })}
  </section>
}

function InboxCard({ session, now }: { session: Session; now: number }): JSX.Element {
  const profiles = useStore((state) => state.profiles)
  const projects = useStore((state) => state.sessionProjects)
  const profile = profiles.find((item) => item.id === session.agent)
  const role = sidebarSessionTitle(session, profile?.label ?? session.agent)
  const project = projects.find((item) => item.id === session.sessionProjectId)
  const message = inboxMessage(session)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    setExpanded(false); setError('')
  }, [session.status, session.lastStatusChangeAt, session.statusReason, session.lastMessage])
  const long = message.text.length > 360
  const text = long && !expanded ? `${message.text.slice(0, 359)}…` : message.text
  const open = (): void => useStore.getState().revealSession(session.id)
  const acknowledge = async (): Promise<void> => {
    if (busy) return
    // A store snapshot can arrive between rendering and clicking. Never clear
    // a different request just because its card occupied the same position.
    const current = useStore.getState().sessions.find((item) => item.id === session.id)
    if (!current || current.status !== session.status || current.lastStatusChangeAt !== session.lastStatusChangeAt || current.statusReason !== session.statusReason) {
      setError('This session has a newer update. Review its current state before clearing it.')
      return
    }
    setBusy(true); setError('')
    try {
      const cleared = await window.term.clearStatus(session.id, { status: session.status, changedAt: session.lastStatusChangeAt, reason: session.statusReason })
      if (!cleared) setError('This session has a newer update. Review it before clearing.')
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  return <article className={`inbox-card inbox-card--${session.status}`} aria-label={`${role}: ${message.label}`}>
    <div className="inbox-card__header"><div><strong>{role}</strong><div className="inbox-card__identity"><span>{profile?.label ?? session.agent}</span><span aria-hidden="true">·</span><span>{project?.name ?? (session.sessionProjectId ? 'Removed project' : 'Unfiled')}</span>{!session.alive && <span className="inbox-offline">Terminal stopped</span>}</div></div>
      <time dateTime={new Date(session.lastStatusChangeAt).toISOString()} title={new Date(session.lastStatusChangeAt).toLocaleString()}>{age(session.lastStatusChangeAt, now)}</time>
    </div>
    <div className="inbox-card__message"><span>{message.label}</span><p>{text}</p>
      {long && <button className="inbox-textbutton" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Read captured message'} <Icon name="chevron" size={12} /></button>}
      {session.status === 'waiting' && message.isFallback && session.statusReason?.trim() && <p className="inbox-card__hint">Only part of the request was captured. Open the terminal for the full question.</p>}
    </div>
    <div className="inbox-card__footer"><button className="px-button" onClick={open}><Icon name="terminal" size={14} />Open terminal</button>
      <button className="inbox-textbutton" disabled={busy} onClick={() => void acknowledge()} title={session.status === 'review' ? 'Mark this update reviewed; keep the terminal running' : 'Clear this status indicator; this does not answer or approve anything'}>{busy ? 'Clearing…' : session.status === 'review' ? 'Mark reviewed' : 'Clear status'}</button>
      {session.status === 'waiting' && <span>Reply or approve in the terminal.</span>}
    </div>
    {error && <p className="inbox-card__error" role="alert">{error}</p>}
  </article>
}
