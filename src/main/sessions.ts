/**
 * Session manager — the heart of Workbench.
 *
 * Owns the lifecycle of every agent session: creating the tmux session, attaching
 * a PTY when the UI needs pixels, deciding what colour the session is, and
 * branching conversations without losing context.
 *
 * Status is decided by a small state machine fed from three sources, in
 * descending order of trust:
 *   1. CLI hooks (authoritative — the agent tells us it is waiting or done)
 *   2. regex triggers over the pane's visible text (iTerm2-style, user editable)
 *   3. liveness polling (pane died, output went quiet)
 */

import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { agentCan, definitionOr } from '../shared/agents.js'
import type { AgentDefinition } from '../shared/agents.js'
import type {
  AgentKind,
  BusAccess,
  CreateSessionOptions,
  ForkOptions,
  HandoffOptions,
  LaunchDescriptor,
  PermissionMode,
  SendPromptResult,
  Session,
  SessionStatus,
  StatusCounts,
  StatusSource,
  TriggerRule,
  VisiblePanes
} from '../shared/types.js'
import { canTransition } from '../shared/types.js'
import { findServerUrl } from '../shared/localhost.js'
import { finalHumanRequest, hasActiveCodexDialog, isAgentRelayPrompt, isDefaultCodexDialogTrigger, isLegacyProseReason, isLegacyProseTrigger } from '../shared/attentionSignals.js'
import { createContextReader } from './context.js'
import { Tmux, TMUX_SOCKET, serverIsGone, sessionIdFromTmuxName, tmuxNameFor } from './tmux.js'
import type { TmuxPaneInfo } from './tmux.js'
import { HookBridge, type HookEvent } from './hooks.js'
import { Store } from './store.js'
import {
  buildLaunchSpec,
  findClaudeTranscript,
  findCodexRolloutBySessionId,
  findCodexRolloutForLaunch,
  lastAssistantMessage,
  loginShell,
  parseCodexSessionLog,
  transcriptToMarkdown,
  type CodexLogSignal
} from './agents.js'
import { ensureAgentTrust } from './trust.js'
import { hostHomeNative, hostSpawn, hostSpawnEnv, toHostPath, toNativePath } from './host.js'
import { Relay, type RelaySession } from './relay.js'
import type { RelayRequest, RelayResult } from '../shared/relay.js'
import { resolveMention, slugify as mentionSlug, type MentionTarget } from '../shared/mentions.js'
import { autoSessionTitle, contextSessionTitle, explicitSessionRole, purposeFromPrompt, SESSION_ROLES, sidebarSessionTitle } from '../shared/sessionTitle.js'
import { readSessionNaming } from './sessionNaming.js'

// node-pty is CJS with a native addon; require it directly so the ESM build
// never has to guess at interop.
//
// The require is deferred to first spawn rather than run at import time. The
// addon is compiled against Electron's ABI, so loading it under plain Node —
// which is how the test suite runs — throws NODE_MODULE_VERSION. Everything in
// this file except attach() works fine without it, and that is the half worth
// testing.
const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ptyModule: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pty(): any {
  if (!ptyModule) ptyModule = require('node-pty')
  return ptyModule
}

interface PtyClient {
  proc: { write(d: string): void; resize(c: number, r: number): void; kill(s?: string): void }
  cols: number
  rows: number
  /** Buffered output, flushed on a timer to keep IPC from thrashing. */
  buffer: string[]
  flushTimer: NodeJS.Timeout | null
}

/**
 * Where an agent's executable is, asked one launch at a time.
 *
 * This was a `{ claude, codex }` record resolved once at startup, which cannot
 * answer for an agent the user adds in Settings while the app is running.
 * Resolving on demand costs a short PATH scan per session creation and needs no
 * cache to invalidate.
 *
 * Returning null means "not installed", and the caller turns that into a
 * message naming the command that was looked for.
 */
export type BinaryResolver = (definition: AgentDefinition) => string | null

export interface NotifyRequest {
  sessionId: string
  title: string
  body: string
  status: SessionStatus
}

const SETTLE_MS = 1200
const POLL_MS = 2000
/**
 * How long one recipient of a broadcast may take before it is written off.
 *
 * A fan-out is a sequential loop, so an `execFile` that never settles — a tmux
 * server that has stopped answering, a pane wedged in copy-mode — does not just
 * lose that one recipient, it hangs every recipient after it *and* the promise
 * the composer is awaiting. The prompt bar then sits on "Sending…" forever with
 * nothing to retry, which is exactly the failure this bounds. Five seconds is
 * three orders of magnitude past the ~5 ms a healthy `send-keys` costs.
 */
const SEND_TIMEOUT_MS = 5000
/** How long a running session may be silent before we test it against triggers. */
const QUIET_BEFORE_TRIGGER_MS = 1500

/** Bumped when `LaunchDescriptor`'s shape changes; older ones are discarded. */
export const LAUNCH_DESCRIPTOR_VERSION = 1

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>()
  private clients = new Map<string, PtyClient>()
  /**
   * Everything needed to relaunch a session exactly as it started. Persisted, so
   * a restart after an app quit resumes the real conversation instead of quietly
   * starting a fresh one.
   */
  private descriptors = new Map<string, LaunchDescriptor>()
  private transcriptPaths = new Map<string, string>()
  private contextReader = createContextReader()
  /**
   * Where each model was last seen to run out of room.
   *
   * Claude's transcript only names its ceiling in a `compact_boundary`, which
   * is written when a session compacts — so a fresh session cannot know its own
   * limit, but a sibling on the same model that has already compacted does. The
   * threshold is a property of the CLI and the model, not of one conversation,
   * so it is safe to share and not safe to persist: a CLI upgrade would leave a
   * stale number on disk, and a stale ceiling is worse than an absent one.
   */
  private contextCeilings = new Map<string, number>()
  private pollTimer: NodeJS.Timeout | null = null
  private createdAtByTmux = new Map<string, number>()
  /** Byte offset already consumed from each session's Codex lifecycle log. */
  private codexLogOffsets = new Map<string, number>()
  /** Invalidates an asynchronous completion if a newer turn starts first. */
  private codexTurnGeneration = new Map<string, number>()
  /**
   * The prompt text of the Codex turn we last saw start, per session.
   *
   * Codex runs turns of its own alongside yours — naming the thread, writing a
   * recap — and every one of them fires the same `agent-turn-complete` notify
   * on the same hook. A thread title takes about five seconds, so without this
   * a Codex session goes green five seconds into a turn that has minutes left,
   * which is exactly what "codex says ready for review while it is still
   * working" looks like. The prompt is the one field that tells them apart:
   * a real turn's notify ends with the text we watched go in.
   */
  private codexTurnText = new Map<string, string>()
  /** Acknowledging heuristic evidence lasts until that evidence actually changes.
   * Output timestamps alone cannot re-arm the same old question in scrollback. */
  private triggerTails = new Map<string, string>()
  private dismissedTriggerTails = new Map<string, string | null>()
  /** Sessions the renderer reports as on-screen, and which one has focus. */
  private visible: VisiblePanes = { sessionIds: [], focusedSessionId: null }
  /**
   * When each session last started working. The preview pane uses it to ask
   * "did this turn produce a document?", which is only answerable relative to
   * when the turn began.
   */
  private turnStartedAt = new Map<string, number>()

  /** Cross-session prompt delivery, including the blocking hand-off. */
  readonly relay: Relay

  private tmux: Tmux
  private hooks: HookBridge
  private store: Store
  private resolveBin: BinaryResolver
  private dataDir: string
  private loginPath: string
  /**
   * Where the CLIs keep their per-directory trust records. Injected rather than
   * read from the host at the call site so tests seed a temp home instead of the
   * developer's real `~/.claude.json` and `~/.codex/config.toml`.
   *
   * Native spelling: we are the ones who read and rewrite those two files. It is
   * the *home* the CLIs run in, though, so on Windows it is the distro's home
   * reached over UNC and not `C:\Users\…`.
   */
  private homeDir: string
  /**
   * Session Bus delivery for new launches, consulted at each launch rather than
   * captured once: the master switch is a preference the user can flip, and a
   * session started right after flipping it must get the tools without waiting
   * for an app restart. Returns null while the bus is off.
   */
  busEnvFor: (sessionId: string) => Record<string, string> = () => ({})
  busMcp: () => { claudeMcpConfig: string; codexArgs: string[] } | null = () => null

  constructor(
    tmux: Tmux,
    hooks: HookBridge,
    store: Store,
    resolveBin: BinaryResolver,
    dataDir: string,
    loginPath: string,
    homeDir: string = hostHomeNative()
  ) {
    super()
    this.tmux = tmux
    this.hooks = hooks
    this.store = store
    this.resolveBin = resolveBin
    this.dataDir = dataDir
    this.loginPath = loginPath
    this.homeDir = homeDir
    this.relay = new Relay({
      send: (id, text) => this.sendPrompt(id, text),
      lookup: (id) => this.relaySessionFor(id),
      readReply: (id) => this.readLastReply(id)
    })
    this.hooks.on('hook', (evt: HookEvent) => this.applyHookEvent(evt))
    this.hooks.on('relay', (msg, reply) => void this.handleRelayRequest(msg, reply))
    this.hooks.on('sessions-query', (msg, reply) => reply(this.describeSessionsFor(msg.termSessionId)))
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.tmux.writeConfig(this.store.prefs.scrollback)
    await this.tmux.ensureServer()
    this.hooks.writeClaudeSettings()
    await this.restore()
    let ticks = 0
    this.pollTimer = setInterval(() => {
      void this.poll()
      // Log size only needs checking occasionally; every 2s would be wasteful.
      if (++ticks % 30 === 0) this.rotateLogs()
    }, POLL_MS)
  }

  /**
   * Ordered shutdown: stop producing state changes, detach every PTY, then
   * flush. Returns false if the final write failed, so the caller can tell the
   * user their layout was not saved instead of quitting as though it were.
   */
  async shutdown(): Promise<boolean> {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    // Detach every client but leave the tmux sessions running — that is the
    // whole promise of the tmux backend.
    for (const id of Array.from(this.clients.keys())) this.detach(id)
    this.persist()
    return this.store.saveNow()
  }

  /**
   * Keeps `pipe-pane` logs from growing without bound. One rotation is kept, so
   * a long-running session cannot quietly eat the disk while still leaving
   * recent output available.
   */
  rotateLogs(): void {
    const maxBytes = Math.max(1, this.store.prefs.sessionLogMaxMb) * 1024 * 1024
    for (const s of this.sessions.values()) {
      const file = this.logPathFor(s.id)
      if (safeFileSize(file) <= maxBytes) continue
      try {
        fs.renameSync(file, `${file}.1`)
      } catch {
        /* the pane will recreate it on the next write */
      }
    }
  }

  /** User-facing "delete my logs" — logging can also be turned off in Settings. */
  deleteLogs(): number {
    let removed = 0
    for (const s of this.sessions.values()) {
      for (const f of [this.logPathFor(s.id), `${this.logPathFor(s.id)}.1`]) {
        try {
          if (fs.existsSync(f)) {
            fs.rmSync(f, { force: true })
            removed++
          }
        } catch {
          /* skip */
        }
      }
    }
    return removed
  }

  /** Reconciles persisted sessions with what tmux actually still has running. */
  private async restore(): Promise<void> {
    for (const d of this.store.descriptors) {
      if (d.version === LAUNCH_DESCRIPTOR_VERSION) this.descriptors.set(d.sessionId, d)
    }

    const live = new Set(await this.tmux.listSessionNames())
    for (const s of this.store.sessions) {
      const alive = live.has(s.tmuxName)
      this.sessions.set(s.id, {
        ...s,
        alive,
        // A session we cannot see any more is finished, not still working.
        status: alive ? s.status : 'exited'
      })
      // Older builds persisted tiny regex fragments such as "Please confirm"
      // after seeing ordinary coordination text. Retire only that known
      // heuristic evidence; a hook-reported approval or a custom rule with
      // the same text remains outstanding. This is neutral, never completion.
      if (alive && s.agent === 'codex' && s.status === 'waiting' && s.statusSource === 'trigger' &&
          isLegacyProseReason(s.statusReason) &&
          !this.matchTriggers(s.statusReason ?? '', s.agent).some((hit) => hit.rule.action === 'waiting' && !isLegacyProseTrigger(hit.rule))) {
        const restored = this.sessions.get(s.id)!
        restored.status = 'idle'
        restored.statusSource = 'system'
        restored.statusReason = null
        restored.lastStatusChangeAt = Date.now()
        this.dismissedTriggerTails.set(s.id, null)
      }
      // A turn that was in flight when we quit still has a boundary worth
      // keeping. `turnStartedAt` lives only in memory, so without this the
      // first turn to end after a relaunch reports no start and the preview
      // pane silently skips a document that turn really did produce.
      if (alive && s.status === 'working') {
        this.turnStartedAt.set(s.id, s.lastStatusChangeAt)
      }
      const d = this.descriptors.get(s.id)
      if (d) {
        this.createdAtByTmux.set(s.tmuxName, d.createdAt)
        if (d.transcriptPath) this.transcriptPaths.set(s.id, d.transcriptPath)
        // Codex rewrites its lifecycle log per process, and the pre-restart tail
        // is already reflected in the persisted status; resume from the end.
        if (d.lifecycleLogPath) {
          this.codexLogOffsets.set(s.id, safeFileSize(d.lifecycleLogPath))
        }
      }
      if (alive) live.delete(s.tmuxName)
    }

    // Adopt tmux sessions we created in a past life but lost track of.
    for (const name of live) {
      const id = sessionIdFromTmuxName(name)
      if (id === null) continue
      const info = await this.tmux.paneInfo(name)
      if (this.sessions.has(id)) continue
      // A descriptor knows what this session really is. Only a genuinely unknown
      // pane falls back to `shell` — misclassifying a live Claude session as a
      // shell strips its hooks, its transcript and its fork lineage.
      const d = this.descriptors.get(id)
      const agent: AgentKind = d?.profileId ?? 'shell'
      const adopted = info?.currentPath ? toNativePath(info.currentPath) : ''
      const cwd = d?.cwd || adopted || hostHomeNative()
      this.sessions.set(id, {
        ...this.blankSession(id, agent, cwd),
        tmuxName: name,
        agentSessionId: d?.agentSessionId ?? null,
        alive: true,
        status: 'idle',
        statusSource: 'system'
      })
      if (d) this.createdAtByTmux.set(name, d.createdAt)
    }
    // Titles from older builds were either prompt fragments or arbitrary
    // labels and had all become "manual". Upgrade them once without touching
    // session IDs, tmux identities, project membership or live status. Only a
    // recorded transcript (or an exact conversation ID) supplies history.
    for (const session of this.sessions.values()) {
      if (session.titleVersion === 1 && SESSION_ROLES.includes(session.title)) continue
      const legacy = sidebarSessionTitle(session, this.definition(session.agent).label)
      const file = this.transcriptPaths.get(session.id) ?? (session.agentSessionId
        ? this.definition(session.agent).launch === 'claude' ? findClaudeTranscript(session.agentSessionId, this.homeDir)
          : this.definition(session.agent).launch === 'codex' ? findCodexRolloutBySessionId(session.agentSessionId, this.homeDir) : null : null)
      const history = file ? readSessionNaming(file) : null
      const hint = /^(?:new session|session\b|recovered\b)/i.test(legacy) ? '' : legacy
      const savedTask = session.lastTask
      const prompt = autoSessionTitle(history?.firstPrompt ?? '') ? history!.firstPrompt! : history?.lastPrompt ?? history?.firstPrompt ?? ''
      this.nameFromContext(session, prompt, hint)
      session.lastTask = purposeFromPrompt(history?.lastReply ?? history?.lastPrompt ?? savedTask ?? (autoSessionTitle(hint) && !explicitSessionRole(hint) ? hint : ''), 140, 20)
    }
    this.persist()
    this.emitChange()
  }

  // ── creation ─────────────────────────────────────────────────────────────

  private blankSession(id: string, agent: AgentKind, cwd: string): Session {
    const now = Date.now()
    return {
      id,
      title: contextSessionTitle(agent, '', cwd),
      titleMode: 'auto',
      titleVersion: 1,
      titleSource: 'context',
      lastTask: null,
      agent,
      cwd,
      status: 'idle',
      serverUrl: null,
      context: null,
      tmuxName: tmuxNameFor(id),
      createdAt: now,
      lastActivityAt: now,
      lastPromptAt: null,
      lastStatusChangeAt: now,
      lastEventAt: null,
      lastSeenAt: null,
      statusSource: 'system',
      statusReason: null,
      parentId: null,
      rootId: id,
      forkKind: 'root',
      depth: 0,
      agentSessionId: null,
      lastMessage: null,
      // Bus access is granted per session, by the user, after the fact.
      bus: 'off',
      model: null,
      effort: null,
      permissionMode: this.store.prefs.defaultPermissionMode,
      alive: false,
      exitCode: null,
      pinned: false,
      color: this.definition(agent).color,
      badge: null,
      workspaceId: null,
      sessionProjectId: null
    }
  }

  /**
   * The registry row for an agent id, including the user's own profiles.
   *
   * Read through `store.prefs` on every call rather than cached, so an agent
   * added or edited in Settings is usable in the next session without a
   * restart. `definitionOr` never returns null: a session whose profile the
   * user has since deleted keeps rendering, with no capabilities.
   */
  private definition(agent: AgentKind): AgentDefinition {
    return definitionOr(agent, this.store.prefs.customAgents)
  }

  private can(agent: AgentKind, cap: Parameters<typeof agentCan>[1]): boolean {
    return agentCan(agent, cap, this.store.prefs.customAgents)
  }

  private newId(): string {
    return crypto.randomBytes(5).toString('hex')
  }

  async create(opts: CreateSessionOptions): Promise<Session> {
    const agent = opts.agent
    const def = this.definition(agent)
    if (!this.resolveBin(def)) {
      throw new Error(
        `${def.label} was not found on PATH${def.bin ? ` (looked for \`${def.bin}\`)` : ''}. Install it, then reopen Workbench.`
      )
    }

    const cwd = this.resolveCwd(opts.cwd)
    const id = this.newId()
    const session = this.blankSession(id, agent, cwd)
    // Recorded, not resolved: the caller already turned a workspace into the
    // `cwd` above. Keeping the id lets the UI say which worktree this session
    // is in, and lets cleanup know a workspace is still occupied.
    session.workspaceId = opts.workspaceId ?? null
    session.sessionProjectId = opts.sessionProjectId ?? null
    this.nameFromContext(session, opts.initialPrompt ?? '', opts.title ?? '')

    if (opts.parentId) {
      const parent = this.sessions.get(opts.parentId)
      if (parent) {
        session.parentId = opts.forkKind === 'sibling' ? parent.parentId : parent.id
        session.rootId = parent.rootId
        session.forkKind = opts.forkKind ?? 'child'
        session.depth = opts.forkKind === 'sibling' ? parent.depth : parent.depth + 1
      }
    }

    await this.spawnInTmux(session, {
      resumeFrom: opts.resumeAgentSessionId ?? null,
      forkFromParent: false,
      extraArgs: opts.extraArgs ?? [],
      origin: 'new',
      permissionMode: opts.permissionMode ?? this.store.prefs.defaultPermissionMode,
      model: opts.model ?? null,
      effort: opts.effort ?? null
    })

    this.sessions.set(id, session)
    this.persist()
    this.emitChange()

    if (opts.initialPrompt) void this.sendWhenReady(id, opts.initialPrompt)
    return session
  }

  private resolveCwd(cwd?: string): string {
    const candidate = cwd || this.store.prefs.defaultCwd || hostHomeNative()
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch {
      /* fall through */
    }
    return hostHomeNative()
  }

  /** Builds the argv and starts the detached tmux session behind a Session. */
  private async spawnInTmux(
    session: Session,
    opts: {
      resumeFrom: string | null
      forkFromParent: boolean
      extraArgs: string[]
      origin: LaunchDescriptor['origin']
      permissionMode: PermissionMode
      model?: string | null
      effort?: string | null
    }
  ): Promise<void> {
    const definition = this.definition(session.agent)
    const bin = this.resolveBin(definition) ?? definition.bin
    const createdAt = Date.now()
    // A fresh log file per launch is what makes two concurrent Codex sessions
    // distinguishable: the path is known only to the process we started.
    const codexSessionLogPath =
      definition.launch === 'codex' ? this.codexLogPathFor(session.id, createdAt) : null
    if (codexSessionLogPath) fs.mkdirSync(path.dirname(codexSessionLogPath), { recursive: true })

    const spec = buildLaunchSpec({
      definition,
      bin,
      cwd: session.cwd,
      claudeSettingsPath: this.hooks.paths.claudeSettings,
      codexNotifyShim: this.hooks.paths.codexShim,
      codexSessionLogPath,
      resumeFrom: opts.resumeFrom,
      forkFromParent: opts.forkFromParent,
      newSessionId: crypto.randomUUID(),
      permissionMode: opts.permissionMode,
      model: opts.model ?? null,
      effort: opts.effort ?? null,
      busMcp: this.busMcp()
    })
    const command = [...spec.command, ...opts.extraArgs]
    if (spec.assignedSessionId) session.agentSessionId = spec.assignedSessionId

    const env: Record<string, string> = {
      ...this.hooks.envFor(session.id),
      ...this.busEnvFor(session.id),
      ...spec.env,
      // The generated scripts directory leads, so `workbench` — list, send and
      // show — resolves inside an agent session without the agent knowing
      // where the app keeps it. Both halves are host spellings and the
      // separator is the host's: this string is only ever read by the host.
      PATH: `${toHostPath(this.hooks.paths.binDir)}:${this.loginPath}`,
      TERMINAL_APP: 'terminal',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }

    // Both CLIs block the first launch in a directory on a trust dialog, and we
    // launch into a fresh worktree almost every time. Seed the trust record so
    // the agent starts straight away instead of stalling on the dialog — or, for
    // Claude, being killed by the Enter our prompt automation sends to it.
    if (definition.launch === 'claude' || definition.launch === 'codex') {
      try {
        ensureAgentTrust(definition.launch, this.homeDir, session.cwd)
      } catch (err) {
        // Best-effort: if we cannot write the record the CLI falls back to its
        // own dialog. Launching anyway beats refusing a session over it.
        console.error('[terminal] could not seed trust for', session.cwd, err)
      }
    }

    await this.tmux.createSession({
      name: session.tmuxName,
      cwd: session.cwd,
      command,
      env,
      cols: 120,
      rows: 34
    })

    this.descriptors.set(session.id, {
      version: LAUNCH_DESCRIPTOR_VERSION,
      sessionId: session.id,
      profileId: session.agent,
      command: bin || loginShell(),
      baseArgs: spec.baseArgs,
      launchArgs: spec.launchArgs,
      extraArgs: opts.extraArgs,
      env: spec.env,
      cwd: session.cwd,
      workspaceId: session.workspaceId,
      agentSessionId: session.agentSessionId,
      origin: opts.origin,
      model: opts.model ?? null,
      effort: opts.effort ?? null,
      permissionMode: opts.permissionMode,
      transcriptPath: null,
      lifecycleLogPath: spec.lifecycleLogPath,
      cliVersion: this.cliVersions[session.agent] ?? null,
      createdAt
    })
    this.codexLogOffsets.set(session.id, 0)
    this.createdAtByTmux.set(session.tmuxName, createdAt)
    session.alive = true
    session.status = 'idle'
    session.statusSource = 'system'
    session.statusReason = null
    session.lastMessage = null

    if (this.store.prefs.sessionLogging) {
      await this.tmux.startPipePane(session.tmuxName, this.logPathFor(session.id))
    }
  }

  /** CLI versions observed at startup, recorded into each descriptor. */
  cliVersions: Partial<Record<AgentKind, string | null>> = {}

  logPathFor(id: string): string {
    return path.join(this.dataDir, 'logs', `${id}.log`)
  }

  private codexLogPathFor(id: string, stamp: number): string {
    return path.join(this.dataDir, 'codex-logs', `${id}-${stamp}.jsonl`)
  }

  /** The persisted launch record for a session, if we still have one. */
  descriptorFor(sessionId: string): LaunchDescriptor | undefined {
    return this.descriptors.get(sessionId)
  }

  // ── forking & handoff ────────────────────────────────────────────────────

  /**
   * Branches a conversation. When the target agent matches the source and we know
   * the CLI's own session id, this is a *real* fork through the CLI's resume
   * machinery, so the child genuinely inherits the parent's context. Otherwise we
   * fall back to a transcript handoff.
   */
  async fork(opts: ForkOptions): Promise<Session> {
    const src = this.sessions.get(opts.sourceId)
    if (!src) throw new Error('Source session no longer exists')

    const targetAgent = opts.targetAgent ?? src.agent
    const sameAgent = targetAgent === src.agent
    // An agent that does not declare `fork` never gets a fork flag invented for
    // it; the handoff path below carries the transcript across instead, which
    // works for anything that can be typed into.
    const canNativeFork =
      sameAgent &&
      this.can(targetAgent, 'fork') &&
      this.conversationExists(src.agent, src.agentSessionId)

    if (!canNativeFork) {
      return this.handoff({
        sourceId: opts.sourceId,
        targetAgent,
        instruction: opts.initialPrompt
      })
    }

    const id = this.newId()
    const session = this.blankSession(id, targetAgent, src.cwd)
    // A fork continues the same work, so it belongs in the same working copy.
    session.workspaceId = src.workspaceId
    session.sessionProjectId = src.sessionProjectId
    session.parentId = opts.kind === 'sibling' ? src.parentId : src.id
    session.rootId = src.rootId
    session.forkKind = opts.kind
    session.depth = opts.kind === 'sibling' ? src.depth : src.depth + 1
    this.nameFromContext(session, opts.initialPrompt ?? '', autoSessionTitle(opts.initialPrompt ?? '') ? '' : src.title)
    session.lastTask ??= src.lastTask ?? null
    session.badge = opts.kind === 'sibling' ? '∥' : '↳'

    const srcDescriptor = this.descriptors.get(src.id)
    await this.spawnInTmux(session, {
      resumeFrom: src.agentSessionId,
      forkFromParent: true,
      extraArgs: [],
      origin: 'forked',
      // A fork inherits how much the parent was trusted to do, not the global
      // default — silently downgrading a full-access branch would surprise you.
      permissionMode: srcDescriptor?.permissionMode ?? this.store.prefs.defaultPermissionMode,
      model: srcDescriptor?.model ?? null,
      effort: srcDescriptor?.effort ?? null
    })

    this.sessions.set(id, session)
    this.persist()
    this.emitChange()

    if (opts.initialPrompt) void this.sendWhenReady(id, opts.initialPrompt)
    return session
  }

  /**
   * Cross-agent transfer: export the source conversation to markdown and start a
   * fresh session of the other CLI pointed at that file. This is how a Claude
   * session hands work to Codex (or back) without you copy-pasting.
   */
  async handoff(opts: HandoffOptions): Promise<Session> {
    const src = this.sessions.get(opts.sourceId)
    if (!src) throw new Error('Source session no longer exists')

    const file = await this.exportTranscript(opts.sourceId)
    const id = this.newId()
    const session = this.blankSession(id, opts.targetAgent, src.cwd)
    session.workspaceId = src.workspaceId
    session.sessionProjectId = src.sessionProjectId
    session.parentId = src.id
    session.rootId = src.rootId
    session.forkKind = 'handoff'
    session.depth = src.depth + 1
    this.nameFromContext(session, opts.instruction ?? '', autoSessionTitle(opts.instruction ?? '') ? '' : src.title)
    session.lastTask ??= src.lastTask ?? null
    session.badge = '⇄'

    await this.spawnInTmux(session, {
      resumeFrom: null,
      forkFromParent: false,
      extraArgs: [],
      origin: 'new',
      permissionMode:
        this.descriptors.get(src.id)?.permissionMode ?? this.store.prefs.defaultPermissionMode
    })

    this.sessions.set(id, session)
    this.persist()
    this.emitChange()

    const instruction =
      opts.instruction?.trim() ||
      'Pick up where that session left off. Start by summarising the current state in two lines, then continue.'
    const prompt = `I am handing you an in-progress session from ${this.definition(src.agent).label}. The full transcript is at ${file} — read it first. ${instruction}`
    void this.sendWhenReady(id, prompt)
    return session
  }

  /**
   * Writes a markdown transcript for a session. Prefers the CLI's own JSONL
   * (clean turn structure) and falls back to scraped pane text.
   */
  async exportTranscript(sessionId: string): Promise<string> {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('Unknown session')

    const outDir = path.join(this.dataDir, 'handoffs')
    fs.mkdirSync(outDir, { recursive: true })
    const outFile = path.join(outDir, `${s.id}-${Date.now()}.md`)

    let body = ''
    const jsonl = this.transcriptPaths.get(s.id) ?? this.locateTranscript(s)
    if (jsonl) body = transcriptToMarkdown(jsonl)

    if (!body.trim()) {
      const scraped = await this.tmux.capturePane(s.tmuxName, 4000)
      body = `\`\`\`\n${stripAnsi(scraped).trim()}\n\`\`\``
    }

    const header = [
      `# Session transcript — ${s.title}`,
      '',
      `- agent: **${s.agent}**`,
      `- working directory: \`${s.cwd}\``,
      `- started: ${new Date(s.createdAt).toISOString()}`,
      `- exported: ${new Date().toISOString()}`,
      '',
      '---',
      ''
    ].join('\n')

    fs.writeFileSync(outFile, header + body, 'utf8')
    return outFile
  }

  /**
   * Whether the CLI conversation for an assigned session id actually exists on
   * disk. A session that died at the trust dialog (or any pre-first-turn crash)
   * was handed a `--session-id` but never wrote a transcript, so resuming it
   * makes the CLI exit with "No conversation found" — turning a restart into an
   * instant re-failure. Restart and fork check this before choosing to resume.
   */
  private conversationExists(agent: Session['agent'], sessionId: string | null): boolean {
    if (!sessionId) return false
    const launch = this.definition(agent).launch
    if (launch === 'claude') return findClaudeTranscript(sessionId, this.homeDir) !== null
    if (launch === 'codex') return findCodexRolloutBySessionId(sessionId, this.homeDir) !== null
    return false
  }

  /**
   * Binds a session to the CLI's own transcript file.
   *
   * For Codex this is deliberately conservative. The id reported by that
   * session's own notify hook gives an exact match; without one we require a
   * rollout that started inside this session's lifetime, in this session's cwd,
   * and is not already claimed by another session. "Newest file in
   * ~/.codex/sessions" is never good enough — with two Codex sessions open it
   * hands one session the other's conversation.
   */
  private locateTranscript(s: Session): string | null {
    const bind = (p: string): string => {
      this.transcriptPaths.set(s.id, p)
      const d = this.descriptors.get(s.id)
      if (d) d.transcriptPath = p
      return p
    }

    const launch = this.definition(s.agent).launch

    if (launch === 'claude' && s.agentSessionId) {
      const p = findClaudeTranscript(s.agentSessionId)
      if (p) return bind(p)
    }

    if (launch === 'codex') {
      if (s.agentSessionId) {
        const p = findCodexRolloutBySessionId(s.agentSessionId)
        if (p) return bind(p)
      }
      const since = this.createdAtByTmux.get(s.tmuxName) ?? s.createdAt
      const p = findCodexRolloutForLaunch({
        cwd: s.cwd,
        sinceMs: since - 5000,
        claimed: this.claimedTranscripts(s.id)
      })
      if (p) return bind(p)
    }
    return null
  }

  /**
   * Re-reads how full this session's context window is.
   *
   * Only for sessions whose transcript is already bound — that happens on the
   * first turn, via the CLI's own notify hook, and a session that has not taken
   * a turn has no context to report. Deliberately no `locateTranscript` call
   * here: that one globs a directory, and this runs for every session every two
   * seconds.
   */
  private refreshContext(s: Session): boolean {
    const file = this.transcriptPaths.get(s.id)
    if (!file) return false

    const usage = this.contextReader.read(this.definition(s.agent).launch, file)
    if (!usage) return false

    // A ceiling this session has observed for itself is the truth; one learned
    // from a sibling on the same model is the next best thing. Codex states its
    // window outright and so never needs either.
    const key = `${s.agent}:${s.model ?? 'default'}`
    if (usage.limit) this.contextCeilings.set(key, usage.limit)
    const limit = usage.limit ?? this.contextCeilings.get(key) ?? null

    if (s.context && s.context.tokens === usage.tokens && s.context.limit === limit) return false
    s.context = { tokens: usage.tokens, limit }
    return true
  }

  /** Files and agent ids already bound to some *other* session. */
  private claimedTranscripts(exceptSessionId: string): string[] {
    const out: string[] = []
    for (const [id, file] of this.transcriptPaths) {
      if (id !== exceptSessionId) out.push(file)
    }
    for (const s of this.sessions.values()) {
      if (s.id !== exceptSessionId && s.agentSessionId) out.push(s.agentSessionId)
    }
    return out
  }

  // ── input ────────────────────────────────────────────────────────────────

  /** Raw keystrokes from an attached terminal view. */
  write(sessionId: string, data: string): void {
    const client = this.clients.get(sessionId)
    if (client) {
      client.proc.write(data)
      return
    }
    // Not attached — still deliverable through tmux.
    void this.tmux.sendText(this.tmuxNameOf(sessionId), data)
  }

  /**
   * Submits a full prompt (text + Enter) to one session.
   *
   * Throws rather than returning quietly when the session cannot receive it —
   * a broadcast that silently drops a recipient is worse than one that fails
   * loudly, because you go on believing all three agents got the instruction.
   */
  async sendPrompt(sessionId: string, text: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('Session no longer exists')
    if (!s.alive) throw new Error('Session has exited')
    await this.tmux.submitPrompt(s.tmuxName, text)
    s.lastPromptAt = Date.now()
    s.lastMessage = null
    this.maybeAutoTitle(s, text)
    this.setStatus(s.id, 'working', { source: 'user', reason: null })
    // A follow-up can arrive while the agent is already working. Persist the
    // prompt time even when neither its status nor its settled title changes.
    this.persist()
    this.emitChange()
  }

  /**
   * The role is an identity; the latest task is a changing memory aid. A
   * project/folder guess may improve on the first real prompt, then the role
   * stays stable unless the user explicitly assigns another company role.
   * Repeated roles are intentional; mentions already use IDs for ambiguity.
   */
  private maybeAutoTitle(session: Session, prompt: string): boolean {
    const summary = purposeFromPrompt(prompt, 140, 20)
    if (!summary) return false
    const explicit = explicitSessionRole(prompt)
    const role = explicit ?? autoSessionTitle(prompt)
    if (session.agent !== 'shell' && role && (explicit || (session.titleMode === 'auto' && session.titleSource !== 'prompt'))) {
      session.title = role
      session.titleSource = 'prompt'
    }
    session.lastTask = summary
    return true
  }

  private nameFromContext(session: Session, prompt: string, hint = ''): void {
    const project = this.store.sessionProjects.find((p) => p.id === session.sessionProjectId)
    const role = explicitSessionRole(prompt) ?? explicitSessionRole(hint) ?? autoSessionTitle(prompt) ?? autoSessionTitle(hint)
    session.title = session.agent === 'shell' ? 'Terminal Operator'
      : role ?? contextSessionTitle(session.agent, project?.name, session.cwd)
    session.titleMode = 'auto'
    session.titleVersion = 1
    session.titleSource = role ? 'prompt' : 'context'
    session.lastTask = purposeFromPrompt(prompt, 140, 20)
  }

  /**
   * Records why a pane died, while the dead pane still holds its scrollback.
   *
   * Best effort by design: this runs during a poll tick and must not be able to
   * throw into it. A missing cause is a worse diagnostic, not a broken app.
   */
  private async captureDeathCause(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      const tail = stripAnsi(await this.tmux.captureTail(s.tmuxName, 40))
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.trim().length > 0)
      if (tail.length === 0) return
      const last = tail.slice(-6).join(' · ').slice(0, 300)
      s.lastMessage = last
      s.statusReason = `Exited with status ${s.exitCode}: ${last}`
      this.persist()
      this.emitChange()
    } catch {
      /* the pane is already gone; the exit code alone will have to do */
    }
  }

  // ── cross-session relay ──────────────────────────────────────────────────

  /**
   * Answers `workbench list` — the roster an agent picks a recipient from.
   *
   * Includes the caller, marked, rather than filtering it out. An agent that
   * cannot see itself in the list has no way to tell "my own name resolves to
   * me" from "my name is not registered", and the second is worth knowing.
   */
  private describeSessionsFor(callerId: string): {
    sessions: { id: string; mention: string; title: string; lastTask?: string | null; agent: string; status: string; self: boolean }[]
  } {
    const targets = this.mentionTargets()
    const rows = targets.map((s) => ({
      id: s.id,
      mention: targets.filter((t) => mentionSlug(t.title) === mentionSlug(s.title)).length > 1 ? s.id : mentionSlug(s.title) || s.id,
      title: s.title,
      lastTask: s.lastTask,
      agent: s.agent,
      status: this.sessions.get(s.id)?.alive ? (this.sessions.get(s.id)?.status ?? 'idle') : 'exited',
      self: s.id === callerId
    }))
    return { sessions: rows }
  }

  /** Answers `workbench send` from inside an agent session. */
  private async handleRelayRequest(
    msg: { termSessionId: string; body: Record<string, unknown> },
    reply: (value: unknown) => void
  ): Promise<void> {
    const body = msg.body
    const to = typeof body.to === 'string' ? body.to : ''
    const message = typeof body.message === 'string' ? body.message : ''
    const wait = body.wait === true
    const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined

    if (!this.sessions.has(msg.termSessionId)) {
      reply({ error: 'This session is not registered with Workbench.' })
      return
    }
    const resolved = this.resolveTarget(to)
    if (!resolved.id) {
      reply({ error: resolved.error })
      return
    }
    try {
      const result = await this.sendRelay({
        fromSessionId: msg.termSessionId,
        toSessionId: resolved.id,
        message,
        wait,
        timeoutMs: timeoutMs as number
      })
      reply(result)
    } catch (err) {
      reply({ error: (err as Error).message })
    }
  }


  /** The view of a session the relay engine needs. */
  private relaySessionFor(id: string): RelaySession | null {
    const s = this.sessions.get(id)
    if (!s) return null
    return { id: s.id, title: s.title, alive: s.alive, status: s.status }
  }

  /** Every session a mention could name, live ones included first. */
  mentionTargets(): MentionTarget[] {
    return [...this.sessions.values()]
      .filter((s) => s.agent !== 'shell')
      .map((s) => ({ id: s.id, title: s.title, lastTask: s.lastTask, agent: s.agent, alive: s.alive }))
  }

  /**
   * The target's closing message.
   *
   * Reads the transcript rather than trusting `lastMessage`, which is capped at
   * 400 characters for the sidebar. A relay reply is another agent's entire
   * input, and a review truncated at 400 characters is worse than no review —
   * it reads complete while omitting every finding after the first.
   */
  private async readLastReply(id: string): Promise<string | null> {
    const s = this.sessions.get(id)
    if (!s) return null
    const file = this.transcriptPaths.get(id) ?? this.locateTranscript(s)
    if (file) {
      const body = lastAssistantMessage(file)
      if (body) return body
    }
    // Codex hands us its closing message on the notify payload, so this is a
    // real answer rather than a consolation prize when the rollout file has not
    // been located yet.
    return s.lastMessage
  }

  /**
   * Sends a prompt from one session to another, optionally blocking until the
   * recipient finishes its turn.
   */
  async sendRelay(req: RelayRequest, authorize?: () => void): Promise<RelayResult> {
    const result = await this.relay.run(req, authorize)
    this.emitChange()
    return result
  }

  /**
   * Resolves an `@name` against the live sessions.
   *
   * Shares `resolveMention` with the renderer's autocomplete on purpose — the
   * popup and the delivery must never disagree about which session a name means.
   */
  resolveTarget(name: string): { id: string | null; error: string | null } {
    const token = name.replace(/^@/, '')
    const hit = resolveMention(token, this.mentionTargets())
    if (hit.target) return { id: hit.target.id, error: null }
    if (hit.reason === 'ambiguous') {
      const names = hit.candidates.map((c) => c.title).join(', ')
      return { id: null, error: `"@${token}" matches several sessions: ${names}` }
    }
    return { id: null, error: `No session matches "@${token}"` }
  }

  /**
   * Fan-out used by the broadcast composer. Every recipient is attempted, and
   * every outcome is reported back so the UI can say "delivered to 2 of 3" and
   * keep the failures selected for a retry.
   */
  async sendPromptMany(sessionIds: string[], text: string): Promise<SendPromptResult[]> {
    const results: SendPromptResult[] = []
    for (const id of sessionIds) {
      try {
        await withTimeout(
          this.sendPrompt(id, text),
          SEND_TIMEOUT_MS,
          'tmux did not answer within 5s'
        )
        results.push({ sessionId: id, ok: true })
      } catch (err) {
        results.push({ sessionId: id, ok: false, error: (err as Error).message })
      }
    }
    return results
  }

  /**
   * Waits for a freshly launched TUI to settle before typing into it — sending a
   * prompt into a half-drawn agent loses the text.
   */
  private async sendWhenReady(sessionId: string, text: string, timeoutMs = 25000): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const deadline = Date.now() + timeoutMs
    let lastActivity = 0
    let stableSince = 0

    while (Date.now() < deadline) {
      await delay(250)
      const info = await this.tmux.paneInfo(s.tmuxName)
      if (!info || info.dead) return
      if (info.activityAt !== lastActivity) {
        lastActivity = info.activityAt
        stableSince = Date.now()
        continue
      }
      if (stableSince && Date.now() - stableSince >= SETTLE_MS) break
      if (!stableSince) stableSince = Date.now()
    }
    await this.sendPrompt(sessionId, text)
  }

  // ── attach / detach ──────────────────────────────────────────────────────

  /**
   * Attaches a PTY client to a tmux session so the renderer can draw it.
   * Only one client per session — reattaching replaces the old one.
   */
  attach(sessionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sessionId)
    if (!s || !s.alive) return

    this.detach(sessionId)
    await0(this.tmux.resize(s.tmuxName, cols, rows))

    // Built once and handed to whichever half actually reads it. A WSL host
    // does not inherit this process's environment — `wsl.exe` forwards nothing
    // — so there `hostSpawn` turns these into `env K=V` arguments; on a local
    // host `hostSpawnEnv` passes them through as a real environment and the
    // argument form is never built. Neither platform gets both.
    const paneEnv: Record<string, string> = {
      PATH: `${toHostPath(this.hooks.paths.binDir)}:${this.loginPath}`,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }
    const attach = hostSpawn(
      [this.tmux.binary, '-L', TMUX_SOCKET, 'attach', '-t', `=${s.tmuxName}`],
      { cwd: toHostPath(s.cwd), env: paneEnv }
    )
    const proc = pty().spawn(attach.file, attach.args, {
      name: 'xterm-256color',
      cols: Math.max(20, cols),
      rows: Math.max(5, rows),
      cwd: attach.cwd,
      env: hostSpawnEnv({ ...process.env, ...paneEnv })
    })

    const client: PtyClient = { proc, cols, rows, buffer: [], flushTimer: null }
    this.clients.set(sessionId, client)

    proc.onData((chunk: string) => {
      client.buffer.push(chunk)
      if (client.flushTimer) return
      // Coalesce bursts; agents emit thousands of tiny writes.
      client.flushTimer = setTimeout(() => {
        client.flushTimer = null
        const data = client.buffer.join('')
        client.buffer.length = 0
        if (data) this.emit('data', sessionId, data)
      }, 8)
    })

    proc.onExit(() => {
      const existing = this.clients.get(sessionId)
      if (existing && existing.proc === proc) this.clients.delete(sessionId)
    })
  }

  detach(sessionId: string): void {
    const client = this.clients.get(sessionId)
    if (!client) return
    if (client.flushTimer) clearTimeout(client.flushTimer)
    try {
      client.proc.kill()
    } catch {
      /* already gone */
    }
    this.clients.delete(sessionId)
  }

  isAttached(sessionId: string): boolean {
    return this.clients.has(sessionId)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const client = this.clients.get(sessionId)
    if (client) {
      client.cols = cols
      client.rows = rows
      try {
        client.proc.resize(Math.max(20, cols), Math.max(5, rows))
      } catch {
        /* transient */
      }
    }
    await0(this.tmux.resize(this.tmuxNameOf(sessionId), cols, rows))
  }

  // ── control ──────────────────────────────────────────────────────────────

  async kill(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return
    this.detach(sessionId)
    await this.tmux.killSession(s.tmuxName)
    s.alive = false
    this.setStatus(sessionId, 'exited', { source: 'user', reason: null, force: true })
    this.persist()
    this.emitChange()
  }

  async remove(sessionId: string): Promise<void> {
    await this.kill(sessionId)
    this.sessions.delete(sessionId)
    this.descriptors.delete(sessionId)
    this.transcriptPaths.delete(sessionId)
    this.codexLogOffsets.delete(sessionId)
    this.codexTurnText.delete(sessionId)
    this.triggerTails.delete(sessionId)
    this.dismissedTriggerTails.delete(sessionId)
    this.turnStartedAt.delete(sessionId)
    this.persist()
    this.emitChange()
  }

  /**
   * Restarts a session in place.
   *
   * The descriptor is persisted, so this works after an app restart too — and
   * when the CLI's own session id is known we resume that conversation rather
   * than starting an empty one. Losing an afternoon of context to a restart
   * button is not an acceptable failure mode.
   */
  async restart(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return
    this.detach(sessionId)

    const d = this.descriptors.get(sessionId)
    const candidate = s.agentSessionId ?? d?.agentSessionId ?? null
    // Only resume a conversation the CLI actually recorded. A phantom id — one
    // assigned to a session that died before its first turn — would make the
    // CLI exit immediately with "No conversation found", so fall back to a
    // fresh start instead.
    const resumeFrom = this.conversationExists(s.agent, candidate) ? candidate : null

    // tmux reports hasSession() true for a *dead* pane (remain-on-exit), so a
    // husk has to be replaced rather than reused.
    if (await this.tmux.hasSession(s.tmuxName)) await this.tmux.killSession(s.tmuxName)
    await this.spawnInTmux(s, {
      resumeFrom,
      forkFromParent: false,
      extraArgs: d?.extraArgs ?? [],
      origin: resumeFrom ? 'resumed' : 'new',
      permissionMode: d?.permissionMode ?? this.store.prefs.defaultPermissionMode,
      model: d?.model ?? null,
      effort: d?.effort ?? null
    })

    s.alive = true
    s.exitCode = null
    this.setStatus(sessionId, 'idle', { source: 'user', reason: null, force: true })
    this.persist()
    this.emitChange()
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.tmux.sendKeys(this.tmuxNameOf(sessionId), ['C-c'])
  }

  /** Grants or revokes this session's Session Bus access. */
  setBusAccess(sessionId: string, bus: BusAccess, expectedProjectId?: string): boolean {
    const s = this.sessions.get(sessionId)
    if (!s) return false
    if (bus === 'app-manager' && expectedProjectId !== undefined) {
      throw new Error('App Manager access is app-wide; confirm it without a project binding.')
    }
    if (bus === 'manager' && !s.sessionProjectId) throw new Error('File this session in a project before granting Manager access.')
    // The renderer confirms a named project. Carry that identity across IPC
    // so a concurrent move cannot turn consent for one project into authority
    // over another between the click and main-process handling.
    if (bus === 'manager' && expectedProjectId !== s.sessionProjectId) {
      throw new Error('The project changed. Confirm Manager access for the current project again.')
    }
    // Filing the central conversation somewhere is organization, not a scope
    // limit. App Manager therefore survives moves and stores an explicit null.
    const projectId = bus === 'manager' ? s.sessionProjectId : null
    if (s.bus === bus && (s.busProjectId ?? null) === projectId) return false
    s.bus = bus
    s.busProjectId = projectId
    this.persist()
    this.emitChange()
    return true
  }

  setPinned(sessionId: string, pinned: boolean): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.pinned = pinned
    this.persist()
    this.emitChange()
  }

  rename(sessionId: string, title: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const role = autoSessionTitle(title)
    if (!role) throw new Error('Describe a company role, such as Software Engineer, Financial Advisor or Research Analyst.')
    s.title = s.agent === 'shell' ? 'Terminal Operator' : role
    s.titleMode = 'manual'
    s.titleVersion = 1
    s.titleSource = 'prompt'
    this.persist()
    this.emitChange()
  }

  /** Files or unfiles one conversation under a user-created Workbench project. */
  assignSessionProject(sessionId: string, projectId: string | null): boolean {
    const s = this.sessions.get(sessionId)
    if (!s || s.sessionProjectId === projectId) return false
    if (s.bus === 'manager') { s.bus = 'off'; s.busProjectId = null }
    s.sessionProjectId = projectId
    if (s.titleMode === 'auto' && s.titleSource !== 'prompt') {
      s.title = contextSessionTitle(s.agent, this.store.sessionProjects.find((p) => p.id === projectId)?.name, s.cwd)
    }
    this.persist()
    this.emitChange()
    return true
  }

  /** Keeps sessions visible when their organizational project is removed. */
  clearSessionProject(projectId: string): number {
    let changed = 0
    for (const s of this.sessions.values()) {
      if (s.sessionProjectId !== projectId) continue
      s.sessionProjectId = null
      if (s.bus === 'manager') { s.bus = 'off'; s.busProjectId = null }
      changed++
    }
    if (changed) {
      this.persist()
      this.emitChange()
    }
    return changed
  }

  /**
   * File a session under a workspace after the fact.
   *
   * Sessions created before workspaces existed have no `workspaceId`, and one
   * that is only ever set at creation time would leave them permanently
   * unfiled — grouped under "No repository" in a sidebar that is supposed to
   * be organising them by repository. The backfill at startup uses this.
   *
   * Returns whether anything changed, so a backfill over dozens of sessions
   * can persist and notify once instead of once per row.
   */
  assignWorkspace(sessionId: string, workspaceId: string | null): boolean {
    const s = this.sessions.get(sessionId)
    if (!s || s.workspaceId === workspaceId) return false
    s.workspaceId = workspaceId
    return true
  }

  /** Write and notify once, after a batch of {@link assignWorkspace} calls. */
  flushWorkspaceAssignments(): void {
    this.persist()
    this.emitChange()
  }

  /** The command to paste into iTerm2 to take this session over directly. */
  attachCommand(sessionId: string): string {
    return this.tmux.attachCommandFor(this.tmuxNameOf(sessionId))
  }

  async captureText(sessionId: string, lines = 4000): Promise<string> {
    return stripAnsi(await this.tmux.capturePane(this.tmuxNameOf(sessionId), lines))
  }

  // ── status engine ────────────────────────────────────────────────────────

  private applyHookEvent(evt: HookEvent): void {
    const s = this.sessions.get(evt.termSessionId)
    if (!s) return

    // `notify` is Codex's authoritative turn-completion channel. Future or
    // user-defined notify payloads must not silently acquire completion
    // semantics just because they reached the same endpoint.
    if (evt.source === 'codex' && evt.event !== 'agent-turn-complete') return
    // …and not every `agent-turn-complete` is *your* turn. Rejected here rather
    // than further down, because such an event also carries a thread id, and
    // adopting a throwaway thread's id would point export and fork at a
    // transcript that does not exist.
    if (evt.source === 'codex' && !this.isCodexTurnOfRecord(evt)) return

    s.lastActivityAt = evt.receivedAt
    s.lastEventAt = evt.receivedAt

    const cliId = extractAgentSessionId(evt.payload)
    if (cliId && cliId !== s.agentSessionId) {
      s.agentSessionId = cliId
      const d = this.descriptors.get(s.id)
      if (d) d.agentSessionId = cliId
      // A newly learnt id supersedes any guess we made earlier.
      this.transcriptPaths.delete(s.id)
    }
    const p = evt.payload as Record<string, unknown>
    if (evt.source === 'claude' && evt.event === 'UserPromptSubmit') {
      s.lastPromptAt = evt.receivedAt
      s.lastMessage = null
      if (typeof p.prompt === 'string') this.maybeAutoTitle(s, p.prompt)
    }
    if (typeof p.transcript_path === 'string' && p.transcript_path) {
      this.transcriptPaths.set(s.id, p.transcript_path)
      const d = this.descriptors.get(s.id)
      if (d) d.transcriptPath = p.transcript_path
    }

    const from: { source: StatusSource; reason: string | null } = { source: 'hook', reason: null }

    if (evt.source === 'claude') {
      switch (evt.event) {
        case 'SessionStart':
          this.setStatus(s.id, 'idle', from)
          break
        case 'UserPromptSubmit':
        case 'PreToolUse':
        case 'PostToolUse':
        case 'SubagentStop':
          this.setStatus(s.id, 'working', from)
          break
        case 'Notification': {
          // An idle reminder is not a new question. Keep real outstanding
          // permissions intact, and do not resurrect a reviewed turn when a
          // late informational notification arrives after the user saw it.
          if (p.notification_type === 'idle_prompt') {
            if (s.status === 'working') this.setStatus(s.id, 'review', from)
            break
          }
          if (typeof p.notification_type === 'string' && p.notification_type !== 'permission_prompt') break
          const msg = typeof p.message === 'string' ? p.message : 'Claude needs your input'
          this.setStatus(s.id, 'waiting', { source: 'hook', reason: msg })
          break
        }
        case 'Stop':
          s.lastMessage = null
          if (this.transcriptPaths.has(s.id)) {
            const history = readSessionNaming(this.transcriptPaths.get(s.id)!)
            if (history.lastPrompt) this.maybeAutoTitle(s, history.lastPrompt)
            // The transcript reader returns the latest turn's reply. Do not
            // carry a cached earlier completion when no reply was recovered.
            s.lastMessage = history.lastReply?.slice(0, 2000) ?? null
            s.lastTask = purposeFromPrompt(history.lastReply ?? '', 140, 20) ?? s.lastTask
          }
          this.setStatus(s.id, 'review', from)
          break
        case 'SessionEnd':
          s.alive = false
          this.setStatus(s.id, 'exited', { source: 'hook', reason: null, force: true })
          break
        default:
          this.setStatus(s.id, 'working', from)
      }
    } else {
      // Codex reports turn completion; whether that means "ready for review" or
      // "over to you" is decided from the final assistant message. Pane text is
      // only a fallback because it can contain stale prompts from earlier turns.
      const last =
        typeof p['last-assistant-message'] === 'string'
          ? (p['last-assistant-message'] as string)
          : null
      const inputs = p['input-messages']
      const latest = Array.isArray(inputs) ? [...inputs].reverse().find((value) => typeof value === 'string' && value.trim()) : null
      if (typeof latest === 'string') this.maybeAutoTitle(s, latest)
      if (last) {
        s.lastMessage = last.slice(0, 2000)
        s.lastTask = purposeFromPrompt(last, 140, 20) ?? s.lastTask
      } else s.lastMessage = null
      const generation = this.codexTurnGeneration.get(s.id) ?? 0
      void this.classifyCodexTurnEnd(s.id, last, generation,
        isAgentRelayPrompt(typeof latest === 'string' ? latest : this.codexTurnText.get(s.id))).then((applied) => {
        if (!applied) return
        this.persist()
        this.emitChange()
      })
    }

    this.persist()
    this.emitChange()
  }

  /**
   * Whether a Codex `agent-turn-complete` belongs to the turn you submitted.
   *
   * Codex's notify hook is per *thread*, not per session, and the TUI opens
   * short-lived threads of its own — one to name the conversation, one to write
   * a recap — each of which completes and notifies while your turn is still
   * running. The payload names the prompt it answered, so comparing that
   * against the prompt we watched enter the session separates the two without
   * depending on the wording of whatever internal prompt Codex used.
   *
   * A session we never saw a turn start for — the app was launched after the
   * fact, or the lifecycle log is unreadable — falls through to accepting the
   * event, which is what it did before any of this existed.
   */
  private isCodexTurnOfRecord(evt: HookEvent): boolean {
    const expected = this.codexTurnText.get(evt.termSessionId)
    if (expected === undefined) return true
    const messages = (evt.payload as Record<string, unknown>)['input-messages']
    if (!Array.isArray(messages)) return true
    const last = [...messages].reverse().find((m) => typeof m === 'string' && m.trim())
    if (typeof last !== 'string') return true
    return normalizePrompt(last) === normalizePrompt(expected)
  }

  /** A finished Codex turn that ends in a question is red, not green. */
  private async classifyCodexTurnEnd(
    sessionId: string,
    lastMessage: string | null,
    generation: number,
    relayTurn = false
  ): Promise<boolean> {
    const beforeCapture = this.sessions.get(sessionId)
    if (!beforeCapture) return false

    let haystack = lastMessage
    if (haystack === null) {
      try {
        haystack = stripAnsi(await this.tmux.captureTail(beforeCapture.tmuxName, 30))
      } catch {
        haystack = ''
      }
    }

    const s = this.sessions.get(sessionId)
    if (!s || !s.alive || (this.codexTurnGeneration.get(sessionId) ?? 0) !== generation) {
      return false
    }
    // Only a final assistant message can address the human. Missing final
    // text can still expose an anchored, currently open MCP approval dialog;
    // ordinary questions in the terminal's older scrollback are not evidence.
    const request = finalHumanRequest(lastMessage, relayTurn)
    const dialog = lastMessage === null ? this.matchTriggers(haystack ?? '', s.agent)
      .find((t) => t.rule.id === 'codex-mcp-approval' && t.rule.action === 'waiting') : undefined
    if (request || dialog) this.setStatus(s.id, 'waiting', { source: 'hook', reason: request ?? dialog!.reason })
    else this.setStatus(s.id, 'review', { source: 'hook', reason: null })
    return true
  }

  /**
   * Drains each Codex session's own lifecycle log.
   *
   * This is the process-scoped half of Codex telemetry: the notify hook only
   * fires at the *end* of a turn, so without this a Codex session sits on the
   * previous colour for the entire time it is thinking, and an approval prompt
   * — which never reaches notify at all — would read as idle.
   */
  private drainCodexLogs(): boolean {
    let changed = false
    for (const s of this.sessions.values()) {
      if (this.definition(s.agent).launch !== 'codex' || !s.alive) continue
      const file = this.descriptors.get(s.id)?.lifecycleLogPath
      if (!file) continue

      const from = this.codexLogOffsets.get(s.id) ?? 0
      const { signals, nextByte } = parseCodexSessionLog(file, from)
      this.codexLogOffsets.set(s.id, nextByte)
      if (!signals.length) continue

      changed = true
      s.lastEventAt = Date.now()
      s.lastActivityAt = Date.now()
      for (const sig of signals) this.applyCodexSignal(s, sig)
    }
    return changed
  }

  private applyCodexSignal(s: Session, sig: CodexLogSignal): void {
    switch (sig.kind) {
      case 'turn-start':
        s.lastPromptAt = Date.now()
        s.lastMessage = null
        this.codexTurnGeneration.set(s.id, (this.codexTurnGeneration.get(s.id) ?? 0) + 1)
        if (sig.text) {
          this.codexTurnText.set(s.id, sig.text)
          this.maybeAutoTitle(s, sig.text)
        }
        this.setStatus(s.id, 'working', { source: 'hook', reason: null })
        break
      case 'approval':
        this.setStatus(s.id, 'waiting', {
          source: 'hook',
          reason: sig.reason ? `Codex is asking for approval (${sig.reason})` : 'Codex needs approval'
        })
        break
      case 'approval-resolved':
        if (s.status === 'waiting') this.setStatus(s.id, 'working', { source: 'hook', reason: null })
        break
      case 'interrupted':
        this.codexTurnGeneration.set(s.id, (this.codexTurnGeneration.get(s.id) ?? 0) + 1)
        this.setStatus(s.id, 'idle', { source: 'hook', reason: null })
        break
      case 'ended':
        this.codexTurnGeneration.set(s.id, (this.codexTurnGeneration.get(s.id) ?? 0) + 1)
        this.setStatus(s.id, 'exited', { source: 'hook', reason: null, force: true })
        s.alive = false
        break
      case 'started':
        break
    }
  }

  private matchTriggers(
    text: string,
    agent: AgentKind
  ): { rule: TriggerRule; reason: string | null }[] {
    const out: { rule: TriggerRule; reason: string | null }[] = []
    for (const rule of this.store.prefs.triggers) {
      if (!rule.enabled) continue
      if (rule.agent !== 'any' && rule.agent !== agent) continue
      let re: RegExp
      try {
        re = new RegExp(rule.pattern, rule.flags || '')
      } catch {
        continue // user typed an invalid regex; skip rather than crash
      }
      const m = re.exec(text)
      if (!m) continue
      out.push({ rule, reason: rule.captureReason ? firstLineOf(m[0]) : null })
    }
    return out
  }

  /**
   * The one place a session's colour changes.
   *
   * Transitions are checked against `STATUS_TRANSITIONS` so a stray late event
   * cannot resurrect an exited session, and `failed` is a state of its own — it
   * must never be shown as a permission request, because "the agent crashed" and
   * "the agent is asking you something" call for opposite responses.
   */
  private setStatus(
    sessionId: string,
    status: SessionStatus,
    opts: { source: StatusSource; reason: string | null; force?: boolean }
  ): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    if (opts.source === 'hook' || (opts.source === 'user' && status === 'working')) {
      this.dismissedTriggerTails.delete(sessionId)
    }
    const prev = s.status

    if (prev === status) {
      // Same colour, possibly a better reason (a second, more specific hook).
      if (opts.reason) s.statusReason = opts.reason
      s.statusSource = opts.source
      return
    }
    if (!opts.force && !canTransition(prev, status)) return

    s.status = status
    s.statusSource = opts.source
    s.statusReason = opts.reason
    s.lastStatusChangeAt = Date.now()
    // Before the notification branches below: a relay blocked on this session
    // should be released by the transition itself, not by whether the user
    // happens to have desktop notifications switched on.
    this.relay.onStatus(s.id, status, opts.reason)
    // Anything but "the user looked at it" makes a completion unseen again.
    if (status !== 'idle') s.lastSeenAt = null

    // A turn's boundaries, which is all the preview pane needs from here: it
    // asks separately whether anything worth looking at appeared in between.
    if (status === 'working') {
      this.turnStartedAt.set(sessionId, s.lastStatusChangeAt)
    } else if (prev === 'working') {
      const startedAt = this.turnStartedAt.get(sessionId)
      this.turnStartedAt.delete(sessionId)
      if (startedAt !== undefined && status !== 'exited' && status !== 'failed') {
        this.emit('produced', { sessionId, cwd: s.cwd, since: startedAt })
      }
    }

    if (status === 'waiting' && this.store.prefs.notifyOnWaiting) {
      this.emit('notify', {
        sessionId,
        title: `${s.title} needs you`,
        body: opts.reason || 'Waiting on your response',
        status
      } satisfies NotifyRequest)
    } else if (status === 'failed') {
      this.emit('notify', {
        sessionId,
        title: `${s.title} failed`,
        body: opts.reason || 'The agent stopped with an error',
        status
      } satisfies NotifyRequest)
    } else if (status === 'review' && prev === 'working' && this.store.prefs.notifyOnDone) {
      this.emit('notify', {
        sessionId,
        title: `${s.title} finished`,
        body: s.lastMessage?.slice(0, 160) || 'Task complete',
        status
      } satisfies NotifyRequest)
    }
  }

  /**
   * The renderer tells us what is actually on screen. Two things depend on it:
   * a completion you have looked at goes quietly neutral instead of staying
   * green forever, and notifications are suppressed only for the exact pane you
   * are looking at.
   */
  setVisiblePanes(v: VisiblePanes): void {
    this.visible = { sessionIds: [...v.sessionIds], focusedSessionId: v.focusedSessionId }
    const focused = v.focusedSessionId
    if (!focused) return
    const s = this.sessions.get(focused)
    if (!s) return

    const now = Date.now()
    s.lastSeenAt = now
    // Green means "there is something new here for you". Once you are looking
    // at it, that is no longer true.
    if (s.status === 'review') {
      s.status = 'idle'
      s.statusSource = 'user'
      s.statusReason = null
      s.lastStatusChangeAt = now
      s.lastSeenAt = now
      this.persist()
      this.emitChange()
    }
  }

  isVisible(sessionId: string): boolean {
    return this.visible.sessionIds.includes(sessionId)
  }

  isFocused(sessionId: string): boolean {
    return this.visible.focusedSessionId === sessionId
  }

  /**
   * Manual escape hatch. Status inference is heuristic at the edges — when it
   * gets a session wrong, you need a way to say so that does not involve
   * killing the session.
   */
  clearStatus(sessionId: string, expected?: { status: SessionStatus; changedAt: number; reason: string | null }): boolean {
    const s = this.sessions.get(sessionId)
    if (!s || (expected && (s.status !== expected.status || s.lastStatusChangeAt !== expected.changedAt || s.statusReason !== expected.reason))) return false
    this.dismissedTriggerTails.set(sessionId, this.triggerTails.get(sessionId) ?? null)
    s.status = s.alive ? 'idle' : 'exited'
    s.statusSource = 'user'
    s.statusReason = null
    s.lastStatusChangeAt = Date.now()
    s.lastSeenAt = Date.now()
    this.persist()
    this.emitChange()
    return true
  }

  /** Liveness + trigger sweep. Cheap: one tmux round-trip for every pane. */
  private async poll(): Promise<void> {
    if (this.sessions.size === 0) return
    let changed = this.drainCodexLogs()
    // A launch can finish while the tmux round-trip is in flight. Its absence
    // from that older snapshot says nothing about the new process; otherwise
    // freshly created workers briefly appear exited and callers refuse them.
    const sampled = new Map([...this.sessions.keys()].map((id) => [id, this.descriptors.get(id)]))

    // A snapshot we could not take is not evidence that anything died. Treating
    // a failed query as "no panes exist" is what turns one bad tmux call into
    // every running session being marked exited.
    let panes: Map<string, TmuxPaneInfo>
    try {
      panes = await this.tmux.allPaneInfo()
    } catch (err) {
      // A dead server is the exception: it is not a snapshot we failed to take,
      // it is the answer. The server owns every pane, so its absence means all
      // of them are gone, and saying so once is what lets the sessions settle on
      // `exited` and the poll go quiet. Without this the list keeps advertising
      // sessions that cannot come back, and the log fills with an identical
      // stack trace every second for as long as the app is open.
      if (!serverIsGone(err)) {
        console.error('[terminal] pane snapshot failed; leaving liveness alone', err)
        if (changed) {
          this.persist()
          this.emitChange()
        }
        return
      }
      panes = new Map()
    }

    for (const s of this.sessions.values()) {
      if (!sampled.has(s.id) || sampled.get(s.id) !== this.descriptors.get(s.id)) continue
      const info = panes.get(s.tmuxName)

      if (!info) {
        if (s.alive) {
          s.alive = false
          this.setStatus(s.id, 'exited', { source: 'poll', reason: null, force: true })
          changed = true
        }
        // Whatever it was serving went with it.
        if (s.serverUrl) {
          s.serverUrl = null
          changed = true
        }
        continue
      }

      if (info.dead) {
        if (s.serverUrl) {
          s.serverUrl = null
          changed = true
        }
        if (s.alive) {
          s.alive = false
          s.exitCode = info.deadStatus
          // A non-zero exit is a failure, not a tidy finish — and it gets its
          // own badge rather than borrowing the "needs you" red.
          const failed = typeof info.deadStatus === 'number' && info.deadStatus !== 0
          this.setStatus(s.id, failed ? 'failed' : 'exited', {
            source: 'poll',
            reason: failed ? `Exited with status ${info.deadStatus}` : null,
            force: true
          })
          // A launch that dies immediately dies before `pipe-pane` is attached,
          // so its error text exists only in the dead pane's scrollback and is
          // gone the moment the pane is dismissed. "Exited with status 127"
          // without the line above it is unactionable, so grab it now.
          if (failed) void this.captureDeathCause(s.id)
          changed = true
        }
        continue
      }

      if (!s.alive) {
        s.alive = true
        changed = true
      }

      // Reaching here means the pane exists and is not dead, so a death *we*
      // recorded was wrong — most often a snapshot we failed to read. Undo it,
      // or the session keeps advertising "Session exited" over a CLI sitting at
      // its prompt, and a relaunch just restores the same stale verdict. Only
      // poll's own verdicts are revisited: a SessionEnd hook or an explicit
      // kill means the session really is finished, whatever the pane says.
      if ((s.status === 'exited' || s.status === 'failed') && s.statusSource === 'poll') {
        s.exitCode = null
        this.setStatus(s.id, 'idle', { source: 'poll', reason: null, force: true })
        changed = true
      }

      if (info.activityAt > s.lastActivityAt) {
        s.lastActivityAt = info.activityAt
        changed = true
      }

      if (this.refreshContext(s)) changed = true

      // Trigger sweep only for sessions that have gone quiet — a session still
      // spewing output is obviously not waiting on us.
      const quietFor = Date.now() - s.lastActivityAt
      if ((s.status === 'working' || s.status === 'idle') && quietFor > QUIET_BEFORE_TRIGGER_MS) {
        const sampledStatus = s.status, sampledChangeAt = s.lastStatusChangeAt, sampledPromptAt = s.lastPromptAt
        const tail = stripAnsi(await this.tmux.captureTail(s.tmuxName, 30))
        if (!s.alive || s.status !== sampledStatus || s.lastStatusChangeAt !== sampledChangeAt || s.lastPromptAt !== sampledPromptAt) continue
        this.triggerTails.set(s.id, tail)
        // A manual acknowledgement applies to the exact screen, including on
        // the first poll after a restart where no previous capture was known.
        // Fresh lifecycle events clear this memory in setStatus above.
        const dismissed = this.dismissedTriggerTails.get(s.id)
        if (dismissed === null) this.dismissedTriggerTails.set(s.id, tail)
        const sameDismissed = this.dismissedTriggerTails.has(s.id) && (dismissed === null || dismissed === tail)
        if (!sameDismissed) this.dismissedTriggerTails.delete(s.id)
        const hits = sameDismissed ? [] : this.matchTriggers(tail, s.agent)
          .filter((hit) => !isLegacyProseTrigger(hit.rule))
          .filter((hit) => !isDefaultCodexDialogTrigger(hit.rule) || hasActiveCodexDialog(tail))

        // A dev server that has finished starting is a quiet session with a URL
        // in its last few lines, so this costs nothing beyond the tail we
        // already have. Announced once per URL: a server that keeps printing
        // its address on every request should not keep interrupting.
        const server = findServerUrl(tail)
        if (server && s.serverUrl !== server) {
          s.serverUrl = server
          changed = true
          this.emit('server', { sessionId: s.id, url: server })
        }

        // First status-changing hit wins, most urgent first — a rule that says
        // "failed" or "waiting" outranks one that says "review" on the same output.
        const statusHit =
          hits.find((h) => h.rule.action === 'failed') ??
          hits.find((h) => h.rule.action === 'waiting') ??
          hits.find((h) => h.rule.action === 'working') ??
          hits.find((h) => h.rule.action === 'review')
        if (statusHit) {
          this.setStatus(s.id, statusHit.rule.action as SessionStatus, {
            source: 'trigger',
            reason: statusHit.reason
          })
          changed = true
        }

        // `notify` is independent of status: it pings without reclassifying.
        for (const hit of hits.filter((h) => h.rule.action === 'notify')) {
          this.emit('notify', {
            sessionId: s.id,
            title: `${s.title} — ${hit.rule.name}`,
            body: hit.reason || 'Trigger matched',
            status: s.status
          } satisfies NotifyRequest)
        }
      }
    }

    if (changed) {
      this.persist()
      this.emitChange()
    }
  }

  // ── queries ──────────────────────────────────────────────────────────────

  list(): Session[] {
    return Array.from(this.sessions.values()).map((s) => this.withLaunchFields(s))
  }

  get(sessionId: string): Session | undefined {
    const s = this.sessions.get(sessionId)
    return s && this.withLaunchFields(s)
  }

  /**
   * The rendered screen of a session, as a person would see it.
   *
   * Exists for sharing. A guest cannot be handed the raw pty stream — a
   * full-screen TUI's byte stream is meaningless without an emulator — but tmux
   * has already done the rendering, so `capture-pane` is exactly the picture a
   * guest needs. Null means the session is gone, which the caller must be able
   * to tell apart from an empty screen.
   */
  async snapshot(sessionId: string, lines: number): Promise<string | null> {
    const s = this.sessions.get(sessionId)
    if (!s || !s.alive) return null
    try {
      return await this.tmux.capturePane(s.tmuxName, lines)
    } catch {
      return null
    }
  }

  /**
   * Fold the launch record into the session the renderer sees.
   *
   * Model and permission mode are chosen once, at launch, and then need to be
   * on screen for the rest of the session's life — a full-access agent that
   * looks like any other is the one that surprises you. Derived here rather
   * than copied onto the stored session so a restart, which builds a fresh
   * descriptor, cannot leave a stale badge behind.
   */
  private withLaunchFields(s: Session): Session {
    const d = this.descriptors.get(s.id)
    if (!d) return s
    return {
      ...s,
      model: d.model,
      effort: d.effort,
      permissionMode: d.permissionMode
    }
  }

  counts(): StatusCounts {
    const c: StatusCounts = {
      working: 0,
      waiting: 0,
      review: 0,
      failed: 0,
      idle: 0,
      exited: 0,
      total: 0
    }
    for (const s of this.sessions.values()) {
      c.total++
      c[s.status]++
    }
    return c
  }

  private tmuxNameOf(sessionId: string): string {
    return this.sessions.get(sessionId)?.tmuxName ?? tmuxNameFor(sessionId)
  }

  private persist(): void {
    // Raw, not `list()`: the launch fields are derived from the descriptors
    // persisted on the next line, and writing both would let the two copies
    // disagree after a descriptor version bump discards the record.
    this.store.setSessions(Array.from(this.sessions.values()))
    this.store.setDescriptors(Array.from(this.descriptors.values()))
  }

  private emitChange(): void {
    this.emit('sessions-changed')
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Bounds a promise that has no timeout of its own.
 *
 * Rejecting does not cancel the work — nothing here can un-type a prompt into a
 * pane — it only stops the caller waiting on it. That distinction is why the
 * message says tmux did not *answer* rather than that the send failed.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    const done = (): void => clearTimeout(timer)
    work.then(
      (value) => {
        done()
        resolve(value)
      },
      (err) => {
        done()
        reject(err)
      }
    )
  })
}

/** Fire-and-forget for promises whose failure is not actionable. */
function await0(p: Promise<unknown>): void {
  void p.catch(() => undefined)
}

function firstLineOf(s: string): string {
  return s.split('\n')[0].trim().slice(0, 160)
}

function safeFileSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/**
 * Pulls the CLI's own conversation id out of a hook payload.
 *
 * Claude sends `session_id`; Codex's notify payload uses **`thread-id`** with a
 * hyphen, which an underscore-only lookup misses entirely — and a Codex session
 * with no agent id can never be forked or exported.
 */
/**
 * Puts a prompt into a form two channels can be compared in.
 *
 * The same text reaches us twice — once as the TUI recorded the submission,
 * once as the model saw it — and the trip can normalise line endings or pad
 * the edges. Nothing else is touched: the comparison is meant to be exact
 * about the words, forgiving only about the whitespace between them.
 */
export function normalizePrompt(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function extractAgentSessionId(payload: Record<string, unknown>): string | null {
  const keys = ['session_id', 'thread-id', 'thread_id', 'conversation_id', 'conversation-id']
  for (const k of keys) {
    const v = payload[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

/**
 * Strips ANSI/CSI/OSC sequences. Agent TUIs are dense with them, and every
 * consumer here (triggers, transcripts, search) wants plain text.
 * Escape bytes are spelled with \u001b so this source stays copy-paste safe.
 */
const RE_OSC = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g
const RE_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
const RE_SS = /\u001b[@-Z\\-_]/g

export function stripAnsi(input: string): string {
  return input
    .replace(RE_OSC, '')
    .replace(RE_CSI, '')
    .replace(RE_SS, '')
    .replace(/\r(?!\n)/g, '')
}
