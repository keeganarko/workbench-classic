/**
 * The complete IPC surface. Every renderer capability passes through here, so
 * this file doubles as the app's API documentation.
 *
 * Two rules hold for every channel below:
 *   1. The payload is validated at runtime (see `validate.ts`) — a TypeScript
 *      annotation is not a check, it is a comment that the compiler erases.
 *   2. The sender is verified to be our own top-level window, so a frame we did
 *      not create cannot drive the main process.
 */

import { app, ipcMain, dialog, shell, BrowserWindow, nativeImage } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { hostHomeNative, toNativePath } from './host.js'
import type { ProjectSync } from './projectSync.js'
import type { Experience } from './experience.js'
import type { Services } from './services.js'
import { withProjectContext } from '../shared/experience.js'
import { listDir, resolveInside, searchFiles } from './files.js'
import { openWithSystem, savePreviewCopy } from './fileActions.js'
import { flowStatus, openFlow, dictationFiles } from './dictation.js'
import { readScripts } from './scripts.js'
import type { AttachmentStore } from './attachments.js'
import type { PreviewServer } from './preview.js'
import type { GitReview } from './review.js'
import type { SessionManager } from './sessions.js'
import type { Store } from './store.js'
import type { Tmux } from './tmux.js'
import type { WorkspaceManager } from './workspaces.js'
import type { AppState, UsageReport } from '../shared/types.js'
import type { RelayResult } from '../shared/relay.js'
import type { Share } from '../shared/share.js'
import type { ShareServer } from './share.js'
import type { ContextShelf } from './shelf.js'
import { toCheckpointName } from '../shared/shelf.js'
import type { Tunnel } from './tunnel.js'
import { RELAY_DEFAULT_TIMEOUT_MS, RELAY_MAX_TIMEOUT_MS } from '../shared/relay.js'
import { PREVIEW_EXTENSIONS } from '../shared/preview.js'
import {
  asAbsolutePath,
  asAgentKind,
  asBusAccess,
  asCreateSessionOptions,
  asDiffQuery,
  asDroppedFiles,
  asFolderRequest,
  asForkOptions,
  asHandoffOptions,
  asInt,
  asPathBatch,
  asPrefsPatch,
  asPreviewDocumentRequest,
  asSafeExternalUrl,
  asSearchRequest,
  asSessionId,
  asSessionIdList,
  asString,
  asTabs,
  asVisiblePanes,
  asWorkspaceRequest,
  isObj
} from './validate.js'

export interface IpcDeps {
  updates: import('./updates.js').UpdateService
  projectSync: ProjectSync
  experience: Experience
  services: Services
  manager: SessionManager
  store: Store
  tmux: Tmux
  workspaces: WorkspaceManager
  attachments: AttachmentStore
  preview: PreviewServer
  review: GitReview
  /** Serves shared sessions to guests' browsers. */
  share: ShareServer
  /** Optional public reach for a share link. */
  tunnel: Tunnel
  /** Named checkpoints of agent conversations, shared with the `ctx` command. */
  shelf: ContextShelf
  snapshot: () => AppState
  pushState: () => void
  registerHotkey: () => void
  /**
   * Re-resolve agent profiles and rebuild the menus that name them.
   *
   * A custom agent is a preference, but `profiles` is what every list in the
   * app reads and it carries "is this on PATH" — a fact about the machine, not
   * the patch. Without this an agent added in Settings would not appear
   * anywhere until the next launch.
   */
  refreshAgents: () => void
  getWindow: () => BrowserWindow | null
  showWindow: () => void
  clipboard: Electron.Clipboard
  dataDir: string
  /** Forces a quota refresh ahead of the poll, for the meter's own button. */
  refreshUsage: () => Promise<UsageReport>
}

export function registerIpc(deps: IpcDeps): void {
  const { manager, store, share, tunnel, shelf, snapshot, pushState } = deps

  /**
   * True only for the main frame of a window we own. Electron delivers IPC from
   * any frame in the process, including one an embedded page created.
   */
  const senderIsOurs = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean => {
    const win = deps.getWindow()
    if (!win || win.isDestroyed()) return false
    if (event.sender !== win.webContents) return false
    // `senderFrame` is null once the frame is gone mid-call.
    const frame = event.senderFrame
    return !!frame && frame === event.sender.mainFrame
  }

  const handle = <T>(
    channel: string,
    fn: (payload: T, event: Electron.IpcMainInvokeEvent) => unknown
  ): void => {
    ipcMain.handle(channel, async (event, payload: T) => {
      if (!senderIsOurs(event)) return { ok: false, error: 'Rejected: unrecognised sender' }
      try {
        return { ok: true, value: await fn(payload, event) }
      } catch (err) {
        // Errors cross the bridge as data, so the UI can show them instead of
        // the renderer eating an unhandled rejection.
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
  }

  /** Fire-and-forget channels get the same sender check and shape validation. */
  const on = (channel: string, fn: (payload: unknown) => void): void => {
    ipcMain.on(channel, (event, payload: unknown) => {
      if (!senderIsOurs(event)) return
      try {
        fn(payload)
      } catch {
        /* a malformed keystroke payload must not take the app down */
      }
    })
  }

  // ── state ────────────────────────────────────────────────────────────────

  handle('state:get', () => snapshot())
  // The local app UI owns these commands. They are deliberately absent from
  // the agent Session Bus: adding a server does not grant agents shell access.
  handle('services:state', () => deps.services.snapshot())
  handle<unknown>('services:save', (raw) => deps.services.save(raw))
  handle<unknown>('services:start', (raw) => deps.services.start(asString(raw, 'service id', 200)))
  handle<unknown>('services:stop', (raw) => deps.services.stop(asString(raw, 'service id', 200)))
  handle<unknown>('services:restart', (raw) => deps.services.restart(asString(raw, 'service id', 200)))
  handle<unknown>('services:remove', (raw) => deps.services.remove(asString(raw, 'service id', 200)))
  // These actions deliberately accept no URLs, paths or release metadata.
  // Only main's selected, validated release can reach the installer adapter.
  handle('updates:check', () => deps.updates.check())
  handle('updates:download', () => deps.updates.download())
  handle('updates:install', () => deps.updates.install())

  handle('projects:defaultFolder', () => path.join(hostHomeNative(), 'Dev'))
  handle('projectSync:account', () => deps.projectSync.account())
  handle<unknown>('projectSync:preview', (raw) => deps.projectSync.preview(asString(raw, 'project id', 200)))
  handle<unknown>('projectSync:sync', (raw) => deps.projectSync.sync(asString(raw, 'project id', 200)))
  handle<unknown>('projectSync:disconnect', (raw) => deps.projectSync.disconnect(asString(raw, 'project id', 200)))
  handle<unknown>('projectSync:connect', (raw) => {
    if (!isObj(raw) || !['create', 'join'].includes(String(raw.mode))) throw new Error('Invalid sharing request')
    return deps.projectSync.connect(asString(raw.id, 'project id', 200), raw.mode as 'create' | 'join', asString(raw.repository, 'repository', 300))
  })
  handle<unknown>('projectSync:invite', (raw) => {
    if (!isObj(raw)) throw new Error('Invalid invitation')
    return deps.projectSync.invite(asString(raw.id, 'project id', 200), asString(raw.username, 'GitHub username', 39))
  })
  handle<unknown>('projectSync:pause', (raw) => {
    if (!isObj(raw) || typeof raw.enabled !== 'boolean') throw new Error('Invalid sync setting')
    return deps.projectSync.pause(asString(raw.id, 'project id', 200), raw.enabled)
  })
  handle<unknown>('projectSync:resolve', (raw) => {
    if (!isObj(raw) || !['local', 'shared'].includes(String(raw.choice))) throw new Error('Invalid conflict resolution')
    return deps.projectSync.resolve(asString(raw.id, 'project id', 200), asString(raw.path, 'file', 800), raw.choice as 'local' | 'shared')
  })

  handle<unknown>('experience:saveTask', (raw) => deps.experience.saveTask(raw))
  handle<unknown>('experience:runTask', (raw) => deps.experience.runTask(asString(raw, 'task id', 200)))
  handle<unknown>('experience:removeTask', (raw) => deps.experience.removeTask(asString(raw, 'task id', 200)))
  handle<unknown>('experience:toggleTask', (raw) => {
    if (!isObj(raw) || typeof raw.enabled !== 'boolean') throw new Error('Invalid schedule change')
    deps.experience.toggleTask(asString(raw.id, 'task id', 200), raw.enabled)
  })
  handle<unknown>('experience:archive', (raw) => {
    if (!isObj(raw) || typeof raw.archived !== 'boolean') throw new Error('Invalid archive change')
    deps.experience.archive(asSessionId(raw.id), raw.archived)
  })
  handle<unknown>('experience:projectDetails', (raw) => {
    if (!isObj(raw)) throw new Error('Invalid project context')
    deps.experience.setProjectDetails(asString(raw.id, 'project id', 200), raw.details)
  })
  handle<unknown>('experience:acknowledgeOutput', (raw) => {
    if (!isObj(raw)) throw new Error('Invalid document acknowledgment')
    deps.experience.acknowledgeOutput(asSessionId(raw.sessionId), asString(raw.path, 'document path', 4096))
  })

  // Linux/WSLg uses the renderer title bar because the native GTK frame would
  // otherwise wrap a second title bar around it. Keep these tiny commands in
  // the authenticated IPC surface rather than exposing BrowserWindow itself.
  handle('window:minimize', () => deps.getWindow()?.minimize())
  handle('window:toggleMaximize', () => {
    const win = deps.getWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  handle('window:close', () => deps.getWindow()?.close())

  handle<unknown>('prefs:set', (raw) => {
    const patch = asPrefsPatch(raw)
    const prefs = store.setPrefs(patch)
    if ('globalHotkey' in patch || 'hotkeyWindowEnabled' in patch) deps.registerHotkey()
    // history-limit is read from the config file at session creation, so this
    // takes effect for sessions started from now on, not existing ones.
    if ('scrollback' in patch) void deps.tmux.writeConfig(prefs.scrollback)
    if ('terminalAccessibility' in patch) app.setAccessibilitySupportEnabled(prefs.terminalAccessibility)
    if ('customAgents' in patch) deps.refreshAgents()
    pushState()
    return prefs
  })

  handle<unknown>('tabs:set', (raw) => {
    const { tabs, activeTabId } = asTabs(raw)
    store.setTabs(tabs, activeTabId)
    return true
  })

  /**
   * The renderer reports what is actually on screen. Notification suppression
   * and "you have seen this completion" both depend on it, and neither can be
   * inferred from window focus alone.
   */
  handle<unknown>('ui:visiblePanes', (raw) => {
    manager.setVisiblePanes(asVisiblePanes(raw))
    return true
  })

  // ── workspaces ───────────────────────────────────────────────────────────

  handle<unknown>('workspaces:list', () => ({
    projects: deps.workspaces.listProjects(),
    workspaces: deps.workspaces.list()
  }))

  /** Powers the dialog: worktree options are only offered for a real repository. */
  handle<unknown>('workspaces:describe', async (raw) => {
    const info = await deps.workspaces.describe(asString(raw, 'folder', 4096))
    return info ? { root: info.root, branch: info.branch, defaultBranch: info.defaultBranch } : null
  })

  /** The way out of a folder that holds repositories but is not one itself. */
  handle<unknown>('workspaces:repos', (raw) =>
    deps.workspaces.reposInside(asString(raw, 'folder', 4096))
  )

  /**
   * Resolves a launch into the workspaces it needs, before any session starts.
   *
   * Separate from `sessions:create` on purpose: "both agents, one shared
   * worktree" is two sessions pointing at one workspace, and two independent
   * create calls could not agree on which one that is.
   */
  handle<unknown>('workspaces:prepare', (raw) => {
    const { req, count } = asWorkspaceRequest(raw)
    return deps.workspaces.create(req, count)
  })

  handle<unknown>('workspaces:remove', (raw) => {
    if (!isObj(raw)) throw new Error('Invalid workspace payload')
    return deps.workspaces.remove(asString(raw.id, 'workspace id', 200), {
      force: raw.force === true
    })
  })

  // ── conversation projects ───────────────────────────────────────────────

  const projectFolder = (raw: unknown): string => {
    const value = asString(raw, 'project folder', 4096)
    const native = value === '~' ? hostHomeNative() : /^~[\\/]/.test(value)
      ? path.join(hostHomeNative(), value.slice(2)) : toNativePath(value)
    try { if (fs.statSync(native).isDirectory()) return native } catch { /* useful error below */ }
    throw new Error('Choose an existing project folder. Creating a project does not move or create its files.')
  }

  handle<unknown>('projects:create', (raw) => {
    if (!isObj(raw)) throw new Error('Invalid project payload')
    const project = store.createSessionProject(
      asString(raw.name, 'project name', 120),
      projectFolder(raw.defaultCwd),
      raw.appearance
    )
    pushState()
    return project
  })

  handle<unknown>('projects:rename', (raw) => {
    if (!isObj(raw)) throw new Error('Invalid project payload')
    const project = store.renameSessionProject(
      asString(raw.id, 'project id', 200),
      asString(raw.name, 'project name', 120),
      raw.defaultCwd == null ? undefined : projectFolder(raw.defaultCwd),
      raw.appearance
    )
    pushState()
    return project
  })

  handle<unknown>('projects:remove', (raw) => {
    const id = asString(raw, 'project id', 200)
    if (deps.projectSync?.snapshot().some((c) => c.projectId === id)) deps.projectSync.disconnect(id)
    deps.experience.removeProject(id)
    manager.clearSessionProject(id)
    const removed = store.removeSessionProject(id)
    pushState()
    return removed
  })

  // ── session lifecycle ────────────────────────────────────────────────────

  handle<unknown>('sessions:create', async (raw) => {
    const opts = asCreateSessionOptions(raw)
    // Project instructions apply to new agent prompts, never to a bare shell
    // (where prose would be executable input) or an already-running session.
    if (opts.sessionProjectId && opts.agent !== 'shell') {
      opts.initialPrompt = withProjectContext(opts.initialPrompt,
        deps.experience.snapshot().projectDetails[opts.sessionProjectId])
    }
    if (
      opts.sessionProjectId &&
      !store.sessionProjects.some((project) => project.id === opts.sessionProjectId)
    ) {
      throw new Error('That project no longer exists')
    }
    // The dialog normally fills this in, but launchers and integrations may
    // supply only a project. Resolve that default here too, before workspace
    // adoption, so those calls cannot silently start in the global home folder.
    if (opts.sessionProjectId && !opts.cwd && !opts.workspaceId) {
      opts.cwd = store.sessionProjects.find((project) => project.id === opts.sessionProjectId)!.defaultCwd
      if (!opts.cwd || !fs.statSync(opts.cwd).isDirectory()) throw new Error('Project folder is unavailable')
    }
    if (opts.workspaceId) {
      const ws = deps.workspaces.get(opts.workspaceId)
      // Refuse rather than fall back to the folder the user typed: silently
      // starting in the main checkout when isolation was asked for is exactly
      // the accident this whole feature exists to prevent.
      if (!ws) throw new Error('That workspace no longer exists')
      opts.cwd = ws.path
    } else if (opts.cwd) {
      // No workspace asked for still means the session belongs *somewhere*.
      // Adopting the folder is what lets the sidebar group by repository, and
      // it must happen here rather than in the dialog so that every route in —
      // palette, restore, a future scripted launch — is filed the same way.
      // The cwd is deliberately left as the user spelled it; only the filing
      // changes, so a symlinked path still starts where they pointed it.
      try {
        opts.workspaceId = (await deps.workspaces.adopt(opts.cwd)).id
      } catch {
        // Filing is a convenience; starting the session is the point. An
        // unreadable folder or a sick git is not a reason to refuse a launch
        // that would otherwise have worked before this feature existed.
      }
    }
    return manager.create(opts)
  })
  handle<unknown>('sessions:fork', (raw) => manager.fork(asForkOptions(raw)))
  handle<unknown>('sessions:handoff', (raw) => manager.handoff(asHandoffOptions(raw)))
  handle<unknown>('sessions:kill', (raw) => manager.kill(asSessionId(raw)))
  handle<unknown>('sessions:remove', (raw) => manager.remove(asSessionId(raw)))
  handle<unknown>('sessions:restart', (raw) => manager.restart(asSessionId(raw)))
  handle<unknown>('sessions:interrupt', (raw) => manager.interrupt(asSessionId(raw)))

  handle<unknown>('sessions:clearStatus', (raw) => {
    if (typeof raw === 'string') return manager.clearStatus(asSessionId(raw))
    if (!isObj(raw) || !isObj(raw.expected)) throw new Error('Invalid status acknowledgement')
    const status = raw.expected.status
    if (status !== 'waiting' && status !== 'review' && status !== 'failed') throw new Error('Invalid Inbox status')
    const changedAt = raw.expected.changedAt
    if (typeof changedAt !== 'number' || !Number.isSafeInteger(changedAt) || changedAt < 0) throw new Error('Invalid status timestamp')
    const reason = raw.expected.reason
    if (reason !== null && (typeof reason !== 'string' || reason.length > 16000)) throw new Error('Invalid status reason')
    // Dismissing the card the user saw must not acknowledge a newer request
    // that arrived while the click was travelling across the process boundary.
    return manager.clearStatus(asSessionId(raw.id), { status, changedAt, reason })
  })

  handle<unknown>('sessions:rename', (raw) => {
    if (!isObj(raw)) throw new Error('Invalid rename payload')
    manager.rename(asSessionId(raw.id), asString(raw.title, 'title', 400))
    return true
  })

  handle<unknown>('sessions:assignProject', (raw) => {
    if (!isObj(raw)) throw new Error('Invalid project assignment')
    const projectId = raw.projectId == null ? null : asString(raw.projectId, 'project id', 200)
    if (projectId && !store.sessionProjects.some((project) => project.id === projectId)) {
      throw new Error('That project no longer exists')
    }
    return manager.assignSessionProject(asSessionId(raw.id), projectId)
  })

  handle<unknown>('sessions:pin', (raw) => {
    if (!isObj(raw)) throw new Error('Invalid pin payload')
    manager.setPinned(asSessionId(raw.id), raw.pinned === true)
    return true
  })

  /**
   * Grants or revokes a session's Session Bus access.
   *
   * Checked on every bus call rather than baked into the agent's launch, so
   * revoking here takes effect on the target's very next tool call — including
   * one already in flight from an agent that was mid-turn.
   */
  handle<unknown>('sessions:busAccess', (raw) => {
    if (!isObj(raw)) throw new Error('Invalid bus-access payload')
    if (Object.keys(raw).some((key) => !['id', 'bus', 'projectId'].includes(key))) throw new Error('Unsupported bus-access field')
    const id = asSessionId(raw.id)
    const access = asBusAccess(raw.bus)
    if (access === 'manager' && !store.sessionProjects.some((p) => p.id === manager.get(id)?.sessionProjectId)) {
      throw new Error('Manager access requires an existing Workbench project.')
    }
    const projectId = access === 'manager' ? asString(raw.projectId, 'confirmed project', 200) : undefined
    if (access !== 'manager' && raw.projectId !== undefined) throw new Error('Only a Project Manager grant accepts a project binding.')
    const changed = manager.setBusAccess(id, access, projectId)
    if (changed) pushState()
    return changed
  })

  // ── input ────────────────────────────────────────────────────────────────

  /**
   * Broadcast entry point: the renderer decides the target set, we fan out and
   * report one outcome per recipient. A dead session comes back as a reported
   * failure, never as a silent no-op.
   */
  handle<unknown>('sessions:sendPrompt', async (raw) => {
    if (!isObj(raw)) throw new Error('Invalid prompt payload')
    const ids = asSessionIdList(raw.ids)
    const text = asString(raw.text, 'prompt')
    return manager.sendPromptMany(ids, text)
  })

  /**
   * Hands a prompt to one named session, optionally blocking until it answers.
   *
   * Separate from `sessions:sendPrompt` rather than a flag on it: a broadcast
   * reports N independent deliveries and never blocks, a relay reports one
   * conversation and may block for minutes. Folding them together would mean
   * every broadcast carried a timeout it never uses.
   */
  handle<RelayResult>('sessions:relay', async (raw) => {
    if (!isObj(raw)) throw new Error('Invalid relay payload')
    const to = asSessionId(raw.toSessionId, 'relay target')
    const from = raw.fromSessionId == null ? null : asSessionId(raw.fromSessionId, 'relay sender')
    return manager.sendRelay({
      fromSessionId: from,
      toSessionId: to,
      message: asString(raw.message, 'relay message'),
      wait: raw.wait === true,
      timeoutMs: asInt(raw.timeoutMs ?? RELAY_DEFAULT_TIMEOUT_MS, 'relay timeout', 1000, RELAY_MAX_TIMEOUT_MS)
    })
  })

  // ── sharing ──────────────────────────────────────────────────────────────

  /**
   * Starts sharing a session and brings up public reach for it.
   *
   * The share exists the moment this returns, on a local URL. The tunnel is
   * raced separately and swaps the origin in when it lands, so the host is
   * never staring at a spinner waiting for someone else's network — and a
   * machine with no `cloudflared` still gets a working link on its own network
   * instead of an error.
   */
  handle<Share>('share:start', async (raw) => {
    const id = asSessionId(raw, 'session')
    if (!manager.get(id)) throw new Error('Session no longer exists')
    const created = share.create(id)
    if (tunnel.state.status === 'off') {
      void tunnel.start(share.port).then((state) => {
        if (state.status === 'up') share.setOrigin(state.url, 'tunnel')
        pushState()
      })
    } else if (tunnel.state.status === 'up') {
      share.setOrigin(tunnel.state.url, 'tunnel')
    }
    pushState()
    return share.get(id) ?? created
  })

  handle<null>('share:stop', async (raw) => {
    share.destroy(asSessionId(raw, 'session'))
    // The tunnel is per-app, not per-share: the last share going away is what
    // takes it down, so two shares do not each spawn their own.
    if (share.list().length === 0) tunnel.stop()
    pushState()
    return null
  })

  handle<Share[]>('share:list', async () => share.list())

  // ── the context shelf ────────────────────────────────────────────────────

  handle<unknown>('shelf:list', async () => shelf.list())

  /**
   * Saves the focused session's conversation under a name.
   *
   * The transcript is written by the agent, not by us, so a session that has
   * not been spoken to yet has no file — which is a sentence the user can act
   * on, not an error.
   */
  handle<unknown>('shelf:save', async (raw) => {
    if (!isObj(raw)) throw new Error('Bad request')
    const id = asSessionId(raw.sessionId, 'sessionId')
    const session = manager.get(id)
    if (!session) throw new Error('Session no longer exists')
    if (!session.agentSessionId) {
      throw new Error('This session has no transcript yet — send it a message first.')
    }
    const saved = shelf.save({
      name: toCheckpointName(String(raw.name ?? '')),
      note: typeof raw.note === 'string' ? raw.note : '',
      cwd: session.cwd,
      agentSessionId: session.agentSessionId
    })
    pushState()
    return saved
  })

  /**
   * Opens a checkpoint as a new session.
   *
   * Always a fork: `shelf.fork` mints a fresh agent session id so the saved
   * copy is never the live one, and the same checkpoint can be opened again
   * tomorrow, or by two people at once, from the same starting state.
   */
  handle<unknown>('shelf:open', async (raw) => {
    if (!isObj(raw)) throw new Error('Bad request')
    const name = String(raw.name ?? '')
    const meta = shelf.get(name)
    if (!meta) throw new Error('That checkpoint is gone.')
    const cwd = typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : store.prefs.defaultCwd
    const resumeAgentSessionId = shelf.fork(name, cwd || meta.originCwd)
    const session = await manager.create({
      agent: 'claude',
      cwd: cwd || meta.originCwd,
      title: name,
      resumeAgentSessionId
    })
    pushState()
    return session
  })

  handle<unknown>('shelf:export', async (raw) => {
    if (!isObj(raw)) throw new Error('Bad request')
    const name = String(raw.name ?? '')
    if (!shelf.get(name)) throw new Error('That checkpoint is gone.')
    const win = deps.getWindow()
    const res = await dialog.showSaveDialog(win ?? undefined!, {
      title: 'Send this checkpoint',
      defaultPath: `${name}.ctx.jsonl`,
      filters: [{ name: 'Context bundle', extensions: ['jsonl'] }]
    })
    if (res.canceled || !res.filePath) return null
    return shelf.exportBundle(name, res.filePath)
  })

  handle<unknown>('shelf:import', async () => {
    const win = deps.getWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Put a checkpoint on your shelf',
      properties: ['openFile'],
      filters: [{ name: 'Context bundle', extensions: ['jsonl'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return null
    const added = shelf.importBundle(res.filePaths[0])
    pushState()
    return added
  })

  handle<unknown>('shelf:relabel', async (raw) => {
    if (!isObj(raw)) throw new Error('Bad request')
    const from = String(raw.name ?? '')
    const renamed = shelf.relabel(from, {
      name: typeof raw.nextName === 'string' && raw.nextName ? toCheckpointName(raw.nextName) : undefined,
      note: typeof raw.note === 'string' ? raw.note : undefined
    })
    pushState()
    return renamed
  })

  handle<unknown>('shelf:remove', async (raw) => {
    if (!isObj(raw)) throw new Error('Bad request')
    shelf.remove(String(raw.name ?? ''))
    pushState()
    return null
  })

  /**
   * Grants or revokes typing for one guest.
   *
   * Host-only by construction — there is no guest-facing route that reaches
   * this, because a guest able to promote themselves is the whole threat.
   */
  handle<Share | null>('share:setCanType', async (raw) => {
    if (!isObj(raw)) throw new Error('Invalid payload')
    const id = asSessionId(raw.sessionId, 'session')
    share.setCanType(id, asString(raw.guestId, 'guest id', 64), raw.canType === true)
    pushState()
    return share.get(id)
  })

  handle<Share | null>('share:kick', async (raw) => {
    if (!isObj(raw)) throw new Error('Invalid payload')
    const id = asSessionId(raw.sessionId, 'session')
    share.kick(id, asString(raw.guestId, 'guest id', 64))
    pushState()
    return share.get(id)
  })

  // ── terminal plumbing ────────────────────────────────────────────────────

  on('pty:write', (raw) => {
    if (!isObj(raw)) return
    manager.write(asSessionId(raw.id), asString(raw.data, 'keystrokes', 1_000_000))
  })

  on('pty:attach', (raw) => {
    if (!isObj(raw)) return
    manager.attach(
      asSessionId(raw.id),
      asInt(raw.cols, 'cols', 20, 1000),
      asInt(raw.rows, 'rows', 5, 500)
    )
  })

  on('pty:detach', (raw) => {
    manager.detach(asSessionId(raw))
  })

  on('pty:resize', (raw) => {
    if (!isObj(raw)) return
    manager.resize(
      asSessionId(raw.id),
      asInt(raw.cols, 'cols', 20, 1000),
      asInt(raw.rows, 'rows', 5, 500)
    )
  })

  // ── introspection & escape hatches ───────────────────────────────────────

  /** The command that lets the user take a session over from iTerm2. */
  handle<unknown>('sessions:attachCommand', (raw) => manager.attachCommand(asSessionId(raw)))

  handle<unknown>('sessions:exportTranscript', (raw) => manager.exportTranscript(asSessionId(raw)))

  handle<unknown>('sessions:capture', (raw) => {
    if (!isObj(raw)) throw new Error('Invalid capture payload')
    const lines = raw.lines === undefined ? 4000 : asInt(raw.lines, 'lines', 1, 100_000)
    return manager.captureText(asSessionId(raw.id), lines)
  })

  handle<unknown>('sessions:revealLog', async (raw) => {
    const p = manager.logPathFor(asSessionId(raw))
    shell.showItemInFolder(p)
    return p
  })

  handle<unknown>('sessions:openCwd', async (raw) => {
    const s = manager.get(asSessionId(raw))
    if (!s) throw new Error('Unknown session')
    await shell.openPath(s.cwd)
    return s.cwd
  })

  handle<void>('logs:delete', () => {
    const removed = manager.deleteLogs()
    return removed
  })

  // ── preview dock ─────────────────────────────────────────────────────────

  /**
   * "Show me what you just made." Every route into the pane — the recents
   * list, a drop, a link inside a rendered document, the Open dialog — ends
   * here, so one place decides what may be read and what it is allowed to reach.
   */
  handle<unknown>('preview:open', (raw) => {
    const doc = deps.preview.open(asAbsolutePath(raw))
    if (store.prefs.previewFollowFile) deps.preview.watch(doc.path)
    else deps.preview.unwatch()
    return doc
  })

  /**
   * A visual pane reads through the same containment gate, but does not claim
   * the preview dock's one live watcher. Its revision comes from the session's
   * explicit `workbench show` or turn-completion event instead.
   */
  handle<unknown>('visual:open', (raw) => deps.preview.open(asAbsolutePath(raw)))

  /** Wraps a body the renderer rendered into a document, and returns its URL. */
  handle<unknown>('preview:document', (raw) => deps.preview.documentUrl(asPreviewDocumentRequest(raw)))

  /** The candidate list an empty pane shows: what changed here most recently. */
  handle<unknown>('preview:recent', (raw) => {
    if (!isObj(raw)) throw new Error('Invalid recents payload')
    const limit = raw.limit === undefined ? 40 : asInt(raw.limit, 'limit', 1, 200)
    return deps.preview.recent(asAbsolutePath(raw.dir, 'folder'), limit)
  })

  handle<unknown>('preview:watch', (raw) => {
    if (raw === null) {
      deps.preview.unwatch()
      return true
    }
    deps.preview.watch(asAbsolutePath(raw))
    return true
  })

  /** Hands the file to whatever the OS opens it with — the escape hatch. */
  handle<unknown>('preview:openInDefaultApp', async (raw) => {
    const file = deps.preview.assertReadable(asAbsolutePath(raw))
    return openWithSystem(file, (target) => shell.openPath(target))
  })

  handle<unknown>('preview:revealInFolder', (raw) => {
    const file = deps.preview.assertReadable(asAbsolutePath(raw))
    shell.showItemInFolder(file)
    return file
  })

  handle<unknown>('preview:saveCopy', (raw) => savePreviewCopy(
    asAbsolutePath(raw),
    (file) => deps.preview.assertReadable(file),
    async (source) => {
      const win = deps.getWindow()
      if (!win || win.isDestroyed()) throw new Error('The Workbench window is no longer open')
      const result = await dialog.showSaveDialog(win, {
        title: 'Save a copy',
        buttonLabel: 'Save copy',
        defaultPath: path.join(app.getPath('downloads'), path.basename(source)),
        properties: ['createDirectory', 'showOverwriteConfirmation']
      })
      return result.canceled ? null : result.filePath ?? null
    }
  ))

  // Native file dragging carries a filesystem file, not the wb-preview URL.
  // The renderer can only drag a file the preview gate already allows; the
  // same top-level sender check applies as for Open and Save. Use the bundled
  // small app icon so starting a drag never decodes a large generated image.
  handle<unknown>('preview:startDrag', (raw, event) => {
    const file = deps.preview.assertReadable(asAbsolutePath(raw))
    const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'resources', 'icon.png'))
    if (icon.isEmpty()) throw new Error('The file drag icon is unavailable. Use Save a copy instead.')
    event.sender.startDrag({ file, icon: icon.resize({ width: 32, height: 32 }) })
    return true
  })

  // ── git review ───────────────────────────────────────────────────────────

  /**
   * Every handler here is addressed by session, never by directory: the
   * renderer names a session it can already see, and main looks up where that
   * session is running. There is no path in any of these payloads that git is
   * asked to run *in*.
   */
  /**
   * What this session's project knows how to run.
   *
   * Session-addressed like every git call: the payload names a session, and
   * the directory comes off the session record here. A caller cannot ask for
   * the scripts in a directory it was never given.
   */
  handle<unknown>('project:scripts', (raw) => {
    const session = manager.get(asSessionId(raw))
    return session ? readScripts(session.cwd) : []
  })

  /**
   * The sidebar's file tree and project search.
   *
   * Session-addressed for the same reason git is, and with the same
   * consequence: the payload's `rel` can only ever narrow the session's own
   * folder, never leave it. The explicit Open action uses the same boundary
   * for files and folders, including files the preview cannot render.
   */
  handle<unknown>('files:list', (raw) => {
    const { sessionId, rel } = asFolderRequest(raw)
    const session = manager.get(sessionId)
    if (!session) throw new Error('Unknown session')
    return listDir(session.cwd, rel)
  })

  handle<unknown>('files:open', async (raw) => {
    const { sessionId, rel } = asFolderRequest(raw)
    const session = manager.get(sessionId)
    if (!session) throw new Error('Unknown session')
    const file = await resolveInside(session.cwd, rel)
    const stat = await fs.promises.stat(file)
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('Choose a file or folder')
    return openWithSystem(file, (target) => shell.openPath(target))
  })

  handle<unknown>('files:search', (raw) => {
    const { sessionId, query, caseSensitive } = asSearchRequest(raw)
    const session = manager.get(sessionId)
    if (!session) throw new Error('Unknown session')
    return searchFiles(session.cwd, query, { caseSensitive })
  })

  handle<unknown>('git:status', (raw) => deps.review.status(asSessionId(raw)))

  handle<unknown>('git:diff', (raw) => deps.review.diff(asDiffQuery(raw)))

  handle<unknown>('git:stage', async (raw) => {
    const { sessionId, paths } = asPathBatch(raw)
    await deps.review.stage(sessionId, paths)
    return true
  })

  handle<unknown>('git:unstage', async (raw) => {
    const { sessionId, paths } = asPathBatch(raw)
    await deps.review.unstage(sessionId, paths)
    return true
  })

  handle<unknown>('git:commit', (raw) => {
    if (!isObj(raw)) throw new Error('Invalid commit payload')
    return deps.review.commit(asSessionId(raw.sessionId), asString(raw.message, 'message', 20_000))
  })

  /**
   * The only outward-facing call in the app.
   *
   * It is a plain handler with no confirmation of its own because the
   * confirmation belongs where the user is: the panel spells out the remote and
   * branch and makes you click twice. Adding a second dialog here would not add
   * a second decision.
   */
  handle<unknown>('git:push', (raw) => deps.review.push(asSessionId(raw)))

  /**
   * "Review this diff" — the feature the panel exists for.
   *
   * The patch is written to a file and a child session is forked with a prompt
   * pointing at it, so the reviewer inherits the parent's context *and* gets
   * the change stated explicitly rather than having to reconstruct it.
   */
  handle<unknown>('git:reviewDiff', async (raw) => {
    if (!isObj(raw)) throw new Error('Invalid review payload')
    const query = asDiffQuery(raw.query)
    const { prompt, empty } = await deps.review.patchFileFor(query)
    if (empty) throw new Error('There is nothing to review — that diff is empty.')
    return manager.fork({
      sourceId: query.sessionId,
      kind: 'child',
      targetAgent: raw.agent === undefined ? undefined : asAgentKind(raw.agent),
      initialPrompt: prompt
    })
  })

  // ── host services ────────────────────────────────────────────────────────

  handle<unknown>('dialog:pickFolder', async (raw) => {
    const opts = isObj(raw) ? raw : {}
    const win = deps.getWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      title: typeof opts.title === 'string' ? opts.title : 'Choose a working directory',
      defaultPath:
        typeof opts.defaultPath === 'string' ? opts.defaultPath : store.prefs.defaultCwd,
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  /** The Open dialog behind the preview pane's toolbar. */
  handle<unknown>('dialog:pickFile', async (raw) => {
    const opts = isObj(raw) ? raw : {}
    const win = deps.getWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Open a document in the preview',
      defaultPath:
        typeof opts.defaultPath === 'string' ? opts.defaultPath : store.prefs.defaultCwd,
      properties: ['openFile'],
      // Grouped rather than restrictive — "All files" stays available, because
      // an extension the classifier does not know is a better error message
      // than a file that cannot be selected.
      filters: [
        { name: 'Documents', extensions: [...PREVIEW_EXTENSIONS] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  // ── usage meters ─────────────────────────────────────────────────────────

  // The meter refreshes itself on a timer; this is the "check now" path, for
  // when you have just burned a lot of quota and do not want to wait for it.
  handle<void>('usage:refresh', () => deps.refreshUsage())

  // ── attachments ──────────────────────────────────────────────────────────

  /**
   * "Show it what I see." Both channels return paths, which the renderer types
   * into the agent's composer — Claude and Codex read images and files from
   * disk, so a path is the whole interface.
   */
  handle<void>('attachments:fromClipboard', () => deps.attachments.fromClipboard(deps.clipboard))

  handle<unknown>('attachments:adopt', (raw) => {
    if (!isObj(raw)) throw new Error('Invalid attachment payload')
    return deps.attachments.adoptAll(asDroppedFiles(raw.files))
  })

  handle<unknown>('clipboard:write', async (raw) => {
    await deps.clipboard.writeText(asString(raw, 'clipboard text', 5_000_000))
    return true
  })

  handle<void>('clipboard:read', () => deps.clipboard.readText())
  handle<void>('dictation:status', () => flowStatus())
  handle<void>('dictation:openFlow', () => openFlow(target => shell.openPath(target)))
  handle<unknown>('dictation:files', (raw) => {
    const session = manager.get(asSessionId(raw))
    if (!session) throw new Error('Unknown session')
    return dictationFiles(session.cwd)
  })

  handle<unknown>('shell:openExternal', async (raw) => {
    await shell.openExternal(asSafeExternalUrl(raw))
    return true
  })

  handle<void>('app:openDataDir', async () => {
    await shell.openPath(deps.dataDir)
    return deps.dataDir
  })

  handle<void>('app:openHandoffDir', async () => {
    const p = path.join(deps.dataDir, 'handoffs')
    await shell.openPath(p)
    return p
  })
}
