/**
 * Workbench main process.
 *
 * Wires together: the tmux backend, the hook bridge that colours sessions, the
 * menu bar status item, native notifications, the global hotkey window, and the
 * IPC surface the renderer talks to.
 */

import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  nativeImage,
  protocol,
  shell,
  dialog,
  clipboard
} from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { UpdateService, readUpdateJSON, downloadUpdate } from './updates.js'
import { UpdatePlatformAdapter } from './updatePlatform.js'
import { fileURLToPath } from 'node:url'

import { Tmux, resolveTmuxBinary, TMUX_SOCKET } from './tmux.js'
import { HookBridge } from './hooks.js'
import { SessionBus } from './bus.js'
import { Store } from './store.js'
import { ProjectSync, GitHubSyncRemote } from './projectSync.js'
import { Experience } from './experience.js'
import { Services } from './services.js'
import { emptyExperience } from '../shared/experience.js'
import { SessionManager, type NotifyRequest } from './sessions.js'
import { resolveLoginPath, findExecutable, probeVersion, loginShell } from './agents.js'
import {
  findNativeExecutable,
  hostDataDir,
  hostFileExists,
  hostHomeNative,
  hostKind,
  installHint,
  toNativePath
} from './host.js'
import { AttachmentStore } from './attachments.js'
import { WorkspaceManager } from './workspaces.js'
import { runGit } from './git.js'
import { trayIconPng } from './icon.js'
import { registerIpc } from './ipc.js'
import { PreviewServer, isInsideRoot } from './preview.js'
import { ShareServer } from './share.js'
import { Tunnel } from './tunnel.js'
import type { TunnelState } from '../shared/share.js'
import { ContextShelf } from './shelf.js'
import { GitReview } from './review.js'
import { NotificationManager } from './notifications.js'
import { UsageMonitor } from './usage.js'
import { emptyReport } from '../shared/usage.js'
import { usageDeps } from './usageSource.js'
import { isSafeExternalUrl } from './validate.js'
import { withProjectContext } from '../shared/experience.js'
import { PREVIEW_SCHEME, classifyPreview, pathFromPreviewUrl } from '../shared/preview.js'
import { isLoopbackUrl } from '../shared/localhost.js'
import { allDefinitions } from '../shared/agents.js'
import { hasVisualPane } from '../shared/visual.js'
import type { AgentDefinition } from '../shared/agents.js'
import type {
  AppState,
  EnvReport,
  AgentProfile,
  PreviewEntry,
  StatusCounts,
  SessionStatus
} from '../shared/types.js'

const __dirname_ = path.dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

let store: Store
let experience: Experience | null = null
let services: Services | null = null
let projectSync: ProjectSync | null = null
let updates: UpdateService | null = null
let nativeUpdateQuit = false
let tmux: Tmux
let hooks: HookBridge
let bus: SessionBus | null = null
let manager: SessionManager
let notifications: NotificationManager
let attachments: AttachmentStore
let workspaces: WorkspaceManager
let preview: PreviewServer
let share: ShareServer
let tunnel: Tunnel
let shelf: ContextShelf
let usage: UsageMonitor | null = null
let envReport: EnvReport
let profiles: AgentProfile[] = []
let loginPath = ''
/** Non-null when the configured hotkey could not be claimed; shown in Settings. */
let hotkeyError: string | null = null

/**
 * The data directory has to be settled before anything reads it.
 *
 * Electron derives `userData` from the app name, and the app name is
 * `package.json`'s until `setName` runs. Calling `setName` later — after ready,
 * where it looks natural — leaves this constant pointing at the old directory,
 * so the app silently keeps two homes. Doing both on the same two lines at
 * module scope is the only ordering that cannot drift apart later.
 */
app.setName('Workbench')

/**
 * Windows ties a running process to its Start Menu shortcut by AppUserModelID,
 * and that link is what makes a toast attributable — without it the Action
 * Center has nothing to file a notification under and silently drops it, while
 * `Notification.isSupported()` still answers true. Set before any window or
 * notification exists, because Windows reads it when the first one is created.
 * A no-op everywhere else.
 */
app.setAppUserModelId('com.keeganarko.workbench')

/**
 * Where Workbench keeps its own state.
 *
 * On macOS and Linux this is exactly Electron's `userData` and always has
 * been. On Windows it moves into the WSL distro, because half of what lives
 * here is not data at all — it is things the *host* has to open: the generated
 * `tmux.conf`, the hook shims tmux execs, the Session Bus script an agent
 * loads as an MCP server, the per-session logs `pipe-pane` appends to, and the
 * git worktrees sessions run in. WSL cannot write anywhere under
 * `C:\Users\…` — measured, EACCES even on a directory it owns — so leaving
 * them in `%APPDATA%` would put every one of them out of reach.
 *
 * The value is a *native* path either way (see the rule in `host.ts`), so
 * every `fs` call below is unchanged; Windows simply reaches the distro over
 * UNC, which it can read, write and stat.
 */
const appData = hostDataDir(app.getPath('userData'))

/**
 * The preview pane's scheme, claimed before the app is ready because Chromium
 * fixes the properties of a scheme once, at startup.
 *
 * `standard` is what makes an absolute path usable as a URL path, so a relative
 * link inside a rendered document resolves the way it does on disk. `secure`
 * keeps a document served here from being treated as mixed content by its own
 * subresources. It is deliberately *not* `bypassCSP`: the policy each preview
 * document is served with is the thing keeping it inert.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: PREVIEW_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
])

/**
 * Names this app has had, newest first, with the store file each one wrote.
 */
const LEGACY_DATA_DIRS = [{ dir: 'Terminal', store: 'terminal.json' }]

/**
 * Carries the data directory over from a previous app name, once.
 *
 * `userData` is derived from the app name, so a rename strands everything:
 * sessions, agent profiles, triggers, logs, Codex lifecycle logs, handoff
 * transcripts, and the record of which worktrees we created — which is the only
 * thing standing between a rename and a folder of orphaned checkouts nobody
 * will ever be able to clean up through the app again.
 *
 * Move the whole directory rather than copying the store file out of it, which
 * is all the previous rename had to do. `rename` keeps the inodes, so a
 * `pipe-pane` holding a log open follows it to the new home instead of writing
 * into a file nothing will ever read again.
 *
 * Absolute paths recorded inside the store still name the old directory, so
 * they are rewritten in the same pass. The rewrite runs over the *parsed*
 * document rather than the serialised text: the textual form of a separator is
 * not the separator. On POSIX it happens to be — `/` is never escaped — but a
 * Windows `\` is written `\\` inside a JSON string, so a textual search for
 * `…\Terminal\` matches nothing, and a search that half-matched would emit a
 * document that no longer parses. Matching the trailing separator still keeps a
 * sibling directory that merely starts with the same name out of it.
 */
function migrateLegacyDataDir(dir: string): void {
  const store = path.join(dir, 'workbench.json')
  if (fs.existsSync(store)) return

  for (const legacy of LEGACY_DATA_DIRS) {
    const from = path.join(path.dirname(dir), legacy.dir)
    if (from === dir || !fs.existsSync(path.join(from, legacy.store))) continue
    try {
      // `rename` will not overwrite a directory that has anything in it, and an
      // empty one here is just Electron having touched the path first.
      if (fs.existsSync(dir)) fs.rmdirSync(dir)
      fs.renameSync(from, dir)
      fs.renameSync(path.join(dir, legacy.store), store)
      const doc = JSON.parse(fs.readFileSync(store, 'utf8')) as unknown
      fs.writeFileSync(store, JSON.stringify(rehome(doc, from + path.sep, dir + path.sep)), {
        mode: 0o600
      })
    } catch {
      // Starting with defaults beats refusing to start.
    }
    return
  }
}

/**
 * Rewrites every string in a parsed JSON value that starts with `from`.
 *
 * Only a prefix match, and only on strings: a path recorded in the store is
 * always absolute, so anything that does not begin with the old directory is
 * not a path into it and must be left exactly as it was.
 */
function rehome(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value.startsWith(from) ? to + value.slice(from.length) : value
  if (Array.isArray(value)) return value.map((v) => rehome(v, from, to))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Keys are paths too — the store indexes worktrees and projects by
      // directory — so a rename that skipped them would strand the entries.
      out[rehome(k, from, to) as string] = rehome(v, from, to)
    }
    return out
  }
  return value
}

migrateLegacyDataDir(appData)

// ── window ──────────────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  // Not "is Linux" — "is not macOS". `hiddenInset` and `trafficLightPosition`
  // are macOS-only, and Windows given them ends up with the native title bar
  // *and* Workbench's own stacked below it, plus a strip of empty inset
  // reserved for traffic lights that will never be drawn.
  const ownChrome = process.platform !== 'darwin'
  const appIcon = path.join(app.getAppPath(), 'resources', 'icon.png')
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 820,
    minHeight: 520,
    show: false,
    backgroundColor: '#1a1a1a',
    // WSLg is a Linux compositor, even though the window lands on a Windows
    // desktop. `hiddenInset` is macOS chrome; asking Linux for it leaves GTK's
    // title bar and border wrapped around our own title bar. Workbench already
    // owns that chrome, so Linux is frameless and supplies its controls in the
    // renderer. The explicit icon also keeps WSLg from falling back to the
    // distribution's penguin for an unpackaged development window.
    ...(ownChrome
      ? { frame: false, icon: fs.existsSync(appIcon) ? appIcon : undefined }
      : {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 14 }
        }),
    webPreferences: {
      preload: path.join(__dirname_, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // Chromium's built-in PDF viewer, which is what shows a PDF in the
      // preview pane. `plugins` no longer means anything else — the external
      // plugin machinery it used to gate has been gone for years.
      plugins: true
    }
  })

  /**
   * Reveal the window, whatever happens.
   *
   * `show: false` until `ready-to-show` is the standard way to avoid a flash of
   * unpainted window, and it is fine right up until the first frame never
   * arrives. Under WSLg it sometimes does not: the GPU process fails
   * initialisation and gets respawned, and a window whose compositor handshake
   * lost that race can sit at `show: false` forever with a perfectly healthy
   * renderer behind it.
   *
   * The reason that is worth a timer rather than a bug report: nothing about it
   * looks like a failure. There is no crash, no error dialog, and the process
   * stays up holding the single-instance lock — so every later attempt to open
   * Workbench is answered by `second-instance` on the invisible window and also
   * appears to do nothing. The app is simply gone, with a full process tree
   * still running. That is the "it will not launch" report.
   *
   * So `ready-to-show` stays the fast path, and the timer is the floor: a
   * window that has not shown itself within a second gets shown regardless. The
   * worst case is the flash of unpainted background that `show: false` existed
   * to avoid, which is a far better outcome than an app that never appears.
   */
  let shown = false
  const reveal = (why: string): void => {
    if (shown || win.isDestroyed()) return
    shown = true
    if (why !== 'ready-to-show') console.warn(`[window] revealed by ${why}`)
    win.show()
  }
  win.on('ready-to-show', () => reveal('ready-to-show'))
  const revealTimer = setTimeout(() => reveal('fallback timer'), 1000)
  win.on('closed', () => clearTimeout(revealTimer))

  const devUrl = process.env.ELECTRON_RENDERER_URL

  // Agent output is rendered in this window, so a link in a transcript is
  // untrusted input. Only http/https/mailto ever reach the OS, and nothing
  // opens a second Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // The window itself must stay on our own UI: navigating it away would run
  // foreign script against the same preload bridge.
  win.webContents.on('will-navigate', (event, url) => {
    const here = devUrl ?? `file://${path.join(__dirname_, '../renderer/index.html')}`
    if (url === win.webContents.getURL() || url === here) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })

  /**
   * The preview frame is the one child frame this window has, and it shows
   * files an agent wrote — so a link inside it is untrusted input.
   *
   * Three outcomes, and no fourth: a document we generated or a file the pane
   * renders directly loads in place; a web link goes to the OS browser; a link
   * to some other local document is bounced back to the renderer, which opens
   * it *rendered* rather than letting the frame display raw source.
   */
  win.webContents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return // `will-navigate` above owns that case
    let isPreviewFrame = false
    try {
      isPreviewFrame = details.frame?.parent === win.webContents.mainFrame
    } catch {
      // A frame that detached mid-navigation is not one we need to allow.
    }
    if (!isPreviewFrame) return // an iframe an artifact made is its own business

    const target = pathFromPreviewUrl(details.url)
    if (target) {
      const kind = classifyPreview(target)
      // Kinds the frame can display as-is; everything else needs rendering.
      if (kind === 'html' || kind === 'pdf' || kind === 'image' || kind === 'svg') return
      details.preventDefault()
      win.webContents.send('preview:navigate', target)
      return
    }
    if (details.url.startsWith(`${PREVIEW_SCHEME}://`)) return // a generated document

    // A local dev server previewed in the pane is a live page, so its own
    // links and client-side routing have to work. Only loopback: the moment
    // the page navigates off this machine it is an external link like any
    // other, and goes to the browser. `isLoopbackUrl` is the same function the
    // renderer checks before ever setting the frame's src, and the same set
    // the renderer's `frame-src` names.
    if (isLoopbackUrl(details.url)) return

    details.preventDefault()
    if (isSafeExternalUrl(details.url)) void shell.openExternal(details.url)
  })

  // Nothing in this app needs a WebView of its own.
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(path.join(__dirname_, '../renderer/index.html'))

  return win
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
    wireWindowEvents(mainWindow)
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  // `focus()` is a request, and a compositor is free to decline it — which is
  // what happens when the ask comes from a launcher click rather than from the
  // user touching this window. Declining leaves Workbench behind whatever is in
  // front of it, so clicking the icon of a running app appears to do nothing.
  // `moveTop` is the part that actually raises it.
  mainWindow.moveTop()
  mainWindow.focus()
}

function wireWindowEvents(win: BrowserWindow): void {
  win.on('closed', () => {
    mainWindow = null
  })
  win.on('focus', () => win.webContents.send('window:focus', true))
  win.on('blur', () => win.webContents.send('window:focus', false))
}

// ── tray ────────────────────────────────────────────────────────────────────

/**
 * The status item the user asked for: a live tally of green (done), red (waiting
 * on you) and yellow (still running) sessions, with a menu that jumps straight
 * to whichever session needs attention.
 */
function buildTray(): void {
  const img = nativeImage.createFromBuffer(trayIconPng(path.join(app.getAppPath(), 'resources'), 1))
  const img2x = nativeImage.createFromBuffer(trayIconPng(path.join(app.getAppPath(), 'resources'), 2))
  img.addRepresentation({ scaleFactor: 2, buffer: img2x.toPNG() })
  // A template image is a macOS menu-bar convention: the system recolours the
  // mask for light and dark menu bars. Windows and Linux draw the mask itself,
  // which comes out as a flat silhouette, so they keep the real icon.
  if (process.platform === 'darwin') img.setTemplateImage(true)

  tray = new Tray(img)
  tray.setToolTip('Workbench')
  tray.on('click', () => {
    if (mainWindow?.isVisible() && mainWindow.isFocused()) mainWindow.hide()
    else showWindow()
  })
  refreshTray()
}

function refreshTray(): void {
  if (!tray) return
  const counts = manager.counts()
  // Emoji dots render in colour in the macOS menu bar, which is the clearest
  // way to show separate tallies in a narrow strip. `failed` only appears when
  // it is non-zero — a permanent ⛔0 would train you to ignore it.
  const failed = counts.failed > 0 ? ` ⛔${counts.failed}` : ''
  // `setTitle` is macOS-only and a silent no-op elsewhere, which would quietly
  // remove the one thing that makes the tray worth having: the tally you can
  // read without switching to the app. Everywhere else the tooltip below
  // carries it, and Windows also gets the count as a taskbar overlay badge.
  if (process.platform === 'darwin') {
    tray.setTitle(` 🔴${counts.waiting} 🟡${counts.working} 🟢${counts.review}${failed}`)
  }
  tray.setToolTip(
    `Workbench — ${counts.waiting} waiting on you · ${counts.working} working · ${counts.review} to review${
      counts.failed > 0 ? ` · ${counts.failed} failed` : ''
    }`
  )
  tray.setContextMenu(buildTrayMenu(counts))

  // The Dock already bounces when a session goes red, but a bounce is a moment
  // and the badge is a standing count — it is what tells you, from another app,
  // whether coming back is worth it. Blocked sessions only: a badge that also
  // counted finished turns would never reach zero.
  const blocked = counts.waiting + counts.failed
  app.dock?.setBadge(blocked > 0 ? String(blocked) : '')
  setTaskbarBadge(blocked)
}

/**
 * The Windows answer to the Dock badge.
 *
 * Windows has no per-app badge API; the equivalent is a small image drawn over
 * the taskbar button, and it is the app's job to render the number into it.
 * Drawn as an SVG data URL rather than a bitmap because the taskbar overlay is
 * 16pt but rendered at the display's scale factor, and a scaled-up 16px PNG of
 * a two-digit count is unreadable.
 *
 * The overlay is cleared, not hidden, when nothing is blocked — a stale "3"
 * left on the taskbar is worse than no badge at all.
 */
let overlayCount = -1
function setTaskbarBadge(blocked: number): void {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return
  // Redrawing on every status poll makes the taskbar flicker on some shells.
  if (blocked === overlayCount) return
  overlayCount = blocked

  if (blocked <= 0) {
    mainWindow.setOverlayIcon(null, '')
    return
  }
  const text = blocked > 99 ? '99+' : String(blocked)
  const size = text.length > 2 ? 9 : text.length > 1 ? 11 : 13
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">` +
    `<circle cx="16" cy="16" r="15" fill="#e5484d"/>` +
    `<text x="16" y="16" fill="#fff" font-family="Segoe UI,sans-serif" font-size="${size * 1.6}"` +
    ` font-weight="600" text-anchor="middle" dominant-baseline="central">${text}</text></svg>`
  const img = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
  mainWindow.setOverlayIcon(
    img.isEmpty() ? null : img,
    `${blocked} session${blocked === 1 ? '' : 's'} waiting on you`
  )
}

function buildTrayMenu(counts: StatusCounts): Menu {
  const sessions = manager.list()
  const group = (status: SessionStatus): Electron.MenuItemConstructorOptions[] =>
    sessions
      .filter((s) => s.status === status)
      .slice(0, 12)
      .map((s) => ({
        label: `${s.title}${s.statusReason ? ` — ${s.statusReason.slice(0, 48)}` : ''}`,
        click: () => focusSession(s.id)
      }))

  const section = (
    label: string,
    status: SessionStatus
  ): Electron.MenuItemConstructorOptions[] => {
    const items = group(status)
    if (items.length === 0) return []
    return [{ type: 'separator' }, { label, enabled: false }, ...items]
  }

  return Menu.buildFromTemplate([
    { label: `Workbench — ${counts.total} session${counts.total === 1 ? '' : 's'}`, enabled: false },
    ...section(`🔴 Waiting on you (${counts.waiting})`, 'waiting'),
    ...section(`⛔ Failed (${counts.failed})`, 'failed'),
    ...section(`🟡 Working (${counts.working})`, 'working'),
    ...section(`🟢 Ready to review (${counts.review})`, 'review'),
    { type: 'separator' },
    { label: 'Open Workbench', click: () => showWindow() },
    ...profiles
      .filter((p) => p.available && p.id !== 'shell')
      .map((p) => ({
        label: `New ${p.label} session`,
        click: (): void => {
          showWindow()
          mainWindow?.webContents.send('menu:new-session', p.id)
        }
      })),
    { type: 'separator' },
    { label: 'Quit Workbench', role: 'quit' }
  ])
}

// ── notifications ───────────────────────────────────────────────────────────

/**
 * Raise the window and land on one exact session. Everything that says "go
 * look at this" — a tray entry, a notification click — goes through here, so
 * they cannot drift apart.
 */
function focusSession(sessionId: string): void {
  showWindow()
  mainWindow?.webContents.send('focus-session', sessionId)
}

function buildNotifications(): NotificationManager {
  return new NotificationManager({
    // Per-pane, not per-window: a banner about session B is exactly what you
    // need while you are heads-down in session A.
    isPaneFocused: (sessionId) =>
      !!mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.isFocused() &&
      manager.isFocused(sessionId),
    suppressWhenFocused: () => store.prefs.notifyOnlyWhenUnfocused,
    silent: () => !store.prefs.notifySound,
    focusSession,
    // Bounce the Dock until the user looks — red means blocked, after all.
    onWaiting: () => {
      if (process.platform === 'darwin') app.dock?.bounce('informational')
    }
  })
}

// ── state broadcast ─────────────────────────────────────────────────────────

/**
 * Give every session from a previous launch a workspace.
 *
 * Sessions predating worktrees have no `workspaceId`, so they would all sit
 * under "No repository" in a sidebar whose whole job is grouping by repository.
 * Deliberately after the window opens and deliberately not awaited: this runs
 * one `git rev-parse` per distinct folder, and the app must not stall behind a
 * slow disk or a network mount to redraw a list that is already correct enough.
 */
async function backfillWorkspaces(): Promise<void> {
  const unfiled = manager.list().filter((s) => !s.workspaceId)
  if (unfiled.length === 0) return

  // One adopt per distinct folder — a dozen sessions in one repo is the normal
  // case, and asking git a dozen times for the same answer is pure latency.
  const byDir = new Map<string, string[]>()
  for (const s of unfiled) {
    const ids = byDir.get(s.cwd)
    if (ids) ids.push(s.id)
    else byDir.set(s.cwd, [s.id])
  }

  let changed = false
  for (const [cwd, ids] of byDir) {
    try {
      const ws = await workspaces.adopt(cwd)
      for (const id of ids) changed = manager.assignWorkspace(id, ws.id) || changed
    } catch {
      // A folder that has since been deleted or unmounted simply stays
      // unfiled. Its sessions still show, under "No repository".
    }
  }
  if (changed) manager.flushWorkspaceAssignments()
}

export function snapshot(): AppState {
  return {
    updates: updates?.snapshot(),
    projectSync: projectSync?.snapshot() ?? [],
    projectSyncError: projectSync?.error() ?? null,
    experience: experience?.snapshot() ?? emptyExperience(),
    sessions: manager.list(),
    sessionProjects: store.sessionProjects,
    projects: workspaces.listProjects(),
    workspaces: workspaces.listLive(),
    tabs: store.tabs,
    activeTabId: store.activeTabId,
    prefs: store.prefs,
    counts: manager.counts(),
    // Binary probes are fixed at startup, but these two are live: a hotkey can
    // be lost to another app on re-registration, and a save can fail at any
    // point. Both need to reach Settings without a restart.
    env: { ...envReport, hotkeyError, storeError: store.error },
    profiles,
    busLog: bus ? bus.entries() : [],
    usage: usage?.current() ?? emptyReport(),
    shares: share ? share.list() : [],
    tunnel: tunnel ? tunnel.state : { status: 'off' },
    checkpoints: shelf ? shelf.list() : []
  }
}

function pushState(): void {
  refreshTray()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state', snapshot())
  }
}

// ── environment probe ───────────────────────────────────────────────────────

async function probeEnvironment(): Promise<void> {
  loginPath = resolveLoginPath()

  const tmuxBin = resolveTmuxBinary() ?? findExecutable('tmux', loginPath)
  const claudeBin = findExecutable('claude', loginPath)
  const codexBin = findExecutable('codex', loginPath)

  const [tmuxVer, claudeVer, codexVer] = await Promise.all([
    tmuxBin ? probeVersion(tmuxBin, ['-V'], loginPath) : Promise.resolve(null),
    claudeBin ? probeVersion(claudeBin, ['--version'], loginPath) : Promise.resolve(null),
    codexBin ? probeVersion(codexBin, ['--version'], loginPath) : Promise.resolve(null)
  ])

  envReport = {
    tmux: { available: !!tmuxBin, version: tmuxVer, socket: TMUX_SOCKET },
    claude: { available: !!claudeBin, version: claudeVer, path: claudeBin },
    codex: { available: !!codexBin, version: codexVer, path: codexBin },
    node: process.versions.node,
    shell: loginShell(),
    hotkeyError,
    storeError: store.error
  }

  profiles = allDefinitions(store.prefs.customAgents).map(toProfile)

  if (!tmuxBin) {
    // The hint has to know *which* machine is missing tmux. On Windows the
    // sessions run inside WSL, so "brew install tmux" is not merely the wrong
    // package manager — it names the wrong computer.
    dialog.showErrorBox(
      'tmux not found',
      `Workbench runs every session inside tmux so your agents survive closing the app.\n\n${installHint('tmux')}\n\nThen reopen Workbench.`
    )
  }

  tmux = new Tmux(tmuxBin ?? 'tmux', path.join(appData, 'tmux.conf'))
}

/**
 * Where an agent's binary is, for the cases that differ.
 *
 * The shell has no binary of its own — it is whatever `$SHELL` says, which is
 * the login shell the user actually wants. The two built-in CLIs were resolved
 * once at startup, because their versions are probed there for the environment
 * report anyway. Anything else is a user-added profile, resolved now: an
 * absolute path is taken as given, and a bare name is looked for on the login
 * PATH — the same PATH the agent itself will run with.
 */
function resolveAgentBinary(def: AgentDefinition): string | null {
  if (def.id === 'shell') return loginShell()
  if (def.id === 'claude') return envReport.claude.path
  if (def.id === 'codex') return envReport.codex.path
  if (!def.bin) return null
  // A binary that runs on the host is named the host's way, so "is this
  // absolute" is a POSIX question — `path.isAbsolute` would answer for Windows
  // and call `/usr/local/bin/foo` a relative name.
  if (path.posix.isAbsolute(def.bin)) {
    try {
      if (!hostFileExists(def.bin, true)) return null
      return def.bin
    } catch {
      return null
    }
  }
  return findExecutable(def.bin, loginPath)
}

/**
 * Rebuild the profile list and everything that names an agent.
 *
 * Called when the custom-agent preference changes. The menus are rebuilt
 * because "New Gemini CLI Session" has to appear in the File menu and the tray
 * without a restart, and both are built once from a template rather than bound
 * to state.
 */
function refreshAgents(): void {
  profiles = allDefinitions(store.prefs.customAgents).map(toProfile)
  buildAppMenu()
  refreshTray()
}

/** A registry row plus the two facts that need a disk. */
function toProfile(def: AgentDefinition): AgentProfile {
  const resolved = resolveAgentBinary(def)
  return {
    id: def.id,
    label: def.label,
    command: resolved ?? def.bin,
    args: def.args,
    color: def.color,
    available: resolved !== null,
    // Only the built-ins are version-probed. Running `--version` on a command a
    // user typed into a settings field is a subprocess we have no reason to
    // start and no way to interpret the output of.
    version:
      def.id === 'claude'
        ? envReport.claude.version
        : def.id === 'codex'
          ? envReport.codex.version
          : null,
    capabilities: def.capabilities,
    builtin: def.builtin
  }
}

// ── global hotkey ───────────────────────────────────────────────────────────

/**
 * A hotkey can fail for two reasons that look identical from here: the string
 * is not a valid accelerator, or another app already owns the combination.
 * Either way the failure used to be swallowed, leaving the user pressing a key
 * that does nothing with no explanation. Record it for Settings instead.
 */
function registerHotkey(): void {
  globalShortcut.unregisterAll()
  hotkeyError = null
  const prefs = store.prefs
  if (!prefs.hotkeyWindowEnabled || !prefs.globalHotkey) return
  try {
    const ok = globalShortcut.register(prefs.globalHotkey, () => {
      if (mainWindow?.isVisible() && mainWindow.isFocused()) mainWindow.hide()
      else showWindow()
    })
    // `register` returns false when the OS refuses — usually another app holds it.
    if (!ok) {
      hotkeyError = `“${prefs.globalHotkey}” is already claimed by another app.`
    }
  } catch (err) {
    hotkeyError = `“${prefs.globalHotkey}” is not a usable shortcut: ${
      err instanceof Error ? err.message : String(err)
    }`
  }
}

// ── application menu ────────────────────────────────────────────────────────

function buildAppMenu(): void {
  const send = (channel: string, payload?: unknown): void => {
    mainWindow?.webContents.send(channel, payload)
  }

  const mac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    // The application menu is a macOS convention end to end: the app-named
    // first submenu, About, and `hide`/`hideOthers` — roles that do not exist
    // on Windows or Linux and render as dead entries there. Dropping it whole
    // elsewhere would take Settings and Quit with it, so they move to the
    // bottom of Session, which is the leftmost menu once this one is gone.
    ...(mac
      ? [
          {
            label: 'Workbench',
            submenu: [
              { role: 'about' as const, label: 'About Workbench' },
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => send('menu:settings')
              },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'Session',
      submenu: [
        // One item per startable assistant, in registry order. The first two
        // keep ⌘N and ⇧⌘N: those are muscle memory, and an agent added later
        // must not silently take a shortcut off the agent that had it.
        ...profiles
          .filter((p) => p.available && p.id !== 'shell')
          .map((p, i) => ({
            label: `New ${p.label} Session`,
            accelerator: i === 0 ? 'CmdOrCtrl+N' : i === 1 ? 'CmdOrCtrl+Shift+N' : undefined,
            click: (): void => send('menu:new-session', p.id)
          })),
        {
          label: 'New Shell',
          accelerator: 'CmdOrCtrl+Alt+N',
          click: () => send('menu:new-session', 'shell')
        },
        { type: 'separator' },
        {
          label: 'Fork Child Session',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => send('menu:fork', 'child')
        },
        {
          label: 'Fork Parallel Session',
          accelerator: 'CmdOrCtrl+Alt+F',
          click: () => send('menu:fork', 'sibling')
        },
        { type: 'separator' },
        {
          label: 'Permissions…',
          accelerator: 'CmdOrCtrl+Alt+B',
          click: () => send('menu:bus')
        },
        { type: 'separator' },
        {
          label: 'Interrupt (Ctrl-C)',
          accelerator: 'CmdOrCtrl+.',
          click: () => send('menu:interrupt')
        },
        {
          label: 'Close Session',
          accelerator: 'CmdOrCtrl+W',
          click: () => send('menu:close-pane')
        },
        ...(mac
          ? []
          : [
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => send('menu:settings')
              },
              { type: 'separator' as const },
              { role: 'quit' as const, label: 'Exit' }
            ])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find in Session…',
          click: () => send('menu:find')
        },
        {
          // Folder search keeps its direct shortcut. Session scrollback search
          // remains in this menu and the command palette; ⌘F belongs to the
          // visual-pane workflow.
          label: 'Find in Folder…',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => send('menu:search')
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Command Palette…',
          accelerator: 'CmdOrCtrl+K',
          click: () => send('menu:palette')
        },
        {
          label: 'Go to Session…',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => send('menu:switcher')
        },
        {
          // In the menu bar, not only the palette: a checkpoint shelf is
          // something you go looking for by name, and a command you can only
          // reach by already knowing it exists is one nobody finds.
          label: 'Context Shelf…',
          accelerator: 'CmdOrCtrl+Shift+K',
          click: () => send('menu:shelf')
        },
        {
          label: 'Go to Next Session Needing You',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => send('menu:attention')
        },
        { type: 'separator' },
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => send('menu:toggle-sidebar')
        },
        {
          label: 'Pin Sidebar',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => send('menu:toggle-pin')
        },
        { type: 'separator' },
        {
          label: 'Toggle Preview',
          accelerator: 'CmdOrCtrl+P',
          click: () => send('menu:toggle-preview')
        },
        {
          label: 'Open File in Preview…',
          accelerator: 'CmdOrCtrl+Alt+O',
          click: () => send('menu:preview-open')
        },
        { type: 'separator' },
        {
          label: 'New Visual Pane',
          accelerator: 'CmdOrCtrl+F',
          click: () => send('menu:visual-pane')
        },
        {
          label: 'Split Right',
          accelerator: 'CmdOrCtrl+D',
          click: () => send('menu:split', 'h')
        },
        {
          label: 'Split Down',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => send('menu:split', 'v')
        },
        {
          label: 'Zoom Pane',
          accelerator: 'CmdOrCtrl+Shift+Return',
          click: () => send('menu:zoom')
        },
        {
          // Deliberately without accelerators. The numbers are spoken for by
          // pane and tab jumps, which you press far more often than you
          // rearrange, and a third digit chord would be one too many.
          label: 'Arrange Panes',
          submenu: [
            { label: 'Balanced Grid', click: () => send('menu:preset', 'auto') },
            { label: 'Spotlight', click: () => send('menu:preset', 'focus') },
            { label: 'Equal Columns', click: () => send('menu:preset', 'columns') },
            { label: 'Equal Rows', click: () => send('menu:preset', 'rows') }
          ]
        },
        { type: 'separator' },
        {
          // The prompt bar has to be reachable without the mouse, because the
          // thing it competes with for the keyboard is a full-screen terminal
          // that wins every ambiguous click. ⌘L for "address bar", which is
          // what it is: the one place you type *to* the agents rather than
          // *into* one of them.
          label: 'Focus Prompt Bar',
          accelerator: 'CmdOrCtrl+L',
          click: () => send('menu:focus-composer')
        },
        {
          label: 'Broadcast Input to All Panes',
          accelerator: 'CmdOrCtrl+Alt+I',
          click: () => send('menu:toggle-broadcast')
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Puts our icon in the dock while developing.
 *
 * A packaged build gets its icon from the bundle's `.icns`, which electron-builder
 * copies in — but `electron-vite dev` runs inside Electron's own app bundle, so
 * the dock shows Electron's atom no matter what `package.json` says. Setting it
 * by hand is the only way to see the real icon before packaging, which is also
 * the only way to notice that it looks wrong.
 */
function applyDevDockIcon(): void {
  if (app.isPackaged || process.platform !== 'darwin') return
  const file = path.join(app.getAppPath(), 'resources', 'icon.png')
  if (!fs.existsSync(file)) return // not generated yet; `npm run icon` makes it
  const image = nativeImage.createFromPath(file)
  if (!image.isEmpty()) app.dock?.setIcon(image)
}

// ── bootstrap ───────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  void app.whenReady().then(async () => {
    applyDevDockIcon()

    store = new Store(appData)
    // Dictation clients inspect the native accessibility tree, while xterm
    // normally draws only pixels. Enable Chromium's half before the window is
    // made; each terminal supplies its visible text through screenReaderMode.
    // This exposes ordinary accessibility surfaces without claiming that an
    // external vendor recognizes Workbench as one of its supported IDEs.
    app.setAccessibilitySupportEnabled(store.prefs.terminalAccessibility)
    await probeEnvironment()

    hooks = new HookBridge(path.join(appData, 'bin'), process.execPath)
    await hooks.start()

    // Restored before the first launch dialog opens, so a worktree from last
    // week is still recognised as one Workbench made — and therefore still one
    // it is allowed to clean up.
    workspaces = new WorkspaceManager({
      git: runGit,
      dataDir: appData,
      onChange: () => {
        store.setWorkspaceState(workspaces.listProjects(), workspaces.list())
        // The renderer labels panes by branch and lists worktrees in Settings,
        // so a change here has to reach it — otherwise a worktree you just
        // deleted is still sitting in the list with a Remove button.
        if (manager) pushState()
      }
    })
    workspaces.load(store.projects, store.workspaces)
    // `load` drops rows whose directory the user deleted between launches;
    // write the surviving set back so the file does not keep resurrecting them.
    store.setWorkspaceState(workspaces.listProjects(), workspaces.list())

    manager = new SessionManager(
      tmux,
      hooks,
      store,
      resolveAgentBinary,
      appData,
      loginPath,
      // The home directory that matters is the one the agents write into —
      // `~/.claude.json`, `~/.codex/config.toml`, the transcripts we read back
      // for handoff. On Windows that is the distro's home, not `C:\Users\…`.
      hostHomeNative()
    )

    manager.cliVersions = {
      claude: envReport.claude.version,
      codex: envReport.codex.version
    }

    notifications = buildNotifications()

    // Git review runs against whichever session you are looking at, so it takes
    // the session manager rather than a directory — see `review.ts`.
    const review = new GitReview({ sessions: manager, dataDir: appData })

    // The Session Bus rides on the hook bridge's server: same loopback port,
    // same rotating token. Nothing new is listening on the machine.
    const sessionBus = new SessionBus({
      sessions: manager,
      binDir: path.join(appData, 'bin'),
      electronExecPath: process.execPath,
      enabled: () => store.prefs.busEnabled === true,
      project: (id) => store.sessionProjects.find((p) => p.id === id),
      projects: () => store.sessionProjects,
      relay: (request, authorize) => manager.sendRelay(request, authorize),
      scheduler: () => experience,
      context: (id, prompt) => withProjectContext(prompt, experience?.snapshot().projectDetails[id]) ?? prompt
    })
    bus = sessionBus
    sessionBus.writeScripts()
    sessionBus.mount(hooks)
    manager.busEnvFor = (id) => sessionBus.envFor(id)
    // The master switch decides whether the tools are offered to a new agent at
    // all; per-session access is checked on every call, so revoking that does
    // not need a restart. Read per launch, so flipping the switch reaches the
    // next session started rather than the next time the app opens.
    manager.busMcp = () =>
      store.prefs.busEnabled
        ? {
            claudeMcpConfig: sessionBus.paths.claudeConfig,
            codexArgs: sessionBus.codexConfigArgs()
          }
        : null
    sessionBus.on('bus-changed', pushState)

    manager.on('sessions-changed', () => {
      notifications.reconcile(manager.list())
      try { experience?.syncRuns() } catch { /* surfaced through experience.error */ }
      // A closed session must not leave a working-looking link behind it.
      share?.prune((id) => manager.get(id)?.alive === true)
      pushState()
    })
    manager.on('notify', (req: NotifyRequest) => notifications.show(req))
    manager.on('data', (sessionId: string, data: string) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:data', { sessionId, data })
      }
    })

    await manager.init()

    experience = new Experience({
      directory: appData,
      project: (id) => store.sessionProjects.find((p) => p.id === id),
      session: (id) => manager.get(id),
      launch: (options) => {
        // SessionManager's interactive fallback to home is not appropriate
        // unattended: a stale project must fail, not run in a different folder.
        if (!options.cwd || !fs.statSync(options.cwd).isDirectory()) throw new Error('Project folder is unavailable')
        return manager.create(options)
      },
      changed: pushState
    })

    // Service output has its own bounded stream. It must never enter the
    // saved agent state, Focus reports, or the status bridge's projection.
    services = new Services({
      directory: appData,
      project: (id) => store.sessionProjects.find((p) => p.id === id),
      changed: () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('services:changed', services?.snapshot())
      }
    })

    projectSync = new ProjectSync({ directory: appData, project: (id) => store.sessionProjects.find((p) => p.id === id), remote: new GitHubSyncRemote(), changed: pushState })

    // Pasted screenshots accumulate quietly; sweep the stale ones once per
    // launch rather than shipping a directory that only ever grows.
    attachments = new AttachmentStore(appData)
    attachments.prune()

    // Sharing owns its own listener rather than borrowing the hook bridge's:
    // the bridge is loopback-only and trusted, this one is handed to strangers.
    share = new ShareServer({
      snapshot: (id, lines) => manager.snapshot(id, lines),
      write: (id, data) => manager.write(id, data),
      title: (id) => manager.get(id)?.title ?? null
    })
    // Looked up against the login PATH, not spawned by bare name: launched from
    // Finder this process has no /opt/homebrew/bin, and a share would report
    // "not installed" on a machine where it plainly is.
    // The one binary that stays on this side of the boundary — see
    // `findNativeExecutable`. On a local host nothing changes: the login PATH
    // is still what a GUI app needs, because its own PATH is bare.
    tunnel = new Tunnel(() =>
      hostKind() === 'wsl'
        ? findNativeExecutable('cloudflared')
        : findExecutable('cloudflared', loginPath)
    )
    // Same directory the `ctx` command on every session's PATH uses: a
    // checkpoint saved from a terminal and one saved from the panel are the
    // same object, and two shelves would be a distinction the user has to keep
    // in their head for no benefit.
    shelf = new ContextShelf()
    share.on('change', () => pushState())
    tunnel.on('state', (state: TunnelState) => {
      // A tunnel that dies takes every link it published with it: the hostname
      // keeps resolving and Cloudflare answers 1033 forever after. If the app
      // went on describing those links as "works anywhere", the host would keep
      // sending a dead address and the guest would keep seeing an error page
      // with no way to connect it back to this. So reach drops to local the
      // moment the tunnel does.
      if (state.status !== 'up') share.setOrigin(share.localOrigin, 'local')
      pushState()
    })
    await share.start()

    preview = new PreviewServer({
      // An artifact opened inside a checkout may load that checkout's own
      // assets — a chart's stylesheet, a screenshot two folders over. Outside
      // one, a document gets its own folder and nothing else.
      resolveRoot: (file) => {
        const roots = [
          ...workspaces.list().map((w) => w.path),
          ...manager.list().map((s) => s.cwd)
        ]
        return (
          roots
            .filter((root) => isInsideRoot(root, file))
            // The narrowest enclosing root, so a worktree does not hand out
            // its parent repository.
            .sort((a, b) => b.length - a.length)[0] ?? null
        )
      },
      onChange: (file) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('preview:changed', file)
        }
      }
    })
    protocol.handle(PREVIEW_SCHEME, (request) => preview.serve(request.url))

    /**
     * A turn ended. If it left a document behind, offer it to the preview pane.
     *
     * The scan is deferred off the status-change path — it walks a repository,
     * and nothing about a status update should wait for that. The renderer
     * decides whether to actually show it; main only reports what appeared.
     */
    // A session printed a local server address. The renderer decides what to
    // offer; main only reports what the session said it did.
    manager.on('server', ({ sessionId, url }: { sessionId: string; url: string }) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send('session:server', { sessionId, url })
    })

    manager.on(
      'produced',
      ({ sessionId, cwd, since }: { sessionId: string; cwd: string; since: number }) => {
        const until = Date.now()
        // Turning off the document dock's auto-open must not turn a visual
        // pane into a still image. A visual pane is an explicit request to
        // receive this session's artifacts, so its turn scan remains active.
        const visual = store.tabs.some((tab) => hasVisualPane(tab.layout, sessionId))
        setImmediate(() => {
          if (!mainWindow || mainWindow.isDestroyed()) return
          let entry: PreviewEntry | null = null
          try {
            entry = preview.producedFor(sessionId, cwd, since, until)
          } catch {
            return // a working directory that has gone away is not an error here
          }
          // The session travels with the document. Without it the renderer
          // cannot tell which chat produced what, and the dock has to guess.
          if (entry) {
            try { experience?.recordOutput(sessionId, entry) } catch { /* history error is visible */ }
            if (store.prefs.previewAutoShow || visual) mainWindow.webContents.send('preview:produced', { sessionId, entry })
          }
        })
      }
    )

    /**
     * `workbench show <file>` — an agent putting an existing file on screen.
     *
     * The auto-surface covers what a turn produced. This covers everything else,
     * which is most of what you actually ask for: a résumé, a design doc, a chart
     * committed last week. Without it an agent has no verb for "look at this" and
     * goes looking for an API to invent instead.
     *
     * Scoped to the asking session's own working directory or an open workspace.
     * The pane is a window into the user's project, not into their disk, and the
     * fact that the caller already holds the bridge token does not change that.
     */
    hooks.route('/preview/show', async (body) => {
      const req = (body ?? {}) as { termSessionId?: unknown; path?: unknown }
      if (typeof req.termSessionId !== 'string' || typeof req.path !== 'string') {
        throw new Error('Nothing to show')
      }
      const session = manager?.list().find((s) => s.id === req.termSessionId)
      if (!session) throw new Error('That session is not open in Workbench')

      let real: string
      try {
        // The path comes from the `workbench` CLI, which resolves relative
        // targets itself but hands absolute POSIX ones straight through — see
        // the note in the generated script. This is the single conversion.
        real = fs.realpathSync.native(path.resolve(toNativePath(req.path)))
      } catch {
        throw new Error(`${path.basename(req.path)} is not there`)
      }
      const allowed = [session.cwd, ...workspaces.list().map((w) => w.path)]
      if (!allowed.some((root) => isInsideRoot(root, real))) {
        throw new Error('Only files inside the session\'s folder can be shown')
      }
      if (!classifyPreview(real)) {
        throw new Error(`The pane cannot render ${path.extname(real) || 'that'} files`)
      }
      let stat: fs.Stats
      try {
        stat = fs.statSync(real)
      } catch {
        throw new Error('That file could not be read')
      }
      if (!stat.isFile()) throw new Error('That is a folder, not a document')

      if (!mainWindow || mainWindow.isDestroyed()) throw new Error('No window to show it in')
      try {
        experience?.recordOutput(session.id, { path: real, name: path.basename(real),
          kind: classifyPreview(real)!, mtimeMs: stat.mtimeMs, size: stat.size })
      } catch { /* Showing a document still works if its history cannot be saved. */ }
      preview.noteShown(session.id)
      mainWindow.webContents.send('preview:show', { sessionId: session.id, path: real })
      return { path: real }
    })

    void backfillWorkspaces()

    // Quotas are decoration: a failed lookup must never delay startup, so the
    // monitor pushes a fresh snapshot whenever it has one instead of being
    // awaited here.
    usage = new UsageMonitor(usageDeps, () => pushState())
    usage.start()

    const updateDirectory = path.join(appData, 'updates')
    let updateServicesPrepared = false
    const updatePlatform = new UpdatePlatformAdapter(async () => {
      // Check disk writes before any window closes or installer starts. The
      // regular quit path then detaches tmux and flushes the final state again.
      if (!store.saveNow()) throw new Error('Workbench could not save your layout. Resolve the storage error before updating.')
      // A service can refuse to stop and cancel an ordinary quit. Settle that
      // decision before a detached installer begins waiting for this process,
      // and keep new service starts blocked throughout the update handoff.
      await services?.shutdown()
      updateServicesPrepared = true
    }, (nativeMac) => {
      nativeUpdateQuit = nativeMac === true
      if (nativeMac === null && updateServicesPrepared) {
        services?.cancelShutdown()
        updateServicesPrepared = false
      }
      if (nativeMac === false) app.quit()
    })
    updates = new UpdateService({ directory: updateDirectory, version: app.getVersion(),
      platform: process.platform, arch: app.runningUnderARM64Translation ? 'arm64' : process.arch,
      systemVersion: os.release(), packaged: app.isPackaged, changed: pushState,
      readJSON: readUpdateJSON, download: downloadUpdate,
      canRestart: (asset) => updatePlatform.canRestart(asset),
      stageMac: (asset) => updatePlatform.stageMac(asset),
      install: (asset, file) => updatePlatform.install(asset, file),
      openInstaller: (file) => updatePlatform.openInstaller(file)
    })

    registerIpc({
      updates,
      services,
      projectSync,
      experience,
      manager,
      store,
      tmux,
      workspaces,
      attachments,
      preview,
      review,
      share,
      tunnel,
      shelf,
      snapshot,
      pushState,
      registerHotkey,
      refreshAgents,
      getWindow: () => mainWindow,
      showWindow,
      clipboard,
      dataDir: appData,
      refreshUsage: () => usage?.refresh() ?? Promise.resolve(emptyReport())
    })

    buildAppMenu()
    buildTray()
    registerHotkey()

    mainWindow = createWindow()
    wireWindowEvents(mainWindow)
    experience.start()
    void services.autoStart().catch((error) => console.error('[services] startup:', error instanceof Error ? error.message : String(error)))
    projectSync.start()
    updates.start()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) showWindow()
    })
  })

  // Closing the last window must not kill the app: the tray is the point, and
  // sessions keep running in tmux either way.
  //
  // That reasoning holds exactly as long as the tray is somewhere the user can
  // click. On macOS it always is. Under WSLg it never is: the session bus has
  // no StatusNotifierWatcher, so `new Tray()` succeeds and puts an icon
  // precisely nowhere. Staying resident there strands the app — no window, no
  // tray, and a live process still holding the single-instance lock, so the
  // launcher does nothing for the rest of the session and the app looks like it
  // will not start.
  //
  // Quitting instead costs nothing that matters: the sessions are tmux
  // sessions, and outliving the app is the whole reason they are. Relaunching
  // reattaches to every one of them.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  /**
   * Quit is asynchronous work: the store flush, the PTY detach and the hook
   * server all have to finish before the process goes away. The old handler
   * fired all three and returned immediately, so a quit could truncate the
   * layout file it was in the middle of writing.
   */
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    void (async () => {
      // Keep the application usable if an owned process refuses to stop. A
      // failed cleanup must not tear down agents or strand half a quit flow.
      try { await services?.shutdown() }
      catch {
        quitting = false
        showWindow()
        void dialog.showMessageBox({ type: 'error', title: 'A service could not stop',
          message: 'Workbench is still open because a background service could not be stopped.',
          detail: 'Open Services to check its output and retry Stop, then quit again.' })
        return
      }
      updates?.stop()
      experience?.stop()
      projectSync?.stop()
      globalShortcut.unregisterAll()
      notifications?.dispose()
      preview?.dispose()
      usage?.stop()
      // Guests lose the view the moment the host quits, which is correct: the
      // link is the host's session, not a service that outlives them.
      tunnel?.stop()
      await share?.stop()
      let saved = true
      try {
        saved = await manager?.shutdown()
      } catch {
        saved = false
      }
      try {
        await hooks?.stop()
      } catch {
        /* the bridge is going away with the process anyway */
      }
      if (!saved) {
        // Losing the layout silently is worse than a slow quit: say so while
        // there is still a process alive to say it.
        console.error('[terminal] shutdown: failed to save session state')
      }
      // Squirrel owns the final Mac termination and relaunch. Calling exit()
      // here bypasses its normal application lifecycle after the async flush.
      if (nativeUpdateQuit) app.quit()
      else app.exit(0)
    })()
  })
}

// Surface unexpected failures instead of dying silently.
process.on('uncaughtException', (err) => {
  const logFile = path.join(appData, 'crash.log')
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.appendFileSync(logFile, `\n[${new Date().toISOString()}] ${err.stack ?? err}\n`)
  } catch {
    /* nothing more we can do */
  }
  console.error('[terminal]', err)
})
