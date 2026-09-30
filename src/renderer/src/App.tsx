import { saveComposerWorkspace } from './lib/updateWorkspace'
import { useEffect } from 'react'
import type { JSX } from 'react'
import { ExperienceShell } from './components/ExperienceShell'
import { ActivityBar } from './components/ActivityBar'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { PaneGrid } from './components/PaneGrid'
import { MinimizedBar } from './components/MinimizedBar'
import { Composer } from './components/Composer'
import { StatusBar } from './components/StatusBar'
import { WindowTitle } from './components/WindowTitle'
import { CommandPalette } from './components/CommandPalette'
import { SessionSwitcher } from './components/SessionSwitcher'
import { NewSessionDialog } from './components/NewSessionDialog'
import { ForkDialog } from './components/ForkDialog'
import { ShareDialog } from './components/ShareDialog'
import { ContextShelf } from './components/ContextShelf'
import { SettingsDialog } from './components/SettingsDialog'
import { BusPanel } from './components/BusPanel'
import { RenameDialog } from './components/RenameDialog'
import { ProjectShareDialog } from './components/ProjectShareDialog'
import { ProjectDialog } from './components/ProjectDialog'
import { Toasts } from './components/Toasts'
import { useStore } from './state/store'
import { dispatchPty } from './lib/ptyBus'
import { actions } from './lib/actions'
import { preview } from './lib/preview'
import { findLeaf, sessionIdsIn, sessionInPane } from './lib/layout'
import type { Direction, LayoutPreset } from './lib/layout'
import { hasPrimaryModifier, hasSecondaryModifier } from './lib/ui'
import { serverLabel } from '../../shared/localhost'
import type { AgentKind, VisiblePanes } from '../../shared/types'
import { hasVisualPane, isVisualPath, isVisualPreviewKind } from '../../shared/visual'

const ARROW_DIR: Record<string, Direction | undefined> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down'
}

const api = window.term

export function App(): JSX.Element {
  const ready = useStore((s) => s.ready)
  const prefs = useStore((s) => s.prefs)
  const overlay = useStore((s) => s.overlay)
  const sidebarView = useStore((s) => s.sidebarView)
  const visualFocused = useStore((s) => {
    const tab = s.tabs.find((item) => item.id === s.activeTabId) ?? s.tabs[0]
    if (!tab) return false
    const pane = findLeaf(tab.layout, tab.activePaneId ?? tab.layout.id)
    return pane?.type === 'leaf' && pane.view === 'visual'
  })

  useEffect(() => useStore.subscribe((state, previous) => {
    if (!state.ready) return
    if (state.composerDraft !== previous.composerDraft || state.experienceProjectId !== previous.experienceProjectId
      || state.composerScope !== previous.composerScope || state.composerTargets !== previous.composerTargets) {
      try { saveComposerWorkspace(state) } catch { /* the update action reports a failed checkpoint before restarting */ }
    }
  }), [])

  // ── main → renderer wiring ────────────────────────────────────────────────
  useEffect(() => {
    const st = useStore.getState()
    void api.getState().then(st.applyState)

    const offs = [
      api.onState((s) => useStore.getState().applyState(s)),
      api.onPtyData(({ sessionId, data }) => dispatchPty(sessionId, data)),
      api.onWindowFocus((f) => useStore.getState().setWindowFocused(f)),
      api.onFocusSession((id) => {
        useStore.getState().revealSession(id)
        useStore.getState().setOverlay({ kind: 'none' })
      }),

      api.onMenu('menu:new-session', (agent) =>
        actions.openNewSession((agent as AgentKind) ?? 'claude')
      ),
      api.onMenu('menu:fork', (kind) => actions.openFork(kind as 'child' | 'sibling')),
      api.onMenu('menu:interrupt', () => void actions.interrupt()),
      api.onMenu('menu:close-pane', () => actions.closeActivePane()),
      api.onMenu('menu:find', () => useStore.getState().setFindOpen(true)),
      api.onMenu('menu:search', () => actions.showSidebar('search')),
      api.onMenu('menu:palette', () => useStore.getState().setOverlay({ kind: 'palette' })),
      api.onMenu('menu:switcher', () => useStore.getState().setOverlay({ kind: 'switcher' })),
      api.onMenu('menu:shelf', () => useStore.getState().setOverlay({ kind: 'shelf' })),
      api.onMenu('menu:attention', () => actions.gotoAttention()),
      api.onMenu('menu:settings', () => useStore.getState().setOverlay({ kind: 'settings' })),
      api.onMenu('menu:bus', () => useStore.getState().setOverlay({ kind: 'bus' })),
      api.onMenu('menu:toggle-sidebar', () => actions.toggleSidebar()),
      api.onMenu('menu:toggle-pin', () => actions.togglePin()),
      api.onMenu('menu:split', (dir) => useStore.getState().split(dir as 'h' | 'v')),
      api.onMenu('menu:visual-pane', () => void actions.openVisualPane()),
      api.onMenu('menu:zoom', () => useStore.getState().toggleZoom()),
      api.onMenu('menu:preset', (p) =>
        useStore.getState().applyLayoutPreset(p as LayoutPreset)
      ),
      api.onMenu('menu:toggle-broadcast', () => actions.toggleBroadcast()),
      api.onMenu('menu:focus-composer', () => actions.focusComposer()),
      api.onMenu('menu:toggle-preview', () => preview.toggle()),
      api.onMenu('menu:preview-open', () => void preview.openDialog()),

      // The open file changed on disk. Re-render in place: an agent rewriting a
      // report while you read it is the normal case, not the exception.
      api.onPreviewChanged((file) => {
        const open = useStore.getState().preview.doc
        if (open && open.path === file) void preview.open(file, { quiet: true })
      }),
      // A link in a rendered document pointed at another document; main bounced
      // the navigation back here so it arrives rendered rather than raw.
      api.onPreviewNavigate((file) => void preview.open(file)),
      // A session printed a local server address. Offered rather than opened:
      // it is a line of agent output, not an instruction, and the pane never
      // connects to anything without being asked.
      api.onSessionServer(({ sessionId, url }) => {
        const st = useStore.getState()
        const name = st.sessions.find((s) => s.id === sessionId)?.title ?? 'A session'
        st.setToast(`${name} is serving ${serverLabel(url)}`, 'info', {
          label: 'Preview',
          run: () => {
            // Reveal first, so the pane it lands in is the one that owns it.
            useStore.getState().revealSession(sessionId)
            preview.openUrl(url, { owner: sessionId })
          }
        })
      }),

      // An agent finished and left a document behind. The pane decides whether
      // it is allowed to take the screen; main only says what appeared, and
      // which chat it appeared for.
      api.onPreviewProduced(({ sessionId, entry }) => {
        if (routeToVisualPane(sessionId, entry.path, isVisualPreviewKind(entry.kind))) return
        void preview.surface(sessionId, entry)
      }),
      // `workbench show <file>` — asked for by name, so within its own chat it
      // opens outright rather than deferring to what you had open. Across
      // chats it still waits its turn.
      api.onPreviewShow(({ sessionId, path }) => {
        if (routeToVisualPane(sessionId, path, isVisualPath(path))) return
        void preview.showFor(sessionId, path)
      })
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // ── report what is actually on screen ─────────────────────────────────────
  // Only the renderer knows this, and main needs it for two things: suppressing
  // a notification about the pane you are already staring at, and letting a
  // green "ready for review" go quiet once you have looked at it. Window focus
  // is a different question and is checked separately in main.
  useEffect(() => {
    // The store changes for unrelated reasons (toasts, hover, streaming
    // sessions); only an actual change of what is on screen is worth an IPC.
    let last = ''
    const report = (): void => {
      const tab = useStore.getState().activeTab()
      let payload: VisiblePanes = { sessionIds: [], focusedSessionId: null }
      if (tab && useStore.getState().experienceView === 'terminals') {
        // A zoomed pane hides its siblings, so they are not visible.
        const ids = tab.zoomedPaneId
          ? [sessionInPane(tab.layout, tab.zoomedPaneId)]
          : sessionIdsIn(tab.layout)
        const focusedPane = tab.zoomedPaneId ?? tab.activePaneId ?? tab.layout.id
        payload = {
          sessionIds: ids.filter((id): id is string => !!id),
          focusedSessionId: sessionInPane(tab.layout, focusedPane)
        }
      }
      const key = JSON.stringify(payload)
      if (key === last) return
      last = key
      void api.setVisiblePanes(payload)
    }
    report()
    return useStore.subscribe(report)
  }, [])

  // ── renderer-side keyboard shortcuts ──────────────────────────────────────

  // The native menu owns the headline accelerators; these are the ones a menu
  // item would look silly holding: Escape, the numbered pane and tab jumps, and
  // directional pane movement.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const st = useStore.getState()
      // The project editor owns Escape and focus while its draft is open.
      // This listener runs in capture phase, before the dialog can prevent a
      // dismissal during saving; leave its keyboard handling to the dialog.
      if (st.overlay.kind === 'project') return
      if (e.key === 'Escape') {
        if (st.overlay.kind !== 'none') {
          st.setOverlay({ kind: 'none' })
          e.preventDefault()
        } else if (st.findOpen) {
          st.setFindOpen(false)
          e.preventDefault()
        }
        return
      }
      // Digits read off e.code, not e.key: with Shift held, e.key for the 1 key
      // is "!" on a US layout and something else again elsewhere.
      const digit = /^Digit([1-9])$/.exec(e.code)

      // The pane-by-position jump, on the *other* modifier — ⌃1 on macOS.
      // ⌘ digits count sessions and so skip an empty pane; these count panes,
      // empty ones included, which is how you aim at a blank pane before
      // loading something into it. In a full layout the two agree.
      if (digit && hasSecondaryModifier(e) && !hasPrimaryModifier(e)) {
        st.focusPaneIndex(Number(digit[1]))
        e.preventDefault()
        return
      }

      if (!hasPrimaryModifier(e) || e.altKey) return

      if (digit) {
        const idx = Number(digit[1]) - 1
        if (e.shiftKey) {
          const tab = st.visibleTabs()[idx]
          if (tab) {
            st.setActiveTab(tab.id)
            e.preventDefault()
          }
        } else {
          // The bare number counts what is on screen first — leftmost pane is
          // 1, the next one right is 2 — and then keeps counting down the
          // sidebar for everything not visible. Tabs get Shift: you reach for a
          // session many times an hour and for a tab a few times a day.
          actions.focusSessionIndex(idx + 1)
          e.preventDefault()
        }
        return
      }

      const dir = ARROW_DIR[e.key]
      if (dir) {
        if (e.shiftKey) actions.swapDirection(dir)
        else actions.focusDirection(dir)
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (!ready) {
    return (
      <div className="app">
        <div className="pane__empty" style={{ flex: 1 }}>
          Starting Workbench…
        </div>
      </div>
    )
  }

  const sidebarVisible = prefs.sidebarVisible !== false

  return (
    <div className="app prototype-app">
      <ExperienceShell>
      <div className="body prototype-workspace">
        <ActivityBar />
        {sidebarVisible && sidebarView !== 'sessions' && <Sidebar />}
        <div className="main">
          <TabBar />
          <MinimizedBar />
          <PaneGrid />
          {!visualFocused && <Composer />}
        </div>
      </div>
      </ExperienceShell>
      <StatusBar />
      <WindowTitle />

      {overlay.kind === 'palette' && <CommandPalette />}
      {overlay.kind === 'switcher' && <SessionSwitcher />}
      {overlay.kind === 'new-session' && (
        <NewSessionDialog agent={overlay.agent} projectId={overlay.projectId} />
      )}
      {overlay.kind === 'project-share' && <ProjectShareDialog projectId={overlay.projectId} />}
      {overlay.kind === 'project' && <ProjectDialog key={`${overlay.projectId ?? 'new'}-${!!overlay.confirmDelete}`} projectId={overlay.projectId} confirmDelete={overlay.confirmDelete} />}
      {overlay.kind === 'fork' && <ForkDialog sessionId={overlay.sessionId} />}
      {overlay.kind === 'share' && <ShareDialog sessionId={overlay.sessionId} />}
      {overlay.kind === 'shelf' && <ContextShelf />}
      {overlay.kind === 'settings' && <SettingsDialog initialTab={overlay.tab} />}
      {overlay.kind === 'bus' && <BusPanel />}
      {overlay.kind === 'rename' && (
        <RenameDialog target={overlay.target} id={overlay.id} current={overlay.current} />
      )}

      <Toasts />
    </div>
  )
}

/**
 * A session with a visual mirror keeps its output inside that canvas.
 *
 * Non-visual documents are still prepared for the ordinary preview dock, but
 * they are stashed instead of opening over the canvas. That is the observable
 * "no text response" contract: the terminal and document machinery continue
 * to exist, while this presentation only ever changes when a visual exists.
 */
function routeToVisualPane(sessionId: string, path: string, visual: boolean): boolean {
  const st = useStore.getState()
  if (!st.tabs.some((tab) => hasVisualPane(tab.layout, sessionId))) return false
  if (visual) st.setVisualArtifact(sessionId, path)
  else void preview.stash(sessionId, path, true)
  return true
}
