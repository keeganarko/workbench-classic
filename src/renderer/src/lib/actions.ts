/**
 * App-level commands. Menus, the command palette, keyboard shortcuts and
 * buttons all funnel through here so the behaviour is identical whichever
 * way you reach it.
 */

import type { AgentKind, CreateSessionOptions, ForkOptions } from '../../../shared/types'
import { useStore } from '../state/store'
import type { SidebarView } from '../state/store'
import { findLeaf, paneInDirection, paneOrder } from './layout'
import type { Direction, PaneRect } from './layout'
import { nextNeedingAttention } from './ui'
import { numberKeyOrder } from '../../../shared/sessionOrder'
import { newSessionProject } from './projectTerminals'
import { SCREEN_READER_INDICATOR } from '../../../shared/flowContext'
import {
  isVisualPreviewKind,
  VISUAL_AGENT,
  VISUAL_EFFORT,
  VISUAL_MODEL
} from '../../../shared/visual'

const api = window.term
let visualLaunchPending = false

/**
 * Where every pane currently sits on screen.
 *
 * Read from the DOM rather than computed from the tree: the tree stores
 * ratios, and only the browser knows what those came out as after the
 * splitters, the sidebar and the preview dock have had their say.
 */
function paneRects(): PaneRect[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-pane-id]')).map((el) => {
    const b = el.getBoundingClientRect()
    return { id: el.dataset.paneId!, left: b.left, top: b.top, right: b.right, bottom: b.bottom }
  })
}

/**
 * The pane a directional move lands on.
 *
 * Zoomed is its own case: there is only one pane on screen, so there is no
 * geometry to compare and the move steps through reading order instead,
 * carrying the zoom with it.
 */
function paneToward(dir: Direction): string | null {
  const tab = useStore.getState().activeTab()
  if (!tab) return null
  const current = tab.activePaneId ?? tab.layout.id
  if (tab.zoomedPaneId) {
    const order = paneOrder(tab.layout)
    const at = order.indexOf(current)
    if (at < 0) return null
    const step = dir === 'right' || dir === 'down' ? 1 : -1
    return order[(at + step + order.length) % order.length] ?? null
  }
  return paneInDirection(paneRects(), current, dir)
}

/** The session in the focused pane of the focused tab, if any. */
export function activeSessionId(): string | null {
  const s = useStore.getState()
  const tab = s.activeTab()
  if (!tab) return null
  const paneId = tab.activePaneId ?? tab.layout.id
  const node = findLeaf(tab.layout, paneId)
  return node && node.type === 'leaf' ? node.sessionId : null
}

export const actions = {
  openNewSession(agent: AgentKind = 'claude', projectId?: string): void {
    const state = useStore.getState()
    const inherited = newSessionProject(state.sessionProjects, state.experienceProjectId, state.activeTab(), state.sessions)
    state.setOverlay({ kind: 'new-session', agent, projectId: projectId ?? inherited?.id })
  },

  async createSession(opts: CreateSessionOptions): Promise<void> {
    const st = useStore.getState()
    try {
      // The dialog always supplies sessionProjectId, including undefined when
      // the user deliberately picks No project. Only callers that omit the
      // field (such as palette scripts) need the current context filled in.
      const inherited = newSessionProject(st.sessionProjects, st.experienceProjectId, st.activeTab(), st.sessions)
      const sessionProjectId = Object.prototype.hasOwnProperty.call(opts, 'sessionProjectId')
        ? opts.sessionProjectId : inherited?.id
      const project = st.sessionProjects.find((item) => item.id === sessionProjectId)
      const session = await api.createSession({
        ...opts, sessionProjectId, cwd: opts.cwd ?? project?.defaultCwd
      })
      st.applyState(await api.getState())
      st.revealSession(session.id)
      st.setOverlay({ kind: 'none' })
    } catch (err) {
      st.setToast(`Could not start ${opts.agent}: ${(err as Error).message}`, 'error')
    }
  },

  /**
   * Starts the speed-first agent that lives behind a new visual canvas.
   *
   * A separate session is intentional. Model and effort are launch settings,
   * and changing the focused coding conversation just because the user opened
   * a canvas would be a surprising, destructive context switch. The new
   * session shares the same folder so it can keep evolving the artifact there;
   * its terminal remains available behind the canvas when interaction is
   * required. If Codex cannot be launched, the old mirror behaviour is still a
   * useful degraded mode and preserves access to the feature.
   */
  async openVisualPane(): Promise<void> {
    if (visualLaunchPending) return
    visualLaunchPending = true

    const st = useStore.getState()
    const tab = st.activeTab()
    const paneId = tab?.activePaneId ?? tab?.layout.id
    const leaf = tab && paneId ? findLeaf(tab.layout, paneId) : null
    const source =
      leaf?.type === 'leaf' && leaf.sessionId
        ? st.sessions.find((session) => session.id === leaf.sessionId)
        : undefined
    const project = newSessionProject(st.sessionProjects, st.experienceProjectId, tab, st.sessions)
    const held = source ? st.preview.bySession[source.id] : undefined
    const artifactPath =
      held && isVisualPreviewKind(held.doc.kind) && !held.doc.virtual
        ? held.doc.path
        : undefined
    const profile = st.profiles.find((item) => item.id === VISUAL_AGENT)

    try {
      if (!profile?.available) throw new Error('Codex is not available on PATH')
      const label = source?.title.trim() || 'Canvas'
      const session = await api.createSession({
        agent: VISUAL_AGENT,
        cwd: source?.cwd ?? project?.defaultCwd ?? st.prefs.defaultCwd,
        workspaceId: source?.workspaceId ?? undefined,
        sessionProjectId: source?.sessionProjectId ?? project?.id,
        title: `Visual · ${label}`.slice(0, 400),
        permissionMode: source?.permissionMode ?? st.prefs.defaultPermissionMode,
        model: VISUAL_MODEL,
        effort: VISUAL_EFFORT
      })
      // Re-read after IPC: main may have pushed fresher session/layout state
      // while the process was starting.
      useStore.getState().openVisualPane(session.id, artifactPath)
      useStore
        .getState()
        .setToast(`${VISUAL_MODEL} · ${VISUAL_EFFORT} visual session started.`, 'success')
    } catch (err) {
      const current = useStore.getState()
      current.openVisualPane()
      current.setToast(
        `Fast visual session could not start; using the focused session: ${(err as Error).message}`,
        'error'
      )
    } finally {
      visualLaunchPending = false
    }
  },

  openFork(kind: 'child' | 'sibling' = 'child'): void {
    const id = activeSessionId()
    const st = useStore.getState()
    if (!id) {
      st.setToast('Focus a session first, then fork it.', 'error')
      return
    }
    st.setOverlay({ kind: 'fork', sessionId: id })
    // The dialog reads this to preselect child vs parallel.
    pendingForkKind = kind
  },

  async fork(opts: ForkOptions): Promise<void> {
    const st = useStore.getState()
    try {
      const session = await api.forkSession(opts)
      st.revealSession(session.id)
      st.setOverlay({ kind: 'none' })
      st.setToast(
        `${opts.kind === 'child' ? 'Child' : 'Parallel'} session started with inherited context.`,
        'success'
      )
    } catch (err) {
      st.setToast(`Fork failed: ${(err as Error).message}`, 'error')
    }
  },

  /**
   * Fork a child session and hand it the diff that is on screen.
   *
   * This is the review loop closing: the reviewer is the agent already in the
   * room, forked from the session that wrote the code, so it inherits the
   * conversation *and* is handed the change stated explicitly. No API key, no
   * second tool, no copy-paste.
   */
  async reviewOpenDiff(): Promise<void> {
    const st = useStore.getState()
    const query = st.preview.diff
    if (!query) {
      st.setToast('Open a diff first, then ask for a review of it.', 'error')
      return
    }
    try {
      const session = await api.gitReviewDiff(query)
      st.revealSession(session.id)
      st.setToast('Reviewing that diff in a new child session.', 'success')
    } catch (err) {
      st.setToast(`Could not start the review: ${(err as Error).message}`, 'error')
    }
  },

  /**
   * Jump to the next session that wants something from you.
   *
   * The whole point of the triage sidebar is knowing *that* something needs
   * you; this is the other half — getting there without reading a list. Press
   * it repeatedly and it walks every blocked session in turn.
   */
  focusDirection(dir: Direction): void {
    const st = useStore.getState()
    const next = paneToward(dir)
    if (!next) return
    const tab = st.activeTab()
    if (tab?.zoomedPaneId) {
      // Move the zoom along with the focus, or you would be looking at one
      // pane while typing into another.
      st.commitTabs(
        st.tabs.map((t) =>
          t.id === tab.id ? { ...t, activePaneId: next, zoomedPaneId: next } : t
        ),
        st.activeTabId
      )
      return
    }
    st.focusPane(next)
  },

  swapDirection(dir: Direction): void {
    const st = useStore.getState()
    const tab = st.activeTab()
    if (!tab) return
    const next = paneToward(dir)
    if (!next) return
    st.swapPanes(tab.activePaneId ?? tab.layout.id, next)
  },

  /**
   * ⌘1…⌘9 — jump to the nth session the sidebar is showing, counted from the top.
   *
   * The numbers name *sessions*, not panes, because the sidebar is the list
   * you are actually reading: it is sorted by what needs you, it survives a
   * layout change, and it is where the number is printed. `revealSession`
   * then does the right thing either way — if that session is already on
   * screen it focuses its pane, and if it is not it loads it into the focused
   * one. So the shortcut is "put me on session n" whether or not it happens to
   * be visible, which is the thing you actually wanted both times.
   *
   * `n` counts the panes on screen first, left to right, and then continues
   * into the sidebar for everything not already visible.
   *
   * Deliberately re-derived on every press rather than remembered. In a list
   * ordered by triage status the order changes constantly, and a cached one
   * would send ⌘3 somewhere the sidebar stopped pointing minutes ago.
   */
  focusSessionIndex(index: number): void {
    const st = useStore.getState()
    const tab = st.activeTab()
    const order = numberKeyOrder({
      sessions: st.sessions,
      workspaces: st.workspaces,
      projects: st.projects,
      sessionProjects: st.sessionProjects,
      groupBy: st.sidebarGroupBy,
      activeSection: st.activeSection,
      collapsed: st.collapsed,
      layout: tab?.layout ?? null,
      zoomedPaneId: tab?.zoomedPaneId ?? null
    })
    const id = order[index - 1]
    // Silent past the end on purpose: holding ⌘ and walking the digits should
    // not fire a toast for every empty slot past the last session.
    if (id) st.revealSession(id)
  },

  /**
   * Puts the caret in the broadcast prompt bar.
   *
   * The composer competes with a terminal for the keyboard, and a terminal
   * wins every ambiguous click — so there has to be one key that says "type to
   * the agents, not into the pane". Bumping a counter rather than reaching for
   * the element keeps the DOM in the component that owns it.
   */
  focusComposer(): void {
    useStore.getState().focusComposer()
  },

  gotoAttention(): void {
    const st = useStore.getState()
    const next = nextNeedingAttention(st.sessions, activeSessionId())
    if (!next) {
      st.setToast('Nothing needs you right now.')
      return
    }
    st.revealSession(next.id)
  },

  async interrupt(): Promise<void> {
    const id = activeSessionId()
    if (!id) return
    await api.interruptSession(id)
  },

  async kill(id: string): Promise<void> {
    await api.killSession(id)
  },

  async remove(id: string): Promise<void> {
    await api.removeSession(id)
    // Re-read after the await — a layout change made while the IPC was in
    // flight would otherwise be clobbered by a stale snapshot.
    const st = useStore.getState()
    const tabs = st.tabs.map((t) => ({ ...t, layout: clearSession(t.layout, id) }))
    st.commitTabs(tabs, st.activeTabId)
  },

  async restart(id: string): Promise<void> {
    const st = useStore.getState()
    try {
      await api.restartSession(id)
      st.setToast('Session restarted.', 'success')
    } catch (err) {
      st.setToast(`Restart failed: ${(err as Error).message}`, 'error')
    }
  },

  closeActivePane(): void {
    const st = useStore.getState()
    const tab = st.activeTab()
    if (!tab?.activePaneId) return
    st.closePane(tab.activePaneId)
  },

  toggleSidebar(): void {
    const st = useStore.getState()
    void api.setPrefs({ sidebarVisible: !st.prefs.sidebarVisible })
  },

  /**
   * Show one of the sidebar's views, from anywhere.
   *
   * Three things have to be true for the panel to be usable, and a command that
   * only did one of them would look broken: the sidebar has to be on screen, it
   * has to be showing that view, and — if it is unpinned and therefore only
   * peeking on hover — it has to stay put once the mouse leaves the rail.
   */
  showSidebar(view: SidebarView): void {
    const st = useStore.getState()
    if (!st.prefs.sidebarVisible) void api.setPrefs({ sidebarVisible: true })
    if (!st.prefs.sidebarPinned) st.setSidebarHovered(true)
    st.setSidebarView(view)
  },

  togglePin(): void {
    const st = useStore.getState()
    const pinned = !st.prefs.sidebarPinned
    void api.setPrefs({ sidebarPinned: pinned, sidebarVisible: true })
    st.setToast(pinned ? 'Sidebar pinned.' : 'Sidebar unpinned — hover the rail to peek.')
  },

  /**
   * The command Wispr Flow's "Set up variable recognition" dialog tells users
   * to run in their IDE, mirrored here so the same steps work in Workbench.
   * It flips the one pref behind both Chromium's accessibility support and
   * xterm's screen-reader rows; the bottom bar shows Flow's indicator text
   * while it is on.
   */
  toggleScreenReaderMode(): void {
    const st = useStore.getState()
    const on = st.prefs.terminalAccessibility === false
    void api.setPrefs({ terminalAccessibility: on })
    st.setToast(
      on ? `${SCREEN_READER_INDICATOR} — terminal text is exposed to accessibility tools and Wispr Flow.` : 'Screen reader mode off.',
      on ? 'success' : 'info'
    )
  },
  toggleBroadcast(): void {
    const st = useStore.getState()
    const on = !st.prefs.broadcastInput
    void api.setPrefs({ broadcastInput: on })
    st.setToast(
      on ? 'Broadcast input ON — keystrokes go to every pane.' : 'Broadcast input off.',
      on ? 'success' : 'info'
    )
  },

  async attachInITerm(id: string): Promise<void> {
    const st = useStore.getState()
    const cmd = await api.attachCommand(id)
    await api.writeClipboard(cmd)
    st.setToast(`Copied: ${cmd}`, 'success')
  },

  async exportTranscript(id: string): Promise<void> {
    const st = useStore.getState()
    try {
      const file = await api.exportTranscript(id)
      await api.writeClipboard(file)
      st.setToast(`Transcript written to ${file} (path copied).`, 'success')
    } catch (err) {
      st.setToast(`Export failed: ${(err as Error).message}`, 'error')
    }
  }
}

/** Set by openFork so the dialog opens on the right tab. */
export let pendingForkKind: 'child' | 'sibling' = 'child'

function clearSession(
  node: import('../../../shared/types').LayoutNode,
  sessionId: string
): import('../../../shared/types').LayoutNode {
  if (node.type === 'leaf') {
    if (node.sessionId !== sessionId) return node
    const { artifact: _oldArtifact, ...withoutArtifact } = node
    return { ...withoutArtifact, sessionId: null }
  }
  return { ...node, children: node.children.map((c) => clearSession(c, sessionId)) }
}
