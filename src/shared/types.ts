/**
 * Shared contracts between the Electron main process and the renderer.
 * Keep this file free of runtime imports so both sides can use it.
 */

import type { Share, TunnelState } from './share.js'
import type { Checkpoint } from './shelf.js'
import type { AgentCapabilities, CustomAgent } from './agents.js'
import type { ContextUsage } from './context.js'
import type { PreviewKind } from './preview.js'
import type { ProjectAppearance } from './projectAppearance.js'

/**
 * The internal session state machine.
 *
 * Presentation is unchanged from the original three-colour triage — the extra
 * states sit *behind* it:
 *   yellow = `working`, red = `waiting`, green = `review`,
 *   neutral = `idle` (a completion the user has looked at), grey = `exited`,
 *   and `failed` gets its own error badge so a crash never masquerades as a
 *   permission request.
 */
export type SessionStatus = 'working' | 'waiting' | 'review' | 'failed' | 'idle' | 'exited'

/** Who last moved a session's status, in descending order of trust. */
export type StatusSource = 'hook' | 'trigger' | 'poll' | 'user' | 'system'

/**
 * Which agent a session is running: a key into the registry in `shared/agents.ts`.
 *
 * This was a union of the three agents the app shipped with, and widening it to
 * a string is the whole of change 5.8. A union cannot express an agent the user
 * added in Settings, and every place that pattern-matched on it — colours,
 * labels, launch flags, dialog lists — is now a lookup instead.
 *
 * The trade is real: `string` cannot be exhaustively checked. What replaces
 * that check is the same shape the file tree uses — validate the *shape* at the
 * IPC boundary (`asAgentKind`), and answer *existence* where the registry is,
 * which is the only place that knows what this install has been configured with.
 */
export type AgentKind = string

/** How a session came into being — drives the lineage tree in the sidebar. */
export type ForkKind = 'root' | 'child' | 'sibling' | 'handoff'

/**
 * How much the agent is allowed to do without asking.
 *   `default`     — the CLI's own prompting behaviour, untouched.
 *   `auto`        — accept edits / write inside the workspace, still sandboxed.
 *   `full-access` — accept everything, no sandbox. Claude's
 *                   `--dangerously-skip-permissions`, Codex's
 *                   `--dangerously-bypass-approvals-and-sandbox`.
 */
export type PermissionMode = 'default' | 'auto' | 'full-access'

/**
 * How far into the Session Bus a session reaches, and how far others reach into
 * it. One level covers both directions on purpose — see `src/main/bus.ts`.
 *
 * `off`  — hidden from ordinary callers; its project manager can still act on it.
 * `read` — others may list/read it; it can address targets whose grants permit it.
 * `full` — others may also prompt and fork it.
 * `manager` — user-authorized control of every session in one bound project.
 * `app-manager` — separately user-authorized session control across this app.
 */
export type BusAccess = 'off' | 'read' | 'full' | 'manager' | 'app-manager'

/** One call across the Session Bus, refused calls included. */
export interface BusEntry {
  id: string
  at: number
  /** How long the call took, which is how a wait_for shows up as a wait. */
  ms: number
  callerId: string
  tool: string
  targetId: string | null
  ok: boolean
  detail: string
}

export interface Session {
  id: string
  title: string
  /**
   * Automatic titles are stable two-word roles, with recent work stored below.
   * `manual` is an explicit role correction; activity still updates normally.
   */
  titleMode: 'auto' | 'manual'
  /** Distinguishes role names from older prompt fragments and random labels. */
  titleVersion?: 1
  /** Context is provisional until the first meaningful prompt establishes a role. */
  titleSource?: 'context' | 'prompt'
  /** Short reminder of the latest requested or completed work, separate from status. */
  lastTask?: string | null
  agent: AgentKind
  cwd: string
  status: SessionStatus
  /** Name of the backing tmux session on the Workbench tmux socket. */
  tmuxName: string

  createdAt: number
  lastActivityAt: number
  /**
   * Last submitted prompt observed by Workbench or the agent's lifecycle feed.
   * Separate from output activity so project entry returns to the conversation
   * the user last steered. Older records have no observed prompt time.
   */
  lastPromptAt: number | null
  lastStatusChangeAt: number
  /** When a structured lifecycle event (hook or transcript) last arrived. */
  lastEventAt: number | null
  /** When the user last had this session visible and focused. */
  lastSeenAt: number | null
  /** What produced the current status. */
  statusSource: StatusSource
  /** Latest human-readable reason for the current status, whatever it is. */
  statusReason: string | null

  /** Lineage — a forked session inherits its parent's conversation context. */
  parentId: string | null
  rootId: string
  forkKind: ForkKind
  depth: number

  /**
   * The CLI's *own* session identifier, which is what makes context inheritance real:
   * for Claude we assign it up front (`--session-id`), for Codex we capture it from
   * the process-scoped session log. Forking replays this id through
   * `--resume --fork-session` or `codex fork`.
   */
  agentSessionId: string | null

  /** Last human-readable line we surfaced for this session. */
  lastMessage: string | null

  /**
   * What this session may do on the Session Bus, and what may be done to it.
   * Absent on sessions stored before the bus existed, which read as `off`.
   */
  bus?: BusAccess
  /**
   * The project the user authorized, captured at grant time. Moving a manager
   * to another project revokes its grant instead of transferring authority.
   * App Manager is explicitly app-wide and stores null here. Neither manager
   * grant is supplied by an agent tool, inherited by a child, or inferred on load.
   */
  busProjectId?: string | null

  /**
   * What this launch was configured with, folded out of its `LaunchDescriptor`
   * so the pane can show it without a round trip.
   *
   * Derived on read rather than copied on write: the descriptor is rebuilt by a
   * restart, and a session that came back with different permissions must not
   * keep displaying the old ones.
   */
  model: string | null
  effort: string | null
  permissionMode: PermissionMode
  /**
   * A local dev server this session printed, or null.
   *
   * Read out of the session's own output, so it is a claim the session made
   * rather than something we verified — nothing connects to it until you ask.
   * It survives to disk with the rest of the record and is read back as null:
   * a server belongs to a running process, and the process is gone.
   */
  serverUrl: string | null
  /**
   * How full this session's context window is, or null when its own transcript
   * has not said yet.
   *
   * Read out of the JSONL the CLI keeps for its resume feature, so it is the
   * agent's own accounting rather than ours — see `shared/context.ts` for what
   * each CLI does and does not write down. Like `serverUrl` it belongs to a
   * running conversation and comes back off disk as null.
   */
  context: ContextUsage | null

  alive: boolean
  exitCode: number | null

  pinned: boolean
  /** Accent colour for the pane header + sidebar dot; defaults per agent profile. */
  color: string
  badge: string | null

  /**
   * The workspace this session's files live in.
   *
   * `cwd` remains the truth about where the process runs — this is the record
   * of *why* it runs there, and it is what tells an isolated attempt apart from
   * one sharing the main checkout. Null for sessions started before workspaces
   * existed.
   */
  workspaceId: string | null

  /**
   * The user-facing Workbench project this conversation is filed under.
   * Independent of `workspaceId`: one project may contain sessions from
   * several repositories and plain folders.
   */
  sessionProjectId: string | null
}

/**
 * A user-created organizational home for conversations.
 *
 * This is deliberately not the Git-oriented {@link Project} below. A
 * Workbench project can span repositories and folders; `defaultCwd` is only
 * where its New terminal button starts, not its identity.
 */
export interface SessionProject {
  id: string
  name: string
  defaultCwd: string
  createdAt: number
  /** Optional so existing projects keep their quiet, unadorned appearance. */
  appearance?: ProjectAppearance
}

/** One repository. Identified by its shared git directory, not by a path. */
export interface Project {
  id: string
  name: string
  /** Absolute path of the main working tree. */
  root: string
  /** The shared `.git` directory every worktree of this repo points at. */
  commonDir: string
  /** `origin`, normalized so ssh and https forms compare equal. */
  origin: string | null
  defaultBranch: string | null
}

/**
 * `local` — a plain folder, not a repository. Works, just cannot be branched.
 * `main`  — the repository's own checkout, opened as-is.
 * `worktree` — a separate working copy on its own branch.
 */
export type WorkspaceKind = 'local' | 'main' | 'worktree'

export interface Workspace {
  id: string
  /** Null for a folder that is not in a repository. */
  projectId: string | null
  name: string
  path: string
  kind: WorkspaceKind
  branch: string | null
  /**
   * Whether Workbench made this worktree.
   *
   * Load-bearing: a worktree that was already there belongs to whoever made it,
   * and this app never deletes one.
   */
  createdByApp: boolean
  createdAt: number
}

/**
 * How a launch decides where its agents work.
 *
 * `current`  — the folder as it stands, agents share it. What `Start both` used
 *              to do silently.
 * `shared`   — one new worktree on one new branch, both agents in it. Isolated
 *              from the main checkout, but the agents still see each other.
 * `isolated` — a worktree per agent, on sibling branches, so two attempts can be
 *              compared instead of merged by accident.
 */
export type WorkspaceMode = 'current' | 'shared' | 'isolated'

/**
 * Everything needed to relaunch a session exactly as it was first started.
 * Persisted (and version-checked) so a restart after an app quit resumes the
 * real CLI conversation instead of quietly starting a fresh one.
 */
export interface LaunchDescriptor {
  /** Bumped whenever the shape changes; unknown versions are discarded. */
  version: number
  sessionId: string
  /** Agent profile this launch belongs to. */
  profileId: AgentKind
  /** Absolute path to the executable as resolved at launch time. */
  command: string
  /** Argv the CLI is always given for this profile (hook wiring, config overrides). */
  baseArgs: string[]
  /** Argv specific to this launch (resume/fork, model, permission mode). */
  launchArgs: string[]
  /** Caller-supplied extra argv, replayed verbatim on restart. */
  extraArgs: string[]
  env: Record<string, string>
  cwd: string
  /** The workspace this launch ran in, so a restart lands in the same checkout. */
  workspaceId: string | null
  /** The CLI's own conversation id, when known. */
  agentSessionId: string | null
  origin: 'new' | 'resumed' | 'forked'
  model: string | null
  effort: string | null
  permissionMode: PermissionMode
  /** The CLI's own transcript (JSONL), once bound. */
  transcriptPath: string | null
  /** Process-scoped lifecycle log we asked this launch to write. */
  lifecycleLogPath: string | null
  /** CLI `--version` output observed when this launch was built. */
  cliVersion: string | null
  createdAt: number
}

/** What a pane draws for its session. Missing on old layouts means terminal. */
export type PaneView = 'terminal' | 'visual'

/** The visual file a visual pane last showed. Kept with the pane across restarts. */
export interface VisualArtifactRef {
  path: string
  /** Bumped when the same path is rewritten, so React knows to reopen it. */
  revision: number
}

/** Split-pane layout, iTerm2 style: leaves hold sessions, splits hold ratios. */
export type LayoutNode =
  | {
      type: 'leaf'
      id: string
      sessionId: string | null
      /** Optional for backward compatibility with every layout written before visual panes. */
      view?: PaneView
      /** Present only after this visual pane has something to show. */
      artifact?: VisualArtifactRef
    }
  | { type: 'split'; id: string; dir: 'h' | 'v'; sizes: number[]; children: LayoutNode[] }

export interface Tab {
  id: string
  title: string
  /** Conversation project that owns this workspace; absent on shared/older tabs. */
  sessionProjectId?: string
  layout: LayoutNode
  activePaneId: string | null
  /** Pane id that is temporarily zoomed to fill the tab (tmux `resize-pane -Z`). */
  zoomedPaneId: string | null
  /**
   * Sessions parked out of the layout as chips: still running, just not
   * spending screen. Optional because tabs written before this existed do not
   * have it, and an absent list means the same thing as an empty one.
   */
  minimized?: string[]
}

export interface TriggerRule {
  id: string
  name: string
  pattern: string
  flags: string
  agent: AgentKind | 'any'
  action: 'waiting' | 'review' | 'working' | 'failed' | 'notify'
  /** Optional text captured from the match, used as the status reason. */
  captureReason: boolean
  enabled: boolean
}

/**
 * A registry definition after main has looked for its binary — the shape the
 * renderer receives. `available` and `version` are the two facts that need a
 * disk, and everything else is the definition it came from.
 */
export interface AgentProfile {
  id: AgentKind
  label: string
  /** Executable resolved on the user's PATH, or the configured name if not found. */
  command: string
  args: string[]
  color: string
  available: boolean
  version: string | null
  /** What this agent can do. Drives which controls a dialog offers. */
  capabilities: AgentCapabilities
  /** False for anything the user added in Settings. */
  builtin: boolean
}

export interface Prefs {
  sidebarPinned: boolean
  sidebarVisible: boolean
  sidebarWidth: number
  /** The document pane on the right. Off until something is worth showing. */
  previewVisible: boolean
  previewWidth: number
  /** Re-render the open document when the file changes on disk. */
  previewFollowFile: boolean
  /**
   * Open the pane by itself when a finished turn produced something worth
   * looking at. The pane's answer to "the same way the Claude app does it".
   */
  previewAutoShow: boolean
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorBlink: boolean
  copyOnSelect: boolean
  /**
   * Click somewhere in a pane and the agent's text cursor goes there.
   *
   * There is no way to *place* a cursor in a terminal — the only thing a TUI
   * understands is arrow keys — so this counts the distance and sends that many
   * of them. `alt` is iTerm2's gesture, for anyone who wants a plain click to
   * stay a plain click.
   */
  clickToMoveCursor: 'off' | 'click' | 'alt'
  scrollback: number
  /** Expose visible terminal rows to OS accessibility clients and dictation tools. */
  terminalAccessibility: boolean
  defaultCwd: string
  /** iTerm2-style "send keystrokes to all panes". */
  broadcastInput: boolean
  globalHotkey: string
  hotkeyWindowEnabled: boolean
  notifyOnWaiting: boolean
  notifyOnDone: boolean
  notifySound: boolean
  /** Only notify when the target pane is not already visible and focused. */
  notifyOnlyWhenUnfocused: boolean
  /**
   * The Session Bus master switch. Off by default: an agent that can drive other
   * agents is a capability the user turns on, not one they discover.
   */
  busEnabled: boolean
  sessionLogging: boolean
  /** Cap for a single session log, in megabytes. Rotated once, then trimmed. */
  sessionLogMaxMb: number
  /** Permission mode new sessions start with unless overridden per session. */
  defaultPermissionMode: PermissionMode
  /**
   * Agents the user added themselves.
   *
   * A custom agent is a command and a colour: it launches, appears everywhere
   * the built-ins appear, and reports status through the text-pattern triggers
   * below. It gets no resume, fork or transcript, because those need knowledge
   * of a specific CLI's file formats rather than a settings form — see
   * `shared/agents.ts`.
   */
  customAgents: CustomAgent[]
  triggers: TriggerRule[]
  /**
   * Which shipped rules this install has already been offered.
   *
   * Bookkeeping, not a setting — it is the difference between "you deleted the
   * Codex trust rule" and "you installed before that rule existed". Without it,
   * a rule added in a later version would only ever reach fresh installs, and
   * every existing one would keep missing the prompt it was written for.
   */
  knownTriggerIds: string[]
}

/** One entry from a project's `package.json` scripts. */
export interface ProjectScript {
  name: string
  command: string
}

/**
 * One entry in the sidebar's file tree.
 *
 * No size and no mtime on purpose: the tree shows neither, and a thousand
 * `stat` calls per opened folder is a real cost paid for nothing. Symlinks are
 * absent entirely — see `main/files.ts` for why.
 */
export interface FileEntry {
  name: string
  /** Relative to the session's folder, forward slashes. The tree's identity for a node. */
  rel: string
  /** Absolute, so opening it needs no second round trip to resolve. */
  path: string
  dir: boolean
}

/** One line of one file that contains the search text. */
export interface SearchHit {
  rel: string
  path: string
  /** 1-based, the way an editor counts. */
  line: number
  /** Where the match starts inside `text` — the excerpt, not the original line. */
  offset: number
  /** The matching line, clipped around the match when the line is very long. */
  text: string
}

export interface SearchResult {
  hits: SearchHit[]
  /**
   * The sweep stopped early. Either a limit was reached or a newer search
   * replaced this one, so the hits are real but the absence of others is not.
   */
  truncated: boolean
  /** Files actually read. The honest denominator for "no matches". */
  scanned: number
}

/**
 * One document open in the preview dock.
 *
 * `text` is filled in for the kinds the renderer turns into HTML itself
 * (Markdown, CSV, JSON, plain text); an image, a PDF or an HTML artifact is
 * loaded by URL instead and arrives with `text: null`.
 */
export interface PreviewDoc {
  path: string
  name: string
  kind: PreviewKind
  mime: string
  size: number
  mtimeMs: number
  /** `wb-preview://f/...` — what an iframe or `<img>` loads. */
  url: string
  /** The document's own directory, for resolving relative links. */
  dirUrl: string
  text: string | null
  /** True when the file was larger than the text cap and was cut short. */
  truncated: boolean
  /**
   * True for a document with no file behind it — a diff the panel generated.
   *
   * Everything that reaches for the disk keys on this: the pane does not watch
   * it, does not offer to open it in another app, and refreshes it by asking
   * git again rather than by re-reading `path`.
   */
  virtual?: boolean
}

/** A candidate document found by scanning a session's folder. */
/**
 * A document a turn left behind, and the session that left it.
 *
 * The session is the whole point: the dock holds one document *per chat*, so
 * an agent finishing in the background fills its own slot instead of taking
 * the pane away from whatever you are reading.
 */
export interface ProducedDocument {
  sessionId: string
  entry: PreviewEntry
}

/** `workbench show <file>` — a session naming a file outright. */
export interface ShownDocument {
  sessionId: string
  path: string
}

export interface PreviewEntry {
  path: string
  name: string
  kind: PreviewKind
  mtimeMs: number
  size: number
}

/**
 * What happened to one path, per side.
 *
 * Two independent fields rather than one status because that is the distinction
 * the Git panel is *for*: a file can be staged as modified and modified again
 * since, and collapsing those into one word would hide exactly the case where
 * it matters.
 */
export type GitChange =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'untracked'
  | 'conflicted'

export interface GitFileChange {
  /** Repository-relative, forward slashes — what `git status` porcelain prints. */
  path: string
  /** Index side: null when the index matches HEAD for this path. */
  staged: GitChange | null
  /** Working-tree side: null when the file matches the index. */
  unstaged: GitChange | null
  /** Where a rename or copy came from. */
  from: string | null
}

export interface GitStatus {
  root: string
  branch: string | null
  defaultBranch: string | null
  /** `origin/main`, or null when the branch tracks nothing. */
  upstream: string | null
  ahead: number
  behind: number
  files: GitFileChange[]
  /** No commit yet. You can still commit; there is nothing to push or diff against. */
  unborn: boolean
}

/** One patch, as the panel receives it. */
export interface GitDiff {
  patch: string
  /** True when the patch was too large and was cut short at a line boundary. */
  truncated: boolean
  /** What this is a diff of, for the pane's header: `Staged`, `main…working tree`. */
  label: string
  root: string
}

/**
 * A diff the Git panel is showing, kept so the pane can rebuild it.
 *
 * The pane cannot re-read a virtual document from disk, so "refresh" has to
 * mean "ask git the same question again" — which means the question has to be
 * remembered somewhere, and this is it.
 */
export interface DiffQuery {
  /** Session whose workspace the diff was taken in. */
  sessionId: string
  side: 'worktree' | 'staged' | 'branch'
  file: string | null
  base?: string | null
  untracked?: boolean
}

/** What the renderer hands main to have it wrapped into a served document. */
export interface PreviewDocumentRequest {
  title: string
  body: string
  baseHref: string
  bodyClass?: string
  initialScroll?: number
}

export interface StatusCounts {
  working: number
  waiting: number
  review: number
  failed: number
  idle: number
  exited: number
  total: number
}

export interface EnvReport {
  tmux: { available: boolean; version: string | null; socket: string }
  claude: { available: boolean; version: string | null; path: string | null }
  codex: { available: boolean; version: string | null; path: string | null }
  node: string
  shell: string
  /** Populated when the configured global hotkey could not be registered. */
  hotkeyError: string | null
  /** Populated when durable state could not be written; surfaced in Settings. */
  storeError: string | null
}

export interface CreateSessionOptions {
  agent: AgentKind
  cwd?: string
  /** User-facing project to file the new conversation under. */
  sessionProjectId?: string
  /**
   * Run inside this workspace. Wins over `cwd`, which is then set from the
   * workspace's own path — one launch cannot be in two directories.
   */
  workspaceId?: string
  title?: string
  /** Initial prompt typed into the agent once it is ready. */
  initialPrompt?: string
  parentId?: string
  forkKind?: ForkKind
  /** Extra argv appended to the agent command. */
  extraArgs?: string[]
  /**
   * Resume this agent session id instead of starting a fresh conversation.
   *
   * Used by the context shelf, which installs a checkpoint's transcript under a
   * new id and then asks for a session that opens it. Distinct from `parentId`
   * /`forkKind`, which describe a relationship between two Workbench sessions:
   * this one has no parent in the app, only a transcript on disk.
   */
  resumeAgentSessionId?: string
  permissionMode?: PermissionMode
  model?: string | null
  effort?: string | null
}

export interface ForkOptions {
  sourceId: string
  /** 'child' resumes and forks the parent's context; 'sibling' branches from the same parent. */
  kind: 'child' | 'sibling'
  /** Switch agents while carrying the transcript across. */
  targetAgent?: AgentKind
  initialPrompt?: string
}

export interface HandoffOptions {
  sourceId: string
  targetAgent: AgentKind
  /** Prepended instruction above the exported transcript. */
  instruction?: string
}

/**
 * One item the user pasted or dropped onto a pane.
 *
 * A file that already lives on disk arrives as a `path` and is referenced where
 * it is. Only bytes with no home of their own — a screenshot on the clipboard,
 * an image dragged out of a web page — arrive as `dataBase64` and get written
 * into the app's attachments directory.
 */
export interface DroppedFile {
  path?: string
  name?: string
  dataBase64?: string
}

/**
 * The outcome of adopting a batch of attachments. Failures are named rather
 * than dropped: pasting four screenshots and silently attaching three is the
 * kind of miss you only notice after the agent answers the wrong question.
 */
export interface AttachResult {
  paths: string[]
  errors: string[]
}

/** One delivery outcome per intended recipient of a fan-out prompt. */
export interface SendPromptResult {
  sessionId: string
  ok: boolean
  error?: string
}

/** Which session the user is actually looking at, reported by the renderer. */
export interface VisiblePanes {
  /** Sessions rendered in the focused tab of a focused window. */
  sessionIds: string[]
  /** The single session in the focused pane, if any. */
  focusedSessionId: string | null
}

/**
 * One rate-limit window as a meter can draw it.
 *
 * Both vendors meter subscription usage as a percentage of an opaque
 * allowance rather than as a token count, so that is what we carry. A raw
 * "tokens left" number does not exist to report.
 */
export interface UsageWindow {
  /** Short label for the bar, e.g. "Weekly" or "Weekly · Opus". */
  label: string
  /** 0-100. Can exceed 100 in principle; the meter clamps when drawing. */
  percentUsed: number
  /** When the window rolls over, epoch ms, or null when unknown. */
  resetsAt: number | null
  /** The vendor's own verdict where it gives one, else derived from percent. */
  severity: 'normal' | 'warning' | 'critical'
  /** True for the window the meter should show when it only has room for one. */
  primary: boolean
}

/** Everything known about one agent's quota, including why it is unknown. */
export interface AgentUsage {
  agent: 'claude' | 'codex'
  windows: UsageWindow[]
  /** A live account check, or an explicitly labeled historical CLI reading. */
  source?: 'account' | 'history'
  /** Earliest next account request after throttling, epoch ms. */
  retryAt?: number | null
  /** Plan name when the source reports one, e.g. "max" or "pro". */
  plan: string | null
  /**
   * When the account was checked, or when a fallback log recorded the numbers,
   * in epoch ms. Failed requests retain this time so an old reading cannot
   * acquire a fresh timestamp just because the user pressed Refresh.
   */
  observedAt: number | null
  /** A failed lookup may accompany cached windows; the footer labels them. */
  error: string | null
}

/** Both agents' quotas, refreshed on a timer in main. */
export interface UsageReport {
  claude: AgentUsage
  codex: AgentUsage
  /** Local CLI token counts, independent of subscription allowance percentages. */
  tokens?: import('./usageTokens.js').UsageTokens
  /** When the last refresh attempt finished, epoch ms. */
  checkedAt: number | null
}

/** Snapshot pushed to the renderer on every state change. */
export interface AppState {
  updates?: import('./updates.js').UpdateState
  projectSync?: import('./projectSync.js').ProjectSyncState[]
  projectSyncError?: string | null
  experience: import('./experience.js').ExperienceState
  sessions: Session[]
  /** User-created conversation containers, independent of Git repositories. */
  sessionProjects: SessionProject[]
  /** Every known repository, so the sidebar can group sessions by one. */
  projects: Project[]
  /** Every known working copy, so a session can be labelled by its branch. */
  workspaces: Workspace[]
  tabs: Tab[]
  activeTabId: string | null
  prefs: Prefs
  counts: StatusCounts
  env: EnvReport
  profiles: AgentProfile[]
  /** Recent Session Bus traffic, newest last. Not persisted. */
  busLog: BusEntry[]
  usage: UsageReport
  /** Sessions currently shared with other people, with who is watching. */
  shares: Share[]
  /** Named conversation checkpoints on this machine's shelf. */
  checkpoints: Checkpoint[]
  /** Whether the share links currently reach beyond this network. */
  tunnel: TunnelState
}

export const STATUS_META: Record<
  SessionStatus,
  { label: string; color: string; dot: string; order: number }
> = {
  waiting: { label: 'Waiting on you', color: '#f14c4c', dot: '🔴', order: 0 },
  failed: { label: 'Failed', color: '#f85149', dot: '⛔', order: 1 },
  working: { label: 'Working', color: '#e2b93d', dot: '🟡', order: 2 },
  review: { label: 'Ready for review', color: '#3fb950', dot: '🟢', order: 3 },
  idle: { label: 'Idle', color: '#6e7681', dot: '⚪', order: 4 },
  exited: { label: 'Exited', color: '#484f58', dot: '⚫', order: 5 }
}

/** Legal transitions of the session state machine. Enforced in SessionManager. */
export const STATUS_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  idle: ['working', 'waiting', 'review', 'failed', 'exited'],
  working: ['waiting', 'review', 'failed', 'idle', 'exited'],
  waiting: ['working', 'review', 'failed', 'idle', 'exited'],
  review: ['working', 'waiting', 'failed', 'idle', 'exited'],
  failed: ['working', 'waiting', 'review', 'idle', 'exited'],
  // A dead pane only comes back through an explicit restart, which resets to idle.
  exited: ['idle']
}

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  if (from === to) return true
  return STATUS_TRANSITIONS[from].includes(to)
}
