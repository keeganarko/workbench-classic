import { useEffect, useRef, useState } from 'react'
import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useStore } from '../state/store'
import { actions, activeSessionId } from '../lib/actions'
import { accel, relTime } from '../lib/ui'
import { useAgentColor, useAgentLabel, useLaunchableProfiles } from '../lib/agents'
import { groupSessionsByProject, groupSessionsByWorkbenchProject } from '../../../shared/grouping'
import type { SessionGroup, WorkbenchProjectGroup } from '../../../shared/grouping'
import {
  SECTIONS,
  byActivity,
  projectSectionKey,
  repoSectionKey,
  sectionRows,
  numberKeyOrder,
  sidebarSessionNumbers
} from '../../../shared/sessionOrder'
import type { SectionDef } from '../../../shared/sessionOrder'
import { sessionTaskSummary, sidebarSessionTitle } from '../../../shared/sessionTitle'
import type { Project, Session, SessionProject, SessionStatus, Workspace } from '../../../shared/types'
import { Logo } from './Logo'
import { Icon } from './Icon'
import { ProjectMark } from './ProjectArtwork'
import { FileTree } from './FileTree'
import { GitPanel } from './GitPanel'
import { ShelfPanel } from './ShelfPanel'
import { SearchPanel } from './SearchPanel'
import { useContextMenu } from './ContextMenu'
import type { MenuEntry } from './ContextMenu'

const api = window.term

export function Sidebar(): JSX.Element {
  const prefs = useStore((s) => s.prefs)
  const sessions = useStore((s) => s.sessions)
  const sessionProjects = useStore((s) => s.sessionProjects)
  const projects = useStore((s) => s.projects)
  const workspaces = useStore((s) => s.workspaces)
  const view = useStore((s) => s.sidebarView)
  const groupBy = useStore((s) => s.sidebarGroupBy)
  // The shell has its own icon button below, so it is not one of these.
  const starters = useLaunchableProfiles().filter((p) => p.id !== 'shell')
  const hovered = useStore((s) => s.sidebarHovered)
  const nonce = useStore((s) => s.sectionNonce)
  const activeSection = useStore((s) => s.activeSection)
  const collapsed = useStore((s) => s.collapsed)
  // Subscribed rather than read once: the numbers below start at the panes, so
  // splitting or closing a pane has to renumber the sidebar immediately.
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const resizing = useRef(false)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const ctx = useContextMenu()

  const tab = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null

  const pinned = prefs.sidebarPinned
  const peeking = pinned || hovered

  // The activity bar filters rather than scrolls: "recent" is the catch-all
  // view carrying all four sections, the other three narrow to one. A scroll
  // alone was invisible, since the sidebar rarely overflows.
  const visibleSections =
    activeSection === 'recent' ? SECTIONS : SECTIONS.filter((s) => s.key === activeSection)

  /**
   * ⌘1…⌘9, resolved once for the whole list.
   *
   * The low digits go to the panes on screen, so the first sidebar row is
   * often numbered 3 rather than 1 — and a session already in a pane shows the
   * number of the pane it is in, not a second one of its own.
   *
   * Computed here rather than inside each row so the numbers come from one
   * walk of one ordering — the same walk `actions.focusSessionIndex` makes when
   * the key is actually pressed. A row that draws its own number would be free
   * to disagree with the shortcut, which is the only way this feature can be
   * worse than not having it.
   */
  const numbers = sidebarSessionNumbers(
    numberKeyOrder({
      sessions,
      sessionProjects,
      workspaces,
      projects,
      groupBy,
      activeSection,
      collapsed,
      layout: tab?.layout ?? null,
      zoomedPaneId: tab?.zoomedPaneId ?? null
    })
  )

  // Still scroll to the top on a rail click, so a long filtered list starts at the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [nonce, activeSection])

  // Drag the right edge to resize, like every VS Code panel.
  useEffect(() => {
    const move = (e: MouseEvent): void => {
      if (!resizing.current) return
      setDragWidth(Math.min(520, Math.max(180, e.clientX - 48)))
    }
    const up = (): void => {
      if (!resizing.current) return
      resizing.current = false
      setDragWidth((w) => {
        if (w !== null) void api.setPrefs({ sidebarWidth: w })
        return null
      })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

  const width = dragWidth ?? prefs.sidebarWidth ?? 264

  return (
    <>
      {!pinned && (
        <div
          className="sidebar__peek-strip"
          onMouseEnter={() => useStore.getState().setSidebarHovered(true)}
        />
      )}
      <div
        className={`sidebar${pinned ? '' : ' sidebar--floating'}${
          !pinned && peeking ? ' sidebar--peek' : ''
        }`}
        style={{ width, minWidth: width }}
        onMouseEnter={() => useStore.getState().setSidebarHovered(true)}
        onMouseLeave={() => !pinned && useStore.getState().setSidebarHovered(false)}
      >
        <Logo />

        <div className="sidebar__actions">
          {/* One per agent this machine can start. Adding a profile in Settings
              puts a button here; it is the whole point of the registry. */}
          {starters.map((p) => (
            <button key={p.id} className="btn" onClick={() => actions.openNewSession(p.id)}>
              <span style={{ color: p.color }}>●</span> {p.label}
            </button>
          ))}
          <button
            className="btn btn--ghost"
            title="New shell session"
            onClick={() => actions.openNewSession('shell')}
            style={{ flex: '0 0 34px' }}
          >
            <Icon name="terminal" size={13} />
          </button>
        </div>

        {view !== 'sessions' ? null : (
          <div className="sidebar__groupby">
            <button
              className={`chip${groupBy === 'status' ? ' chip--on' : ''}`}
              title="Bucket sessions by what they need from you"
              onClick={() => useStore.getState().setSidebarGroupBy('status')}
            >
              Status
            </button>
            <button
              className={`chip${groupBy === 'repo' ? ' chip--on' : ''}`}
              title="Bucket sessions by the repository they are working in"
              onClick={() => useStore.getState().setSidebarGroupBy('repo')}
            >
              Repo
            </button>
            <button
              className={`chip${groupBy === 'project' ? ' chip--on' : ''}`}
              title="Bucket sessions by your Workbench projects"
              onClick={() => useStore.getState().setSidebarGroupBy('project')}
            >
              Projects
            </button>
            {groupBy === 'project' && (
              <button
                className="iconbtn sidebar__new-project"
                title="New project"
                aria-label="New project"
                onClick={() => useStore.getState().setOverlay({ kind: 'project' })}
              >
                <Icon name="plus" size={12} />
              </button>
            )}
          </div>
        )}

        {view === 'shelf' ? (
          <ShelfPanel />
        ) : view === 'git' ? (
          <GitPanel />
        ) : view === 'files' ? (
          <FileTree />
        ) : view === 'search' ? (
          <SearchPanel />
        ) : (
          <div className="sidebar__scroll" ref={scrollRef}>
            {groupBy === 'project' ? (
              <ByWorkbenchProject
                sessions={sessions}
                projects={sessionProjects}
                numbers={numbers}
                onContext={ctx.open}
                defaultAgent={starters[0]?.id ?? 'shell'}
              />
            ) : groupBy === 'repo' ? (
              <ByProject
                sessions={sessions}
                workspaces={workspaces}
                projects={projects}
                numbers={numbers}
                onContext={ctx.open}
              />
            ) : (
              <>
                {activeSection !== 'recent' && (
                  <button
                    className="sidebar__filter"
                    title="Show all sections"
                    onClick={() => useStore.getState().focusSection('recent')}
                  >
                    Filtered to {SECTIONS.find((s) => s.key === activeSection)?.label ?? activeSection}
                    <span className="sidebar__filter-clear">Show all</span>
                  </button>
                )}
                {visibleSections.map((section) => (
                  <Section
                    key={section.key}
                    def={section}
                    sessions={sessions}
                    numbers={numbers}
                    onContext={ctx.open}
                  />
                ))}
              </>
            )}
          </div>
        )}

        <div
          className={`sidebar__resizer${dragWidth !== null ? ' sidebar__resizer--active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault()
            resizing.current = true
          }}
        />
      </div>
      {ctx.node}
    </>
  )
}

function ByWorkbenchProject({
  sessions,
  projects,
  numbers,
  onContext,
  defaultAgent
}: {
  sessions: Session[]
  projects: SessionProject[]
  numbers: Map<string, number>
  onContext: (e: ReactMouseEvent, items: MenuEntry[]) => void
  defaultAgent: string
}): JSX.Element {
  const groups = groupSessionsByWorkbenchProject(sessions, projects)

  if (groups.length === 0) {
    return (
      <div className="section__empty">
        No projects yet — use + above to create one, then start its first terminal.
      </div>
    )
  }
  return (
    <>
      {groups.map((group) => (
        <WorkbenchProjectSection
          key={group.key || 'ungrouped-project'}
          group={group}
          numbers={numbers}
          onContext={onContext}
          defaultAgent={defaultAgent}
        />
      ))}
    </>
  )
}

/** A project stays on screen even while empty, because + starts its next terminal. */
function WorkbenchProjectSection({
  group,
  numbers,
  onContext,
  defaultAgent
}: {
  group: WorkbenchProjectGroup
  numbers: Map<string, number>
  onContext: (e: ReactMouseEvent, items: MenuEntry[]) => void
  defaultAgent: string
}): JSX.Element {
  const key = projectSectionKey(group.key)
  const collapsed = useStore((s) => !!s.collapsed[key])
  const toggle = useStore((s) => s.toggleCollapsed)
  const rows = [...group.sessions].sort(byActivity)
  const attention: SessionStatus[] = ['waiting', 'failed', 'working', 'review']
  const tally = attention
    .map((status) => ({ status, n: rows.filter((row) => row.status === status).length }))
    .filter((item) => item.n > 0)

  const menu = (): MenuEntry[] =>
    group.project
      ? [
          {
            label: 'New terminal in project',
            onSelect: () => actions.openNewSession(defaultAgent, group.project!.id)
          },
          {
            label: 'Rename project…',
            onSelect: () =>
              useStore.getState().setOverlay({ kind: 'project', projectId: group.project!.id })
          }
        ]
      : []

  return (
    <div data-section={key}>
      <button
        className="section__header"
        onClick={() => toggle(key)}
        onContextMenu={(event) => group.project && onContext(event, menu())}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('application/x-workbench-session')) {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
          }
        }}
        onDrop={(event) => {
          event.preventDefault()
          const sessionId = event.dataTransfer.getData('application/x-workbench-session')
          if (sessionId) void api.assignSessionProject(sessionId, group.project?.id ?? null)
        }}
      >
        <span className={`section__chevron${collapsed ? ' section__chevron--collapsed' : ''}`}>
          <Icon name="chevron" size={12} strokeWidth={1.6} />
        </span>
        {group.project && <ProjectMark name={group.project.name} appearance={group.project.appearance} />}
        <span className="section__repo" title={group.project?.defaultCwd ?? 'Sessions not filed in a project'}>
          {group.label}
        </span>
        <span className="section__tally">
          {tally.map((item) => (
            <span key={item.status} className="section__tally-item">
              <span className={`dot dot--${item.status}`} />
              {item.n}
            </span>
          ))}
        </span>
        {group.project && (
          <span
            className="iconbtn section__add"
            role="button"
            tabIndex={0}
            title={`New terminal in ${group.label}`}
            onClick={(event) => {
              event.stopPropagation()
              actions.openNewSession(defaultAgent, group.project!.id)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              event.stopPropagation()
              actions.openNewSession(defaultAgent, group.project!.id)
            }}
          >
            <Icon name="plus" size={11} />
          </span>
        )}
        <span className="section__count">{rows.length}</span>
      </button>

      {!collapsed &&
        (rows.length === 0 ? (
          <div className="section__empty">No terminals yet — use + to start one</div>
        ) : (
          rows.map((session) => (
            <Row
              key={`${key}:${session.id}`}
              session={session}
              number={numbers.get(session.id) ?? null}
              onContext={onContext}
            />
          ))
        ))}
    </div>
  )
}

/**
 * The sidebar, bucketed by repository instead of by triage status.
 *
 * Each repo keeps a status summary in its header, because the reason to group
 * by repo is to see *this* codebase's situation at a glance — losing the
 * red/yellow/green read in exchange for tidiness would be a bad trade.
 */
function ByProject({
  sessions,
  workspaces,
  projects,
  numbers,
  onContext
}: {
  sessions: Session[]
  workspaces: Workspace[]
  projects: Project[]
  numbers: Map<string, number>
  onContext: (e: ReactMouseEvent, items: MenuEntry[]) => void
}): JSX.Element {
  const groups = groupSessionsByProject(sessions, workspaces, projects)

  if (groups.length === 0) {
    return <div className="section__empty">No sessions — start one above</div>
  }
  return (
    <>
      {groups.map((g) => (
        <ProjectSection
          key={g.key || 'ungrouped'}
          group={g}
          numbers={numbers}
          onContext={onContext}
        />
      ))}
    </>
  )
}

function ProjectSection({
  group,
  numbers,
  onContext
}: {
  group: SessionGroup
  numbers: Map<string, number>
  onContext: (e: ReactMouseEvent, items: MenuEntry[]) => void
}): JSX.Element {
  const key = repoSectionKey(group.key)
  const collapsed = useStore((s) => !!s.collapsed[key])
  const toggle = useStore((s) => s.toggleCollapsed)

  const rows = [...group.sessions].sort(byActivity)
  // Only the statuses that mean "look at me" get a dot in the header. Idle
  // sessions are the background hum and would drown the two that matter.
  const attention: SessionStatus[] = ['waiting', 'failed', 'working', 'review']
  const tally = attention
    .map((status) => ({ status, n: rows.filter((r) => r.status === status).length }))
    .filter((t) => t.n > 0)

  return (
    <div data-section={key}>
      <button className="section__header" onClick={() => toggle(key)}>
        <span className={`section__chevron${collapsed ? ' section__chevron--collapsed' : ''}`}>
          <Icon name="chevron" size={12} strokeWidth={1.6} />
        </span>
        <span className="section__repo" title={group.project?.root ?? 'Not in a repository'}>
          {group.label}
        </span>
        <span className="section__tally">
          {tally.map((t) => (
            <span key={t.status} className="section__tally-item">
              <span className={`dot dot--${t.status}`} />
              {t.n}
            </span>
          ))}
        </span>
        <span className="section__count">{rows.length}</span>
      </button>

      {!collapsed &&
        rows.map((s) => (
          <Row
            key={`${key}:${s.id}`}
            session={s}
            number={numbers.get(s.id) ?? null}
            onContext={onContext}
          />
        ))}
    </div>
  )
}

function Section({
  def,
  sessions,
  numbers,
  onContext
}: {
  def: SectionDef
  sessions: Session[]
  numbers: Map<string, number>
  onContext: (e: ReactMouseEvent, items: MenuEntry[]) => void
}): JSX.Element | null {
  const collapsed = useStore((s) => !!s.collapsed[def.key])
  const toggle = useStore((s) => s.toggleCollapsed)

  // Shared with the ⌘1…⌘9 ordering rather than duplicated: the digits are
  // assigned by walking exactly these rows, so the two must not be able to
  // drift apart.
  const rows = sectionRows(def, sessions)

  // Nothing pinned means no section at all: an empty "Pinned" header above the
  // triage list is a permanent reminder of a feature you are not using.
  if (def.pinned && rows.length === 0) return null

  return (
    <div data-section={def.key}>
      <button className="section__header" onClick={() => toggle(def.key)}>
        <span className={`section__chevron${collapsed ? ' section__chevron--collapsed' : ''}`}>
          <Icon name="chevron" size={12} strokeWidth={1.6} />
        </span>
        {def.status && <span className={`dot dot--${def.status}`} />}
        {def.pinned && <Icon name="pinned" size={11} strokeWidth={1.5} />}
        {def.label}
        <span className="section__count">{rows.length}</span>
      </button>

      {!collapsed &&
        (rows.length === 0 ? (
          <div className="section__empty">
            {def.status === 'waiting'
              ? 'Nothing needs you right now'
              : def.status === 'failed'
                ? 'Nothing has failed'
                : def.status === 'working'
                  ? 'No agents working'
                  : def.status === 'review'
                    ? 'No finished turns yet'
                    : 'No recent sessions'}
          </div>
        ) : (
          rows.map((s) => (
            <Row
              key={`${def.key}:${s.id}`}
              session={s}
              number={numbers.get(s.id) ?? null}
              onContext={onContext}
            />
          ))
        ))}
    </div>
  )
}

function Row({
  session,
  number,
  onContext
}: {
  session: Session
  /** Its ⌘-digit, or null past the ninth visible row. */
  number: number | null
  onContext: (e: ReactMouseEvent, items: MenuEntry[]) => void
}): JSX.Element {
  const active = activeSessionId() === session.id
  const agentColor = useAgentColor(session.agent)
  const agentLabel = useAgentLabel(session.agent)
  const displayTitle = sidebarSessionTitle(session, agentLabel)
  const projects = useStore((s) => s.sessionProjects)
  const draggable = useStore((s) => s.sidebarGroupBy === 'project')
  useStore((s) => s.tabs) // re-render when pane focus moves
  // A document this session produced while you were looking somewhere else.
  // The dock holds one per chat; this is how a chat says it has something.
  const unread = useStore((s) => {
    const slot = s.preview.bySession[session.id]
    return slot && !slot.seen ? slot.doc.name : null
  })

  const moveItems = (): MenuEntry[] => {
    const items = projects
      .filter((project) => project.id !== session.sessionProjectId)
      .map((project) => ({
        label: `Move to project: ${project.name}`,
        onSelect: () => void api.assignSessionProject(session.id, project.id)
      }))
    if (session.sessionProjectId) {
      items.push({
        label: 'Remove from project',
        onSelect: () => void api.assignSessionProject(session.id, null)
      })
    }
    return items
  }

  const menu = (): MenuEntry[] => [
    { label: 'Open in focused pane', onSelect: () => useStore.getState().revealSession(session.id) },
    {
      label: 'Open in split',
      onSelect: () => useStore.getState().split('h', session.id)
    },
    { separator: true },
    {
      label: 'Fork child session',
      hint: '⌘⇧F',
      onSelect: () => {
        useStore.getState().revealSession(session.id)
        actions.openFork('child')
      }
    },
    {
      label: 'Fork parallel session',
      hint: '⌘⌥F',
      onSelect: () => {
        useStore.getState().revealSession(session.id)
        actions.openFork('sibling')
      }
    },
    { separator: true },
    {
      label: session.pinned ? 'Unpin session' : 'Pin session',
      onSelect: () => void api.pinSession(session.id, !session.pinned)
    },
    ...moveItems(),
    {
      label: 'Set role…',
      onSelect: () => {
        useStore.getState().setOverlay({
          kind: 'rename',
          target: 'session',
          id: session.id,
          current: session.title
        })
      }
    },
    { separator: true },
    {
      label: 'Copy tmux attach command',
      onSelect: () => void actions.attachInITerm(session.id)
    },
    { label: 'Export transcript', onSelect: () => void actions.exportTranscript(session.id) },
    { label: 'Reveal session log', onSelect: () => void api.revealLog(session.id) },
    { label: 'Open working folder', onSelect: () => void api.openCwd(session.id) },
    { separator: true },
    ...(session.alive
      ? [
          {
            label: 'Interrupt (Ctrl-C)',
            hint: '⌘.',
            onSelect: () => void api.interruptSession(session.id)
          },
          { label: 'Kill session', danger: true as const, onSelect: () => void actions.kill(session.id) }
        ]
      : [{ label: 'Restart session', onSelect: () => void actions.restart(session.id) }]),
    { label: 'Remove from list', danger: true, onSelect: () => void actions.remove(session.id) }
  ]

  return (
    <>
      <div
        className={`srow${active ? ' srow--active' : ''}`}
        draggable={draggable}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('application/x-workbench-session', session.id)
          event.dataTransfer.setData('text/plain', session.title)
        }}
        onClick={() => useStore.getState().revealSession(session.id)}
        onContextMenu={(e) => onContext(e, menu())}
        title={`${agentLabel} · ${displayTitle}\n${session.status}`}
      >
        {session.depth > 0 && (
          <span className="srow__indent" style={{ width: session.depth * 7 }} />
        )}
        {number !== null && (
          <span
            className="srow__num"
            title={`Jump to this session (${accel(`CmdOrCtrl+${number}`)})`}
          >
            {number}
          </span>
        )}
        <span className={`dot dot--${session.status}`} />
        <span className="srow__copy">
          <span className="srow__title">{displayTitle}</span>
          <span className="srow__about">{sessionTaskSummary(session)}</span>
          <span className="srow__meta"><span className="srow__agent" style={{ color: agentColor, background: '#ffffff0f' }}>{agentLabel}</span><span>{session.status}</span><span>{relTime(session.lastActivityAt)}</span></span>
        </span>
        {unread && (
          <span className="srow__doc" title={`${unread} — click to open it in the preview pane`}>
            <Icon name="document" size={10} strokeWidth={1.5} />
          </span>
        )}
        {session.badge && <span className="srow__badge">{session.badge}</span>}
        <button
          className={`iconbtn srow__pin${session.pinned ? ' srow__pin--on' : ''}`}
          title={session.pinned ? 'Unpin' : 'Pin'}
          onClick={(e) => {
            e.stopPropagation()
            void api.pinSession(session.id, !session.pinned)
          }}
        >
          <Icon name={session.pinned ? 'pinned' : 'pin'} size={11} strokeWidth={1.4} />
        </button>
        <button
          className="iconbtn srow__close"
          title={
            session.alive
              ? `Kill "${session.title}" and remove it from the list`
              : `Remove "${session.title}" from the list`
          }
          aria-label={session.alive ? 'Kill and remove session' : 'Remove session'}
          onClick={(e) => {
            // Without this the row's own click handler also fires and reveals
            // the pane we are in the middle of destroying.
            e.stopPropagation()
            const { title, alive } = session
            void actions.remove(session.id).then(() => {
              useStore
                .getState()
                .setToast(alive ? `Killed and removed ${title}` : `Removed ${title}`, 'info')
            })
          }}
        >
          <Icon name="close" size={11} strokeWidth={1.6} />
        </button>
      </div>
      {(session.status === 'waiting' || session.status === 'failed') && session.statusReason && (
        <div className={`srow__reason${session.status === 'failed' ? ' srow__reason--failed' : ''}`}>
          {session.statusReason}
        </div>
      )}
    </>
  )
}
