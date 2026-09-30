/**
 * Durable state: preferences, the session registry, launch descriptors and the
 * tab layout.
 *
 * Three properties matter here, and each one exists because of a way this file
 * can ruin your day:
 *   - **Atomic writes** so a crash mid-write cannot leave an unparseable file.
 *   - **A recoverable backup**, because "your state file was corrupt so we threw
 *     it away" is not an acceptable thing to do to someone's session list.
 *   - **Surfaced failures** — a read-only disk used to be completely silent, and
 *     you would only discover it after losing everything on quit.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import type {
  LaunchDescriptor,
  Prefs,
  Project,
  Session,
  SessionProject,
  Tab,
  TriggerRule,
  Workspace
} from '../shared/types.js'
import { BUILTIN_IDS, isAgentId } from '../shared/agents.js'
import type { CustomAgent } from '../shared/agents.js'
import { tmuxNameFor } from './tmux.js'
import { readProjectAppearance, validateProjectAppearance } from '../shared/projectAppearance.js'

/** Current on-disk schema version. Bump whenever a migration is added below. */
export const STORE_VERSION = 3

export const DEFAULT_TRIGGERS: TriggerRule[] = [
  {
    id: 'codex-mcp-approval',
    name: 'Codex MCP tool approval',
    // The footer anchors this to an open dialog. A permission question left
    // in scrollback must not turn the next working turn back into "needs you".
    pattern: 'Allow the [^\\n]{1,120} MCP server to run tool [^\\n]+\\?[\\s\\S]*enter to submit \\| esc to cancel\\s*$',
    flags: 'i',
    agent: 'codex',
    action: 'waiting',
    captureReason: true,
    enabled: true
  },
  {
    id: 'codex-approval',
    name: 'Codex approval prompt',
    pattern: '(Allow command|Approve this|Do you want to (allow|proceed)|\\[y/n\\]|\\(y/N\\))',
    flags: 'i',
    agent: 'codex',
    action: 'waiting',
    captureReason: true,
    enabled: true
  },
  {
    id: 'codex-question',
    name: 'Codex asked a question',
    pattern: '(Which (option|approach)|Please (confirm|choose|clarify)|\\bWould you like\\b)',
    flags: 'i',
    agent: 'codex',
    action: 'waiting',
    captureReason: true,
    enabled: true
  },
  {
    id: 'codex-trust',
    name: 'Codex directory trust prompt',
    pattern: '(Do you (trust|want to trust)|allow Codex to work in|Yes, (allow|proceed))',
    flags: 'i',
    agent: 'codex',
    action: 'waiting',
    captureReason: true,
    enabled: true
  },
  // ── before the agent exists ───────────────────────────────────────────────
  //
  // Every rule above assumes a live agent behind a live hook. These cover the
  // window before there is one: a CLI stopped at its own trust, sign-in or
  // first-run screen has not installed a hook yet and never will until you
  // answer it, so with no trigger the pane sits at a question while the sidebar
  // shows a calm grey dot — the exact failure this app was built to remove.
  {
    id: 'claude-trust',
    name: 'Claude folder trust prompt',
    pattern: '(Do you trust the files|trust the files in this folder)',
    flags: 'i',
    agent: 'claude',
    action: 'waiting',
    captureReason: true,
    enabled: true
  },
  {
    id: 'claude-login',
    name: 'Claude needs you to sign in',
    pattern: '(Select login method|Sign in to Claude|run\\s+/login|Invalid API key)',
    flags: 'i',
    agent: 'claude',
    action: 'waiting',
    captureReason: true,
    enabled: true
  },
  {
    id: 'claude-first-run',
    name: 'Claude first-run setup',
    pattern: "(Choose the (option|text style)|Let's get started|Press Enter to continue)",
    flags: 'i',
    agent: 'claude',
    action: 'waiting',
    captureReason: true,
    enabled: true
  },
  {
    id: 'claude-permission',
    name: 'Claude permission prompt',
    pattern:
      '(Yes, I accept|Do you want to (proceed|allow|make this edit|create)|No, and tell Claude)',
    flags: 'i',
    agent: 'claude',
    action: 'waiting',
    captureReason: true,
    enabled: true
  },
  {
    id: 'agent-missing',
    name: 'Agent binary not found',
    // Anchored to the shell's own error line, and written for both orders it
    // comes in — zsh puts the name last, bash puts it first. A loose "command
    // not found" would also fire on an agent quoting a build log back at you,
    // which would mark a perfectly healthy session as failed.
    pattern:
      '^\\s*(?:(?:zsh|bash|sh|fish|env):\\s*)?(?:command not found:?\\s*(?:claude|codex)\\b' +
      '|(?:claude|codex):\\s*(?:command not found|No such file or directory))',
    flags: 'im',
    agent: 'any',
    action: 'failed',
    captureReason: true,
    enabled: true
  },
  {
    id: 'shell-sudo',
    name: 'Password prompt',
    pattern: '(\\bPassword:|\\bpassphrase\\b.*:)',
    flags: 'i',
    agent: 'any',
    action: 'waiting',
    captureReason: false,
    enabled: true
  },
  {
    id: 'generic-error',
    name: 'Error in output',
    pattern: '(^|\\s)(FATAL|Traceback \\(most recent call last\\)|panic:)',
    flags: '',
    agent: 'any',
    // Was `highlight`, which nothing ever implemented — the rule silently did
    // nothing. `failed` is what it always meant. Migrated in `migrate()`.
    action: 'failed',
    captureReason: true,
    enabled: false
  }
]

/**
 * The default rule ids that shipped before Workbench learned to back-fill new
 * ones.
 *
 * Every install from that era was offered exactly these, so a document that is
 * missing one is a document where somebody deleted it on purpose — and it stays
 * deleted. Never add to this list: it is a record of what happened, not a
 * mirror of `DEFAULT_TRIGGERS`.
 */
const TRIGGERS_SHIPPED_BEFORE_BACKFILL = [
  'codex-approval',
  'codex-question',
  'codex-trust',
  'shell-sudo',
  'generic-error'
]

export const DEFAULT_PREFS: Prefs = {
  sidebarPinned: true,
  sidebarVisible: true,
  sidebarWidth: 264,
  previewVisible: false,
  previewWidth: 460,
  previewFollowFile: true,
  previewAutoShow: true,
  fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
  fontSize: 12,
  lineHeight: 1.35,
  cursorBlink: true,
  copyOnSelect: true,
  clickToMoveCursor: 'click',
  scrollback: 100000,
  terminalAccessibility: true,
  defaultCwd: path.join(os.homedir(), 'Dev'),
  broadcastInput: false,
  globalHotkey: 'Alt+Space',
  hotkeyWindowEnabled: true,
  notifyOnWaiting: true,
  notifyOnDone: true,
  notifySound: true,
  notifyOnlyWhenUnfocused: true,
  busEnabled: false,
  sessionLogging: true,
  sessionLogMaxMb: 25,
  defaultPermissionMode: 'default',
  customAgents: [],
  triggers: DEFAULT_TRIGGERS,
  knownTriggerIds: DEFAULT_TRIGGERS.map((t) => t.id)
}

export interface PersistedShape {
  version: number
  prefs: Prefs
  sessions: Session[]
  descriptors: LaunchDescriptor[]
  tabs: Tab[]
  activeTabId: string | null
  /** User-facing conversation projects; `projects` below is legacy Git naming. */
  sessionProjects: SessionProject[]
  projects: Project[]
  workspaces: Workspace[]
}

export function emptyState(): PersistedShape {
  return {
    version: STORE_VERSION,
    prefs: { ...DEFAULT_PREFS, triggers: DEFAULT_TRIGGERS.map((t) => ({ ...t })) },
    sessions: [],
    descriptors: [],
    tabs: [],
    activeTabId: null,
    sessionProjects: [],
    projects: [],
    workspaces: []
  }
}

/** The v2 vocabulary. Anything already in it is kept as-is. */
const STATUSES: readonly Session['status'][] = [
  'idle',
  'working',
  'waiting',
  'review',
  'failed',
  'exited'
]
const TRIGGER_ACTIONS: readonly TriggerRule['action'][] = [
  'working',
  'waiting',
  'review',
  'failed',
  'notify'
]

/**
 * v1 names, mapped onto the v2 state machine.
 *
 * Consulted only for values the v2 vocabulary does not already contain — these
 * tables are a fallback, never a filter. Running every load through them alone
 * silently downgraded `working` and `review` to `idle`, so quitting the app
 * turned a session that was mid-turn, or finished and unread, into a neutral
 * one. That is the single thing the colour is for.
 */
const V1_STATUS: Record<string, Session['status']> = {
  running: 'working',
  done: 'review'
}
const V1_TRIGGER_ACTION: Record<string, TriggerRule['action']> = {
  running: 'working',
  done: 'review',
  // `highlight` was declared but never implemented; it always meant "something
  // went wrong here", so it becomes `failed` rather than being dropped silently.
  highlight: 'failed'
}

/**
 * Brings any older document up to the current shape.
 *
 * Migrations are value-level, not just key-level: a v1 session carrying
 * `status: 'running'` would otherwise land in a v2 app as an unrecognised state
 * and render with no colour at all.
 */
export function migrate(input: unknown): { data: PersistedShape; migratedFrom: number | null } {
  const empty = emptyState()
  if (!input || typeof input !== 'object') return { data: empty, migratedFrom: null }
  const raw = input as Partial<PersistedShape> & Record<string, unknown>
  const from = typeof raw.version === 'number' ? raw.version : 1

  const storedPrefs: Record<string, unknown> = isObject(raw.prefs) ? raw.prefs : {}
  const prefs: Prefs = { ...DEFAULT_PREFS, ...storedPrefs }
  // Read from the stored document rather than the merged one: the default is a
  // full list, so merging first would make every existing install look like it
  // had already been offered everything. A document written before this
  // bookkeeping existed is treated as having been offered exactly the rules of
  // that era — so its deletions survive and only genuinely new rules arrive.
  const known = Array.isArray(storedPrefs.knownTriggerIds)
    ? storedPrefs.knownTriggerIds.filter((id): id is string => typeof id === 'string')
    : TRIGGERS_SHIPPED_BEFORE_BACKFILL
  prefs.triggers = migrateTriggers(prefs.triggers, known)
  prefs.knownTriggerIds = Array.from(new Set([...known, ...DEFAULT_TRIGGERS.map((t) => t.id)]))
  prefs.sessionLogMaxMb = clampNumber(prefs.sessionLogMaxMb, 1, 2048, DEFAULT_PREFS.sessionLogMaxMb)
  prefs.scrollback = clampNumber(prefs.scrollback, 1000, 1_000_000, DEFAULT_PREFS.scrollback)
  prefs.terminalAccessibility = typeof prefs.terminalAccessibility === 'boolean'
    ? prefs.terminalAccessibility : DEFAULT_PREFS.terminalAccessibility
  prefs.fontSize = clampNumber(prefs.fontSize, 6, 48, DEFAULT_PREFS.fontSize)
  if (!['default', 'auto', 'full-access'].includes(prefs.defaultPermissionMode)) {
    prefs.defaultPermissionMode = DEFAULT_PREFS.defaultPermissionMode
  }
  if (!['off', 'click', 'alt'].includes(prefs.clickToMoveCursor)) {
    prefs.clickToMoveCursor = DEFAULT_PREFS.clickToMoveCursor
  }
  prefs.customAgents = sanitizeCustomAgents(prefs.customAgents)

  const sessions = (Array.isArray(raw.sessions) ? raw.sessions : [])
    .map(migrateSession)
    .filter((s): s is Session => s !== null)

  const descriptors = (Array.isArray(raw.descriptors) ? raw.descriptors : []).filter(
    isLaunchDescriptor
  )

  return {
    data: {
      version: STORE_VERSION,
      prefs,
      sessions,
      descriptors,
      tabs: Array.isArray(raw.tabs) ? (raw.tabs as Tab[]) : [],
      activeTabId: typeof raw.activeTabId === 'string' ? raw.activeTabId : null,
      sessionProjects: (Array.isArray(raw.sessionProjects) ? raw.sessionProjects : [])
        .map(migrateSessionProject)
        .filter((p): p is SessionProject => p !== null),
      projects: (Array.isArray(raw.projects) ? raw.projects : [])
        .map(migrateProject)
        .filter((p): p is Project => p !== null),
      workspaces: (Array.isArray(raw.workspaces) ? raw.workspaces : [])
        .map(migrateWorkspace)
        .filter((w): w is Workspace => w !== null)
    },
    migratedFrom: from === STORE_VERSION ? null : from
  }
}

/**
 * Normalizes the stored rules, then adds any shipped rule this install has
 * never been offered.
 *
 * The back-fill is what makes a new detection reach an existing install. It is
 * deliberately one-way: a rule already present is left exactly as the user
 * edited it, and a rule they deleted is not resurrected, because `known`
 * remembers that it was offered once.
 */
/**
 * Custom agent profiles, as read off disk.
 *
 * `asCustomAgents` already checks these at the IPC boundary, but store.json is
 * a file a person can edit, and load must never throw on a bad one — a single
 * malformed profile would otherwise cost the user every session they have. So
 * this drops what it cannot use and keeps the rest, matching how sessions and
 * triggers are treated a few lines above.
 *
 * A profile shadowing a built-in is dropped for the same reason it is dropped
 * at the boundary: the built-in owns a hook bridge and a transcript parser that
 * an override would silently switch off.
 */
function sanitizeCustomAgents(v: unknown): CustomAgent[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>(BUILTIN_IDS)
  const out: CustomAgent[] = []
  for (const raw of v.slice(0, 32)) {
    if (!isObject(raw)) continue
    const id = String(raw.id ?? '')
    const label = String(raw.label ?? '').trim()
    const command = String(raw.command ?? '').trim()
    if (!isAgentId(id) || seen.has(id) || !label || !command) continue
    seen.add(id)
    out.push({
      id,
      label,
      command,
      args: Array.isArray(raw.args) ? raw.args.slice(0, 32).map((a) => String(a)) : [],
      color: /^#[0-9a-fA-F]{6}$/.test(String(raw.color)) ? String(raw.color) : '#8b949e'
    })
  }
  return out
}

function migrateTriggers(input: unknown, known: string[] = []): TriggerRule[] {
  if (!Array.isArray(input)) return DEFAULT_TRIGGERS.map((t) => ({ ...t }))
  const out: TriggerRule[] = []
  for (const t of input) {
    if (!isObject(t) || typeof t.id !== 'string' || typeof t.pattern !== 'string') continue
    const rawAction = String(t.action)
    const action = (TRIGGER_ACTIONS as string[]).includes(rawAction)
      ? (rawAction as TriggerRule['action'])
      : (V1_TRIGGER_ACTION[rawAction] ?? 'waiting')
    out.push({
      id: t.id,
      name: typeof t.name === 'string' ? t.name : t.id,
      pattern: t.pattern,
      flags: typeof t.flags === 'string' ? t.flags : '',
      agent:
        t.agent === 'claude' || t.agent === 'codex' || t.agent === 'shell' ? t.agent : 'any',
      action,
      captureReason: t.captureReason !== false,
      enabled: t.enabled !== false
    })
  }
  if (!out.length) return DEFAULT_TRIGGERS.map((t) => ({ ...t }))

  const seen = new Set([...known, ...out.map((t) => t.id)])
  for (const rule of DEFAULT_TRIGGERS) {
    if (!seen.has(rule.id)) out.push({ ...rule })
  }
  return out
}

/**
 * A persisted project row, or null if it is not usable.
 *
 * Dropping a malformed row is right here: a project is a cache of what git
 * already knows, so the worst case is that the next `adopt` rebuilds it.
 */
function migrateProject(input: unknown): Project | null {
  if (!isObject(input)) return null
  const { id, root, commonDir } = input
  if (typeof id !== 'string' || !id) return null
  if (typeof root !== 'string' || !root) return null
  if (typeof commonDir !== 'string' || !commonDir) return null
  return {
    id,
    name: typeof input.name === 'string' ? input.name : path.basename(root),
    root,
    commonDir,
    origin: typeof input.origin === 'string' ? input.origin : null,
    defaultBranch: typeof input.defaultBranch === 'string' ? input.defaultBranch : null
  }
}

function migrateSessionProject(input: unknown): SessionProject | null {
  if (!isObject(input)) return null
  if (typeof input.id !== 'string' || !input.id) return null
  if (typeof input.name !== 'string' || !input.name.trim()) return null
  if (typeof input.defaultCwd !== 'string' || !input.defaultCwd) return null
  return {
    id: input.id,
    name: input.name.trim(),
    defaultCwd: input.defaultCwd,
    createdAt: numberOr(input.createdAt, Date.now()),
    ...(input.appearance === undefined ? {} : { appearance: readProjectAppearance(input.appearance) })
  }
}

function migrateWorkspace(input: unknown): Workspace | null {
  if (!isObject(input)) return null
  const { id, path: dir } = input
  if (typeof id !== 'string' || !id) return null
  if (typeof dir !== 'string' || !dir) return null
  const kind =
    input.kind === 'main' || input.kind === 'worktree' || input.kind === 'local'
      ? input.kind
      : 'local'
  return {
    id,
    projectId: typeof input.projectId === 'string' ? input.projectId : null,
    name: typeof input.name === 'string' ? input.name : path.basename(dir),
    path: dir,
    kind,
    branch: typeof input.branch === 'string' ? input.branch : null,
    // Defaults to false, and that default is load-bearing: a row whose flag was
    // lost must read as "somebody else made this", never as one Workbench is
    // free to delete.
    createdByApp: input.createdByApp === true,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : Date.now()
  }
}

function migrateSession(input: unknown): Session | null {
  if (!isObject(input)) return null
  if (typeof input.id !== 'string' || !input.id) return null
  const agent =
    input.agent === 'claude' || input.agent === 'codex' || input.agent === 'shell'
      ? input.agent
      : 'shell'
  const id = input.id
  const now = Date.now()
  const raw = String(input.status)
  const status = (STATUSES as string[]).includes(raw)
    ? (raw as Session['status'])
    : (V1_STATUS[raw] ?? 'idle')
  return {
    id,
    title: typeof input.title === 'string' ? input.title : `${agent} session`,
    // SessionManager upgrades legacy titles using the project and the bound
    // conversation, after descriptors and transcript paths are available.
    titleMode: input.titleMode === 'auto' ? 'auto' : 'manual',
    titleVersion: input.titleVersion === 1 ? 1 : undefined,
    titleSource: input.titleSource === 'prompt' ? 'prompt' : 'context',
    lastTask: typeof input.lastTask === 'string' ? input.lastTask.slice(0, 180) : null,
    agent,
    // Never read back off disk: both belong to a process that is running.
    serverUrl: null,
    context: null,
    cwd: typeof input.cwd === 'string' ? input.cwd : os.homedir(),
    status,
    tmuxName: typeof input.tmuxName === 'string' ? input.tmuxName : tmuxNameFor(id),
    createdAt: numberOr(input.createdAt, now),
    lastActivityAt: numberOr(input.lastActivityAt, now),
    lastPromptAt: typeof input.lastPromptAt === 'number' && Number.isFinite(input.lastPromptAt) && input.lastPromptAt >= 0 ? input.lastPromptAt : null,
    lastStatusChangeAt: numberOr(input.lastStatusChangeAt, now),
    lastEventAt: typeof input.lastEventAt === 'number' ? input.lastEventAt : null,
    lastSeenAt: typeof input.lastSeenAt === 'number' ? input.lastSeenAt : null,
    statusSource: isStatusSource(input.statusSource) ? input.statusSource : 'system',
    // v1 only ever kept a reason for `waiting`; carry it across rather than lose it.
    statusReason:
      typeof input.statusReason === 'string'
        ? input.statusReason
        : typeof input.waitingReason === 'string'
          ? input.waitingReason
          : null,
    parentId: typeof input.parentId === 'string' ? input.parentId : null,
    rootId: typeof input.rootId === 'string' ? input.rootId : id,
    forkKind:
      input.forkKind === 'child' ||
      input.forkKind === 'sibling' ||
      input.forkKind === 'handoff'
        ? input.forkKind
        : 'root',
    depth: numberOr(input.depth, 0),
    agentSessionId: typeof input.agentSessionId === 'string' ? input.agentSessionId : null,
    lastMessage: typeof input.lastMessage === 'string' ? input.lastMessage : null,
    // Scope must be stored explicitly: an old project grant never widens on
    // upgrade, and a malformed app grant with a project binding fails closed.
    // The app's runtime store is not an OS boundary against same-user edits.
    bus: input.bus === 'read' || input.bus === 'full' ? input.bus
      : input.bus === 'app-manager' && input.busProjectId === null ? 'app-manager'
      : input.bus === 'manager' && typeof input.busProjectId === 'string' && input.busProjectId.length > 0
        && input.busProjectId === input.sessionProjectId ? 'manager' : 'off',
    busProjectId: input.bus === 'manager' && typeof input.busProjectId === 'string'
      && input.busProjectId === input.sessionProjectId ? input.busProjectId : null,
    // Not read back from disk: these are folded in from the launch descriptor
    // every time a session is handed to the renderer, and a stored copy could
    // only ever be the stale one. The safe placeholder is the strictest mode,
    // so a session whose descriptor is gone never claims more freedom than it
    // can prove.
    model: null,
    effort: null,
    permissionMode: 'default',
    alive: input.alive === true,
    exitCode: typeof input.exitCode === 'number' ? input.exitCode : null,
    pinned: input.pinned === true,
    color:
      typeof input.color === 'string'
        ? input.color
        : agent === 'claude'
          ? '#d97757'
          : agent === 'codex'
            ? '#10a37f'
            : '#8b949e',
    badge: typeof input.badge === 'string' ? input.badge : null,
    // Null for every session started before workspaces existed — those ran in
    // the folder they were pointed at, which `cwd` already records.
    workspaceId: typeof input.workspaceId === 'string' ? input.workspaceId : null,
    sessionProjectId:
      typeof input.sessionProjectId === 'string' ? input.sessionProjectId : null
  }
}

function isLaunchDescriptor(input: unknown): input is LaunchDescriptor {
  if (!isObject(input)) return false
  return (
    typeof input.version === 'number' &&
    typeof input.sessionId === 'string' &&
    typeof input.command === 'string' &&
    Array.isArray(input.baseArgs) &&
    Array.isArray(input.launchArgs) &&
    typeof input.cwd === 'string'
  )
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
function isStatusSource(v: unknown): v is Session['statusSource'] {
  return v === 'hook' || v === 'trigger' || v === 'poll' || v === 'user' || v === 'system'
}
function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.min(max, Math.max(min, n))
}

export class Store {
  private file: string
  private backupFile: string
  private corruptFile: string
  private data: PersistedShape
  /** Last write failure, surfaced in Settings rather than swallowed. */
  private _error: string | null = null
  private _migratedFrom: number | null = null

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'workbench.json')
    this.backupFile = `${this.file}.bak`
    this.corruptFile = `${this.file}.corrupt`
    this.data = this.load()
  }

  /** Non-null when the last save failed; cleared by the next successful save. */
  get error(): string | null {
    return this._error
  }

  /** The schema version we upgraded from on this launch, if any. */
  get migratedFrom(): number | null {
    return this._migratedFrom
  }

  private load(): PersistedShape {
    const attempt = (file: string): PersistedShape | null => {
      let raw: string
      try {
        raw = fs.readFileSync(file, 'utf8')
      } catch {
        return null // absent is normal on first run
      }
      try {
        const { data, migratedFrom } = migrate(JSON.parse(raw))
        this._migratedFrom = migratedFrom
        return data
      } catch {
        return null // present but unparseable — that is worth reporting
      }
    }

    const primary = attempt(this.file)
    if (primary) return primary

    // The main file exists but is unreadable. Keep a copy of it before falling
    // back, so nothing is destroyed by the recovery itself.
    if (fs.existsSync(this.file)) {
      try {
        fs.copyFileSync(this.file, this.corruptFile)
      } catch {
        /* best effort */
      }
      const backup = attempt(this.backupFile)
      if (backup) {
        this._error = `State file was unreadable; recovered the previous version. The damaged copy is at ${this.corruptFile}`
        return backup
      }
      this._error = `State file was unreadable and no backup could be used. A copy is at ${this.corruptFile}`
    }
    return emptyState()
  }

  private saveTimer: NodeJS.Timeout | null = null

  /** Coalesces bursts of writes; state changes fire constantly while agents run. */
  save(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveNow()
    }, 400)
  }

  /**
   * Writes immediately. Returns whether it worked — callers that are shutting
   * down need to know, and `error` is surfaced in Settings either way.
   */
  saveNow(): boolean {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      // Roll the last good file aside first: if this write is the one that
      // corrupts, the backup is from before it.
      if (fs.existsSync(this.file)) {
        try {
          fs.copyFileSync(this.file, this.backupFile)
        } catch {
          /* a missing backup is not a reason to skip the write */
        }
      }
      const tmp = `${this.file}.${process.pid}.tmp`
      const fd = fs.openSync(tmp, 'w', 0o600)
      try {
        fs.writeFileSync(fd, JSON.stringify(this.data, null, 2), 'utf8')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, this.file)
      this._error = null
      return true
    } catch (err) {
      this._error = `Could not save app state: ${(err as Error).message}`
      return false
    }
  }

  get prefs(): Prefs {
    return this.data.prefs
  }

  setPrefs(patch: Partial<Prefs>): Prefs {
    this.data.prefs = { ...this.data.prefs, ...patch }
    this.save()
    return this.data.prefs
  }

  get sessions(): Session[] {
    return this.data.sessions
  }

  setSessions(sessions: Session[]): void {
    this.data.sessions = sessions
    this.save()
  }

  get descriptors(): LaunchDescriptor[] {
    return this.data.descriptors
  }

  setDescriptors(descriptors: LaunchDescriptor[]): void {
    this.data.descriptors = descriptors
    this.save()
  }

  get tabs(): Tab[] {
    return this.data.tabs
  }

  setTabs(tabs: Tab[], activeTabId: string | null): void {
    this.data.tabs = tabs
    this.data.activeTabId = activeTabId
    this.save()
  }

  get activeTabId(): string | null {
    return this.data.activeTabId
  }

  get projects(): Project[] {
    return this.data.projects
  }

  get sessionProjects(): SessionProject[] {
    return this.data.sessionProjects
  }

  createSessionProject(name: string, defaultCwd: string, appearance?: unknown): SessionProject {
    const clean = name.trim()
    if (!clean) throw new Error('Project name is required')
    if (this.data.sessionProjects.some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
      throw new Error(`A project named “${clean}” already exists`)
    }
    const project: SessionProject = {
      id: `project_${crypto.randomBytes(8).toString('hex')}`,
      name: clean,
      defaultCwd,
      createdAt: Date.now(),
      ...(appearance === undefined ? {} : { appearance: validateProjectAppearance(appearance) })
    }
    this.data.sessionProjects.push(project)
    this.save()
    return project
  }

  renameSessionProject(id: string, name: string, defaultCwd?: string, appearance?: unknown): SessionProject {
    const project = this.data.sessionProjects.find((p) => p.id === id)
    if (!project) throw new Error('That project no longer exists')
    const clean = name.trim()
    if (!clean) throw new Error('Project name is required')
    if (
      this.data.sessionProjects.some(
        (p) => p.id !== id && p.name.toLowerCase() === clean.toLowerCase()
      )
    ) {
      throw new Error(`A project named “${clean}” already exists`)
    }
    const design = appearance === undefined ? undefined : validateProjectAppearance(appearance)
    project.name = clean
    if (defaultCwd) project.defaultCwd = defaultCwd
    if (design) project.appearance = design
    this.save()
    return project
  }

  removeSessionProject(id: string): boolean {
    const before = this.data.sessionProjects.length
    this.data.sessionProjects = this.data.sessionProjects.filter((p) => p.id !== id)
    if (this.data.sessionProjects.length === before) return false
    this.save()
    return true
  }

  get workspaces(): Workspace[] {
    return this.data.workspaces
  }

  setWorkspaceState(projects: Project[], workspaces: Workspace[]): void {
    this.data.projects = projects
    this.data.workspaces = workspaces
    this.save()
  }
}
