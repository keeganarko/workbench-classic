/** Small presentation helpers shared by the sidebar, panes and palette. */

import type { PermissionMode, Session, SessionStatus } from '../../../shared/types'

/*
 * `byActivity` and `isRecentStatus` used to live here. They moved to
 * `shared/sessionOrder.ts` when ⌘1…⌘9 started jumping to sidebar rows: the
 * shortcut has to sort and bucket exactly the way the sidebar draws, and
 * shared code cannot import a renderer module. Import them from there.
 */

export function statusColor(status: SessionStatus): string {
  return `var(--status-${status})`
}

/** "3m", "2h", "4d" — compact enough for a 24px row. */
export function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 45) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

function rendererPlatform(): string {
  if (typeof window !== 'undefined' && window.term?.platform) return window.term.platform
  return typeof navigator !== 'undefined' ? navigator.platform : ''
}

export function shortPath(p: string): string {
  // Native macOS/Linux homes plus a Windows home reached through WSL.
  const unixHome = p.match(/^\/(?:Users|home)\/[^/]+/)
  const wslWindowsHome = p.match(/^\/mnt\/[a-z]\/Users\/[^/]+/i)
  const nativeWindowsHome = p.match(/^[a-z]:[\\/]Users[\\/][^\\/]+/i)
  const home = unixHome?.[0] ?? wslWindowsHome?.[0] ?? nativeWindowsHome?.[0]
  if (home) {
    const rest = p.slice(home.length)
    return rest.length === 0 ? '~' : `~${rest}`
  }
  return p
}

/** Short enough for a pane footer, and says what it costs you. */
export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  default: 'asks first',
  auto: 'auto-edit',
  'full-access': 'full access'
}

/**
 * The order Workbench walks the sessions that want something from you.
 *
 * `waiting` first: a permission prompt has stopped a turn that already started,
 * so it is the only one costing you time right now. `failed` next — it needs a
 * decision, but nothing is blocked behind it. `review` last, because a finished
 * turn keeps. Inside a bucket the *oldest* status change wins, so the session
 * that has been stuck longest is the one you reach first; sorting by newest,
 * the way every other list here does, would starve it forever.
 */
const ATTENTION_ORDER: SessionStatus[] = ['waiting', 'failed', 'review']

export function attentionQueue(sessions: Session[]): Session[] {
  return sessions
    .filter((s) => s.alive && ATTENTION_ORDER.includes(s.status))
    .sort((a, b) => {
      const byStatus =
        ATTENTION_ORDER.indexOf(a.status) - ATTENTION_ORDER.indexOf(b.status)
      return byStatus !== 0 ? byStatus : a.lastStatusChangeAt - b.lastStatusChangeAt
    })
}

/**
 * The next session to jump to, given where the user already is.
 *
 * Deliberately stateless: pressing the shortcut repeatedly walks the queue
 * because every press re-derives it from current status. A remembered cursor
 * would go stale the moment a session changed status — and in a list defined
 * entirely by status, that is constantly.
 *
 * A current session that is not itself in the queue yields index -1, which
 * wraps to the front. That is the case that matters: you are heads-down in a
 * working pane and want the first thing that is blocked.
 */
export function nextNeedingAttention(
  sessions: Session[],
  currentId: string | null
): Session | null {
  const queue = attentionQueue(sessions)
  if (queue.length === 0) return null
  const at = queue.findIndex((s) => s.id === currentId)
  return queue[(at + 1) % queue.length]
}

/** Renders Electron accelerator names the way the current desktop expects. */
export function accel(text: string, platform = rendererPlatform()): string {
  if (platform === 'darwin' || /^Mac/.test(platform)) {
    return text
      .replace(/CmdOrCtrl|Cmd/g, '⌘')
      .replace(/Shift/g, '⇧')
      .replace(/Alt|Option/g, '⌥')
      .replace(/Ctrl|Control/g, '⌃')
      .replace(/\+/g, '')
  }
  return text
    .replace(/CmdOrCtrl|Cmd|Control/g, 'Ctrl')
    .replace(/Option/g, 'Alt')
}

/** Renderer-only shortcuts use Command on macOS and Control everywhere else. */
export function hasPrimaryModifier(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>,
  platform = rendererPlatform()
): boolean {
  return platform === 'darwin' || /^Mac/.test(platform) ? event.metaKey : event.ctrlKey
}

/** One event, narrowed to the parts a modifier test can read. */
type ChordEvent = Pick<
  KeyboardEvent,
  'type' | 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>

function isMacPlatform(platform: string): boolean {
  return platform === 'darwin' || /^Mac/.test(platform)
}

/**
 * Paste inside a terminal pane, on Windows and Linux.
 *
 * macOS needs nothing here: Command is not a terminal modifier, so xterm leaves
 * Cmd-V alone and the Edit menu's paste role handles it. Everywhere else the
 * two sets of keys collide. Ctrl-V is a key the terminal already claims — xterm
 * turns it into the SYN byte and marks the event handled — and Electron only
 * dispatches a menu accelerator for keys the page left unhandled. So the Edit
 * menu never fires, and the keystroke is spent on an invisible ^V. Inside Codex
 * that byte is its own "paste image" shortcut, which is why the symptom people
 * report is a "no image on clipboard" error while Windows is holding text.
 *
 * The only place left to catch it is ahead of xterm, which is what xterm's
 * `attachCustomKeyEventHandler` exists for. Ctrl-Shift-V answers as well:
 * it is the chord Linux terminals trained everyone to use, and nothing else
 * in the app wants it. Shift-Insert uses the same path: native dictation tools
 * such as Wispr Flow send that chord when Ctrl-V is unreliable in a terminal.
 * Handling it here keeps the paste framed once and prevents an Insert escape
 * sequence or a second browser paste from reaching the foreground program.
 */
export function isTerminalPasteShortcut(event: ChordEvent, platform = rendererPlatform()): boolean {
  if (isMacPlatform(platform) || event.type !== 'keydown') return false
  if (event.key === 'Insert' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) return true
  if (!event.ctrlKey || event.metaKey || event.altKey) return false
  return event.key.toLowerCase() === 'v'
}

/**
 * Copy out of a terminal pane, on Windows and Linux — the same collision as
 * {@link isTerminalPasteShortcut}, and the same cure.
 *
 * Shift is required, not optional. Bare Ctrl-C has to stay SIGINT or the one
 * key that stops a runaway agent would start copying instead, so copy moves to
 * Ctrl-Shift-C, which is where every Linux terminal already puts it for exactly
 * this reason.
 */
export function isTerminalCopyShortcut(event: ChordEvent, platform = rendererPlatform()): boolean {
  if (isMacPlatform(platform) || event.type !== 'keydown') return false
  if (!event.ctrlKey || !event.shiftKey || event.metaKey || event.altKey) return false
  return event.key.toLowerCase() === 'c'
}

/**
 * How to write the secondary modifier in a label, for this desktop.
 *
 * Paired with {@link hasSecondaryModifier} so the printed key and the key that
 * actually works cannot drift: both ask the same question about the platform.
 */
export function secondaryAccel(key: string, platform = rendererPlatform()): string {
  const mac = platform === 'darwin' || /^Mac/.test(platform)
  return accel(mac ? `Ctrl+${key}` : `Alt+${key}`, platform)
}

/**
 * The other modifier — whichever one the primary is not.
 *
 * There are two numbered jumps and only one primary modifier, so the less-used
 * one (pane by position) moves here: ⌃1 on macOS, ⌥1 elsewhere. Deliberately
 * *not* Alt on macOS, where ⌥ plus a digit is a typed character.
 */
export function hasSecondaryModifier(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey'>,
  platform = rendererPlatform()
): boolean {
  const mac = platform === 'darwin' || /^Mac/.test(platform)
  return mac ? event.ctrlKey && !event.metaKey : event.altKey && !event.ctrlKey
}

/**
 * What to print next to Copy and Paste in a pane's context menu.
 *
 * Not `accel('CmdOrCtrl+C')`: on Windows that renders "Ctrl+C", which is a lie —
 * there Ctrl+C interrupts the program. The platforms genuinely disagree about
 * which keys these are, so the menu has to say so.
 */
export function clipboardAccel(kind: 'copy' | 'paste', platform = rendererPlatform()): string {
  if (isMacPlatform(platform)) return accel(kind === 'copy' ? 'Cmd+C' : 'Cmd+V', platform)
  // Paste is shown unshifted because both chords work and Ctrl+V is the one a
  // person reaches for first; copy has only the shifted form to offer.
  return accel(kind === 'copy' ? 'Ctrl+Shift+C' : 'Ctrl+V', platform)
}
