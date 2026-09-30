/**
 * Runtime validation for everything that crosses the IPC boundary.
 *
 * The renderer is not a trusted input source. `contextIsolation` keeps page
 * script out of the main process, but any XSS in a rendered agent message would
 * still be speaking through the same preload bridge — so a payload's *shape* is
 * checked here rather than assumed from a TypeScript annotation that evaporates
 * at build time.
 *
 * Deliberately hand-rolled: a schema library would be a supply-chain dependency
 * in the one process that has filesystem and process-spawning authority.
 */

import { BUILTIN_IDS, isAgentId, slugifyAgentId } from '../shared/agents.js'
import type { CustomAgent } from '../shared/agents.js'
import type {
  DiffQuery,
  AgentKind,
  BusAccess,
  CreateSessionOptions,
  DroppedFile,
  ForkOptions,
  HandoffOptions,
  PermissionMode,
  Prefs,
  PreviewDocumentRequest,
  Tab,
  VisiblePanes,
  WorkspaceMode
} from '../shared/types.js'

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

function fail(what: string): never {
  throw new ValidationError(`Invalid ${what}`)
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** A session id as we mint them: hex, short, and safe inside a tmux name. */
export function asSessionId(v: unknown, what = 'session id'): string {
  if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(v)) fail(what)
  return v
}

export function asString(v: unknown, what: string, maxLen = 100_000): string {
  if (typeof v !== 'string' || v.length > maxLen) fail(what)
  return v
}

export function asOptionalString(v: unknown, what: string, maxLen = 100_000): string | undefined {
  if (v === undefined || v === null) return undefined
  return asString(v, what, maxLen)
}

export function asBool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') fail(what)
  return v
}

export function asInt(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(what)
  return Math.min(max, Math.max(min, Math.round(v)))
}

/**
 * A registry key, checked for shape only.
 *
 * Membership is deliberately not checked here. Which agents exist depends on
 * what the user has configured, and that lives in prefs — so the launch path
 * answers it, where a miss can say "Gemini CLI was not found on PATH" instead
 * of a validator's flat refusal. Same split as the file tree: shape at the
 * boundary, existence where the truth is.
 */
export function asAgentKind(v: unknown): AgentKind {
  if (!isAgentId(v)) fail('agent kind')
  return v
}

export function asPermissionMode(v: unknown): PermissionMode | undefined {
  if (v === undefined || v === null) return undefined
  if (v !== 'default' && v !== 'auto' && v !== 'full-access') fail('permission mode')
  return v
}

export function asSessionIdList(v: unknown, max = 200): string[] {
  if (!Array.isArray(v) || v.length > max) fail('session id list')
  return v.map((id) => asSessionId(id))
}

export function asCreateSessionOptions(v: unknown): CreateSessionOptions {
  if (!isObj(v)) fail('create-session options')
  return {
    agent: asAgentKind(v.agent),
    cwd: asOptionalString(v.cwd, 'cwd', 4096),
    sessionProjectId: asOptionalString(v.sessionProjectId, 'project id', 200),
    workspaceId: asOptionalString(v.workspaceId, 'workspace id', 200),
    title: asOptionalString(v.title, 'title', 400),
    initialPrompt: asOptionalString(v.initialPrompt, 'prompt'),
    parentId: v.parentId === undefined || v.parentId === null ? undefined : asSessionId(v.parentId),
    forkKind:
      v.forkKind === 'root' ||
      v.forkKind === 'child' ||
      v.forkKind === 'sibling' ||
      v.forkKind === 'handoff'
        ? v.forkKind
        : undefined,
    // Extra argv is spawned, not shelled out, but a caller that can inject
    // unbounded flags into an agent launch is still worth bounding.
    extraArgs: Array.isArray(v.extraArgs)
      ? v.extraArgs.slice(0, 32).map((a) => asString(a, 'launch argument', 4096))
      : undefined,
    permissionMode: asPermissionMode(v.permissionMode),
    model: asOptionalString(v.model, 'model', 200) ?? null,
    effort: asOptionalString(v.effort, 'effort', 60) ?? null
  }
}

export function asForkOptions(v: unknown): ForkOptions {
  if (!isObj(v)) fail('fork options')
  if (v.kind !== 'child' && v.kind !== 'sibling') fail('fork kind')
  return {
    sourceId: asSessionId(v.sourceId),
    kind: v.kind,
    targetAgent: v.targetAgent === undefined || v.targetAgent === null
      ? undefined
      : asAgentKind(v.targetAgent),
    initialPrompt: asOptionalString(v.initialPrompt, 'prompt')
  }
}

export function asHandoffOptions(v: unknown): HandoffOptions {
  if (!isObj(v)) fail('handoff options')
  return {
    sourceId: asSessionId(v.sourceId),
    targetAgent: asAgentKind(v.targetAgent),
    instruction: asOptionalString(v.instruction, 'instruction')
  }
}

/**
 * A request to prepare workspaces for a launch.
 *
 * `count` is bounded low on purpose: this is "how many agents am I starting",
 * and each one above the first costs a full checkout on disk. A renderer bug
 * asking for a thousand worktrees should fail the check, not fill the volume.
 */
export function asWorkspaceRequest(v: unknown): {
  req: { cwd: string; title?: string; mode: WorkspaceMode }
  count: number
} {
  if (!isObj(v)) fail('workspace request')
  const mode = v.mode
  if (mode !== 'current' && mode !== 'shared' && mode !== 'isolated') fail('workspace mode')
  return {
    req: {
      cwd: asString(v.cwd, 'folder', 4096),
      title: asOptionalString(v.title, 'title', 400),
      mode
    },
    count: asInt(v.count ?? 1, 'agent count', 1, 8)
  }
}

/**
 * Files the user pasted or dropped onto a pane.
 *
 * `path` is trusted only as far as the sender is: the renderer got it from
 * Electron's own `webUtils.getPathForFile`, and the main process still stats it
 * before handing it to an agent. `dataBase64` is bounded here rather than in
 * the store, because the cheapest place to refuse 400 MB of base64 is before it
 * has been decoded.
 */
export function asDroppedFiles(v: unknown, max = 20): DroppedFile[] {
  if (!Array.isArray(v) || v.length > max) fail('attachment list')
  return v.map((raw) => {
    if (!isObj(raw)) fail('attachment')
    const out: DroppedFile = {}
    if (raw.path !== undefined && raw.path !== null && raw.path !== '') {
      out.path = asString(raw.path, 'attachment path', 4096)
    }
    if (raw.name !== undefined && raw.name !== null) {
      out.name = asString(raw.name, 'attachment name', 400)
    }
    if (raw.dataBase64 !== undefined && raw.dataBase64 !== null && raw.dataBase64 !== '') {
      // 25 MB of bytes is roughly 34 MB of base64; the slack covers padding.
      out.dataBase64 = asString(raw.dataBase64, 'attachment data', 36_000_000)
    }
    if (out.path === undefined && out.dataBase64 === undefined) fail('attachment: no file behind it')
    return out
  })
}

export function asVisiblePanes(v: unknown): VisiblePanes {
  if (!isObj(v)) fail('visible panes')
  return {
    sessionIds: asSessionIdList(v.sessionIds),
    focusedSessionId:
      v.focusedSessionId === null || v.focusedSessionId === undefined
        ? null
        : asSessionId(v.focusedSessionId)
  }
}

/** The bridge validates shape here; the bus authenticates the session credential. */
export function asBusCall(v: unknown): {
  credential: string
  callerId: string
  tool: string
  args: Record<string, unknown>
} {
  if (!isObj(v)) fail('bus call')
  return {
    credential: typeof v.credential === 'string' ? asString(v.credential, 'bus credential', 128) : '',
    callerId: asSessionId(v.callerId),
    tool: asString(v.tool, 'bus tool name', 64),
    args: isObj(v.args) ? v.args : {}
  }
}

/**
 * A diff request from the panel.
 *
 * `sessionId` is what makes this safe to serve: there is no directory in the
 * payload, so the renderer cannot ask for git to be run anywhere the user has
 * not already got a session running. The path, when present, is checked again
 * in `review.ts` for being repository-relative.
 */
export function asDiffQuery(v: unknown): DiffQuery {
  if (!isObj(v)) fail('diff request')
  const side = v.side
  if (side !== 'worktree' && side !== 'staged' && side !== 'branch') fail('diff side')
  return {
    sessionId: asSessionId(v.sessionId),
    side,
    file: v.file == null ? null : asString(v.file, 'file path', 4096),
    base: v.base == null ? null : asString(v.base, 'branch name', 300),
    untracked: v.untracked === true
  }
}

/** A stage/unstage payload: one session and up to 500 repository-relative paths. */
/**
 * A folder inside the session's own tree.
 *
 * Only the *shape* is checked here — that it is a string of a sane length. The
 * question of whether it stays inside the session's folder is answered against
 * a real filesystem in `files.resolveInside`, because `..` and a symlink are
 * not the same kind of lie and only one of them is visible in the text.
 */
export function asFolderRequest(v: unknown): { sessionId: string; rel: string } {
  if (!isObj(v)) fail('folder request')
  return {
    sessionId: asSessionId(v.sessionId),
    rel: v.rel == null ? '' : asString(v.rel, 'folder', 4096)
  }
}

/** Search is literal text, never a pattern, so the length cap is the whole check. */
export function asSearchRequest(v: unknown): {
  sessionId: string
  query: string
  caseSensitive: boolean
} {
  if (!isObj(v)) fail('search request')
  return {
    sessionId: asSessionId(v.sessionId),
    query: asString(v.query, 'search text', 200),
    caseSensitive: v.caseSensitive === true
  }
}

export function asPathBatch(v: unknown): { sessionId: string; paths: string[] } {
  if (!isObj(v)) fail('file list')
  if (!Array.isArray(v.paths)) fail('file list')
  if (v.paths.length > 500) throw new Error('Too many files in one operation')
  return {
    sessionId: asSessionId(v.sessionId),
    paths: v.paths.map((p) => asString(p, 'file path', 4096))
  }
}

export function asBusAccess(v: unknown): BusAccess {
  if (v !== 'off' && v !== 'read' && v !== 'full' && v !== 'manager' && v !== 'app-manager') fail('bus access level')
  return v
}

const PREF_KEYS: Record<keyof Prefs, 'boolean' | 'number' | 'string' | 'other'> = {
  sidebarPinned: 'boolean',
  sidebarVisible: 'boolean',
  sidebarWidth: 'number',
  previewVisible: 'boolean',
  previewWidth: 'number',
  previewFollowFile: 'boolean',
  previewAutoShow: 'boolean',
  fontFamily: 'string',
  fontSize: 'number',
  lineHeight: 'number',
  cursorBlink: 'boolean',
  copyOnSelect: 'boolean',
  clickToMoveCursor: 'other',
  scrollback: 'number',
  terminalAccessibility: 'boolean',
  defaultCwd: 'string',
  broadcastInput: 'boolean',
  globalHotkey: 'string',
  hotkeyWindowEnabled: 'boolean',
  notifyOnWaiting: 'boolean',
  notifyOnDone: 'boolean',
  notifySound: 'boolean',
  notifyOnlyWhenUnfocused: 'boolean',
  busEnabled: 'boolean',
  sessionLogging: 'boolean',
  sessionLogMaxMb: 'number',
  defaultPermissionMode: 'other',
  customAgents: 'other',
  triggers: 'other',
  knownTriggerIds: 'other'
}

/**
 * Preference keys the main process owns outright.
 *
 * `knownTriggerIds` records which shipped rules this install has been offered,
 * so that a rule the user deleted stays deleted. A renderer that could write it
 * could resurrect deleted rules or suppress new ones, and it is bookkeeping no
 * UI has any reason to set.
 */
const MAIN_OWNED_PREFS = new Set<keyof Prefs>(['knownTriggerIds'])

const NUMBER_RANGE: Partial<Record<keyof Prefs, [number, number]>> = {
  sidebarWidth: [160, 900],
  previewWidth: [260, 1600],
  fontSize: [6, 48],
  scrollback: [1000, 1_000_000],
  sessionLogMaxMb: [1, 2048]
}

/** Accepts a partial prefs patch, dropping unknown keys instead of storing them. */
export function asPrefsPatch(v: unknown): Partial<Prefs> {
  if (!isObj(v)) fail('preferences')
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(v)) {
    const kind = PREF_KEYS[key as keyof Prefs]
    if (!kind) continue // unknown key — silently ignored, never persisted
    if (MAIN_OWNED_PREFS.has(key as keyof Prefs)) continue
    if (kind === 'boolean') out[key] = asBool(value, key)
    else if (kind === 'number') {
      const range = NUMBER_RANGE[key as keyof Prefs]
      out[key] =
        key === 'lineHeight'
          ? Math.min(3, Math.max(0.8, Number(value) || 1.35))
          : asInt(value, key, range?.[0] ?? 0, range?.[1] ?? Number.MAX_SAFE_INTEGER)
    } else if (kind === 'string') out[key] = asString(value, key, 4096)
    else if (key === 'clickToMoveCursor') {
      if (value !== 'off' && value !== 'click' && value !== 'alt') fail('click-to-move mode')
      out[key] = value
    } else if (key === 'defaultPermissionMode') out[key] = asPermissionMode(value)
    else if (key === 'customAgents') out[key] = asCustomAgents(value)
    else if (key === 'triggers') out[key] = asTriggers(value)
  }
  return out as Partial<Prefs>
}

/**
 * User-defined agent profiles.
 *
 * The id is derived from the label rather than accepted from the renderer: it
 * ends up in tmux session names and on every persisted session, so it has to be
 * a slug, and letting a form supply one is a way to get a colliding or empty
 * key. A profile that would shadow a built-in is dropped — the built-in owns a
 * hook bridge and a transcript parser that the override would silently disable.
 *
 * `command` is not checked for existence here. Whether `gemini` is installed is
 * a fact about the machine at launch time, not about this payload, and a
 * profile for a CLI the user is about to install should save fine.
 */
function asCustomAgents(v: unknown): CustomAgent[] {
  if (!Array.isArray(v) || v.length > 32) fail('custom agents')
  const seen = new Set<string>(BUILTIN_IDS)
  const out: CustomAgent[] = []
  for (const raw of v) {
    if (!isObj(raw)) fail('custom agent')
    const label = asString(raw.label, 'agent name', 60).trim()
    if (!label) fail('agent name')
    const command = asString(raw.command, 'agent command', 4096).trim()
    if (!command) fail('agent command')
    // An id already assigned stays put: it is on every session this profile has
    // ever launched, so renaming the label must not orphan them.
    const id = isAgentId(raw.id) ? raw.id : slugifyAgentId(label)
    if (!isAgentId(id) || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      label,
      command,
      args: Array.isArray(raw.args)
        ? raw.args.slice(0, 32).map((a) => asString(a, 'agent argument', 4096))
        : [],
      color: /^#[0-9a-fA-F]{6}$/.test(String(raw.color)) ? String(raw.color) : '#8b949e'
    })
  }
  return out
}

function asTriggers(v: unknown): Prefs['triggers'] {
  if (!Array.isArray(v) || v.length > 200) fail('triggers')
  return v.map((t) => {
    if (!isObj(t)) fail('trigger')
    const action = t.action
    if (
      action !== 'waiting' &&
      action !== 'review' &&
      action !== 'working' &&
      action !== 'failed' &&
      action !== 'notify'
    ) {
      fail('trigger action')
    }
    const pattern = asString(t.pattern, 'trigger pattern', 4000)
    const flags = asString(t.flags ?? '', 'trigger flags', 8)
    // Compile here so a bad regex is rejected at the boundary with a clear
    // message, rather than silently skipped every poll for the rest of time.
    try {
      new RegExp(pattern, flags)
    } catch (err) {
      throw new ValidationError(`Invalid trigger pattern: ${(err as Error).message}`)
    }
    return {
      id: asString(t.id, 'trigger id', 200),
      name: asString(t.name ?? t.id, 'trigger name', 200),
      pattern,
      flags,
      // Any registry key, or 'any'. A rule naming an agent the user later
      // deletes simply stops matching, which is the right outcome — it costs
      // nothing and comes back if the profile does.
      agent: t.agent === 'any' || isAgentId(t.agent) ? (t.agent as string) : 'any',
      action,
      captureReason: t.captureReason !== false,
      enabled: t.enabled !== false
    }
  })
}

export function asTabs(v: unknown): { tabs: Tab[]; activeTabId: string | null } {
  if (!isObj(v)) fail('tabs payload')
  if (!Array.isArray(v.tabs) || v.tabs.length > 200) fail('tabs')
  for (const t of v.tabs) {
    if (!isObj(t) || typeof t.id !== 'string') fail('tab')
    if (!isObj(t.layout)) fail('tab layout')
  }
  return {
    tabs: v.tabs as Tab[],
    activeTabId: v.activeTabId === null || v.activeTabId === undefined ? null : asString(v.activeTabId, 'tab id', 200)
  }
}

/**
 * Schemes we are willing to hand to the OS.
 *
 * `file:` would open arbitrary local paths, `javascript:`/`data:` can execute in
 * whatever the OS picks to handle them, and `chrome:`/`devtools:` reach into
 * Electron's own internals. An agent's output ends up rendered in this app, so
 * a link in a transcript must not be able to reach any of them.
 */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

export function isSafeExternalUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 8192) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return SAFE_SCHEMES.has(url.protocol)
}

export function asSafeExternalUrl(raw: unknown): string {
  if (!isSafeExternalUrl(raw)) {
    throw new ValidationError('Refusing to open that link: only http, https and mailto are allowed')
  }
  return raw
}

/**
 * An absolute filesystem path from the renderer.
 *
 * Only the shape is checked here — that it is a plausible absolute path with no
 * NUL byte. Whether it may actually be read is a separate question, answered by
 * `PreviewServer` against the roots the user has opened.
 */
export function asAbsolutePath(v: unknown, what = 'file path'): string {
  const s = asString(v, what, 4096)
  if (s.trim() === '' || s.includes('\0')) fail(what)
  const absolute = s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\')
  if (!absolute) fail(what)
  return s
}

/** Ceiling on one rendered preview document crossing the bridge. */
const MAX_PREVIEW_BODY = 16 * 1024 * 1024

export function asPreviewDocumentRequest(v: unknown): PreviewDocumentRequest {
  if (!isObj(v)) fail('preview document')
  const out: PreviewDocumentRequest = {
    title: asString(v.title, 'preview title', 500),
    body: asString(v.body, 'preview body', MAX_PREVIEW_BODY),
    baseHref: asString(v.baseHref, 'preview base', 8192)
  }
  if (v.bodyClass !== undefined) {
    const cls = asString(v.bodyClass, 'preview body class', 40)
    if (!/^[a-z-]*$/.test(cls)) fail('preview body class')
    out.bodyClass = cls
  }
  if (v.initialScroll !== undefined) {
    out.initialScroll = asInt(v.initialScroll, 'preview scroll', 0, 10_000_000)
  }
  return out
}
