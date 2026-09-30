/**
 * Renderer state. Main-process state (sessions, prefs, env) arrives via IPC and
 * is mirrored here read-only; everything else (layout, overlays, toasts) is
 * owned by the renderer and pushed back to main for persistence.
 */

import { create } from 'zustand'
import { emptyExperience, type ExperienceState, type ExperienceView } from '../../../shared/experience'
import { emptyReport } from '../../../shared/usage'
import { parseFocusEvents, updateFocusEvents, type FocusEvent } from '../../../shared/focusJournal'
import type {
  AgentKind,
  AgentProfile,
  AppState,
  BusEntry,
  EnvReport,
  UsageReport,
  Prefs,
  DiffQuery,
  PreviewDoc,
  PreviewEntry,
  Project,
  Session,
  SessionProject,
  StatusCounts,
  Tab,
  Workspace
} from '../../../shared/types'

/**
 * How wide a prompt casts. `project` is the dynamic one: it sends to whichever
 * Workbench project is selected, so one instruction reaches its live agents.
 */
import type { ComposerScope } from '../../../shared/composer'
export type { ComposerScope } from '../../../shared/composer'
import {
  applyPreset,
  findLeaf,
  firstEmptyPane,
  newTab,
  paneOrder,
  paneShowing,
  removePane,
  sessionInPane,
  sessionIdsIn,
  setPaneSession,
  setPaneView,
  setVisualArtifact,
  splitPane,
  swapPaneSessions
} from '../lib/layout'
import { loadComposerWorkspace } from '../lib/updateWorkspace'
import type { Share, TunnelState } from '../../../shared/share'
import type { Checkpoint } from '../../../shared/shelf'
import type { LayoutPreset } from '../lib/layout'
import { isVisualPreviewKind } from '../../../shared/visual'
import { ensureProjectTabs, focusProjectTerminal, newSessionProject, priorityProjectSession, projectTabs, reconcileProjectTabs } from '../lib/projectTerminals'

export type OverlayKind =
  | { kind: 'none' }
  | { kind: 'palette' }
  | { kind: 'switcher' }
  | { kind: 'new-session'; agent: AgentKind; projectId?: string }
  | { kind: 'project-share'; projectId: string }
  | { kind: 'project'; projectId?: string; confirmDelete?: boolean }
  | { kind: 'settings'; tab?: 'updates' | 'flow' }
  | { kind: 'bus' }
  | { kind: 'fork'; sessionId: string }
  | { kind: 'share'; sessionId: string }
  | { kind: 'shelf' }
  // Electron throws on window.prompt(), so renaming needs an in-app dialog.
  | { kind: 'rename'; target: 'session' | 'tab'; id: string; current: string }

export interface Toast {
  id: string
  text: string
  tone: 'info' | 'error' | 'success'
  /**
   * Something to do about it, shown as a button on the toast.
   *
   * A notice you can only acknowledge is a notice that has to say where to go
   * next; one that carries the verb does not. Held as a closure because it is
   * transient by construction — a toast outlives nothing.
   */
  action?: { label: string; run: () => void }
}

/**
 * The document pane on the right.
 *
 * `doc` is what main resolved; `url` is what the viewer actually loads, which
 * for a Markdown file is a document main generated from it and for an artifact
 * is the file itself. Scroll offsets are kept per path so a file being rewritten
 * while you read it comes back where you were rather than at the top.
 */
/**
 * What the sidebar is showing.
 *
 * The rail was five status filters; those are now filters *inside* the sessions
 * view, and the rail's top group picks the view. Files and Search join this
 * union when they exist — the switcher is the part that had to come first,
 * because a git panel with nowhere to live is not a git panel.
 */
export type SidebarView = 'sessions' | 'files' | 'search' | 'git' | 'shelf'

/**
 * One chat's document, kept while you are looking at a different chat.
 *
 * A copy of the parts of `PreviewState` that belong to what is on screen, so
 * restoring a slot is a straight assignment rather than a re-render.
 */
export interface SessionPreview {
  doc: PreviewDoc
  url: string
  diff: DiffQuery | null
  /** False for a user choice or an explicitly named agent deliverable. */
  auto: boolean
  /** False until the slot has been on screen. This is what raises the dot. */
  seen: boolean
}

export interface PreviewState {
  doc: PreviewDoc | null
  url: string | null
  loading: boolean
  error: string | null
  recents: PreviewEntry[]
  /** Folder the recents list was built from, so it is not rebuilt on every render. */
  recentsDir: string | null
  scroll: Record<string, number>
  /**
   * Whether what is on screen was guessed by the scan. A document chosen by
   * the user or named explicitly by the agent is protected from later guesses.
   */
  auto: boolean
  /**
   * The git query behind an open diff, or null.
   *
   * A diff has no file to re-read, so this is what "refresh" goes back to —
   * which is what makes the button say something true after you stage a file.
   */
  diff: DiffQuery | null
  /**
   * The session the document on screen belongs to, or null for one opened
   * with no pane focused. A document with no owner belongs to no chat, so
   * moving between chats leaves it alone.
   */
  owner: string | null
  /**
   * Bumped to make the frame load the same URL again.
   *
   * Only a live server needs this. Every other document gets a fresh URL when
   * it changes, so re-rendering is enough; a dev server's address never
   * changes, which means "refresh" has to be expressed as a remount.
   */
  frameNonce: number
  /**
   * What each session last put on screen, keyed by session id.
   *
   * The dock is one pane, but what it holds belongs to the focused chat. An
   * agent finishing in the background renders into its own slot and raises a
   * dot on its sidebar row instead of taking the pane away from whatever you
   * are reading; switching to it shows a document that is already built.
   */
  bySession: Record<string, SessionPreview>
}

interface UiState {
  focusEvents: FocusEvent[]
  updates: import('../../../shared/updates').UpdateState | null
  composerDraft: string
  composerSending: boolean
  setComposerDraft: (value: string | ((current: string) => string)) => void
  projectSync: import('../../../shared/projectSync').ProjectSyncState[]
  projectSyncError: string | null
  experience: ExperienceState
  experienceView: ExperienceView
  experienceProjectId: string | null
  /** Last focused workspace in each navigation scope, including All terminals. */
  experienceTabIds: Record<string, string | null>
  visibleTabs: () => Tab[]
  navigateExperience: (view: ExperienceView, projectId?: string | null, prioritize?: boolean) => void
  openProject: (projectId: string) => void
  // mirrored from main
  sessions: Session[]
  sessionProjects: SessionProject[]
  projects: Project[]
  workspaces: Workspace[]
  prefs: Prefs
  counts: StatusCounts
  env: EnvReport | null
  usage: UsageReport
  /** Sessions handed to other people, with who is watching each. */
  shares: Share[]
  checkpoints: Checkpoint[]
  /** Whether share links currently reach past this network. */
  tunnel: TunnelState
  profiles: AgentProfile[]
  /** Recent Session Bus traffic. Lives only as long as the app run. */
  busLog: BusEntry[]
  ready: boolean

  // renderer-owned
  tabs: Tab[]
  activeTabId: string | null
  overlay: OverlayKind
  toasts: Toast[]
  findOpen: boolean
  windowFocused: boolean
  /** Sidebar section collapse state, keyed by section id. */
  collapsed: Record<string, boolean>
  /** Section the activity bar last jumped to. */
  activeSection: string
  /** Bumped on every jump so the sidebar re-scrolls even to the same section. */
  sectionNonce: number
  /** Which agents the composer sends to. */
  /**
   * Which agents the composer sends to, by registry id. Only entries the user
   * has actually toggled are stored — an absent one means on, so an agent
   * added later is included rather than silently skipped.
   */
  composerTargets: Record<string, boolean>
  /** How wide the composer casts: the focused pane, its project, or all agents. */
  composerScope: ComposerScope
  /**
   * Bumped every time something asks for the caret in the prompt bar.
   *
   * A counter rather than a boolean because the request can repeat: pressing
   * the shortcut twice in a row has to focus twice, and a boolean that is
   * already `true` produces no effect the second time.
   */
  composerFocusNonce: number
  composerDictationNonce: number
  /** Whether the sidebar buckets sessions by triage status or by repository. */
  sidebarView: SidebarView
  sidebarGroupBy: 'status' | 'repo' | 'project'
  sidebarHovered: boolean
  preview: PreviewState

  applyState: (s: AppState) => void
  setToast: (text: string, tone?: Toast['tone'], action?: Toast['action']) => void
  dismissToast: (id: string) => void
  setOverlay: (o: OverlayKind) => void
  setFindOpen: (v: boolean) => void
  setWindowFocused: (v: boolean) => void
  toggleCollapsed: (key: string) => void
  focusSection: (key: string) => void
  setComposerTarget: (agent: string, on: boolean) => void
  setComposerScope: (scope: ComposerScope) => void
  /** Asks the composer to take the keyboard. */
  focusComposer: () => void
  focusDictation: () => void
  setSidebarView: (view: SidebarView) => void
  setSidebarGroupBy: (mode: 'status' | 'repo' | 'project') => void
  setSidebarHovered: (v: boolean) => void
  setPreview: (patch: Partial<PreviewState>) => void
  /** Writes (or, with null, drops) one session's remembered document. */
  setSessionPreview: (sessionId: string, slot: SessionPreview | null) => void
  rememberPreviewScroll: (path: string, y: number) => void

  // tab / layout operations
  activeTab: () => Tab | null
  commitTabs: (tabs: Tab[], activeTabId: string | null) => void
  addTab: (sessionId?: string | null) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  focusPane: (paneId: string) => void
  split: (dir: 'h' | 'v', sessionId?: string | null) => void
  /** Opens a right-hand visual pane, optionally attached to an explicit session. */
  openVisualPane: (sessionId?: string | null, artifactPath?: string) => void
  setPaneView: (paneId: string, view: 'terminal' | 'visual') => void
  /** Delivers a newly produced visual file to every visual mirror of a session. */
  setVisualArtifact: (sessionId: string, path: string) => void
  closePane: (paneId: string) => void
  assignSession: (paneId: string, sessionId: string | null) => void
  /** Reveals a session: focuses its pane if visible, else fills an empty pane. */
  revealSession: (sessionId: string) => void
  toggleZoom: () => void
  updateSizes: (tabId: string, layout: Tab['layout']) => void
  /** Rearranges the active tab's panes into a named shape. */
  applyLayoutPreset: (preset: LayoutPreset) => void
  /** Focuses the nth pane in reading order, 1-based. No-op past the end. */
  focusPaneIndex: (index: number) => void
  /** Exchanges what two panes are showing, leaving the panes where they are. */
  swapPanes: (a: string, b: string) => void
  /** Parks a pane's session as a chip and gives its screen space back. */
  minimizePane: (paneId: string) => void
  /** Brings a parked session back on screen. */
  restoreMinimized: (sessionId: string) => void
}

const api = window.term

function savedFocusEvents(): FocusEvent[] {
  try { return parseFocusEvents(localStorage.getItem('workbench.focus.events')) } catch { return [] }
}

/** Profiles change when the user edits them, which is rarely. Compare by value. */
function sameProfiles(a: AgentProfile[], b: AgentProfile[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x, i) => {
    const y = b[i]
    return (
      x.id === y.id &&
      x.label === y.label &&
      x.color === y.color &&
      x.command === y.command &&
      x.available === y.available &&
      x.version === y.version
    )
  })
}

export const useStore = create<UiState>((set, get) => ({
  focusEvents: savedFocusEvents(),
  projectSync: [],
  projectSyncError: null,
  experience: emptyExperience(),
  experienceView: 'overview',
  experienceProjectId: null,
  experienceTabIds: {},
  visibleTabs: () => projectTabs(get().tabs, get().experienceProjectId),
  openProject: (projectId) => get().navigateExperience('terminals', projectId, true),
  navigateExperience: (experienceView, projectId, prioritize = false) => {
    const state = get()
    const requested = projectId === undefined ? state.experienceProjectId : projectId
    const project = state.sessionProjects.find((item) => item.id === requested)
    const nextProjectId = project?.id ?? null
    if (nextProjectId === state.experienceProjectId && !prioritize) {
      set({ experienceView })
      return
    }
    // The sidebar's filter and the actual terminal selection must move in one
    // store update. Doing this in a component effect briefly exposes the old
    // project's pane (and its composer target) under the new project's name.
    const experienceTabIds = {
      ...state.experienceTabIds,
      [state.experienceProjectId ?? '']: state.activeTabId
    }
    let tabs = project
      ? ensureProjectTabs(state.tabs, state.sessions, project, state.experience.archivedIds)
      : reconcileProjectTabs(state.tabs, state.sessions)
    const visible = projectTabs(tabs, nextProjectId)
    const preferred = experienceTabIds[nextProjectId ?? '']
    let activeTabId: string | null = visible.find((tab) => tab.id === preferred)?.id
      ?? visible.find((tab) => tab.id === state.activeTabId)?.id
      ?? visible[0]?.id ?? null
    const priority = project && priorityProjectSession(state.sessions, project.id, state.experience.archivedIds)
    if (project && priority) {
      ({ tabs, activeTabId } = focusProjectTerminal(tabs, activeTabId, project.id, priority.id))
    }
    set({ tabs, activeTabId, experienceView, experienceProjectId: nextProjectId, experienceTabIds })
    void api.setTabs(tabs, activeTabId)
  },
  sessions: [],
  sessionProjects: [],
  projects: [],
  workspaces: [],
  prefs: {} as Prefs,
  counts: { working: 0, waiting: 0, review: 0, failed: 0, idle: 0, exited: 0, total: 0 },
  env: null,
  usage: emptyReport(),
  shares: [],
  checkpoints: [],
  tunnel: { status: 'off' },
  profiles: [],
  busLog: [],
  ready: false,

  tabs: [],
  activeTabId: null,
  overlay: { kind: 'none' },
  toasts: [],
  findOpen: false,
  windowFocused: true,
  collapsed: {},
  activeSection: 'recent',
  sectionNonce: 0,
  updates: null,
  composerDraft: '',
  composerSending: false,
  setComposerDraft: (value) => set((s) => ({ composerDraft: typeof value === 'function' ? value(s.composerDraft) : value })),
  composerTargets: {},
  composerScope: 'pane',
  composerFocusNonce: 0,
  composerDictationNonce: 0,
  sidebarView: 'sessions',
  sidebarGroupBy: 'status',
  sidebarHovered: false,
  preview: {
    doc: null,
    url: null,
    loading: false,
    error: null,
    recents: [],
    recentsDir: null,
    scroll: {},
    auto: false,
    diff: null,
    owner: null,
    frameNonce: 0,
    bySession: {}
  },

  applyState: (s) =>
    set((prev) => {
      // Adopt persisted tabs on first load; afterwards the renderer is the
      // source of truth for layout so main's copy never fights the user.
      const restored = prev.ready ? null : loadComposerWorkspace()
      const tabs = reconcileProjectTabs(
        prev.ready ? prev.tabs : s.tabs.length ? s.tabs : [newTab('Workspace')], s.sessions
      )
      const activeTabId = prev.ready
        ? prev.activeTabId
        : (s.activeTabId ?? tabs[0]?.id ?? null)
      // A closed session's remembered document goes with it, or the map grows
      // for the life of the window holding panes nobody can focus again.
      const live = new Set(s.sessions.map((x) => x.id))
      const kept = Object.keys(prev.preview.bySession).filter((id) => live.has(id))
      const preview =
        kept.length === Object.keys(prev.preview.bySession).length
          ? prev.preview
          : {
              ...prev.preview,
              bySession: Object.fromEntries(kept.map((id) => [id, prev.preview.bySession[id]]))
            }
      const focusEvents = updateFocusEvents(prev.focusEvents, prev.sessions, s.sessions, s.experience?.outputs ?? [], prev.ready)
      if (focusEvents !== prev.focusEvents) {
        // Persist only meaningful boundaries, never every half-second state
        // pulse. Storage failure leaves the live board usable in this window.
        try { localStorage.setItem('workbench.focus.events', JSON.stringify(focusEvents)) } catch { /* best effort */ }
      }
      return {
        focusEvents,
        updates: s.updates ?? null,
        ...(!prev.ready && restored ? {
          composerDraft: restored.composerDraft,
          composerScope: restored.composerScope,
          composerTargets: restored.composerTargets,
          experienceProjectId: s.sessionProjects?.some((p) => p.id === restored.experienceProjectId) ? restored.experienceProjectId : null
        } : {}),
        projectSync: s.projectSync ?? [],
        projectSyncError: s.projectSyncError ?? null,
        experience: s.experience ?? emptyExperience(),
        preview,
        sessions: s.sessions,
        sessionProjects: s.sessionProjects ?? [],
        projects: s.projects,
        workspaces: s.workspaces,
        prefs: s.prefs,
        counts: s.counts,
        env: s.env,
        usage: s.usage,
        shares: s.shares ?? [],
        checkpoints: s.checkpoints ?? [],
        tunnel: s.tunnel ?? { status: 'off' },
        // Identity kept when nothing changed: main pushes a fresh array twice a
        // second, and every component that reads a profile would re-render on it.
        profiles: sameProfiles(prev.profiles, s.profiles) ? prev.profiles : s.profiles,
        busLog: s.busLog ?? [],
        ready: true,
        tabs,
        activeTabId
      }
    }),

  setToast: (text, tone = 'info', action) => {
    const id = Math.random().toString(36).slice(2)
    set((s) => ({ toasts: [...s.toasts, { id, text, tone, action }] }))
    // A toast you are meant to act on has to outlast the glance that notices
    // it, so it gets the same dwell as an error rather than the passing 3s.
    const dwell = tone === 'error' || action ? 6500 : 3200
    setTimeout(() => get().dismissToast(id), dwell)
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setOverlay: (overlay) => set({ overlay }),
  setFindOpen: (findOpen) => set({ findOpen, ...(findOpen ? { experienceView: 'terminals' as const } : {}) }),
  setWindowFocused: (windowFocused) => set({ windowFocused }),
  toggleCollapsed: (key) =>
    set((s) => ({ collapsed: { ...s.collapsed, [key]: !s.collapsed[key] } })),
  focusSection: (key) =>
    set((s) => ({
      activeSection: key,
      // Jumping to a section always expands it, else the jump does nothing.
      collapsed: { ...s.collapsed, [key]: false },
      sectionNonce: s.sectionNonce + 1
    })),
  setComposerTarget: (agent, on) =>
    set((s) => ({ composerTargets: { ...s.composerTargets, [agent]: on } })),
  setComposerScope: (composerScope) => set({ composerScope }),
  focusComposer: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1, experienceView: 'terminals' })),
  focusDictation: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1, composerDictationNonce: s.composerDictationNonce + 1, experienceView: 'terminals' })),
  setSidebarView: (sidebarView) => set({ sidebarView, experienceView: 'terminals' }),
  setSidebarGroupBy: (sidebarGroupBy) => set({ sidebarGroupBy }),
  setSidebarHovered: (sidebarHovered) => set({ sidebarHovered }),
  setPreview: (patch) => set((s) => ({ preview: { ...s.preview, ...patch } })),
  setSessionPreview: (sessionId, slot) =>
    set((s) => {
      const bySession = { ...s.preview.bySession }
      if (slot) bySession[sessionId] = slot
      else delete bySession[sessionId]
      return { preview: { ...s.preview, bySession } }
    }),
  rememberPreviewScroll: (path, y) =>
    set((s) => ({ preview: { ...s.preview, scroll: { ...s.preview.scroll, [path]: y } } })),

  activeTab: () => {
    const tabs = get().visibleTabs()
    const { activeTabId } = get()
    return tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null
  },

  commitTabs: (tabs, activeTabId) => {
    const state = get()
    // Every way of creating a tab, including visual panes and empty fallbacks,
    // inherits the selected project. Older shared tabs retain their scope.
    const previous = new Set(state.tabs.map((tab) => tab.id))
    const inherited = newSessionProject(state.sessionProjects, state.experienceProjectId, state.activeTab(), state.sessions)
    const scoped = tabs.map((tab) => {
      if (previous.has(tab.id) || tab.sessionProjectId) return tab
      // Empty tabs opened from All terminals retain the focused project's
      // context, so their first Start button does not default back to Unfiled.
      // A populated shared tab still keeps its existing conversation ownership.
      const projectId = state.experienceProjectId
        ?? (sessionIdsIn(tab.layout).length === 0 ? inherited?.id : undefined)
      return projectId ? { ...tab, sessionProjectId: projectId } : tab
    })
    set({ tabs: scoped, activeTabId, experienceView: 'terminals' })
    void api.setTabs(scoped, activeTabId)
  },

  addTab: (sessionId = null) => {
    const state = get()
    const session = state.sessions.find((item) => item.id === sessionId)
    if (state.experienceProjectId && session && session.sessionProjectId !== state.experienceProjectId) {
      state.navigateExperience('terminals', session.sessionProjectId ?? null)
    }
    const t = newTab(`Workspace ${get().tabs.length + 1}`, sessionId)
    get().commitTabs([...get().tabs, t], t.id)
  },

  closeTab: (tabId) => {
    const tabs = get().tabs.filter((t) => t.id !== tabId)
    const visible = projectTabs(tabs, get().experienceProjectId)
    const next = visible.length ? tabs : [...tabs, newTab('Workspace')]
    const activeId =
      get().activeTabId === tabId ? (visible.at(-1)?.id ?? next.at(-1)?.id ?? null) : get().activeTabId
    get().commitTabs(next, activeId)
  },

  setActiveTab: (tabId) => {
    const state = get()
    const tab = state.tabs.find((item) => item.id === tabId)
    if (!tab) return
    if (state.experienceProjectId && tab.sessionProjectId !== state.experienceProjectId) {
      state.navigateExperience('terminals', tab.sessionProjectId ?? null)
    }
    get().commitTabs(get().tabs, tabId)
  },

  focusPane: (paneId) => {
    const tabs = get().tabs.map((t) =>
      t.id === get().activeTabId ? { ...t, activePaneId: paneId } : t
    )
    get().commitTabs(tabs, get().activeTabId)
  },

  split: (dir, sessionId = null) => {
    const state = get()
    const session = state.sessions.find((item) => item.id === sessionId)
    if (state.experienceProjectId && session && session.sessionProjectId !== state.experienceProjectId) {
      state.revealSession(session.id)
      return
    }
    const tab = get().activeTab()
    if (!tab) return
    const target = tab.activePaneId ?? tab.layout.id
    const { layout, newPaneId } = splitPane(tab.layout, target, dir, sessionId)
    const tabs = get().tabs.map((t) =>
      t.id === tab.id ? { ...t, layout, activePaneId: newPaneId, zoomedPaneId: null } : t
    )
    get().commitTabs(tabs, get().activeTabId)
  },

  openVisualPane: (attachedSessionId, carriedArtifactPath) => {
    const state = get()
    const tab = state.activeTab()
    if (!tab) {
      const next = newTab('Visual', attachedSessionId ?? null, 'visual')
      if (carriedArtifactPath && next.layout.type === 'leaf') {
        next.layout.artifact = { path: carriedArtifactPath, revision: 0 }
      }
      state.commitTabs([...state.tabs, next], next.id)
      return
    }
    const target = tab.activePaneId ?? tab.layout.id
    const focused = findLeaf(tab.layout, target)
    const candidate = focused?.type === 'leaf' ? focused.sessionId : null
    const source = candidate ? state.sessions.find((session) => session.id === candidate) : undefined
    // A visual direction sent to a bare shell is executable shell input, not a
    // prompt. Open an unattached canvas instead and let it offer real agents.
    // With no explicit id this remains the general-purpose "mirror this chat"
    // primitive used by fallbacks. Cmd/Ctrl+F normally supplies the dedicated
    // visual session created by actions.openVisualPane.
    const sessionId =
      attachedSessionId !== undefined
        ? attachedSessionId
        : source && source.agent !== 'shell'
          ? source.id
          : null
    // If this chat already put a visual in the document dock, carry it into
    // the canvas instead of opening on a decorative empty state. Textual
    // documents stay in the dock where they belong.
    const held = sessionId ? state.preview.bySession[sessionId] : undefined
    const artifactPath =
      carriedArtifactPath ??
      (held && isVisualPreviewKind(held.doc.kind) && !held.doc.virtual
        ? held.doc.path
        : undefined)
    const { layout, newPaneId } = splitPane(tab.layout, target, 'h', sessionId, {
      view: 'visual',
      artifactPath
    })
    const tabs = state.tabs.map((t) =>
      t.id === tab.id ? { ...t, layout, activePaneId: newPaneId, zoomedPaneId: null } : t
    )
    state.commitTabs(tabs, state.activeTabId)
  },

  setPaneView: (paneId, view) => {
    const state = get()
    const tab = state.activeTab()
    if (!tab) return
    let layout = setPaneView(tab.layout, paneId, view)
    if (view === 'visual') {
      const sessionId = sessionInPane(layout, paneId)
      const held = sessionId ? state.preview.bySession[sessionId] : undefined
      if (sessionId && held && isVisualPreviewKind(held.doc.kind) && !held.doc.virtual) {
        layout = setVisualArtifact(layout, sessionId, held.doc.path)
      }
    }
    if (layout === tab.layout) return
    state.commitTabs(
      state.tabs.map((t) => (t.id === tab.id ? { ...t, layout, activePaneId: paneId } : t)),
      state.activeTabId
    )
  },

  setVisualArtifact: (sessionId, path) => {
    const state = get()
    let changed = false
    const tabs = state.tabs.map((tab) => {
      const layout = setVisualArtifact(tab.layout, sessionId, path)
      if (layout === tab.layout) return tab
      changed = true
      return { ...tab, layout }
    })
    if (changed) state.commitTabs(tabs, state.activeTabId)
  },

  closePane: (paneId) => {
    const tab = get().activeTab()
    if (!tab) return
    const layout = removePane(tab.layout, paneId)
    if (!layout) {
      // Last pane in the tab — close the tab instead of leaving nothing.
      get().closeTab(tab.id)
      return
    }
    const tabs = get().tabs.map((t) =>
      t.id === tab.id
        ? {
            ...t,
            layout,
            activePaneId: t.activePaneId === paneId ? layout.id : t.activePaneId,
            zoomedPaneId: t.zoomedPaneId === paneId ? null : t.zoomedPaneId
          }
        : t
    )
    get().commitTabs(tabs, get().activeTabId)
  },

  assignSession: (paneId, sessionId) => {
    const state = get()
    const session = state.sessions.find((item) => item.id === sessionId)
    const owner = state.experienceProjectId ?? state.activeTab()?.sessionProjectId
    if (owner && session && session.sessionProjectId !== owner) {
      state.revealSession(session.id)
      return
    }
    const tab = get().activeTab()
    if (!tab) return
    const layout = setPaneSession(tab.layout, paneId, sessionId)
    const tabs = get().tabs.map((t) =>
      t.id === tab.id ? { ...t, layout, activePaneId: paneId } : t
    )
    get().commitTabs(tabs, get().activeTabId)
  },

  revealSession: (sessionId) => {
    const before = get()
    const session = before.sessions.find((item) => item.id === sessionId)
    if (before.experienceProjectId && session && session.sessionProjectId !== before.experienceProjectId) {
      before.navigateExperience('terminals', session.sessionProjectId ?? null)
    } else {
      set({ experienceView: 'terminals' })
    }
    const state = get()
    // Already on screen somewhere? Just focus it.
    for (const tab of state.visibleTabs()) {
      const paneId = paneShowing(tab.layout, sessionId)
      if (paneId) {
        const tabs = state.tabs.map((t) =>
          t.id === tab.id ? { ...t, activePaneId: paneId, zoomedPaneId: t.zoomedPaneId ? paneId : null } : t
        )
        state.commitTabs(tabs, tab.id)
        return
      }
    }
    const tab = state.activeTab()
    // All terminals can still have a project-owned tab selected. An explicit
    // No project (or another project) must open outside that tab; putting it
    // into an owned empty pane would make the next snapshot remove it again.
    if (!tab || (tab.sessionProjectId && tab.sessionProjectId !== session?.sessionProjectId)) {
      const t = newTab('Workspace', sessionId)
      state.commitTabs([...state.tabs, t], t.id)
      return
    }
    // A launch dialog opened from a particular empty pane belongs in that
    // pane. Searching the tree first could put a newly started visual agent in
    // an unrelated blank terminal to its left while leaving its canvas empty.
    const activePaneId = tab.activePaneId ?? tab.layout.id
    const activePane = findLeaf(tab.layout, activePaneId)
    if (activePane?.type === 'leaf' && !activePane.sessionId) {
      state.assignSession(activePaneId, sessionId)
      return
    }
    const empty = firstEmptyPane(tab.layout)
    if (empty) {
      state.assignSession(empty, sessionId)
      return
    }
    // Otherwise replace whatever the focused pane is showing.
    state.assignSession(tab.activePaneId ?? tab.layout.id, sessionId)
  },

  toggleZoom: () => {
    const tab = get().activeTab()
    if (!tab || !tab.activePaneId) return
    const tabs = get().tabs.map((t) =>
      t.id === tab.id
        ? { ...t, zoomedPaneId: t.zoomedPaneId ? null : t.activePaneId }
        : t
    )
    get().commitTabs(tabs, get().activeTabId)
  },

  updateSizes: (tabId, layout) => {
    // Drag-resize fires constantly; update local state and let commitTabs
    // debounce persistence through the main process.
    const tabs = get().tabs.map((t) => (t.id === tabId ? { ...t, layout } : t))
    set({ tabs })
  },

  minimizePane: (paneId) => {
    const tab = get().activeTab()
    if (!tab) return
    const sessionId = sessionInPane(tab.layout, paneId)
    if (!sessionId) return

    // Drop ids whose sessions are gone while we are here, or the list would
    // accumulate ghosts across restarts.
    const live = new Set(get().sessions.map((s) => s.id))
    // Removing the only pane would take the tab — and the chip strip — with it,
    // so the last pane is emptied rather than closed.
    const layout = removePane(tab.layout, paneId) ?? setPaneSession(tab.layout, paneId, null)
    // A visual split may mirror the same live session as a terminal pane. In
    // that case minimizing the mirror removes only that pane; adding a chip
    // would claim the still-visible session had been parked.
    const remainsVisible = sessionIdsIn(layout).includes(sessionId)
    const minimized = remainsVisible
      ? (tab.minimized ?? []).filter((id) => live.has(id))
      : [...(tab.minimized ?? []).filter((id) => live.has(id)), sessionId]
    const tabs = get().tabs.map((t) =>
      t.id === tab.id
        ? {
            ...t,
            layout,
            minimized,
            activePaneId: t.activePaneId === paneId ? layout.id : t.activePaneId,
            zoomedPaneId: t.zoomedPaneId === paneId ? null : t.zoomedPaneId
          }
        : t
    )
    get().commitTabs(tabs, get().activeTabId)
  },

  restoreMinimized: (sessionId) => {
    const tabs = get().tabs.map((t) =>
      t.minimized?.includes(sessionId)
        ? { ...t, minimized: t.minimized.filter((id) => id !== sessionId) }
        : t
    )
    set({ tabs })
    // revealSession commits, so the un-parking rides along with it.
    get().revealSession(sessionId)
  },

  applyLayoutPreset: (preset) => {
    const tab = get().activeTab()
    if (!tab) return
    const layout = applyPreset(tab.layout, preset)
    // A preset is about seeing everything at once, so it drops the zoom that
    // was hiding the rest.
    const tabs = get().tabs.map((t) =>
      t.id === tab.id ? { ...t, layout, zoomedPaneId: null } : t
    )
    get().commitTabs(tabs, get().activeTabId)
  },

  focusPaneIndex: (index) => {
    const tab = get().activeTab()
    if (!tab) return
    const paneId = paneOrder(tab.layout)[index - 1]
    if (paneId) get().focusPane(paneId)
  },

  swapPanes: (a, b) => {
    const tab = get().activeTab()
    if (!tab || a === b) return
    const layout = swapPaneSessions(tab.layout, a, b)
    // Focus follows the session, not the box: you swapped to keep working on
    // what you were working on, somewhere better placed.
    const tabs = get().tabs.map((t) =>
      t.id === tab.id
        ? { ...t, layout, activePaneId: b, zoomedPaneId: t.zoomedPaneId === a ? b : t.zoomedPaneId }
        : t
    )
    get().commitTabs(tabs, get().activeTabId)
  }
}))

/** Convenience selector: the session object shown in a pane. */
export function useSession(sessionId: string | null | undefined): Session | undefined {
  return useStore((s) => s.sessions.find((x) => x.id === sessionId))
}
