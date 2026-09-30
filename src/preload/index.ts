/**
 * Preload bridge. The renderer gets exactly this object and nothing else —
 * no Node, no ipcRenderer, no remote module.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { FlowStatus, DictationFiles } from '../shared/dictation'
import type { ProjectAppearance } from '../shared/projectAppearance'
import type {
  AgentKind,
  DiffQuery,
  GitDiff,
  GitStatus,
  AppState,
  AttachResult,
  BusAccess,
  CreateSessionOptions,
  DroppedFile,
  FileEntry,
  ForkOptions,
  HandoffOptions,
  Prefs,
  PreviewDoc,
  PreviewDocumentRequest,
  PreviewEntry,
  ProducedDocument,
  ProjectScript,
  ShownDocument,
  Project,
  SearchResult,
  SendPromptResult,
  Session,
  SessionProject,
  Tab,
  UsageReport,
  VisiblePanes,
  Workspace,
  WorkspaceMode
} from '../shared/types.js'
import type { RelayResult } from '../shared/relay.js'
import type { Share } from '../shared/share.js'
import type { Checkpoint } from '../shared/shelf.js'

type Result<T> = { ok: true; value: T } | { ok: false; error: string }

/** Unwraps the main process's result envelope, throwing on the error case. */
async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, payload)) as Result<T>
  if (!res.ok) throw new Error(res.error)
  return res.value
}

/** Subscribes to a main→renderer channel and returns an unsubscribe function. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  serviceState: () => invoke<import('../shared/services.js').ServicesState>('services:state'),
  onServices: (cb: (state: import('../shared/services.js').ServicesState) => void) => on('services:changed', cb),
  saveService: (input: import('../shared/services.js').ServiceInput) => invoke<import('../shared/services.js').ServiceRecord>('services:save', input),
  startService: (id: string) => invoke<import('../shared/services.js').ServiceRecord>('services:start', id),
  stopService: (id: string) => invoke<import('../shared/services.js').ServiceRecord>('services:stop', id),
  restartService: (id: string) => invoke<import('../shared/services.js').ServiceRecord>('services:restart', id),
  removeService: (id: string) => invoke<void>('services:remove', id),
  checkForUpdates: () => invoke<void>('updates:check'),
  downloadUpdate: () => invoke<void>('updates:download'),
  installUpdate: () => invoke<void>('updates:install'),
  defaultProjectFolder: () => invoke<string>('projects:defaultFolder'),
  projectSyncAccount: () => invoke<string>('projectSync:account'),
  projectSyncPreview: (id: string) => invoke<import('../shared/projectSync.js').SyncPreview>('projectSync:preview', id),
  projectSyncConnect: (id: string, mode: 'create' | 'join', repository: string) => invoke<void>('projectSync:connect', { id, mode, repository }),
  projectSyncNow: (id: string) => invoke<void>('projectSync:sync', id),
  projectSyncDisconnect: (id: string) => invoke<void>('projectSync:disconnect', id),
  projectSyncInvite: (id: string, username: string) => invoke<void>('projectSync:invite', { id, username }),
  projectSyncPause: (id: string, enabled: boolean) => invoke<void>('projectSync:pause', { id, enabled }),
  projectSyncResolve: (id: string, path: string, choice: 'local' | 'shared') => invoke<void>('projectSync:resolve', { id, path, choice }),
  saveTask: (input: import('../shared/experience.js').TaskInput) =>
    invoke<import('../shared/experience.js').ScheduledTask>('experience:saveTask', input),
  runTask: (id: string) => invoke<import('../shared/experience.js').TaskRun | null>('experience:runTask', id),
  removeTask: (id: string) => invoke<void>('experience:removeTask', id),
  toggleTask: (id: string, enabled: boolean) => invoke<void>('experience:toggleTask', { id, enabled }),
  archiveSession: (id: string, archived: boolean) => invoke<void>('experience:archive', { id, archived }),
  setProjectDetails: (id: string, details: import('../shared/experience.js').ProjectDetails) =>
    invoke<void>('experience:projectDetails', { id, details }),
  acknowledgeOutput: (sessionId: string, path: string) => invoke<void>('experience:acknowledgeOutput', { sessionId, path }),
  /** Renderer-safe platform name for shortcut labels and key handling. */
  platform: process.platform,

  // state
  getState: () => invoke<AppState>('state:get'),
  onState: (cb: (s: AppState) => void) => on<AppState>('state', cb),
  setPrefs: (patch: Partial<Prefs>) => invoke<Prefs>('prefs:set', patch),
  setTabs: (tabs: Tab[], activeTabId: string | null) =>
    invoke<boolean>('tabs:set', { tabs, activeTabId }),
  /**
   * Tells main which sessions are actually on screen. Only the renderer knows
   * this — window focus is not the same question — and both notification
   * suppression and "you have seen this result" depend on the answer.
   */
  setVisiblePanes: (v: VisiblePanes) => invoke<boolean>('ui:visiblePanes', v),

  // workspaces
  listWorkspaces: () =>
    invoke<{ projects: Project[]; workspaces: Workspace[] }>('workspaces:list'),
  /** null when the folder is not inside a Git repository. */
  describeFolder: (cwd: string) =>
    invoke<{ root: string; branch: string | null; defaultBranch: string | null } | null>(
      'workspaces:describe',
      cwd
    ),
  /** Repositories one level inside a folder, for when the folder itself is not one. */
  findRepos: (cwd: string) =>
    invoke<{ name: string; path: string }[]>('workspaces:repos', cwd),
  /** Resolves a launch into workspaces before any session is started. */
  prepareWorkspaces: (req: { cwd: string; title?: string; mode: WorkspaceMode; count: number }) =>
    invoke<Workspace[]>('workspaces:prepare', req),
  removeWorkspace: (id: string, force = false) =>
    invoke<{ removed: boolean; reason: string | null; path: string }>('workspaces:remove', {
      id,
      force
    }),

  // user-facing conversation projects
  createProject: (name: string, defaultCwd: string, appearance?: ProjectAppearance) =>
    invoke<SessionProject>('projects:create', { name, defaultCwd, appearance }),
  renameProject: (id: string, name: string, defaultCwd: string, appearance?: ProjectAppearance) =>
    invoke<SessionProject>('projects:rename', { id, name, defaultCwd, appearance }),
  removeProject: (id: string) => invoke<boolean>('projects:remove', id),

  // sessions
  createSession: (opts: CreateSessionOptions) => invoke<Session>('sessions:create', opts),
  forkSession: (opts: ForkOptions) => invoke<Session>('sessions:fork', opts),
  handoffSession: (opts: HandoffOptions) => invoke<Session>('sessions:handoff', opts),
  killSession: (id: string) => invoke<void>('sessions:kill', id),
  removeSession: (id: string) => invoke<void>('sessions:remove', id),
  restartSession: (id: string) => invoke<void>('sessions:restart', id),
  interruptSession: (id: string) => invoke<void>('sessions:interrupt', id),
  renameSession: (id: string, title: string) =>
    invoke<boolean>('sessions:rename', { id, title }),
  assignSessionProject: (id: string, projectId: string | null) =>
    invoke<boolean>('sessions:assignProject', { id, projectId }),
  pinSession: (id: string, pinned: boolean) => invoke<boolean>('sessions:pin', { id, pinned }),
  setBusAccess: (id: string, bus: BusAccess, projectId?: string) =>
    invoke<boolean>('sessions:busAccess', { id, bus, projectId }),
  /** Manual override when the inferred colour is wrong. */
  clearStatus: (id: string, expected?: { status: Session['status']; changedAt: number; reason: string | null }) =>
    invoke<boolean>('sessions:clearStatus', expected ? { id, expected } : id),

  /**
   * Fan-out prompt send. Returns one result per recipient rather than a single
   * boolean: a broadcast that reached four of five sessions is not a success,
   * and the caller has to be able to say which one was missed.
   */
  sendPrompt: (ids: string[], text: string) =>
    invoke<SendPromptResult[]>('sessions:sendPrompt', { ids, text }),

  /**
   * Hands a prompt to one session and, with `wait`, blocks until it answers.
   *
   * The promise stays pending for as long as the other agent is working — up to
   * the relay's own ceiling — so callers must keep their UI responsive rather
   * than treating this like the fire-and-forget `sendPrompt`.
   */
  relay: (req: {
    fromSessionId: string | null
    toSessionId: string
    message: string
    wait: boolean
    timeoutMs?: number
  }) => invoke<RelayResult>('sessions:relay', req),

  attachCommand: (id: string) => invoke<string>('sessions:attachCommand', id),
  exportTranscript: (id: string) => invoke<string>('sessions:exportTranscript', id),
  captureText: (id: string, lines?: number) =>
    invoke<string>('sessions:capture', { id, lines }),
  revealLog: (id: string) => invoke<string>('sessions:revealLog', id),
  openCwd: (id: string) => invoke<string>('sessions:openCwd', id),

  // terminal
  ptyAttach: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:attach', { id, cols, rows }),
  ptyDetach: (id: string) => ipcRenderer.send('pty:detach', id),
  ptyWrite: (id: string, data: string) => ipcRenderer.send('pty:write', { id, data }),
  ptyResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', { id, cols, rows }),
  onPtyData: (cb: (p: { sessionId: string; data: string }) => void) =>
    on<{ sessionId: string; data: string }>('pty:data', cb),

  // attachments — "show it what I see"
  /**
   * The real filesystem path behind a dropped or pasted `File`, or `''` when
   * there isn't one (an image dragged out of a web page is bytes, not a file).
   *
   * Electron 32 removed the `File.path` augmentation; `webUtils` is the
   * supported replacement, and it only exists on this side of the bridge.
   */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  /** Resolves pasted/dropped items to paths an agent can open. */
  attachFiles: (files: DroppedFile[]) => invoke<AttachResult>('attachments:adopt', { files }),
  /** The no-event fallback: read the system clipboard directly. */
  attachClipboard: () => invoke<AttachResult>('attachments:fromClipboard'),

  // git review — "what did it actually change?"
  /** null when the session's folder is not inside a repository. */
  gitStatus: (sessionId: string) => invoke<GitStatus | null>('git:status', sessionId),
  gitDiff: (query: DiffQuery) => invoke<GitDiff>('git:diff', query),
  gitStage: (sessionId: string, paths: string[]) =>
    invoke<boolean>('git:stage', { sessionId, paths }),
  gitUnstage: (sessionId: string, paths: string[]) =>
    invoke<boolean>('git:unstage', { sessionId, paths }),
  gitCommit: (sessionId: string, message: string) =>
    invoke<{ sha: string; subject: string }>('git:commit', { sessionId, message }),
  /** Leaves the machine. Only ever called from a button that names the target. */
  gitPush: (sessionId: string) =>
    invoke<{ remote: string; branch: string; created: boolean }>('git:push', sessionId),
  /** Forks a child session pointed at a patch file and asks it to review. */
  gitReviewDiff: (query: DiffQuery, agent?: AgentKind) =>
    invoke<Session>('git:reviewDiff', { query, agent }),

  // preview dock — "show me the thing you just made"
  /** Opens a path in the preview and returns everything needed to render it. */
  previewOpen: (filePath: string) => invoke<PreviewDoc>('preview:open', filePath),
  /**
   * Opens a visual without taking over the document dock's file watcher.
   * Visual canvases refresh at agent turn boundaries, while the dock follows
   * one file continuously; those are deliberately separate lifetimes.
   */
  visualOpen: (filePath: string) => invoke<PreviewDoc>('visual:open', filePath),
  /**
   * Hands a rendered body to main, which wraps it in a document with a policy
   * of its own and returns the URL the preview frame loads.
   */
  previewDocument: (req: PreviewDocumentRequest) => invoke<string>('preview:document', req),
  /** Recently changed previewable files under a folder — the empty-pane list. */
  previewRecent: (dir: string, limit?: number) =>
    invoke<PreviewEntry[]>('preview:recent', { dir, limit }),
  /** Follow a file's changes, or `null` to stop following. */
  previewWatch: (filePath: string | null) => invoke<boolean>('preview:watch', filePath),
  previewOpenInDefaultApp: (filePath: string) =>
    invoke<string>('preview:openInDefaultApp', filePath),
  previewRevealInFolder: (filePath: string) => invoke<string>('preview:revealInFolder', filePath),
  previewSaveCopy: (filePath: string) => invoke<string | null>('preview:saveCopy', filePath),
  previewStartDrag: (filePath: string) => invoke<boolean>('preview:startDrag', filePath),
  /** The open file changed on disk. */
  onPreviewChanged: (cb: (filePath: string) => void) => on<string>('preview:changed', cb),
  /** A link inside a rendered document pointed at another local document. */
  onPreviewNavigate: (cb: (filePath: string) => void) => on<string>('preview:navigate', cb),
  /** An agent finished a turn and left a document behind. */
  projectScripts: (sessionId: string) =>
    invoke<ProjectScript[]>('project:scripts', sessionId),

  /** One level of the focused session's folder. Lazy: the tree asks per folder. */
  filesList: (sessionId: string, rel = '') =>
    invoke<FileEntry[]>('files:list', { sessionId, rel }),
  filesOpen: (sessionId: string, rel = '') => invoke<string>('files:open', { sessionId, rel }),
  /** Literal text, not a pattern — see `main/files.ts`. */
  filesSearch: (sessionId: string, query: string, caseSensitive = false) =>
    invoke<SearchResult>('files:search', { sessionId, query, caseSensitive }),
  onSessionServer: (cb: (found: { sessionId: string; url: string }) => void) =>
    on<{ sessionId: string; url: string }>('session:server', cb),
  onPreviewProduced: (cb: (doc: ProducedDocument) => void) =>
    on<ProducedDocument>('preview:produced', cb),
  /** An agent asked for a file outright, via `workbench show`. */
  onPreviewShow: (cb: (doc: ShownDocument) => void) => on<ShownDocument>('preview:show', cb),
  // sharing — "let someone else watch this session"
  /**
   * Starts sharing a session. Returns immediately with a link that works on
   * this network; the link is swapped for a public one if a tunnel comes up,
   * which arrives as a normal state push rather than as this promise.
   */
  shareStart: (sessionId: string) => invoke<Share>('share:start', sessionId),
  shareStop: (sessionId: string) => invoke<null>('share:stop', sessionId),
  shareList: () => invoke<Share[]>('share:list'),

  // ── the context shelf ──────────────────────────────────────────────────
  shelfList: () => invoke<Checkpoint[]>('shelf:list'),
  shelfSave: (sessionId: string, name: string, note: string) =>
    invoke<Checkpoint>('shelf:save', { sessionId, name, note }),
  shelfOpen: (name: string, cwd?: string) => invoke<Session>('shelf:open', { name, cwd }),
  shelfExport: (name: string) =>
    invoke<{ path: string; bytes: number } | null>('shelf:export', { name }),
  shelfImport: () => invoke<Checkpoint | null>('shelf:import'),
  shelfRelabel: (name: string, nextName?: string, note?: string) =>
    invoke<Checkpoint>('shelf:relabel', { name, nextName, note }),
  shelfRemove: (name: string) => invoke<null>('shelf:remove', { name }),
  /** Host-only. Guests cannot promote themselves; see `main/share.ts`. */
  shareSetCanType: (sessionId: string, guestId: string, canType: boolean) =>
    invoke<Share | null>('share:setCanType', { sessionId, guestId, canType }),
  shareKick: (sessionId: string, guestId: string) =>
    invoke<Share | null>('share:kick', { sessionId, guestId }),

  // usage meters
  /** Checks quotas now rather than waiting for the next poll. */
  refreshUsage: () => invoke<UsageReport>('usage:refresh'),

  // host services
  minimizeWindow: () => invoke<void>('window:minimize'),
  toggleMaximizeWindow: () => invoke<void>('window:toggleMaximize'),
  closeWindow: () => invoke<void>('window:close'),
  pickFolder: (defaultPath?: string) =>
    invoke<string | null>('dialog:pickFolder', { defaultPath }),
  pickFile: (defaultPath?: string) => invoke<string | null>('dialog:pickFile', { defaultPath }),
  writeClipboard: (text: string) => invoke<boolean>('clipboard:write', text),
  readClipboard: () => invoke<string>('clipboard:read'),
  flowStatus: () => invoke<FlowStatus>('dictation:status'),
  openFlow: () => invoke<void>('dictation:openFlow'),
  dictationFiles: (sessionId: string) => invoke<DictationFiles>('dictation:files', sessionId),
  openExternal: (url: string) => invoke<boolean>('shell:openExternal', url),
  openDataDir: () => invoke<string>('app:openDataDir'),
  openHandoffDir: () => invoke<string>('app:openHandoffDir'),
  /** Deletes every on-disk session log; returns how many files were removed. */
  deleteLogs: () => invoke<number>('logs:delete'),

  // main→renderer commands (menus, tray, notifications)
  onFocusSession: (cb: (id: string) => void) => on<string>('focus-session', cb),
  onMenu: (channel: string, cb: (payload: unknown) => void) => on<unknown>(channel, cb),
  onWindowFocus: (cb: (focused: boolean) => void) => on<boolean>('window:focus', cb)
}

export type WorkbenchApi = typeof api

contextBridge.exposeInMainWorld('term', api)
