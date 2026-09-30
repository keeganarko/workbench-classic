import { sessionTaskSummary } from '../../../shared/sessionTitle'
/**
 * The Permissions control room for the Session Bus: who may talk to whom,
 * and what has been said. The familiar Permissions label is used throughout
 * navigation so users do not need to know the transport's internal name to
 * find and change an agent's access.
 *
 * Both halves are here on purpose. An agent that can drive other agents is a
 * capability, and a capability the user cannot see being exercised is one they
 * cannot supervise — so the grants and the ledger sit in the same window, and
 * refused calls are shown as prominently as successful ones.
 */

import { useState, type JSX } from 'react'
import { useStore } from '../state/store'
import { shortPath } from '../lib/ui'
import { useAgentLabel } from '../lib/agents'
import { STATUS_META } from '../../../shared/types'
import type { BusAccess, BusEntry, Session } from '../../../shared/types'

const api = window.term

const LEVELS: { key: BusAccess; label: string; hint: string }[] = [
  { key: 'off', label: 'Off', hint: 'Cannot contact other agents. Hidden from ordinary callers; an authorized manager can still manage it.' },
  { key: 'read', label: 'Read', hint: 'Others may read it. It can read or message targets that permit those actions.' },
  { key: 'full', label: 'Full', hint: 'Others may also prompt and fork it.' },
  { key: 'manager', label: 'Project Manager', hint: 'Manage sessions and scheduled tasks in this project, after you grant permission.' },
  { key: 'app-manager', label: 'App Manager', hint: 'Your central agent: create and direct sessions across every project in this app.' }
]

export function BusPanel(): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const busLog = useStore((s) => s.busLog)
  const enabled = useStore((s) => s.prefs.busEnabled === true)
  const close = (): void => useStore.getState().setOverlay({ kind: 'none' })

  const granted = sessions.filter((s) => (s.bus ?? 'off') !== 'off')

  return (
    <div className="overlay" onMouseDown={close}>
      <div id="agent-permissions" className="modal modal--wide" role="dialog" aria-modal="true"
        aria-labelledby="agent-permissions-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__head" id="agent-permissions-title">Permissions</div>
        <div className="modal__body">
          <div className="field">
            <label className="switch">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => void api.setPrefs({ busEnabled: e.target.checked })}
              />
              Enable agent communication
            </label>
            <span className="field__hint">
              Let agents read and contact other sessions according to the permissions below.
              Managers can also create and manage sessions. Start or restart a terminal after
              enabling this so its agent receives the communication tools.
            </span>
          </div>

          <div className="field">
            <span className="field__label">
              Agent permissions {granted.length > 0 && <>— {granted.length} granted</>}
            </span>
            <span className="field__hint">
              All projects are shown here. Read and Full enable access to individual sessions. Project Manager grants control of one
              entire project, including its Off sessions. App Manager directs sessions across all projects. Revoking access stops new calls;
              prompts already delivered cannot be recalled. Moving a Project Manager revokes its project grant.
            </span>
            <div className="buslist">
              {sessions.length === 0 && <div className="bus__empty">No sessions yet.</div>}
              {sessions.map((s) => (
                <GrantRow key={s.id} session={s} disabled={!enabled} />
              ))}
            </div>
          </div>

          <div className="field">
            <span className="field__label">Recent activity</span>
            <span className="field__hint">
              Newest last. Two agents talking in circles show up here as a repeating pair.
            </span>
            <div className="buslog">
              {busLog.length === 0 && <div className="bus__empty">No agent activity yet.</div>}
              {busLog.map((e) => (
                <LogRow key={e.id} entry={e} sessions={sessions} />
              ))}
            </div>
          </div>
        </div>
        <div className="modal__foot">
          <button className="btn btn--ghost" style={{ flex: '0 0 auto' }} onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function GrantRow({ session, disabled }: { session: Session; disabled: boolean }): JSX.Element {
  const level = session.bus ?? 'off'
  const agent = useAgentLabel(session.agent)
  const project = useStore((s) => s.sessionProjects.find((p) => p.id === session.sessionProjectId))
  const [confirmProjectId, setConfirmProjectId] = useState<string | null>(null)
  const [confirmApp, setConfirmApp] = useState(false)
  const grant = async (access: BusAccess): Promise<void> => {
    try {
      await api.setBusAccess(session.id, access,
        access === 'manager' ? confirmProjectId ?? project?.id : undefined)
      setConfirmProjectId(null)
      setConfirmApp(false)
    }
    catch (error) { useStore.getState().setToast(`Grant failed: ${(error as Error).message}`, 'error') }
  }
  return (
    <div>
    <div className="busrow">
      <span className={`dot dot--${session.status}`} />
      <span className="busrow__title" title={session.cwd}>
        <strong>{session.title}</strong>
        <span className="busrow__about">{sessionTaskSummary(session)}</span>
      </span>
      <span className="busrow__meta">
        {agent} · {project?.name ?? 'Unfiled'} · {session.id.slice(0, 8)} · {STATUS_META[session.status].label} ·{' '}
        {shortPath(session.cwd)}
      </span>
      <div className="segmented segmented--tight">
        {LEVELS.map((l) => (
          <button
            key={l.key}
            className={`segmented__opt${level === l.key ? ' segmented__opt--on' : ''}`}
            title={l.key === 'manager' && !project ? 'File this session in a project first.' : l.hint}
            disabled={disabled || (l.key === 'manager' && !project)}
            onClick={() => {
              setConfirmApp(false)
              setConfirmProjectId(null)
              if (l.key === 'app-manager' && level !== 'app-manager') setConfirmApp(true)
              else if (l.key === 'manager' && level !== 'manager') setConfirmProjectId(project?.id ?? null)
              else void grant(l.key)
            }}
          >
            {l.label}
          </button>
        ))}
      </div>
    </div>
    {confirmProjectId && project?.id === confirmProjectId && (
      <div className="field busgrant">
        <strong>Allow {session.title} to manage {project.name}?</strong>
        <span className="field__hint">
          This agent can read and send prompts to every session in {project.name}, including
          sessions marked Off, and create, fork, rename, pin, interrupt, stop, restart or delete
          them. Deleting removes the session from Workbench; project files stay on disk.
          It can also create, edit, pause, run and delete this project's scheduled tasks.
          Saved schedules stay in Scheduled until you pause or delete them, even after revoking this grant.
          New agents receive Full access. This grant does not change CLI execution
          permissions or allow the agent to grant Manager access. You can revoke it here anytime.
        </span>
        <div className="row">
          <button className="btn" disabled={disabled} onClick={() => void grant('manager')}>Grant Manager for {project.name}</button>
          <button className="btn btn--ghost" onClick={() => setConfirmProjectId(null)}>Cancel</button>
        </div>
      </div>
    )}
    {confirmApp && <div className="field busgrant">
      <strong>Make {session.title} your App Manager?</strong>
      <span className="field__hint">This agent can read, message, create and manage sessions across every project in this Workbench app, including sessions marked Off and unfiled sessions. Workers stay in their own projects and do not inherit management permission. Stopping or removing sessions keeps project files on disk. You can revoke this grant here at any time.</span>
      <div className="row">
        <button className="btn" disabled={disabled} onClick={() => void grant('app-manager')}>Grant App Manager for all projects</button>
        <button className="btn btn--ghost" onClick={() => setConfirmApp(false)}>Cancel</button>
      </div>
    </div>}
    </div>
  )
}

function LogRow({ entry, sessions }: { entry: BusEntry; sessions: Session[] }): JSX.Element {
  const name = (id: string | null): string => {
    if (!id) return '—'
    return sessions.find((s) => s.id === id)?.title ?? id.slice(0, 8)
  }
  const at = new Date(entry.at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  return (
    <div className={`buslogrow${entry.ok ? '' : ' buslogrow--refused'}`}>
      <span className="buslogrow__time">{at}</span>
      <span className="buslogrow__who">{name(entry.callerId)}</span>
      <span className="buslogrow__tool">{entry.tool}</span>
      <span className="buslogrow__who">{name(entry.targetId)}</span>
      {/* A wait that took four minutes is the interesting kind of slow, so the
          duration is shown rather than hidden as an implementation detail. */}
      {entry.ms >= 1000 && <span className="buslogrow__ms">{Math.round(entry.ms / 1000)}s</span>}
      <span className="buslogrow__detail">{entry.detail}</span>
    </div>
  )
}
